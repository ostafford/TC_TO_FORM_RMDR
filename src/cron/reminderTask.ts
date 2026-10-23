/**
 * The Reminder Task lifecycle (#27), run by the cron after the Shifts' own
 * steps. Each due task, by what its Shift says now:
 *  - not created yet: create it on the board chosen when the Reminder went out,
 *    unless the Shift was credited or deleted first, or the Reminder Task has
 *    been turned off since;
 *  - the Shift was deleted: delete it at once;
 *  - a submission was credited to the Shift: close it as `completed`;
 *  - still open 7 days after the Shift: delete it (the Escalation and our
 *    records stay);
 *  - after the Escalation: re-check hourly (one `form-submissions` call), and
 *    close it once a submission is credited;
 *  - ticked by the employee for the first time (#28): check for a submission,
 *    and with none, reopen it and send the tick DM, once. A later tick leaves
 *    it closed; the Escalation notes any tick.
 * Only a credited submission closes it: the employee ticking it is never the
 * check.
 *
 * A failed step is tried again after doubling waits (./backoff.ts, #33). The
 * create and the tick DM are sends: after about an hour, or with their claim
 * stuck, they're given up on and listed in a Failure Alert. The rest (the
 * re-checks, closing and deleting) keep trying at the longest wait.
 */
import { submittedFor } from "../crediting/check.js";
import { reminderTaskDescription, reminderTaskTitle, tickDm } from "../messages/reminderTask.js";
import { TASK_LIFETIME_SECONDS, type ReminderTaskRow, type Undelivered } from "../store.js";
import { LONGEST_WAIT_SECONDS, fullName, retryWait, undelivered } from "./backoff.js";
import type { DueStepDeps } from "./dueSteps.js";

/** The most Reminder Tasks one run takes. */
const TASK_BATCH = 25;

export type TaskStepResult =
  | "created"
  | "completed"
  | "deleted"
  | "checked"
  | "reopened"
  | "skipped"
  | "retry"
  | "given_up"
  | "deferred";

/** What a send gives up on once its waits are used up (#33), given the last failure's status. */
type GiveUp = (status: number | null) => Promise<TaskStepResult>;

export async function runTaskSteps(deps: DueStepDeps): Promise<Record<TaskStepResult, number>> {
  const counts: Record<TaskStepResult, number> = {
    created: 0,
    completed: 0,
    deleted: 0,
    checked: 0,
    reopened: 0,
    skipped: 0,
    retry: 0,
    given_up: 0,
    deferred: 0,
  };
  for (const task of await deps.store.takeDueTasks(deps.now, TASK_BATCH)) {
    // Stopped for the minute (#31): hand it back for the next run.
    if (deps.ct.minuteBudgetSpent()) {
      await deps.store.releaseTask(task.shiftId);
      counts.deferred++;
      continue;
    }
    const result = task.task === null ? await create(task, deps) : await openTask(task, task.task, deps);
    counts[result]++;
  }
  return counts;
}

