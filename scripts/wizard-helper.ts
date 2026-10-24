/**
 * `npm run --silent wizard-helper -- WHAT ...`: what the setup wizard's form
 * and timing steps (#38) can't do in Bash. Each prints plain lines for the
 * wizard to show or read, tab-separated where it reads fields.
 *
 * Reading Connecteam (the key comes from CT_API_KEY in the environment, never
 * an argument, so it isn't in the process list or the session log):
 *   time-zones        each live time clock's zone:     ZONE <tab> CLOCK NAME
 *   forms             the account's forms, in order:   FORM ID <tab> LABEL
 *   form ID           one form: `name <tab> NAME`, then `warning <tab> TEXT`
 *                     and `date <tab> QUESTION ID <tab> TITLE` lines
 *
 * Checking what the person typed (prints the value as saved, or the problem):
 *   zone TEXT | duration grace|delay TEXT | clock TEXT | where TEXT
 *
 * The worked examples (#18), one line each:
 *   grace-example GRACE | delay-timeline GRACE DELAY
 *   quiet-example GRACE DELAY [FROM UNTIL]      (minutes; "HH:MM"; none is off)
 *   clock-label HH:MM | duration-label MINUTES
 *
 * Exit: 0 done, 1 what was typed won't do (the reason is printed), 3 the key
 * was rejected, 4 Connecteam couldn't be read.
 *
 * CT_API_BASE replaces https://api.connecteam.com, for the wizard's tests.
 */
import { isTimeZone } from "./lib/deploy-config.js";
import { dateQuestions, formLabels, formWarnings, plainText, zoneOfSettings, type ApiForm } from "./lib/wizard-forms.js";
import {
  MAX_DELAY_MINUTES,
  MAX_GRACE_MINUTES,
  clockLabel,
  delayTimeline,
  graceExample,
  normaliseWhere,
  parseClockInput,
  parseDuration,
  quietExample,
} from "./lib/wizard-values.js";
import { formatDuration } from "../src/messages/format.js";

class Stop extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const FORMS_PAGE = 300; // the most `GET /forms/v1/forms` returns at once

