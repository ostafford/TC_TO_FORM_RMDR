/**
 * Failure Alerts (#33, #34), run near the start of each cron run: post what
 * earlier runs found wrong to the Alerts Channel, never as DMs, and never held
 * for Quiet Hours. The conditions:
 *  - messages: a send was given up on (it kept failing for about an hour, or
 *    its claim was stuck) and nothing has gone out since. The alert lists who
 *    wasn't reached; the all clear follows once a send goes out again, and
 *    lists them once more to follow up by hand.
 *  - sweep: the polling sweep's reads have failed for about an hour (#32).
 *  - key, form, publisher, board: a block is in force (./blocks.ts). The all
 *    clear, once it lifts, lists the sends skipped as more than an hour late.
 *  - webhook: clock-outs not arriving. The sweep found 3 or more Shift
 *    Segments the webhook missed in 24 hours, or no webhook arrived for 24
 *    hours while Shifts happened.
 *  - allowance: less than 20% of the account's daily API allowance is left.
 *
 * Each alert and all clear is claimed in D1 before it's posted, and marked
 * posted only on `outcome === "ok"` (playbook: check every send's outcome). A
 * condition alerts at most once per 24 hours, so a problem that comes and goes
 * doesn't repeat itself; while it's held back, sends given up on or skipped
 * still reach the client in the next all clear. With the API key rejected,
 * no post can get through Connecteam; the alert stays owed, and the all clear
 * reports once the key works (the Integrator Relay, #36, is the other way out).
 */
import {
  allClear,
  allowanceUsed,
  clockOutCheckFailing,
  clockOutsNotArriving,
  failureCause,
  messagesNotSending,
  paused,
  settingGone,
} from "../messages/failureAlert.js";
import type { AlertCondition, Block } from "../store.js";
import type { DueStepDeps } from "./dueSteps.js";
import { DEFAULT_DAY_LIMIT } from "./sweep.js";

/** A condition alerts again no sooner than this after its last alert. */
export const ALERT_HOLD_SECONDS = 24 * 60 * 60;

/** The sweep's reads failing this long raise its alert. */
export const SWEEP_FAILING_SECONDS = 60 * 60;

/** The window the lost-webhook alert looks over. */
export const WEBHOOK_WINDOW_SECONDS = 24 * 60 * 60;

/** This many Shift Segments found by the sweep alone, in the window, mean the webhook is losing them. */
export const WEBHOOK_MISSED_LIMIT = 3;

/** The allowance alert is raised once less than this share of the daily allowance is left. */
export const ALLOWANCE_LEFT_SHARE = 0.2;

export interface AlertResult {
  /** Alerts and all clears posted this run. */
  posted: number;
  /** Posts that failed; the next run tries again. */
  failed: number;
}

/** Where a condition stands this run: the alert's text, recovered, or neither (still settling). */
type Standing = { alert: string } | "recovered" | "neither";

export async function runFailureAlerts(deps: DueStepDeps): Promise<AlertResult> {
  const { store, now } = deps;
  const result: AlertResult = { posted: 0, failed: 0 };
  // A run that died mid-post: count it as posted, so nothing goes out twice.
  const settled = await store.settleStuckAlerts(now);
  if (settled > 0) (deps.log ?? (() => {}))({ evt: "alert_claim_stuck", settled });

  // In force from earlier runs, by the setting they were found on.
  const blocks = new Map((await store.blocks()).map((b) => [b.block, b]));
  for (const block of ["key", "form", "publisher", "board"] as const satisfies readonly Block[]) {
    const b = deps.blocks?.has(block) ? blocks.get(block) : undefined;
    const alert = !b ? null : block === "key" ? paused() : settingGone({ setting: block, id: b.setting ?? "" });
    // Held back, a block still owes its all clear: it lists the sends skipped when it lifts.
    await evaluate(block, alert === null ? "recovered" : { alert }, deps, result, { quietWhenHeld: true });
  }

  await messages(deps, result);
  await evaluate("sweep", await sweep(deps), deps, result);
  await evaluate("webhook", await webhook(deps), deps, result);
  await evaluate("allowance", await allowance(deps), deps, result);
  return result;
}

