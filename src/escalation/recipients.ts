/**
 * Who gets an Escalation (#5, #25), read live from one paged `GET /users` at
 * send time so a newly promoted Admin is included without anyone adding them.
 * Pure, so the rules are tested without a Worker.
 */
import type { ConnecteamUser } from "../connecteam/types.js";

/** In the API, `manager` is what the app and the glossary call an Admin; `owner` is one too. */
const ADMIN_TYPES = new Set(["manager", "owner"]);

/**
 * The employee's direct manager: the value of their custom field whose type is
 * `directManager`, found by type, never by a hard-coded id. `null` when the
 * account has no such field or the employee's value is blank. The value is a
 * user id; a numeric string, a one-element array or `{ value }` is read too,
 * since the blank and set shapes aren't confirmed live (#5).
 */
export function directManagerId(employee: ConnecteamUser): number | null {
  const field = (employee.customFields ?? []).find((f) => f.type === "directManager");
  return field ? userId(field.value) : null;
}

function userId(v: unknown): number | null {
  if (Array.isArray(v)) return v.length === 1 ? userId(v[0]) : null;
  if (v !== null && typeof v === "object" && "value" in v) return userId((v as { value: unknown }).value);
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Every Admin except the Excluded Admins, plus the employee's direct manager
 * (even an Excluded one), each once. The employee is never escalated to about
 * their own Missed Form.
 */
export function escalationRecipients(opts: {
  users: ConnecteamUser[];
  employee: ConnecteamUser;
  excludedAdminIds: number[];
}): number[] {
  const excluded = new Set(opts.excludedAdminIds);
  const ids = opts.users
    .filter((u) => ADMIN_TYPES.has(u.userType ?? "") && !u.isArchived && !excluded.has(u.userId))
    .map((u) => u.userId);
  const manager = directManagerId(opts.employee);
  if (manager !== null) ids.push(manager);
  return [...new Set(ids)].filter((id) => id !== opts.employee.userId);
}
