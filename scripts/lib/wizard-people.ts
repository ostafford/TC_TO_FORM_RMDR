/**
 * What the setup wizard's people and channel steps (#39, user stories 42 to
 * 46) make of Connecteam's users, publishers, task boards and chats, and
 * the support link's values. Pure, so the rules are tested without a network.
 *
 * Shapes tested live 2026-10-24 on the demo account (#39): `GET
 * /users/v1/users` lists owners (`userType: "owner"`), and the direct manager
 * is a custom field of type `directManager` holding a user id; `GET
 * /publishers/v1/publishers` lists `{ id, name }`; `GET /tasks/v1/taskboards`
 * lists `{ id, name, isArchived }`, unpaged; `GET /chat/v1/conversations`
 * lists `{ id, title, type: "team" | "channel" }`, 10 a page unless asked.
 */
import type { ConnecteamUser, Conversation } from "../../src/connecteam/types.js";
import { directManagerId, isAdmin } from "../../src/escalation/recipients.js";
import { plainText } from "./wizard-forms.js";

/** "Jordan Lee", or the id when the user has no name. */
export function fullName(u: ConnecteamUser): string {
  return plainText(`${u.firstName ?? ""} ${u.lastName ?? ""}`) || `user ${u.userId}`;
}

export interface AdminRow {
  userId: number;
  label: string;
}

/** Every Admin who gets Escalations unless unticked: the same people the Worker reads at send time. */
export function adminRows(users: ConnecteamUser[]): AdminRow[] {
  return users
    .filter(isAdmin)
    .map((u) => ({ userId: u.userId, label: `${fullName(u)}${u.userType === "owner" ? " (owner)" : ""}` }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Whether the account uses direct managers: it has a `directManager` field,
 * and how many staff have one set. Escalations reach a direct manager even
 * when they're unticked (#25).
 */
export function directManagers(users: ConnecteamUser[]): { field: boolean; set: number; staff: number } {
  const staff = users.filter((u) => !u.isArchived && !isAdmin(u));
  const field = users.some((u) => (u.customFields ?? []).some((f) => f.type === "directManager"));
  return { field, set: staff.filter((u) => directManagerId(u) !== null).length, staff: staff.length };
}

/** One plain line about direct managers, for the recipients step. */
export function directManagerLine(d: { field: boolean; set: number; staff: number }): string {
  if (!d.field) return "Direct managers: not used in this account, so escalations go to admins only.";
  if (d.set === 0) return "Direct managers: the field exists, but no one has one set yet, so escalations go to admins only for now.";
  return `Direct managers: found. ${d.set} of ${d.staff} staff have one, who also gets their escalations.`;
}

/** The chat list's labels: the title, what kind it is, and the id where two share a title. */
export function conversationLabels(conversations: Conversation[]): string[] {
  const count = new Map<string, number>();
  for (const c of conversations) count.set(plainText(c.title), (count.get(plainText(c.title)) ?? 0) + 1);
  return conversations.map((c) => {
    const title = plainText(c.title) || "(untitled)";
    const kind = c.type === "channel" ? "channel" : "team chat";
    return `${title} (${kind}${(count.get(plainText(c.title)) ?? 0) > 1 ? `, id ${c.id}` : ""})`;
  });
}

/**
 * Whether a sender name says it's automated (#19, user story 14: staff
 * should know it isn't a person writing). A hint, not a rule.
 */
export function soundsAutomated(name: string): boolean {
  return /automat|\bbot\b|reminder|no[- ]?reply|system|notification/i.test(name);
}

/** The support link's address: https only. */
export function checkRelayUrl(text: string): { ok: true; value: string } | { ok: false; problem: string } {
  const t = text.trim().replace(/\/+$/, "");
  try {
    if (new URL(t).protocol === "https:") return { ok: true, value: t };
  } catch {
    // falls through
  }
  return { ok: false, problem: `"${text.trim()}" isn't an https:// address. Your integrator gives you this.` };
}

/**
 * The client's name in the integrator's issues: letters, digits, `-`, `.`
 * and `_`, as the relay keeps them (relay/src/types.ts clientSlug), lowered.
 */
export function checkClientSlug(text: string): { ok: true; value: string } | { ok: false; problem: string } {
  const t = text.trim().toLowerCase();
  if (/^[a-z0-9][a-z0-9._-]{0,63}$/.test(t)) return { ok: true, value: t };
  return { ok: false, problem: `Use letters, numbers and dashes only (up to 64), like acme-cleaning.` };
}