/**
 * Post the condition's alert, unless it's held back, or its all clear once
 * it has recovered. `quietWhenHeld`: a condition held back is still raised,
 * quietly, for one whose all clear may have sends to list; a quiet one's all
 * clear is posted only when it has.
 */
async function evaluate(
  condition: AlertCondition,
  standing: Standing,
  deps: DueStepDeps,
  result: AlertResult,
  opts: { quietWhenHeld?: boolean } = {},
): Promise<void> {
  const { store, now } = deps;
  if (standing === "neither") return;
  if (standing !== "recovered") {
    if (await store.claimAlert(condition, now, ALERT_HOLD_SECONDS)) {
      if (await post(condition, "alert", standing.alert, deps, result)) await store.alertPosted(condition, now);
      else await store.raiseQuietly(condition);
    } else if (opts.quietWhenHeld) {
      await store.raiseQuietly(condition);
    }
    return;
  }
  const claim = await store.claimAllClear(condition, now);
  if (!claim) return;
  const sends = await store.openUndelivered(condition);
  if (claim.quiet && sends.length === 0) {
    // The client never heard of it, and nothing was missed: nothing to say.
    await store.allClearPosted(condition, [], now);
    return;
  }
  if (await post(condition, "all_clear", allClear({ recovered: condition, sends }), deps, result)) {
    await store.allClearPosted(
      condition,
      sends.map((s) => s.sendKey),
      now,
    );
  } else await store.releaseAllClear(condition);
}

/** Sends given up on, and nothing gone out since: alert, listing them. */
async function messages(deps: DueStepDeps, result: AlertResult): Promise<void> {
  const { store, now } = deps;
  if (!(await store.sendsFailing())) return evaluate("messages", "recovered", deps, result);
  const sends = await store.openUndelivered("messages");
  const latest = sends[sends.length - 1]!;
  const alert = messagesNotSending({
    sinceMinutes: Math.floor((now - Math.min(...sends.map((s) => s.failingSince))) / 60),
    cause: failureCause(latest),
    sends,
  });
  // Held back: no alert, but the all clear will list these.
  await evaluate("messages", { alert }, deps, result, { quietWhenHeld: true });
}

async function sweep(deps: DueStepDeps): Promise<Standing> {
  const { store, now } = deps;
  const since = await store.state("read_failing_since");
  if (since === null) return "recovered";
  if (now - since < SWEEP_FAILING_SECONDS) return "neither";
  const status = (await store.state("read_failing_status")) || null;
  return {
    alert: clockOutCheckFailing({
      sinceMinutes: Math.floor((now - since) / 60),
      cause: failureCause({ outcome: "failed", status }),
    }),
  };
}

/**
 * Clock-outs not arriving. A Deployment that has never had a webhook counts
 * as silent once it has watched for the whole window.
 */
async function webhook(deps: DueStepDeps): Promise<Standing> {
  const { now } = deps;
  const h = await deps.store.webhookHealth(now, WEBHOOK_WINDOW_SECONDS);
  const quietSince = h.lastDelivery ?? h.watchingSince;
  const silent = h.activity && quietSince !== null && now - quietSince >= WEBHOOK_WINDOW_SECONDS;
  if (silent) return { alert: clockOutsNotArriving({ silentHours: Math.floor((now - quietSince) / 3600) }) };
  if (h.missed >= WEBHOOK_MISSED_LIMIT) return { alert: clockOutsNotArriving({ missed: h.missed }) };
  return "recovered";
}

/** Less than 20% of the daily allowance left, as of the last call that said so. */
async function allowance(deps: DueStepDeps): Promise<Standing> {
  const remaining = await deps.store.state("day_remaining");
  if (remaining === null) return "neither";
  const limit = (await deps.store.state("day_limit")) ?? DEFAULT_DAY_LIMIT;
  return remaining < limit * ALLOWANCE_LEFT_SHARE ? { alert: allowanceUsed() } : "recovered";
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
