/**
 * One cron run's work (ADR-0002): lease the Shifts whose next step is due,
 * oldest first, and do that step:
 *  - the end of the Grace Period: one `form-submissions` check, then the
 *    Reminder if nothing arrived;
 *  - the escalation point, the escalation delay after the Reminder: the check
 *    again, then an Escalation to each recipient if still nothing;
 * then each Reminder Task step that is due (./reminderTask.ts), then the
 * polling sweep (./sweep.ts). Before them, blocks that are fixed are lifted
 * (./blocks.ts, #34), then Failure Alerts go (./failureAlerts.ts): they
 * report what earlier runs found, and get the minute's first calls. Last, the
 * blocks this run found and the daily allowance left are recorded for the
 * next run.
 *
 * A block (a rejected API key, or a setting pointing at something gone)
 * holds the steps that need it, without counting against them.
 *
 * A step that fails is tried again after doubling waits, and a send is given
 * up on after about an hour (./backoff.ts, #33). So is a send whose claim is
 * stuck: its run died mid-send, so it may have gone out, and is never retried.
 * Either way the Shift carries on to its next step as scheduled.
 *
 * Overlapping runs are safe: each leases what it takes, and every send is
 * claimed. Each run is polite to the account's shared rate limit (#31): it
 * stops for the minute on a 429, or once less than 20% of the per-minute
 * limit remains, and hands back what it leased but didn't reach, so the next
 * minute picks it up.
 */
import type { ConnecteamClient } from "../connecteam/client.js";
import { submittedFor } from "../crediting/check.js";
import type { Settings } from "../env.js";
import { escalationRecipients } from "../escalation/recipients.js";
import { escalation } from "../messages/escalation.js";
import { reminderShiftEnded } from "../messages/reminder.js";
import type { Block, ShiftRow, Undelivered, WorkList } from "../store.js";
import { fullName, retryWait, undelivered } from "./backoff.js";
import { causedByBlock, held, liftBlocks, pausedByKey, recordBlocks } from "./blocks.js";
import { runFailureAlerts, type AlertResult } from "./failureAlerts.js";
import { runTaskSteps, type TaskStepResult } from "./reminderTask.js";
import { runSweep, type SweepResult } from "./sweep.js";

export interface DueStepDeps {
  store: WorkList;
  ct: ConnecteamClient;
  settings: Settings;
  /** Unix seconds: the cron's scheduled time. */
  now: number;
  log?: (event: Record<string, unknown>) => void;
  /** The blocks in force this run (#34), set once they've been lifted or not. */
  blocks?: ReadonlySet<Block>;
}

/** The most Shifts one run takes. */
const BATCH = 25;

export type StepResult = "submitted" | "reminded" | "escalated" | "retry" | "given_up" | "skipped" | "deferred" | "held";

export async function runDueSteps(input: DueStepDeps): Promise<
  Record<StepResult, number> & {
    blocks: Block[];
    alerts: AlertResult;
    tasks: Record<TaskStepResult, number>;
    sweep: SweepResult;
    paused: boolean;
  }
> {
  const deps: DueStepDeps = { ...input, blocks: await liftBlocks(input) };
  const alerts = await runFailureAlerts(deps);
  const counts: Record<StepResult, number> = {
    submitted: 0,
    reminded: 0,
    escalated: 0,
    retry: 0,
    given_up: 0,
    skipped: 0,
    deferred: 0,
    held: 0,
  };
  // Held Shifts aren't even taken: they'd sit at the head of the queue.
  for (const shift of held(deps, "shift") ? [] : await deps.store.takeDue(deps.now, BATCH)) {
    if (deps.ct.stopped()) {
      await deps.store.release(shift.id);
      counts.deferred++;
      continue;
    }
    // A block found mid-run.
    if (held(deps, "shift")) {
      await deps.store.release(shift.id);
      counts.held++;
      continue;
    }
    const result =
      shift.status === "grace"
        ? await endOfGracePeriod(shift, deps)
        : shift.status === "reminded"
          ? await escalationPoint(shift, deps)
          : await skip(shift, deps);
    counts[result]++;
  }
  // After the Shifts, so a task due from this run's Reminder is created alongside it.
  const tasks = await runTaskSteps(deps);
  // Last: what is due goes first, and a Shift the sweep finds is due from the next run. Paused, it waits too.
  const sweep = pausedByKey(deps) ? { swept: 0, found: 0, failed: 0, deferred: 0 } : await runSweep(deps);
  const paused = deps.ct.minuteBudgetSpent();
  if (paused) (deps.log ?? (() => {}))({ evt: "rate_limit_pause", ...deps.ct.lastRateLimit });
  const blocks = await recordBlocks(deps);
  const dayRemaining = deps.ct.lastRateLimit?.dayRemaining;
  if (dayRemaining != null) await deps.store.setState("day_remaining", dayRemaining);
  return { ...counts, blocks, alerts, tasks, sweep, paused };
}

