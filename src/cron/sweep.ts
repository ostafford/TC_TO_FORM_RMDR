/**
 * The polling sweep (#32): the safety net under the `time_activity` webhook,
 * which gets at most 3 retries and no replay (research #2). Each run reads
 * the time clocks whose turn it is, yesterday and today in the Deployment's
 * time zone, one call per clock, and feeds every record the webhook missed or
 * left stale into the same path a delivery takes, so the same rules apply:
 * the 24-hour cutoff, break joining, the recorded end time, and no second
 * check for a Shift already known.
 *
 * It's spaced out so it never uses more than 20% of the account's daily
 * allowance, which other integrations share: each clock is read every
 * {@link sweepIntervalMinutes} minutes.
 */
import type { TimeActivity } from "../connecteam/types.js";
import type { DueStepDeps } from "./dueSteps.js";

/** The share of the daily allowance the sweep may use. */
const SWEEP_SHARE = 0.2;

/** Expert's daily allowance, the lowest plan with API access: used until a response says otherwise. */
export const DEFAULT_DAY_LIMIT = 10_000;

/** The time clocks are listed again this often, to pick up new and archived ones. */
const CLOCK_LIST_SECONDS = 60 * 60;

/**
 * A record changed this recently is left for its webhook, which is likely
 * still on its way, so it isn't fed (or counted as missed) ahead of it.
 */
export const SETTLE_SECONDS = 5 * 60;

const MINUTES_PER_DAY = 24 * 60;

/** How often each clock is read: every minute when the budget allows, otherwise spread out. */
export function sweepIntervalMinutes(clocks: number, dayLimit: number): number {
  const listing = (24 * 60 * 60) / CLOCK_LIST_SECONDS;
  const budget = Math.max(1, Math.floor(dayLimit * SWEEP_SHARE) - listing);
  return Math.max(1, Math.ceil((clocks * MINUTES_PER_DAY) / budget));
}

export interface SweepResult {
  /** Time clocks read this run. */
  swept: number;
  /** Records the webhook missed or left stale, now fed in. */
  found: number;
  failed: number;
}

export async function runSweep(deps: DueStepDeps): Promise<SweepResult> {
  const { store, ct, now } = deps;
  const log = deps.log ?? (() => {});
  const result: SweepResult = { swept: 0, found: 0, failed: 0 };

  const listedAt = await store.sweepState("clocks_listed_at");
  if (listedAt === null || now - listedAt >= CLOCK_LIST_SECONDS) {
    const clocks = await ct.listTimeClocks();
    if (clocks.outcome === "ok") {
      // Archived clocks take no new records.
      await store.setSweepClocks(clocks.data.filter((c) => !c.isArchived).map((c) => c.id), now);
    } else {
      // Sweep the clocks already known; listing is tried again next run.
      result.failed++;
      log({ evt: "step_failed", step: "sweep_clocks", ...clocks });
    }
  }

  const clocks = await store.sweepClockCount();
  if (clocks > 0) {
    const every = sweepIntervalMinutes(clocks, (await store.sweepState("day_limit")) ?? DEFAULT_DAY_LIMIT);
    const today = dateIn(deps.settings.timeZone, now);
    const yesterday = dayBefore(today);
    for (const clock of await store.takeDueClocks(now, Math.ceil(clocks / every), now + every * 60)) {
      const read = await ct.listTimeActivities(clock, yesterday, today);
      if (read.outcome !== "ok") {
        // Its turn has moved on: the next read is one interval away, as planned.
        result.failed++;
        log({ evt: "step_failed", step: "sweep", timeClockId: clock, ...read });
        continue;
      }
      result.swept++;
      result.found += await feed(clock, read.data, deps);
    }
  }

  const dayLimit = ct.lastRateLimit?.dayLimit;
  if (dayLimit) await store.setSweepState("day_limit", dayLimit);
  return result;
}

/** Feed what one clock read found that we don't already have. Returns how many records that was. */
async function feed(
  timeClockId: number,
  users: { userId: number; shifts: TimeActivity[]; manualBreaks: TimeActivity[] }[],
  deps: DueStepDeps,
): Promise<number> {
  const { store, settings, now } = deps;
  const records = users
    .flatMap((u) => [
      ...u.shifts.map((activity) => ({ kind: "segment" as const, userId: u.userId, activity })),
      ...u.manualBreaks.map((activity) => ({ kind: "break" as const, userId: u.userId, activity })),
    ])
    .filter(({ activity: a }) => (a.modifiedAt ?? a.end?.timestamp ?? a.start.timestamp) <= now - SETTLE_SECONDS)
    .sort((x, y) => x.activity.start.timestamp - y.activity.start.timestamp);

  const known = await store.knownRecords(records.map((r) => r.activity.id));
  const opts = { formIds: [settings.complianceFormId], gracePeriodMinutes: settings.gracePeriodMinutes, now };
  let found = 0;
  for (const { kind, userId, activity } of records) {
    const was = known.get(activity.id);
    const end = activity.end?.timestamp ?? null;
    // An end is never taken away (a stored end stays, as for a delivery).
    if (was && was.startAt === activity.start.timestamp && (was.endAt === end || end === null)) continue;

    const write = { dedupeKey: null, eventType: "sweep", userId, activity };
    if (kind === "segment") await store.recordSegment({ ...write, timeClockId }, opts);
    else await store.recordBreak(write, opts);
    await store.recordSweepFind({ timeActivityId: activity.id, kind, userId }, now);
    (deps.log ?? (() => {}))({ evt: "sweep_found", kind, userId, timeActivityId: activity.id, known: was !== undefined });
    found++;
  }
  return found;
}

/** The calendar date (`YYYY-MM-DD`) at `seconds` in `timeZone`. */
function dateIn(timeZone: string, seconds: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(seconds * 1000),
  );
}

/** The calendar day before a `YYYY-MM-DD` date. */
function dayBefore(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
