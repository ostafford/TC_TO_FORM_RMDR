/**
 * Worker bindings. Secrets come from `wrangler secret put`; the rest are the
 * Deployment's settings, kept in .dev.vars and built into the config at deploy
 * (the tracked wrangler.jsonc stays a blank template).
 */
import type { CreditRules } from "./crediting/choose.js";

export interface Env {
  DB: D1Database;

  // secrets
  CT_API_KEY: string;
  CT_WEBHOOK_SECRET: string;

  // settings
  COMPLIANCE_FORM_ID: string;
  CT_PUBLISHER_ID: string;
  WHERE_TO_FIND: string;
  GRACE_PERIOD_MINUTES: string;
  ESCALATION_DELAY_MINUTES: string;
  TIME_ZONE: string;
  /** Optional: user ids, comma-separated. */
  EXCLUDED_ADMIN_IDS?: string;
  /** Optional: the Compliance Form's date question naming the Shift a submission is for. */
  SHIFT_DATE_QUESTION_ID?: string;
}

export interface Settings {
  apiKey: string;
  webhookSecret: string;
  complianceFormId: number;
  publisherId: number;
  whereToFind: string;
  gracePeriodMinutes: number;
  escalationDelayMinutes: number;
  timeZone: string;
  /** Admins who don't get Escalations, unless they are the employee's direct manager. */
  excludedAdminIds: number[];
  /** The Shift Date Question's id, or blank when none is configured. */
  shiftDateQuestionId: string;
}

/** The Deployment's settings, or the names of the ones that are missing or malformed. */
export function readSettings(env: Env): { ok: true; settings: Settings } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const text = (name: keyof Env): string => {
    const v = String(env[name] ?? "").trim();
    if (!v) problems.push(name);
    return v;
  };
  const whole = (name: keyof Env): number => {
    const v = text(name);
    const n = Number(v);
    if (v && !(Number.isInteger(n) && n > 0)) problems.push(name);
    return n;
  };

  const idList = (name: keyof Env): number[] => {
    const v = String(env[name] ?? "").trim();
    if (!v) return [];
    const ids = v.split(",").map((x) => Number(x.trim()));
    if (!ids.every((n) => Number.isInteger(n) && n > 0)) problems.push(name);
    return ids;
  };

  const settings: Settings = {
    apiKey: text("CT_API_KEY"),
    webhookSecret: text("CT_WEBHOOK_SECRET"),
    complianceFormId: whole("COMPLIANCE_FORM_ID"),
    publisherId: whole("CT_PUBLISHER_ID"),
    whereToFind: text("WHERE_TO_FIND"),
    gracePeriodMinutes: whole("GRACE_PERIOD_MINUTES"),
    escalationDelayMinutes: whole("ESCALATION_DELAY_MINUTES"),
    timeZone: text("TIME_ZONE"),
    excludedAdminIds: idList("EXCLUDED_ADMIN_IDS"),
    shiftDateQuestionId: String(env.SHIFT_DATE_QUESTION_ID ?? "").trim(),
  };
  if (settings.timeZone && !isTimeZone(settings.timeZone)) problems.push("TIME_ZONE");

  return problems.length ? { ok: false, problems } : { ok: true, settings };
}

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The crediting rules (#26) these settings give. */
export function creditRules(s: Settings): CreditRules {
  return { shiftDateQuestionId: s.shiftDateQuestionId, complianceFormId: s.complianceFormId, deploymentZone: s.timeZone };
}
