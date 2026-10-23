/**
 * #33: when sends keep failing, the client hears about it in their Alerts
 * Channel, once, with an all clear on recovery. A failing step is tried again
 * after 1, 2, 4, 8, 16 and 32 minutes while the Shift's other steps carry on;
 * after about an hour a send is given up on and a "Messages not sending"
 * Failure Alert lists who wasn't reached. A send claim stuck for more than 10
 * minutes is given up on the same way instead of being retried. Each
 * condition alerts at most once per 24 hours, and never by DM.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ALERTS_CHANNEL, FORM_ID, PUBLISHER_ID, harness, resetDb, timeActivity } from "./harness.js";
import type { FakeUser } from "./fake-connecteam.js";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const GRACE = 30 * MINUTE;
const DELAY = 4 * HOUR;

// Tue 6 Oct 2026, 9:00 am to 5:02 pm in Sydney (AEDT, UTC+11).
const START = Date.UTC(2026, 9, 5, 22, 0) / 1000;
const END = Date.UTC(2026, 9, 6, 6, 2) / 1000;
const DUE = END + GRACE;

/** When a step failing from `at` is tried: at once, then after 1, 2, 4, 8, 16 and 32 minutes. */
const TRIES = [0, 1, 3, 7, 15, 31, 63];

const JORDAN: FakeUser = { userId: 501, firstName: "Jordan", lastName: "Lee" };
const STAFF: FakeUser[] = [
  JORDAN,
  { userId: 502, firstName: "Avery", lastName: "Ng" },
  { userId: 503, firstName: "Casey", lastName: "Ory" },
  { userId: 504, firstName: "Drew", lastName: "Park" },
  { userId: 505, firstName: "Eli", lastName: "Quinn" },
];
const OWNER: FakeUser = { userId: 10, firstName: "Olive", lastName: "Owner", userType: "owner" };
const ADMIN: FakeUser = { userId: 20, firstName: "Ari", lastName: "Admin", userType: "manager" };

const DMS = "/chat/v1/conversations/privateMessage/";
const TASKS = "/tasks/v1/taskboards/";

const SENDING_ACTION = "Action: none yet. An all-clear follows when it recovers.";

let h: ReturnType<typeof harness>;

function setUp(settings: Partial<Record<string, string>> = {}, admins: FakeUser[] = []) {
  h = harness(settings);
  h.ct.addForm(FORM_ID, "Daily Safety Checklist");
  for (const u of [...STAFF, ...admins]) h.ct.addUser({ ...u });
}

beforeEach(async () => {
  await resetDb();
  setUp();
});

/** The user clocks out `afterEnd` seconds after END, so their Grace Period ends then after DUE. */
async function clockOut(userId = JORDAN.userId, afterEnd = 0) {
  await h.webhook(timeActivity({ eventType: "clock_out", userId, id: `ta-${userId}`, start: START, end: END + afterEnd }));
}

/** Run the cron at each try of a step failing from `at`. */
async function tickThroughTries(at: number) {
  for (const m of TRIES) await h.tick(at + m * MINUTE);
}

const dmCalls = (userId?: number) =>
  h.ct.calls.filter((c) => c.method === "POST" && c.path.startsWith(DMS) && (userId === undefined || c.path === `${DMS}${userId}`));
const posts = () => h.ct.posts.map((p) => p.text);

