/**
 * The `time_activity` webhook (#2): one broadcast subscription covering every
 * Time Clock. The payload is flat: `requestId`, `eventType`, `userId`,
 * `timeClockId`, `activityType` and a `timeActivity` (delete events carry a bare
 * `timeActivityId` instead). Parsing is pure; the route stores the result.
 */
import type { TimeActivity } from "../connecteam/types.js";

export type TimeActivityDelivery =
  | {
      kind: "segment";
      dedupeKey: string;
      eventType: "clock_in" | "clock_out";
      userId: number;
      timeClockId: number | null;
      activity: TimeActivity;
    }
  /** Verified and recorded, but not an event this build acts on yet. */
  | { kind: "ignored"; dedupeKey: string; eventType: string; userId: number | null }
  | { kind: "malformed" };

/** Events whose `timeActivity` is a saved Shift Segment this build acts on. */
const SEGMENT_EVENTS = new Set(["clock_in", "clock_out"]);

export function parseTimeActivityDelivery(payload: unknown): TimeActivityDelivery {
  const o = asObject(payload);
  if (!o || typeof o.eventType !== "string") return { kind: "malformed" };

  const eventType = o.eventType;
  const userId = typeof o.userId === "number" ? o.userId : null;
  const ta = asObject(o.timeActivity);
  const activityId = typeof ta?.id === "string" ? ta.id : typeof o.timeActivityId === "string" ? o.timeActivityId : "";
  const dedupeKey = [String(o.requestId ?? ""), eventType, String(userId ?? ""), activityId].join("|");

  if (o.activityType !== "shift" || !SEGMENT_EVENTS.has(eventType)) {
    return { kind: "ignored", dedupeKey, eventType, userId };
  }

  const start = punch(ta?.start);
  if (userId === null || !ta || !activityId || !start) return { kind: "malformed" };
  const end = punch(ta.end);

  const activity: TimeActivity = { id: activityId, start };
  if (end) activity.end = end;
  if (typeof ta.schedulerShiftId === "string" && ta.schedulerShiftId) activity.schedulerShiftId = ta.schedulerShiftId;
  if (typeof ta.isAutoClockOut === "boolean") activity.isAutoClockOut = ta.isAutoClockOut;

  return {
    kind: "segment",
    dedupeKey,
    eventType: eventType as "clock_in" | "clock_out",
    userId,
    timeClockId: typeof o.timeClockId === "number" ? o.timeClockId : null,
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
