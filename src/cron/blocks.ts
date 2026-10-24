/**
 * Blocks (#34): what stops work until the client fixes it.
 *  - key: Connecteam rejected the API key (a 401 or 403 on any call). Every
 *    step waits: the run stops at once.
 *  - form, publisher, board: the Compliance Form, the custom publisher or the
 *    task board is gone (a 404 on it). Only the steps that need it wait.
 * A block lifts once its setting changes, as the alert's Action asks (the
 * client reran that setup step; the key is compared by hash, never stored).
 * The key and the form, which one call can test, are also re-checked every
 * 15 minutes, in case the failure was Connecteam's own and passed.
 * A failure caused by a block doesn't count toward the step's backoff
 * (./backoff.ts): the step just waits. When a block lifts, every send it held
 * that is now more than an hour overdue is skipped, never sent, and listed in
 * the block's all clear (./failureAlerts.ts), so nobody gets a stale Reminder
 * or a burst of old Escalations.
 */
import type { Block, ShiftRow } from "../store.js";
import { fullName, undelivered } from "./backoff.js";
import type { DueStepDeps } from "./dueSteps.js";

/** The steps that can be held, and the blocks besides the key that hold each. */
export type HeldStep = "shift" | "task_create" | "tick";
const NEEDS: Record<HeldStep, Block[]> = {
  // The Reminder and the Escalation: the form's name, sent as the publisher.
  shift: ["form", "publisher"],
  task_create: ["form", "board"],
  tick: ["form", "publisher"],
};

/** The sends each block holds, skipped when it lifts if more than an hour overdue. */
const HOLDS: Record<Block, { reminder: boolean; escalation: boolean; task: boolean; tick: boolean }> = {
  key: { reminder: true, escalation: true, task: true, tick: true },
  form: { reminder: true, escalation: true, task: true, tick: true },
  publisher: { reminder: true, escalation: true, task: false, tick: true },
  board: { reminder: false, escalation: false, task: true, tick: false },
};

/** A send this overdue when its block lifts is skipped. */
export const SKIP_OVERDUE_SECONDS = 60 * 60;

/** How often a rejected key or a gone Compliance Form is tested again, in case it works now. */
export const RECHECK_SECONDS = 15 * 60;

/** Whether all work is paused: the key is rejected, in force or found this run. */
export function pausedByKey(deps: DueStepDeps): boolean {
  return deps.ct.keyRejected || !!deps.blocks?.has("key");
}

/** Whether this step must wait: a block in force, or one found this run. */
export function held(deps: DueStepDeps, step: HeldStep): boolean {
  if (pausedByKey(deps)) return true;
  return NEEDS[step].some((b) => deps.blocks?.has(b) || (b !== "key" && deps.ct.gone.has(b)));
}

/** Whether a failure was caused by a block, so it doesn't count toward the step's backoff. */
export function causedByBlock(deps: DueStepDeps, status: number | null | undefined): boolean {
  return deps.ct.keyRejected || (status === 404 && deps.ct.gone.size > 0);
}

/** The setting each block was found on, as stored with it: the key only as a hash. */
async function settingOf(block: Block, deps: DueStepDeps): Promise<string | null> {
  const s = deps.settings;
  if (block === "form") return String(s.complianceFormId);
  if (block === "publisher") return String(s.publisherId);
  if (block === "board") return s.reminderTask?.boardId ?? null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s.apiKey));
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Lift every block that's fixed, skipping what it held that's now more than
 * an hour overdue. Returns the blocks still in force. Runs first in each run.
 */
