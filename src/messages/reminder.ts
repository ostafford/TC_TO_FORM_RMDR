/**
 * The Reminder's wording: variant D from the message-wording prototype (#11),
 * fixed, not editable per Deployment. The client sets only the "where to find
 * it" phrase (and the publisher's name, which Connecteam shows as the sender).
 */
import { cap, clampMessage, formatDuration, formatShift, type ShiftTimes } from "./format.js";

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
