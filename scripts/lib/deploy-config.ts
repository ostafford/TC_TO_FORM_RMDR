/*
 * Adapted from EH_Webhook (~/IDP/EH_Webhook/scripts/lib/deploy-config.ts at
 * 0c5ec92): the JSONC stripping, `.dev.vars` parsing and live comparison are
 * unchanged; the settings list and its checks are this project's (#19
 * "Settings and deployment"). Never import it from the sibling project.
 */
/**
 * Builds the config a deploy actually uses: the tracked `wrangler.jsonc`
 * template plus this Deployment's own values from the git-ignored `.dev.vars`.
 *
 * Why (playbook, ../CLAUDE.md): values written into the tracked config were
 * quietly reset to the template's blanks by ordinary git use, and a plain
 * `wrangler deploy` then pushed blank settings and a dead database id to the
 * live Worker. It deployed cleanly and then did nothing.
 *
 * Pure: no file or network access, so it is tested directly.
 */

/** The output file. Git-ignored; rebuilt on every deploy. */
export const DEPLOY_CONFIG_PATH = "wrangler.deploy.json";

/** The `.dev.vars` key holding this Deployment's D1 database id. */
export const DATABASE_ID_KEY = "D1_DATABASE_ID";

/** The template's stand-in for the database id: not a UUID, so a raw deploy fails before it changes anything. */
export const DATABASE_ID_PLACEHOLDER = "set-D1_DATABASE_ID-in-.dev.vars";

type Format = "number" | "minutes" | "switch" | "clock" | "zone" | "numberList" | "url" | "text";

interface SettingSpec {
  /** `var` goes into the config; `secret` is set with `wrangler secret put` and never copied. */
  kind: "var" | "secret";
  /** `true`, `false`, or required only when another setting says so. */
  required: boolean | ((values: Record<string, string>) => boolean);
  format: Format;
}

const isOn = (key: string) => (v: Record<string, string>) => v[key]?.trim() === "true";

/**
 * Every setting a Deployment has (#19 "Settings and deployment"). The
 * wizard fills these in; `.dev.vars.example` lists each one.
 */
export const SETTINGS = {
  CT_API_KEY: { kind: "secret", required: false, format: "text" },
  CT_WEBHOOK_SECRET: { kind: "secret", required: false, format: "text" },
  COMPLIANCE_FORM_ID: { kind: "var", required: true, format: "number" },
  SHIFT_DATE_QUESTION_ID: { kind: "var", required: false, format: "text" },
  WHERE_TO_FIND: { kind: "var", required: true, format: "text" },
  GRACE_PERIOD_MINUTES: { kind: "var", required: true, format: "minutes" },
  ESCALATION_DELAY_MINUTES: { kind: "var", required: true, format: "minutes" },
  QUIET_HOURS_ENABLED: { kind: "var", required: true, format: "switch" },
  QUIET_HOURS_FROM: { kind: "var", required: isOn("QUIET_HOURS_ENABLED"), format: "clock" },
  QUIET_HOURS_UNTIL: { kind: "var", required: isOn("QUIET_HOURS_ENABLED"), format: "clock" },
  TIME_ZONE: { kind: "var", required: true, format: "zone" },
  EXCLUDED_ADMIN_IDS: { kind: "var", required: false, format: "numberList" },
  REMINDER_TASK_ENABLED: { kind: "var", required: true, format: "switch" },
  TASK_BOARD_ID: { kind: "var", required: isOn("REMINDER_TASK_ENABLED"), format: "text" },
  CT_PUBLISHER_ID: { kind: "var", required: true, format: "number" },
  CT_PUBLISHER_NAME: { kind: "var", required: true, format: "text" },
  ALERTS_CHANNEL_ID: { kind: "var", required: true, format: "text" },
  INTEGRATOR_RELAY_URL: { kind: "var", required: false, format: "url" },
  INTEGRATOR_CLIENT_SLUG: { kind: "var", required: (v) => !!v.INTEGRATOR_RELAY_URL?.trim(), format: "text" },
  INTEGRATOR_RELAY_SECRET: { kind: "secret", required: false, format: "text" },
} satisfies Record<string, SettingSpec>;

export type SettingKey = keyof typeof SETTINGS;

const entries = Object.entries(SETTINGS) as Array<[SettingKey, SettingSpec]>;

/** The settings that go into the config's `vars`, in order. */
export const VAR_KEYS = entries.filter(([, s]) => s.kind === "var").map(([k]) => k);

/** The settings set with `wrangler secret put`. */
export const SECRET_KEYS = entries.filter(([, s]) => s.kind === "secret").map(([k]) => k);

/** What `.dev.vars` holds: the database id and every setting. */
export const DEV_VARS_KEYS: readonly string[] = [DATABASE_ID_KEY, ...entries.map(([k]) => k)];

