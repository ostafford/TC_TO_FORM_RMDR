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
 *   people            `admin <tab> USER ID <tab> LABEL` per Admin, then one
 *                     `direct <tab> LINE` saying whether direct managers are used
 *   boards            live task boards:                BOARD ID <tab> NAME
 *   publishers        custom publishers:               PUBLISHER ID <tab> NAME
 *   channels          chats (not private ones):        CONVERSATION ID <tab> LABEL
 *   create-channel TITLE USER,ID,...   a new channel with those members: its id
 *
 * Checking what the person typed (prints the value as saved, or the problem):
 *   zone TEXT | duration grace|delay TEXT | clock TEXT | where TEXT
 *   relay-url TEXT | slug TEXT | automated NAME (exit 1 when it doesn't sound automated)
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
import type { ConnecteamUser, Conversation } from "../src/connecteam/types.js";
import {
  adminRows,
  checkClientSlug,
  checkRelayUrl,
  conversationLabels,
  directManagerLine,
  directManagers,
  soundsAutomated,
} from "./lib/wizard-people.js";

class Stop extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

// The most one page returns: `GET /forms/v1/forms`, `/users/v1/users`, and
// `/publishers/v1/publishers` and `/chat/v1/conversations`.
const FORMS_PAGE = 300;
const USERS_PAGE = 500;
const SMALL_PAGE = 100;

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
  const key = (process.env.CT_API_KEY ?? "").trim();
  if (!key) throw new Stop(4, "No API key saved yet. Run the key step first: npm run setup -- --step key");
  const base = (process.env.CT_API_BASE ?? "https://api.connecteam.com").replace(/\/+$/, "");
  try {
    return await fetch(`${base}${path}`, {
      method,
      headers: { "X-API-KEY": key, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new Stop(4, `Couldn't reach Connecteam (${err instanceof Error ? err.message : String(err)}).`);
  }
}

async function get(path: string): Promise<unknown> {
  const res = await call("GET", path);
  if (res.status === 401 || res.status === 403) {
    throw new Stop(3, "Connecteam didn't accept the API key. Rerun the key step: npm run setup -- --step key");
  }
  if (!res.ok) throw new Stop(4, `Connecteam answered HTTP ${res.status} for ${path.split("?")[0]}.`);
  return res.json();
}

/** Every row of a paged list, `limit` at a time, stopping on a short page (`paging.offset` comes back even on the last one). */
async function allPages<T>(path: string, limit: number, rows: (body: unknown) => T[] | undefined): Promise<T[]> {
  const all: T[] = [];
  for (let offset = 0; ; offset += limit) {
    const page = rows(await get(`${path}${path.includes("?") ? "&" : "?"}limit=${limit}&offset=${offset}`)) ?? [];
    all.push(...page);
    if (page.length < limit) return all;
  }
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
  const all = await allPages("/forms/v1/forms", FORMS_PAGE, (b) => (b as { data?: { forms?: ApiForm[] } }).data?.forms);
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

async function people(): Promise<string[]> {
  const users = await allPages("/users/v1/users", USERS_PAGE, (b) => (b as { data?: { users?: ConnecteamUser[] } }).data?.users);
  const admins = adminRows(users);
  if (admins.length === 0) throw new Stop(4, "Couldn't find any admins in this account's users.");
  return [...admins.map((a) => `admin\t${a.userId}\t${a.label}`), `direct\t${directManagerLine(directManagers(users))}`];
}

async function boards(): Promise<string[]> {
  const body = (await get("/tasks/v1/taskboards")) as { data?: { taskBoards?: { id: number; name: string; isArchived?: boolean }[] } };
  return (body.data?.taskBoards ?? []).filter((b) => !b.isArchived).map((b) => `${b.id}\t${plainText(b.name)}`);
}

async function publishers(): Promise<string[]> {
  const rows = await allPages("/publishers/v1/publishers", SMALL_PAGE, (b) => (b as { data?: { publishers?: { id: number; name: string }[] } }).data?.publishers);
  return rows.map((p) => `${p.id}\t${plainText(p.name)}`);
}

async function channels(): Promise<string[]> {
  const rows = await allPages("/chat/v1/conversations", SMALL_PAGE, (b) => (b as { data?: { conversations?: Conversation[] } }).data?.conversations);
  const labels = conversationLabels(rows);
  return rows.map((c, i) => `${c.id}\t${labels[i]}`);
}

/**
 * A new channel for Failure Alerts: only Admins post in a channel, and the
 * members are the ones given (#15). Per the docs, not tested live: creating
 * one needs an owner's API key, so a refusal says to create it in the app.
 */
async function createChannel(title: string, ids: string): Promise<string[]> {
  const t = plainText(title);
  if (!t) throw new Stop(1, "Give the channel a name.");
  const members = ids.split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (members.length === 0) throw new Stop(1, "The channel needs at least one member.");
  const res = await call("POST", "/chat/v1/conversations", { title: t, type: "channel", assignedUserIds: members });
  if (res.status === 401 || res.status === 403) {
    throw new Stop(4, "Connecteam wouldn't create the channel: that needs an API key made by the account owner. Create the channel in Connecteam (Chat > New channel) instead, then rerun this step and pick it.");
  }
  if (!res.ok) throw new Stop(4, `Connecteam answered HTTP ${res.status} when creating the channel.`);
  const id = ((await res.json()) as { data?: { conversation?: { id?: unknown } } }).data?.conversation?.id;
  if (typeof id !== "string" || !id) throw new Stop(4, "Connecteam created the channel but didn't say its id. Rerun this step and pick it from the list.");
  return [id];
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
    case "people":
      return people();
    case "boards":
      return boards();
    case "publishers":
      return publishers();
    case "channels":
      return channels();
    case "create-channel":
      return createChannel(rest[0] ?? "", rest[1] ?? "");
    case "relay-url": {
      const u = checkRelayUrl(rest[0] ?? "");
      if (!u.ok) throw new Stop(1, u.problem);
      return [u.value];
    }
    case "slug": {
      const s = checkClientSlug(rest[0] ?? "");
      if (!s.ok) throw new Stop(1, s.problem);
      return [s.value];
    }
    case "automated":
      if (!soundsAutomated(rest[0] ?? "")) throw new Stop(1, "no");
      return ["yes"];
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
