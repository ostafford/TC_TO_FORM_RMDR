/**
 * Finding a Shift's Scheduled Shift (#6, #24): only through its
 * `schedulerShiftId`, never by matching user and times. The Shift doesn't say
 * which scheduler it belongs to, so each non-archived scheduler is tried
 * (about 1 to 3 calls). An id with a `:` is V1's; otherwise V1 is tried, then
 * V2 (a Vision-migrated account). Not found under any: no Scheduled Shift.
 */
import type { ConnecteamClient } from "../connecteam/client.js";
import type { CtResult, ScheduledShift, Scheduler } from "../connecteam/types.js";

/** What one run reads once for every lookup. */
export interface SchedulerReads {
  schedulers?: CtResult<Scheduler[]>;
}

/** The Scheduled Shift, `null` when there's none, or the failed call as it came back. */
export async function findScheduledShift(
  ct: ConnecteamClient,
  schedulerShiftId: string,
  reads: SchedulerReads = {},
): Promise<CtResult<ScheduledShift | null>> {
  const schedulers = (reads.schedulers ??= await ct.listSchedulers());
  if (schedulers.outcome !== "ok") return schedulers;
  const versions: (1 | 2)[] = schedulerShiftId.includes(":") ? [1] : [1, 2];
  for (const s of schedulers.data.filter((x) => !x.isArchived)) {
    for (const v of versions) {
      const found = await ct.getScheduledShift(s.schedulerId, schedulerShiftId, v);
      if (found.outcome !== "ok" || found.data) return found;
    }
  }
  return { outcome: "ok", data: null };
}
