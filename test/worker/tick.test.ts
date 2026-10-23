/**
 * #28: an employee who ticks the Reminder Task without submitting is told
 * once, by DM, that ticking doesn't count, and the task is reopened. A second
 * tick leaves it closed; the Escalation notes the tick. Deliveries follow what
 * Connecteam sent live on 2026-10-24: a tick in the app sends `task_completed`,
 * and a completion made through the API (our own close) sends nothing.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { FORM_ID, formSubmission, harness, resetDb, taskCompleted, timeActivity } from "./harness.js";
import type { FakeSubmission, FakeTask, FakeUser } from "./fake-connecteam.js";

// Tue 6 Oct 2026, 9:00 am to 5:02 pm in Sydney (AEDT, UTC+11).
const START = Date.UTC(2026, 9, 5, 22, 0) / 1000;
const END = Date.UTC(2026, 9, 6, 6, 2) / 1000;
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const GRACE = 30 * MINUTE;
const REMINDED = END + GRACE;
const ESCALATE = REMINDED + 4 * HOUR;
const TICKED = REMINDED + HOUR;

const BOARD = "board-7";
const ON = { REMINDER_TASK_ENABLED: "true", TASK_BOARD_ID: BOARD };

const JORDAN: FakeUser = { userId: 501, firstName: "Jordan", lastName: "Lee" };
const ADMIN: FakeUser = { userId: 20, firstName: "Ari", lastName: "Admin", userType: "manager" };

const TICK_DM =
  "Hi Jordan 👋\n\n" +
  "Thanks for ticking the task, but we haven't received your form yet.\n\n" +
  "Shift: Tue 6 Oct, 9:00 am – 5:02 pm\n" +
  "Form: Daily Safety Checklist\n" +
  "Where: the Forms tab in the Connecteam app\n\n" +
  "Ticking the task doesn't submit the form. The task has been reopened and ticks itself off once your form arrives.";
const NOTE = "\nNote: ticked the reminder task without submitting";

let h: ReturnType<typeof harness>;

function setUp(settings: Partial<Record<string, string>> = ON) {
  h = harness(settings);
  h.ct.addForm(FORM_ID, "Daily Safety Checklist").addUser({ ...JORDAN }).addUser({ ...ADMIN });
}

beforeEach(async () => {
  await resetDb();
  setUp();
});

/** Clock out, and let the Reminder and its task go out at the end of the Grace Period. */
async function reminded() {
  await h.webhook(timeActivity({ eventType: "clock_out", userId: JORDAN.userId, id: "ta-1", start: START, end: END }));
  await h.tick(REMINDED);
}

const theTask = (): FakeTask => [...h.ct.tasks.values()][0]!;
const toJordan = () => h.ct.dms.filter((d) => d.userId === JORDAN.userId).map((d) => d.text);
const escalations = () => h.ct.dms.filter((d) => d.userId !== JORDAN.userId).map((d) => d.text);
const puts = (status: string) =>
  h.ct.calls.filter((c) => c.method === "PUT" && (c.body as { status?: string }).status === status);

/** The employee marks the task done in the app: Connecteam closes it, then tells us. */
async function tick(at: number) {
  const task = theTask();
  task.status = "completed";
  return h.webhook(taskCompleted(task, at));
}

function submission(at: number): FakeSubmission {
  return { formSubmissionId: "s-1", formId: FORM_ID, submittingUserId: JORDAN.userId, submissionTimestamp: at };
}

