/**
 * #22: every way a Shift ends gets checked, not just a normal clock-out, and
 * corrections never cause repeat messages. User stories 29, 32, 33 and 34 on #19.
 */
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { FORM_ID, deletion, harness, resetDb, timeActivity } from "./harness.js";

// Tue 6 Oct 2026, 9:00 am to 5:02 pm in Sydney (AEDT, UTC+11).
const START = Date.UTC(2026, 9, 5, 22, 0) / 1000;
const END = Date.UTC(2026, 9, 6, 6, 2) / 1000;
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const GRACE = 30 * MINUTE;

const JORDAN = { userId: 501, firstName: "Jordan", lastName: "Lee" };

let h: ReturnType<typeof harness>;

beforeEach(async () => {
  await resetDb();
  h = harness();
  h.ct.addUser(JORDAN).addForm(FORM_ID, "Daily Safety Checklist");
});

const event = (eventType: string, over: Partial<Parameters<typeof timeActivity>[0]> = {}) =>
  timeActivity({ eventType, userId: JORDAN.userId, id: "ta-1", start: START, end: END, ...over });

const clockIn = () => timeActivity({ eventType: "clock_in", userId: JORDAN.userId, id: "ta-1", start: START });

const checks = () => h.ct.callsTo("GET", `/forms/v1/forms/${FORM_ID}/form-submissions`);

describe("every way a Shift ends leads to the same check as a clock-out", () => {
  it.each([
    "clock_out",
    "auto_clock_out",
    "admin_add",
    "admin_edit",
    "admin_approved_add_request",
    "admin_approved_edit_request",
    "auto_approved_add_request",
    "auto_approved_edit_request",
    "admin_approved_clock_out_outside_geo_fence_request",
    "auto_approved_clock_out_outside_geo_fence_request",
    "admin_approved_clock_out_without_nfc_request",
    "auto_approved_clock_out_without_nfc_request",
  ])("%s", async (eventType) => {
    expect((await h.webhook(event(eventType))).status).toBe(200);
    await h.tick(END + GRACE - MINUTE);
    expect(h.ct.calls).toEqual([]);

    await h.tick(END + GRACE);
    expect(checks().map((c) => c.query.submittingEndTime)).toEqual([String(END + GRACE)]);
    expect(h.ct.dms).toHaveLength(1);
  });

  it("Connecteam's own auto clock-out at the Scheduled Shift's end", async () => {
    await h.webhook(event("auto_clock_out", { isAutoClockOut: true }));
    await h.tick(END + GRACE);
    expect(h.ct.dms).toHaveLength(1);
  });

  it("a clock-in alone is not an end", async () => {
    await h.webhook(clockIn());
    await h.tick(START + 24 * HOUR);
    expect(h.ct.calls).toEqual([]);
  });
});

describe("requests are only asks, and are ignored", () => {
  it.each([
    "user_add_request",
    "user_edit_request",
    "user_delete_request",
    "admin_declined_add_request",
    "admin_declined_edit_request",
  ])("%s", async (eventType) => {
    expect((await h.webhook(event(eventType))).status).toBe(200);
    await h.tick(END + GRACE);
    expect(h.ct.calls).toEqual([]);
  });

  it("a user_delete_request doesn't cancel the Shift", async () => {
    await h.webhook(event("clock_out"));
    await h.webhook(deletion({ eventType: "user_delete_request", userId: JORDAN.userId, id: "ta-1", at: END + MINUTE }));
    await h.tick(END + GRACE);
    expect(h.ct.dms).toHaveLength(1);
  });
});

describe("a Shift first known more than 24 hours after its recorded end", () => {
  it("is never checked: no Reminder, then or later", async () => {
    await h.webhook(event("admin_add"), { at: END + 24 * HOUR + 1 });
    await h.tick(END + 24 * HOUR + MINUTE);
    await h.tick(END + 48 * HOUR);
    expect(h.ct.calls).toEqual([]);
  });

  it("is stored as too late, with nothing due, so no cron run picks it up", async () => {
    // Later steps (crediting a submission, the sweep) read this status too.
    await h.webhook(event("admin_add"), { at: END + 24 * HOUR + 1 });
    const row = await env.DB.prepare("SELECT status, due_at FROM shifts WHERE id = 'ta-1'").first();
    expect(row).toEqual({ status: "too_late", due_at: null });
  });

  it("is checked when known exactly 24 hours after", async () => {
    await h.webhook(event("admin_add"), { at: END + 24 * HOUR });
    await h.tick(END + 24 * HOUR + MINUTE);
    expect(h.ct.dms).toHaveLength(1);
  });

  it("counts from when the Shift was first known, so one seen at its clock-in is checked however late it ends", async () => {
    await h.webhook(clockIn());
    // An Admin adds the forgotten clock-out two days later.
    await h.webhook(event("admin_edit"), { at: END + 48 * HOUR });
    await h.tick(END + 48 * HOUR + MINUTE);
    expect(h.ct.dms).toHaveLength(1);
  });

  it("isn't brought back by a later edit", async () => {
    await h.webhook(event("admin_add"), { at: END + 30 * HOUR });
    await h.webhook(event("admin_edit", { end: END + HOUR }), { at: END + 31 * HOUR });
    await h.tick(END + 32 * HOUR);
    expect(h.ct.calls).toEqual([]);
  });
});