describe("a failing send", () => {
  it("is tried again after 1, 2, 4, 8, 16 and 32 minutes, and not in between", async () => {
    await clockOut();
    h.ct.failAll("POST", DMS, 503);
    const triedAt: number[] = [];
    for (let m = 0; m <= 70; m++) {
      const before = dmCalls().length;
      await h.tick(DUE + m * MINUTE);
      if (dmCalls().length > before) triedAt.push(m);
    }
    expect(triedAt).toEqual(TRIES);
  });

  it("after about an hour, is given up on, and the Alerts Channel hears who wasn't reached", async () => {
    await clockOut();
    h.ct.failAll("POST", DMS, 503);
    await tickThroughTries(DUE);
    expect(h.ct.posts).toEqual([]);

    await h.tick(DUE + 64 * MINUTE);
    expect(h.ct.posts).toEqual([
      {
        conversationId: ALERTS_CHANNEL,
        senderId: PUBLISHER_ID,
        text:
          "ALERT · MESSAGES NOT SENDING\n\n" +
          "Since: 1 hour 4 minutes ago\n" +
          "Cause: Connecteam not responding\n" +
          "Undelivered: 1 reminder (Jordan Lee)\n\n" +
          SENDING_ACTION,
      },
    ]);
    // Never as a DM: the Alerts Channel only.
    expect(h.ct.dms).toEqual([]);
  });

  it("counts a 429 and a dropped connection as failures too, naming the cause", async () => {
    await clockOut();
    h.ct.failNext("POST", DMS, null).failAll("POST", DMS, 429);
    await tickThroughTries(DUE);
    await h.tick(DUE + 64 * MINUTE);
    expect(posts()).toHaveLength(1);
    expect(posts()[0]).toContain("Cause: Connecteam's rate limit\n");
  });

  it("succeeding on a later try sends it once, and alerts nobody", async () => {
    await clockOut();
    h.ct.failNext("POST", DMS, null).failNext("POST", DMS, 500);
    await tickThroughTries(DUE);
    await h.tick(DUE + 64 * MINUTE);
    expect(h.ct.dms.map((d) => d.userId)).toEqual([JORDAN.userId]);
    expect(dmCalls()).toHaveLength(3);
    expect(h.ct.posts).toEqual([]);
  });

  it("given up on, still lets the Shift carry on: the Escalation goes out as scheduled and says the Reminder wasn't confirmed", async () => {
    setUp({}, [OWNER, ADMIN]);
    await clockOut();
    h.ct.failAll("POST", DMS, 503);
    await tickThroughTries(DUE);
    h.ct.recover();
    await h.tick(DUE + 64 * MINUTE); // the alert
    expect(h.ct.dms).toEqual([]);

    await h.tick(DUE + DELAY - MINUTE);
    expect(h.ct.dms).toEqual([]);
    await h.tick(DUE + DELAY);
    expect(h.ct.dms.map((d) => d.userId).sort()).toEqual([OWNER.userId, ADMIN.userId]);
    expect(h.ct.dms[0]!.text).toBe(
      "MISSING COMPLIANCE FORM\n\n" +
        "Employee: Jordan Lee\n" +
        "Shift: Tue 6 Oct, 9:00 am – 5:02 pm\n" +
        "Form: Daily Safety Checklist\n" +
        "Reminded: not confirmed (sending failed)",
    );
  });

  it("in a Reminder Task create, never holds up the Escalation, and is listed once given up on", async () => {
    setUp({ REMINDER_TASK_ENABLED: "true", TASK_BOARD_ID: "board-7" }, [ADMIN]);
    await clockOut();
    h.ct.failAll("POST", TASKS, 500);
    await tickThroughTries(DUE);
    expect(h.ct.dms.map((d) => d.userId)).toEqual([JORDAN.userId]); // the Reminder went out
    expect(h.ct.calls.filter((c) => c.method === "POST" && c.path.startsWith(TASKS))).toHaveLength(TRIES.length);

    await h.tick(DUE + 64 * MINUTE);
    expect(posts()).toEqual([
      "ALERT · MESSAGES NOT SENDING\n\n" +
        "Since: 1 hour 4 minutes ago\n" +
        "Cause: Connecteam not responding\n" +
        "Undelivered: 1 reminder task (User 501)\n\n" +
        SENDING_ACTION,
    ]);

    await h.tick(DUE + DELAY);
    expect(h.ct.dms.map((d) => d.userId)).toEqual([JORDAN.userId, ADMIN.userId]);
    // Given up on: never tried again.
    expect(h.ct.calls.filter((c) => c.method === "POST" && c.path.startsWith(TASKS))).toHaveLength(TRIES.length);
  });

  it("to one Escalation recipient retries only that recipient, then lists the Escalation by the employee it's about", async () => {
    setUp({}, [OWNER, ADMIN]);
    await clockOut();
    await h.tick(DUE);
    h.ct.failAll("POST", `${DMS}${ADMIN.userId}`, 503);
    await tickThroughTries(DUE + DELAY);
    expect(dmCalls(OWNER.userId)).toHaveLength(1);
    expect(dmCalls(ADMIN.userId)).toHaveLength(TRIES.length);

    await h.tick(DUE + DELAY + 64 * MINUTE);
    expect(posts()).toHaveLength(1);
    expect(posts()[0]).toContain("Undelivered: 1 escalation (Jordan Lee)\n");
  });
});

