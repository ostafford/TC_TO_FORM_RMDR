/**
 * One cron run's work (ADR-0002): lease the Shifts whose next step is due,
 * oldest first, and do that step:
 *  - the end of the Grace Period: one `form-submissions` check, then the
 *    Reminder if nothing arrived;
 *  - the escalation point, the escalation delay after the Reminder: the check
 *    again, then an Escalation to each recipient if still nothing
 *    (./escalate.ts), or during Quiet Hours, held for the Escalation Summary
 *    that goes first in the first run after they end (./summary.ts, #29);
 * then each Reminder Task step that is due (./reminderTask.ts), then the
 * polling sweep (./sweep.ts). Before them, blocks that are fixed are lifted
 * (./blocks.ts, #34), then Failure Alerts go (./failureAlerts.ts): they
 * report what earlier runs found, and get the minute's first calls. Last, the
 * blocks this run found and the daily allowance left are recorded for the
 * next run. With the Integrator Relay set up, the run first sends the daily
 * check-in, if it's due (#36).
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
import type { Settings } from "../env.js";
import { reminderShiftEnded } from "../messages/reminder.js";
import type { RelaySender } from "../relay/send.js";
import type { Block, ShiftRow, Undelivered, WorkList } from "../store.js";
import { fullName, undelivered } from "./backoff.js";
import { held, liftBlocks, pausedByKey, recordBlocks } from "./blocks.js";
import { escalationPoint } from "./escalate.js";
import { runFailureAlerts, type AlertResult } from "./failureAlerts.js";
import { runTaskSteps, type TaskStepResult } from "./reminderTask.js";
import { checkSubmitted, retry, skip, type StepResult } from "./steps.js";
import { runSummaries } from "./summary.js";
import { runSweep, type SweepResult } from "./sweep.js";

export type { StepResult };

export interface DueStepDeps {
  store: WorkList;
  ct: ConnecteamClient;
  settings: Settings;
  /** Unix seconds: the cron's scheduled time. */
  now: number;
  log?: (event: Record<string, unknown>) => void;
  /** The blocks in force this run (#34), set once they've been lifted or not. */
  blocks?: ReadonlySet<Block>;
  /** Sends to the Integrator Relay (#36); absent when it isn't set up. */
  relay?: RelaySender;
}

/** The Deployment checks in with the Integrator Relay this often (#36). The relay reports 36 hours of silence. */
export const CHECK_IN_SECONDS = 24 * 60 * 60;

/** The most Shifts one run takes. */
const BATCH = 25;

export async function runDueSteps(input: DueStepDeps): Promise<
  Record<StepResult, number> & {
    summary: Awaited<ReturnType<typeof runSummaries>>;
    checkedIn: boolean;
    blocks: Block[];
    alerts: AlertResult;
    tasks: Record<TaskStepResult, number>;
    sweep: SweepResult;
    paused: boolean;
  }
> {
  // First, and needing no Connecteam call: a paused Deployment still checks in.
  const checkedIn = await checkIn(input);
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
    quiet: 0,
  };
  // Escalations held overnight go first, once Quiet Hours are over (#29).
  const summary = held(deps, "shift") ? { summaries: 0 } : await runSummaries(deps);
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
  return { ...counts, summary, checkedIn, blocks, alerts, tasks, sweep, paused };
}

/** The daily check-in with the Integrator Relay (#36), claimed so overlapping runs send one. */
async function checkIn(deps: DueStepDeps): Promise<boolean> {
  if (!deps.relay) return false;
  const claim = await deps.store.claimCheckIn(deps.now, CHECK_IN_SECONDS);
  if (!claim) return false;
  if (await deps.relay({ kind: "check_in" })) return true;
  await deps.store.releaseCheckIn(claim.previous);
  return false;
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
