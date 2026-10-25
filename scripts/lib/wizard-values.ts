/**
 * The setup wizard's timing and wording steps (#38): reading what the person
 * types, and the worked examples each step shows (#18: a plain Why, What to
 * do and an Example in real times). Pure, so the examples are tested without
 * a terminal.
 */
import { formatDuration } from "../../src/messages/format.js";
import { QUIET_HOURS } from "../../src/escalation/quietHours.js";

/** The longest "where to find it" phrase a message shows in full (src/messages/reminder.ts caps it at 100). */
export const MAX_WHERE = 100;

/** The longest Grace Period and escalation delay the wizard accepts: past these, a typo is likelier than a choice. */
export const MAX_GRACE_MINUTES = 24 * 60;
export const MAX_DELAY_MINUTES = 72 * 60;

/**
 * "30", "30m", "90 minutes", "4h", "1.5 hours", "1h 30m" -> whole minutes, or
 * `null`. A bare number is in `unit`. Fractions must come to whole minutes.
 */
export function parseDuration(text: string, unit: "minutes" | "hours"): number | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const bare = /^\d+(\.\d+)?$/.test(t) ? Number(t) * (unit === "hours" ? 60 : 1) : null;
  let total = bare;
  if (total === null) {
    const re = /(\d+(?:\.\d+)?)\s*(hours?|hrs|hr|h|minutes?|mins|min|m)\s*/gy;
    let rest = 0;
    let n = 0;
    for (const m of t.matchAll(re)) {
      rest += m[0].length;
      n += Number(m[1]) * (m[2]!.startsWith("h") ? 60 : 1);
    }
    total = rest === t.length ? n : null;
  }
  if (total === null || !Number.isInteger(total) || total < 1) return null;
  return total;
}

/** Minutes after midnight (any day) -> "9:00 pm". */
export function clock12(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

/**
 * The "where to find it" phrase, tidied to finish "You'll find it in …": a
 * leading "in " and a trailing full stop are dropped, since the wizard and
 * the Reminder ("Where: …") supply their own.
 */
export function normaliseWhere(text: string): { ok: true; value: string } | { ok: false; problem: string } {
  const value = text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^in(\s+|$)/i, "")
    .replace(/\.+$/, "")
    .trim();
  if (!value) return { ok: false, problem: "Type where staff find the form, e.g. the Forms tab in the Connecteam app." };
  if (value.length > MAX_WHERE) {
    return { ok: false, problem: `Keep it to ${MAX_WHERE} characters or fewer (that's ${value.length}), so messages show all of it.` };
  }
  return { ok: true, value };
}

const CLOCK_OUT = 17 * 60; // the examples' clock-out, 5:00 pm
const LATE_SHIFT_END = 22 * 60; // the Quiet Hours example's Shift end, 10:00 pm (#16)

/** " (next day)" or " (+2 days)" once the examples' day has passed midnight. */
function dayNote(minutes: number): string {
  const days = Math.floor(minutes / 1440);
  return days === 0 ? "" : days === 1 ? " (next day)" : ` (+${days} days)`;
}

/** "5:30 pm", with its day note. */
const at = (minutes: number) => clock12(minutes) + dayNote(minutes);

/** A timeline row: the time right-aligned, so the events line up, and its day note first. */
const row = (minutes: number, what: string) => `${clock12(minutes).padStart(8)}   ${dayNote(minutes).trim()}${dayNote(minutes) ? " " : ""}${what}`;

/** The Grace Period's worked example. */
export function graceExample(graceMinutes: number): string[] {
  const reminder = CLOCK_OUT + graceMinutes;
  return [
    `Jordan clocks out at ${clock12(CLOCK_OUT)}. With a grace period of ${formatDuration(graceMinutes)},`,
    `if the form isn't in by ${at(reminder)}, Jordan gets a reminder in Connecteam chat.`,
    `If Jordan submits it before then, no message is sent at all.`,
  ];
}

/** The escalation delay's timeline, built from the chosen Grace Period. */
export function delayTimeline(graceMinutes: number, delayMinutes: number): string[] {
  const reminder = CLOCK_OUT + graceMinutes;
  const escalation = reminder + delayMinutes;
  return [
    row(CLOCK_OUT, "Jordan clocks out"),
    row(reminder, `no form yet → reminder to Jordan`),
    row(escalation, `still no form, ${formatDuration(delayMinutes)} later → your admins and Jordan's manager are told`),
    `If Jordan submits any time before ${at(escalation)}, nobody else hears about it.`,
  ];
}

/** Quiet Hours as every Deployment has them: "9:00 pm to 7:00 am". */
export const QUIET_HOURS_LABEL = `${clock12(QUIET_HOURS.from)} to ${clock12(QUIET_HOURS.until)}`;

/** The Quiet Hours example (#16): a Shift ending at 10 pm, with the chosen timings, with Quiet Hours on or off. */
export function quietExample(graceMinutes: number, delayMinutes: number, on: boolean): string[] {
  const reminder = LATE_SHIFT_END + graceMinutes;
  const escalation = reminder + delayMinutes;
  // The window runs across midnight, as src/escalation/quietHours.ts decides.
  const m = escalation % 1440;
  const quiet = m >= QUIET_HOURS.from || m < QUIET_HOURS.until;
  const outcome = !on
    ? "escalation sent straight away (quiet hours off)"
    : quiet
      ? `escalation due → held until ${clock12(QUIET_HOURS.until)}, then sent in the morning summary`
      : "escalation sent straight away (outside quiet hours)";
  return [
    `A shift ends at ${clock12(LATE_SHIFT_END)}.`,
    row(reminder, "reminder to the employee (sent: reminders are never held)"),
    row(escalation, outcome),
  ];
}
