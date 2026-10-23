/**
 * #27: an optional Reminder Task (on by default) keeps the Reminder visible in
 * the employee's task list and ticks itself off when the form arrives.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { FORM_ID, deletion, formSubmission, harness, resetDb, timeActivity } from "./harness.js";
import type { FakeSubmission, FakeUser } from "./fake-connecteam.js";

// Tue 6 Oct 2026, 9:00 am to 5:02 pm in Sydney (AEDT, UTC+11).
const START = Date.UTC(2026, 9, 5, 22, 0) / 1000;
const END = Date.UTC(2026, 9, 6, 6, 2) / 1000;
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const GRACE = 30 * MINUTE;
const DELAY = 4 * HOUR;
const REMINDED = END + GRACE;
const ESCALATE = REMINDED + DELAY;

const BOARD = "board-7";
const ON = { REMINDER_TASK_ENABLED: "true", TASK_BOARD_ID: BOARD };

const JORDAN: FakeUser = { userId: 501, firstName: "Jordan", lastName: "Lee" };
const ADMIN: FakeUser = { userId: 20, firstName: "Ari", lastName: "Admin", userType: "manager" };

const TITLE = "Daily Safety Checklist – Tue 6 Oct";
const DESCRIPTION =
  "Shift: Tue 6 Oct, 9:00 am – 5:02 pm\n" +
  "Where: the Forms tab in the Connecteam app\n\n" +
  "Closes automatically when the form is received. Ticking it does not count as submitting.";

let h: ReturnType<typeof harness>;

/** A Deployment, with the Reminder Task on unless the settings say otherwise. Keeps D1 as it is. */
function setUp(settings: Partial<Record<string, string>> = ON) {
  h = harness(settings);
  h.ct.addForm(FORM_ID, "Daily Safety Checklist").addUser({ ...JORDAN }).addUser({ ...ADMIN });
}

beforeEach(async () => {
  await resetDb();
  setUp();
});

const clockOut = () => h.webhook(timeActivity({ eventType: "clock_out", userId: JORDAN.userId, id: "ta-1", start: START, end: END }));

/** Clock out, and let the Reminder (and its task) go out at the end of the Grace Period. */
async function reminded() {
  await clockOut();
  await h.tick(REMINDED);
}

const taskCalls = (method?: string) =>
  h.ct.calls.filter((c) => c.path.startsWith("/tasks/") && (method === undefined || c.method === method));
const theTask = () => [...h.ct.tasks.values()];
const escalations = () => h.ct.dms.filter((d) => d.userId !== JORDAN.userId);
const checks = () => h.ct.callsTo("GET", `/forms/v1/forms/${FORM_ID}/form-submissions`);

function submission(at: number): FakeSubmission {
  return { formSubmissionId: "s-1", formId: FORM_ID, submittingUserId: JORDAN.userId, submissionTimestamp: at };
}

describe("creating the Reminder Task", () => {
  it("goes alongside the Reminder: one published task for the employee on the chosen board", async () => {
    await reminded();

    expect(h.ct.dms.map((d) => d.userId)).toEqual([JORDAN.userId]);
    expect(taskCalls()).toEqual([
      {
        method: "POST",
        path: `/tasks/v1/taskboards/${BOARD}/tasks`,
        query: {},
        body: { userIds: [JORDAN.userId], status: "published", title: TITLE, description: { content: DESCRIPTION } },
      },
    ]);
  });

  it("isn't created when a submission arrived in the Grace Period", async () => {
    await clockOut();
    h.ct.submit(submission(END + 10 * MINUTE));
    await h.tick(REMINDED);
    expect(taskCalls()).toEqual([]);
  });

  it("waits for the Reminder: no task while the Reminder DM keeps failing", async () => {
    h.ct.failNext("POST", "/chat/v1/conversations/privateMessage/", 503);
    await reminded();
    expect(taskCalls()).toEqual([]);

    await h.tick(REMINDED + MINUTE);
    expect(h.ct.dms).toHaveLength(1);
    expect(taskCalls("POST")).toHaveLength(1);
  });

  it("is created once: later runs never create a second", async () => {
    await reminded();
    await h.tick(REMINDED + MINUTE);
    await h.tick(REMINDED + HOUR);
    await h.tick(ESCALATE);
    await h.tick(ESCALATE + 2 * HOUR);
    expect(taskCalls("POST")).toHaveLength(1);
    expect(theTask()).toHaveLength(1);
  });

  it("tries again next minute after a failed create, without sending the Reminder again", async () => {
    h.ct.failNext("POST", "/tasks/", 503);
    await reminded();
    expect(theTask()).toEqual([]);

    await h.tick(REMINDED + MINUTE);
    expect(theTask()).toHaveLength(1);
    expect(h.ct.dms).toHaveLength(1);
  });

  it("isn't created after all once a submission is credited first", async () => {
    h.ct.failNext("POST", "/tasks/", 503);
    await reminded();
    await h.webhook(formSubmission(submission(REMINDED + 30)));
    await h.tick(REMINDED + MINUTE);
    expect(taskCalls("POST")).toHaveLength(1); // only the failed one
    expect(theTask()).toEqual([]);
  });
});

