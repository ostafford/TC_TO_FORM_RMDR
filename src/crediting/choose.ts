/**
 * Which Shift a Compliance Form submission is credited to (#26). A submission
 * has no Shift id, only who submitted and when (#3), so the order is:
 *  1. the Shift on the date the Shift Date Question names, if one is
 *     configured and a Shift on that date still needs a form;
 *  2. the Shift the submission was made during, or within the Grace Period of;
 *  3. the user's oldest outstanding Missed Form.
 * A date matching no Shift that needs a form falls back to 2, then 3. Pure, so
 * the order is tested without a Worker.
 */
import type { FormSubmission } from "../connecteam/types.js";

/** A Shift that still needs a form: not credited, not deleted, not too late. */
export interface CreditCandidate {
  id: string;
  startAt: number;
  startTz: string;
  /** The end of the Grace Period; `null` while the Shift is open. */
  graceEndsAt: number | null;
  status: "open" | "grace" | "reminded" | "escalated";
  /** The form ids that count for this Shift (#17). */
  formIds: number[];
}

export interface CreditRules {
  /** The Shift Date Question's id, or blank when none is configured. */
  shiftDateQuestionId: string;
  /** Only a submission of the current Compliance Form is matched by its date (#17). */
  complianceFormId: number;
  /** Used when an answer carries no time zone. */
  deploymentZone: string;
}

export function chooseShift(
  submission: FormSubmission,
  candidates: CreditCandidate[],
  rules: CreditRules,
): string | null {
  const open = candidates
    .filter((c) => c.formIds.includes(submission.formId))
    .sort((a, b) => a.startAt - b.startAt);

  if (rules.shiftDateQuestionId && submission.formId === rules.complianceFormId) {
    const date = answeredDate(submission, rules);
    const onDate = date ? open.find((c) => dayOf(c.startAt, c.startTz) === date) : undefined;
    if (onDate) return onDate.id;
  }

  const t = submission.submissionTimestamp;
  const during = open.find((c) => c.startAt <= t && (c.graceEndsAt === null || t <= c.graceEndsAt));
  if (during) return during.id;

  const missed = open.find((c) => c.status === "reminded" || c.status === "escalated");
  return missed?.id ?? null;
}

/** The Shift Date Question's answer as "YYYY-MM-DD", or `null` when it wasn't answered with a date. */
export function answeredDate(submission: FormSubmission, rules: CreditRules): string | null {
  const a = submission.answers?.find((x) => x.questionId === rules.shiftDateQuestionId && x.questionType === "datetime");
  if (!a || a.wasSubmittedEmpty || a.isDateSubmitted === false || typeof a.timestamp !== "number") return null;
  for (const zone of [a.timezone, submission.submissionTimezone, rules.deploymentZone]) {
    if (!zone) continue;
    try {
      return dayOf(a.timestamp, zone);
    } catch {
      // Not a zone Intl knows: try the next.
    }
  }
  return null;
}

/** The calendar day of a moment in a zone, as "YYYY-MM-DD". */
function dayOf(seconds: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(seconds * 1000),
  );
}
