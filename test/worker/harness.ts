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
  const worker = createWorker({ fetchImpl: ct.fetch });

  return {
    ct,

    async webhook(payload: unknown, headers: Record<string, string> = { "x-webhook-secret": SECRET }) {
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
      jobId: "job-1",
      shiftAttachments: [],
    },
  };
}
