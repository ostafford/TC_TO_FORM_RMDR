/**
 * The Deployment Worker (ADR-0002): `fetch` takes Connecteam's webhooks and
 * makes no Connecteam calls; a one-minute cron does every step that is due.
 */
import { ConnecteamClient } from "./connecteam/client.js";
import { DEFAULT_SCHEME, verifyWebhookSignature } from "./connecteam/signature.js";
import { runDueSteps } from "./cron/dueSteps.js";
import { creditSubmission } from "./crediting/credit.js";
import { creditRules, readSettings, type Env } from "./env.js";
import { WorkList } from "./store.js";
import { isFormsDelivery, parseFormSubmissionDelivery } from "./webhook/formSubmission.js";
import { parseTimeActivityDelivery } from "./webhook/timeActivity.js";

export interface WorkerOptions {
  /** Where Connecteam calls go. Tests put a fake Connecteam here. */
  fetchImpl?: typeof fetch;
  /** When a webhook arrives, in Unix seconds. Tests set it; the 24-hour rule (#22) reads it. */
  now?: () => number;
}

const log = (event: Record<string, unknown>) => console.log(JSON.stringify(event));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function createWorker(opts: WorkerOptions = {}): ExportedHandler<Env> {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/webhook") return json(404, { error: "not found" });

      const rawBody = await request.text();
      const secret = (env.CT_WEBHOOK_SECRET ?? "").trim();
      if (!secret) return json(500, { error: "webhook secret not configured" });
      const signed = await verifyWebhookSignature(rawBody, request.headers.get(DEFAULT_SCHEME.header), secret);
      if (!signed) return json(401, { error: "invalid or missing signature" });

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return json(400, { error: "malformed JSON body" });
      }

      const store = new WorkList(env.DB);
      const now = opts.now ? opts.now() : Math.floor(Date.now() / 1000);

      if (isFormsDelivery(payload)) {
        const form = parseFormSubmissionDelivery(payload);
        if (form.kind === "malformed") return json(400, { error: "not a form submission delivery" });
        await store.recordDelivery(form, now);
        if (form.kind === "ignored") return json(200, { ok: true });
        const settings = readSettings(env);
        if (!settings.ok) {
          log({ evt: "webhook", status: 500, problems: settings.problems });
          return json(500, { error: "settings incomplete" });
        }
        // A late submission cancels the Escalation as soon as it arrives.
        const shiftId = await creditSubmission(store, form.submission, creditRules(settings.settings), now);
        log({ evt: "webhook", status: 200, eventType: form.eventType, userId: form.userId, creditedTo: shiftId });
        return json(200, { ok: true });
      }

      const delivery = parseTimeActivityDelivery(payload);
      if (delivery.kind === "malformed") return json(400, { error: "not a time activity delivery" });

      if (delivery.kind === "ignored") {
        await store.recordDelivery(delivery, now);
        return json(200, { ok: true });
      }
      if (delivery.kind === "deleted") {
        await store.deleteSegment(delivery, now);
        log({ evt: "webhook", status: 200, eventType: delivery.eventType, userId: delivery.userId });
        return json(200, { ok: true });
      }

      // The Grace Period and accepted forms are fixed for the Shift when its end
      // is recorded, so a later settings change doesn't move a scheduled step.
      const settings = readSettings(env);
      if (!settings.ok) {
        log({ evt: "webhook", status: 500, problems: settings.problems });
        return json(500, { error: "settings incomplete" });
      }
      await store.recordSegment(delivery, {
        formIds: [settings.settings.complianceFormId],
        gracePeriodMinutes: settings.settings.gracePeriodMinutes,
        now,
      });
      log({ evt: "webhook", status: 200, eventType: delivery.eventType, userId: delivery.userId });
      return json(200, { ok: true });
    },

    async scheduled(controller, env) {
      const settings = readSettings(env);
      if (!settings.ok) {
        log({ evt: "cron", skipped: "settings incomplete", problems: settings.problems });
        return;
      }
      const s = settings.settings;
      const ct = new ConnecteamClient({
        apiKey: s.apiKey,
        customPublisherId: s.publisherId,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
      const result = await runDueSteps({
        store: new WorkList(env.DB),
        ct,
        settings: s,
        now: Math.floor(controller.scheduledTime / 1000),
        log,
      });
      log({ evt: "cron", ...result });
    },
  };
}

export default createWorker();