describe("closing it once a submission is credited", () => {
  it("closes it as completed, a full replace from the stored fields, when the form_submission webhook arrives", async () => {
    await reminded();
    const [created] = theTask();
    await h.webhook(formSubmission(submission(REMINDED + HOUR)));
    expect(taskCalls("PUT")).toEqual([]); // the webhook makes no Connecteam calls

    await h.tick(REMINDED + HOUR + MINUTE);
    expect(taskCalls("PUT")).toEqual([
      {
        method: "PUT",
        path: `/tasks/v1/taskboards/${BOARD}/tasks/${created!.id}`,
        query: {},
        body: { userIds: [JORDAN.userId], status: "completed", title: TITLE, description: { content: DESCRIPTION } },
      },
    ]);
    expect(theTask()[0]?.status).toBe("completed");

    await h.tick(ESCALATE);
    expect(escalations()).toEqual([]);
    expect(taskCalls("PUT")).toHaveLength(1);
  });

  it("closes it in the same run when the escalation point's check finds the submission", async () => {
    await reminded();
    h.ct.submit(submission(REMINDED + HOUR));
    await h.tick(ESCALATE);
    expect(escalations()).toEqual([]);
    expect(theTask()[0]?.status).toBe("completed");
  });

  it("tries again next minute when the close fails", async () => {
    await reminded();
    await h.webhook(formSubmission(submission(REMINDED + HOUR)));
    h.ct.failNext("PUT", "/tasks/", 503);
    await h.tick(REMINDED + HOUR + MINUTE);
    expect(theTask()[0]?.status).toBe("published");
    await h.tick(REMINDED + HOUR + 2 * MINUTE);
    expect(theTask()[0]?.status).toBe("completed");
  });

  it("stops when the task was deleted in Connecteam: nothing left to close", async () => {
    await reminded();
    h.ct.tasks.clear();
    await h.webhook(formSubmission(submission(REMINDED + HOUR)));
    await h.tick(REMINDED + HOUR + MINUTE);
    await h.tick(REMINDED + HOUR + 2 * MINUTE);
    expect(taskCalls("PUT")).toHaveLength(1);
  });
});

describe("after the Escalation", () => {
  it("re-checks the open task hourly, one form-submissions call each, and closes it once a submission turns up", async () => {
    await reminded();
    await h.tick(ESCALATE);
    expect(escalations()).toHaveLength(1);
    const before = checks().length;

    await h.tick(ESCALATE + HOUR - MINUTE);
    expect(checks()).toHaveLength(before);
    await h.tick(ESCALATE + HOUR);
    expect(checks()).toHaveLength(before + 1);
    expect(checks().at(-1)?.query).toEqual(
      expect.objectContaining({ submittingStartTimestamp: String(START), submittingEndTime: String(ESCALATE + HOUR) }),
    );

    h.ct.submit(submission(ESCALATE + 90 * MINUTE));
    await h.tick(ESCALATE + 2 * HOUR);
    expect(checks()).toHaveLength(before + 2);
    expect(theTask()[0]?.status).toBe("completed");

    await h.tick(ESCALATE + 3 * HOUR);
    expect(checks()).toHaveLength(before + 2);
  });

  it("closes it as soon as the form_submission webhook arrives, without waiting for the hour", async () => {
    await reminded();
    await h.tick(ESCALATE);
    await h.webhook(formSubmission(submission(ESCALATE + 10 * MINUTE)));
    await h.tick(ESCALATE + 11 * MINUTE);
    expect(theTask()[0]?.status).toBe("completed");
  });
});

describe("removing it", () => {
  it("deletes a task still open 7 days after the Shift; the Escalation stays", async () => {
    await reminded();
    await h.tick(ESCALATE);
    const [created] = theTask();

    await h.tick(END + 7 * DAY - MINUTE);
    expect(taskCalls("DELETE")).toEqual([]);
    await h.tick(END + 7 * DAY);
    expect(taskCalls("DELETE").map((c) => c.path)).toEqual([`/tasks/v1/taskboards/${BOARD}/tasks/${created!.id}`]);
    expect(theTask()).toEqual([]);
    expect(escalations()).toHaveLength(1);

    const calls = h.ct.calls.length;
    await h.tick(END + 8 * DAY);
    expect(h.ct.calls).toHaveLength(calls);
  });

  it("deletes a deleted Shift's open task at once", async () => {
    await reminded();
    await h.webhook(deletion({ userId: JORDAN.userId, id: "ta-1", at: REMINDED + HOUR }));
    await h.tick(REMINDED + HOUR + MINUTE);
    expect(taskCalls("DELETE")).toHaveLength(1);
    expect(theTask()).toEqual([]);

    await h.tick(ESCALATE);
    expect(escalations()).toEqual([]);
  });

  it("counts a task already gone as deleted", async () => {
    await reminded();
    h.ct.tasks.clear();
    await h.webhook(deletion({ userId: JORDAN.userId, id: "ta-1", at: REMINDED + HOUR }));
    await h.tick(REMINDED + HOUR + MINUTE);
    await h.tick(REMINDED + HOUR + 2 * MINUTE);
    expect(taskCalls("DELETE")).toHaveLength(1);
  });
});

describe("with the Reminder Task off", () => {
  it("creates no task", async () => {
    setUp({ REMINDER_TASK_ENABLED: "false" });
    await reminded();
    await h.tick(ESCALATE);
    expect(h.ct.dms.length).toBeGreaterThan(1);
    expect(taskCalls()).toEqual([]);
  });

  it.each([
    ["turned off", { REMINDER_TASK_ENABLED: "false" }],
    ["moved to another board", { REMINDER_TASK_ENABLED: "true", TASK_BOARD_ID: "board-9" }],
  ])("lets tasks that already exist finish their lifecycle when it's %s", async (_, settings) => {
    await reminded();
    const [created] = theTask();
    setUp(settings);
    h.ct.tasks.set(created!.id, created!); // the same Connecteam account, seen by the new settings

    await h.webhook(formSubmission(submission(REMINDED + HOUR)));
    await h.tick(REMINDED + HOUR + MINUTE);
    expect(taskCalls().map((c) => `${c.method} ${c.path}`)).toEqual([`PUT /tasks/v1/taskboards/${BOARD}/tasks/${created!.id}`]);
    expect(theTask()[0]?.status).toBe("completed");
  });
});
