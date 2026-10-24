/**
 * `npm run --silent check-api-key`: the wizard's step 2 check (#37). Reads the
 * key from CT_API_KEY in the environment (never an argument, so it isn't in
 * the process list or the session log), makes one call that returns no staff
 * data (the time clocks), and prints one JSON line: ./lib/api-allowance.ts.
 *
 * Exit: 0 the key works on Expert or above, 2 below Expert, 3 the key was
 * rejected, 4 anything else (no answer, no limit header).
 *
 * CT_API_BASE replaces https://api.connecteam.com, for the wizard's tests.
 */
import { allowanceOf, type Allowance } from "./lib/api-allowance.js";

const EXIT: Record<Allowance["kind"], number> = { ok: 0, below_expert: 2, rejected: 3, unknown: 4 };

async function main(): Promise<Allowance> {
  const key = (process.env.CT_API_KEY ?? "").trim();
  if (!key) return { kind: "unknown", detail: "CT_API_KEY is empty" };
  try {
    const base = (process.env.CT_API_BASE ?? "https://api.connecteam.com").replace(/\/+$/, "");
    const res = await fetch(`${base}/time-clock/v1/time-clocks`, {
      headers: { "X-API-KEY": key, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    await res.body?.cancel();
    return allowanceOf(res.status, res.headers);
  } catch (err) {
    return { kind: "unknown", detail: err instanceof Error ? err.message : String(err) };
  }
}

const result = await main();
console.log(JSON.stringify(result));
process.exit(EXIT[result.kind]);