export async function liftBlocks(deps: DueStepDeps): Promise<Set<Block>> {
  const { store, ct, now } = deps;
  const log = deps.log ?? (() => {});
  const inForce = new Set<Block>();
  for (const b of await store.blocks()) {
    let fixed = b.setting !== (await settingOf(b.block, deps));
    const testable = b.block === "key" || b.block === "form";
    if (!fixed && testable && now - b.checkedAt >= RECHECK_SECONDS && !ct.stopped()) {
      const probe = await ct.getForm(deps.settings.complianceFormId);
      // For the key, a 404 is the form, not the key: the key works.
      fixed = b.block === "key" ? !ct.keyRejected && (probe.outcome === "ok" || probe.status === 404) : probe.outcome === "ok";
      if (!fixed) await store.blockChecked(b.block, now);
    }
    if (!fixed) {
      inForce.add(b.block);
      continue;
    }
    if (!(await store.unblock(b.block))) continue; // another run lifted it
    // Tasks not yet created go to the board chosen in its place.
    const board = deps.settings.reminderTask?.boardId;
    if (b.block === "board" && b.setting !== null && board) await store.moveUncreatedTasks(b.setting, board);
    const skipped = await skipOverdue(b.block, { ...deps, blocks: inForce });
    // Even if it lifted before its alert went out, its all clear must list what was skipped.
    if (skipped > 0) await store.raiseQuietly(b.block);
    log({ evt: "block_lifted", block: b.block, since: b.since, skipped });
  }
  return inForce;
}

/** Skip the sends the block held that are now more than an hour overdue. Returns how many. */
async function skipOverdue(block: Block, deps: DueStepDeps): Promise<number> {
  const { store, ct, settings, now } = deps;
  const holds = HOLDS[block];
  const cutoff = now - SKIP_OVERDUE_SECONDS;
  const shifts = holds.reminder || holds.escalation ? await store.overdueShifts(cutoff) : [];
  const tasks = (await store.overdueTaskSends(cutoff)).filter((t) => (t.task === null ? holds.task : holds.tick));
  if (shifts.length === 0 && tasks.length === 0) return 0;

  // One call for everyone's name; without it, they're listed by user id.
  const users = ct.stopped() ? null : await ct.listActiveUsers();
  const names = new Map(users?.outcome === "ok" ? users.data.map((u) => [u.userId, fullName(u)]) : []);
  const skip = (shift: Pick<ShiftRow, "id" | "userId" | "startAt" | "startTz">, kind: "reminder" | "escalation" | "task" | "tick") =>
    undelivered(
      { ...shift, failingSince: null },
      kind,
      { name: names.get(shift.userId) ?? "", outcome: "skipped", status: null, alert: block },
      deps,
    );

  let count = 0;
  for (const shift of shifts) {
    if (shift.status === "grace" && holds.reminder) {
      // The Shift carries on as if the Reminder had gone out on time; the Reminder Task, overdue too, is skipped with it.
      const escalateAt = shift.graceEndsAt! + settings.escalationDelayMinutes * 60;
      await store.giveUpReminder(shift.id, skip(shift, "reminder"), escalateAt, holds.task ? null : settings.reminderTask);
      count++;
      if (escalateAt > cutoff || !holds.escalation) continue;
    } else if (shift.status !== "reminded" || !holds.escalation) {
      continue;
    }
    await store.markEscalated(shift.id, now, skip(shift, "escalation"));
    count++;
  }
  for (const task of tasks) {
    if (task.task === null) await store.finishTask(task.shiftId, "skipped", skip(task.shift, "task"));
    else await store.markTickHandled(task.shiftId, { undelivered: skip(task.shift, "tick") }, now);
    count++;
  }
  return count;
}

/** Record the blocks found this run, so later runs wait and the alerts go out. Runs last. */
export async function recordBlocks(deps: DueStepDeps): Promise<Block[]> {
  const found: Block[] = [...(deps.ct.keyRejected ? (["key"] as const) : []), ...deps.ct.gone];
  for (const b of found) await deps.store.block(b, deps.now, await settingOf(b, deps));
  if (found.length > 0) (deps.log ?? (() => {}))({ evt: "blocked", blocks: found });
  return found;
}
