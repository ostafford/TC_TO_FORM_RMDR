/**
 * #34: the rest of the Failure Alerts. A rejected API key pauses all work; a
 * setting pointing at something gone (the Compliance Form, the publisher,
 * the task board) holds the steps that need it; both alert at once, and when
 * work resumes, any send more than an hour overdue is skipped and listed in
 * the all clear. Clock-outs not arriving and the daily allowance more than
 * 80% used alert too. Each alerts once and gets an all clear on recovery.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ALERTS_CHANNEL, FORM_ID, harness, resetDb, timeActivity } from "./harness.js";
import type { FakeUser } from "./fake-connecteam.js";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const GRACE = 30 * MINUTE;
const DELAY = 4 * HOUR;

// Tue 6 Oct 2026, 9:00 am to 5:02 pm in Sydney (AEDT, UTC+11).
const START = Date.UTC(2026, 9, 5, 22, 0) / 1000;
const END = Date.UTC(2026, 9, 6, 6, 2) / 1000;
const DUE = END + GRACE;

const JORDAN: FakeUser = { userId: 501, firstName: "Jordan", lastName: "Lee" };
const AVERY: FakeUser = { userId: 502, firstName: "Avery", lastName: "Ng" };
const ADMIN: FakeUser = { userId: 20, firstName: "Ari", lastName: "Admin", userType: "manager" };

const DMS = "/chat/v1/conversations/privateMessage/";
const TASKS = "/tasks/v1/taskboards/";
const FORM = `/forms/v1/forms/${FORM_ID}`;

let h: ReturnType<typeof harness>;

function setUp(settings: Partial<Record<string, string>> = {}) {
  h = harness(settings);
  h.ct.addForm(FORM_ID, "Daily Safety Checklist");
  for (const u of [JORDAN, AVERY, ADMIN]) h.ct.addUser({ ...u });
}

beforeEach(async () => {
  await resetDb();
  setUp();
});

async function clockOut(user: FakeUser = JORDAN, afterEnd = 0) {
  await h.webhook(
    timeActivity({ eventType: "clock_out", userId: user.userId, id: `ta-${user.userId}`, start: START, end: END + afterEnd }),
  );
}

const posts = () => h.ct.posts.map((p) => p.text);
const callsDuring = async (at: number) => {
  const before = h.ct.calls.length + h.ct.sweepCalls.length;
  await h.tick(at);
  return h.ct.calls.length + h.ct.sweepCalls.length - before;
};

describe("a rejected API key", () => {
  it("pauses all work at once and posts the Paused alert", async () => {
    await clockOut();
    // A key missing a permission: rejected on the submission check, while the Alerts Channel still works.
    h.ct.failAll("GET", `${FORM}/form-submissions`, 403);
    await h.tick(DUE);
    expect(h.ct.dms).toEqual([]);

    await h.tick(DUE + MINUTE);
    expect(h.ct.posts).toEqual([
      expect.objectContaining({
        conversationId: ALERTS_CHANNEL,
        text:
          "ALERT · PAUSED\n\n" +
          "Cause: Connecteam rejected the API key\n" +
          "Effect: no reminders or escalations\n\n" +
          'Action: create a new API key (Settings → API keys), then rerun setup step "API key".',
      }),
    ]);
    // Paused: the Shift isn't worked, and the sweep doesn't run.
    expect(h.ct.callsTo("GET", `${FORM}/form-submissions`)).toHaveLength(1);
    expect(h.ct.sweepCalls).toHaveLength(0);
    for (let m = 2; m < 10; m++) await h.tick(DUE + m * MINUTE);
    expect(h.ct.callsTo("GET", `${FORM}/form-submissions`)).toHaveLength(1);
    expect(posts()).toHaveLength(1);
  });

  it("resumes once the key is replaced; a send under an hour late still goes out, and the all clear has nothing to list", async () => {
    await clockOut();
    h.ct.failAll("GET", `${FORM}/form-submissions`, 403);
    await h.tick(DUE);
    await h.tick(DUE + MINUTE);

    h.ct.recover();
    h.configure({ CT_API_KEY: "a-new-key" });
    await h.tick(DUE + 40 * MINUTE);
    expect(h.ct.dms.map((d) => d.userId)).toEqual([JORDAN.userId]);
    expect(posts()[1]).toBe("ALL CLEAR\n\nConnecteam accepts the API key again.\n\nAction: none.");
  });

  it("revoked outright, makes one call a minute while paused; on recovery, sends more than an hour overdue are skipped and listed", async () => {
    await clockOut();
    h.ct.rejectKey();
    await h.tick(DUE);
    // Only the alert's post, which can't get through either; the key is re-checked every 15 minutes.
    expect(await callsDuring(DUE + MINUTE)).toBe(1);
    expect(await callsDuring(DUE + 2 * MINUTE)).toBe(1);
    expect(await callsDuring(DUE + 15 * MINUTE)).toBe(2);
    expect(h.ct.posts).toEqual([]);

    h.ct.recover();
    await h.tick(DUE + 3 * HOUR);
    expect(h.ct.dms).toEqual([]); // the Reminder is three hours late: skipped
    expect(posts()).toEqual([
      "ALL CLEAR\n\n" +
        "Connecteam accepts the API key again.\n" +
        "Skipped (over an hour late):\n" +
        "- Reminder: Jordan Lee, Tue 6 Oct\n\n" +
        "Action: follow these up by hand if needed.",
    ]);
  });

  it("revoked briefly, posts nothing at all: its alert never got through, and nothing was skipped", async () => {
    await clockOut();
    h.ct.rejectKey();
    for (let m = 0; m <= 15; m++) await h.tick(DUE + m * MINUTE);
    h.ct.recover();
    for (let m = 30; m <= 32; m++) await h.tick(DUE + m * MINUTE);
    expect(h.ct.dms.map((d) => d.userId)).toEqual([JORDAN.userId]);
    expect(h.ct.posts).toEqual([]);
  });

  it("skips a late Reminder but keeps the Shift going: its Escalation still goes out when due", async () => {
    await clockOut();
    h.ct.rejectKey();
    await h.tick(DUE);
    h.ct.recover();
    await h.tick(DUE + 2 * HOUR);
    await h.tick(DUE + DELAY);
    expect(h.ct.dms.map((d) => d.userId)).toEqual([ADMIN.userId]);
    expect(h.ct.dms[0]!.text).toContain("Reminded: not confirmed (sending failed)");
  });

  it("skips the Escalation too when it was also more than an hour overdue", async () => {
    await clockOut();
    h.ct.rejectKey();
    await h.tick(DUE);
    h.ct.recover();
    await h.tick(DUE + DELAY + 2 * HOUR);
    await h.tick(DUE + DELAY + 2 * HOUR + MINUTE);
    expect(h.ct.dms).toEqual([]);
    expect(posts()[0]).toContain("Skipped (over an hour late):\n- Reminder: Jordan Lee, Tue 6 Oct\n- Escalation: Jordan Lee, Tue 6 Oct\n");
  });
});

describe("a setting pointing at something gone", () => {
  it("the Compliance Form: alerts at once, holds the Shift steps without calling, and lifts when the setting changes", async () => {
    await clockOut();
    h.ct.forms.delete(FORM_ID);
    await h.tick(DUE);
    await h.tick(DUE + MINUTE);
    expect(posts()).toEqual([
      "ALERT · FORM NOT FOUND\n\n" +
        "Setting: Compliance Form (id 9001)\n" +
        "Cause: deleted or no longer available\n\n" +
        'Action: rerun setup step "Compliance Form".',
    ]);
    for (let m = 2; m < 15; m++) await h.tick(DUE + m * MINUTE);
    expect(h.ct.callsTo("GET", FORM)).toHaveLength(1);
    await h.tick(DUE + 15 * MINUTE); // re-checked: still gone
    expect(h.ct.callsTo("GET", FORM)).toHaveLength(2);

    h.ct.addForm(9002, "New Checklist");
    h.configure({ COMPLIANCE_FORM_ID: "9002" });
    await h.tick(DUE + 20 * MINUTE);
    expect(h.ct.dms.map((d) => d.userId)).toEqual([JORDAN.userId]);
    expect(h.ct.dms[0]!.text).toContain("Form: New Checklist");
    expect(posts()[1]).toBe("ALL CLEAR\n\nThe Compliance Form setting works again.\n\nAction: none.");
  });

  it("the Compliance Form: lifts at a re-check if it's back", async () => {
    await clockOut();
    h.ct.forms.delete(FORM_ID);
    await h.tick(DUE);
    h.ct.addForm(FORM_ID, "Daily Safety Checklist");
    await h.tick(DUE + 14 * MINUTE);
    expect(h.ct.dms).toEqual([]);
    await h.tick(DUE + 15 * MINUTE);
    expect(h.ct.dms.map((d) => d.userId)).toEqual([JORDAN.userId]);
  });

  it("the publisher: DMs wait; its alert can't be posted as it either; a new publisher lifts it and late sends are skipped", async () => {
    await clockOut();
    h.ct.deletePublisher(4242);
    await h.tick(DUE);
    await h.tick(DUE + MINUTE);
    // The Alerts Channel is posted to as the same publisher.
    const alertPosts = () => h.ct.calls.filter((c) => c.path === `/chat/v1/conversations/${ALERTS_CHANNEL}/message`);
    expect(alertPosts()).toHaveLength(1);
    expect(h.ct.posts).toEqual([]);
    const dmCalls = () => h.ct.calls.filter((c) => c.path.startsWith(DMS));
    for (let m = 2; m < 30; m++) await h.tick(DUE + m * MINUTE);
    expect(dmCalls()).toHaveLength(1);

    h.configure({ CT_PUBLISHER_ID: "4243" });
    await h.tick(DUE + 90 * MINUTE);
    expect(dmCalls()).toHaveLength(1);
    expect(posts()).toEqual([
      "ALL CLEAR\n\n" +
        "The sender setting works again.\n" +
        "Skipped (over an hour late):\n" +
        "- Reminder: Jordan Lee, Tue 6 Oct\n\n" +
        "Action: follow these up by hand if needed.",
    ]);
  });

  it("the publisher: found gone on an alert's post holds DMs too", async () => {
    await clockOut();
    h.ct.failAll("POST", DMS, 503);
    for (const m of [0, 1, 3, 7, 15, 31, 63]) await h.tick(DUE + m * MINUTE);
    h.ct.recover().deletePublisher(4242);
    await h.tick(DUE + 64 * MINUTE); // the Messages alert's post finds it gone
    await clockOut(AVERY, 70 * MINUTE);
    await h.tick(DUE + 70 * MINUTE);
    expect(h.ct.calls.filter((c) => c.path === `${DMS}${AVERY.userId}`)).toEqual([]);
  });

  it("uses up none of a step's tries while it waits: after the block lifts, a failing send still gets all 7", async () => {
    await clockOut();
    h.ct.deletePublisher(4242);
    await h.tick(DUE);
    h.ct.failAll("POST", DMS, 503);
    h.configure({ CT_PUBLISHER_ID: "4243" });
    const lifted = DUE + 5 * MINUTE;
    const before = h.ct.calls.filter((c) => c.path.startsWith(DMS)).length;
    for (let m = 0; m <= 64; m++) await h.tick(lifted + m * MINUTE);
    expect(h.ct.calls.filter((c) => c.path.startsWith(DMS)).length - before).toBe(7);
  });

  it("not the publisher: a DM 404 to a user who's gone is an ordinary failure, tried again", async () => {
    await clockOut();
    h.ct.users.delete(JORDAN.userId);
    h.ct.failNext("POST", DMS, 404);
    await h.tick(DUE);
    await h.tick(DUE + MINUTE);
    expect(h.ct.dms.map((d) => d.userId)).toEqual([JORDAN.userId]);
    expect(h.ct.posts).toEqual([]);
  });

  it("the task board: Reminders carry on; creates wait, then go to the new board", async () => {
    setUp({ REMINDER_TASK_ENABLED: "true", TASK_BOARD_ID: "board-7" });
    await clockOut();
    h.ct.deleteBoard("board-7");
    await h.tick(DUE);
    await h.tick(DUE + MINUTE);
    expect(posts()).toEqual([
      "ALERT · TASK BOARD NOT FOUND\n\n" +
        "Setting: Reminder Task board (id board-7)\n" +
        "Cause: deleted or no longer available\n\n" +
        'Action: rerun setup step "Reminder Task".',
    ]);

    await clockOut(AVERY, 10 * MINUTE);
    await h.tick(DUE + 10 * MINUTE);
    expect(h.ct.dms.map((d) => d.userId)).toEqual([JORDAN.userId, AVERY.userId]);
    const creates = () => h.ct.calls.filter((c) => c.method === "POST" && c.path.startsWith(TASKS));
    expect(creates()).toHaveLength(1);

    h.configure({ TASK_BOARD_ID: "board-8" });
    await h.tick(DUE + 40 * MINUTE);
    expect([...h.ct.tasks.values()].map((t) => [t.boardId, t.userIds])).toEqual([
      ["board-8", [JORDAN.userId]],
      ["board-8", [AVERY.userId]],
    ]);
    expect(posts()[1]).toBe("ALL CLEAR\n\nThe Reminder Task board setting works again.\n\nAction: none.");
  });
});

describe("clock-outs not arriving", () => {
  const CLOCK = 67;
  const record = (userId: number, id: string, start: number, end: number) => ({
    timeClockId: CLOCK,
    userId,
    kind: "shift" as const,
    id,
    start,
    end,
    modifiedAt: end,
  });

  it("alerts when the sweep finds 3 Shifts the webhook missed within 24 hours", async () => {
    h.ct.addTimeClock(CLOCK);
    for (const [i, u] of [JORDAN, AVERY, ADMIN].entries()) h.ct.addRecord(record(u.userId, `ta-${i}`, START, END));
    await h.tick(END + 10 * MINUTE);
    await h.tick(END + 11 * MINUTE);
    expect(posts()).toContainEqual(
      "ALERT · CLOCK-OUTS NOT ARRIVING\n\n" +
        "Missed: 3 in the last 24 hours\n" +
        "Effect: reminders still sent, up to a few minutes late\n\n" +
        'Action: rerun setup step "Webhook".',
    );
  });

  it("alerts when no webhook arrives for 24 hours while Shifts happen, and clears when one does", async () => {
    await clockOut();
    await h.tick(DUE); // the Reminder
    const next = END + 25 * HOUR;
    h.ct.addTimeClock(CLOCK).addRecord(record(AVERY.userId, "ta-later", next - 9 * HOUR, next - 10 * MINUTE));
    await h.tick(next);
    await h.tick(next + MINUTE);
    expect(posts()).toContain(
      "ALERT · CLOCK-OUTS NOT ARRIVING\n\n" +
        "Since: 25 hours\n" +
        "Effect: reminders still sent, up to a few minutes late\n\n" +
        'Action: rerun setup step "Webhook".',
    );

    await h.webhook(timeActivity({ eventType: "clock_in", userId: JORDAN.userId, id: "ta-new", start: next + 2 * MINUTE }));
    await h.tick(next + 3 * MINUTE);
    expect(posts()).toContain("ALL CLEAR\n\nClock-outs are arriving again.\n\nAction: none.");
  });

  it("stays quiet for 2 missed, or a quiet day with no Shifts", async () => {
    h.ct.addTimeClock(CLOCK);
    for (const [i, u] of [JORDAN, AVERY].entries()) h.ct.addRecord(record(u.userId, `ta-${i}`, START, END));
    await h.tick(END + 10 * MINUTE);
    await h.tick(END + 11 * MINUTE);
    await h.tick(END + 26 * HOUR);
    await h.tick(END + 26 * HOUR + MINUTE);
    expect(posts().filter((t) => t.includes("CLOCK-OUTS"))).toEqual([]);
  });
});

describe("the daily allowance", () => {
  it("more than 80% used alerts once; back under clears", async () => {
    h.ct.dayLimit = 10_000;
    h.ct.dayRemaining = 1_999;
    await clockOut();
    await h.tick(DUE);
    await h.tick(DUE + MINUTE);
    await h.tick(DUE + 2 * MINUTE);
    expect(posts().filter((t) => t.startsWith("ALERT · API ALLOWANCE"))).toEqual([
      "ALERT · API ALLOWANCE 80% USED\n\n" +
        "Shared with: every integration on this account\n" +
        "If exhausted: reminders stop until tomorrow\n\n" +
        "Action: none yet.",
    ]);

    // A new day: the next call says so (the sweep lists the time clocks hourly).
    h.ct.dayRemaining = 9_000;
    await h.tick(DUE + 61 * MINUTE);
    await h.tick(DUE + 62 * MINUTE);
    expect(posts()).toContain("ALL CLEAR\n\nThe API allowance is under 80% used again.\n\nAction: none.");
  });

  it("with 20% or more left says nothing", async () => {
    h.ct.dayLimit = 10_000;
    h.ct.dayRemaining = 2_000;
    await clockOut();
    await h.tick(DUE);
    await h.tick(DUE + MINUTE);
    expect(h.ct.posts).toEqual([]);
  });
});
