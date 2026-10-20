/**
 * #26: a late submission cancels the Escalation as soon as it arrives, and
 * each submission is credited to the right Shift. One submission counts for
 * one Shift only, whether it arrives by webhook or turns up in a later check.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { FORM_ID, SECRET, formSubmission, harness, resetDb, timeActivity } from "./harness.js";
import type { FakeSubmission } from "./fake-connecteam.js";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const GRACE = 30 * MINUTE;
const DELAY = 4 * HOUR;

/** Sydney wall-clock time (AEDT, UTC+11, in Oct 2026) as Unix seconds. */
const syd = (day: number, hour: number, minute = 0) => Date.UTC(2026, 9, day, hour - 11, minute) / 1000;

const JORDAN = { userId: 501, firstName: "Jordan", lastName: "Lee" };
const ADMIN = { userId: 20, firstName: "Ari", lastName: "Admin", userType: "manager" };

// Mon 5 Oct and Tue 6 Oct, 9 am to 5 pm.
const MON = { id: "ta-mon", start: syd(5, 9), end: syd(5, 17) };
const TUE = { id: "ta-tue", start: syd(6, 9), end: syd(6, 17) };

let h: ReturnType<typeof harness>;

function setUp(settings: Partial<Record<string, string>> = {}) {
  h = harness(settings);
  h.ct.addForm(FORM_ID, "Daily Safety Checklist").addUser({ ...JORDAN }).addUser({ ...ADMIN });
}

beforeEach(async () => {
  await resetDb();
  setUp();
});

const clockOut = (s: { id: string; start: number; end: number }) =>
  h.webhook(timeActivity({ eventType: "clock_out", userId: JORDAN.userId, ...s }));

const remindersTo = () => h.ct.dms.filter((d) => d.userId === JORDAN.userId);
const escalations = () => h.ct.dms.filter((d) => d.userId !== JORDAN.userId);

/** A submission that both the webhook and the `form-submissions` check can see. */
function submit(over: Partial<FakeSubmission> & { submissionTimestamp: number }): FakeSubmission {
  const s: FakeSubmission = { formSubmissionId: "s-1", formId: FORM_ID, submittingUserId: JORDAN.userId, ...over };
  h.ct.submit(s);
  return s;
}

/** Clock out of a Shift and let its Reminder go out. */
async function missed(s: { id: string; start: number; end: number }) {
  await clockOut(s);
  await h.tick(s.end + GRACE);
}

