/**
 * The Reminder's wording: variant D from the message-wording prototype (#11),
 * fixed, not editable per Deployment. The client sets only the "where to find
 * it" phrase (and the publisher's name, which Connecteam shows as the sender).
 */
import { cap, clampMessage, formatDuration, formatOpenShift, formatShift, type ShiftTimes } from "./format.js";

export interface ReminderInput {
  /** Blank when Connecteam has no first name for the user. */
  firstName: string;
  shift: ShiftTimes;
  deploymentZone: string;
  formName: string;
  whereToFind: string;
  escalationDelayMinutes: number;
}

/** The "Shift ended" Reminder: the Grace Period passed with no Compliance Form. */
export function reminderShiftEnded(input: ReminderInput): string {
  const first = cap(input.firstName, 40) || "there";
  return clampMessage(
    `Hi ${first} 👋\n\n` +
      `We haven't received your form for this shift yet.\n\n` +
      `Shift: ${formatShift(input.shift, input.deploymentZone)}\n` +
      `Form: ${cap(input.formName, 100)}\n` +
      `Where: ${cap(input.whereToFind, 100)}\n\n` +
      `Please submit it now. Your manager is notified if it's still missing in ${formatDuration(input.escalationDelayMinutes)}.`,
  );
}

/**
 * The "still clocked in" Reminder, and its "break never ended" form (#24): the
 * Shift was still open at its Scheduled Shift's planned end (`shift.endSeconds`),
 * so it was treated as ending then.
 */
export function reminderStillOpen(input: ReminderInput & { onBreak: boolean }): string {
  const first = cap(input.firstName, 40) || "there";
  const [opening, step] = input.onBreak
    ? ["Your break is still running", "End your break and clock out if you've finished."]
    : ["You're still clocked in", "Clock out if you've finished."];
  return clampMessage(
    `Hi ${first} 👋\n\n` +
      `${opening}, and we haven't received your form for this shift yet.\n\n` +
      `Shift: ${formatOpenShift(input.shift, input.deploymentZone)}\n` +
      `Form: ${cap(input.formName, 100)}\n` +
      `Where: ${cap(input.whereToFind, 100)}\n\n` +
      `1. ${step}\n` +
      `2. Submit the form.\n\n` +
      `Your manager is notified if it's still missing in ${formatDuration(input.escalationDelayMinutes)}.`,
  );
}
