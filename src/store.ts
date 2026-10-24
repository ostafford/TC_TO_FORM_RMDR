/**
 * The D1 work list (ADR-0002, migrations/0001_init.sql). All times are Unix
 * seconds.
 */
import type { TimeActivity } from "./connecteam/types.js";
import type { CreditCandidate } from "./crediting/choose.js";
import type { AlertCondition, GoneSetting, SendKind } from "./messages/failureAlert.js";

/**
 * open: no end yet, or on a manual break. grace: waiting for the Grace Period to end. submitted: a
 * submission was found in time. reminded: the Reminder went out; the
 * escalation point is due. escalated: the Escalation went out. too_late: first
 * known more than 24 hours after it ended, so never checked.
 */
export type ShiftStatus = "open" | "grace" | "submitted" | "reminded" | "escalated" | "too_late";

export interface ShiftRow {
  id: string;
  userId: number;
  startAt: number;
  startTz: string;
  endAt: number | null;
  formIds: number[];
  graceEndsAt: number | null;
  status: ShiftStatus;
  /** `null` before the Reminder, and when it was given up on (#33): never sent, or unconfirmed. */
  remindedAt: number | null;
  /** The due step's failures in a row (#33). */
  attempts: number;
  /** When the first of those failures happened, or `null`. */
  failingSince: number | null;
}

/** A manual break, as the `time_activity` webhook sends it (#23), or as the sweep reads it (#32). */
export interface BreakWrite {
  /** `null` when the sweep found it: no webhook delivery to record. */
  dedupeKey: string | null;
  eventType: string;
  userId: number;
  activity: TimeActivity;
}

export interface SegmentWrite {
  /** `null` when the sweep found it: no webhook delivery to record. */
  dedupeKey: string | null;
  eventType: string;
  userId: number;
  timeClockId: number | null;
  activity: TimeActivity;
}

/** How long a cron run holds the Shifts it took. Longer than any one run. */
const LEASE_SECONDS = 5 * 60;

/** The statuses of a Shift not yet checked: its times still follow its segments and breaks. */
const UNCHECKED = "'open', 'grace'";

/** How many merges one write may make across breaks: a Shift with this many breaks resumed out of order. */
const MAX_JOINS = 10;

/** The statuses of a Shift that still needs a form. */
const NEEDS_FORM = "'open', 'grace', 'reminded', 'escalated'";

/** Open Reminder Tasks are re-checked this often after the Escalation. */
export const TASK_RECHECK_SECONDS = 60 * 60;

/** A Reminder Task still open this long after its Shift ended is deleted. */
export const TASK_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

/** A Reminder Task with a step still to do: not created yet, or open. */
const TASK_ACTIVE = "'pending', 'open'";

/**
 * An open Reminder Task's next step, read from its Shift as it is when the row
 * is written (`?1` is now, `?2` the Shift's id), so a credit, delete, tick or
 * Escalation that lands mid-step is never overwritten: at once if the Shift was
 * credited or deleted or the task ticked, hourly once escalated, otherwise the
 * 7-day deletion. Used only in an `UPDATE reminder_tasks`.
 */
const TASK_NEXT_DUE = `(SELECT CASE
    WHEN s.deleted_at IS NOT NULL OR s.status = 'submitted' OR reminder_tasks.tick = 'ticked' THEN ?1
    WHEN s.status = 'escalated' THEN MIN(?1 + ${TASK_RECHECK_SECONDS}, s.end_at + ${TASK_LIFETIME_SECONDS})
    ELSE s.end_at + ${TASK_LIFETIME_SECONDS} END
  FROM shifts s WHERE s.id = ?2)`;

export interface ReminderTaskRow {
  shiftId: string;
  boardId: string;
  /** `null` until created; then its id and the fields the close `PUT` sends again. */
  task: { id: string; title: string; userIds: number[]; description: string } | null;
  /** ticked: the employee ticked it without submitting, and reopening it is due. reopened: done once. */
  tick: "ticked" | "reopened" | null;
  /** The task's Shift as it is now, deleted or not. */
  shift: ShiftRow & { deleted: boolean };
  /** The task's due step's failures in a row, and when the first happened (#33). */
  attempts: number;
  failingSince: number | null;
}

/** A send claim held this long belongs to a run that died mid-send: it's never retried (ADR-0002, #33). */
export const STUCK_CLAIM_SECONDS = 10 * 60;

/** The state of a send's claim. stuck: claimed more than {@link STUCK_CLAIM_SECONDS} ago and never done. */
export type SendState = "claimed" | "stuck" | "done" | null;

export type { SendKind };

/**
 * A send given up on (#33): it kept failing for about an hour (`failed`), or
 * its claim was stuck (`unconfirmed`: it may have gone out), or it was more
 * than an hour overdue when a block lifted (`skipped`, #34).
 */
export interface Undelivered {
  /** `<kind>:<shiftId>`: one per send and Shift. */
  sendKey: string;
  kind: SendKind;
  /** The employee the send was for, or about. */
  userId: number;
  /** Their full name, or blank when it wasn't known. */
  name: string;
  shiftStart: number;
  shiftTz: string;
  outcome: "failed" | "unconfirmed" | "skipped";
  /** The condition whose all clear lists it: `messages`, or the block it was skipped after. */
  alert: AlertCondition;
  /** The last failure's HTTP status; `null` for a timeout, a stuck claim or a skip. */
  status: number | null;
  failingSince: number;
  givenUpAt: number;
}

/**
 * What stops work until the client fixes it (#34): a rejected API key, or a
 * Compliance Form, custom publisher or task board that's gone.
 */
export type Block = "key" | GoneSetting;

export interface BlockRow {
  block: Block;
  since: number;
  /** The setting's value when it was found gone; `null` for the key. */
  setting: string | null;
  checkedAt: number;
}

export type { AlertCondition };

/**
 * Small values the Worker keeps (worker_state): the sweep's (#32), when its
 * reads started failing and the last failure's status (#33), the daily
 * allowance left (#34), and when the last check-in went to the relay (#36).
 */
export type StateKey =
  | "clocks_listed_at"
  | "day_limit"
  | "read_failing_since"
  | "read_failing_status"
  | "day_remaining"
  | "checked_in_at";

/** What the lost-webhook alert reads (#34). */
export interface WebhookHealth {
  /** When the last webhook delivery arrived, or `null` for never. */
  lastDelivery: number | null;
  /** Shift Segments the sweep found that no webhook told us of, in the window. */
  missed: number;
  /** Whether any Shift Segment started or ended in the window. */
  activity: boolean;
  /** When the first Shift was recorded: how long the Deployment has been watching. */
  watchingSince: number | null;
}

/** A Shift first known more than this long after its recorded end is never checked. */
export const BACKFILL_CUTOFF_SECONDS = 24 * 60 * 60;

export class WorkList {
  constructor(private readonly db: D1Database) {}