describe("the form_submission webhook", () => {
  it("is verified like the time-clock webhooks", async () => {
    const delivery = formSubmission({ formSubmissionId: "s-1", formId: FORM_ID, submittingUserId: JORDAN.userId, submissionTimestamp: 1 });
    expect((await h.webhook(delivery, { headers: {} })).status).toBe(401);
    expect((await h.webhook(delivery, { headers: { "x-webhook-secret": "wrong" } })).status).toBe(401);
    expect((await h.webhook(delivery, { headers: { "x-webhook-secret": SECRET } })).status).toBe(200);
  });

  it("refuses a delivery with no submission in it", async () => {
    expect((await h.webhook({ requestId: "r", activityType: "forms", eventType: "form_submission", data: {} })).status).toBe(400);
  });

  it("cancels the pending Escalation as soon as a late submission arrives", async () => {
    await missed(MON);
    await h.webhook(formSubmission(submit({ submissionTimestamp: MON.end + 2 * HOUR })));

    const calls = h.ct.calls.length;
    await h.tick(MON.end + GRACE + DELAY);
    expect(h.ct.calls).toHaveLength(calls);
    expect(escalations()).toEqual([]);
  });

  it("during the Grace Period means no check and no Reminder", async () => {
    await clockOut(MON);
    await h.webhook(formSubmission(submit({ submissionTimestamp: MON.end + 10 * MINUTE })));
    await h.tick(MON.end + GRACE);
    expect(h.ct.calls).toEqual([]);
  });

  it("during a Shift still open credits it, so its clock-out starts no check", async () => {
    await h.webhook(timeActivity({ eventType: "clock_in", userId: JORDAN.userId, id: MON.id, start: MON.start }));
    await h.webhook(formSubmission(submit({ submissionTimestamp: MON.start + HOUR })));
    await clockOut(MON);
    await h.tick(MON.end + GRACE);
    expect(h.ct.calls).toEqual([]);
  });

  it("arriving while the Reminder is being sent still cancels the Escalation", async () => {
    await clockOut(MON);
    // Submitted at the last second of the Grace Period, just after the check looked.
    h.ct.duringDm = async () => {
      await h.webhook(formSubmission(submit({ submissionTimestamp: MON.end + GRACE })), { at: MON.end + GRACE });
    };
    await h.tick(MON.end + GRACE);
    expect(remindersTo()).toHaveLength(1);

    // The Shift stays credited: nothing is due at the escalation point.
    const calls = h.ct.calls.length;
    await h.tick(MON.end + GRACE + DELAY);
    expect(h.ct.calls).toHaveLength(calls);
  });

  it("never credits a Shift that doesn't need a form: one back-filled too late", async () => {
    await missed(MON);
    // An Admin back-fills a Tuesday Shift two days late: never checked, and needs no form.
    await h.webhook(timeActivity({ eventType: "admin_add", userId: JORDAN.userId, ...TUE }), { at: TUE.end + 2 * DAY });
    // Submitted during that Tuesday Shift: it closes Monday's Missed Form instead.
    await h.webhook(formSubmission(submit({ submissionTimestamp: TUE.start + HOUR })), { at: TUE.end + 2 * DAY });
    await h.tick(MON.end + GRACE + DELAY);
    expect(escalations()).toEqual([]);
  });

  it("is de-duplicated: a repeated delivery changes nothing", async () => {
    await missed(MON);
    const delivery = formSubmission(submit({ submissionTimestamp: MON.end + HOUR }));
    expect((await h.webhook(delivery)).status).toBe(200);
    expect((await h.webhook(delivery)).status).toBe(200);
    await h.tick(MON.end + GRACE + DELAY);
    expect(escalations()).toEqual([]);
  });

  it("ignores an edited submission: an edit keeps its submitted time", async () => {
    await missed(MON);
    const s = { formSubmissionId: "s-1", formId: FORM_ID, submittingUserId: JORDAN.userId, submissionTimestamp: MON.end + HOUR };
    expect((await h.webhook(formSubmission(s, "form_submission_edited"))).status).toBe(200);
    await h.tick(MON.end + GRACE + DELAY);
    expect(escalations()).toHaveLength(1);
  });

  it("ignores another form's submissions", async () => {
    await missed(MON);
    await h.webhook(formSubmission(submit({ formId: 7777, submissionTimestamp: MON.end + HOUR })));
    await h.tick(MON.end + GRACE + DELAY);
    expect(escalations()).toHaveLength(1);
  });
});

