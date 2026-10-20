/**
 * The `form_submission` webhook (#3, #26): feature type `forms`. The payload
 * is an envelope (`requestId`, `activityType: "forms"`, `eventType`) with the
 * submission in `data`, the same fields as `GET .../form-submissions`.
 * Parsing is pure; the route credits the result.
 */
import type { FormAnswer, FormSubmission } from "../connecteam/types.js";

export type FormSubmissionDelivery =
  | { kind: "submission"; dedupeKey: string; eventType: string; userId: number; submission: FormSubmission }
  /** Verified and recorded, but not an event this build acts on (an edit keeps its submitted time). */
  | { kind: "ignored"; dedupeKey: string; eventType: string; userId: number | null }
  | { kind: "malformed" };

export function isFormsDelivery(payload: unknown): boolean {
  return asObject(payload)?.activityType === "forms";
}

export function parseFormSubmissionDelivery(payload: unknown): FormSubmissionDelivery {
  const o = asObject(payload);
  if (!o || typeof o.eventType !== "string") return { kind: "malformed" };
  const d = asObject(o.data);
  const eventType = o.eventType;
  const userId = typeof d?.submittingUserId === "number" ? d.submittingUserId : null;
  const id = typeof d?.formSubmissionId === "string" ? d.formSubmissionId : "";
  const dedupeKey = [String(o.requestId ?? ""), eventType, String(userId ?? ""), id].join("|");

  if (eventType !== "form_submission") return { kind: "ignored", dedupeKey, eventType, userId };
  if (!d || !id || userId === null || typeof d.formId !== "number" || typeof d.submissionTimestamp !== "number") {
    return { kind: "malformed" };
  }

  const submission: FormSubmission = {
    formSubmissionId: id,
    formId: d.formId,
    submissionTimestamp: d.submissionTimestamp,
    submittingUserId: userId,
    answers: Array.isArray(d.answers) ? (d.answers.filter((a) => asObject(a)) as FormAnswer[]) : [],
  };
  if (typeof d.submissionTimezone === "string") submission.submissionTimezone = d.submissionTimezone;
  return { kind: "submission", dedupeKey, eventType, userId, submission };
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
