/**
 * Sending to the Integrator Relay (#36): every Failure Alert and all clear,
 * and a daily check-in, so the integrator hears about a problem even when
 * Connecteam can't deliver it to the Alerts Channel. The relay is a separate
 * Worker (../../relay, #35); these bodies match its `relay/src/types.ts`,
 * kept as a copy since the two deploy apart.
 *
 * The result is checked like any send (playbook): `true` only on a 2xx. A
 * failed send never throws, and never touches the Alerts Channel post.
 */
import { httpJson } from "../http/json.js";

export interface RelaySettings {
  url: string;
  clientSlug: string;
  secret: string;
}

export type RelayPush =
  | { kind: "alert"; condition: string; state: "raised" | "cleared"; text: string }
  | { kind: "check_in" };

/** Sends one push; `true` when the relay took it. */
export type RelaySender = (push: RelayPush) => Promise<boolean>;

/** How long one push may take: a relay that hangs mustn't hold up the run. */
const RELAY_TIMEOUT_MS = 5_000;

export function relaySender(
  cfg: RelaySettings,
  opts: { now: number; fetchImpl?: typeof fetch; log?: (event: Record<string, unknown>) => void },
): RelaySender {
  return async (push) => {
    const r = await httpJson(
      {
        method: "POST",
        url: cfg.url,
        headers: { "x-relay-secret": cfg.secret },
        body: { ...push, client: cfg.clientSlug, at: new Date(opts.now * 1000).toISOString() },
      },
      opts.fetchImpl,
      RELAY_TIMEOUT_MS,
    );
    const ok = r.kind === "success";
    (opts.log ?? (() => {}))({
      evt: ok ? "relay_sent" : "relay_failed",
      kind: push.kind,
      ...("condition" in push ? { condition: push.condition, state: push.state } : {}),
      status: r.status,
      ...(r.kind === "retryable" ? { detail: r.detail } : {}),
    });
    return ok;
  };
}
