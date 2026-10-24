/**
 * The Escalation's wording: variant D from the message-wording prototype
 * (#11), fixed, not editable per Deployment. Labelled lines only, and never
 * any form content: who, which Shift, which form, how long ago reminded (or
 * that the Reminder couldn't be confirmed, #33), and whether they ticked the
 * Reminder Task without submitting (#28).
 */
import { MAX_MESSAGE, cap, clampMessage, formatDuration, formatShift, type ShiftTimes } from "./format.js";

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

/** One Shift held overnight, for the Escalation Summary. */
export interface SummaryEntry {
  /** The employee's full name; blank when Connecteam has none. */
  fullName: string;
  userId: number;
  shift: ShiftTimes;
  /** Whole minutes since the Reminder went out, or `null` when it was given up on (#33). */
  remindedMinutesAgo: number | null;
  /** They ticked the Reminder Task without submitting (#28). */
  ticked: boolean;
}

/**
 * The Escalation Summary (#16, #29), variant D: everything held for one
 * recipient over Quiet Hours, one line per Shift, oldest first. Split into
 * more than one message only past 500 characters; each counts its own lines.
 * Returns each message with the entries it carries, in order.
 */
export function escalationSummaries(input: {
  formName: string;
  deploymentZone: string;
  entries: SummaryEntry[];
}): { text: string; entries: SummaryEntry[] }[] {
  const line = (e: SummaryEntry) =>
    `- ${cap(e.fullName, 60) || `User ${e.userId}`} · ${formatShift(e.shift, input.deploymentZone)}` +
    (e.remindedMinutesAgo === null ? " · reminder not confirmed" : "") +
    (e.ticked ? " · ticked the task" : "");
  const build = (entries: SummaryEntry[]) => {
    const ages = entries.flatMap((e) => (e.remindedMinutesAgo === null ? [] : [e.remindedMinutesAgo]));
    const foot = ages.length > 0 ? `Each was reminded at least ${formatDuration(Math.min(...ages))} ago.` : "None of these reminders could be confirmed.";
    return (
      `MISSING COMPLIANCE FORMS (${entries.length})\n\n` +
      `Form: ${cap(input.formName, 100)}\n` +
      `Held overnight (quiet hours):\n\n` +
      `${entries.map(line).join("\n")}\n\n` +
      foot
    );
  };

  const ordered = [...input.entries].sort((a, b) => a.shift.startSeconds - b.shift.startSeconds);
  const messages: { text: string; entries: SummaryEntry[] }[] = [];
  let current: SummaryEntry[] = [];
  for (const e of ordered) {
    if (current.length > 0 && build([...current, e]).length > MAX_MESSAGE) {
      messages.push({ text: clampMessage(build(current)), entries: current });
      current = [];
    }
    current.push(e);
  }
  if (current.length > 0) messages.push({ text: clampMessage(build(current)), entries: current });
  return messages;
}

