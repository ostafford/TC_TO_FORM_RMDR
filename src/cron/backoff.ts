/**
 * Backoff and giving up, for a failing step (#33). A send that fails (a 429,
 * 5xx, timeout, or any other non-ok answer), or a call it needs first, is
 * tried again on a later cron run after doubling waits, by moving that step's
 * own due time, so the Shift's other steps carry on as scheduled. After the
 * last wait, about an hour in, a send is given up on and listed in a Failure
 * Alert.
 */
import type { SendKind, ShiftRow, Undelivered } from "../store.js";

/** The waits between tries, in minutes: 1 + 2 + 4 + 8 + 16 + 32 = 63, about an hour. */
export const BACKOFF_MINUTES = [1, 2, 4, 8, 16, 32] as const;

/**
 * The wait in seconds before the next try, after a step's `failures`th
 * failure in a row, or `null` once the waits are used up: give up.
 */
export function retryWait(failures: number): number | null {
  const minutes = BACKOFF_MINUTES[failures - 1];
  return minutes === undefined ? null : minutes * 60;
}

/** The longest wait: a step that is never given up on keeps trying at this pace. */
export const LONGEST_WAIT_SECONDS = Math.max(...BACKOFF_MINUTES) * 60;

/** A send given up on, for the Failure Alerts to list. */
export function undelivered(
  shift: Pick<ShiftRow, "id" | "userId" | "startAt" | "startTz" | "failingSince">,
  kind: SendKind,
  f: { name: string; outcome: Undelivered["outcome"]; status: number | null; alert?: Undelivered["alert"] },
  deps: { now: number },
): Undelivered {
  return {
    sendKey: `${kind}:${shift.id}`,
    kind,
    userId: shift.userId,
    name: f.name,
    shiftStart: shift.startAt,
    shiftTz: shift.startTz,
    outcome: f.outcome,
    alert: f.alert ?? "messages",
    status: f.status,
    failingSince: shift.failingSince ?? deps.now,
    givenUpAt: deps.now,
  };
}

/** "Jordan Lee", or blank when Connecteam has no name: who a send given up on was for. */
export function fullName(user: { firstName?: string; lastName?: string } | null): string {
  return [user?.firstName, user?.lastName].filter(Boolean).join(" ");
}
