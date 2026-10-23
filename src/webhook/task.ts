/**
 * The Tasks webhook (#28): feature type `tasks`. As sent live on 2026-10-24,
 * the envelope has `activityType: "Task"`, `eventType` (`task_published` or
 * `task_completed`) and `data`, an array of tasks (`id`, `taskBoardId`,
 * `userIds`, `status`, ...). Nothing in it says who completed a task, and a
 * completion made through the API, such as our own close, sends nothing.
 * Parsing is pure; the route records the result.
 */

export type TaskDelivery =
  | { kind: "completed"; dedupeKey: string; eventType: string; taskIds: string[] }
  /** Verified and recorded, but not an event this build acts on. */
  | { kind: "ignored"; dedupeKey: string; eventType: string; userId: null }
  | { kind: "malformed" };

export function isTaskDelivery(payload: unknown): boolean {
  const type = asObject(payload)?.activityType;
  return typeof type === "string" && type.toLowerCase() === "task";
}

export function parseTaskDelivery(payload: unknown): TaskDelivery {
  const o = asObject(payload);
  if (!o || typeof o.eventType !== "string") return { kind: "malformed" };
  const eventType = o.eventType;
  const tasks = Array.isArray(o.data) ? o.data.map(asObject) : null;
  const taskIds = (tasks ?? []).map((t) => t?.id).filter((id): id is string => typeof id === "string" && id !== "");
  const dedupeKey = [String(o.requestId ?? ""), eventType, taskIds.join(",")].join("|");

  if (eventType !== "task_completed") return { kind: "ignored", dedupeKey, eventType, userId: null };
  if (!tasks || taskIds.length !== tasks.length) return { kind: "malformed" };
  return { kind: "completed", dedupeKey, eventType, taskIds };
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
