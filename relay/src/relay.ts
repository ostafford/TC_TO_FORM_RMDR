/*
 * Adapted from EH_Webhook (~/IDP/EH_Webhook/integrator-relay/src/relay.ts at
 * 0c5ec92): alerts are per condition, not per user, and check-ins are stored
 * so a Deployment that goes silent is noticed (#35).
 */
/**
 * The relay's whole decision, pure and injectable:
 *
 *   alert raised   -> one OPEN GitHub issue per (client, condition). The first
 *                     creates it; a repeat adds a comment. GitHub then emails
 *                     the integrator via issue notifications.
 *   alert cleared  -> the all clear: comment on that issue and close it; with
 *                     none open, nothing.
 *   check_in       -> store the time; if a missed-check-in issue is open for
 *                     the client, comment and close it.
 *   scheduled      -> open a missed-check-in issue for each client silent for
 *                     more than 36 hours, once.
 *
 * `forwardEmail` is an optional extra hop for integrators who want a direct
 * email rather than relying on GitHub notifications.
 */
import { RELAY_LABEL, type GitHubIssues } from "./github.js";
import { clientSlug, parseTelemetry, type AlertPush, type CheckInPush, type CheckInStore } from "./types.js";

export interface RelayDeps {
  gh: GitHubIssues;
  checkIns: CheckInStore;
  now: () => Date;
  forwardEmail?: (subject: string, text: string) => Promise<void>;
}

export interface RelayResult {
  status: number;
  body: Record<string, unknown>;
}

/** A Deployment that hasn't checked in for this long is reported. Its check-in is daily. */
export const MISSED_CHECK_IN_MS = 36 * 60 * 60 * 1000;

const LABELS_ALERT = [RELAY_LABEL, "failure-alert"];
const LABELS_MISSED = [RELAY_LABEL, "missed-check-in"];

/** Issue titles name the condition in words; an unknown one by its slug. */
const CONDITIONS: Record<string, string> = {
  messages: "messages not sending",
  sweep: "clock-out check failing",
  key: "paused, API key rejected",
  form: "Compliance Form not found",
  publisher: "sender not found",
  board: "task board not found",
  webhook: "clock-outs not arriving",
  allowance: "API allowance 80% used",
};

const alertTitle = (client: string, condition: string) =>
  `[clock-out reminder] ${CONDITIONS[condition] ?? condition} — ${client}`;
const missedTitle = (client: string) => `[clock-out reminder] missed check-in — ${client}`;

export async function handleTelemetry(rawBody: unknown, deps: RelayDeps): Promise<RelayResult> {
  const t = parseTelemetry(rawBody);
  if (!t) return { status: 400, body: { error: "unrecognised telemetry body" } };
  return t.kind === "alert" ? handleAlert(t, deps) : handleCheckIn(t, deps);
}

async function handleAlert(t: AlertPush, deps: RelayDeps): Promise<RelayResult> {
  const client = clientSlug(t.client);
  const title = alertTitle(client, t.condition);
  const existing = await deps.gh.findOpenByTitle(title);

  if (t.state === "cleared") {
    if (!existing) return { status: 202, body: { ok: true, noop: true } };
    await deps.gh.comment(existing.number, `All clear at ${t.at}.\n\n${quote(t.text)}`);
    await deps.gh.update(existing.number, { state: "closed" });
    return { status: 202, body: { ok: true, issue: existing.number, closed: true } };
  }

  if (existing) {
    await deps.gh.comment(existing.number, `Raised again at ${t.at}.\n\n${quote(t.text)}`);
    await forward(deps, title, `Raised again (${t.at})\n${existing.html_url}`);
    return { status: 202, body: { ok: true, issue: existing.number, deduped: true } };
  }
  const issue = await deps.gh.create({ title, body: alertBody(client, t, deps.now()), labels: LABELS_ALERT });
  await forward(deps, title, `${t.text}\n\n${issue.html_url}`);
  return { status: 202, body: { ok: true, issue: issue.number, deduped: false } };
}

async function handleCheckIn(t: CheckInPush, deps: RelayDeps): Promise<RelayResult> {
  const client = clientSlug(t.client);
  const was = await deps.checkIns.get(client);
  const now = deps.now().getTime();

  if (was?.flaggedAt != null) {
    const existing = await deps.gh.findOpenByTitle(missedTitle(client));
    if (existing) {
      await deps.gh.comment(existing.number, `Checked in again at ${t.at}.`);
      await deps.gh.update(existing.number, { state: "closed" });
    }
  }
  // Stored after the issue is closed, so a GitHub failure leaves it flagged and the next check-in closes it.
  await deps.checkIns.set(client, { lastAt: now, flaggedAt: null });
  return { status: 202, body: { ok: true, ...(was?.flaggedAt != null ? { closed: true } : {}) } };
}

/**
 * The scheduled check: open one missed-check-in issue for each Deployment
 * silent for more than 36 hours. One that fails to open is tried next time.
 */
export async function handleMissedCheckIns(deps: RelayDeps): Promise<{ opened: string[]; failed: string[] }> {
  const now = deps.now().getTime();
  const opened: string[] = [];
  const failed: string[] = [];
  for (const [client, r] of Object.entries(await deps.checkIns.all())) {
    if (r.flaggedAt !== null || now - r.lastAt <= MISSED_CHECK_IN_MS) continue;
    try {
      const title = missedTitle(client);
      const issue =
        (await deps.gh.findOpenByTitle(title)) ??
        (await deps.gh.create({ title, body: missedBody(client, r.lastAt, deps.now()), labels: LABELS_MISSED }));
      await deps.checkIns.set(client, { ...r, flaggedAt: now });
      await forward(deps, title, `No check-in since ${new Date(r.lastAt).toISOString()}\n${issue.html_url}`);
      opened.push(client);
    } catch {
      failed.push(client);
    }
  }
  return { opened, failed };
}

async function forward(deps: RelayDeps, subject: string, text: string): Promise<void> {
  if (!deps.forwardEmail) return;
  try {
    await deps.forwardEmail(subject, text);
  } catch {
    // the GitHub issue is already the source of truth; a failed email forward
    // must not fail the request.
  }
}

/** The alert's own text, as a quote, so its line breaks survive. */
function quote(text: string): string {
  return (text || "(no text)")
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
}

function alertBody(client: string, t: AlertPush, seen: Date): string {
  return [
    `**Client:** \`${client}\``,
    `**Condition:** \`${t.condition}\``,
    `**First raised:** ${t.at}`,
    "",
    quote(t.text),
    "",
    "The Deployment raised this Failure Alert and posted it to the client's",
    "Alerts Channel, if Connecteam could deliver it (a rejected API key or a",
    "missing publisher can't be). Repeats are added as comments; the all clear",
    "comments and closes this issue.",
    "",
    `_relayed ${seen.toISOString()}_`,
  ].join("\n");
}

function missedBody(client: string, lastAt: number, seen: Date): string {
  return [
    `**Client:** \`${client}\``,
    `**Last check-in:** ${new Date(lastAt).toISOString()}`,
    "",
    "This Deployment checks in once a day and hasn't for more than 36 hours.",
    "Its Worker may have stopped entirely: deleted, its cron trigger removed,",
    "its settings incomplete, or failing before it can report. Check the",
    "Worker in the client's Cloudflare account (`wrangler tail`). The next",
    "check-in comments and closes this issue. A Deployment torn down on purpose",
    "never checks in again: close this issue by hand.",
    "",
    `_relayed ${seen.toISOString()}_`,
  ].join("\n");
}
