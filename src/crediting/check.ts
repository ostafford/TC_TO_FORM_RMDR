/**
 * "Did they submit?" (#3), asked at the end of a Grace Period, at the
 * escalation point, and by the hourly Reminder Task re-check (#27): one
 * `form-submissions` call per form that counts for the Shift, from its first
 * clock-in to `toSeconds`. Each submission found that isn't credited elsewhere
 * goes through the crediting order (#26), which may credit it to another Shift
 * instead.
 */
import type { ConnecteamClient } from "../connecteam/client.js";
import type { CtResult } from "../connecteam/types.js";
import { creditRules, type Settings } from "../env.js";
import type { ShiftRow, WorkList } from "../store.js";
import { creditSubmission } from "./credit.js";

export interface CheckDeps {
  store: WorkList;
  ct: ConnecteamClient;
  settings: Settings;
  /** Unix seconds. */
  now: number;
}

/** `true` when a submission now counts for this Shift; a failed call is passed back as is. */
export async function submittedFor(
  shift: Pick<ShiftRow, "id" | "userId" | "startAt" | "formIds">,
  toSeconds: number,
  deps: CheckDeps,
): Promise<CtResult<boolean>> {
  for (const formId of shift.formIds) {
    const found = await deps.ct.listFormSubmissions(formId, {
      userId: shift.userId,
      fromSeconds: shift.startAt,
      toSeconds,
    });
    if (found.outcome !== "ok") return found;
    for (const submission of found.data) {
      const creditedTo = await creditSubmission(deps.store, submission, creditRules(deps.settings), deps.now);
      if (creditedTo === shift.id) return { outcome: "ok", data: true };
    }
  }
  return { outcome: "ok", data: false };
}