  /** Record a delivery that isn't a Shift Segment, for de-duplication and last-seen. */
  async recordDelivery(d: { dedupeKey: string; eventType: string; userId: number | null }, now: number): Promise<void> {
    await this.#delivery(d, now).run();
  }

  /**
   * Record a Shift Segment from any saved-record event (#22): a clock-in, a
   * clock-out of any kind, an admin add or edit, or an approved request. One
   * atomic batch, and safe to repeat.
   *
   * - The segment maps to its Shift by id. An unknown id with the same user and
   *   first clock-in as a known Shift is that Shift recreated under a new id (a
   *   geofence approval deletes and recreates the record), and maps back to it.
   *   So does an unknown id starting inside a Shift already checked: a break an
   *   Admin added later split the record, and nothing announces the break
   *   itself (tested live 2026-10-21, #23).
   * - A segment resuming from a manual break joins the Shift the break started
   *   from (ADR-0001), whichever arrives first.
   * - The segment's times are saved as sent, so an edit replaces them.
   * - A Shift not yet checked (`open` or `grace`) takes its times from its
   *   segments and breaks, and once it has an end, its Grace Period is timed
   *   from that end. An edit before the check moves the Grace Period with it.
   * - A Shift already checked (`submitted`, `reminded`, `escalated`, `too_late`) keeps its
   *   status and schedule: an edit never starts a second check.
   * - A Shift first known more than 24 hours after its recorded end is
   *   `too_late` and never checked (a fixed rule, not a setting).
   */
  async recordSegment(w: SegmentWrite, opts: { formIds: number[]; gracePeriodMinutes: number; now: number }): Promise<void> {
    const a = w.activity;
    const known = await this.db
      .prepare(
        `SELECT shift_id AS id, 0 AS rank FROM shift_segments WHERE time_activity_id = ?1
         UNION ALL
         SELECT id, 1 AS rank FROM shifts WHERE user_id = ?2 AND start_at = ?3
         UNION ALL
         SELECT id, 2 AS rank FROM shifts
         WHERE user_id = ?2 AND status NOT IN (${UNCHECKED}) AND start_at < ?3 AND ?3 < end_at
         ORDER BY rank LIMIT 1`,
      )
      .bind(a.id, w.userId, a.start.timestamp)
      .first<{ id: string }>();
    const shiftId = known?.id ?? a.id;
    const endAt = a.end?.timestamp ?? null;
    const graceSeconds = opts.gracePeriodMinutes * 60;

    await this.db.batch([
      ...this.#deliveryOf(w, opts.now),
      this.db
        .prepare(
          `INSERT INTO shifts (id, user_id, time_clock_id, start_at, start_tz, scheduler_shift_id, form_ids, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
           ON CONFLICT (id) DO NOTHING`,
        )
        .bind(
          shiftId,
          w.userId,
          w.timeClockId,
          a.start.timestamp,
          a.start.timezone,
          a.schedulerShiftId ?? null,
          JSON.stringify(opts.formIds),
          opts.now,
        ),
      // A saved record means the Shift exists again, if a delete got there first.
      this.db.prepare("UPDATE shifts SET deleted_at = NULL WHERE id = ?").bind(shiftId),
      this.db
        .prepare(
          `INSERT INTO shift_segments (time_activity_id, shift_id, start_at, end_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (time_activity_id) DO UPDATE SET
             start_at = excluded.start_at, end_at = COALESCE(excluded.end_at, shift_segments.end_at)`,
        )
        .bind(a.id, shiftId, a.start.timestamp, endAt),
      ...this.#refreshTimes(shiftId, graceSeconds),
    ]);
    await this.#joinAcrossBreaks(w.userId, graceSeconds);
  }

  /**
   * Record a manual break (#23): started, ended, added or edited. The Shift
   * whose last segment ends exactly where it starts stays open while it's
   * open, and ends at its end if no segment resumes there (ADR-0001). One
   * atomic batch, and safe to repeat.
   */
  async recordBreak(w: BreakWrite, opts: { gracePeriodMinutes: number; now: number }): Promise<void> {
    const a = w.activity;
    const from = await this.#shiftEndingAt(w.userId, a.start.timestamp);
    const graceSeconds = opts.gracePeriodMinutes * 60;
    await this.db.batch([
      ...this.#deliveryOf(w, opts.now),
      this.db
        .prepare(
          `INSERT INTO manual_breaks (time_activity_id, user_id, start_at, end_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (time_activity_id) DO UPDATE SET
             start_at = excluded.start_at, end_at = COALESCE(excluded.end_at, manual_breaks.end_at)`,
        )
        .bind(a.id, w.userId, a.start.timestamp, a.end?.timestamp ?? null),
      ...(from ? this.#refreshTimes(from, graceSeconds) : []),
    ]);
    await this.#joinAcrossBreaks(w.userId, graceSeconds);
  }

  /**
   * A manual break was deleted: the Shift it started from no longer runs
   * through it. A break never recorded changes nothing.
   */
  async deleteBreak(
    d: { dedupeKey: string; eventType: string; userId: number | null; timeActivityId: string },
    opts: { gracePeriodMinutes: number; now: number },
  ): Promise<void> {
    const known = await this.db
      .prepare("SELECT user_id, start_at FROM manual_breaks WHERE time_activity_id = ?")
      .bind(d.timeActivityId)
      .first<{ user_id: number; start_at: number }>();
    const from = known ? await this.#shiftEndingAt(known.user_id, known.start_at) : null;
    await this.db.batch([
      this.#delivery(d, opts.now),
      this.db.prepare("DELETE FROM manual_breaks WHERE time_activity_id = ?").bind(d.timeActivityId),
      ...(from ? this.#refreshTimes(from, opts.gracePeriodMinutes * 60) : []),
    ]);
  }

  /** The user's Shift with a segment ending exactly at `at`, or `null`. */
  async #shiftEndingAt(userId: number, at: number): Promise<string | null> {
    const r = await this.db
      .prepare(
        `SELECT ss.shift_id FROM shift_segments ss JOIN shifts s ON s.id = ss.shift_id
         WHERE s.user_id = ? AND ss.end_at = ? LIMIT 1`,
      )
      .bind(userId, at)
      .first<{ shift_id: string }>();
    return r?.shift_id ?? null;
  }

  /**
   * Join Shifts across the user's manual breaks (ADR-0001): a Shift with a
   * segment starting exactly where a break ends belongs to the Shift with a
   * segment ending exactly where that break starts. Deliveries can arrive in
   * any order, so this runs after every write. Only a Shift not yet checked is
   * folded in; it has had no sends, so nothing hangs off its row.
   */
  async #joinAcrossBreaks(userId: number, graceSeconds: number): Promise<void> {
    for (let i = 0; i < MAX_JOINS; i++) {
      const pair = await this.db
        .prepare(
          `SELECT before.shift_id AS keep, after.shift_id AS fold
           FROM manual_breaks b
           JOIN shift_segments before ON before.end_at = b.start_at
           JOIN shifts kept ON kept.id = before.shift_id AND kept.user_id = b.user_id AND kept.deleted_at IS NULL
           JOIN shift_segments after ON after.start_at = b.end_at
           JOIN shifts folded ON folded.id = after.shift_id AND folded.user_id = b.user_id
           WHERE b.user_id = ? AND folded.id != kept.id AND folded.status IN (${UNCHECKED})
             AND folded.credited_submission_id IS NULL AND folded.deleted_at IS NULL
           ORDER BY b.start_at LIMIT 1`,
        )
        .bind(userId)
        .first<{ keep: string; fold: string }>();
      if (!pair) return;
      await this.db.batch([
        this.db.prepare("UPDATE shift_segments SET shift_id = ? WHERE shift_id = ?").bind(pair.keep, pair.fold),
        this.db.prepare("DELETE FROM shifts WHERE id = ?").bind(pair.fold),
        ...this.#refreshTimes(pair.keep, graceSeconds),
      ]);
    }
  }

