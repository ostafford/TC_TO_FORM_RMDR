/**
 * #23 (ADR-0001): a worker who takes lunch owes one Compliance Form and gets
 * no Reminder mid-break. Shift Segments joined by a manual break, at exactly
 * both ends, are one Shift. The deliveries follow what Connecteam sent live on
 * 2026-10-21: starting a break sends the segment's ordinary `clock_out`, then
 * the break's `clock_in`; resuming sends the break's `clock_out`, then a new
 * segment's `clock_in`.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { FORM_ID, deletion, harness, manualBreak, resetDb, timeActivity } from "./harness.js";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const GRACE = 30 * MINUTE;

/** Sydney wall-clock time on Tue 6 Oct 2026 (AEDT, UTC+11) as Unix seconds. */
const syd = (hour: number, minute = 0) => Date.UTC(2026, 9, 6, hour - 11, minute) / 1000;

const START = syd(9);
const LUNCH = syd(12);
const BACK = syd(12, 30);
const END = syd(17, 2);

const JORDAN = { userId: 501, firstName: "Jordan", lastName: "Lee" };
const user = JORDAN.userId;

let h: ReturnType<typeof harness>;

beforeEach(async () => {
  await resetDb();
  h = harness();
  h.ct.addUser({ ...JORDAN }).addForm(FORM_ID, "Daily Safety Checklist");
});

const segment = (eventType: string, id: string, start: number, end?: number) =>
  h.webhook(timeActivity({ eventType, userId: user, id, start, ...(end !== undefined ? { end } : {}) }));
const brk = (eventType: string, id: string, start: number, end?: number) =>
  h.webhook(manualBreak({ eventType, userId: user, id, start, ...(end !== undefined ? { end } : {}) }));

/** Clock in at 9, start lunch at `from`: the segment's clock-out, then the break's clock-in. */
async function morningThenBreak(from = LUNCH) {
  await segment("clock_in", "ta-1", START);
  await segment("clock_out", "ta-1", START, from);
  await brk("clock_in", "br-1", from);
}

/** End the break at `at` and resume: the break's clock-out, then a new segment's clock-in. */
async function resume(from: number, at: number) {
  await brk("clock_out", "br-1", from, at);
  await segment("clock_in", "ta-2", at);
}

const checks = () => h.ct.callsTo("GET", `/forms/v1/forms/${FORM_ID}/form-submissions`);

describe("a lunch break", () => {
  it("doesn't end the Shift: no check during or after it, and one check, from the first clock-in, after the last clock-out", async () => {
    await morningThenBreak();
    await h.tick(LUNCH + GRACE);
    await resume(LUNCH, BACK);
    await h.tick(BACK + GRACE);
    expect(h.ct.calls).toEqual([]);

    await segment("clock_out", "ta-2", BACK, END);
    await h.tick(END + GRACE);
    expect(checks().map((c) => [c.query.submittingStartTimestamp, c.query.submittingEndTime])).toEqual([
      [String(START), String(END + GRACE)],
    ]);
    expect(h.ct.dms).toHaveLength(1);
    expect(h.ct.dms[0]?.text).toContain("Shift: Tue 6 Oct, 9:00 am – 5:02 pm");

    await h.tick(END + GRACE + HOUR);
    expect(h.ct.dms).toHaveLength(1);
  });

  it("running past the Grace Period sends no Reminder while it lasts", async () => {
    await morningThenBreak();
    for (const t of [LUNCH + GRACE, LUNCH + HOUR, LUNCH + 3 * HOUR]) await h.tick(t);
    expect(h.ct.calls).toEqual([]);
  });

  it("is one Shift whichever order the deliveries arrive in", async () => {
    await segment("clock_out", "ta-2", BACK, END);
    await brk("clock_out", "br-1", LUNCH, BACK);
    await segment("clock_out", "ta-1", START, LUNCH);
    await h.tick(END + GRACE);
    await h.tick(END + GRACE + MINUTE);
    expect(h.ct.dms).toHaveLength(1);
    expect(checks().map((c) => c.query.submittingStartTimestamp)).toEqual([String(START)]);
  });

  it("is one Shift when the resumed segment arrives before the break has ended", async () => {
    await morningThenBreak();
    await segment("clock_in", "ta-2", BACK);
    await brk("clock_out", "br-1", LUNCH, BACK);
    await segment("clock_out", "ta-2", BACK, END);
    await h.tick(BACK + GRACE);
    expect(h.ct.calls).toEqual([]);
    await h.tick(END + GRACE);
    expect(h.ct.dms).toHaveLength(1);
  });

  it("counts a submission made during the break", async () => {
    h.ct.submit({ formSubmissionId: "s-1", formId: FORM_ID, submittingUserId: user, submissionTimestamp: LUNCH + 10 * MINUTE });
    await morningThenBreak();
    await resume(LUNCH, BACK);
    await segment("clock_out", "ta-2", BACK, END);
    await h.tick(END + GRACE);
    expect(checks()).toHaveLength(1);
    expect(h.ct.dms).toEqual([]);
  });

  it("joins only at exactly both ends: a resume a minute late starts a new Shift", async () => {
    await morningThenBreak();
    await brk("clock_out", "br-1", LUNCH, BACK);
    await segment("clock_out", "ta-2", BACK + MINUTE, END);

    // The morning ends at the break's end; the afternoon is its own Shift.
    await h.tick(BACK + GRACE);
    expect(h.ct.dms).toHaveLength(1);
    await h.tick(END + GRACE);
    expect(h.ct.dms).toHaveLength(2);
  });
});