async function create(row: ReminderTaskRow, deps: DueStepDeps): Promise<TaskStepResult> {
  const { store, ct, settings, now } = deps;
  const log = deps.log ?? (() => {});
  const { shift } = row;
  const needed = !shift.deleted && (shift.status === "reminded" || shift.status === "escalated");
  if (!needed || settings.reminderTask === null || shift.endAt === null || now >= shift.endAt + TASK_LIFETIME_SECONDS) {
    await store.finishTask(row.shiftId, "skipped");
    return "skipped";
  }

  // The task carries no name, so one given up on is listed by user id.
  const giveUp = (outcome: Undelivered["outcome"]) => async (status: number | null) => {
    await store.finishTask(row.shiftId, "skipped", undelivered(failing(row), "task", { name: "", outcome, status }, deps));
    log({ evt: "send_given_up", shiftId: row.shiftId, kind: "task", outcome, status });
    return "given_up" as const;
  };

  const form = await ct.getForm(settings.complianceFormId);
  if (form.outcome !== "ok") return retry(row, deps, { step: "form", ...form }, giveUp("failed"));

  // Creating isn't idempotent: the claim stops a second create until the id is stored.
  const claimKey = `task:${row.shiftId}`;
  if (!(await store.claimSend(claimKey, row.shiftId, now))) {
    // The id is stored in the same batch that marks the claim done, so a held
    // claim here is another run mid-create, or a stuck one: a run that died,
    // or a create that got no answer. A stuck one is given up on, never retried.
    if ((await store.sendState(claimKey, now)) === "stuck") return giveUp("unconfirmed")(null);
    await store.releaseTask(row.shiftId);
    log({ evt: "task_claim_held", shiftId: row.shiftId });
    return "skipped";
  }

  const input = {
    shift: { startSeconds: shift.startAt, endSeconds: shift.endAt, timeZone: shift.startTz },
    deploymentZone: settings.timeZone,
    formName: form.data.formName,
    whereToFind: settings.whereToFind,
  };
  const task = { title: reminderTaskTitle(input), userIds: [shift.userId], description: reminderTaskDescription(input) };
  const created = await ct.createTask(row.boardId, task);
  if (created.outcome !== "ok") {
    if (created.status === null) {
      // No answer: Connecteam may have saved it, and a second create would
      // make a second task. The claim stays, so it's never created again; once
      // stuck, it's given up on as unconfirmed.
      await store.releaseTask(row.shiftId);
      log({ evt: "step_failed", shiftId: row.shiftId, step: "task_create", claimKept: true, ...created });
      return "retry";
    }
    await store.releaseSend(claimKey);
    return retry(row, deps, { step: "task_create", ...created }, giveUp("failed"));
  }
  await store.markTaskCreated(row.shiftId, claimKey, { id: created.data.id, ...task }, now);
  return "created";
}

async function openTask(
  row: ReminderTaskRow,
  task: NonNullable<ReminderTaskRow["task"]>,
  deps: DueStepDeps,
): Promise<TaskStepResult> {
  const { store, ct, now } = deps;
  const { shift } = row;

  if (shift.deleted || shift.endAt === null || now >= shift.endAt + TASK_LIFETIME_SECONDS) {
    return remove(row, task, deps);
  }
  if (row.tick === "ticked" && shift.status !== "submitted") {
    const found = await submittedFor(shift, now, deps);
    if (found.outcome !== "ok") return retry(row, deps, { step: "tick_check", ...found }, giveUpTick(row, "", "failed", deps));
    if (!found.data) return reopen(row, task, shift.endAt, deps);
  } else if (shift.status === "escalated") {
    const found = await submittedFor(shift, now, deps);
    if (found.outcome !== "ok") return retry(row, deps, { step: "task_recheck", ...found }, null);
    if (!found.data) {
      await store.rescheduleTask(row.shiftId, now);
      return "checked";
    }
  } else if (shift.status !== "submitted") {
    // Still before the Escalation, which does its own check.
    await store.rescheduleTask(row.shiftId, now);
    return "skipped";
  }

  const done = await ct.completeTask(row.boardId, task.id, task);
  // A 404: someone deleted the task in Connecteam. Nothing is left to close.
  if (done.outcome !== "ok" && done.status !== 404) return retry(row, deps, { step: "task_complete", ...done }, null);
  await store.finishTask(row.shiftId, done.outcome === "ok" ? "completed" : "deleted");
  return "completed";
}

/**
 * Ticked without submitting: reopen the task, then tell the employee, with
 * the DM claimed so it goes out at most once. Reopening is a full replace and
 * safe to repeat, so a failed DM retries both.
 */
