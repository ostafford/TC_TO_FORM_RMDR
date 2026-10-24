/*
 * Adapted from EH_Webhook (~/IDP/EH_Webhook/integrator-relay/src/types.ts at
 * 0c5ec92): EH_Webhook's `system_alert` (one per Connecteam user) and
 * `health` pushes become this project's `alert` (one per condition) and
 * `check_in`.
 */
/**
 * What a Deployment POSTs here (#36 sends them). Never staff names: the
 * issues are on a public repo, so the Deployment sends its alerts with counts
 * in place of names (the Alerts Channel keeps the names).
 *
 *  - `alert`: a Failure Alert (`state: "raised"`) or its all clear
 *    (`"cleared"`), with the same text the Alerts Channel gets.
 *  - `check_in`: the once-a-day "still running".
 */

export interface AlertPush {
  kind: "alert";
  /** The Deployment's client slug (INTEGRATOR_CLIENT_SLUG). "" / missing -> "unknown-client". */
  client: string;
  /** The Failure Alert condition, e.g. `messages`, `key`, `webhook`. */
  condition: string;
  state: "raised" | "cleared";
  /** The alert's or the all clear's text, as posted to the Alerts Channel. */
  text: string;
  /** ISO timestamp from the Deployment. */
  at: string;
}

export interface CheckInPush {
  kind: "check_in";
  client: string;
  at: string;
}

export type Telemetry = AlertPush | CheckInPush;

/** A condition is a short lowercase slug; anything else isn't one of ours. */
const CONDITION = /^[a-z][a-z_]{0,31}$/;

/** The longest alert text kept: the Deployment's own messages stop at 500 characters. */
const MAX_TEXT = 2000;

/** Narrow an untrusted body to a Telemetry, or null if it isn't one. */
export function parseTelemetry(body: unknown): Telemetry | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const client = typeof b.client === "string" ? b.client : "";
  const at = typeof b.at === "string" ? b.at : new Date().toISOString();

  if (b.kind === "alert") {
    if (typeof b.condition !== "string" || !CONDITION.test(b.condition)) return null;
    if (b.state !== "raised" && b.state !== "cleared") return null;
    const text = typeof b.text === "string" ? b.text.slice(0, MAX_TEXT) : "";
    return { kind: "alert", client, condition: b.condition, state: b.state, text, at };
  }
  if (b.kind === "check_in") return { kind: "check_in", client, at };
  return null;
}

/** "" / whitespace / missing -> a stable placeholder. Kept short and plain, as it goes in an issue title. */
export function clientSlug(client: string | undefined): string {
  const s = (client ?? "").trim().replace(/[^\w.-]+/g, "-").slice(0, 64);
  return s || "unknown-client";
}

/** One Deployment's check-ins, kept by the relay (./checkIns.ts). Times are epoch milliseconds. */
export interface CheckInRecord {
  lastAt: number;
  /** When its missed-check-in issue was opened, or null while it's checking in. */
  flaggedAt: number | null;
}

export interface CheckInStore {
  get(client: string): Promise<CheckInRecord | null>;
  set(client: string, record: CheckInRecord): Promise<void>;
  all(): Promise<Record<string, CheckInRecord>>;
}
