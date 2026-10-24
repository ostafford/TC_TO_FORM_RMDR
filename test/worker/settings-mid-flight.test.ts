/**
 * #30: changing a setting never surprises anyone mid-flight (#17). Shifts in
 * progress at a Compliance Form switch accept either form, and Shifts that
 * start afterwards only the new one; old-form submissions are matched by the
 * time rules only. Steps already scheduled keep their times when the Grace
 * Period or escalation delay changes. Excluded Admins, the "where to find
 * it" phrase and the publisher are read when each message is sent (Quiet
 * Hours: ./quiet-hours.test.ts).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { FORM_ID, formSubmission, harness, resetDb, timeActivity } from "./harness.js";
import type { FakeSubmission, FakeUser } from "./fake-connecteam.js";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const GRACE = 30 * MINUTE;
const DELAY = 4 * HOUR;
const NEW_FORM = 9002;

/** Unix seconds for a Sydney wall-clock time in October 2026 (AEDT, UTC+11). */
const syd = (day: number, hour: number, minute = 0) => Date.UTC(2026, 9, day, hour - 11, minute) / 1000;
const START = syd(6, 9);
const END = syd(6, 17);
const DUE = END + GRACE;

const JORDAN: FakeUser = { userId: 501, firstName: "Jordan", lastName: "Lee" };
const ADMIN: FakeUser = { userId: 20, firstName: "Ari", lastName: "Admin", userType: "manager" };
const OWNER: FakeUser = { userId: 10, firstName: "Olive", lastName: "Owner", userType: "owner" };

let h: ReturnType<typeof harness>;

function setUp(settings: Partial<Record<string, string>> = {}) {
  h = harness(settings);
  h.ct.addForm(FORM_ID, "Daily Safety Checklist").addForm(NEW_FORM, "New Checklist");
  for (const u of [JORDAN, ADMIN, OWNER]) h.ct.addUser({ ...u });
}

beforeEach(async () => {
  await resetDb();
  setUp();
});

const shift = (id: string, start: number, end?: number) =>
  timeActivity({ eventType: end === undefined ? "clock_in" : "clock_out", userId: JORDAN.userId, id, start, ...(end ? { end } : {}) });
const submission = (formId: number, at: number, over: Partial<FakeSubmission> = {}): FakeSubmission => ({
  formSubmissionId: `sub-${formId}-${at}`,
  formId,
  submittingUserId: JORDAN.userId,
  submissionTimestamp: at,
  ...over,
});
const checkedForms = () =>
  h.ct.calls.filter((c) => c.path.endsWith("/form-submissions")).map((c) => Number(c.path.split("/")[4]));
const reminders = () => h.ct.dms.filter((d) => d.userId === JORDAN.userId);
const escalatedTo = () => h.ct.dms.filter((d) => d.userId !== JORDAN.userId).map((d) => d.userId).sort();

/** The client reruns the Compliance Form step: the Worker sees the new setting from the next run on. */
async function switchForm() {
  h.configure({ COMPLIANCE_FORM_ID: String(NEW_FORM) });
}

