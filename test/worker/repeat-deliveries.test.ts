/**
 * #86: a repeat delivery is skipped by its key (`requestId` + `eventType` +
 * user + entity), not by `requestId` alone. The key is stored only once a
 * delivery is fully handled, so Connecteam's retry of a failed one still
 * counts. Writes that can safely run twice stay as the second line of defence.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { FORM_ID, deletion, formSubmission, harness, resetDb, taskCompleted, timeActivity } from "./harness.js";
import type { FakeSubmission, FakeTask, FakeUser } from "./fake-connecteam.js";

// Tue 6 Oct 2026, 9:00 am to 5:02 pm in Sydney (AEDT, UTC+11).
const START = Date.UTC(2026, 9, 5, 22, 0) / 1000;
const END = Date.UTC(2026, 9, 6, 6, 2) / 1000;
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const REMINDED = END + 30 * MINUTE;
const ESCALATE = REMINDED + 4 * HOUR;

const ON = { REMINDER_TASK_ENABLED: "true", TASK_BOARD_ID: "board-7" };

const JORDAN: FakeUser = { userId: 501, firstName: "Jordan", lastName: "Lee" };
const SAM: FakeUser = { userId: 502, firstName: "Sam", lastName: "Rao" };
const ADMIN: FakeUser = { userId: 20, firstName: "Ari", lastName: "Admin", userType: "manager" };
const STAFF = [JORDAN, SAM];

let h: ReturnType<typeof harness>;

function setUp(settings: Partial<Record<string, string>> = {}) {
  h = harness(settings);
  h.ct.addForm(FORM_ID, "Daily Safety Checklist").addUser({ ...JORDAN }).addUser({ ...SAM }).addUser({ ...ADMIN });
}

beforeEach(async () => {
  await resetDb();
  setUp();
});

const clockOut = (u: FakeUser, requestId?: string) =>
  timeActivity({ eventType: "clock_out", userId: u.userId, id: `ta-${u.userId}`, start: START, end: END, ...(requestId ? { requestId } : {}) });

function submission(u: FakeUser): FakeSubmission {
  const s = { formSubmissionId: `s-${u.userId}`, formId: FORM_ID, submittingUserId: u.userId, submissionTimestamp: REMINDED + HOUR };
  h.ct.submit(s);
  return s;
}

const taskOf = (u: FakeUser): FakeTask => [...h.ct.tasks.values()].find((t) => t.userIds.includes(u.userId))!;
const dmsTo = (u: FakeUser) => h.ct.dms.filter((d) => d.userId === u.userId);
const escalations = () => h.ct.dms.filter((d) => !STAFF.some((u) => u.userId === d.userId));

/** Clock everyone out with fresh `requestId`s and let their Reminders go out. */
async function reminded() {
  for (const u of STAFF) await h.webhook(clockOut(u));
  await h.tick(REMINDED);
}

describe("an identical delivery sent twice", () => {
  it("is handled once: a repeated clock-out doesn't bring back a Shift deleted since", async () => {
    const out = clockOut(JORDAN, "r-out");
    await h.webhook(out);
    await h.webhook(deletion({ userId: JORDAN.userId, id: `ta-${JORDAN.userId}`, at: END + MINUTE }));
    const repeat = await h.webhook(out, { at: END + 2 * MINUTE });

    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual({ ok: true, skipped: "repeat" });
    await h.tick(REMINDED);
    expect(dmsTo(JORDAN)).toEqual([]);
  });

  it("is skipped for form and task deliveries too", async () => {
    setUp(ON);
    await reminded();
    const form = formSubmission(submission(JORDAN));
    const task = taskOf(SAM);
    task.status = "completed";
    const tick = taskCompleted(task, REMINDED + HOUR);

    for (const delivery of [form, tick]) {
      expect(await (await h.webhook(delivery)).json()).toEqual({ ok: true });
      expect(await (await h.webhook(delivery)).json()).toEqual({ ok: true, skipped: "repeat" });
    }
  });

  it("still counts when the first try failed: Connecteam's retry of a submission is credited", async () => {
    await reminded();
    const form = formSubmission(submission(JORDAN));
    h.configure({ COMPLIANCE_FORM_ID: "" });
    expect((await h.webhook(form)).status).toBe(500);

    h.configure({ COMPLIANCE_FORM_ID: String(FORM_ID) });
    expect(await (await h.webhook(form)).json()).toEqual({ ok: true });
    h.ct.submissions.length = 0;
    await h.tick(ESCALATE);
    expect(escalations().map((d) => d.text).join("\n")).not.toContain("Jordan");
  });
});