describe("a Shift that ends in a break with no resume", () => {
  it("ends at the break's end, so the break doesn't use up the Grace Period", async () => {
    const breakEnd = LUNCH + 40 * MINUTE;
    await morningThenBreak();
    await brk("clock_out", "br-1", LUNCH, breakEnd);

    await h.tick(LUNCH + GRACE);
    await h.tick(breakEnd + GRACE - MINUTE);
    expect(h.ct.calls).toEqual([]);
    await h.tick(breakEnd + GRACE);
    expect(checks().map((c) => c.query.submittingEndTime)).toEqual([String(breakEnd + GRACE)]);
    expect(h.ct.dms).toHaveLength(1);
  });

  it("works from a break clock-in that already carries its end", async () => {
    const breakEnd = LUNCH + 20 * MINUTE;
    await segment("clock_out", "ta-1", START, LUNCH);
    await brk("clock_in", "br-1", LUNCH, breakEnd);
    await brk("clock_out", "br-1", LUNCH, breakEnd);
    await h.tick(LUNCH + GRACE);
    expect(h.ct.dms).toEqual([]);
    await h.tick(breakEnd + GRACE);
    expect(h.ct.dms).toHaveLength(1);
  });

  it("left open, with no Scheduled Shift, waits: no Reminder", async () => {
    await morningThenBreak();
    await h.tick(LUNCH + 24 * HOUR);
    expect(h.ct.calls).toEqual([]);
  });

  it("whose break is deleted ends at its last clock-out again", async () => {
    await morningThenBreak();
    // Live: `admin_delete` with `activityType: "manual_break"` and the bare id.
    await h.webhook({ ...deletion({ userId: user, id: "br-1", at: LUNCH + 5 * MINUTE }), activityType: "manual_break" });
    await h.tick(LUNCH + GRACE);
    expect(checks().map((c) => c.query.submittingEndTime)).toEqual([String(LUNCH + GRACE)]);
    expect(h.ct.dms).toHaveLength(1);
  });
});

describe("what isn't a break", () => {
  it("a later manual clock-in after a clock-out starts a new Shift", async () => {
    await segment("clock_out", "ta-1", START, LUNCH);
    await segment("clock_out", "ta-2", BACK, END);
    await h.tick(LUNCH + GRACE);
    expect(h.ct.dms).toHaveLength(1);
    await h.tick(END + GRACE);
    expect(h.ct.dms).toHaveLength(2);
  });

  it("a break on its own, with no Shift before it, changes nothing", async () => {
    expect((await brk("clock_in", "br-1", LUNCH, BACK)).status).toBe(200);
    await h.tick(BACK + GRACE);
    expect(h.ct.calls).toEqual([]);
  });
});

describe("a break an Admin adds later, splitting a finished record into new ids", () => {
  // Live: an `admin_edit` ends the original at the break's start, then an
  // `admin_add` opens a new id from the break's end. Nothing is sent for the break.
  async function split() {
    await segment("admin_edit", "ta-1", START, LUNCH);
    await segment("admin_add", "ta-2", BACK, END);
  }

  it("after the Reminder maps back to the Shift already checked: no second check", async () => {
    await segment("clock_out", "ta-1", START, END);
    await h.tick(END + GRACE);
    const calls = h.ct.calls.length;

    await split();
    await h.tick(END + GRACE + HOUR);
    await h.tick(END + 2 * GRACE + HOUR);
    expect(h.ct.calls).toHaveLength(calls);
    expect(h.ct.dms).toHaveLength(1);
  });

  it("after a submission was credited maps back too", async () => {
    h.ct.submit({ formSubmissionId: "s-1", formId: FORM_ID, submittingUserId: user, submissionTimestamp: END });
    await segment("clock_out", "ta-1", START, END);
    await h.tick(END + GRACE);
    await split();
    await h.tick(END + GRACE + HOUR);
    expect(checks()).toHaveLength(1);
    expect(h.ct.dms).toEqual([]);
  });
});