async function get(path: string): Promise<unknown> {
  const key = (process.env.CT_API_KEY ?? "").trim();
  if (!key) throw new Stop(4, "No API key saved yet. Run the key step first: npm run setup -- --step key");
  const base = (process.env.CT_API_BASE ?? "https://api.connecteam.com").replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { headers: { "X-API-KEY": key, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new Stop(4, `Couldn't reach Connecteam (${err instanceof Error ? err.message : String(err)}).`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Stop(3, "Connecteam didn't accept the API key. Rerun the key step: npm run setup -- --step key");
  }
  if (!res.ok) throw new Stop(4, `Connecteam answered HTTP ${res.status} for ${path.split("?")[0]}.`);
  return res.json();
}

async function timeZones(): Promise<string[]> {
  const body = (await get("/time-clock/v1/time-clocks")) as { data?: { timeClocks?: { id: number; name: string; isArchived: boolean }[] } };
  const clocks = (body.data?.timeClocks ?? []).filter((c) => !c.isArchived);
  if (clocks.length === 0) throw new Stop(4, "This account has no time clock in use.");
  const lines: string[] = [];
  for (const c of clocks) {
    const zone = zoneOfSettings(await get(`/time-clock/v1/time-clocks/${c.id}/settings`));
    if (zone) lines.push(`${zone}\t${plainText(c.name)}`);
  }
  if (lines.length === 0) throw new Stop(4, "Connecteam didn't say which time zone the time clock uses.");
  return lines;
}

async function forms(): Promise<string[]> {
  const all: ApiForm[] = [];
  // `paging.offset` comes back even on the last page (tested live 2026-10-24), so stop on a short page.
  for (let offset = 0; ; offset += FORMS_PAGE) {
    const body = (await get(`/forms/v1/forms?limit=${FORMS_PAGE}&offset=${offset}`)) as { data?: { forms?: ApiForm[] } };
    const page = body.data?.forms ?? [];
    all.push(...page);
    if (page.length < FORMS_PAGE) break;
  }
  if (all.length === 0) throw new Stop(4, "This account has no forms yet. Create the Compliance Form in Connecteam (Forms), then rerun: npm run setup -- --step form");
  const labels = formLabels(all);
  return all.map((f, i) => `${f.formId}\t${labels[i]}`);
}

async function form(id: string): Promise<string[]> {
  if (!/^[1-9]\d*$/.test(id)) throw new Stop(1, `"${id}" isn't a form id.`);
  const f = ((await get(`/forms/v1/forms/${id}`)) as { data: ApiForm }).data;
  return [
    `name\t${plainText(f.formName)}`,
    ...formWarnings(f).map((w) => `warning\t${w}`),
    ...dateQuestions(f).map((q) => `date\t${q.questionId}\t${q.title}`),
  ];
}

function minutesArg(v: string | undefined): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Stop(1, `"${v ?? ""}" isn't a number of minutes.`);
  return n;
}

function zone(text: string): string[] {
  const t = text.trim();
  if (!t || !isTimeZone(t)) throw new Stop(1, `"${t}" isn't a time zone name. Use one like Australia/Sydney or Pacific/Auckland.`);
  return [new Intl.DateTimeFormat("en-AU", { timeZone: t }).resolvedOptions().timeZone];
}

function duration(kind: string | undefined, text: string): string[] {
  if (kind !== "grace" && kind !== "delay") throw new Stop(1, "duration needs grace or delay");
  const unit = kind === "grace" ? "minutes" : "hours";
  const max = kind === "grace" ? MAX_GRACE_MINUTES : MAX_DELAY_MINUTES;
  const m = parseDuration(text, unit);
  if (m === null) {
    throw new Stop(1, kind === "grace" ? `"${text.trim()}" isn't a number of minutes. Type one like 30, or 1h 30m.` : `"${text.trim()}" isn't a number of hours. Type one like 4, 1.5 or 90m.`);
  }
  if (m > max) throw new Stop(1, `That's longer than ${formatDuration(max)}, the most this setting takes.`);
  return [String(m)];
}

function clock(text: string): string[] {
  const c = parseClockInput(text);
  if (c === null) throw new Stop(1, `"${text.trim()}" isn't a time. Type one like 9 pm, 7:30 am or 21:00.`);
  return [c];
}

function where(text: string): string[] {
  const w = normaliseWhere(text);
  if (!w.ok) throw new Stop(1, w.problem);
  return [w.value];
}

async function main(args: string[]): Promise<string[]> {
  const [what, ...rest] = args;
  switch (what) {
    case "time-zones":
      return timeZones();
    case "forms":
      return forms();
    case "form":
      return form(rest[0] ?? "");
    case "zone":
      return zone(rest[0] ?? "");
    case "duration":
      return duration(rest[0], rest[1] ?? "");
    case "clock":
      return clock(rest[0] ?? "");
    case "where":
      return where(rest[0] ?? "");
    case "grace-example":
      return graceExample(minutesArg(rest[0]));
    case "delay-timeline":
      return delayTimeline(minutesArg(rest[0]), minutesArg(rest[1]));
    case "quiet-example": {
      const [g, d, from, until] = rest;
      const quiet = from && until ? { from: clock(from)[0]!, until: clock(until)[0]! } : null;
      return quietExample(minutesArg(g), minutesArg(d), quiet);
    }
    case "clock-label":
      return [clockLabel(clock(rest[0] ?? "")[0]!)];
    case "duration-label":
      return [formatDuration(minutesArg(rest[0]))];
    default:
      throw new Stop(1, `unknown: ${what ?? "(nothing)"}`);
  }
}

try {
  for (const line of await main(process.argv.slice(2))) console.log(line);
} catch (err) {
  if (!(err instanceof Stop)) throw err;
  console.log(err.message);
  process.exit(err.code);
}