describe("an edit to a Shift", () => {
  it("already reminded, with new times, doesn't start a second check", async () => {
    await h.webhook(event("clock_out"));
    await h.tick(END + GRACE);
    const calls = h.ct.calls.length;

    await h.webhook(event("admin_edit", { start: START - HOUR, end: END + HOUR }), { at: END + 2 * HOUR });
    await h.tick(END + 2 * HOUR + MINUTE);
    await h.tick(END + HOUR + GRACE + MINUTE);
    expect(h.ct.calls).toHaveLength(calls);
    expect(h.ct.dms).toHaveLength(1);
  });

  it("already credited with a submission doesn't start a second check", async () => {
    h.ct.submit({ formSubmissionId: "s-1", formId: FORM_ID, submittingUserId: JORDAN.userId, submissionTimestamp: END });
    await h.webhook(event("clock_out"));
    await h.tick(END + GRACE);

    await h.webhook(event("admin_edit", { end: END + HOUR }), { at: END + 2 * HOUR });
    await h.tick(END + HOUR + GRACE + MINUTE);
    expect(checks()).toHaveLength(1);
    expect(h.ct.dms).toEqual([]);
  });

  it("before its check moves the Grace Period to the corrected end", async () => {
    await h.webhook(event("clock_out"));
    await h.webhook(event("admin_edit", { end: END + HOUR }), { at: END + 10 * MINUTE });

    await h.tick(END + GRACE);
    expect(h.ct.calls).toEqual([]);

    await h.tick(END + HOUR + GRACE);
    expect(checks().map((c) => c.query.submittingEndTime)).toEqual([String(END + HOUR + GRACE)]);
    expect(h.ct.dms[0]?.text).toContain("Shift: Tue 6 Oct, 9:00 am – 6:02 pm\n");
  });

  it("to the start before its check moves the submission window's start", async () => {
    await h.webhook(event("clock_out"));
    await h.webhook(event("admin_edit", { start: START - HOUR }), { at: END + 10 * MINUTE });
    await h.tick(END + GRACE);
    expect(checks().map((c) => c.query.submittingStartTimestamp)).toEqual([String(START - HOUR)]);
  });
});

describe("a geofence approval that deletes and recreates the record with a new id", () => {
  const approval = (over: Partial<Parameters<typeof timeActivity>[0]> = {}) =>
    event("admin_approved_clock_out_outside_geo_fence_request", { id: "ta-2", ...over });
  const deleteOriginal = (at: number) => deletion({ userId: JORDAN.userId, id: "ta-1", at });

  it("after the Reminder doesn't start a second check", async () => {
    await h.webhook(event("clock_out"));
    await h.tick(END + GRACE);
    const calls = h.ct.calls.length;

    await h.webhook(deleteOriginal(END + 2 * HOUR));
    await h.webhook(approval(), { at: END + 2 * HOUR });
    await h.tick(END + 2 * HOUR + GRACE);
    expect(h.ct.calls).toHaveLength(calls);
  });

  it("of a Shift still open gets one check, whichever arrives first", async () => {
    for (const order of ["approval first", "delete first"] as const) {
      await resetDb();
      h = harness();
      h.ct.addUser(JORDAN).addForm(FORM_ID, "Daily Safety Checklist");

      await h.webhook(clockIn());
      if (order === "approval first") {
        await h.webhook(approval());
        await h.webhook(deleteOriginal(END + MINUTE));
      } else {
        await h.webhook(deleteOriginal(END));
        await h.webhook(approval());
      }
      await h.tick(END + GRACE);
      await h.tick(END + GRACE + MINUTE);
      expect(h.ct.dms, order).toHaveLength(1);
    }
  });
});

describe("a deleted Shift", () => {
  it.each(["admin_delete", "admin_approved_delete_request", "auto_approved_delete_request"])(
    "%s cancels its pending steps",
    async (eventType) => {
      await h.webhook(event("clock_out"));
      expect((await h.webhook(deletion({ eventType, userId: JORDAN.userId, id: "ta-1", at: END + MINUTE }))).status).toBe(
        200,
      );
      await h.tick(END + GRACE);
      await h.tick(END + 2 * HOUR);
      expect(h.ct.calls).toEqual([]);
    },
  );

  it("deleted while still open is never checked once its clock-out time passes", async () => {
    await h.webhook(clockIn());
    await h.webhook(deletion({ userId: JORDAN.userId, id: "ta-1", at: START + HOUR }));
    await h.tick(END + GRACE);
    expect(h.ct.calls).toEqual([]);
  });

  it("deleting a record never seen is accepted and changes nothing", async () => {
    await h.webhook(event("clock_out"));
    expect((await h.webhook(deletion({ userId: JORDAN.userId, id: "ta-unknown", at: END }))).status).toBe(200);
    await h.tick(END + GRACE);
    expect(h.ct.dms).toHaveLength(1);
  });

  it("a delete with no record id is refused", async () => {
    const { timeActivityId: _id, ...bare } = deletion({ userId: JORDAN.userId, id: "ta-1", at: END });
    expect((await h.webhook(bare)).status).toBe(400);
  });
});
