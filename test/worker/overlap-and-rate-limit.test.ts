/**
 * #31 (ADR-0002): the cron is safe to overlap and polite to the account's
 * shared rate limit. Runs lease what they take, so overlapping runs never
 * work the same Shift and never send twice; a dead run's lease runs out and
 * its work is picked up; due work goes oldest first; and a run stops for the
 * minute on a 429 or once less than 20% of the per-minute limit remains,
 * leaving the rest for the next minute.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { FORM_ID, harness, resetDb, timeActivity } from "./harness.js";

const MINUTE = 60;
const GRACE = 30 * MINUTE;
const LEASE = 5 * MINUTE;

// Tue 6 Oct 2026, 9:00 am in Sydney (AEDT, UTC+11).
const START = Date.UTC(2026, 9, 5, 22, 0) / 1000;
const END = START + 8 * 60 * MINUTE;

/** Three employees whose Shifts end a minute apart, so their Grace Periods end in that order. */
const STAFF = [
  { userId: 501, firstName: "Avery", lastName: "Lee" },
  { userId: 502, firstName: "Blake", lastName: "Ng" },
  { userId: 503, firstName: "Casey", lastName: "Ory" },
];
/** When all three are due. */
const ALL_DUE = END + 2 * MINUTE + GRACE;

let h: ReturnType<typeof harness>;

beforeEach(async () => {
  await resetDb();
  h = harness();
  h.ct.addForm(FORM_ID, "Daily Safety Checklist");
  for (const u of STAFF) h.ct.addUser({ ...u });
});

async function clockOut(count = STAFF.length) {
  for (const [i, u] of STAFF.slice(0, count).entries()) {
    await h.webhook(timeActivity({ eventType: "clock_out", userId: u.userId, id: `ta-${u.userId}`, start: START, end: END + i * MINUTE }));
  }
}

const checks = () => h.ct.callsTo("GET", `/forms/v1/forms/${FORM_ID}/form-submissions`);
const remindedUsers = () => h.ct.dms.map((d) => d.userId);
const dmCalls = () => h.ct.calls.filter((c) => c.path.startsWith("/chat/v1/conversations/privateMessage/"));

describe("overlapping runs", () => {
  it("never work the same Shift: one check and one Reminder each", async () => {
    await clockOut();
    await Promise.all([h.tick(ALL_DUE), h.tick(ALL_DUE), h.tick(ALL_DUE)]);
    expect(checks()).toHaveLength(3);
    expect(remindedUsers().sort()).toEqual([501, 502, 503]);
  });

  it("a run that died mid-check leaves its Shift leased until the lease runs out; then the next run works it", async () => {
    await clockOut(1);
    const due = END + GRACE;
    const stall = h.ct.stallNext("GET", `/forms/v1/forms/${FORM_ID}/form-submissions`);
    const dying = h.tick(due);
    await stall.reached;

    await h.tick(due + MINUTE);
    await h.tick(due + LEASE - MINUTE);
    expect(checks()).toHaveLength(1); // only the stalled one
    expect(h.ct.dms).toEqual([]);

    await h.tick(due + LEASE);
    expect(checks()).toHaveLength(2);
    expect(remindedUsers()).toEqual([501]);

    stall.release(503);
    await dying;
    await h.tick(due + LEASE + MINUTE);
    expect(remindedUsers()).toEqual([501]);
  });

  it("a run that died mid-send never has its Reminder sent again", async () => {
    await clockOut(1);
    const due = END + GRACE;
    const stall = h.ct.stallNext("POST", "/chat/v1/conversations/privateMessage/");
    const dying = h.tick(due);
    await stall.reached;

    await h.tick(due + LEASE);
    await h.tick(due + LEASE + MINUTE);
    expect(dmCalls()).toHaveLength(1);

    stall.release(503);
    await dying;
  });
});

describe("the per-minute rate limit", () => {
  it("does due work oldest first, and with less than 20% left, stops after the step under way; the rest goes next minute", async () => {
    await clockOut();
    h.ct.minute = { limit: 100, remaining: 19 };

    await h.tick(ALL_DUE);
    expect(remindedUsers()).toEqual([501]);
    expect(checks().map((c) => c.query.userIds)).toEqual(["501"]);
    expect(h.ct.sweepCalls).toEqual([]);

    await h.tick(ALL_DUE + MINUTE);
    expect(remindedUsers()).toEqual([501, 502]);
    await h.tick(ALL_DUE + 2 * MINUTE);
    expect(remindedUsers()).toEqual([501, 502, 503]);
  });

  it("leaves the Reminder Task to the next minute when the Shift steps used up the headroom", async () => {
    h = harness({ REMINDER_TASK_ENABLED: "true", TASK_BOARD_ID: "board-7" });
    h.ct.addForm(FORM_ID, "Daily Safety Checklist").addUser({ ...STAFF[0]! });
    await clockOut(1);
    h.ct.minute = { limit: 100, remaining: 19 };

    await h.tick(END + GRACE);
    expect(remindedUsers()).toEqual([501]);
    expect(h.ct.tasks.size).toBe(0);
    await h.tick(END + GRACE + MINUTE);
    expect(h.ct.tasks.size).toBe(1);
  });

  it("keeps going with 20% or more left", async () => {
    await clockOut();
    h.ct.minute = { limit: 100, remaining: 20 };
    await h.tick(ALL_DUE);
    expect(remindedUsers()).toEqual([501, 502, 503]);
    expect(h.ct.sweepCalls).not.toEqual([]);
  });

  it("stops for the minute on a 429; that Shift and the rest are worked next minute", async () => {
    await clockOut();
    h.ct.failNext("GET", `/forms/v1/forms/${FORM_ID}/form-submissions`, 429);

    await h.tick(ALL_DUE);
    expect(checks().map((c) => c.query.userIds)).toEqual(["501"]);
    expect(h.ct.dms).toEqual([]);
    expect(h.ct.sweepCalls).toEqual([]);

    // The Shift that got the 429 waits out its first backoff (#33), so the others, due earlier, go first.
    await h.tick(ALL_DUE + MINUTE);
    expect(remindedUsers()).toEqual([502, 503, 501]);
  });
});
