import { describe, it, expect, beforeEach } from "vitest";
import { FORM_ID, PUBLISHER_ID, harness, resetDb, timeActivity } from "./harness.js";

// Tue 6 Oct 2026, 9:00 am to 5:02 pm in Sydney (AEDT, UTC+11). Well in the
// past, so a Worker that timed the Grace Period from the webhook's arrival
// instead of the recorded end would never be due at these ticks.
const START = Date.UTC(2026, 9, 5, 22, 0) / 1000;
const END = Date.UTC(2026, 9, 6, 6, 2) / 1000;
const GRACE = 30 * 60;
const MINUTE = 60;

const JORDAN = { userId: 501, firstName: "Jordan", lastName: "Lee" };

let h: ReturnType<typeof harness>;

beforeEach(async () => {
  await resetDb();
  h = harness();
  h.ct.addUser(JORDAN).addForm(FORM_ID, "Daily Safety Checklist");
});

const clockOut = (over: Partial<Parameters<typeof timeActivity>[0]> = {}) =>
  timeActivity({ eventType: "clock_out", userId: JORDAN.userId, id: "ta-1", start: START, end: END, ...over });

describe("the webhook", () => {
  it("accepts a signed clock_out and makes no Connecteam calls", async () => {
    const res = await h.webhook(clockOut());
    expect(res.status).toBe(200);
    expect(h.ct.calls).toEqual([]);
  });

  it("rejects an unsigned or wrongly signed delivery, and nothing is scheduled", async () => {
    expect((await h.webhook(clockOut(), {})).status).toBe(401);
    expect((await h.webhook(clockOut(), { "x-webhook-secret": "not-the-secret" })).status).toBe(401);

    await h.tick(END + GRACE + MINUTE);
    expect(h.ct.calls).toEqual([]);
  });

  it("rejects a body that isn't JSON", async () => {
    expect((await h.webhook("{ not json")).status).toBe(400);
  });

  it("de-duplicates a repeated delivery", async () => {
    const delivery = clockOut();
    expect((await h.webhook(delivery)).status).toBe(200);
    expect((await h.webhook(delivery)).status).toBe(200);

    await h.tick(END + GRACE);
    expect(h.ct.dms).toHaveLength(1);
    expect(h.ct.callsTo("GET", `/forms/v1/forms/${FORM_ID}/form-submissions`)).toHaveLength(1);
  });
});

describe("the end of the Grace Period", () => {
  it("does nothing before the Grace Period ends", async () => {
    await h.webhook(clockOut());
    await h.tick(END + GRACE - MINUTE);
    expect(h.ct.calls).toEqual([]);
  });

  it("with no submission, checks once and sends the Reminder as the custom publisher", async () => {
    await h.webhook(clockOut());
    await h.tick(END + GRACE);

    const checks = h.ct.callsTo("GET", `/forms/v1/forms/${FORM_ID}/form-submissions`);
    expect(checks.map((c) => c.query)).toEqual([
      {
        userIds: String(JORDAN.userId),
        submittingStartTimestamp: String(START),
        submittingEndTime: String(END + GRACE),
        limit: "1",
      },
    ]);
    expect(h.ct.dms).toEqual([
      {
        userId: JORDAN.userId,
        senderId: PUBLISHER_ID,
        text:
          "Hi Jordan 👋\n\n" +
          "We haven't received your form for this shift yet.\n\n" +
          "Shift: Tue 6 Oct, 9:00 am – 5:02 pm\n" +
          "Form: Daily Safety Checklist\n" +
          "Where: the Forms tab in the Connecteam app\n\n" +
          "Please submit it now. Your manager is notified if it's still missing in 4 hours.",
      },
    ]);
  });

  it("times the Grace Period from the recorded end, however late the webhook arrives", async () => {
    // Arrives (now, in real time) days after the Shift ended.
    await h.webhook(clockOut());
    await h.tick(END + GRACE);
    expect(h.ct.dms).toHaveLength(1);
  });

  it("with a submission during the Shift or the Grace Period, sends nothing", async () => {
    h.ct.submit({ formSubmissionId: "s-1", formId: FORM_ID, submittingUserId: JORDAN.userId, submissionTimestamp: END + GRACE });
    await h.webhook(clockOut());
    await h.tick(END + GRACE);
    await h.tick(END + GRACE + MINUTE);

    expect(h.ct.dms).toEqual([]);
    expect(h.ct.callsTo("GET", `/forms/v1/forms/${FORM_ID}/form-submissions`)).toHaveLength(1);
  });

  it("doesn't count another user's submission", async () => {
    h.ct.submit({ formSubmissionId: "s-2", formId: FORM_ID, submittingUserId: 999, submissionTimestamp: END });
    await h.webhook(clockOut());
    await h.tick(END + GRACE);
    expect(h.ct.dms).toHaveLength(1);
  });

  it("works a Shift first seen at its clock-in once the clock-out arrives", async () => {
    await h.webhook(timeActivity({ eventType: "clock_in", userId: JORDAN.userId, id: "ta-1", start: START }));
    await h.tick(START + 12 * 60 * MINUTE);
    expect(h.ct.calls).toEqual([]);

    await h.webhook(clockOut());
    await h.tick(END + GRACE);
    expect(h.ct.dms).toHaveLength(1);
  });

  it("shows the Shift in the zone it was recorded in, named when it differs from the Deployment's", async () => {
    await h.webhook(clockOut({ timezone: "Australia/Perth" }));
    await h.tick(END + GRACE);
    expect(h.ct.dms[0]?.text).toContain("Shift: Tue 6 Oct, 6:00 am – 2:02 pm (AWST)\n");
  });
});

describe("sending the Reminder at most once", () => {
  it("never sends it twice across later cron runs", async () => {
    await h.webhook(clockOut());
    await h.tick(END + GRACE);
    const callsAfterFirst = h.ct.calls.length;

    await h.tick(END + GRACE + MINUTE);
    await h.tick(END + GRACE + 10 * MINUTE);
    expect(h.ct.dms).toHaveLength(1);
    expect(h.ct.calls).toHaveLength(callsAfterFirst);
  });

  it("releases the claim when the send fails, and the next run sends it", async () => {
    h.ct.failNext("POST", "/chat/v1/conversations/privateMessage/", 503);
    await h.webhook(clockOut());

    await h.tick(END + GRACE);
    expect(h.ct.dms).toEqual([]);

    await h.tick(END + GRACE + MINUTE);
    expect(h.ct.dms).toHaveLength(1);
    expect(h.ct.calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  it("treats a rejected send as not sent", async () => {
    h.ct.failNext("POST", "/chat/v1/conversations/privateMessage/", 400);
    await h.webhook(clockOut());

    await h.tick(END + GRACE);
    await h.tick(END + GRACE + MINUTE);
    expect(h.ct.dms).toHaveLength(1);
  });

  it("sends nothing while the submission check fails, then checks again", async () => {
    h.ct.failNext("GET", `/forms/v1/forms/${FORM_ID}/form-submissions`, 503);
    await h.webhook(clockOut());

    await h.tick(END + GRACE);
    expect(h.ct.dms).toEqual([]);

    await h.tick(END + GRACE + MINUTE);
    expect(h.ct.dms).toHaveLength(1);
  });
});
