/**
 * The D1 work list (ADR-0002, migrations/0001_init.sql). All times are Unix
 * seconds.
 */
import type { TimeActivity } from "./connecteam/types.js";

export type ShiftStatus = "open" | "grace" | "submitted" | "reminded";

export interface ShiftRow {
  id: string;
  userId: number;
  startAt: number;
  startTz: string;
  endAt: number | null;
  formIds: number[];
  graceEndsAt: number | null;
  status: ShiftStatus;
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

export class WorkList {
  constructor(private readonly db: D1Database) {}

  /** Record a delivery that isn't a Shift Segment, for de-duplication and last-seen. */
  async recordDelivery(d: { dedupeKey: string; eventType: string; userId: number | null }, now: number): Promise<void> {
    await this.#delivery(d, now).run();
  }

  /**
   * Record a Shift Segment from a webhook, and when it carries a recorded end,
   * schedule the Grace Period check from that end. One atomic batch, and safe
   * to repeat: a duplicate delivery changes nothing, and a Shift that already
   * has an end keeps it (edits are #22).
   */
  async recordSegment(w: SegmentWrite, opts: { formIds: number[]; gracePeriodMinutes: number; now: number }): Promise<void> {
    const a = w.activity;
    const known = await this.db
      .prepare("SELECT shift_id FROM shift_segments WHERE time_activity_id = ?")
      .bind(a.id)
      .first<{ shift_id: string }>();
    const shiftId = known?.shift_id ?? a.id;

    const endAt = a.end?.timestamp ?? null;
    const graceEndsAt = endAt === null ? null : endAt + opts.gracePeriodMinutes * 60;
    const status: ShiftStatus = endAt === null ? "open" : "grace";

    await this.db.batch([
      this.#delivery(w, opts.now),
      this.db
        .prepare(
          `INSERT INTO shifts (id, user_id, time_clock_id, start_at, start_tz, end_at, scheduler_shift_id,
                               form_ids, grace_ends_at, status, due_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO NOTHING`,
        )
        .bind(
          shiftId,
          w.userId,
          w.timeClockId,
          a.start.timestamp,
          a.start.timezone,
          endAt,
          a.schedulerShiftId ?? null,
          JSON.stringify(opts.formIds),
          graceEndsAt,
          status,
          graceEndsAt,
          opts.now,
        ),
      // A clock-out for a Shift first seen at its clock-in.
      this.db
        .prepare(
          `UPDATE shifts SET end_at = ?, grace_ends_at = ?, due_at = ?, status = 'grace'
           WHERE id = ? AND status = 'open' AND ? IS NOT NULL`,
        )
        .bind(endAt, graceEndsAt, graceEndsAt, shiftId, endAt),
      this.db
        .prepare(
          `INSERT INTO shift_segments (time_activity_id, shift_id, start_at, end_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (time_activity_id) DO UPDATE SET end_at = COALESCE(shift_segments.end_at, excluded.end_at)`,
        )
        .bind(a.id, shiftId, a.start.timestamp, endAt),
    ]);
  }

  /**
   * Lease up to `limit` Shifts whose next step is due, oldest due first. A
   * Shift another run holds is skipped, so overlapping runs never work the
   * same Shift.
   */
  async takeDue(now: number, limit: number): Promise<ShiftRow[]> {
    const due = await this.db
      .prepare(
        `SELECT * FROM shifts WHERE due_at <= ? AND (lease_until IS NULL OR lease_until <= ?)
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

  /** A submission arrived in time: nothing more to do for this Shift. */
  async markSubmitted(shiftId: string, formSubmissionId: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE shifts SET status = 'submitted', due_at = NULL, lease_until = NULL, credited_submission_id = ?
         WHERE id = ?`,
      )
      .bind(formSubmissionId, shiftId)
      .run();
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

  /** The Reminder went out (`outcome === "ok"`): mark its claim done and the Shift reminded. */
  async markReminded(shiftId: string, claimKey: string, now: number): Promise<void> {
    await this.db.batch([
      this.db.prepare("UPDATE send_claims SET state = 'done', done_at = ? WHERE claim_key = ?").bind(now, claimKey),
      this.db
        .prepare("UPDATE shifts SET status = 'reminded', due_at = NULL, lease_until = NULL WHERE id = ?")
        .bind(shiftId),
    ]);
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
  };
}