describe("a task delivery", () => {
  it("is a repeat however its tasks are ordered", async () => {
    setUp(ON);
    await reminded();
    const tasks = STAFF.map((u) => taskCompleted(taskOf(u), REMINDED + HOUR, "r-both").data[0]!);
    const tick = taskCompleted(taskOf(JORDAN), REMINDED + HOUR, "r-both");

    expect(await (await h.webhook({ ...tick, data: tasks })).json()).toEqual({ ok: true });
    expect(await (await h.webhook({ ...tick, data: [...tasks].reverse() })).json()).toEqual({ ok: true, skipped: "repeat" });
  });
});

describe("a delivery sharing a requestId with one handled, differing in one key field only", () => {
  const out = () => clockOut(JORDAN, "r-key");
  const form = () => formSubmission(submission(JORDAN), "form_submission", "r-key");
  const tick = () => taskCompleted({ id: "task-1", boardId: "board-7", userIds: [JORDAN.userId], status: "completed", title: "t" }, REMINDED, "r-key");
  const pair = <T extends object>(d: T, change: (d: T) => object) => [d, change(d)];

  it.each([
    ["time activity: eventType", () => pair(out(), (d) => ({ ...d, eventType: "auto_clock_out" }))],
    ["time activity: user", () => pair(out(), (d) => ({ ...d, userId: SAM.userId }))],
    ["time activity: activity", () => pair(out(), (d) => ({ ...d, timeActivity: { ...d.timeActivity, id: "ta-other" } }))],
    ["form: eventType", () => pair(form(), (d) => ({ ...d, eventType: "form_submission_edited" }))],
    ["form: user", () => pair(form(), (d) => ({ ...d, data: { ...d.data, submittingUserId: SAM.userId } }))],
    ["form: submission", () => pair(form(), (d) => ({ ...d, data: { ...d.data, formSubmissionId: "s-other" } }))],
    ["task: eventType", () => pair(tick(), (d) => ({ ...d, eventType: "task_published" }))],
    ["task: tasks", () => pair(tick(), (d) => ({ ...d, data: [{ ...d.data[0]!, id: "task-other" }] }))],
  ])("is handled: %s", async (_, deliveries) => {
    for (const d of deliveries()) expect(await (await h.webhook(d)).json()).toEqual({ ok: true });
  });
});

describe("two different events sharing one requestId", () => {
  it("are both handled for time activity deliveries", async () => {
    for (const u of STAFF) await h.webhook(clockOut(u, "r-shared"));
    await h.tick(REMINDED);
    expect(dmsTo(JORDAN)).toHaveLength(1);
    expect(dmsTo(SAM)).toHaveLength(1);
  });

  it("are both handled for form deliveries", async () => {
    await reminded();
    for (const u of STAFF) await h.webhook(formSubmission(submission(u), "form_submission", "r-shared"));
    h.ct.submissions.length = 0;
    await h.tick(ESCALATE);
    expect(escalations()).toEqual([]);
  });

  it("are both handled for task deliveries", async () => {
    setUp(ON);
    await reminded();
    for (const u of STAFF) {
      const task = taskOf(u);
      task.status = "completed";
      await h.webhook(taskCompleted(task, REMINDED + HOUR, "r-shared"));
    }
    await h.tick(REMINDED + HOUR + MINUTE);
    expect(dmsTo(JORDAN)).toHaveLength(2);
    expect(dmsTo(SAM)).toHaveLength(2);
  });
});
