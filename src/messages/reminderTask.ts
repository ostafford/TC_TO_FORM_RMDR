/**
 * The Reminder Task's wording: variant D from the message-wording prototype
 * (#11), fixed, not editable per Deployment. Like the Reminder, it names the
 * form and says where to find it; the API can't link a task to a form (#4).
 */
import { cap, clampMessage, formatShift, formatShiftDay, type ShiftTimes } from "./format.js";

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

/**
 * The tick DM (#28): the employee ticked the Reminder Task without submitting,
 * and it has been reopened. Sent once per Reminder Task, never held.
 */
export function tickDm(input: ReminderTaskInput & { firstName: string }): string {
  const first = cap(input.firstName, 40) || "there";
  return clampMessage(
    `Hi ${first} 👋\n\n` +
      `Thanks for ticking the task, but we haven't received your form yet.\n\n` +
      `Shift: ${formatShift(input.shift, input.deploymentZone)}\n` +
      `Form: ${cap(input.formName, 100)}\n` +
      `Where: ${cap(input.whereToFind, 100)}\n\n` +
      `Ticking the task doesn't submit the form. The task has been reopened and ticks itself off once your form arrives.`,
  );
}
