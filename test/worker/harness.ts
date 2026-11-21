/**
 * Drives the Worker as a black box: signed webhooks in, `scheduled` at an
 * injected clock, a fake Connecteam out.
 */
import { env, createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { createWorker } from "../../src/index.js";
import { FakeConnecteam, type FakeSubmission, type FakeTask } from "./fake-connecteam.js";

export const SECRET = "test-webhook-secret";
export const FORM_ID = 9001;
export const PUBLISHER_ID = 4242;
export const ALERTS_CHANNEL = "alerts-1";

export async function resetDb(): Promise<void> {
  await env.DB.batch(
    ["send_claims", "reminder_tasks", "shift_segments", "shifts", "manual_breaks", "webhook_deliveries", "sweep_clocks", "worker_state", "sweep_finds", "undelivered", "failure_alerts", "blocks"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
}

export function harness(settings: Partial<Record<string, string>> = {}) {
  const ct = new FakeConnecteam();
  let beforeCredit: (() => Promise<void>) | null = null;
  // Runs `beforeCredit` once, just before the next credit write reaches the database.
  const DB = new Proxy(env.DB, {
    get(db, key) {
      if (key !== "batch") {
        const v = Reflect.get(db, key, db);
        return typeof v === "function" ? v.bind(db) : v;
      }
      return async (statements: D1PreparedStatement[]) => {
        const sql = (statements[0] as { statement?: string } | undefined)?.statement ?? "";
        if (beforeCredit && sql.trimStart().startsWith("UPDATE shifts SET status = 'submitted'")) {
          const hook = beforeCredit;
          beforeCredit = null;
          await hook();
        }
        return db.batch(statements);
      };
    },
  });
  // The test Deployment's settings (vitest.config.ts), with any overrides.
  let workerEnv = { ...env, DB, ...settings } as typeof env;
  let arrival = 0;
  const worker = createWorker({ fetchImpl: ct.fetch, now: () => arrival });

  return {
    ct,

    /**
     * Run `hook` just before the Worker next credits a submission to a Shift,
     * after it has chosen which: for racing two credits of one submission.
     */
    beforeCredit(hook: () => Promise<void>) {
      beforeCredit = hook;
    },

    /** Change settings from now on, as rerunning a setup step and redeploying does. */
    configure(more: Partial<Record<string, string>>) {
      workerEnv = { ...workerEnv, ...more } as typeof env;
    },

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
        workerEnv,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return res;
    },

    /** Any request other than a webhook delivery, signed, with `payload` as its body when given. */
    async request(method: string, path: string, payload?: unknown) {
      const ctx = createExecutionContext();
      const body = payload === undefined ? null : JSON.stringify(payload);
      const res = await worker.fetch!(
        new Request(`https://worker.example${path}`, { method, body, headers: { "x-webhook-secret": SECRET } }) as Request<
          unknown,
          IncomingRequestCfProperties
        >,
        workerEnv,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return res;
    },

    /** Run the cron as if it fired at `atSeconds` (Unix seconds). */
    async tick(atSeconds: number) {
      const ctx = createExecutionContext();
      await worker.scheduled!(createScheduledController({ scheduledTime: atSeconds * 1000, cron: "* * * * *" }), workerEnv, ctx);
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
  /** Links the segment to its Scheduled Shift (#24). */
  schedulerShiftId?: string;
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
      ...(opts.schedulerShiftId !== undefined ? { schedulerShiftId: opts.schedulerShiftId } : {}),
      jobId: "job-1",
      shiftAttachments: [],
    },
  };
}

/**
 * A manual break delivery as Connecteam sends it (tested live 2026-10-21, #23):
 * the ordinary events with `activityType: "manual_break"` and the break type's
 * `manualBreakId`. Like any payload, it shows the record as it is when sent, so
 * a `clock_in` may already carry `end`.
 */
export function manualBreak(opts: {
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
    eventTimestamp: opts.eventType === "clock_in" ? opts.start : (opts.end ?? opts.start),
    webhookVersion: 1,
    userId: opts.userId,
    timeClockId: 67,
    activityType: "manual_break",
    eventType: opts.eventType,
    timeActivity: {
      id: opts.id,
      start: { timestamp: opts.start, timezone },
      ...(opts.end !== undefined ? { end: { timestamp: opts.end, timezone } } : {}),
      manualBreakId: "lunch-break",
      isAutoClockOut: false,
    },
  };
}

/** A delete delivery: it carries a bare `timeActivityId`, not a `timeActivity` (#2). */
export function deletion(opts: { eventType?: string; userId: number; id: string; at: number; requestId?: string }) {
  return {
    requestId: opts.requestId ?? `req-${++requests}`,
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

/**
 * A `task_completed` delivery as Connecteam sent it live on 2026-10-24 (#28):
 * `data` is an array, and nothing says who completed the task.
 */
export function taskCompleted(t: FakeTask, at: number, requestId?: string) {
  return {
    requestId: requestId ?? `req-${++requests}`,
    company: "demo",
    activityType: "Task",
    eventTimestamp: at,
    evnetTimestamp: at,
    eventType: "task_completed",
    data: [
      {
        id: t.id,
        taskBoardId: Number(t.boardId) || t.boardId,
        userIds: t.userIds,
        status: "completed",
        title: t.title,
        labelIds: [],
        type: "oneTime",
        isArchived: false,
      },
    ],
    webhookVersion: 1,
  };
}

/** A `form_submission` delivery as Connecteam sends it (#3): the submission sits in `data`. */
export function formSubmission(s: FakeSubmission, eventType = "form_submission", requestId?: string) {
  return {
    requestId: requestId ?? `req-${++requests}`,
    company: "demo",
    activityType: "forms",
    eventType,
    eventTimestamp: s.submissionTimestamp,
    data: {
      submissionTimezone: "Australia/Sydney",
      submissionStartTimestamp: s.submissionTimestamp - 60,
      entryNum: 1,
      isAnonymous: false,
      answers: [],
      ...s,
    },
  };
}
