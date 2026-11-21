/**
 * Live, read-only checks of the calls the basic path and the Escalation make,
 * and of the assumptions the fake Connecteam makes that matter most (#93),
 * against the account in this project's own `.dev.vars` (the demo account).
 * Self-skips without CT_API_KEY and COMPLIANCE_FORM_ID. Not run by `npm test`;
 * use `npm run test:integration`, before every release (RUNBOOK "Tests").
 * Never copy the research key from ~/IDP/.research.env into .dev.vars.
 */
import { describe, it, expect } from "vitest";
import { ConnecteamClient } from "../src/connecteam/client.js";

const apiKey = process.env.CT_API_KEY ?? "";
const formId = Number(process.env.COMPLIANCE_FORM_ID ?? "");
const live = apiKey !== "" && Number.isInteger(formId) && formId > 0;

/** A raw GET, for what the client doesn't expose: other query strings, other keys. */
const get = (path: string, key: string | null = apiKey) =>
  fetch(`https://api.connecteam.com${path}`, { headers: key === null ? {} : { "X-API-KEY": key } });
const userIds = async (path: string) =>
  ((await (await get(path)).json()) as { data: { users: Array<{ userId: number }> } }).data.users.map((u) => u.userId);
/** `YYYY-MM-DD` for a Unix-seconds instant in a time zone. */
const day = (seconds: number, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone }).format(seconds * 1000);
const DAY = 86_400;

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
    const r = await ct.listFormSubmissions(formId, { userId: 1, fromSeconds: now - 86_400, toSeconds: now });
    expect(r).toEqual({ outcome: "ok", data: [] });
    expect(ct.lastRateLimit?.minuteLimit).toBeGreaterThan(0);
  });

  it("lists active users with the fields the Escalation reads, and at least one Admin", async () => {
    const r = await ct.listActiveUsers();
    expect(r.outcome).toBe("ok");
    if (r.outcome !== "ok") return;
    expect(r.data.some((u) => u.userType === "manager" || u.userType === "owner")).toBe(true);
    for (const u of r.data) expect(Array.isArray(u.customFields)).toBe(true);
  });

  describe("the fake's riskiest assumptions (#93)", () => {
    it("finds an archived user by id only with userStatus=all (#82)", async () => {
      const [archived] = await userIds("/users/v1/users?userStatus=archived&limit=1&offset=0");
      expect(archived, "the account needs an archived user").toBeTypeOf("number");
      expect(await userIds(`/users/v1/users?userIds=${archived}&limit=1&offset=0`)).toEqual([]);
      expect(await userIds(`/users/v1/users?userIds=${archived}&userStatus=all&limit=1&offset=0`)).toEqual([archived]);
    });

    it("returns form submissions newest first", async () => {
      const res = await get(`/forms/v1/forms/${formId}/form-submissions?limit=100`);
      expect(res.status).toBe(200);
      const subs = ((await res.json()) as { data: { formSubmissions: Array<{ submissionTimestamp: number }> } }).data.formSubmissions;
      expect(subs.length, "the Compliance Form needs two submissions or more").toBeGreaterThanOrEqual(2);
      const times = subs.map((s) => s.submissionTimestamp);
      expect(times).toEqual([...times].sort((a, b) => b - a));
    });

    it("filters time activities on each record's local start date (#92)", async () => {
      const clocks = await ct.listTimeClocks();
      if (clocks.outcome !== "ok") throw new Error(`time clocks: ${clocks.outcome}`);
      const now = Math.floor(Date.now() / 1000);
      const [from, to] = [day(now - 60 * DAY, "UTC"), day(now, "UTC")];
      for (const clock of clocks.data) {
        const wide = await ct.listTimeActivities(clock.id, from, to);
        if (wide.outcome !== "ok") throw new Error(`time activities: ${wide.outcome}`);
        const records = wide.data.flatMap((u) => [...u.shifts, ...u.manualBreaks]);
        const first = records[0];
        if (!first) continue;
        // One day, read in the record's own zone: exactly the records that started that day there.
        const date = day(first.start.timestamp, first.start.timezone);
        const narrow = await ct.listTimeActivities(clock.id, date, date);
        if (narrow.outcome !== "ok") throw new Error(`time activities: ${narrow.outcome}`);
        const ids = (rs: typeof records) => rs.map((r) => r.id).sort();
        expect(ids(narrow.data.flatMap((u) => [...u.shifts, ...u.manualBreaks]))).toEqual(
          ids(records.filter((r) => day(r.start.timestamp, r.start.timezone) === date)),
        );
        return;
      }
      throw new Error("no time clock has a record in the last 60 days");
    });

    it("answers a bad key with 403, and no key with 401: both reject the key", async () => {
      expect((await get(`/forms/v1/forms/${formId}`, "not-a-real-key")).status).toBe(403);
      expect((await get(`/forms/v1/forms/${formId}`, null)).status).toBe(401);
      const bad = new ConnecteamClient({ apiKey: "not-a-real-key", customPublisherId: 0 });
      await bad.getForm(formId);
      expect(bad.keyRejected).toBe(true);
    });
  });
});
