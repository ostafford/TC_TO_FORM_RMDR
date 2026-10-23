/**
 * The D1 work list (ADR-0002, migrations/0001_init.sql). All times are Unix
 * seconds.
 */
import type { TimeActivity } from "./connecteam/types.js";
import type { CreditCandidate } from "./crediting/choose.js";

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
  remindedAt: number | null;
}

/** A manual break, as the `time_activity` webhook sends it (#23). */
export interface BreakWrite {
  dedupeKey: string;
  eventType: string;
  userId: number;
  activity: TimeActivity;
}

export interface SegmentWrite {
  dedupeKey: string;
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
      this.#delivery(w, opts.now),
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
      this.#delivery(w, opts.now),
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
          `UPDATE shifts SET status = 'submitted', due_at = NULL, lease_until = NULL, credited_submission_id = ?1
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

  /** The claim's state, or `null` when nothing holds it. */
  async sendState(claimKey: string): Promise<"claimed" | "done" | null> {
    const r = await this.db
      .prepare("SELECT state FROM send_claims WHERE claim_key = ?")
      .bind(claimKey)
      .first<{ state: "claimed" | "done" }>();
    return r?.state ?? null;
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
    await this.db.batch([
      this.#sendDone(claimKey, now),
      this.db
        // A submission credited mid-send wins: the Shift stays submitted.
        .prepare(
          "UPDATE shifts SET status = 'reminded', reminded_at = ?, due_at = ?, lease_until = NULL WHERE id = ? AND status = 'grace'",
        )
        .bind(now, escalateAt, shiftId),
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
    ]);
  }

  /** One recipient's send went out (`outcome === "ok"`). */
  async markSendDone(claimKey: string, now: number): Promise<void> {
    await this.#sendDone(claimKey, now).run();
  }

  /**
   * Every Escalation went out: nothing more is due for this Shift itself. Its
   * open Reminder Task is re-checked hourly from now on.
   */
  async markEscalated(shiftId: string, now: number): Promise<void> {
    await this.db.batch([
      this.db
        .prepare("UPDATE shifts SET status = 'escalated', due_at = NULL, lease_until = NULL WHERE id = ? AND status = 'reminded'")
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
   * first, as {@link takeDue} does for Shifts. A deleted Shift's task is
   * taken too: deleting it is its step.
   */
  async takeDueTasks(now: number, limit: number): Promise<ReminderTaskRow[]> {
    const due = await this.db
      .prepare(
        `SELECT t.board_id, t.task_id, t.title, t.user_ids, t.description, t.tick, s.*
         FROM reminder_tasks t JOIN shifts s ON s.id = t.shift_id
         WHERE t.due_at <= ? AND (t.lease_until IS NULL OR t.lease_until <= ?)
         ORDER BY t.due_at LIMIT ?`,
      )
      .bind(now, now, limit)
      .all<Record<string, unknown>>();

    const taken: ReminderTaskRow[] = [];
    for (const r of due.results) {
      const lease = await this.db
        .prepare("UPDATE reminder_tasks SET lease_until = ? WHERE shift_id = ? AND (lease_until IS NULL OR lease_until <= ?)")
        .bind(now + LEASE_SECONDS, r.id, now)
        .run();
      if (lease.meta.changes !== 1) continue;
      taken.push({
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
      });
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

  /** The ticked Reminder Task was reopened and the tick DM went out (`outcome === "ok"`). */
  async markTickHandled(shiftId: string, claimKey: string, now: number): Promise<void> {
    await this.db.batch([
      this.#sendDone(claimKey, now),
      this.db.prepare("UPDATE reminder_tasks SET tick = 'reopened' WHERE shift_id = ? AND tick = 'ticked'").bind(shiftId),
      // A second statement: a `SET` reads the row as it was, so the next step must see the new tick.
      this.db
        .prepare(`UPDATE reminder_tasks SET lease_until = NULL, due_at = ${TASK_NEXT_DUE} WHERE shift_id = ?2`)
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

  /** The Reminder Task has nothing more to do. */
  async finishTask(shiftId: string, state: "completed" | "deleted" | "skipped"): Promise<void> {
    await this.db
      .prepare("UPDATE reminder_tasks SET state = ?, due_at = NULL, lease_until = NULL WHERE shift_id = ?")
      .bind(state, shiftId)
      .run();
  }

  /** Nothing to do for the open Reminder Task yet: schedule its next step. */
  async rescheduleTask(shiftId: string, now: number): Promise<void> {
    await this.db
      .prepare(`UPDATE reminder_tasks SET lease_until = NULL, due_at = ${TASK_NEXT_DUE} WHERE shift_id = ?2`)
      .bind(now, shiftId)
      .run();
  }

  /** Let the next run try this Reminder Task again. */
  async releaseTask(shiftId: string): Promise<void> {
    await this.db.prepare("UPDATE reminder_tasks SET lease_until = NULL WHERE shift_id = ?").bind(shiftId).run();
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
  };
}