async function skip(shift: ShiftRow, deps: DueStepDeps): Promise<StepResult> {
  await deps.store.release(shift.id);
  return "skipped";
}

/** What a step gives up on once its waits are used up (#33), given the last failure's status. */
type GiveUp = (status: number | null) => Promise<StepResult>;

/**
 * Did they submit between the Shift's first clock-in and `toSeconds`
 * (../crediting/check.ts)? Returns a result to stop with, or `null` when
 * nothing counts for this Shift.
 */
async function checkSubmitted(
  shift: ShiftRow,
  toSeconds: number,
  step: string,
  deps: DueStepDeps,
  giveUp: GiveUp,
): Promise<StepResult | null> {
  const found = await submittedFor(shift, toSeconds, deps);
  if (found.outcome !== "ok") return retry(shift, deps, { step, ...found }, giveUp);
  return found.data ? "submitted" : null;
}

async function endOfGracePeriod(shift: ShiftRow, deps: DueStepDeps): Promise<StepResult> {
  const { store, ct, settings, now } = deps;
  const log = deps.log ?? (() => {});
  if (shift.endAt === null || shift.graceEndsAt === null) return skip(shift, deps);

  let name = "";
  // Given up on: the escalation point stays where it would have been had the Reminder gone out on time.
  const giveUp = (outcome: Undelivered["outcome"]) => async (status: number | null) => {
    const u = undelivered(shift, "reminder", { name, outcome, status }, deps);
    await store.giveUpReminder(shift.id, u, shift.graceEndsAt! + settings.escalationDelayMinutes * 60, settings.reminderTask);
    log({ evt: "send_given_up", shiftId: shift.id, kind: "reminder", outcome, status });
    return "given_up" as const;
  };

  const submitted = await checkSubmitted(shift, shift.graceEndsAt, "submission_check", deps, giveUp("failed"));
  if (submitted) return submitted;

  // A Missed Form. Read what the Reminder names before claiming the send.
  const user = await ct.getUser(shift.userId);
  if (user.outcome !== "ok") return retry(shift, deps, { step: "user", ...user }, giveUp("failed"));
  name = fullName(user.data);
  const form = await ct.getForm(settings.complianceFormId);
  if (form.outcome !== "ok") return retry(shift, deps, { step: "form", ...form }, giveUp("failed"));

  const claimKey = `reminder:${shift.id}`;
  // The escalation delay is fixed for the Shift when the Reminder goes out.
  const escalateAt = now + settings.escalationDelayMinutes * 60;
  if (!(await store.claimSend(claimKey, shift.id, now))) {
    // Never send twice. A done claim means it already went out; a stuck one
    // belongs to a run that died mid-send, so it's given up on, never retried.
    const state = await store.sendState(claimKey, now);
    if (state === "done") {
      await store.markReminded(shift.id, claimKey, now, escalateAt, settings.reminderTask);
      return "reminded";
    }
    if (state === "stuck") return giveUp("unconfirmed")(null);
    // Another run is mid-send.
    await store.release(shift.id);
    log({ evt: "reminder_claim_held", shiftId: shift.id });
    return "skipped";
  }

  const text = reminderShiftEnded({
    firstName: user.data?.firstName ?? "",
    shift: { startSeconds: shift.startAt, endSeconds: shift.endAt, timeZone: shift.startTz },
    deploymentZone: settings.timeZone,
    formName: form.data.formName,
    whereToFind: settings.whereToFind,
    escalationDelayMinutes: settings.escalationDelayMinutes,
  });
  const sent = await ct.sendDirectMessage(shift.userId, text);
  if (sent.outcome !== "ok") {
    await store.releaseSend(claimKey);
    return retry(shift, deps, { step: "reminder", ...sent }, giveUp("failed"));
  }
  await store.markReminded(shift.id, claimKey, now, escalateAt, settings.reminderTask);
  return "reminded";
}

/**
 * The escalation point. Recipients are read live, so a newly promoted Admin is
 * included and an Excluded Admins change takes effect on the next send. Each
 * recipient's send is claimed on its own: a failure retries only the
 * recipients still owed, after the next wait, and nobody gets it twice. Once
 * given up on, or with a recipient's claim stuck, the Escalation is listed in
 * a Failure Alert by the employee it's about.
 */
