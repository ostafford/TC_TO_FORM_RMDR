/**
 * The `time_activity` webhook (#2): one broadcast subscription covering every
 * Time Clock. The payload is flat: `requestId`, `eventType`, `userId`,
 * `timeClockId`, `activityType` and a `timeActivity` (delete events carry a bare
 * `timeActivityId` instead). Parsing is pure; the route stores the result.
 *
 * A manual break comes as the same events with `activityType:
 * "manual_break"` (tested live 2026-10-21, #23): no break-specific event type.
 */
import type { TimeActivity } from "../connecteam/types.js";

export type TimeActivityDelivery =
  | {
      kind: "segment";
      webhook: "time_activity";
      dedupeKey: string;
      eventType: string;
      userId: number;
      timeClockId: number | null;
      /** The delivery's `eventTimestamp`: a write older than the last one applied is ignored (#83). */
      eventAt: number | null;
      activity: TimeActivity;
    }
  /** A saved Shift Segment was deleted. */
  | { kind: "deleted"; webhook: "time_activity"; dedupeKey: string; eventType: string; userId: number | null; timeActivityId: string }
  /** A manual break was started, ended, added or edited. */
  | {
      kind: "break";
      webhook: "time_activity";
      dedupeKey: string;
      eventType: string;
      userId: number;
      eventAt: number | null;
      activity: TimeActivity;
    }
  /** A manual break was deleted. */
  | { kind: "breakDeleted"; webhook: "time_activity"; dedupeKey: string; eventType: string; userId: number | null; timeActivityId: string }
  /** Verified and recorded, but not an event this build acts on. */
  | { kind: "ignored"; webhook: "time_activity"; dedupeKey: string; eventType: string; userId: number | null }
  | { kind: "malformed" };

/**
 * Events whose `timeActivity` is a saved Shift Segment: every way a Shift ends
 * (#22), plus the clock-in that opens one. Approved requests are saved; the
 * `user_*_request` and `admin_declined_*` events are only asks, carrying
 * requested times, and are ignored.
 */
const SEGMENT_EVENTS = new Set(["clock_in", "clock_out", "auto_clock_out", "admin_add", "admin_edit"]);
const APPROVED = /^(admin|auto)_approved_/;
const DELETE_EVENTS = /^(admin_delete|(admin|auto)_approved_delete_request)$/;

export function parseTimeActivityDelivery(payload: unknown): TimeActivityDelivery {
  const o = asObject(payload);
  if (!o || typeof o.eventType !== "string") return { kind: "malformed" };

  const eventType = o.eventType;
  const userId = typeof o.userId === "number" ? o.userId : null;
  const ta = asObject(o.timeActivity);
  const activityId = typeof ta?.id === "string" ? ta.id : typeof o.timeActivityId === "string" ? o.timeActivityId : "";
  const dedupeKey = [String(o.requestId ?? ""), eventType, String(userId ?? ""), activityId].join("|");

  const isBreak = o.activityType === "manual_break";
  if (o.activityType !== "shift" && !isBreak) return { kind: "ignored", webhook: "time_activity", dedupeKey, eventType, userId };

  if (DELETE_EVENTS.test(eventType)) {
    if (!activityId) return { kind: "malformed" };
    return { kind: isBreak ? "breakDeleted" : "deleted", webhook: "time_activity", dedupeKey, eventType, userId, timeActivityId: activityId };
  }

  if (!SEGMENT_EVENTS.has(eventType) && !APPROVED.test(eventType)) {
    return { kind: "ignored", webhook: "time_activity", dedupeKey, eventType, userId };
  }

  const start = punch(ta?.start);
  if (userId === null || !ta || !activityId || !start) return { kind: "malformed" };
  // A payload shows the record as it is when sent, so even a clock-in can carry an end.
  const end = punch(ta.end);

  const activity: TimeActivity = { id: activityId, start };
  if (end) activity.end = end;
  const eventAt = typeof o.eventTimestamp === "number" ? o.eventTimestamp : null;
  if (isBreak) return { kind: "break", webhook: "time_activity", dedupeKey, eventType, userId, eventAt, activity };
  if (typeof ta.schedulerShiftId === "string" && ta.schedulerShiftId) activity.schedulerShiftId = ta.schedulerShiftId;
  if (typeof ta.isAutoClockOut === "boolean") activity.isAutoClockOut = ta.isAutoClockOut;

  return {
    kind: "segment",
    webhook: "time_activity",
    dedupeKey,
    eventType,
    userId,
    timeClockId: typeof o.timeClockId === "number" ? o.timeClockId : null,
    eventAt,
    activity,
  };
}

function punch(v: unknown): TimeActivity["start"] | null {
  const p = asObject(v);
  if (!p || typeof p.timestamp !== "number" || typeof p.timezone !== "string") return null;
  return { timestamp: p.timestamp, timezone: p.timezone };
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
