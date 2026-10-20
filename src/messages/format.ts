/**
 * The building blocks every message shares: Shift times, durations and the
 * 500-character ceiling. Pure, so the wording tests run in plain node.
 */

/** Connecteam chat's limit as we write to it (#4: the docs say 500 or 1,000). */
export const MAX_MESSAGE = 500;

/** Clamp a whole message to {@link MAX_MESSAGE}, as EH_Webhook does. */
export function clampMessage(text: string): string {
  const t = text.trim();
  return t.length <= MAX_MESSAGE ? t : `${t.slice(0, MAX_MESSAGE - 1)}…`;
}

/** Cut one placeholder value to `max` characters, so one long name can't crowd out the rest. */
export function cap(value: string, max: number): string {
  const t = value.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

export interface ShiftTimes {
  /** Unix seconds. */
  startSeconds: number;
  /** Unix seconds. */
  endSeconds: number;
  /** The IANA zone the Shift was recorded in. */
  timeZone: string;
}

/**
 * "Mon 20 Oct, 9:00 am – 5:02 pm", in the zone the Shift was recorded in. The
 * zone's short name is added ("… (AWST)") only when it differs from the
 * Deployment's zone at that moment.
 */
export function formatShift(shift: ShiftTimes, deploymentZone: string): string {
  const start = parts(shift.startSeconds, shift.timeZone);
  const end = parts(shift.endSeconds, shift.timeZone);
  const text = `${start.day}, ${start.time} – ${end.time}`;
  const home = parts(shift.startSeconds, deploymentZone);
  return start.zone === home.zone ? text : `${text} (${start.zone})`;
}

/** "Mon 20 Oct", the Shift's day on its own. */
export function formatShiftDay(startSeconds: number, timeZone: string): string {
  return parts(startSeconds, timeZone).day;
}

/** "30 minutes", "4 hours", "1 hour 30 minutes". */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (h === 0) return unit(m, "minute");
  if (m === 0) return unit(h, "hour");
  return `${unit(h, "hour")} ${unit(m, "minute")}`;
}

function parts(seconds: number, timeZone: string): { day: string; time: string; zone: string } {
  const fmt = new Intl.DateTimeFormat("en-AU", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });
  const p: Record<string, string> = {};
  for (const { type, value } of fmt.formatToParts(new Date(seconds * 1000))) p[type] = value;
  return {
    day: `${p.weekday} ${p.day} ${p.month}`,
    time: `${p.hour}:${p.minute} ${(p.dayPeriod ?? "").toLowerCase()}`,
    zone: p.timeZoneName ?? timeZone,
  };
}