describe("the all clear", () => {
  it("follows the next send that goes out, listing what wasn't delivered to follow up by hand", async () => {
    await clockOut();
    h.ct.failAll("POST", DMS, 503);
    await tickThroughTries(DUE);
    await h.tick(DUE + 64 * MINUTE);
    h.ct.recover();

    await clockOut(502, 70 * MINUTE);
    await h.tick(DUE + 70 * MINUTE); // Avery's Reminder goes out
    expect(posts()).toHaveLength(1);
    await h.tick(DUE + 71 * MINUTE);
    expect(posts()[1]).toBe(
      "ALL CLEAR\n\n" +
        "Messages are sending again.\n" +
        "Not delivered:\n" +
        "- Reminder: Jordan Lee, Tue 6 Oct\n\n" +
        "Action: follow these up by hand if needed.",
    );
    await h.tick(DUE + 72 * MINUTE);
    expect(posts()).toHaveLength(2);
  });

  it("comes once per condition: a second send given up on while alerted adds no alert, and the all clear lists both", async () => {
    await clockOut();
    await clockOut(502, 10 * MINUTE);
    h.ct.failAll("POST", DMS, 503);
    for (let m = 0; m <= 75; m++) await h.tick(DUE + m * MINUTE);
    expect(posts()).toHaveLength(1);
    expect(posts()[0]).toContain("Undelivered: 1 reminder (Jordan Lee)\n");

    h.ct.recover();
    await clockOut(503, 80 * MINUTE);
    await h.tick(DUE + 80 * MINUTE);
    await h.tick(DUE + 81 * MINUTE);
    expect(posts()).toHaveLength(2);
    expect(posts()[1]).toContain("- Reminder: Jordan Lee, Tue 6 Oct\n- Reminder: Avery Ng, Tue 6 Oct\n");
  });

  it("is posted again next run if its post fails, and an alert likewise", async () => {
    await clockOut();
    h.ct.failAll("POST", DMS, 503);
    await tickThroughTries(DUE);
    h.ct.failNext("POST", `/chat/v1/conversations/${ALERTS_CHANNEL}/message`, 503);
    await h.tick(DUE + 64 * MINUTE);
    expect(h.ct.posts).toEqual([]);
    await h.tick(DUE + 65 * MINUTE);
    expect(posts()).toHaveLength(1);
    await h.tick(DUE + 66 * MINUTE);
    expect(posts()).toHaveLength(1);
  });
});

describe("the 24-hour hold", () => {
  it("holds back a second alert for the same condition within 24 hours; its sends still reach the next all clear", async () => {
    // First outage: Jordan's Reminder. Alert, then all clear when Avery's goes out.
    await clockOut(501);
    h.ct.failAll("POST", DMS, 503);
    await tickThroughTries(DUE);
    await h.tick(DUE + 64 * MINUTE);
    h.ct.recover();
    await clockOut(502, 70 * MINUTE);
    await h.tick(DUE + 70 * MINUTE);
    await h.tick(DUE + 71 * MINUTE);
    expect(posts().map((t) => t.split("\n")[0])).toEqual(["ALERT · MESSAGES NOT SENDING", "ALL CLEAR"]);

    // Second outage within 24 hours: Casey's Reminder. No alert.
    await clockOut(503, 120 * MINUTE);
    h.ct.failAll("POST", DMS, 503);
    await tickThroughTries(DUE + 120 * MINUTE);
    await h.tick(DUE + 184 * MINUTE);
    expect(posts()).toHaveLength(2);

    // It recovers: the all clear lists Casey, and not Jordan again.
    h.ct.recover();
    await clockOut(504, 200 * MINUTE);
    await h.tick(DUE + 200 * MINUTE);
    await h.tick(DUE + 201 * MINUTE);
    expect(posts()).toHaveLength(3);
    expect(posts()[2]).toContain("Not delivered:\n- Reminder: Casey Ory, Tue 6 Oct\n\n");

    // More than 24 hours after the first alert: a new outage alerts again.
    const later = 64 * MINUTE + DAY;
    await clockOut(505, later);
    h.ct.failAll("POST", DMS, 503);
    await tickThroughTries(DUE + later);
    await h.tick(DUE + later + 64 * MINUTE);
    expect(posts()).toHaveLength(4);
    expect(posts()[3]).toContain("Undelivered: 1 reminder (Eli Quinn)\n");
  });
});