async function reopen(
  row: ReminderTaskRow,
  task: NonNullable<ReminderTaskRow["task"]>,
  endAt: number,
  deps: DueStepDeps,
): Promise<TaskStepResult> {
  const { store, ct, settings, now } = deps;
  const { shift } = row;
  const claimKey = `tick:${row.shiftId}`;
  const state = await store.sendState(claimKey, now);
  if (state === "done") {
    await store.markTickHandled(row.shiftId, { done: claimKey }, now);
    return "reopened";
  }
  // A run died mid-send: never retried.
  if (state === "stuck") return giveUpTick(row, "", "unconfirmed", deps)(null);

  const user = await ct.getUser(shift.userId);
  if (user.outcome !== "ok") return retry(row, deps, { step: "user", ...user }, giveUpTick(row, "", "failed", deps));
  const giveUp = giveUpTick(row, fullName(user.data), "failed", deps);
  const form = await ct.getForm(settings.complianceFormId);
  if (form.outcome !== "ok") return retry(row, deps, { step: "form", ...form }, giveUp);

  const reopened = await ct.reopenTask(row.boardId, task.id, task);
  if (reopened.outcome !== "ok") {
    // A 404: the task never existed on this board. Nothing to reopen or point to.
    if (reopened.status === 404) {
      await store.finishTask(row.shiftId, "deleted");
      return "deleted";
    }
    return retry(row, deps, { step: "task_reopen", ...reopened }, giveUp);
  }

  if (!(await store.claimSend(claimKey, row.shiftId, now))) {
    // Held: another run mid-send. (A stuck claim was given up on above.)
    await store.releaseTask(row.shiftId);
    (deps.log ?? (() => {}))({ evt: "tick_claim_held", shiftId: row.shiftId });
    return "skipped";
  }
  const text = tickDm({
    firstName: user.data?.firstName ?? "",
    shift: { startSeconds: shift.startAt, endSeconds: endAt, timeZone: shift.startTz },
    deploymentZone: settings.timeZone,
    formName: form.data.formName,
    whereToFind: settings.whereToFind,
  });
  const sent = await ct.sendDirectMessage(shift.userId, text);
  if (sent.outcome !== "ok") {
    await store.releaseSend(claimKey);
    return retry(row, deps, { step: "tick_dm", ...sent }, giveUp);
  }
  await store.markTickHandled(row.shiftId, { done: claimKey }, now);
  return "reopened";
}

/** The task's Shift, failing since the task's own step first failed. */
const failing = (row: ReminderTaskRow) => ({ ...row.shift, failingSince: row.failingSince });

/** Give up on the tick DM: the tick counts as handled, and the Escalation still notes it. */
function giveUpTick(row: ReminderTaskRow, name: string, outcome: Undelivered["outcome"], deps: DueStepDeps): GiveUp {
  return async (status) => {
    const u = undelivered(failing(row), "tick", { name, outcome, status }, deps);
    await deps.store.markTickHandled(row.shiftId, { undelivered: u }, deps.now);
    (deps.log ?? (() => {}))({ evt: "send_given_up", shiftId: row.shiftId, kind: "tick", outcome, status });
    return "given_up";
  };
}

async function remove(
  row: ReminderTaskRow,
  task: NonNullable<ReminderTaskRow["task"]>,
  deps: DueStepDeps,
): Promise<TaskStepResult> {
  const gone = await deps.ct.deleteTask(row.boardId, task.id);
  // A 404 means it was already gone, which is what we wanted.
  if (gone.outcome !== "ok" && gone.status !== 404) return retry(row, deps, { step: "task_delete", ...gone }, null);
  await deps.store.finishTask(row.shiftId, "deleted");
  return "deleted";
}

/**
 * The step failed: try it again after the next wait (./backoff.ts). Once the
 * waits are used up, a send (`giveUp`) is given up on; anything else keeps
 * trying at the longest wait.
 */
async function retry(
  row: ReminderTaskRow,
  deps: DueStepDeps,
  detail: Record<string, unknown> & { status?: number | null },
  giveUp: GiveUp | null,
): Promise<TaskStepResult> {
  const failures = row.attempts + 1;
  (deps.log ?? (() => {}))({ evt: "step_failed", shiftId: row.shiftId, failures, ...detail });
  const wait = retryWait(failures);
  if (wait === null && giveUp) return giveUp(detail.status ?? null);
  await deps.store.backOffTask(row.shiftId, deps.now, wait ?? LONGEST_WAIT_SECONDS);
  return "retry";
}
