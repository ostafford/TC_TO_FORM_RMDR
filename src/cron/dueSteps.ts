/**
 * One cron run's work (ADR-0002): lease the Shifts whose next step is due,
 * oldest first, and do that step. For now the only step is the end of the
 * Grace Period: one `form-submissions` check, then the Reminder if nothing
 * arrived.
 */
import type { ConnecteamClient } from "../connecteam/client.js";
import type { Settings } from "../env.js";
import { reminderShiftEnded } from "../messages/reminder.js";
import type { ShiftRow, WorkList } from "../store.js";

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

export type StepResult = "submitted" | "reminded" | "retry" | "skipped";

export async function runDueSteps(deps: DueStepDeps): Promise<Record<StepResult, number>> {
  const counts: Record<StepResult, number> = { submitted: 0, reminded: 0, retry: 0, skipped: 0 };
  for (const shift of await deps.store.takeDue(deps.now, BATCH)) {
    const result = await endOfGracePeriod(shift, deps);
    counts[result]++;
  }
  return counts;
}

async function endOfGracePeriod(shift: ShiftRow, deps: DueStepDeps): Promise<StepResult> {
  const { store, ct, settings, now } = deps;
  const log = deps.log ?? (() => {});
  if (shift.status !== "grace" || shift.endAt === null || shift.graceEndsAt === null) {
    await store.release(shift.id);
    return "skipped";
  }

  // Did they submit between the Shift's first clock-in and the end of the Grace Period?
  for (const formId of shift.formIds) {
    const found = await ct.findFormSubmission(formId, {
      userId: shift.userId,
      fromSeconds: shift.startAt,
      toSeconds: shift.graceEndsAt,
    });
    if (found.outcome !== "ok") return retry(shift, deps, { step: "submission_check", ...found });
    if (found.data) {
      await store.markSubmitted(shift.id, found.data.formSubmissionId);
      return "submitted";
    }
  }

  // A Missed Form. Read what the Reminder names before claiming the send.
  const user = await ct.getUser(shift.userId);
  if (user.outcome !== "ok") return retry(shift, deps, { step: "user", ...user });
  const form = await ct.getForm(settings.complianceFormId);
  if (form.outcome !== "ok") return retry(shift, deps, { step: "form", ...form });

  const claimKey = `reminder:${shift.id}`;
  if (!(await store.claimSend(claimKey, shift.id, now))) {
    // Never send twice. A done claim means it already went out; a held one is
    // either another run mid-send or a run that died (alerting on that is #33).
    if ((await store.sendState(claimKey)) === "done") {
      await store.markReminded(shift.id, claimKey, now);
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
  await store.markReminded(shift.id, claimKey, now);
  return "reminded";
}

/** Leave the step due so the next run tries again (backoff and alerting are #33). */
async function retry(shift: ShiftRow, deps: DueStepDeps, detail: Record<string, unknown>): Promise<StepResult> {
  await deps.store.release(shift.id);
  (deps.log ?? (() => {}))({ evt: "step_failed", shiftId: shift.id, ...detail });
  return "retry";
}