describe("a stuck send claim", () => {
  it("held more than 10 minutes by a run that died mid-send is never retried, and raises an alert", async () => {
    setUp({}, [ADMIN]);
    await clockOut();
    const stall = h.ct.stallNext("POST", DMS);
    const dying = h.tick(DUE);
    await stall.reached;

    for (let m = 5; m <= 9; m++) await h.tick(DUE + m * MINUTE);
    expect(dmCalls()).toHaveLength(1);
    await h.tick(DUE + 10 * MINUTE); // stuck: given up on
    expect(h.ct.posts).toEqual([]);
    await h.tick(DUE + 11 * MINUTE);
    expect(posts()).toEqual([
      "ALERT · MESSAGES NOT SENDING\n\n" +
        "Since: 1 minute ago\n" +
        "Cause: the integration stopped mid-send\n" +
        "Unconfirmed: 1 reminder (Jordan Lee)\n\n" +
        SENDING_ACTION,
    ]);
    expect(dmCalls()).toHaveLength(1);

    stall.release(503);
    await dying;
    // The Shift carries on to its Escalation as scheduled.
    await h.tick(DUE + DELAY);
    expect(dmCalls(ADMIN.userId)).toHaveLength(1);
    expect(dmCalls(JORDAN.userId)).toHaveLength(1);
  });

  it("from a Reminder Task create that got no answer is kept, so the task is never created twice", async () => {
    setUp({ REMINDER_TASK_ENABLED: "true", TASK_BOARD_ID: "board-7" });
    await clockOut();
    h.ct.failNext("POST", TASKS, null);
    const creates = () => h.ct.calls.filter((c) => c.method === "POST" && c.path.startsWith(TASKS));

    for (let m = 0; m <= 9; m++) await h.tick(DUE + m * MINUTE);
    expect(creates()).toHaveLength(1);
    await h.tick(DUE + 10 * MINUTE);
    await h.tick(DUE + 11 * MINUTE);
    expect(posts()).toHaveLength(1);
    expect(posts()[0]).toContain("Unconfirmed: 1 reminder task (User 501)\n");
    await h.tick(DUE + 2 * HOUR);
    expect(creates()).toHaveLength(1);
  });
});

describe("Failure Alerts and overlapping runs", () => {
  it("are posted once however many runs overlap", async () => {
    await clockOut();
    h.ct.failAll("POST", DMS, 503);
    await tickThroughTries(DUE);
    await Promise.all([h.tick(DUE + 64 * MINUTE), h.tick(DUE + 64 * MINUTE), h.tick(DUE + 64 * MINUTE)]);
    expect(posts()).toHaveLength(1);
  });
});

describe("the sweep's reads failing", () => {
  it("for about an hour raises an alert, and a read that works brings the all clear", async () => {
    h.ct.addTimeClock(67);
    h.ct.failAll("GET", "/time-clock/", 503);
    const t0 = DUE;
    await h.tick(t0);
    await h.tick(t0 + 59 * MINUTE);
    expect(h.ct.posts).toEqual([]);
    await h.tick(t0 + HOUR);
    expect(posts()).toEqual([
      "ALERT · CLOCK-OUT CHECK FAILING\n\n" +
        "Since: 1 hour ago\n" +
        "Cause: Connecteam not responding\n" +
        "Effect: a clock-out Connecteam doesn't notify us of waits until this recovers\n\n" +
        SENDING_ACTION,
    ]);
    await h.tick(t0 + HOUR + MINUTE);
    expect(posts()).toHaveLength(1);

    h.ct.recover();
    await h.tick(t0 + HOUR + 2 * MINUTE);
    await h.tick(t0 + HOUR + 3 * MINUTE);
    expect(posts()[1]).toBe("ALL CLEAR\n\nThe clock-out check is working again.\n\nAction: none.");
  });

  it("for less than an hour, or only some clocks failing, raises nothing", async () => {
    h.ct.addTimeClock(67).addTimeClock(68);
    h.ct.failAll("GET", "/time-clock/v1/time-clocks/67/", 503);
    for (let m = 0; m <= 65; m += 5) await h.tick(DUE + m * MINUTE);
    expect(h.ct.posts).toEqual([]);
  });
});
