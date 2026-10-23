/**
 * The Escalation's wording: variant D from the message-wording prototype
 * (#11), fixed, not editable per Deployment. Labelled lines only, and never
 * any form content: who, which Shift, which form, how long ago reminded, and
 * whether they ticked the Reminder Task without submitting (#28).
 */
import { cap, clampMessage, formatDuration, formatShift, type ShiftTimes } from "./format.js";

export interface EscalationInput {
  /** The employee's full name; blank when Connecteam has none. */
  fullName: string;
  userId: number;
  shift: ShiftTimes;
  deploymentZone: string;
  formName: string;
  /** Whole minutes since the Reminder went out. */
  remindedMinutesAgo: number;
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
      `Reminded: ${formatDuration(input.remindedMinutesAgo)} ago` +
      (input.ticked ? `\nNote: ticked the reminder task without submitting` : ""),
  );
}
