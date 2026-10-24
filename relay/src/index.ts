/*
 * Adapted from EH_Webhook (~/IDP/EH_Webhook/integrator-relay/src/index.ts at
 * 0c5ec92): its own secret header, a check-in store, and a scheduled check.
 */
/**
 * This project's Integrator Relay (#35, spec #19). One standalone Worker the
 * integrator hosts once, outside every Deployment and never shared with
 * EH_Webhook. It receives the Failure Alerts and daily check-ins a Deployment
 * sends when INTEGRATOR_RELAY_URL is set (#36), and turns them into GitHub
 * issues on this repo (and, optionally, an email webhook), so the integrator
 * hears about a problem even when Connecteam can't deliver it. An hourly cron
 * notices a Deployment that has stopped checking in.
 *
 * Routes:
 *   POST /        - a telemetry push. Requires `x-relay-secret: RELAY_SECRET`.
 *   GET  /health  - the relay's own liveness check.
 */
import { checkInStore, type CheckIns } from "./checkIns.js";
import { GitHubRestIssues } from "./github.js";
import { handleMissedCheckIns, handleTelemetry, type RelayDeps } from "./relay.js";

export { CheckIns } from "./checkIns.js";

export interface Env {
  /** Shared secret; every Deployment's INTEGRATOR_RELAY_SECRET must equal this. */
  RELAY_SECRET: string;
  /** Fine-grained PAT, Issues: Read and write on GITHUB_REPO. Only lives here. */
  GITHUB_TOKEN: string;
  /** "owner/name" of the repo that receives the issues. */
  GITHUB_REPO: string;
  /** Optional: also POST a compact alert here (Zapier / Make / SMTP bridge). */
  EMAIL_WEBHOOK_URL?: string;
  CHECK_INS: DurableObjectNamespace<CheckIns>;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const log = (event: Record<string, unknown>) => console.log(JSON.stringify(event));

function deps(env: Env): RelayDeps {
  const forwardEmail = env.EMAIL_WEBHOOK_URL ? mkEmailForward(env.EMAIL_WEBHOOK_URL) : undefined;
  return {
    gh: new GitHubRestIssues({ repo: env.GITHUB_REPO, token: env.GITHUB_TOKEN }),
    checkIns: checkInStore(env.CHECK_INS),
    now: () => new Date(),
    ...(forwardEmail ? { forwardEmail } : {}),
  };
}

export default {
  async fetch(req, env): Promise<Response> {
    const { pathname } = new URL(req.url);

    if (req.method === "GET" && pathname === "/health") {
      return json(200, { ok: true, service: "clock-out-form-reminder-relay" });
    }
    if (req.method !== "POST") {
      return json(405, { error: "POST only" });
    }
    if (!env.RELAY_SECRET || req.headers.get("x-relay-secret") !== env.RELAY_SECRET) {
      return json(401, { error: "missing or invalid x-relay-secret" });
    }
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
      return json(500, { error: "relay not configured: GITHUB_TOKEN / GITHUB_REPO" });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "invalid JSON body" });
    }

    try {
      const r = await handleTelemetry(body, deps(env));
      return json(r.status, r.body);
    } catch (err) {
      // The Deployment treats any non-2xx as failed and moves on; log it for `wrangler tail`.
      log({ evt: "relay_failed", detail: String(err) });
      return json(502, { error: "relay upstream failure", detail: String(err) });
    }
  },

  async scheduled(_controller, env): Promise<void> {
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return log({ evt: "missed_check_ins", skipped: "not configured" });
    log({ evt: "missed_check_ins", ...(await handleMissedCheckIns(deps(env))) });
  },
} satisfies ExportedHandler<Env>;

/** POST a compact `{ subject, text }` to an external email webhook. */
function mkEmailForward(url: string) {
  return async (subject: string, text: string): Promise<void> => {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject, text }),
    });
  };
}