async function escalationPoint(shift: ShiftRow, deps: DueStepDeps): Promise<StepResult> {
  const { store, ct, settings, now } = deps;
  const log = deps.log ?? (() => {});
  if (shift.endAt === null) return skip(shift, deps);

  let name = "";
  const missed = (outcome: Undelivered["outcome"], status: number | null) =>
    undelivered(shift, "escalation", { name, outcome, status }, deps);
  const giveUp: GiveUp = async (status) => {
    await store.markEscalated(shift.id, now, missed("failed", status));
    log({ evt: "send_given_up", shiftId: shift.id, kind: "escalation", outcome: "failed", status });
    return "given_up";
  };

  const submitted = await checkSubmitted(shift, now, "escalation_check", deps, giveUp);
  if (submitted) return submitted;

  const users = await ct.listActiveUsers();
  if (users.outcome !== "ok") return retry(shift, deps, { step: "users", ...users }, giveUp);
  let employee = users.data.find((u) => u.userId === shift.userId) ?? null;
  if (!employee) {
    // Archived since the Shift: not in the active list.
    const one = await ct.getUser(shift.userId);
    if (one.outcome !== "ok") return retry(shift, deps, { step: "user", ...one }, giveUp);
    employee = one.data ?? { userId: shift.userId, customFields: [] };
  }
  name = fullName(employee);
  const form = await ct.getForm(settings.complianceFormId);
  if (form.outcome !== "ok") return retry(shift, deps, { step: "form", ...form }, giveUp);

  const recipients = escalationRecipients({ users: users.data, employee, excludedAdminIds: settings.excludedAdminIds });
  if (recipients.length === 0) log({ evt: "escalation_no_recipients", shiftId: shift.id });

  const text = escalation({
    fullName: name,
    userId: shift.userId,
    shift: { startSeconds: shift.startAt, endSeconds: shift.endAt, timeZone: shift.startTz },
    deploymentZone: settings.timeZone,
    formName: form.data.formName,
    remindedMinutesAgo: shift.remindedAt === null ? null : Math.floor((now - shift.remindedAt) / 60),
    ticked: await store.taskTicked(shift.id),
  });

  let failed: { status: number | null } | null = null;
  let owed = 0;
  let busy = 0;
  let stuck = 0;
  for (const recipient of recipients) {
    const claimKey = `escalation:${shift.id}:${recipient}`;
    if (!(await store.claimSend(claimKey, shift.id, now))) {
      // Done: already sent. Stuck: a run died mid-send, so never retried. Otherwise another run is mid-send.
      const state = await store.sendState(claimKey, now);
      if (state === "stuck") stuck++;
      else if (state !== "done") busy++;
      continue;
    }
    const sent = await ct.sendDirectMessage(recipient, text);
    if (sent.outcome !== "ok") {
      await store.releaseSend(claimKey);
      log({ evt: "step_failed", shiftId: shift.id, step: "escalation", recipient, ...sent });
      failed = sent;
      owed++;
      continue;
    }
    await store.markSendDone(claimKey, now);
  }

  if (failed) return retry(shift, deps, { step: "escalation", owed, status: failed.status }, giveUp);
  if (busy > 0) return skip(shift, deps);
  await store.markEscalated(shift.id, now, stuck > 0 ? missed("unconfirmed", null) : null);
  if (stuck > 0) log({ evt: "send_given_up", shiftId: shift.id, kind: "escalation", outcome: "unconfirmed", stuck });
  return "escalated";
}

/**
 * The step failed: try it again after the next wait (./backoff.ts), or once
 * the waits are used up, give up on it. A failure caused by a block only
 * waits for it to lift.
 */
async function retry(
  shift: ShiftRow,
  deps: DueStepDeps,
  detail: Record<string, unknown> & { status?: number | null },
  giveUp: GiveUp,
): Promise<StepResult> {
  if (causedByBlock(deps, detail.status)) {
    // It waits for the block to lift (./blocks.ts): no try used up.
    (deps.log ?? (() => {}))({ evt: "step_held", shiftId: shift.id, ...detail });
    await deps.store.release(shift.id);
    return "held";
  }
  const failures = shift.attempts + 1;
  (deps.log ?? (() => {}))({ evt: "step_failed", shiftId: shift.id, failures, ...detail });
  const wait = retryWait(failures);
  if (wait === null) return giveUp(detail.status ?? null);
  await deps.store.backOff(shift.id, shift.status, deps.now, wait);
  return "retry";
}
