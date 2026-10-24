/**
 * The Failure Alerts' wording (#33, #34): variant D from the message-wording
 * prototype (#11), fixed, not editable per Deployment. Posted to the Alerts
 * Channel only, never as DMs, and never held for Quiet Hours. Labelled lines
 * only, and every one ends with an `Action:` line, which is kept however long
 * the list above it: names give way first.
 */
import { MAX_MESSAGE, cap, formatDuration, formatShiftDay } from "./format.js";

/** The sends a Failure Alert can list as not reached. */
export type SendKind = "reminder" | "escalation" | "task" | "tick";

/** A setting that can point at something gone (#34). */
export type GoneSetting = "form" | "publisher" | "board";

/**
 * The Failure Alert conditions. messages: sends given up on (#33). sweep: the
 * sweep's reads failing (#33). key: Connecteam rejected the API key, so work
 * is paused (#34). form, publisher, board: that setting points at something
 * gone (#34). webhook: clock-outs not arriving (#34). allowance: the daily API
 * allowance more than 80% used (#34).
 */
export type AlertCondition = "messages" | "sweep" | "key" | GoneSetting | "webhook" | "allowance";

/**
 * A send that didn't reach someone, as the alerts list it: `failed` (it kept
 * failing, so it was never sent), `unconfirmed` (it may have gone out) or
 * `skipped` (more than an hour overdue when work resumed, #34).
 */
export interface MissedSend {
  kind: SendKind;
  /** The employee it was for, or about. */
  userId: number;
  /** Their full name, or blank when it wasn't known. */
  name: string;
  shiftStart: number;
  shiftTz: string;
  outcome: "failed" | "unconfirmed" | "skipped";
}

const KIND: Record<SendKind, { one: string; many: string; label: string }> = {
  reminder: { one: "reminder", many: "reminders", label: "Reminder" },
  escalation: { one: "escalation", many: "escalations", label: "Escalation" },
  task: { one: "reminder task", many: "reminder tasks", label: "Reminder task" },
  tick: { one: "tick message", many: "tick messages", label: "Tick message" },
};

/** What the last failure says went wrong, for the `Cause:` line. */
export function failureCause(f: { outcome: MissedSend["outcome"]; status: number | null }): string {
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
export function messagesNotSending(input: {
  sinceMinutes: number;
  cause: string;
  sends: MissedSend[];
  /** Counts only, no names: for the Integrator Relay, whose issues are on a public repo (#36). */
  anonymous?: boolean;
}): string {
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
  return input.anonymous ? head + lines(0) + action : fit((names) => head + lines(names) + action);
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

/** ALERT · PAUSED: Connecteam rejected the API key, so no work is done until it's replaced (#34). */
export function paused(): string {
  return (
    `ALERT · PAUSED\n\n` +
    `Cause: Connecteam rejected the API key\n` +
    `Effect: no reminders or escalations\n\n` +
    `Action: create a new API key (Settings → API keys), then rerun setup step "API key".`
  );
}

const SETTING: Record<GoneSetting, { title: string; setting: string; step: string }> = {
  form: { title: "FORM NOT FOUND", setting: "Compliance Form", step: "Compliance Form" },
  publisher: { title: "SENDER NOT FOUND", setting: "Sender (custom publisher)", step: "Sender name" },
  board: { title: "TASK BOARD NOT FOUND", setting: "Reminder Task board", step: "Reminder Task" },
};

/**
 * ALERT · FORM NOT FOUND, and the same shape for the publisher and the task
 * board (#34): a setting points at something gone. Once gone, its name can't
 * be read, so it's named by id.
 */
export function settingGone(input: { setting: GoneSetting; id: string }): string {
  const s = SETTING[input.setting];
  return (
    `ALERT · ${s.title}\n\n` +
    `Setting: ${s.setting} (id ${cap(input.id, 40)})\n` +
    `Cause: deleted or no longer available\n\n` +
    `Action: rerun setup step "${s.step}".`
  );
}

/**
 * ALERT · CLOCK-OUTS NOT ARRIVING (#34): the sweep keeps finding Shifts the
 * webhook missed, or no webhook has arrived for 24 hours while Shifts happened.
 */
export function clockOutsNotArriving(input: { missed: number } | { silentHours: number }): string {
  const what = "missed" in input ? `Missed: ${input.missed} in the last 24 hours` : `Since: ${input.silentHours} hours`;
  return (
    `ALERT · CLOCK-OUTS NOT ARRIVING\n\n` +
    `${what}\n` +
    `Effect: reminders still sent, up to a few minutes late\n\n` +
    `Action: rerun setup step "Webhook".`
  );
}

/** ALERT · API ALLOWANCE 80% USED (#34). */
export function allowanceUsed(): string {
  return (
    `ALERT · API ALLOWANCE 80% USED\n\n` +
    `Shared with: every integration on this account\n` +
    `If exhausted: reminders stop until tomorrow\n\n` +
    `Action: none yet.`
  );
}

const RECOVERED: Record<AlertCondition, string> = {
  messages: "Messages are sending again.",
  sweep: "The clock-out check is working again.",
  key: "Connecteam accepts the API key again.",
  form: "The Compliance Form setting works again.",
  publisher: "The sender setting works again.",
  board: "The Reminder Task board setting works again.",
  webhook: "Clock-outs are arriving again.",
  allowance: "The API allowance is under 80% used again.",
};

/**
 * ALL CLEAR: the condition recovered. It lists every send given up on since
 * the condition's last all clear, to follow up by hand: for `messages`, those
 * not delivered; after a block, those skipped as more than an hour late.
 */
export function allClear(input: {
  recovered: AlertCondition;
  sends: MissedSend[];
  /** Counts only, no names: for the Integrator Relay (#36). */
  anonymous?: boolean;
}): string {
  const what = RECOVERED[input.recovered];
  if (input.sends.length === 0) return `ALL CLEAR\n\n${what}\n\nAction: none.`;
  const label = input.recovered === "messages" ? "Not delivered:" : "Skipped (over an hour late):";
  if (input.anonymous) {
    const counts = (Object.keys(KIND) as SendKind[]).flatMap((kind) => {
      const n = input.sends.filter((s) => s.kind === kind).length;
      return n === 0 ? [] : [`${n} ${n === 1 ? KIND[kind].one : KIND[kind].many}`];
    });
    return `ALL CLEAR\n\n${what}\n${label} ${counts.join(", ")}, named in the Alerts Channel\n\nAction: follow these up by hand if needed.`;
  }
  return fit((names) => {
    const shown = input.sends.slice(0, names);
    const more = input.sends.length - shown.length;
    const items = shown.map(
      (s) =>
        `- ${KIND[s.kind].label}: ${who(s)}, ${formatShiftDay(s.shiftStart, s.shiftTz)}` +
        (s.outcome === "unconfirmed" ? " (unconfirmed)" : ""),
    );
    if (more > 0) items.push(`- and ${more} more`);
    return `ALL CLEAR\n\n${what}\n${label}\n${items.join("\n")}\n\nAction: follow these up by hand if needed.`;
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
