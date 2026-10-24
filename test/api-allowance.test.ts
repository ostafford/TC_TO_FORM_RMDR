/** The wizard's Expert-plan check (#37): what one answer says about the key and the daily allowance. */
import { describe, it, expect } from "vitest";
import { EXPERT_DAY_LIMIT, allowanceOf } from "../scripts/lib/api-allowance.js";

const headers = (h: Record<string, string>) => new Headers(h);

describe("allowanceOf", () => {
  it("passes Expert's 10,000 a day and above, reading what's left", () => {
    expect(EXPERT_DAY_LIMIT).toBe(10_000);
    expect(allowanceOf(200, headers({ "x-ratelimit-day-limit": "10000", "x-ratelimit-day-remaining": "9990" }))).toEqual({
      kind: "ok",
      dayLimit: 10_000,
      dayRemaining: 9990,
    });
    // As the demo account answered live (2026-10-24, #37).
    expect(allowanceOf(200, headers({ "x-ratelimit-day-limit": "20000", "x-ratelimit-day-reset": "1792886400.0" }))).toMatchObject({
      kind: "ok",
      dayLimit: 20_000,
    });
  });

  it("refuses below Expert", () => {
    expect(allowanceOf(200, headers({ "x-ratelimit-day-limit": "9999" }))).toEqual({ kind: "below_expert", dayLimit: 9999 });
    expect(allowanceOf(200, headers({ "x-ratelimit-day-limit": "1000" }))).toEqual({ kind: "below_expert", dayLimit: 1000 });
  });

  it("calls a 401 or 403 a rejected key (an invalid key answers 403, tested live 2026-10-24)", () => {
    expect(allowanceOf(403, headers({}))).toEqual({ kind: "rejected", status: 403 });
    expect(allowanceOf(401, headers({}))).toEqual({ kind: "rejected", status: 401 });
  });

  it("can't tell without the limit header, or on another failure", () => {
    expect(allowanceOf(200, headers({}))).toEqual({ kind: "unknown", detail: "no x-ratelimit-day-limit header" });
    expect(allowanceOf(200, headers({ "x-ratelimit-day-limit": "lots" }))).toMatchObject({ kind: "unknown" });
    expect(allowanceOf(503, headers({ "x-ratelimit-day-limit": "20000" }))).toEqual({ kind: "unknown", detail: "Connecteam answered HTTP 503" });
  });
});
