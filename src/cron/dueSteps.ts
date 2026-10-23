/**
 * One cron run's work (ADR-0002): lease the Shifts whose next step is due,
 * oldest first, and do that step:
 *  - the end of the Grace Period: one `form-submissions` check, then the
 *    Reminder if nothing arrived;
 *  - the escalation point, the escalation delay after the Reminder: the check
 *    again, then an Escalation to each recipient if still nothing;
 * then each Reminder Task step that is due (./reminderTask.ts).
 */
import type { ConnecteamClient } from "../connecteam/client.js";
import { submittedFor } from "../crediting/check.js";
import type { Settings } from "../env.js";
import { escalationRecipients } from "../escalation/recipients.js";
import { escalation } from "../messages/escalation.js";
import { reminderShiftEnded } from "../messages/reminder.js";
import type { ShiftRow, WorkList } from "../store.js";
import { runTaskSteps, type TaskStepResult } from "./reminderTask.js";

export interface DueStepDeps {
  store: WorkList;
  ct: ConnecteamClient;
  settings: Settings;
  /** Unix seconds: the cron's scheduled time. */
  now: number;
  log?: (event: Record<string, unknown>) => void;
}

/** The most Shifts one run takes. */
const BATCH = 25;

export type StepResult = "submitted" | "reminded" | "escalated" | "retry" | "skipped";

export async function runDueSteps(
  deps: DueStepDeps,
): Promise<Record<StepResult, number> & { tasks: Record<TaskStepResult, number> }> {
  const counts: Record<StepResult, number> = { submitted: 0, reminded: 0, escalated: 0, retry: 0, skipped: 0 };
  for (const shift of await deps.store.takeDue(deps.now, BATCH)) {
    const result =
      shift.status === "grace"
        ? await endOfGracePeriod(shift, deps)
        : shift.status === "reminded"
          ? await escalationPoint(shift, deps)
          : await skip(shift, deps);
    counts[result]++;
  }
  // After the Shifts, so a task due from this run's Reminder is created alongside it.
  return { ...counts, tasks: await runTaskSteps(deps) };
}

async function skip(shift: ShiftRow, deps: DueStepDeps): Promise<StepResult> {
  await deps.store.release(shift.id);
  return "skipped";
}

/**
 * Did they submit between the Shift's first clock-in and `toSeconds`
 * (../crediting/check.ts)? Returns a result to stop with, or `null` when
 * nothing counts for this Shift.
 */
async function checkSubmitted(shift: ShiftRow, toSeconds: number, step: string, deps: DueStepDeps): Promise<StepResult | null> {
  const found = await submittedFor(shift, toSeconds, deps);
  if (found.outcome !== "ok") return retry(shift, deps, { step, ...found });
  return found.data ? "submitted" : null;
}

async function endOfGracePeriod(shift: ShiftRow, deps: DueStepDeps): Promise<StepResult> {
  const { store, ct, settings, now } = deps;
  const log = deps.log ?? (() => {});
  if (shift.endAt === null || shift.graceEndsAt === null) return skip(shift, deps);

  const submitted = await checkSubmitted(shift, shift.graceEndsAt, "submission_check", deps);
  if (submitted) return submitted;

  // A Missed Form. Read what the Reminder names before claiming the send.
  const user = await ct.getUser(shift.userId);
  if (user.outcome !== "ok") return retry(shift, deps, { step: "user", ...user });
  const form = await ct.getForm(settings.complianceFormId);
  if (form.outcome !== "ok") return retry(shift, deps, { step: "form", ...form });

  const claimKey = `reminder:${shift.id}`;
  // The escalation delay is fixed for the Shift when the Reminder goes out.
  const escalateAt = now + settings.escalationDelayMinutes * 60;
  if (!(await store.claimSend(claimKey, shift.id, now))) {
    // Never send twice. A done claim means it already went out; a held one is
    // either another run mid-send or a run that died (alerting on that is #33).
    if ((await store.sendState(claimKey)) === "done") {
      await store.markReminded(shift.id, claimKey, now, escalateAt, settings.reminderTask);
      return "reminded";
    }
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
    return retry(shift, deps, { step: "reminder", ...sent });
  }
  await store.markReminded(shift.id, claimKey, now, escalateAt, settings.reminderTask);
  return "reminded";
}

/**
 * The escalation point. Recipients are read live, so a newly promoted Admin is
 * included and an Excluded Admins change takes effect on the next send. Each
 * recipient's send is claimed on its own: a failure retries only the
 * recipients still owed, next minute, and nobody gets it twice.
 */
async function escalationPoint(shift: ShiftRow, deps: DueStepDeps): Promise<StepResult> {
  const { store, ct, settings, now } = deps;
  const log = deps.log ?? (() => {});
  if (shift.endAt === null || shift.remindedAt === null) return skip(shift, deps);

  const submitted = await checkSubmitted(shift, now, "escalation_check", deps);
  if (submitted) return submitted;

  const users = await ct.listActiveUsers();
  if (users.outcome !== "ok") return retry(shift, deps, { step: "users", ...users });
  let employee = users.data.find((u) => u.userId === shift.userId) ?? null;
  if (!employee) {
    // Archived since the Shift: not in the active list.
    const one = await ct.getUser(shift.userId);
    if (one.outcome !== "ok") return retry(shift, deps, { step: "user", ...one });
    employee = one.data ?? { userId: shift.userId, customFields: [] };
  }
  const form = await ct.getForm(settings.complianceFormId);
  if (form.outcome !== "ok") return retry(shift, deps, { step: "form", ...form });

  const recipients = escalationRecipients({ users: users.data, employee, excludedAdminIds: settings.excludedAdminIds });
  if (recipients.length === 0) log({ evt: "escalation_no_recipients", shiftId: shift.id });

  const text = escalation({
    fullName: [employee.firstName, employee.lastName].filter(Boolean).join(" "),
    userId: shift.userId,
    shift: { startSeconds: shift.startAt, endSeconds: shift.endAt, timeZone: shift.startTz },
    deploymentZone: settings.timeZone,
    formName: form.data.formName,
    remindedMinutesAgo: Math.floor((now - shift.remindedAt) / 60),
    ticked: await store.taskTicked(shift.id),
  });

  let owed = 0;
  for (const recipient of recipients) {
    const claimKey = `escalation:${shift.id}:${recipient}`;
    if (!(await store.claimSend(claimKey, shift.id, now))) {
      // Done: already sent. Held: another run mid-send, or one that died (#33).
      if ((await store.sendState(claimKey)) !== "done") owed++;
      continue;
    }
    const sent = await ct.sendDirectMessage(recipient, text);
    if (sent.outcome !== "ok") {
      await store.releaseSend(claimKey);
      log({ evt: "step_failed", shiftId: shift.id, step: "escalation", recipient, ...sent });
      owed++;
      continue;
    }
    await store.markSendDone(claimKey, now);
  }

  if (owed > 0) return retry(shift, deps, { step: "escalation", owed });
  await store.markEscalated(shift.id, now);
  return "escalated";
}

/** Leave the step due so the next run tries again (backoff and alerting are #33). */
async function retry(shift: ShiftRow, deps: DueStepDeps, detail: Record<string, unknown>): Promise<StepResult> {
  await deps.store.release(shift.id);
  (deps.log ?? (() => {}))({ evt: "step_failed", shiftId: shift.id, ...detail });
  return "retry";
}
