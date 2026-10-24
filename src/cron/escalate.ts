/**
 * The escalation point (#25), the escalation delay after the Reminder.
 * Recipients are read live, so a newly promoted Admin is included and an
 * Excluded Admins change takes effect on the next send. Each recipient's send
 * is claimed on its own (`escalation:<shift>:<recipient>`): a failure retries
 * only the recipients still owed, after the next wait, and nobody gets it
 * twice. Once given up on, or with a recipient's claim stuck, the Escalation
 * is listed in a Failure Alert by the employee it's about.
 *
 * During Quiet Hours (#29), the Escalation is held, with no calls made, until
 * they end; then it goes out in the Escalation Summary (./summary.ts), which
 * shares the preparing and finishing here. Quiet Hours are read when it's due.
 */
import type { ConnecteamUser, CtResult, Form } from "../connecteam/types.js";
import { escalationRecipients } from "../escalation/recipients.js";
import { isQuiet, quietEnds } from "../escalation/quietHours.js";
import { escalation, type SummaryEntry } from "../messages/escalation.js";
import type { ShiftRow, Undelivered } from "../store.js";
import { fullName, undelivered } from "./backoff.js";
import type { DueStepDeps } from "./dueSteps.js";
import { checkSubmitted, retry, skip, type GiveUp, type StepResult } from "./steps.js";

/** One Shift's Escalation, checked and ready to send: who gets it, and what it says. */
export interface Prepared {
  shift: ShiftRow;
  recipients: number[];
  entry: SummaryEntry;
  formName: string;
  giveUp: GiveUp;
  /** How its sends went, for {@link finish}. */
  tally: { failed: { status: number | null } | null; owed: number; busy: number; stuck: number };
  missed: (outcome: Undelivered["outcome"], status: number | null) => Undelivered;
}

/** What one run reads once for every Shift in the Escalation Summary. */
export interface Reads {
  users?: CtResult<ConnecteamUser[]>;
  form?: CtResult<Form>;
}

/** The Quiet Hours `now` falls in end at, or `null` when it isn't quiet (or they're off). */
export function quietUntil(deps: DueStepDeps): number | null {
  const q = deps.settings.quietHours;
  if (!q || !isQuiet(deps.now, deps.settings.timeZone, q)) return null;
  return quietEnds(deps.now, deps.settings.timeZone, q);
}

/** The daytime escalation point: hold it if it's quiet, otherwise send each recipient their Escalation. */
export async function escalationPoint(shift: ShiftRow, deps: DueStepDeps): Promise<StepResult> {
  if (shift.endAt === null) return skip(shift, deps);
  const releaseAt = quietUntil(deps);
  if (releaseAt !== null) {
    await deps.store.hold(shift.id, releaseAt);
    (deps.log ?? (() => {}))({ evt: "escalation_held", shiftId: shift.id, releaseAt });
    return "quiet";
  }

  const p = await prepare(shift, deps);
  if (!("recipients" in p)) return p.result;
  const text = escalation({
    ...p.entry,
    deploymentZone: deps.settings.timeZone,
    formName: p.formName,
  });
  for (const recipient of p.recipients) {
    const claimKey = await claim(p, recipient, deps);
    if (!claimKey) continue;
    const sent = await deps.ct.sendDirectMessage(recipient, text);
    await settle(p, [claimKey], sent, deps, { recipient });
  }
  return finish(p, deps);
}

/**
 * Check for a submission once more, then read who gets the Escalation and
 * what it names. Returns the step's result instead when it stops here: a
 * submission was credited, or a call failed (retried with backoff).
 */
