/**
 * Quiet Hours (#16, #29): a nightly window in the Deployment's one named time
 * zone, during which Escalations wait. Fixed at 9 pm to 7 am; a Deployment
 * only turns them on or off. Pure, so the clock maths (a window across
 * midnight, daylight saving) is tested without a Worker.
 */

/** From and until, in minutes after local midnight. A window with from > until runs across midnight. */
export interface QuietHours {
  from: number;
  until: number;
}

/** Every Deployment's Quiet Hours when they're on: 9 pm to 7 am. */
export const QUIET_HOURS: QuietHours = { from: 21 * 60, until: 7 * 60 };

/** Whether `at` (Unix seconds) falls in Quiet Hours, by the local clock in `zone`. Equal ends mean never. */
export function isQuiet(at: number, zone: string, q: QuietHours): boolean {
  if (q.from === q.until) return false;
  const m = local(at, zone).minutes;
  return q.from < q.until ? m >= q.from && m < q.until : m >= q.from || m < q.until;
}

/**
 * When the Quiet Hours `at` falls in end: the next time the local clock in
 * `zone` reads `until`, after `at`, in Unix seconds. Follows daylight saving:
 * 7:00 am is 7:00 am on the morning the clocks change.
 */
export function quietEnds(at: number, zone: string, q: QuietHours): number {
  const today = local(at, zone);
  for (let day = 0; day <= 2; day++) {
    const t = wallClock(today.y, today.mo, today.d + day, q.until, zone);
    if (t > at) return t;
  }
  return at;
}

/** The Unix seconds at which the local clock in `zone` reads `minutes` on the local day `at` falls on (the setup wizard's sample Shift, #40). */
export function onLocalDay(at: number, zone: string, minutes: number): number {
  const day = local(at, zone);
  return wallClock(day.y, day.mo, day.d, minutes, zone);
}

/** The Unix seconds at which the local clock in `zone` reads `minutes` on that (possibly overflowing) date. */
function wallClock(y: number, mo: number, d: number, minutes: number, zone: string): number {
  const asUtc = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60) / 1000;
  // The zone's offset is read at the guess, then again at the corrected time, for a change in between.
  let t = asUtc - offset(asUtc, zone);
  t = asUtc - offset(t, zone);
  return t;
}

/** The zone's offset from UTC at `at`, in seconds. */
function offset(at: number, zone: string): number {
  const l = local(at, zone);
  return Date.UTC(l.y, l.mo - 1, l.d, Math.floor(l.minutes / 60), l.minutes % 60, l.s) / 1000 - at;
}

function local(at: number, zone: string): { y: number; mo: number; d: number; minutes: number; s: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const p: Record<string, number> = {};
  for (const { type, value } of fmt.formatToParts(new Date(at * 1000))) p[type] = Number(value);
  return { y: p.year!, mo: p.month!, d: p.day!, minutes: p.hour! * 60 + p.minute!, s: p.second! };
}