  /**
   * A Shift not yet checked takes its times from its segments and breaks
   * (ADR-0001): it starts at its first clock-in, and it ends
   *  - never while a segment is open, or while a break it ran into is open;
   *  - at the end of a break its last segment ran into, when nothing resumed;
   *  - otherwise at its last segment's end.
   * Once it has an end, its Grace Period is timed from that end; a Shift
   * already in its Grace Period keeps the length it was given. One that loses
   * its end (a break started) is open again, with nothing due.
   */
  #refreshTimes(shiftId: string, graceSeconds: number): D1PreparedStatement[] {
    const grace = `CASE WHEN shifts.status = 'grace' THEN shifts.grace_ends_at - shifts.end_at ELSE ?2 END`;
    return [
      this.db
        .prepare(
          `UPDATE shifts SET start_at = s.start_at
           FROM (SELECT MIN(start_at) AS start_at FROM shift_segments WHERE shift_id = ?1) AS s
           WHERE shifts.id = ?1 AND shifts.status IN (${UNCHECKED}) AND s.start_at IS NOT NULL`,
        )
        .bind(shiftId),
      this.db
        .prepare(
          `UPDATE shifts SET
             end_at = r.end_at,
             grace_ends_at = r.end_at + ${grace},
             due_at = CASE WHEN r.end_at IS NULL OR shifts.created_at - r.end_at > ?3 THEN NULL ELSE r.end_at + ${grace} END,
             status = CASE WHEN r.end_at IS NULL THEN 'open' WHEN shifts.created_at - r.end_at > ?3 THEN 'too_late' ELSE 'grace' END
           FROM (
             SELECT CASE
                      WHEN EXISTS (SELECT 1 FROM shift_segments WHERE shift_id = ?1 AND end_at IS NULL) THEN NULL
                      WHEN b.time_activity_id IS NOT NULL THEN b.end_at
                      ELSE seg.last_end END AS end_at
             FROM (SELECT MAX(end_at) AS last_end FROM shift_segments WHERE shift_id = ?1) AS seg
             LEFT JOIN manual_breaks b
               ON b.start_at = seg.last_end AND b.user_id = (SELECT user_id FROM shifts WHERE id = ?1)
           ) AS r
           WHERE shifts.id = ?1 AND shifts.status IN (${UNCHECKED})
             AND EXISTS (SELECT 1 FROM shift_segments WHERE shift_id = ?1)`,
        )
        .bind(shiftId, graceSeconds, BACKFILL_CUTOFF_SECONDS),
    ];
  }

  /**
   * A Shift Segment was deleted (`admin_delete`, or an approved delete
   * request). A Shift not yet checked takes its times from the segments left
   * (a geofence approval's recreated record may be the only one closed). Once
   * a Shift has no segments left, its pending steps are cancelled: the cron
   * skips it while `deleted_at` is set. A segment that was never recorded
   * changes nothing.
   */
  async deleteSegment(
    d: { dedupeKey: string; eventType: string; userId: number | null; timeActivityId: string },
    opts: { gracePeriodMinutes: number; now: number },
  ): Promise<void> {
    const now = opts.now;
    const known = await this.db
      .prepare("SELECT shift_id FROM shift_segments WHERE time_activity_id = ?")
      .bind(d.timeActivityId)
      .first<{ shift_id: string }>();
    if (!known) {
      await this.#delivery(d, now).run();
      return;
    }
    await this.db.batch([
      this.#delivery(d, now),
      this.db.prepare("DELETE FROM shift_segments WHERE time_activity_id = ?").bind(d.timeActivityId),
      ...this.#refreshTimes(known.shift_id, opts.gracePeriodMinutes * 60),
      this.db
        .prepare(
          `UPDATE shifts SET deleted_at = ?
           WHERE id = ? AND NOT EXISTS (SELECT 1 FROM shift_segments WHERE shift_id = shifts.id)`,
        )
        .bind(now, known.shift_id),
      // A deleted Shift's Reminder Task is deleted at once (or never created).
      this.db
        .prepare(
          `UPDATE reminder_tasks SET due_at = ?1
           WHERE shift_id = ?2 AND state IN (${TASK_ACTIVE})
             AND EXISTS (SELECT 1 FROM shifts WHERE id = ?2 AND deleted_at IS NOT NULL)`,
        )
        .bind(now, known.shift_id),
    ]);
  }

  /**
   * Lease up to `limit` Shifts whose next step is due, oldest due first. A
   * Shift another run holds is skipped, so overlapping runs never work the
   * same Shift, and so is a deleted one.
   */
  async takeDue(now: number, limit: number): Promise<ShiftRow[]> {
    const due = await this.db
      .prepare(
        `SELECT * FROM shifts WHERE due_at <= ? AND deleted_at IS NULL AND (lease_until IS NULL OR lease_until <= ?)
         ORDER BY due_at LIMIT ?`,
      )
      .bind(now, now, limit)
      .all<Record<string, unknown>>();

    const taken: ShiftRow[] = [];
    for (const r of due.results) {
      const lease = await this.db
        .prepare("UPDATE shifts SET lease_until = ? WHERE id = ? AND (lease_until IS NULL OR lease_until <= ?)")
        .bind(now + LEASE_SECONDS, r.id, now)
        .run();
      if (lease.meta.changes === 1) taken.push(toShift(r));
    }
    return taken;
  }

  /** Let the next run try this Shift again. */
  async release(shiftId: string): Promise<void> {
    await this.db.prepare("UPDATE shifts SET lease_until = NULL WHERE id = ?").bind(shiftId).run();
  }

  /**
   * The user's Shifts that still need a form, for crediting (#26): open, in
   * their Grace Period, or a Missed Form (reminded or escalated), not deleted
   * and not yet credited.
   */
  async creditCandidates(userId: number): Promise<CreditCandidate[]> {
    const rows = await this.db
      .prepare(
        `SELECT id, start_at, start_tz, grace_ends_at, status, form_ids FROM shifts
         WHERE user_id = ? AND status IN (${NEEDS_FORM}) AND deleted_at IS NULL AND credited_submission_id IS NULL`,
      )
      .bind(userId)
      .all<Record<string, unknown>>();
    return rows.results.map((r) => ({
      id: String(r.id),
      startAt: Number(r.start_at),
      startTz: String(r.start_tz),
      graceEndsAt: r.grace_ends_at === null ? null : Number(r.grace_ends_at),
      status: r.status as CreditCandidate["status"],
      formIds: JSON.parse(String(r.form_ids)) as number[],
    }));
  }

  /** The Shift this submission is already credited to, or `null`. */
  async creditedTo(formSubmissionId: string): Promise<string | null> {
    const r = await this.db
      .prepare("SELECT id FROM shifts WHERE credited_submission_id = ?")
      .bind(formSubmissionId)
      .first<{ id: string }>();
    return r?.id ?? null;
  }

  /**
   * Credit a submission to a Shift: it's submitted, and nothing more is due
   * (no Reminder, no Escalation). Returns `false`, changing nothing, when the
   * Shift no longer needs a form or the submission already counts for another.
   * Its Reminder Task, if any, is due `now` to be closed.
   */
  async credit(shiftId: string, formSubmissionId: string, now: number): Promise<boolean> {
    const [r] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE shifts SET status = 'submitted', due_at = NULL, lease_until = NULL, credited_submission_id = ?1,
             attempts = 0, failing_since = NULL
           WHERE id = ?2 AND status IN (${NEEDS_FORM}) AND deleted_at IS NULL AND credited_submission_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM shifts WHERE credited_submission_id = ?1)`,
        )
        .bind(formSubmissionId, shiftId),
      this.db
        .prepare(
          `UPDATE reminder_tasks SET due_at = ?1
           WHERE shift_id = ?2 AND state IN (${TASK_ACTIVE})
             AND EXISTS (SELECT 1 FROM shifts WHERE id = ?2 AND credited_submission_id = ?3)`,
        )
        .bind(now, shiftId, formSubmissionId),
    ]);
    return r!.meta.changes === 1;
  }

  /**
   * Claim a send before it goes out. Returns `true` when this caller holds the
   * claim; `false` when it is already claimed or done, so the send must not go.
   */
  async claimSend(claimKey: string, shiftId: string, now: number): Promise<boolean> {
    const r = await this.db
      .prepare("INSERT OR IGNORE INTO send_claims (claim_key, shift_id, state, claimed_at) VALUES (?, ?, 'claimed', ?)")
      .bind(claimKey, shiftId, now)
      .run();
    return r.meta.changes === 1;
  }

  /**
   * The claim's state at `now`, or `null` when nothing holds it. A claim held
   * for more than {@link STUCK_CLAIM_SECONDS} is `stuck`: the run that took it
   * died mid-send, so whether it went out is unknown, and it's never retried.
   */
  async sendState(claimKey: string, now: number): Promise<SendState> {
    const r = await this.db
      .prepare("SELECT state, claimed_at FROM send_claims WHERE claim_key = ?")
      .bind(claimKey)
      .first<{ state: "claimed" | "done"; claimed_at: number }>();
    if (!r) return null;
    return r.state === "claimed" && r.claimed_at <= now - STUCK_CLAIM_SECONDS ? "stuck" : r.state;
  }

  /** A send failed: drop its claim so a later run can try again. */
  async releaseSend(claimKey: string): Promise<void> {
    await this.db.prepare("DELETE FROM send_claims WHERE claim_key = ? AND state = 'claimed'").bind(claimKey).run();
  }

  /**
   * The Reminder went out (`outcome === "ok"`): mark its claim done, and make
   * the escalation point due `escalateAt`. With the Reminder Task on, its
   * creation is due at once, on the board set now.
   */
  async markReminded(
    shiftId: string,
    claimKey: string,
    now: number,
    escalateAt: number,
    reminderTask: { boardId: string } | null,
  ): Promise<void> {
    await this.db.batch([this.#sendDone(claimKey, now), ...this.#reminded(shiftId, now, now, escalateAt, reminderTask)]);
  }

  /**
   * The Reminder was given up on (#33): it kept failing, or its claim was
   * stuck. The Shift's other steps carry on as if it had gone out: the
   * escalation point is due `escalateAt`, and the Reminder Task, if on, is due
   * at once. `reminded_at` stays `null`, so the Escalation says so.
   */
  async giveUpReminder(
    shiftId: string,
    u: Undelivered,
    escalateAt: number,
    reminderTask: { boardId: string } | null,
  ): Promise<void> {
    await this.db.batch([this.#undelivered(u), ...this.#reminded(shiftId, null, u.givenUpAt, escalateAt, reminderTask)]);
  }

  #reminded(
    shiftId: string,
    remindedAt: number | null,
    now: number,
    escalateAt: number,
    reminderTask: { boardId: string } | null,
  ): D1PreparedStatement[] {
    return [
      this.db
        // A submission credited mid-send wins: the Shift stays submitted.
        .prepare(
          `UPDATE shifts SET status = 'reminded', reminded_at = ?, due_at = ?, lease_until = NULL, attempts = 0, failing_since = NULL
           WHERE id = ? AND status = 'grace'`,
        )
        .bind(remindedAt, escalateAt, shiftId),
      ...(reminderTask
        ? [
            this.db
              .prepare(
                `INSERT OR IGNORE INTO reminder_tasks (shift_id, board_id, state, due_at, created_at)
                 SELECT id, ?, 'pending', ?, ? FROM shifts WHERE id = ? AND status = 'reminded'`,
              )
              .bind(reminderTask.boardId, now, now, shiftId),
          ]
        : []),
    ];
  }

  /** One recipient's send went out (`outcome === "ok"`). */
  async markSendDone(claimKey: string, now: number): Promise<void> {
    await this.#sendDone(claimKey, now).run();
  }

  /**
   * Every Escalation went out, or the ones still owed were given up on (#33,
   * recorded with them): nothing more is due for this Shift itself. Its open
   * Reminder Task is re-checked hourly from now on.
   */
  async markEscalated(shiftId: string, now: number, undelivered: Undelivered | null = null): Promise<void> {
    await this.db.batch([
      ...(undelivered ? [this.#undelivered(undelivered)] : []),
      this.db
        .prepare(
          `UPDATE shifts SET status = 'escalated', due_at = NULL, lease_until = NULL, attempts = 0, failing_since = NULL
           WHERE id = ? AND status = 'reminded'`,
        )
        .bind(shiftId),
      this.db
        .prepare(
          `UPDATE reminder_tasks SET due_at = MIN(COALESCE(due_at, ?1), ?1)
           WHERE shift_id = ?2 AND state IN (${TASK_ACTIVE})
             AND EXISTS (SELECT 1 FROM shifts WHERE id = ?2 AND status = 'escalated')`,
        )
        .bind(now + TASK_RECHECK_SECONDS, shiftId),
    ]);
  }

  /**
   * Lease up to `limit` Reminder Tasks whose next step is due, oldest due
   * first, as {@link takeDue} does for Shifts, leaving out creates or ticks
   * held by a block (#34). A deleted Shift's task is taken too: deleting it is
   * its step.
   */
  async takeDueTasks(now: number, limit: number, take = { creates: true, ticks: true }): Promise<ReminderTaskRow[]> {
    const due = await this.db
      .prepare(
        `${TASK_SELECT}
         WHERE t.due_at <= ?1 AND (t.lease_until IS NULL OR t.lease_until <= ?1)
           AND (?3 OR t.task_id IS NOT NULL) AND (?4 OR t.tick IS NOT 'ticked')
         ORDER BY t.due_at LIMIT ?2`,
      )
      .bind(now, limit, take.creates ? 1 : 0, take.ticks ? 1 : 0)
      .all<Record<string, unknown>>();

    const taken: ReminderTaskRow[] = [];
    for (const r of due.results) {
      const lease = await this.db
        .prepare("UPDATE reminder_tasks SET lease_until = ? WHERE shift_id = ? AND (lease_until IS NULL OR lease_until <= ?)")
        .bind(now + LEASE_SECONDS, r.id, now)
        .run();
      if (lease.meta.changes === 1) taken.push(toTask(r));
    }
    return taken;
  }

  /**
   * The Reminder Task was created (`outcome === "ok"`): store its id, title,
   * users and description with its claim marked done, in one batch, so no
   * later run can create a second.
   */
  async markTaskCreated(
    shiftId: string,
    claimKey: string,
    task: { id: string; title: string; userIds: number[]; description: string },
    now: number,
  ): Promise<void> {
    await this.db.batch([
      this.#sendDone(claimKey, now),
      this.db
        .prepare(
          `UPDATE reminder_tasks SET
             task_id = ?3, title = ?4, user_ids = ?5, description = ?6, state = 'open', lease_until = NULL,
             attempts = 0, failing_since = NULL,
             due_at = ${TASK_NEXT_DUE}
           WHERE shift_id = ?2`,
        )
        .bind(now, shiftId, task.id, task.title, JSON.stringify(task.userIds), task.description),
    ]);
  }

  /**
   * A `task_completed` delivery (#28). An open Reminder Task ticked for the
   * first time with no credited submission is due at once, to be reopened
   * with the tick DM. A later tick, a tick after our own close (which sends
   * no webhook anyway) or any other Quick Task changes nothing.
   */
  async recordTick(d: { dedupeKey: string; eventType: string; taskIds: string[] }, now: number): Promise<number> {
    const results = await this.db.batch([
      this.#delivery({ ...d, userId: null }, now),
      ...d.taskIds.map((taskId) =>
        this.db
          .prepare(
            `UPDATE reminder_tasks SET tick = 'ticked', due_at = ?1
             WHERE task_id = ?2 AND state = 'open' AND tick IS NULL
               AND EXISTS (SELECT 1 FROM shifts s WHERE s.id = reminder_tasks.shift_id
                           AND s.deleted_at IS NULL AND s.credited_submission_id IS NULL)`,
          )
          .bind(now, taskId),
      ),
    ]);
    return results.slice(1).reduce((n, r) => n + r.meta.changes, 0);
  }

  /**
   * The ticked Reminder Task was reopened and the tick DM went out (`outcome
   * === "ok"`), or the tick DM was given up on (#33, recorded with it).
   */
  async markTickHandled(shiftId: string, claim: { done: string } | { undelivered: Undelivered }, now: number): Promise<void> {
    await this.db.batch([
      "done" in claim ? this.#sendDone(claim.done, now) : this.#undelivered(claim.undelivered),
      this.db.prepare("UPDATE reminder_tasks SET tick = 'reopened' WHERE shift_id = ? AND tick = 'ticked'").bind(shiftId),
      // A second statement: a `SET` reads the row as it was, so the next step must see the new tick.
      this.db
        .prepare(
          `UPDATE reminder_tasks SET lease_until = NULL, attempts = 0, failing_since = NULL, due_at = ${TASK_NEXT_DUE}
           WHERE shift_id = ?2`,
        )
        .bind(now, shiftId),
    ]);
  }

  /** Whether the employee ever ticked this Shift's Reminder Task without submitting, for the Escalation. */
  async taskTicked(shiftId: string): Promise<boolean> {
    const r = await this.db
      .prepare("SELECT 1 AS ticked FROM reminder_tasks WHERE shift_id = ? AND tick IS NOT NULL")
      .bind(shiftId)
      .first<{ ticked: number }>();
    return r !== null;
  }

  /** The Reminder Task has nothing more to do: done, or its creation given up on (#33, recorded with it). */
  async finishTask(shiftId: string, state: "completed" | "deleted" | "skipped", undelivered: Undelivered | null = null): Promise<void> {
    await this.db.batch([
      ...(undelivered ? [this.#undelivered(undelivered)] : []),
      this.db
        .prepare(
          "UPDATE reminder_tasks SET state = ?, due_at = NULL, lease_until = NULL, attempts = 0, failing_since = NULL WHERE shift_id = ?",
        )
        .bind(state, shiftId),
    ]);
  }

  /** Nothing to do for the open Reminder Task yet: schedule its next step. */
  async rescheduleTask(shiftId: string, now: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE reminder_tasks SET lease_until = NULL, attempts = 0, failing_since = NULL, due_at = ${TASK_NEXT_DUE}
         WHERE shift_id = ?2`,
      )
      .bind(now, shiftId)
      .run();
  }

  /**
   * The Shift's due step failed (#33): try it again `waitSeconds` from now,
   * counting the failure. Only while the Shift is still at that step: a
   * credit or delete that landed mid-step keeps what it set.
   */
  async backOff(shiftId: string, status: ShiftStatus, now: number, waitSeconds: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE shifts SET lease_until = NULL,
           due_at = CASE WHEN status = ?2 AND due_at IS NOT NULL THEN ?3 ELSE due_at END,
           attempts = CASE WHEN status = ?2 THEN attempts + 1 ELSE attempts END,
           failing_since = CASE WHEN status = ?2 THEN COALESCE(failing_since, ?4) ELSE failing_since END
         WHERE id = ?1`,
      )
      .bind(shiftId, status, now + waitSeconds, now)
      .run();
  }

  /**
   * The Reminder Task's due step failed (#33): try it again `waitSeconds`
   * from now, counting the failure, unless a credit, delete or tick that
   * landed mid-step made a step due sooner.
   */
  async backOffTask(shiftId: string, now: number, waitSeconds: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE reminder_tasks SET lease_until = NULL, attempts = attempts + 1, failing_since = COALESCE(failing_since, ?2),
           due_at = CASE WHEN due_at > ?2 THEN due_at ELSE ?3 END
         WHERE shift_id = ?1 AND due_at IS NOT NULL`,
      )
      .bind(shiftId, now, now + waitSeconds)
      .run();
  }

  /** The sends given up on that the condition's all clear hasn't listed yet, oldest first (#33). */
  async openUndelivered(alert: AlertCondition): Promise<Undelivered[]> {
    const rows = await this.db
      // Given up together (a block lifting), each Shift's sends read in the order they'd have gone.
      .prepare(
        `SELECT * FROM undelivered WHERE alert = ? AND cleared_at IS NULL
         ORDER BY given_up_at, shift_start, CASE kind WHEN 'reminder' THEN 0 WHEN 'task' THEN 1 WHEN 'tick' THEN 2 ELSE 3 END, send_key`,
      )
      .bind(alert)
      .all<Record<string, unknown>>();
    return rows.results.map((r) => ({
      sendKey: String(r.send_key),
      kind: r.kind as SendKind,
      userId: Number(r.user_id),
      name: String(r.name),
      shiftStart: Number(r.shift_start),
      shiftTz: String(r.shift_tz),
      outcome: r.outcome as Undelivered["outcome"],
      alert: r.alert as AlertCondition,
      status: r.status === null ? null : Number(r.status),
      failingSince: Number(r.failing_since),
      givenUpAt: Number(r.given_up_at),
    }));
  }

  /**
   * Whether sends are failing now (#33): a send was given up on, and none has
   * gone out since. A give-up and a send in the same run count as failing.
   */
  async sendsFailing(): Promise<boolean> {
    const r = await this.db
      .prepare(
        `SELECT (SELECT MAX(given_up_at) FROM undelivered WHERE alert = 'messages') AS gave_up,
                (SELECT MAX(done_at) FROM send_claims WHERE done_at IS NOT NULL) AS sent`,
      )
      .first<{ gave_up: number | null; sent: number | null }>();
    return r?.gave_up != null && (r.sent == null || r.gave_up >= r.sent);
  }

  /**
   * A Failure Alert's claims (#33) that are stuck count as posted, so nothing
   * is posted twice: an alert is raised as of its claim, an all clear cleared.
   */
  async settleStuckAlerts(now: number): Promise<number> {
    const [a, b] = await this.db.batch([
      this.db
        .prepare("UPDATE failure_alerts SET state = 'raised', alerted_at = claimed_at WHERE state = 'alerting' AND claimed_at <= ?")
        .bind(now - STUCK_CLAIM_SECONDS),
      this.db
        .prepare("UPDATE failure_alerts SET state = 'clear' WHERE state = 'clearing' AND claimed_at <= ?")
        .bind(now - STUCK_CLAIM_SECONDS),
    ]);
    return a!.meta.changes + b!.meta.changes;
  }

  /**
   * Claim the condition's alert, before posting it. Returns `false`, posting
   * nothing, while it's held back: within `holdSeconds` of its last alert, or
   * another run's claim.
   */
  async claimAlert(condition: AlertCondition, now: number, holdSeconds: number): Promise<boolean> {
    const [, claim] = await this.db.batch([
      this.db.prepare("INSERT OR IGNORE INTO failure_alerts (condition, state) VALUES (?, 'clear')").bind(condition),
      this.db
        .prepare(
          `UPDATE failure_alerts SET state = 'alerting', claimed_at = ?2, quiet = CASE WHEN state = 'clear' THEN 1 ELSE quiet END
           WHERE condition = ?1 AND state IN ('clear', 'raised') AND (alerted_at IS NULL OR alerted_at <= ?3)`,
        )
        .bind(condition, now, now - holdSeconds),
    ]);
    return claim!.meta.changes === 1;
  }

  /** The alert went out (`outcome === "ok"`): the condition is raised, and owes an all clear. */
  async alertPosted(condition: AlertCondition, now: number): Promise<void> {
    await this.db
      .prepare("UPDATE failure_alerts SET state = 'raised', alerted_at = ?, quiet = 0 WHERE condition = ? AND state = 'alerting'")
      .bind(now, condition)
      .run();
  }

  /**
   * The condition is raised without an alert: its post failed (the next run
   * tries again), or it's held back with sends to list, so the all clear
   * still lists them.
   */
  async raiseQuietly(condition: AlertCondition): Promise<void> {
    await this.db.batch([
      this.db.prepare("INSERT OR IGNORE INTO failure_alerts (condition, state) VALUES (?, 'clear')").bind(condition),
      this.db
        .prepare(
          `UPDATE failure_alerts SET state = 'raised', quiet = CASE WHEN state = 'clear' THEN 1 ELSE quiet END
           WHERE condition = ? AND state IN ('clear', 'alerting')`,
        )
        .bind(condition),
    ]);
  }

  /**
   * Claim the condition's all clear, before posting it. `null` unless it's
   * raised; `quiet` when its alert never reached the client (#34).
   */
  async claimAllClear(condition: AlertCondition, now: number): Promise<{ quiet: boolean } | null> {
    const r = await this.db
      .prepare(
        "UPDATE failure_alerts SET state = 'clearing', claimed_at = ? WHERE condition = ? AND state = 'raised' RETURNING quiet",
      )
      .bind(now, condition)
      .first<{ quiet: number }>();
    return r ? { quiet: r.quiet === 1 } : null;
  }

  /** The all clear went out (`outcome === "ok"`), listing these sends: they're cleared. */
  async allClearPosted(condition: AlertCondition, sendKeys: string[], now: number): Promise<void> {
    await this.db.batch([
      this.db.prepare("UPDATE failure_alerts SET state = 'clear' WHERE condition = ? AND state = 'clearing'").bind(condition),
      ...sendKeys.map((k) => this.db.prepare("UPDATE undelivered SET cleared_at = ? WHERE send_key = ?").bind(now, k)),
    ]);
  }

  /**
   * Claim telling the Integrator Relay the condition is raised or cleared
   * (#36), before the send. `false` when the relay already knows, or the
   * condition isn't (or is no longer) in that state for the Alerts Channel.
   */
  async claimRelay(condition: AlertCondition, to: "raised" | "cleared"): Promise<boolean> {
    const r = await this.db
      .prepare(
        to === "raised"
          ? "UPDATE failure_alerts SET relayed = 1 WHERE condition = ? AND relayed = 0 AND state IN ('alerting', 'raised')"
          : "UPDATE failure_alerts SET relayed = 0 WHERE condition = ? AND relayed = 1 AND state = 'clear'",
      )
      .bind(condition)
      .run();
    return r.meta.changes === 1;
  }

  /** The relay didn't take it: the next run tries again. */
  async releaseRelay(condition: AlertCondition, to: "raised" | "cleared"): Promise<void> {
    await this.db
      .prepare("UPDATE failure_alerts SET relayed = ? WHERE condition = ?")
      .bind(to === "raised" ? 0 : 1, condition)
      .run();
  }

  /**
   * Claim the daily check-in (#36): due when none went out in the last
   * `everySeconds`. Returns the previous check-in's time (`null` for never)
   * to put back if the send fails, or `false` when it isn't due.
   */
  async claimCheckIn(now: number, everySeconds: number): Promise<{ previous: number | null } | false> {
    const previous = await this.state("checked_in_at");
    if (previous !== null && now - previous < everySeconds) return false;
    const r = await this.db
      .prepare(
        `INSERT INTO worker_state (key, value) VALUES ('checked_in_at', ?1)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE worker_state.value <= ?2`,
      )
      .bind(now, now - everySeconds)
      .run();
    return r.meta.changes === 1 ? { previous } : false;
  }

  /** The check-in didn't reach the relay: due again next run. */
  async releaseCheckIn(previous: number | null): Promise<void> {
    await (previous === null
      ? this.db.prepare("DELETE FROM worker_state WHERE key = 'checked_in_at'")
      : this.db.prepare("UPDATE worker_state SET value = ? WHERE key = 'checked_in_at'").bind(previous)
    ).run();
  }

  /** The all clear's post failed: still raised, so the next run tries again. */
  async releaseAllClear(condition: AlertCondition): Promise<void> {
    await this.db.prepare("UPDATE failure_alerts SET state = 'raised' WHERE condition = ? AND state = 'clearing'").bind(condition).run();
  }

  /** Let the next run try this Reminder Task again. */
  async releaseTask(shiftId: string): Promise<void> {
    await this.db.prepare("UPDATE reminder_tasks SET lease_until = NULL WHERE shift_id = ?").bind(shiftId).run();
  }

  /**
   * The saved times of the Shift Segments and manual breaks we know, by id,
   * for the sweep to compare with what Connecteam has now (#32).
   */
  async knownRecords(ids: string[]): Promise<Map<string, { startAt: number; endAt: number | null }>> {
    const known = new Map<string, { startAt: number; endAt: number | null }>();
    // D1 binds at most 100 parameters per statement.
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      const marks = chunk.map(() => "?").join(", ");
      const rows = await this.db
        .prepare(
          `SELECT time_activity_id, start_at, end_at FROM shift_segments WHERE time_activity_id IN (${marks})
           UNION ALL
           SELECT time_activity_id, start_at, end_at FROM manual_breaks WHERE time_activity_id IN (${marks})`,
        )
        .bind(...chunk, ...chunk)
        .all<{ time_activity_id: string; start_at: number; end_at: number | null }>();
      for (const r of rows.results) known.set(r.time_activity_id, { startAt: r.start_at, endAt: r.end_at });
    }
    return known;
  }

  /** The sweep added or corrected this record: no webhook told us (#32, counted by #34). */
  async recordSweepFind(f: { timeActivityId: string; kind: "segment" | "break"; userId: number }, now: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO sweep_finds (time_activity_id, kind, user_id, found_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (time_activity_id) DO UPDATE SET found_at = excluded.found_at`,
      )
      .bind(f.timeActivityId, f.kind, f.userId, now)
      .run();
  }

  /** The blocks in force (#34). */
  async blocks(): Promise<BlockRow[]> {
    const rows = await this.db
      .prepare("SELECT block, since, setting, checked_at FROM blocks ORDER BY block")
      .all<{ block: Block; since: number; setting: string | null; checked_at: number }>();
    return rows.results.map((r) => ({ block: r.block, since: r.since, setting: r.setting, checkedAt: r.checked_at }));
  }

  /** Something stops work until the client fixes it (#34). A block already in force keeps its start. */
  async block(block: Block, now: number, setting: string | null): Promise<void> {
    await this.db
      .prepare("INSERT OR IGNORE INTO blocks (block, since, setting, checked_at) VALUES (?, ?, ?, ?)")
      .bind(block, now, setting, now)
      .run();
  }

  /** The block was probed and is still in force. */
  async blockChecked(block: Block, now: number): Promise<void> {
    await this.db.prepare("UPDATE blocks SET checked_at = ? WHERE block = ?").bind(now, block).run();
  }

  /** Lift the block. `true` for the one caller that lifted it, so only one run skips what's overdue. */
  async unblock(block: Block): Promise<boolean> {
    const r = await this.db.prepare("DELETE FROM blocks WHERE block = ?").bind(block).run();
    return r.meta.changes === 1;
  }

  /**
   * The Shifts whose Reminder or Escalation was due at or before `cutoff`
   * and hasn't gone out (#34), with when it was due.
   */
  async overdueShifts(cutoff: number): Promise<(ShiftRow & { dueAt: number })[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM shifts WHERE status IN ('grace', 'reminded') AND due_at <= ? AND deleted_at IS NULL
         ORDER BY due_at`,
      )
      .bind(cutoff)
      .all<Record<string, unknown>>();
    return rows.results.map((r) => ({ ...toShift(r), dueAt: Number(r.due_at) }));
  }

  /**
   * The Reminder Tasks whose create or tick DM was due at or before `cutoff`
   * and hasn't gone out (#34).
   */
  async overdueTaskSends(cutoff: number): Promise<ReminderTaskRow[]> {
    const rows = await this.db
      .prepare(
        `${TASK_SELECT}
         WHERE t.due_at <= ? AND ((t.state = 'pending' AND t.task_id IS NULL) OR (t.state = 'open' AND t.tick = 'ticked'))
         ORDER BY t.due_at`,
      )
      .bind(cutoff)
      .all<Record<string, unknown>>();
    return rows.results.map(toTask);
  }

  /**
   * The task board `from` was gone, and `to` replaces it (#34): Reminder
   * Tasks not yet created go there. Created ones stay where they are.
   */
  async moveUncreatedTasks(from: string, to: string): Promise<void> {
    await this.db
      .prepare("UPDATE reminder_tasks SET board_id = ? WHERE board_id = ? AND task_id IS NULL AND state = 'pending'")
      .bind(to, from)
      .run();
  }

  /** Skip a send that was overdue when a block lifted (#34): recorded, never sent. */
  async recordSkipped(u: Undelivered): Promise<void> {
    await this.#undelivered(u).run();
  }

  /** What the lost-webhook alert reads, over the `windowSeconds` before `now` (#34). */
  async webhookHealth(now: number, windowSeconds: number): Promise<WebhookHealth> {
    const from = now - windowSeconds;
    const r = await this.db
      .prepare(
        `SELECT (SELECT MAX(received_at) FROM webhook_deliveries) AS last_delivery,
                (SELECT COUNT(*) FROM sweep_finds WHERE kind = 'segment' AND found_at > ?1) AS missed,
                EXISTS (SELECT 1 FROM shift_segments WHERE start_at > ?1 OR end_at > ?1) AS activity,
                (SELECT MIN(created_at) FROM shifts) AS watching_since`,
      )
      .bind(from)
      .first<{ last_delivery: number | null; missed: number; activity: number; watching_since: number | null }>();
    return {
      lastDelivery: r?.last_delivery ?? null,
      missed: r?.missed ?? 0,
      activity: !!r?.activity,
      watchingSince: r?.watching_since ?? null,
    };
  }

  async state(key: StateKey): Promise<number | null> {
    const r = await this.db.prepare("SELECT value FROM worker_state WHERE key = ?").bind(key).first<{ value: number }>();
    return r?.value ?? null;
  }

  async setState(key: StateKey, value: number): Promise<void> {
    await this.db
      .prepare("INSERT INTO worker_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .bind(key, value)
      .run();
  }

  /**
   * The time clocks to sweep are now `ids`: a new one is due at once, a known
   * one keeps its turn, and one no longer listed is dropped. Records the time
   * they were listed.
   */
  /**
   * A sweep read failed (#33): the reads have been failing since now, unless
   * they already were. `status` is its HTTP status, 0 for no response.
   */
  async sweepReadFailed(now: number, status: number): Promise<void> {
    await this.db.batch([
      this.db.prepare("INSERT OR IGNORE INTO worker_state (key, value) VALUES ('read_failing_since', ?)").bind(now),
      this.db
        .prepare("INSERT INTO worker_state (key, value) VALUES ('read_failing_status', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
        .bind(status),
    ]);
  }

  /** A sweep read worked: the reads aren't failing. */
  async sweepReadOk(): Promise<void> {
    await this.db.prepare("DELETE FROM worker_state WHERE key IN ('read_failing_since', 'read_failing_status')").run();
  }

  async setSweepClocks(ids: number[], now: number): Promise<void> {
    const marks = ids.map(() => "?").join(", ");
    await this.db.batch([
      ids.length === 0
        ? this.db.prepare("DELETE FROM sweep_clocks")
        : this.db.prepare(`DELETE FROM sweep_clocks WHERE time_clock_id NOT IN (${marks})`).bind(...ids),
      ...ids.map((id) => this.db.prepare("INSERT OR IGNORE INTO sweep_clocks (time_clock_id, next_at) VALUES (?, ?)").bind(id, now)),
      this.db
        .prepare(
          "INSERT INTO worker_state (key, value) VALUES ('clocks_listed_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        )
        .bind(now),
    ]);
  }

  async sweepClockCount(): Promise<number> {
    const r = await this.db.prepare("SELECT COUNT(*) AS n FROM sweep_clocks").first<{ n: number }>();
    return r?.n ?? 0;
  }

  /**
   * Claim up to `limit` time clocks whose sweep is due, longest waiting first,
   * by moving each one's turn on to `nextAt`. A clock another run claimed is
   * skipped.
   */
  /** A claimed clock wasn't read after all (the run stopped for the minute): it's due again now. */
  async releaseClock(timeClockId: number, now: number): Promise<void> {
    await this.db.prepare("UPDATE sweep_clocks SET next_at = ? WHERE time_clock_id = ?").bind(now, timeClockId).run();
  }

  async takeDueClocks(now: number, limit: number, nextAt: number): Promise<number[]> {
    const due = await this.db
      .prepare("SELECT time_clock_id FROM sweep_clocks WHERE next_at <= ? ORDER BY next_at, time_clock_id LIMIT ?")
      .bind(now, limit)
      .all<{ time_clock_id: number }>();
    const taken: number[] = [];
    for (const r of due.results) {
      const claim = await this.db
        .prepare("UPDATE sweep_clocks SET next_at = ? WHERE time_clock_id = ? AND next_at <= ?")
        .bind(nextAt, r.time_clock_id, now)
        .run();
      if (claim.meta.changes === 1) taken.push(r.time_clock_id);
    }
    return taken;
  }

  #deliveryOf(d: { dedupeKey: string | null; eventType: string; userId: number | null }, now: number): D1PreparedStatement[] {
    return d.dedupeKey === null ? [] : [this.#delivery({ ...d, dedupeKey: d.dedupeKey }, now)];
  }

  #undelivered(u: Undelivered): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT OR IGNORE INTO undelivered
           (send_key, kind, user_id, name, shift_start, shift_tz, outcome, alert, status, failing_since, given_up_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(u.sendKey, u.kind, u.userId, u.name, u.shiftStart, u.shiftTz, u.outcome, u.alert, u.status, u.failingSince, u.givenUpAt);
  }

  #sendDone(claimKey: string, now: number): D1PreparedStatement {
    return this.db.prepare("UPDATE send_claims SET state = 'done', done_at = ? WHERE claim_key = ?").bind(now, claimKey);
  }

  #delivery(d: { dedupeKey: string; eventType: string; userId: number | null }, now: number): D1PreparedStatement {
    return this.db
      .prepare("INSERT OR IGNORE INTO webhook_deliveries (dedupe_key, event_type, user_id, received_at) VALUES (?, ?, ?, ?)")
      .bind(d.dedupeKey, d.eventType, d.userId, now);
  }
}