export async function prepare(shift: ShiftRow, deps: DueStepDeps, reads: Reads = {}): Promise<Prepared | { result: StepResult }> {
  const { store, ct, settings, now } = deps;
  const log = deps.log ?? (() => {});
  let name = "";
  const missed = (outcome: Undelivered["outcome"], status: number | null) =>
    undelivered(shift, "escalation", { name, outcome, status }, deps);
  const giveUp: GiveUp = async (status) => {
    await store.markEscalated(shift.id, now, missed("failed", status));
    log({ evt: "send_given_up", shiftId: shift.id, kind: "escalation", outcome: "failed", status });
    return "given_up";
  };

  const submitted = await checkSubmitted(shift, now, "escalation_check", deps, giveUp);
  if (submitted) return { result: submitted };

  const users = (reads.users ??= await ct.listActiveUsers());
  if (users.outcome !== "ok") return { result: await retry(shift, deps, { step: "users", ...users }, giveUp) };
  let employee = users.data.find((u) => u.userId === shift.userId) ?? null;
  if (!employee) {
    // Archived since the Shift: not in the active list.
    const one = await ct.getUser(shift.userId);
    if (one.outcome !== "ok") return { result: await retry(shift, deps, { step: "user", ...one }, giveUp) };
    employee = one.data ?? { userId: shift.userId, customFields: [] };
  }
  name = fullName(employee);
  const form = (reads.form ??= await ct.getForm(settings.complianceFormId));
  if (form.outcome !== "ok") return { result: await retry(shift, deps, { step: "form", ...form }, giveUp) };

  const recipients = escalationRecipients({ users: users.data, employee, excludedAdminIds: settings.excludedAdminIds });
  if (recipients.length === 0) log({ evt: "escalation_no_recipients", shiftId: shift.id });
  return {
    shift,
    recipients,
    formName: form.data.formName,
    entry: {
      fullName: name,
      userId: shift.userId,
      shift: { startSeconds: shift.startAt, endSeconds: shift.endAt!, timeZone: shift.startTz },
      remindedMinutesAgo: shift.remindedAt === null ? null : Math.floor((now - shift.remindedAt) / 60),
      ticked: await store.taskTicked(shift.id),
    },
    giveUp,
    missed,
    tally: { failed: null, owed: 0, busy: 0, stuck: 0 },
  };
}

/**
 * Claim one recipient's Escalation for this Shift. Returns the claim's key,
 * or `null` when it isn't to be sent: already done, stuck (a run died
 * mid-send, so never retried), or another run is mid-send.
 */
export async function claim(p: Prepared, recipient: number, deps: DueStepDeps): Promise<string | null> {
  const claimKey = `escalation:${p.shift.id}:${recipient}`;
  if (await deps.store.claimSend(claimKey, p.shift.id, deps.now)) return claimKey;
  const state = await deps.store.sendState(claimKey, deps.now);
  if (state === "stuck") p.tally.stuck++;
  else if (state !== "done") p.tally.busy++;
  return null;
}

/** A send for these claims came back: mark them done on `ok`, otherwise release them and count it owed. */
export async function settle(
  p: Prepared,
  claimKeys: string[],
  sent: { outcome: "ok" } | { outcome: "retryable" | "error"; status: number | null },
  deps: DueStepDeps,
  detail: Record<string, unknown>,
): Promise<void> {
  if (sent.outcome === "ok") {
    for (const k of claimKeys) await deps.store.markSendDone(k, deps.now);
    return;
  }
  for (const k of claimKeys) await deps.store.releaseSend(k);
  (deps.log ?? (() => {}))({ evt: "step_failed", shiftId: p.shift.id, step: "escalation", ...detail, ...sent });
  p.tally.failed = sent;
  p.tally.owed++;
}

/**
 * Once every recipient's send is done or given up on, the Shift is
 * escalated; a failed send retries the ones still owed after the next wait;
 * one another run is sending waits for the next run.
 */
export async function finish(p: Prepared, deps: DueStepDeps): Promise<StepResult> {
  const { shift, tally } = p;
  if (tally.failed) return retry(shift, deps, { step: "escalation", owed: tally.owed, status: tally.failed.status }, p.giveUp);
  if (tally.busy > 0) return skip(shift, deps);
  await deps.store.markEscalated(shift.id, deps.now, tally.stuck > 0 ? p.missed("unconfirmed", null) : null);
  if (tally.stuck > 0) {
    (deps.log ?? (() => {}))({ evt: "send_given_up", shiftId: shift.id, kind: "escalation", outcome: "unconfirmed", stuck: tally.stuck });
  }
  return "escalated";
}
