/**
 * The work list's own guard that a submission counts for one Shift only
 * (#26), below the crediting order: whatever chooses the Shift, the store
 * refuses a second.
 */
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { creditSubmission } from "../../src/crediting/credit.js";
import { WorkList } from "../../src/store.js";
import { resetDb } from "./harness.js";

const store = new WorkList(env.DB);
const rules = { shiftDateQuestionId: "", complianceFormId: 9001, deploymentZone: "Australia/Sydney" };

async function shift(id: string, start: number) {
  await store.recordSegment(
    {
      dedupeKey: id,
      eventType: "clock_out",
      userId: 501,
      timeClockId: 67,
      activity: { id, start: { timestamp: start, timezone: "Australia/Sydney" }, end: { timestamp: start + 3600, timezone: "Australia/Sydney" } },
    },
    { formIds: [9001], gracePeriodMinutes: 30, now: start + 3600 },
  );
}

beforeEach(async () => {
  await resetDb();
  await shift("a", 1_000_000);
  await shift("b", 2_000_000);
});

describe("crediting in the store", () => {
  it("refuses to credit a submission already counted for another Shift", async () => {
    expect(await store.credit("a", "s-1", 3_000_000)).toBe(true);
    expect(await store.credit("b", "s-1", 3_000_000)).toBe(false);
    expect(await store.creditedTo("s-1")).toBe("a");
  });

  it("refuses to credit a Shift that already has a submission", async () => {
    expect(await store.credit("a", "s-1", 3_000_000)).toBe(true);
    expect(await store.credit("a", "s-2", 3_000_000)).toBe(false);
  });

  it("reports where a submission already counts, without moving it", async () => {
    const s = { formSubmissionId: "s-1", formId: 9001, submittingUserId: 501, submissionTimestamp: 2_000_100 };
    expect(await creditSubmission(store, s, rules, 3_000_000)).toBe("b");
    expect(await creditSubmission(store, { ...s, submissionTimestamp: 1_000_100 }, rules, 3_000_000)).toBe("b");
  });
});
