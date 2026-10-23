/**
 * #32: a Shift whose webhook never arrived still gets checked. Each cron run
 * reads the time clocks whose turn it is (yesterday and today) and feeds what
 * the webhook missed into the same path, spaced out to stay within 20% of the
 * daily allowance.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FORM_ID, harness, resetDb, timeActivity } from "./harness.js";
import type { FakeRecord } from "./fake-connecteam.js";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const GRACE = 30 * MINUTE;
const SETTLE = 5 * MINUTE;

/** Sydney wall-clock time on Tue 6 Oct 2026 (AEDT, UTC+11) as Unix seconds. */
const syd = (hour: number, minute = 0) => Date.UTC(2026, 9, 6, hour - 11, minute) / 1000;

const START = syd(9);
const LUNCH = syd(12);
const BACK = syd(12, 30);
const END = syd(17, 2);

const CLOCK = 67;
const JORDAN = { userId: 501, firstName: "Jordan", lastName: "Lee" };
const user = JORDAN.userId;

let h: ReturnType<typeof harness>;
let logs: Record<string, unknown>[];

beforeEach(async () => {
  await resetDb();
  h = harness();
  h.ct.addUser({ ...JORDAN }).addForm(FORM_ID, "Daily Safety Checklist").addTimeClock(CLOCK);
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logs.push(JSON.parse(String(line)) as Record<string, unknown>);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const shift = (id: string, start: number, end?: number, over: Partial<FakeRecord> = {}): FakeRecord => ({
  timeClockId: CLOCK,
  userId: user,
  kind: "shift",
  id,
  start,
  ...(end !== undefined ? { end } : {}),
  modifiedAt: end ?? start,
  ...over,
});
const manualBreak = (id: string, start: number, end?: number) => shift(id, start, end, { kind: "manual_break" });

const checks = () => h.ct.callsTo("GET", `/forms/v1/forms/${FORM_ID}/form-submissions`);
const reads = (clock = CLOCK) => h.ct.sweepCalls.filter((c) => c.path === `/time-clock/v1/time-clocks/${clock}/time-activities`);
const lists = () => h.ct.sweepCalls.filter((c) => c.path === "/time-clock/v1/time-clocks");
/** How many records the sweep found that the webhook missed, over every run so far. */
const found = () =>
  logs.filter((l) => l.evt === "cron").reduce((n, l) => n + Number((l.sweep as { found: number }).found), 0);

async function minutes(from: number, count: number) {
  for (let i = 0; i < count; i++) await h.tick(from + i * MINUTE);
}

describe("a Shift the webhook missed", () => {
  it("gets the same check and Reminder, timed from its recorded end", async () => {
    h.ct.addRecord(shift("ta-1", START, END));
    await h.tick(END + SETTLE);
    expect(found()).toBe(1);
    expect(checks()).toEqual([]);

    await h.tick(END + GRACE);
    expect(checks().map((c) => [c.query.submittingStartTimestamp, c.query.submittingEndTime])).toEqual([
      [String(START), String(END + GRACE)],
    ]);
    expect(h.ct.dms).toHaveLength(1);
    expect(h.ct.dms[0]?.text).toContain("Shift: Tue 6 Oct, 9:00 am – 5:02 pm");
  });

  it("whose clock-out was lost is ended by the sweep", async () => {
    await h.webhook(timeActivity({ eventType: "clock_in", userId: user, id: "ta-1", start: START }));
    h.ct.addRecord(shift("ta-1", START, END));
    await h.tick(END + SETTLE);
    expect(found()).toBe(1);
    await h.tick(END + GRACE);
    expect(h.ct.dms).toHaveLength(1);
  });

  it("joins across a manual break, as the webhook path does", async () => {
    h.ct.addRecord(shift("ta-1", START, LUNCH)).addRecord(manualBreak("br-1", LUNCH, BACK)).addRecord(shift("ta-2", BACK, END));
    await h.tick(END + SETTLE);
    await h.tick(END + GRACE);
    await h.tick(END + GRACE + MINUTE);
    expect(checks().map((c) => c.query.submittingStartTimestamp)).toEqual([String(START)]);
    expect(h.ct.dms).toHaveLength(1);
    expect(h.ct.dms[0]?.text).toContain("Shift: Tue 6 Oct, 9:00 am – 5:02 pm");
  });

  it("with a lost break delivery sends no Reminder mid-break", async () => {
    await h.webhook(timeActivity({ eventType: "clock_out", userId: user, id: "ta-1", start: START, end: LUNCH }));
    h.ct.addRecord(shift("ta-1", START, LUNCH)).addRecord(manualBreak("br-1", LUNCH));
    await h.tick(LUNCH + SETTLE);
    await h.tick(LUNCH + GRACE);
    await h.tick(LUNCH + 2 * HOUR);
    expect(checks()).toEqual([]);
    expect(h.ct.dms).toEqual([]);
  });

  it("ended more than 24 hours before the sweep found it is never checked", async () => {
    const yesterdayEnd = END - 25 * HOUR;
    h.ct.addRecord(shift("ta-1", yesterdayEnd - 8 * HOUR, yesterdayEnd));
    await h.tick(END);
    await h.tick(END + GRACE);
    await h.tick(END + 5 * HOUR);
    expect(checks()).toEqual([]);
    expect(h.ct.dms).toEqual([]);
  });
});

describe("a Shift the webhook told us about", () => {
  it("isn't checked twice or counted as missed", async () => {
    await h.webhook(timeActivity({ eventType: "clock_out", userId: user, id: "ta-1", start: START, end: END }));
    h.ct.addRecord(shift("ta-1", START, END));
    await minutes(END + SETTLE, 30);
    await h.tick(END + GRACE + HOUR);
    expect(found()).toBe(0);
    expect(checks()).toHaveLength(1);
    expect(h.ct.dms).toHaveLength(1);
  });

  it("is left alone while its record is fresh, so a webhook still on its way isn't counted as missed", async () => {
    h.ct.addRecord(shift("ta-1", START, END));
    await minutes(END + MINUTE, 3);
    expect(found()).toBe(0);
    await h.webhook(timeActivity({ eventType: "clock_out", userId: user, id: "ta-1", start: START, end: END }), { at: END + 4 * MINUTE });
    await minutes(END + 4 * MINUTE, 5);
    expect(found()).toBe(0);
    await h.tick(END + GRACE);
    expect(h.ct.dms).toHaveLength(1);
  });

  it("with an edit the webhook missed takes the new times before its check", async () => {
    await h.webhook(timeActivity({ eventType: "clock_out", userId: user, id: "ta-1", start: START, end: END }));
    const edited = END - 30 * MINUTE;
    h.ct.addRecord(shift("ta-1", START, edited, { modifiedAt: END }));
    await h.tick(END + SETTLE);
    expect(found()).toBe(1);
    await h.tick(END + GRACE);
    expect(checks().map((c) => c.query.submittingEndTime)).toEqual([String(edited + GRACE)]);
  });
});

describe("reading the time clocks", () => {
  it("asks for yesterday and today in the Deployment's time zone, one call per clock", async () => {
    await h.tick(syd(9)); // 22:00 the day before, in UTC
    expect(reads().map((c) => [c.query.startDate, c.query.endDate])).toEqual([["2026-10-05", "2026-10-06"]]);
  });

  it("skips archived clocks, and lists the clocks again hourly to pick up new ones", async () => {
    h.ct.addTimeClock(68, true);
    await minutes(START, 3);
    expect(reads(68)).toEqual([]);
    expect(lists()).toHaveLength(1);

    h.ct.addTimeClock(69);
    await h.tick(START + 30 * MINUTE);
    expect(reads(69)).toEqual([]);
    await h.tick(START + HOUR);
    expect(lists()).toHaveLength(2);
    // Two clocks need 2,880 reads a day, over the 20% budget: each is read every other minute.
    await h.tick(START + HOUR + MINUTE);
    expect(reads(69)).toHaveLength(1);
  });

  it("reads one clock every minute when the allowance allows it", async () => {
    await minutes(START, 10);
    expect(reads()).toHaveLength(10);
  });

  it("spreads several clocks out to stay within 20% of the daily allowance", async () => {
    h.ct.addTimeClock(68).addTimeClock(69);
    h.ct.dayLimit = 10_000;
    await minutes(START, 60);

    const all = h.ct.sweepCalls.length;
    expect(all * 24).toBeLessThanOrEqual(0.2 * 10_000);
    // 3 clocks × 1,440 = 4,320 a day against 2,000: each clock every 3 minutes.
    for (const clock of [CLOCK, 68, 69]) expect(reads(clock)).toHaveLength(20);
  });

  it("reads more often once the responses show a larger allowance", async () => {
    h.ct.addTimeClock(68).addTimeClock(69);
    h.ct.dayLimit = 30_000;
    // The first run, before any response, spaces them for Expert's 10,000; that turn runs out first.
    await minutes(START, 3);
    const before = h.ct.sweepCalls.length;
    await minutes(START + 3 * MINUTE, 10);
    // 4,320 a day fits in 20% of 30,000: every clock, every minute.
    expect(h.ct.sweepCalls.length - before).toBe(30);
  });

  it("carries on with the other clocks when a read fails, and reads that clock again at its next turn", async () => {
    h.ct.addTimeClock(68);
    h.ct.dayLimit = 30_000; // room to read both clocks every minute
    await minutes(START, 3);
    h.ct.addRecord(shift("ta-1", START, END)).addRecord(shift("ta-9", START, END, { timeClockId: 68, userId: 502 }));
    h.ct.failNext("GET", `/time-clock/v1/time-clocks/${CLOCK}/time-activities`, 503);
    await h.tick(END + SETTLE);
    expect(found()).toBe(1);
    await h.tick(END + SETTLE + MINUTE);
    expect(found()).toBe(2);
    await h.tick(END + GRACE);
    expect(h.ct.dms.map((d) => d.userId)).toContain(user);
  });
});
