/**
 * The Reminder Task's wording: variant D from the message-wording prototype
 * (#11), fixed, not editable per Deployment. Like the Reminder, it names the
 * form and says where to find it; the API can't link a task to a form (#4).
 */
import { cap, formatShift, formatShiftDay, type ShiftTimes } from "./format.js";

export interface ReminderTaskInput {
  shift: ShiftTimes;
  deploymentZone: string;
  formName: string;
  whereToFind: string;
}

/** "Daily Safety Checklist – Tue 20 Oct": the form and the Shift's day, in the zone it was recorded in. */
export function reminderTaskTitle(input: ReminderTaskInput): string {
  return `${cap(input.formName, 100)} – ${formatShiftDay(input.shift.startSeconds, input.shift.timeZone)}`;
}

export function reminderTaskDescription(input: ReminderTaskInput): string {
  return (
    `Shift: ${formatShift(input.shift, input.deploymentZone)}\n` +
    `Where: ${cap(input.whereToFind, 100)}\n\n` +
    `Closes automatically when the form is received. Ticking it does not count as submitting.`
  );
}
