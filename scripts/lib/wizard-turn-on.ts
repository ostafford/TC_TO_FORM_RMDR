/**
 * The setup wizard's last steps (#40, user stories 47 and 50): the settings
 * summary, the Connecteam webhook subscriptions "Turn it on" makes, and the
 * test Reminder's sample Shift. Pure, so the rules are tested without a
 * network or a Cloudflare account.
 *
 * Webhook shapes per the docs (time activity, forms and tasks webhook pages,
 * create and list references), not tested live: `POST /settings/v1/webhooks`
 * takes `{ name, url, featureType, entityId, eventTypes, secretKey,
 * isDisabled }` and returns `data.id`; `PUT .../{id}` takes the same body (as
 * EH_Webhook's wizard sends it); `GET /settings/v1/webhooks` lists
 * `data.webhooks[]`, 10 a page unless asked. A tasks subscription scoped to a
 * board by `entityId` was tested live 2026-10-24 (#28).
 */
import { checkSettings, type SettingProblem } from "./deploy-config.js";
import { onLocalDay } from "../../src/escalation/quietHours.js";
import type { ShiftTimes } from "../../src/messages/format.js";

/**
 * The time clock events the Worker acts on (src/webhook/timeActivity.ts):
 * every way a Shift Segment is saved, ended or deleted. Not the `user_*_request`
 * and `admin_declined_*` asks, which carry requested times (#19), nor the
 * timesheet events.
 */
export const TIME_ACTIVITY_EVENTS = [
  "clock_in",
  "clock_out",
  "auto_clock_out",
  "admin_add",
  "admin_edit",
  "admin_delete",
  "admin_approved_add_request",
  "admin_approved_edit_request",
  "admin_approved_delete_request",
  "admin_approved_clock_out_outside_geo_fence_request",
  "admin_approved_clock_out_without_nfc_request",
  "auto_approved_add_request",
  "auto_approved_edit_request",
  "auto_approved_delete_request",
  "auto_approved_clock_out_outside_geo_fence_request",
  "auto_approved_clock_out_without_nfc_request",
] as const;

export interface WebhookBody {
  name: string;
  url: string;
  featureType: "time_activity" | "forms" | "tasks";
  /** `null` is every time clock (a broadcast subscription). */
  entityId: string | null;
  eventTypes: string[];
  secretKey: string;
  isDisabled: false;
}

/** A subscription as `GET /settings/v1/webhooks` lists it: the fields read here. */
export interface ExistingWebhook {
  id: number | string;
  name?: string;
  url?: string;
  featureType?: string;
}

/**
 * This Deployment's three subscriptions (#19 step 17): `time_activity` on
 * every clock, `form_submission` on the Compliance Form only, and
 * `task_completed` on the task board, when there is one. The board's kept
 * even with the Reminder Task off, so tasks already made finish their
 * lifecycle (#19, user story 56).
 */
/** Every subscription "Turn it on" makes is named starting with this. */
export const WEBHOOK_NAME_PREFIX = "Clock-out Form Reminder: ";

export function wantedWebhooks(url: string, secret: string, v: Record<string, string>): WebhookBody[] {
  const base = { url, secretKey: secret, isDisabled: false as const };
  const out: WebhookBody[] = [
    { ...base, name: `${WEBHOOK_NAME_PREFIX}clock-outs`, featureType: "time_activity", entityId: null, eventTypes: [...TIME_ACTIVITY_EVENTS] },
    { ...base, name: `${WEBHOOK_NAME_PREFIX}form submissions`, featureType: "forms", entityId: v.COMPLIANCE_FORM_ID?.trim() ?? "", eventTypes: ["form_submission"] },
  ];
  const board = v.TASK_BOARD_ID?.trim();
  if (board) out.push({ ...base, name: `${WEBHOOK_NAME_PREFIX}ticked tasks`, featureType: "tasks", entityId: board, eventTypes: ["task_completed"] });
  return out;
}

export interface WebhookPlan {
  update: { id: string; body: WebhookBody }[];
  create: WebhookBody[];
  /** This Deployment's own extras: repeats from earlier runs, or a kind no longer wanted. */
  remove: string[];
}

/**
 * What to do so Connecteam holds exactly `wanted` for this Deployment. Only
 * subscriptions whose `url` is this Worker's are this Deployment's: anything
 * else on the account belongs to another integration and is never touched. A
 * second `POST` would deliver every event twice (EH_Webhook #82), so one
 * already there is updated instead.
 */
export function planWebhooks(existing: ExistingWebhook[], wanted: WebhookBody[], url: string): WebhookPlan {
  const ours = existing.filter((w) => w.url === url);
  const plan: WebhookPlan = { update: [], create: [], remove: [] };
  const used = new Set<string>();
  for (const body of wanted) {
    const match = ours.find((w) => w.featureType === body.featureType && !used.has(String(w.id)));
    if (match) {
      used.add(String(match.id));
      plan.update.push({ id: String(match.id), body });
    } else {
      plan.create.push(body);
    }
  }
  plan.remove = ours.map((w) => String(w.id)).filter((id) => !used.has(id));
  return plan;
}

/** The settings still missing or malformed before anything goes live: all but the database id, which "Turn it on" makes. */
export function settingProblems(v: Record<string, string>): SettingProblem[] {
  return checkSettings({ ...v, D1_DATABASE_ID: "turn-it-on-makes-this" }).filter((p) => p.key !== "D1_DATABASE_ID");
}

/** The step that sets each setting (#19's `--step` names), for "rerun …" hints. */
export const STEP_OF: Record<string, string> = {
  COMPLIANCE_FORM_ID: "form",
  SHIFT_DATE_QUESTION_ID: "form",
  WHERE_TO_FIND: "form",
  GRACE_PERIOD_MINUTES: "timings",
  ESCALATION_DELAY_MINUTES: "timings",
  QUIET_HOURS_ENABLED: "quiet-hours",
  QUIET_HOURS_FROM: "quiet-hours",
  QUIET_HOURS_UNTIL: "quiet-hours",
  TIME_ZONE: "timezone",
  EXCLUDED_ADMIN_IDS: "recipients",
  REMINDER_TASK_ENABLED: "reminder-task",
  TASK_BOARD_ID: "reminder-task",
  CT_PUBLISHER_ID: "sender",
  CT_PUBLISHER_NAME: "sender",
  ALERTS_CHANNEL_ID: "alerts",
  INTEGRATOR_RELAY_URL: "support",
  INTEGRATOR_CLIENT_SLUG: "support",
};

/** "Time zone ............ Australia/Sydney": one summary row, the dots lining the values up. */
export function summaryRow(label: string, value: string): string {
  return `${label} ${".".repeat(Math.max(3, 22 - label.length))} ${value}`;
}

/** The test Reminder's sample Shift: 9:00 am to 5:00 pm on today's date in the Deployment's zone. */
export function sampleShift(nowSeconds: number, zone: string): ShiftTimes {
  return { startSeconds: onLocalDay(nowSeconds, zone, 9 * 60), endSeconds: onLocalDay(nowSeconds, zone, 17 * 60), timeZone: zone };
}