const FORMAT_PROBLEM: Record<Format, { ok: (v: string) => boolean; says: string }> = {
  number: { ok: (v) => /^[1-9]\d*$/.test(v), says: "must be a number (an id from Connecteam)" },
  minutes: { ok: (v) => /^[1-9]\d*$/.test(v), says: "must be a whole number of minutes, 1 or more" },
  switch: { ok: (v) => v === "true" || v === "false", says: 'must be "true" or "false"' },
  clock: { ok: (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v), says: 'must be a 24-hour time like "21:00"' },
  zone: { ok: isTimeZone, says: 'must be a time zone name like "Australia/Sydney"' },
  numberList: { ok: (v) => /^[1-9]\d*(\s*,\s*[1-9]\d*)*$/.test(v), says: "must be user ids separated by commas" },
  url: { ok: isHttpsUrl, says: "must be an https:// address" },
  text: { ok: () => true, says: "" },
};

export interface SettingProblem {
  key: string;
  problem: string;
}

/** Each required value that's blank and each value in the wrong form, in settings order. */
export function checkSettings(devVars: Record<string, string>): SettingProblem[] {
  const problems: SettingProblem[] = [];
  const db = devVars[DATABASE_ID_KEY]?.trim() ?? "";
  if (!db || db === DATABASE_ID_PLACEHOLDER) {
    problems.push({ key: DATABASE_ID_KEY, problem: "missing (the id `npx wrangler d1 list` shows)" });
  }
  for (const [key, spec] of entries) {
    if (spec.kind !== "var") continue;
    const value = devVars[key]?.trim() ?? "";
    const required = typeof spec.required === "function" ? spec.required(devVars) : spec.required;
    if (!value) {
      if (required) problems.push({ key, problem: "missing" });
      continue;
    }
    const f = FORMAT_PROBLEM[spec.format];
    if (!f.ok(value)) problems.push({ key, problem: `${f.says}, not "${value}"` });
  }
  return problems;
}

/** Removes `//` and block comments and trailing commas, leaving string contents alone. */
export function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i === -1) break;
      i++;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** `KEY=VALUE` lines; `#` comments and blank lines skipped, surrounding quotes removed. */
export function parseDevVars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = unquote(line.slice(eq + 1).trim());
  }
  return out;
}

/**
 * A value as the setup wizard writes it (`'...'`, an apostrophe inside as
 * `'\''`), or as a hand-edited dotenv line writes it (`"..."` or bare).
 */
function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replaceAll("'\\''", "'");
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  return v;
}

export interface WranglerConfig {
  vars?: Record<string, string>;
  d1_databases?: Array<{ binding: string; database_id: string }>;
  [key: string]: unknown;
}

export type RenderResult =
  | { ok: true; config: WranglerConfig; databaseId: string; vars: Record<string, string> }
  | { ok: false; problems: SettingProblem[] };

/**
 * The template with this Deployment's values filled in. Every template var
 * takes its `.dev.vars` value; secrets are never copied. Fails, naming each
 * one, when the database id or a required value is blank or malformed.
 */
export function renderDeployConfig(templateText: string, devVars: Record<string, string>): RenderResult {
  const config = JSON.parse(stripJsonc(templateText)) as WranglerConfig;
  const db = config.d1_databases?.find((d) => d.binding === "DB");

  const problems = checkSettings(devVars);
  if (!db) problems.unshift({ key: "wrangler.jsonc", problem: "has no DB entry in d1_databases" });
  if (problems.length > 0) return { ok: false, problems };

  const vars = { ...(config.vars ?? {}) };
  for (const key of Object.keys(vars)) {
    if (SETTINGS[key as SettingKey]?.kind === "var") vars[key] = devVars[key]?.trim() ?? "";
  }
  const databaseId = devVars[DATABASE_ID_KEY]!.trim();
  db!.database_id = databaseId;
  return { ok: true, config: { ...config, vars }, databaseId, vars };
}

/** One binding as `wrangler versions view --json` lists it. */
export interface LiveBinding {
  name: string;
  type: string;
  text?: string;
  database_id?: string;
}

export interface LiveComparison {
  /** Set when the deploy would point the Worker at a different database. */
  databaseChange: { live: string; next: string } | null;
  /** Plain-text vars whose value the deploy would change. */
  varChanges: Array<{ name: string; live: string; next: string }>;
}

/** What a deploy of `rendered` would change on the live Worker (secrets are never compared). */
export function compareWithLive(
  rendered: { databaseId: string; vars: Record<string, string> },
  live: readonly LiveBinding[],
): LiveComparison {
  const liveDb = live.find((b) => b.type === "d1" && b.name === "DB")?.database_id;
  const liveVars = new Map(live.filter((b) => b.type === "plain_text").map((b) => [b.name, b.text ?? ""]));
  const varChanges = Object.entries(rendered.vars)
    .filter(([name, next]) => (liveVars.get(name) ?? "") !== next)
    .map(([name, next]) => ({ name, live: liveVars.get(name) ?? "", next }));
  return {
    databaseChange: liveDb && liveDb !== rendered.databaseId ? { live: liveDb, next: rendered.databaseId } : null,
    varChanges,
  };
}

/** Whether `zone` is an IANA time zone name this runtime knows; the wizard checks typed zones with it too. */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function isHttpsUrl(v: string): boolean {
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}
