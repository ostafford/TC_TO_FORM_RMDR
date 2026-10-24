/**
 * The setup wizard's Expert-plan check (#37, user story 48). Connecteam's
 * rate-limit headers show the account's daily limit, not its plan's name
 * (tested live 2026-10-24, #37), so the check compares the limit itself with
 * Expert's: below it, the reminder would run out of calls by lunchtime.
 * Pure, so the rules are tested without a network.
 */

/** Expert's daily allowance, the least this integration needs (#19). */
export const EXPERT_DAY_LIMIT = 10_000;

export type Allowance =
  | { kind: "ok"; dayLimit: number; dayRemaining: number | null }
  | { kind: "below_expert"; dayLimit: number }
  | { kind: "rejected"; status: number }
  | { kind: "unknown"; detail: string };

/** What one call's answer says about the key and the account's daily allowance. */
export function allowanceOf(status: number, headers: Headers): Allowance {
  if (status === 401 || status === 403) return { kind: "rejected", status };
  if (status < 200 || status >= 300) return { kind: "unknown", detail: `Connecteam answered HTTP ${status}` };
  const num = (name: string) => {
    const v = headers.get(name);
    const n = v === null || v.trim() === "" ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const dayLimit = num("x-ratelimit-day-limit");
  if (dayLimit === null) return { kind: "unknown", detail: "no x-ratelimit-day-limit header" };
  if (dayLimit < EXPERT_DAY_LIMIT) return { kind: "below_expert", dayLimit };
  return { kind: "ok", dayLimit, dayRemaining: num("x-ratelimit-day-remaining") };
}