describe("one submission counts for one Shift only", () => {
  // Long enough that Monday's and Tuesday's Missed Forms are both outstanding at once.
  const LONG = 2 * DAY;
  beforeEach(() => setUp({ ESCALATION_DELAY_MINUTES: String(LONG / MINUTE) }));

  it("by webhook: a late submission closes the oldest Missed Form, and the other still escalates", async () => {
    await missed(MON);
    await missed(TUE);
    await h.webhook(formSubmission(submit({ submissionTimestamp: TUE.end + 2 * HOUR })));

    await h.tick(MON.end + GRACE + LONG);
    expect(escalations()).toEqual([]);
    await h.tick(TUE.end + GRACE + LONG);
    expect(escalations()).toHaveLength(1);
    expect(escalations()[0]?.text).toContain("Shift: Tue 6 Oct");
  });

  it("by check: with no webhook, each escalation point finds the same submission but only one is closed", async () => {
    await missed(MON);
    await missed(TUE);
    submit({ submissionTimestamp: TUE.end + 2 * HOUR });

    await h.tick(TUE.end + GRACE + LONG);
    expect(escalations()).toHaveLength(1);
    expect(escalations()[0]?.text).toContain("Shift: Tue 6 Oct");
  });

  it("back-to-back Shifts whose windows overlap: the earlier gets it, the later gets its Reminder", async () => {
    const early = { id: "ta-early", start: syd(6, 6), end: syd(6, 12) };
    const late = { id: "ta-late", start: syd(6, 12, 10), end: syd(6, 18) };
    await clockOut(early);
    await clockOut(late);
    submit({ submissionTimestamp: syd(6, 12, 20) });

    await h.tick(early.end + GRACE);
    await h.tick(late.end + GRACE);
    expect(remindersTo()).toHaveLength(1);
    expect(remindersTo()[0]?.text).toContain("Shift: Tue 6 Oct, 12:10 pm – 6:00 pm");
  });

  it("a submission the check already credited never closes a second Shift when its webhook arrives late", async () => {
    await missed(MON);
    // Submitted during Tuesday's Shift: Tuesday's own check credits it.
    const s = submit({ submissionTimestamp: TUE.start + HOUR });
    await clockOut(TUE);
    await h.tick(TUE.end + GRACE);
    expect(remindersTo()).toHaveLength(1);

    await h.webhook(formSubmission(s), { at: TUE.end + GRACE + MINUTE });
    await h.tick(MON.end + GRACE + LONG);
    expect(escalations()).toHaveLength(1);
    expect(escalations()[0]?.text).toContain("Shift: Mon 5 Oct");
  });

  it("a second submission closes the second Missed Form", async () => {
    await missed(MON);
    await missed(TUE);
    await h.webhook(formSubmission(submit({ submissionTimestamp: TUE.end + 2 * HOUR })));
    await h.webhook(formSubmission(submit({ formSubmissionId: "s-2", submissionTimestamp: TUE.end + 3 * HOUR })));
    await h.tick(TUE.end + GRACE + LONG);
    expect(escalations()).toEqual([]);
  });
});

describe("the Shift Date Question", () => {
  const naming = (day: number) => [
    { questionId: "q-date", questionType: "datetime", timestamp: syd(day, 0), timezone: "Australia/Sydney", isDateSubmitted: true, isTimeSubmitted: false },
  ];

  beforeEach(() => setUp({ SHIFT_DATE_QUESTION_ID: "q-date" }));

  it("credits the Shift on the date it names, even when submitted during another Shift", async () => {
    await missed(MON);
    await h.webhook(timeActivity({ eventType: "clock_in", userId: JORDAN.userId, id: TUE.id, start: TUE.start }));
    // Catching up on Monday's form during Tuesday's Shift.
    await h.webhook(formSubmission(submit({ submissionTimestamp: TUE.start + HOUR, answers: naming(5) })));

    await h.tick(MON.end + GRACE + DELAY);
    expect(escalations()).toEqual([]);

    // Tuesday still needs its own form.
    await clockOut(TUE);
    await h.tick(TUE.end + GRACE);
    expect(remindersTo().map((d) => d.text.match(/Shift: (\w+ \d+ \w+)/)?.[1])).toEqual(["Mon 5 Oct", "Tue 6 Oct"]);
  });

  it("naming a date with no Shift needing a form falls back to the Shift it was made during", async () => {
    await missed(MON);
    await clockOut(TUE);
    await h.webhook(formSubmission(submit({ submissionTimestamp: TUE.end + 10 * MINUTE, answers: naming(1) })));

    await h.tick(TUE.end + GRACE);
    expect(remindersTo()).toHaveLength(1); // Monday's only
    await h.tick(MON.end + GRACE + DELAY);
    expect(escalations()).toHaveLength(1);
  });

  it("is read from submissions the check finds, too", async () => {
    await missed(MON);
    submit({ submissionTimestamp: TUE.start + HOUR, answers: naming(5) });
    await clockOut(TUE);

    // Tuesday's check finds the submission, but it names Monday.
    await h.tick(TUE.end + GRACE);
    expect(remindersTo()).toHaveLength(2);
    await h.tick(MON.end + GRACE + DELAY);
    expect(escalations().map((d) => d.text.match(/Shift: (\w+ \d+ \w+)/)?.[1])).toEqual([]);
    await h.tick(TUE.end + GRACE + DELAY + DAY);
    expect(escalations().map((d) => d.text.match(/Shift: (\w+ \d+ \w+)/)?.[1])).toEqual(["Tue 6 Oct"]);
  });
});