/** A Reminder Task with its Shift: `WHERE` and the rest follow. */
const TASK_SELECT = `SELECT t.board_id, t.task_id, t.title, t.user_ids, t.description, t.tick,
         t.attempts AS task_attempts, t.failing_since AS task_failing_since, s.*
       FROM reminder_tasks t JOIN shifts s ON s.id = t.shift_id`;

function toTask(r: Record<string, unknown>): ReminderTaskRow {
  return {
    shiftId: String(r.id),
    boardId: String(r.board_id),
    task:
      r.task_id === null
        ? null
        : {
            id: String(r.task_id),
            title: String(r.title),
            userIds: JSON.parse(String(r.user_ids)) as number[],
            description: String(r.description ?? ""),
          },
    tick: (r.tick as ReminderTaskRow["tick"]) ?? null,
    shift: { ...toShift(r), deleted: r.deleted_at !== null },
    attempts: Number(r.task_attempts),
    failingSince: r.task_failing_since === null ? null : Number(r.task_failing_since),
  };
}

function toShift(r: Record<string, unknown>): ShiftRow {
  return {
    id: String(r.id),
    userId: Number(r.user_id),
    startAt: Number(r.start_at),
    startTz: String(r.start_tz),
    endAt: r.end_at === null ? null : Number(r.end_at),
    formIds: JSON.parse(String(r.form_ids)) as number[],
    graceEndsAt: r.grace_ends_at === null ? null : Number(r.grace_ends_at),
    status: r.status as ShiftStatus,
    remindedAt: r.reminded_at === null || r.reminded_at === undefined ? null : Number(r.reminded_at),
    attempts: Number(r.attempts ?? 0),
    failingSince: r.failing_since === null || r.failing_since === undefined ? null : Number(r.failing_since),
  };
}