describe("a first tick without a submission", () => {
  it("reopens the task as it was created and sends the tick DM at the next run; the webhook itself calls nothing", async () => {
    await reminded();
    const created = { ...theTask() };
    const calls = h.ct.calls.length;
    expect((await tick(TICKED)).status).toBe(200);
    expect(h.ct.calls).toHaveLength(calls);

    await h.tick(TICKED + MINUTE);
    expect(theTask().status).toBe("published");
    expect(puts("published").map((c) => [c.path, c.body])).toEqual([
      [
        `/tasks/v1/taskboards/${BOARD}/tasks/${created.id}`,
        { userIds: created.userIds, status: "published", title: created.title, description: created.description },
      ],
    ]);
    expect(toJordan()).toHaveLength(2);
    expect(toJordan()[1]).toBe(TICK_DM);

    await h.tick(TICKED + 2 * MINUTE);
    await h.tick(TICKED + HOUR);
    expect(toJordan()).toHaveLength(2);
    expect(puts("published")).toHaveLength(1);
  });

  it("puts the note on the Escalation", async () => {
    await reminded();
    await tick(TICKED);
    await h.tick(TICKED + MINUTE);
    await h.tick(ESCALATE);
    expect(escalations()).toHaveLength(1);
    expect(escalations()[0]).toMatch(new RegExp(`Reminded: 4 hours ago${NOTE}$`));
  });

  it("then goes back to its lifecycle: the hourly re-check after the Escalation closes it once a submission turns up", async () => {
    await reminded();
    await tick(TICKED);
    await h.tick(TICKED + MINUTE);
    await h.tick(ESCALATE);
    h.ct.submit(submission(ESCALATE + 10 * MINUTE));
    await h.tick(ESCALATE + 30 * MINUTE);
    expect(theTask().status).toBe("published");
    await h.tick(ESCALATE + HOUR);
    expect(theTask().status).toBe("completed");
  });

  it("is retried next minute when the DM fails, and the DM still goes out once", async () => {
    await reminded();
    await tick(TICKED);
    h.ct.failNext("POST", "/chat/v1/conversations/privateMessage/", 503);
    await h.tick(TICKED + MINUTE);
    expect(toJordan()).toHaveLength(1);

    await h.tick(TICKED + 2 * MINUTE);
    await h.tick(TICKED + 3 * MINUTE);
    expect(toJordan()).toEqual([expect.any(String), TICK_DM]);
    expect(theTask().status).toBe("published");
  });

  it("sends nothing more when the same delivery arrives again", async () => {
    await reminded();
    const first = taskCompleted({ ...theTask(), status: "completed" }, TICKED);
    theTask().status = "completed";
    await h.webhook(first);
    await h.webhook(first);
    await h.tick(TICKED + MINUTE);
    await h.webhook(first);
    await h.tick(TICKED + 2 * MINUTE);
    expect(toJordan()).toHaveLength(2);
    expect(puts("published")).toHaveLength(1);
    expect(theTask().status).toBe("published");
  });

  it("after the Escalation still reopens it and sends the tick DM", async () => {
    await reminded();
    await h.tick(ESCALATE);
    await tick(ESCALATE + 10 * MINUTE);
    await h.tick(ESCALATE + 11 * MINUTE);
    expect(theTask().status).toBe("published");
    expect(toJordan()).toEqual([expect.any(String), TICK_DM]);
  });

  it("is still handled after the Reminder Task was turned off", async () => {
    await reminded();
    const created = theTask();
    setUp({ REMINDER_TASK_ENABLED: "false" });
    h.ct.tasks.set(created.id, created); // the same Connecteam account, seen by the new settings
    await tick(TICKED);
    await h.tick(TICKED + MINUTE);
    expect(theTask().status).toBe("published");
    expect(toJordan()).toEqual([TICK_DM]);
  });
});

describe("a second tick", () => {
  it("leaves the task closed and sends no second DM; the Escalation notes it", async () => {
    await reminded();
    await tick(TICKED);
    await h.tick(TICKED + MINUTE);
    await tick(TICKED + 30 * MINUTE);
    await h.tick(TICKED + 31 * MINUTE);
    await h.tick(ESCALATE);

    expect(theTask().status).toBe("completed");
    expect(puts("published")).toHaveLength(1);
    expect(toJordan()).toHaveLength(2);
    expect(escalations()[0]).toMatch(new RegExp(`${NOTE}$`));
  });
});

describe("a tick that isn't without a submission", () => {
  it("credited before the next run: no reopen and no DM; the task is closed as completed", async () => {
    await reminded();
    await tick(TICKED);
    await h.webhook(formSubmission(submission(TICKED + 10)));
    await h.tick(TICKED + MINUTE);
    expect(puts("published")).toEqual([]);
    expect(puts("completed")).toHaveLength(1);
    expect(toJordan()).toHaveLength(1);
  });

  it("with a submission the check finds: no reopen and no DM; the task closes and nothing escalates", async () => {
    await reminded();
    h.ct.submit(submission(TICKED - 10 * MINUTE));
    await tick(TICKED);
    await h.tick(TICKED + MINUTE);
    await h.tick(ESCALATE);
    expect(puts("published")).toEqual([]);
    expect(theTask().status).toBe("completed");
    expect(toJordan()).toHaveLength(1);
    expect(escalations()).toEqual([]);
  });

  it("after our own close changes nothing", async () => {
    await reminded();
    await h.webhook(formSubmission(submission(TICKED)));
    await h.tick(TICKED + MINUTE);
    const calls = h.ct.calls.length;
    await tick(TICKED + 5 * MINUTE);
    await h.tick(TICKED + 6 * MINUTE);
    expect(h.ct.calls).toHaveLength(calls);
    expect(toJordan()).toHaveLength(1);
  });
});

describe("other Quick Tasks", () => {
  it("a tick on any other task changes nothing, and the Escalation has no note", async () => {
    await reminded();
    const other: FakeTask = { id: "other-1", boardId: BOARD, userIds: [JORDAN.userId], status: "completed", title: "Restock" };
    expect((await h.webhook(taskCompleted(other, TICKED))).status).toBe(200);
    await h.tick(TICKED + MINUTE);
    await h.tick(ESCALATE);
    expect(puts("published")).toEqual([]);
    expect(toJordan()).toHaveLength(1);
    expect(escalations()[0]).not.toContain("Note:");
  });

  it("a published event is recorded and ignored", async () => {
    await reminded();
    const calls = h.ct.calls.length;
    const published = { ...taskCompleted(theTask(), TICKED), eventType: "task_published" };
    expect((await h.webhook(published)).status).toBe(200);
    await h.tick(TICKED + MINUTE);
    expect(h.ct.calls).toHaveLength(calls);
  });

  it("a task delivery without its task list is refused", async () => {
    const res = await h.webhook({ requestId: "r-1", activityType: "Task", eventType: "task_completed", eventTimestamp: TICKED, data: {} });
    expect(res.status).toBe(400);
  });
});
