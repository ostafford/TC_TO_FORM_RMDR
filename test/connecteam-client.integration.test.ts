/**
 * Live, read-only checks of the calls the basic path and the Escalation make,
 * against the account in this project's own `.dev.vars`. Self-skips without
 * CT_API_KEY and COMPLIANCE_FORM_ID. Not run by `npm test`; use `npm run test:integration`.
 * Never copy the research key from ~/IDP/.research.env into .dev.vars.
 */
import { describe, it, expect } from "vitest";
import { ConnecteamClient } from "../src/connecteam/client.js";

const apiKey = process.env.CT_API_KEY ?? "";
const formId = Number(process.env.COMPLIANCE_FORM_ID ?? "");
const live = apiKey !== "" && Number.isInteger(formId) && formId > 0;

describe.skipIf(!live)("ConnecteamClient (live)", () => {
  const ct = new ConnecteamClient({ apiKey, customPublisherId: Number(process.env.CT_PUBLISHER_ID ?? 0) });

  it("reads the Compliance Form's name", async () => {
    const r = await ct.getForm(formId);
    expect(r.outcome).toBe("ok");
    if (r.outcome === "ok") expect(r.data.formName.length).toBeGreaterThan(0);
  });

  it("answers the submission check in one call, with Unix-second bounds", async () => {
    const now = Math.floor(Date.now() / 1000);
    // A user id no account has: the check must come back ok and empty.
    const r = await ct.findFormSubmission(formId, { userId: 1, fromSeconds: now - 86_400, toSeconds: now });
    expect(r).toEqual({ outcome: "ok", data: null });
    expect(ct.lastRateLimit?.minuteLimit).toBeGreaterThan(0);
  });

  it("lists active users with the fields the Escalation reads, and at least one Admin", async () => {
    const r = await ct.listActiveUsers();
    expect(r.outcome).toBe("ok");
    if (r.outcome !== "ok") return;
    expect(r.data.some((u) => u.userType === "manager" || u.userType === "owner")).toBe(true);
    for (const u of r.data) expect(Array.isArray(u.customFields)).toBe(true);
  });
});
