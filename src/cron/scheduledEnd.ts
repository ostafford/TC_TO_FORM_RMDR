/**
 * Open past the Scheduled Shift's end (#24). A Shift still open (clocked in,
 * or on a break) with a Scheduled Shift is checked against it: its planned
 * end is read when it comes, so an Admin's edit counts.
 *  - still ahead: check again at the planned end;
 *  - passed, and the Shift still open: treat it as ending then. Its Grace
 *    Period runs from the planned end, and its Reminder says they're still
 *    clocked in, or still on their break (./dueSteps.ts);
 *  - not found under any scheduler: no Scheduled Shift, so it waits for the
 *    real clock-out.
 * A clock-out before then ends it as usual (../store.ts, `#refreshTimes`).
 */
import { findScheduledShift, type SchedulerReads } from "../escalation/scheduledShift.js";
import type { ShiftRow } from "../store.js";
import { LONGEST_WAIT_SECONDS } from "./backoff.js";
import type { DueStepDeps } from "./dueSteps.js";
import { retry, skip, type GiveUp, type StepResult } from "./steps.js";

export async function scheduledEnd(shift: ShiftRow, deps: DueStepDeps, reads: SchedulerReads): Promise<StepResult> {
  const { store, ct, settings, now } = deps;
  const log = deps.log ?? (() => {});
  if (!shift.schedulerShiftId) return skip(shift, deps);

  // Nothing to give up on: it keeps trying, at the longest wait.
  const keepTrying: GiveUp = async () => {
    await store.backOff(shift.id, shift.status, now, LONGEST_WAIT_SECONDS);
    return "retry";
  };
  const found = await findScheduledShift(ct, shift.schedulerShiftId, reads);
  if (found.outcome !== "ok") return retry(shift, deps, { step: "scheduled_shift", ...found }, keepTrying);

  if (!found.data) {
    await store.noScheduledShift(shift.id);
    log({ evt: "no_scheduled_shift", shiftId: shift.id, schedulerShiftId: shift.schedulerShiftId });
    return "scheduled";
  }
  const plannedEnd = found.data.endTime;
  if (plannedEnd > now) {
    await store.checkScheduleAt(shift.id, plannedEnd);
    return "scheduled";
  }
  await store.endBySchedule(shift.id, plannedEnd, settings.gracePeriodMinutes * 60);
  log({ evt: "ended_by_schedule", shiftId: shift.id, plannedEnd });
  return "scheduled";
}
