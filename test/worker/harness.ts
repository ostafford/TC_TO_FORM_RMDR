/**
 * Drives the Worker as a black box: signed webhooks in, `scheduled` at an
 * injected clock, a fake Connecteam out.
 */
import { env, createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { createWorker } from "../../src/index.js";
import { FakeConnecteam } from "./fake-connecteam.js";

export const SECRET = "test-webhook-secret";
export const FORM_ID = 9001;
export const PUBLISHER_ID = 4242;

export async function resetDb(): Promise<void> {
  await env.DB.batch(
    ["send_claims", "shift_segments", "shifts", "webhook_deliveries"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
}

export function harness() {
  const ct = new FakeConnecteam();
  let arrival = 0;
  const worker = createWorker({ fetchImpl: ct.fetch, now: () => arrival });

  return {
    ct,

    /**
     * Deliver a webhook. It arrives `at` (Unix seconds); by default a few
     * seconds after the payload's `eventTimestamp`, as a live delivery would.
     */
    async webhook(payload: unknown, opts: { at?: number; headers?: Record<string, string> } = {}) {
      const headers = opts.headers ?? { "x-webhook-secret": SECRET };
      const stamp = (payload as { eventTimestamp?: unknown } | null)?.eventTimestamp;
      arrival = opts.at ?? (typeof stamp === "number" ? stamp + 5 : Math.floor(Date.now() / 1000));
      const ctx = createExecutionContext();
      const body = typeof payload === "string" ? payload : JSON.stringify(payload);
      const res = await worker.fetch!(
        new Request("https://worker.example/webhook", { method: "POST", body, headers }) as Request<
          unknown,
          IncomingRequestCfProperties
        >,
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return res;
    },

    /** Run the cron as if it fired at `atSeconds` (Unix seconds). */
    async tick(atSeconds: number) {
      const ctx = createExecutionContext();
      await worker.scheduled!(createScheduledController({ scheduledTime: atSeconds * 1000, cron: "* * * * *" }), env, ctx);
      await waitOnExecutionContext(ctx);
    },
  };
}

let requests = 0;

/** A `time_activity` delivery as Connecteam sends it (#2). */
export function timeActivity(opts: {
  eventType: "clock_in" | "clock_out" | string;
  userId: number;
  id: string;
  start: number;
  end?: number;
  timezone?: string;
  requestId?: string;
  isAutoClockOut?: boolean;
}) {
  const timezone = opts.timezone ?? "Australia/Sydney";
  return {
    requestId: opts.requestId ?? `req-${++requests}`,
    company: "demo",
    eventTimestamp: opts.end ?? opts.start,
    webhookVersion: 1,
    userId: opts.userId,
    timeClockId: 67,
    activityType: "shift",
    eventType: opts.eventType,
    timeActivity: {
      id: opts.id,
      start: { timestamp: opts.start, timezone },
      ...(opts.end !== undefined ? { end: { timestamp: opts.end, timezone } } : {}),
      ...(opts.isAutoClockOut !== undefined ? { isAutoClockOut: opts.isAutoClockOut } : {}),
      jobId: "job-1",
      shiftAttachments: [],
    },
  };
}

/** A delete delivery: it carries a bare `timeActivityId`, not a `timeActivity` (#2). */
export function deletion(opts: { eventType?: string; userId: number; id: string; at: number }) {
  return {
    requestId: `req-${++requests}`,
    company: "demo",
    eventTimestamp: opts.at,
    webhookVersion: 1,
    userId: opts.userId,
    timeClockId: 67,
    activityType: "shift",
    eventType: opts.eventType ?? "admin_delete",
    timeActivityId: opts.id,
  };
}
