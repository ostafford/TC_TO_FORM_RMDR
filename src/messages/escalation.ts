/**
 * The Escalation's wording: variant D from the message-wording prototype
 * (#11), fixed, not editable per Deployment. Labelled lines only, and never
 * any form content: who, which Shift, which form, how long ago reminded (or
 * that the Reminder couldn't be confirmed, #33), and whether they ticked the
 * Reminder Task without submitting (#28).
 */
import { cap, clampMessage, formatDuration, formatShift, type ShiftTimes } from "./format.js";

export interface EscalationInput {
  /** The employee's full name; blank when Connecteam has none. */
  fullName: string;
  userId: number;
  shift: ShiftTimes;
  deploymentZone: string;
  formName: string;
  /** Whole minutes since the Reminder went out, or `null` when it was given up on (#33). */
  remindedMinutesAgo: number | null;
  /** They ticked the Reminder Task without submitting, so they saw the Reminder. */
  ticked: boolean;
}

export function escalation(input: EscalationInput): string {
  const employee = cap(input.fullName, 80) || `User ${input.userId}`;
  return clampMessage(
    `MISSING COMPLIANCE FORM\n\n` +
      `Employee: ${employee}\n` +
      `Shift: ${formatShift(input.shift, input.deploymentZone)}\n` +
      `Form: ${cap(input.formName, 100)}\n` +
      (input.remindedMinutesAgo === null
        ? `Reminded: not confirmed (sending failed)`
        : `Reminded: ${formatDuration(input.remindedMinutesAgo)} ago`) +
      (input.ticked ? `\nNote: ticked the reminder task without submitting` : ""),
  );
}