describe("a Compliance Form switch", () => {
  beforeEach(async () => {
    // A run before the switch, so the Worker has seen the old form.
    await h.tick(START - HOUR);
  });

  it("a Shift in progress accepts the new form", async () => {
    await h.webhook(shift("ta-1", START));
    await switchForm();
    await h.tick(START + HOUR);
    await h.webhook(shift("ta-1", START, END));
    h.ct.submit(submission(NEW_FORM, END + 10 * MINUTE));
    await h.tick(DUE);
    expect(reminders()).toEqual([]);
    expect(checkedForms().sort()).toEqual([FORM_ID, NEW_FORM]);
  });

  it("a Shift in progress still accepts the old one, the form its employee was told about", async () => {
    await h.webhook(shift("ta-1", START));
    await switchForm();
    await h.tick(START + HOUR);
    await h.webhook(shift("ta-1", START, END));
    h.ct.submit(submission(FORM_ID, END + 10 * MINUTE));
    await h.tick(DUE);
    expect(reminders()).toEqual([]);
  });

  it("a Missed Form already reminded accepts either, so a late new-form submission still cancels its Escalation", async () => {
    setUp({});
    await h.tick(START - HOUR);
    await h.webhook(shift("ta-1", START, END));
    await h.tick(DUE);
    expect(reminders()).toHaveLength(1);
    await switchForm();
    await h.tick(DUE + HOUR);
    const late = submission(NEW_FORM, DUE + 2 * HOUR);
    h.ct.submit(late);
    await h.tick(DUE + DELAY);
    expect(escalatedTo()).toEqual([]);
  });

  it("is applied before a webhook credits a submission, even with no run since", async () => {
    await h.webhook(shift("ta-1", START, END));
    await switchForm();
    const s = submission(NEW_FORM, END + 5 * MINUTE);
    h.ct.submit(s);
    await h.webhook(formSubmission(s));
    await h.tick(DUE);
    expect(reminders()).toEqual([]);
    expect(checkedForms()).toEqual([]); // credited by the webhook: nothing left to check
  });

  it("a Shift that starts afterwards accepts only the new form", async () => {
    await switchForm();
    await h.tick(START - 30 * MINUTE);
    await h.webhook(shift("ta-1", START, END));
    h.ct.submit(submission(FORM_ID, END + 10 * MINUTE));
    await h.tick(DUE);
    expect(checkedForms()).toEqual([NEW_FORM]);
    expect(reminders()).toHaveLength(1);
    expect(reminders()[0]!.text).toContain("Form: New Checklist");
  });

  it("an old-form submission is matched by the time rules only, never by the Shift Date Question", async () => {
    setUp({ SHIFT_DATE_QUESTION_ID: "q-date" });
    await h.tick(syd(5, 8));
    // Mon 5 Oct: a Missed Form. Tue 6 Oct: a Shift in progress at the switch.
    await h.webhook(shift("ta-mon", syd(5, 9), syd(5, 17)));
    await h.tick(syd(5, 17, 30));
    await h.webhook(shift("ta-1", START));
    await switchForm();
    await h.tick(START + HOUR);
    await h.webhook(shift("ta-1", START, END));
    // An old-form submission during Tuesday's Grace Period whose date question names Monday.
    const old = submission(FORM_ID, END + 5 * MINUTE, {
      answers: [{ questionId: "q-date", questionType: "datetime", timestamp: syd(5, 0), timezone: "Australia/Sydney", isDateSubmitted: true, isTimeSubmitted: false }],
    });
    h.ct.submit(old);
    await h.webhook(formSubmission(old));
    await h.tick(DUE);
    // Credited to Tuesday (the time rules), so no Reminder for it; Monday stays missed.
    expect(reminders()).toHaveLength(1);
    await h.tick(syd(5, 17, 30) + DELAY);
    expect(escalatedTo()).toEqual([OWNER.userId, ADMIN.userId].sort());
  });
});

describe("timings changed mid-flight", () => {
  it("a shorter or longer Grace Period leaves a Grace Period already running as it was", async () => {
    await h.webhook(shift("ta-1", START, END));
    h.configure({ GRACE_PERIOD_MINUTES: "10" });
    await h.tick(END + 10 * MINUTE);
    expect(reminders()).toEqual([]);
    h.configure({ GRACE_PERIOD_MINUTES: "60" });
    await h.tick(DUE);
    expect(reminders()).toHaveLength(1);
  });

  it("an edit to the Shift keeps its Grace Period's length too", async () => {
    await h.webhook(shift("ta-1", START, END));
    h.configure({ GRACE_PERIOD_MINUTES: "60" });
    await h.webhook(timeActivity({ eventType: "admin_edit", userId: JORDAN.userId, id: "ta-1", start: START, end: END + 5 * MINUTE }));
    await h.tick(DUE + 5 * MINUTE);
    expect(reminders()).toHaveLength(1);
  });

  it("a Shift ending after the change takes the new Grace Period", async () => {
    h.configure({ GRACE_PERIOD_MINUTES: "10" });
    await h.webhook(shift("ta-1", START, END));
    await h.tick(END + 10 * MINUTE);
    expect(reminders()).toHaveLength(1);
  });

  it("a changed escalation delay leaves an Escalation already scheduled where it was, and the Reminder's own wording stands", async () => {
    await h.webhook(shift("ta-1", START, END));
    await h.tick(DUE);
    expect(reminders()[0]!.text).toContain("still missing in 4 hours.");
    h.configure({ ESCALATION_DELAY_MINUTES: "60" });
    await h.tick(DUE + HOUR);
    expect(escalatedTo()).toEqual([]);
    h.configure({ ESCALATION_DELAY_MINUTES: "600" });
    await h.tick(DUE + DELAY);
    expect(escalatedTo()).toEqual([OWNER.userId, ADMIN.userId].sort());
  });
});

describe("read when each message is sent", () => {
  it("Excluded Admins: a change after the Reminder decides who gets the Escalation", async () => {
    await h.webhook(shift("ta-1", START, END));
    await h.tick(DUE);
    h.configure({ EXCLUDED_ADMIN_IDS: String(ADMIN.userId) });
    await h.tick(DUE + DELAY);
    expect(escalatedTo()).toEqual([OWNER.userId]);
  });

  it("the 'where to find it' phrase: a change after the clock-out is in the Reminder", async () => {
    await h.webhook(shift("ta-1", START, END));
    h.configure({ WHERE_TO_FIND: "the Safety tab" });
    await h.tick(DUE);
    expect(reminders()[0]!.text).toContain("Where: the Safety tab\n");
  });

  it("the publisher: a change after the clock-out sends as the new one", async () => {
    await h.webhook(shift("ta-1", START, END));
    h.configure({ CT_PUBLISHER_ID: "4243" });
    await h.tick(DUE);
    expect(reminders()[0]!.senderId).toBe(4243);
  });
});
