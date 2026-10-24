/**
 * What every Shift step shares (./dueSteps.ts, ./escalate.ts,
 * ./summary.ts): its result, the submission check, and retrying a failure
 * with backoff (./backoff.ts, #33) or waiting out a block (./blocks.ts, #34).
 */
import { submittedFor } from "../crediting/check.js";
import type { ShiftRow } from "../store.js";
import { retryWait } from "./backoff.js";
import { causedByBlock } from "./blocks.js";
import type { DueStepDeps } from "./dueSteps.js";

/** held: waiting for a block to lift. quiet: an Escalation held for Quiet Hours (#29). */
export type StepResult = "submitted" | "reminded" | "escalated" | "retry" | "given_up" | "skipped" | "deferred" | "held" | "quiet";

/** What a step gives up on once its waits are used up (#33), given the last failure's status. */
export type GiveUp = (status: number | null) => Promise<StepResult>;

export async function skip(shift: ShiftRow, deps: DueStepDeps): Promise<StepResult> {
  await deps.store.release(shift.id);
  return "skipped";
}

/**
 * Did they submit between the Shift's first clock-in and `toSeconds`
 * (../crediting/check.ts)? Returns a result to stop with, or `null` when
 * nothing counts for this Shift.
 */
export async function checkSubmitted(
  shift: ShiftRow,
  toSeconds: number,
  step: string,
  deps: DueStepDeps,
  giveUp: GiveUp,
): Promise<StepResult | null> {
  const found = await submittedFor(shift, toSeconds, deps);
  if (found.outcome !== "ok") return retry(shift, deps, { step, ...found }, giveUp);
  return found.data ? "submitted" : null;
}

/**
 * The step failed: try it again after the next wait (./backoff.ts), or once
 * the waits are used up, give up on it. A failure caused by a block only
 * waits for it to lift.
 */
export async function retry(
  shift: ShiftRow,
  deps: DueStepDeps,
  detail: Record<string, unknown> & { status?: number | null },
  giveUp: GiveUp,
): Promise<StepResult> {
  if (causedByBlock(deps, detail.status)) {
    // It waits for the block to lift (./blocks.ts): no try used up.
    (deps.log ?? (() => {}))({ evt: "step_held", shiftId: shift.id, ...detail });
    await deps.store.release(shift.id);
    return "held";
  }
  const failures = shift.attempts + 1;
  (deps.log ?? (() => {}))({ evt: "step_failed", shiftId: shift.id, failures, ...detail });
  const wait = retryWait(failures);
  if (wait === null) return giveUp(detail.status ?? null);
  await deps.store.backOff(shift.id, shift.status, deps.now, wait);
  return "retry";
}
