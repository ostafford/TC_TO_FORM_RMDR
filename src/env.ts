/**
 * Worker bindings. Secrets come from `wrangler secret put`; the rest are the
 * Deployment's settings, kept in .dev.vars and built into the config at deploy
 * (the tracked wrangler.jsonc stays a blank template).
 */
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

  const settings: Settings = {
    apiKey: text("CT_API_KEY"),
    webhookSecret: text("CT_WEBHOOK_SECRET"),
    complianceFormId: whole("COMPLIANCE_FORM_ID"),
    publisherId: whole("CT_PUBLISHER_ID"),
    whereToFind: text("WHERE_TO_FIND"),
    gracePeriodMinutes: whole("GRACE_PERIOD_MINUTES"),
    escalationDelayMinutes: whole("ESCALATION_DELAY_MINUTES"),
    timeZone: text("TIME_ZONE"),
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
