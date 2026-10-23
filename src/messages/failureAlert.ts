/**
 * The Failure Alerts' wording (#33): variant D from the message-wording
 * prototype (#11), fixed, not editable per Deployment. Posted to the Alerts
 * Channel only, never as DMs, and never held for Quiet Hours. Labelled lines
 * only, and every one ends with an `Action:` line, which is kept however long
 * the list above it: names give way first.
 */
import { MAX_MESSAGE, cap, formatDuration, formatShiftDay } from "./format.js";

/** The sends a Failure Alert can list as not reached. */
export type SendKind = "reminder" | "escalation" | "task" | "tick";

/**
 * A send that didn't reach someone, as the alerts list it: `failed` (it kept
 * failing, so it was never sent) or `unconfirmed` (it may have gone out).
 */
export interface MissedSend {
  kind: SendKind;
  /** The employee it was for, or about. */
  userId: number;
  /** Their full name, or blank when it wasn't known. */
  name: string;
  shiftStart: number;
  shiftTz: string;
  outcome: "failed" | "unconfirmed";
}

const KIND: Record<SendKind, { one: string; many: string; label: string }> = {
  reminder: { one: "reminder", many: "reminders", label: "Reminder" },
  escalation: { one: "escalation", many: "escalations", label: "Escalation" },
  task: { one: "reminder task", many: "reminder tasks", label: "Reminder task" },
  tick: { one: "tick message", many: "tick messages", label: "Tick message" },
};

/** What the last failure says went wrong, for the `Cause:` line. */
export function failureCause(f: { outcome: "failed" | "unconfirmed"; status: number | null }): string {
  if (f.outcome === "unconfirmed") return "the integration stopped mid-send";
  if (f.status === 429) return "Connecteam's rate limit";
  if (f.status === null || f.status >= 500) return "Connecteam not responding";
  return `Connecteam refused it (HTTP ${f.status})`;
}

const who = (s: MissedSend) => cap(s.name, 40) || `User ${s.userId}`;

/**
 * ALERT · MESSAGES NOT SENDING: sends kept failing for about an hour (or a
 * claim was stuck), listing who wasn't reached, by kind.
 */
export function messagesNotSending(input: { sinceMinutes: number; cause: string; sends: MissedSend[] }): string {
  const head = `ALERT · MESSAGES NOT SENDING\n\nSince: ${formatDuration(input.sinceMinutes)} ago\nCause: ${input.cause}\n`;
  const action = `\n\nAction: none yet. An all-clear follows when it recovers.`;
  const lines = (names: number) =>
    (["failed", "unconfirmed"] as const)
      .map((outcome) => {
        const sends = input.sends.filter((s) => s.outcome === outcome);
        if (sends.length === 0) return null;
        const groups = (Object.keys(KIND) as SendKind[]).flatMap((kind) => {
          const of = sends.filter((s) => s.kind === kind);
          if (of.length === 0) return [];
          const k = KIND[kind];
          return [`${of.length} ${of.length === 1 ? k.one : k.many}${nameList(of.map(who), names)}`];
        });
        return `${outcome === "failed" ? "Undelivered" : "Unconfirmed"}: ${groups.join(", ")}`;
      })
      .filter((l) => l !== null)
      .join("\n");
  return fit((names) => head + lines(names) + action);
}

/** ALERT · CLOCK-OUT CHECK FAILING: the polling sweep's reads have failed for about an hour (#32). */
export function clockOutCheckFailing(input: { sinceMinutes: number; cause: string }): string {
  return (
    `ALERT · CLOCK-OUT CHECK FAILING\n\n` +
    `Since: ${formatDuration(input.sinceMinutes)} ago\n` +
    `Cause: ${input.cause}\n` +
    `Effect: a clock-out Connecteam doesn't notify us of waits until this recovers\n\n` +
    `Action: none yet. An all-clear follows when it recovers.`
  );
}

/**
 * ALL CLEAR: the condition recovered. For sends, it lists every one given up
 * on since the last all clear, to follow up by hand.
 */
export function allClear(input: { recovered: "messages" | "sweep"; sends: MissedSend[] }): string {
  const what = input.recovered === "messages" ? "Messages are sending again." : "The clock-out check is working again.";
  if (input.sends.length === 0) return `ALL CLEAR\n\n${what}\n\nAction: none.`;
  return fit((names) => {
    const shown = input.sends.slice(0, names);
    const more = input.sends.length - shown.length;
    const items = shown.map(
      (s) =>
        `- ${KIND[s.kind].label}: ${who(s)}, ${formatShiftDay(s.shiftStart, s.shiftTz)}` +
        (s.outcome === "unconfirmed" ? " (unconfirmed)" : ""),
    );
    if (more > 0) items.push(`- and ${more} more`);
    return `ALL CLEAR\n\n${what}\nNot delivered:\n${items.join("\n")}\n\nAction: follow these up by hand if needed.`;
  });
}

/** " (A, B and 2 more)", showing at most `names` names. */
function nameList(names: string[], max: number): string {
  if (max <= 0) return "";
  const shown = names.slice(0, max);
  const more = names.length - shown.length;
  return ` (${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""})`;
}

/** The text with as many names as fit in {@link MAX_MESSAGE}, so the `Action:` line is never cut. */
function fit(build: (names: number) => string): string {
  for (let names = 50; names > 0; names--) {
    const text = build(names);
    if (text.length <= MAX_MESSAGE) return text;
  }
  return build(0);
}
