/**
 * Who gets an Escalation (#5, #25), read live from one paged `GET /users` at
 * send time so a newly promoted Admin is included without anyone adding them.
 * Pure, so the rules are tested without a Worker.
 */
import type { ConnecteamUser } from "../connecteam/types.js";

/**
 * In the API, `manager` is what the app and the glossary call an Admin;
 * `owner` is one too. An Admin invited but not yet accepted is still a `user`
 * (with `invitedToBeManager: true`, tested live 2026-10-24, #39), so they join
 * once they accept.
 */
const ADMIN_TYPES = new Set(["manager", "owner"]);

/** Whether this user can get Escalations at all: not archived (#131). */
export function isActive(u: ConnecteamUser): boolean {
  return !u.isArchived;
}

/** Whether this user gets Escalations unless excluded: an Admin, not archived. The setup wizard lists the same people (#39). */
export function isAdmin(u: ConnecteamUser): boolean {
  return ADMIN_TYPES.has(u.userType ?? "") && isActive(u);
}

/**
 * The employee's direct managers: the values of their custom fields whose type
 * is `directManager`, found by type, never by a hard-coded id. An account can
 * create more than one such field, and each one counts (#129). None when the
 * account has no such field or the employee's values are blank. A value is a
 * user id (tested live 2026-11-22, #128); a numeric string, a one-element
 * array or `{ value }` is read too, since the docs don't pin the shape.
 */
export function directManagerIds(employee: ConnecteamUser): number[] {
  return (employee.customFields ?? [])
    .filter((f) => f.type === "directManager")
    .map((f) => userId(f.value))
    .filter((id) => id !== null);
}

function userId(v: unknown): number | null {
  if (Array.isArray(v)) return v.length === 1 ? userId(v[0]) : null;
  if (v !== null && typeof v === "object" && "value" in v) return userId((v as { value: unknown }).value);
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Every Admin except the Excluded Admins, plus the employee's direct managers
 * (even an Excluded one), each once. Like an Admin, a direct manager must be
 * an active user in `users`: one archived or deleted since is left out
 * (#131). The employee is never escalated to about their own Missed Form.
 */
export function escalationRecipients(opts: {
  users: ConnecteamUser[];
  employee: ConnecteamUser;
  excludedAdminIds: number[];
}): number[] {
  const excluded = new Set(opts.excludedAdminIds);
  const ids = opts.users
    .filter((u) => isAdmin(u) && !excluded.has(u.userId))
    .map((u) => u.userId);
  const active = new Set(opts.users.filter(isActive).map((u) => u.userId));
  ids.push(...directManagerIds(opts.employee).filter((id) => active.has(id)));
  return [...new Set(ids)].filter((id) => id !== opts.employee.userId);
}
