/**
 * Failure Alerts (#33), run first in each cron run: post what earlier runs
 * found wrong to the Alerts Channel, never as DMs, and never held for Quiet
 * Hours. Two conditions so far:
 *  - messages: a send was given up on (it kept failing for about an hour, or
 *    its claim was stuck) and nothing has gone out since. The alert lists who
 *    wasn't reached; the all clear follows once a send goes out again, and
 *    lists them once more to follow up by hand.
 *  - sweep: the polling sweep's reads have failed for about an hour (#32).
 *
 * Each alert and all clear is claimed in D1 before it's posted, and marked
 * posted only on `outcome === "ok"` (playbook: check every send's outcome). A
 * condition alerts at most once per 24 hours, so a problem that comes and goes
 * doesn't repeat itself; while it's held back, sends given up on still reach
 * the client in the next all clear.
 */
import { allClear, clockOutCheckFailing, failureCause, messagesNotSending } from "../messages/failureAlert.js";
import type { AlertCondition } from "../store.js";
import type { DueStepDeps } from "./dueSteps.js";

/** A condition alerts again no sooner than this after its last alert. */
export const ALERT_HOLD_SECONDS = 24 * 60 * 60;

/** The sweep's reads failing this long raise its alert. */
export const SWEEP_FAILING_SECONDS = 60 * 60;

export interface AlertResult {
  /** Alerts and all clears posted this run. */
  posted: number;
  /** Posts that failed; the next run tries again. */
  failed: number;
}

export async function runFailureAlerts(deps: DueStepDeps): Promise<AlertResult> {
  const { store, now } = deps;
  const result: AlertResult = { posted: 0, failed: 0 };
  // A run that died mid-post: count it as posted, so nothing goes out twice.
  const settled = await store.settleStuckAlerts(now);
  if (settled > 0) (deps.log ?? (() => {}))({ evt: "alert_claim_stuck", settled });

  await messages(deps, result);
  await sweep(deps, result);
  return result;
}

async function messages(deps: DueStepDeps, result: AlertResult): Promise<void> {
  const { store, now } = deps;
  const sends = await store.openUndelivered();
  if (await store.sendsFailing()) {
    if (await store.claimAlert("messages", now, ALERT_HOLD_SECONDS)) {
      const latest = sends[sends.length - 1]!;
      const text = messagesNotSending({
        sinceMinutes: Math.floor((now - Math.min(...sends.map((s) => s.failingSince))) / 60),
        cause: failureCause(latest),
        sends,
      });
      if (await post("messages", "alert", text, deps, result)) await store.alertPosted("messages", now);
      else await store.raiseQuietly("messages");
    } else {
      // Held back: no alert, but the all clear will list these.
      await store.raiseQuietly("messages");
    }
  } else if (await store.claimAllClear("messages", now)) {
    const text = allClear({ recovered: "messages", sends });
    if (await post("messages", "all_clear", text, deps, result)) {
      await store.allClearPosted(
        "messages",
        sends.map((s) => s.sendKey),
        now,
      );
    } else await store.releaseAllClear("messages");
  }
}

async function sweep(deps: DueStepDeps, result: AlertResult): Promise<void> {
  const { store, now } = deps;
  const since = await store.sweepState("read_failing_since");
  if (since !== null && now - since >= SWEEP_FAILING_SECONDS) {
    if (!(await store.claimAlert("sweep", now, ALERT_HOLD_SECONDS))) return;
    const status = (await store.sweepState("read_failing_status")) || null;
    const text = clockOutCheckFailing({
      sinceMinutes: Math.floor((now - since) / 60),
      cause: failureCause({ outcome: "failed", status }),
    });
    if (await post("sweep", "alert", text, deps, result)) await store.alertPosted("sweep", now);
    else await store.raiseQuietly("sweep");
  } else if (since === null && (await store.claimAllClear("sweep", now))) {
    if (await post("sweep", "all_clear", allClear({ recovered: "sweep", sends: [] }), deps, result)) {
      await store.allClearPosted("sweep", [], now);
    } else await store.releaseAllClear("sweep");
  }
}

/** Post to the Alerts Channel. `true` only when Connecteam reports `ok`. */
async function post(
  condition: AlertCondition,
  kind: "alert" | "all_clear",
  text: string,
  deps: DueStepDeps,
  result: AlertResult,
): Promise<boolean> {
  const sent = await deps.ct.sendChannelMessage(deps.settings.alertsChannelId, text);
  const log = deps.log ?? (() => {});
  if (sent.outcome !== "ok") {
    result.failed++;
    log({ evt: "alert_failed", condition, kind, ...sent });
    return false;
  }
  result.posted++;
  log({ evt: "alert_posted", condition, kind });
  return true;
}
