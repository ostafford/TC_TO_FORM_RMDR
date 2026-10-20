/*
 * Copied from EH_Webhook (~/IDP/EH_Webhook/src/connecteam/types.ts at 0c5ec92)
 * and adapted: EH_Webhook's onboarding and pay-rate shapes are dropped, and the
 * time-activity, form and form-submission shapes this project needs are added.
 * Never import it from the sibling project.
 */

export interface ConnecteamCustomFieldValue {
  customFieldId: number;
  value: unknown;
  type: string;
  name: string;
}

export interface ConnecteamUser {
  userId: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  phoneNumber?: string;
  userType?: string;
  isArchived?: boolean;
  modifiedAt?: number;
  customFields: ConnecteamCustomFieldValue[];
}

export interface Conversation {
  id: string;
  title: string;
  type: string;
}

/** A clock punch: Unix seconds plus the IANA zone it was recorded in. */
export interface Punch {
  timestamp: number;
  timezone: string;
}

/**
 * One Shift Segment as Connecteam sends it, on the `time_activity` webhook and
 * on `GET .../time-activities`. Two additions over sch_import's type (#6):
 * `end` is absent while the segment is open, and `schedulerShiftId` links it to
 * a Scheduled Shift (absent when there is none). Keep the id a string.
 */
export interface TimeActivity {
  id: string;
  start: Punch;
  end?: Punch;
  schedulerShiftId?: string;
  isAutoClockOut?: boolean;
}

/** `GET /forms/v1/forms/{formId}`, the fields this project reads. */
export interface Form {
  formId: number;
  formName: string;
}

/** One row of `GET /forms/v1/forms/{formId}/form-submissions`. */
export interface FormSubmission {
  formSubmissionId: string;
  formId: number;
  /** When it was submitted (Unix seconds), not when the form was opened. */
  submissionTimestamp: number;
  submittingUserId: number;
}

export interface RateLimit {
  minuteRemaining: number | null;
  minuteLimit: number | null;
  dayRemaining: number | null;
}

export type CtResult<T> =
  | { outcome: "ok"; data: T }
  | { outcome: "retryable"; status: number | null; detail: string }
  | { outcome: "error"; status: number; detail: string };
