/**
 * The Escalation Summary (#16, #29): once Quiet Hours are over, every
 * Escalation held through them goes out together, one Summary per recipient
 * of everything held for them, split only past 500 characters.
 *
 * Each held Shift is prepared as at the escalation point (./escalate.ts): the
 * check for a submission once more (a submission credited meanwhile drops it
 * from the Summary), then its recipients, read live. The users and the form
 * are read once for all of them. Each (Shift, recipient) keeps its own
 * `escalation:` claim, so a Summary goes only to whoever is still owed that
 * Shift, and a Shift is escalated once all its recipients have it. A Summary
 * that fails is retried with backoff (#33), only to those still owed.
 */
import { escalationSummaries } from "../messages/escalation.js";
import type { DueStepDeps } from "./dueSteps.js";
import { claim, finish, prepare, quietUntil, settle, type Prepared, type Reads } from "./escalate.js";
import type { StepResult } from "./steps.js";

/** The most held Shifts one run takes. */
const SUMMARY_BATCH = 100;

export async function runSummaries(deps: DueStepDeps): Promise<Partial<Record<StepResult, number>> & { summaries: number }> {
  const counts: Partial<Record<StepResult, number>> & { summaries: number } = { summaries: 0 };
  const count = (r: StepResult) => (counts[r] = (counts[r] ?? 0) + 1);
  // Still quiet (or quiet again, if the settings changed): they wait.
  if (quietUntil(deps) !== null) return counts;

  const reads: Reads = {};
  const ready: Prepared[] = [];
  for (const shift of await deps.store.takeHeld(deps.now, SUMMARY_BATCH)) {
    if (deps.ct.stopped()) {
      await deps.store.release(shift.id);
      count("deferred");
      continue;
    }
    const p = await prepare(shift, deps, reads);
    if ("recipients" in p) ready.push(p);
    else count(p.result);
  }

  const byRecipient = new Map<number, Prepared[]>();
  for (const p of ready) for (const r of p.recipients) byRecipient.set(r, [...(byRecipient.get(r) ?? []), p]);

  const formName = ready[0]?.formName ?? "";
  for (const [recipient, held] of byRecipient) {
    const claimed: { p: Prepared; claimKey: string }[] = [];
    for (const p of held) {
      // Stopped for the minute (#31): this recipient waits for the next run.
      if (deps.ct.stopped()) {
        p.tally.busy++;
        continue;
      }
      const claimKey = await claim(p, recipient, deps);
      if (claimKey) claimed.push({ p, claimKey });
    }
    const messages = escalationSummaries({
      formName,
      deploymentZone: deps.settings.timeZone,
      entries: claimed.map((c) => c.p.entry),
    });
    for (const m of messages) {
      const these = claimed.filter((c) => m.entries.includes(c.p.entry));
      const sent = await deps.ct.sendDirectMessage(recipient, m.text);
      for (const c of these) await settle(c.p, [c.claimKey], sent, deps, { recipient, summary: true });
      if (sent.outcome === "ok") counts.summaries++;
    }
  }

  for (const p of ready) count(await finish(p, deps));
  return counts;
}
