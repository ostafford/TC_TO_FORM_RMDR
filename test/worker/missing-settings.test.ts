/**
 * #88 (US 65): a Deployment with a setting missing does nothing rather than
 * the wrong thing. A webhook gets 500, so Connecteam sends it again, and a
 * cron run is skipped.
 */
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { FORM_ID, formSubmission, harness, resetDb, timeActivity } from "./harness.js";

// Tue 6 Oct 2026, 9:00 am to 5:02 pm in Sydney (AEDT, UTC+11).
const START = Date.UTC(2026, 9, 5, 22, 0) / 1000;
const END = Date.UTC(2026, 9, 6, 6, 2) / 1000;
const GRACE = 30 * 60;

const JORDAN = { userId: 501, firstName: "Jordan", lastName: "Lee" };

let h: ReturnType<typeof harness>;

beforeEach(async () => {
  await resetDb();
  h = harness();
  h.ct.addUser({ ...JORDAN }).addForm(FORM_ID, "Daily Safety Checklist");
});

const clockOut = () => timeActivity({ eventType: "clock_out", userId: JORDAN.userId, id: "ta-1", start: START, end: END, requestId: "r-1" });

describe("a webhook with a required setting missing", () => {
  it("gets 500 and records nothing, so Connecteam's re-send is handled once the setting is back", async () => {
    h.configure({ COMPLIANCE_FORM_ID: "" });
    const res = await h.webhook(clockOut());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "settings incomplete" });

    // Nothing recorded: no Shift to check, and the delivery isn't a repeat.
    h.configure({ COMPLIANCE_FORM_ID: env.COMPLIANCE_FORM_ID });
    await h.tick(END + GRACE);
    expect(h.ct.calls).toEqual([]);
    const again = await h.webhook(clockOut());
    expect(await again.json()).toEqual({ ok: true });
    await h.tick(END + GRACE + 60);
    expect(h.ct.dms.map((d) => d.userId)).toEqual([JORDAN.userId]);
  });

  it("gets 500 for a form submission too, and its re-send is credited once the setting is back", async () => {
    await h.webhook(clockOut());
    const submission = formSubmission(
      { formSubmissionId: "s-1", formId: FORM_ID, submittingUserId: JORDAN.userId, submissionTimestamp: END + 60 },
      "form_submission",
      "r-sub",
    );
    h.configure({ COMPLIANCE_FORM_ID: "" });
    const res = await h.webhook(submission);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "settings incomplete" });

    h.configure({ COMPLIANCE_FORM_ID: env.COMPLIANCE_FORM_ID });
    const again = await h.webhook(submission);
    expect(await again.json()).toEqual({ ok: true });
    await h.tick(END + GRACE);
    expect(h.ct.dms).toEqual([]);
  });
});

describe("a webhook with no webhook secret set", () => {
  it.each([[""], ["   "]])("gets 500 for a secret of %j", async (secret) => {
    h.configure({ CT_WEBHOOK_SECRET: secret });
    const res = await h.webhook(clockOut());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "webhook secret not configured" });
  });
});

describe("the cron with a required setting missing", () => {
  it("makes no Connecteam calls and sends nothing, then carries on once the setting is back", async () => {
    await h.webhook(clockOut());
    h.configure({ CT_API_KEY: "" });
    await h.tick(END + GRACE);
    expect(h.ct.calls).toEqual([]);
    expect(h.ct.sweepCalls).toEqual([]);
    expect(h.ct.dms).toEqual([]);
    expect(h.ct.posts).toEqual([]);

    h.configure({ CT_API_KEY: env.CT_API_KEY });
    await h.tick(END + GRACE + 60);
    expect(h.ct.dms.map((d) => d.userId)).toEqual([JORDAN.userId]);
  });
});
