/**
 * Credit one Compliance Form submission to a Shift (#26), whichever way it
 * arrived: the `form_submission` webhook, or a `form-submissions` check at the
 * end of a Grace Period or the escalation point. One submission counts for at
 * most one Shift, so a submission already credited stays where it is.
 */
import type { FormSubmission } from "../connecteam/types.js";
import type { WorkList } from "../store.js";
import { chooseShift, type CreditRules } from "./choose.js";

/** How often to choose again after losing a race to another credit. */
const ATTEMPTS = 3;

/**
 * The Shift the submission counts for (just now, or already), or `null` when
 * none needs it. A Shift credited just now has its Reminder Task due `now`.
 */
export async function creditSubmission(
  store: WorkList,
  submission: FormSubmission,
  rules: CreditRules,
  now: number,
): Promise<string | null> {
  for (let i = 0; i < ATTEMPTS; i++) {
    const already = await store.creditedTo(submission.formSubmissionId);
    if (already) return already;
    const target = chooseShift(submission, await store.creditCandidates(submission.submittingUserId), rules);
    if (!target) return null;
    if (await store.credit(target, submission.formSubmissionId, now)) return target;
  }
  return null;
}
