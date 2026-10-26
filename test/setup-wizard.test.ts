/**
 * The setup wizard (#37 to #41), driven as a person would: the real script
 * with typed input, no browser, and a fake Connecteam on localhost answering
 * in the shapes the live API sends (rate-limit headers, time clock settings,
 * forms, users, publishers, task boards and chats, tested live 2026-10-24;
 * webhooks per the docs), and a fake wrangler standing in for Cloudflare. The Cloudflare step needs a person and
 * a real account, so only its entry points are checked here.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDevVars } from "../scripts/lib/deploy-config.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(root, "scripts/setup-wizard.sh");

/** What the fake Connecteam answers next for the time clocks, in order; the last one repeats. */
let answers: { status: number; dayLimit?: number }[] = [];
const seenKeys: string[] = [];
let server: Server;
let base = "";

const CLOCKS = [
  { id: 101, name: "Time Clock", isArchived: false, timezone: "Australia/Melbourne" },
  { id: 102, name: "Old Clock", isArchived: true, timezone: "Asia/Tokyo" },
];
const noLimit = (field: string) => ({ enabled: false, [field]: 10 });
const settings = (over: Record<string, unknown> = {}) => ({
  isAnonymous: false,
  limitEntriesPerUser: noLimit("limitEntriesPerUser"),
  limitTotalEntries: noLimit("limitTotalEntries"),
  limitEntriesUntilTimestamp: noLimit("limitEntriesUntilTimestamp"),
  ...over,
});
const FORMS = [
  {
    formId: 501,
    formName: "Daily Compliance Form",
    settings: settings(),
    questions: [
      { questionId: "q-text", title: "Notes", questionType: "openEnded" },
      { questionId: "q-time", title: "Finish time", questionType: "datetime", isDateActive: false, isTimeActive: true },
      { questionId: "q-shift", title: "Which shift is this form for?", questionType: "datetime", isDateActive: true, isTimeActive: false },
      { questionId: "q-group", title: "Group", questionType: "group", questions: [{ questionId: "q-inner", title: "Inner date", questionType: "datetime", isDateActive: true }] },
    ],
  },
  { formId: 502, formName: "Incident Report", settings: settings({ isAnonymous: true }), questions: [] },
  { formId: 503, formName: "Weekly Site Audit", settings: settings({ limitEntriesPerUser: { enabled: true, limitEntriesPerUser: 1 } }), questions: [] },
];

const dm = (id: number | null) => ({ customFieldId: 9, name: "Direct manager", type: "directManager", value: id });
let USERS = [
  { userId: 1, firstName: "Okky", lastName: "Stafford", userType: "owner", isArchived: false, customFields: [dm(null)] },
  { userId: 2, firstName: "Priya", lastName: "Shah", userType: "manager", isArchived: false, customFields: [dm(1)] },
  { userId: 3, firstName: "Marcus", lastName: "Webb", userType: "manager", isArchived: false, customFields: [dm(1)] },
  { userId: 4, firstName: "Gone", lastName: "Admin", userType: "manager", isArchived: true, customFields: [] },
  { userId: 5, firstName: "Jordan", lastName: "Lee", userType: "user", isArchived: false, customFields: [dm(2)] },
  { userId: 6, firstName: "Invited", lastName: "Admin", userType: "user", invitedToBeManager: true, isArchived: false, customFields: [dm(null)] },
];
let boards = [
  { id: 701, name: "Task Management", isArchived: false },
  { id: 702, name: "Old board", isArchived: true },
  { id: 703, name: "Compliance follow-ups", isArchived: false },
];
const PUBLISHERS = [
  { id: 2040969, name: "Implementation Publisher", imageUrl: "" },
  { id: 2480518, name: "Compliance Reminders (Automated)", imageUrl: "" },
];
// Twelve chats: more than the 10 a page Connecteam sends unless asked.
let CHATS = Array.from({ length: 12 }, (_, i) => ({
  id: `chat-${i + 1}`,
  title: i === 11 ? "Managers" : `Team ${i + 1}`,
  type: i === 11 ? "channel" : "team",
}));
/** What POST /chat/v1/conversations was sent, and whether it's refused (as for a non-owner key, per the docs). */
const created: unknown[] = [];
let createStatus = 200;
/** Connecteam's webhook subscriptions, and every write to them. */
let webhooks: Array<Record<string, unknown> & { id: number }> = [];
let nextWebhookId = 900;
const webhookCalls: string[] = [];
/** Direct messages sent, and what the next one answers. */
const dms: Array<{ userId: number; body: { senderId: number; text: string } }> = [];
let dmAnswer: { status: number; detail?: string } = { status: 200 };

beforeAll(async () => {
  server = createServer(async (req, res) => {
    seenKeys.push(String(req.headers["x-api-key"] ?? ""));
    const url = new URL(req.url ?? "/", "http://fake");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/time-clock/v1/time-clocks") {
      const a = answers.length > 1 ? answers.shift()! : answers[0]!;
      const limits = a.dayLimit !== undefined ? { "x-ratelimit-day-limit": String(a.dayLimit), "x-ratelimit-day-remaining": String(a.dayLimit - 1) } : {};
      const clocks = CLOCKS.map(({ timezone: _, ...c }) => c);
      return send(a.status, a.status === 200 ? { data: { timeClocks: clocks } } : { detail: "Invalid API key" }, limits);
    }
    const clock = /^\/time-clock\/v1\/time-clocks\/(\d+)\/settings$/.exec(url.pathname);
    if (clock) {
      const c = CLOCKS.find((x) => x.id === Number(clock[1]));
      return c ? send(200, { data: { general: { weekStartDay: 2, timezone: c.timezone } } }) : send(404, { detail: "Not Found" });
    }
    if (url.pathname === "/forms/v1/forms") {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 10);
      // Like the live API, paging.offset comes back even on the last page.
      return send(200, { data: { forms: FORMS.slice(offset, offset + limit) }, paging: { offset: Math.min(offset + limit, FORMS.length) } });
    }
    const form = /^\/forms\/v1\/forms\/(\d+)$/.exec(url.pathname);
    if (form) {
      const f = FORMS.find((x) => x.formId === Number(form[1]));
      return f ? send(200, { data: f }) : send(404, { detail: "Not Found" });
    }
    const page = <T,>(rows: T[], fallback = 10) => {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? fallback);
      return { rows: rows.slice(offset, offset + limit), paging: { offset: Math.min(offset + limit, rows.length) } };
    };
    if (url.pathname === "/users/v1/users") {
      const only = url.searchParams.get("userIds");
      const p = page(only ? USERS.filter((u) => String(u.userId) === only) : USERS);
      return send(200, { data: { users: p.rows }, paging: p.paging });
    }
    if (url.pathname === "/tasks/v1/taskboards") return send(200, { data: { taskBoards: boards } });
    if (url.pathname === "/publishers/v1/publishers") {
      const p = page(PUBLISHERS);
      return send(200, { data: { publishers: p.rows }, paging: p.paging });
    }
    if (url.pathname === "/chat/v1/conversations" && req.method === "POST") {
      created.push(JSON.parse(raw));
      if (createStatus !== 200) return send(createStatus, { detail: "Forbidden" });
      return send(200, { data: { conversation: { id: "chat-new", ...JSON.parse(raw) } } });
    }
    const dm = /^\/chat\/v1\/conversations\/privateMessage\/(\d+)$/.exec(url.pathname);
    if (dm && req.method === "POST") {
      dms.push({ userId: Number(dm[1]), body: JSON.parse(raw) });
      return dmAnswer.status === 200 ? send(200, { data: {} }) : send(dmAnswer.status, { detail: dmAnswer.detail ?? "" });
    }
    if (url.pathname === "/settings/v1/webhooks" && req.method === "GET") {
      const p = page(webhooks);
      return send(200, { data: { webhooks: p.rows }, paging: p.paging });
    }
    if (url.pathname === "/settings/v1/webhooks" && req.method === "POST") {
      const w = { ...JSON.parse(raw), id: nextWebhookId++ };
      webhooks.push(w);
      webhookCalls.push(`POST ${w.featureType}`);
      return send(200, { data: w });
    }
    const hook = /^\/settings\/v1\/webhooks\/(\d+)$/.exec(url.pathname);
    if (hook) {
      const i = webhooks.findIndex((w) => w.id === Number(hook[1]));
      if (i < 0) return send(404, { detail: "Not Found" });
      webhookCalls.push(`${req.method} ${hook[1]}`);
      if (req.method === "PUT") webhooks[i] = { ...webhooks[i]!, ...JSON.parse(raw) };
      if (req.method === "DELETE") webhooks.splice(i, 1);
      return send(200, { data: webhooks[i] ?? {} });
    }
    if (url.pathname === "/chat/v1/conversations") {
      const p = page(CHATS);
      return send(200, { data: { conversations: p.rows }, paging: p.paging });
    }
    send(404, { detail: "Not Found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function run(args: string[], input = "", envFile?: string, extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  // A key in the shell running the tests would stand in for the one in .dev.vars.
  const { CT_API_KEY: _, ...parent } = process.env;
  return new Promise((resolve) => {
    const child = spawn("bash", [SCRIPT, ...args], {
      cwd: root,
      env: {
        ...parent,
        NO_COLOR: "1",
        WIZARD_NO_BROWSER: "1",
        WIZARD_LOG: "off", // no `script` recording under test
        WIZARD_DETAILS: join(tmpdir(), "wizard-test-wrangler.log"),
        CT_API_BASE: base,
        ...(envFile ? { WIZARD_ENV_FILE: envFile } : {}),
        ...extraEnv,
      },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
    child.stdin.end(input);
  });
}

/**
 * Run the wizard, typing `input` and keeping stdin open, and press Ctrl-C
 * (SIGINT) once the output shows `at`.
 */
function interrupt(args: string[], input: string, at: string, envFile: string, extraEnv: Record<string, string>): Promise<{ code: number | null; out: string }> {
  const { CT_API_KEY: _, ...parent } = process.env;
  return new Promise((resolve) => {
    const child = spawn("bash", [SCRIPT, ...args], {
      cwd: root,
      env: { ...parent, NO_COLOR: "1", WIZARD_NO_BROWSER: "1", WIZARD_LOG: "off", WIZARD_DETAILS: join(tmpdir(), "wizard-test-wrangler.log"), CT_API_BASE: base, WIZARD_ENV_FILE: envFile, ...extraEnv },
    });
    let out = "";
    let sent = false;
    const seen = (d: Buffer) => {
      out += d;
      if (!sent && out.includes(at)) {
        sent = true;
        child.kill("SIGINT");
      }
    };
    child.stdout.on("data", seen);
    child.stderr.on("data", seen);
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.write(input);
  });
}

const tempEnv = () => join(mkdtempSync(join(tmpdir(), "wizard-")), ".dev.vars");

/** A `.dev.vars` with a working key already saved, as after step 2. */
function envWithKey(extra = ""): string {
  const env = tempEnv();
  writeFileSync(env, `CT_API_KEY='ct-key-saved'\n${extra}`, { mode: 0o600 });
  return env;
}
const saved = (env: string) => parseDevVars(readFileSync(env, "utf8"));
/** The output with line wrapping undone, for text the wizard wraps. */
const flat = (out: string) => out.replace(/\s+/g, " ");

describe("the setup wizard's entry points", () => {
  it("--help lists every step --step can rerun", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("--step NAME");
    expect(r.out).toContain("Steps: key timezone form timings quiet-hours recipients reminder-task sender alerts support webhook test");
    expect(r.out).toContain("--support");
  });

  it("refuses an unknown step before asking anything", async () => {
    const unknown = await run(["--step", "nope"]);
    expect(unknown.code).toBe(2);
    expect(unknown.out).toContain("unknown step: nope");
  });

  it("asks for the support link only with --support, or when one is saved (17 stages, else 18)", async () => {
    // Both stop at the Cloudflare question (no input), after the banner.
    const plain = await run([], "", tempEnv());
    expect(plain.out).toContain("17 stages");
    const asked = await run(["--support"], "", tempEnv());
    expect(asked.out).toContain("18 stages");
    const kept = await run([], "", envWithKey("INTEGRATOR_RELAY_URL='https://relay.example.workers.dev'\n"));
    expect(kept.out).toContain("18 stages");
  });
});

describe("step 2, the API key (--step key)", () => {
  it("on Expert or above, saves the key to .dev.vars and says the allowance, never showing the key", async () => {
    answers = [{ status: 200, dayLimit: 20_000 }];
    const env = tempEnv();
    const r = await run(["--step", "key"], "ct-key-good-123\n", env);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Why this step");
    expect(r.out).toContain("What to do");
    expect(r.out).toContain("Example");
    expect(r.out).toContain("Key works. Daily API allowance: 20000 calls a day.");
    expect(r.out).not.toContain("ct-key-good-123");
    expect(readFileSync(env, "utf8")).toContain("CT_API_KEY='ct-key-good-123'");
    expect(seenKeys.at(-1)).toBe("ct-key-good-123");
  });

  it("below Expert's 10,000 a day, stops with a plain explanation and saves nothing", async () => {
    answers = [{ status: 200, dayLimit: 5_000 }];
    const env = tempEnv();
    const r = await run(["--step", "key"], "ct-key-small\n", env);
    expect(r.code).toBe(1);
    expect(r.out).toContain("This account's daily API allowance is 5000 calls.");
    expect(r.out).toContain("Expert plan or above (10,000 calls a day)");
    expect(r.out).toContain("run out of calls by lunchtime");
    expect(existsSync(env)).toBe(false);
  });

  it("a rejected key asks again, and the one that works is saved", async () => {
    answers = [{ status: 403 }, { status: 200, dayLimit: 10_000 }];
    const env = tempEnv();
    const r = await run(["--step", "key"], "ct-key-typo\ny\nct-key-right\n", env);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Connecteam didn't accept that key.");
    expect(readFileSync(env, "utf8")).toContain("CT_API_KEY='ct-key-right'");
    expect(readFileSync(env, "utf8")).not.toContain("ct-key-typo");
  });

  it("rerun with a key already saved, Enter keeps it", async () => {
    answers = [{ status: 200, dayLimit: 20_000 }];
    const env = tempEnv();
    await run(["--step", "key"], "ct-key-first\n", env);
    const r = await run(["--step", "key"], "\n", env);
    expect(r.code).toBe(0);
    expect(r.out).toContain("[Enter keeps current]");
    expect(seenKeys.at(-1)).toBe("ct-key-first");
    rmSync(env);
  });
});

// Every helper call starts node, so a step with several takes a few seconds.
const SLOW = 60_000;

describe("step 3, the time zone (--step timezone)", { timeout: SLOW }, () => {
  beforeEach(() => {
    answers = [{ status: 200, dayLimit: 20_000 }];
  });

  it("defaults to the live time clock's zone, ignoring archived clocks", async () => {
    const env = envWithKey();
    const r = await run(["--step", "timezone"], "\n", env);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Time clock "Time Clock" is set to Australia/Melbourne.');
    expect(r.out).not.toContain("Asia/Tokyo");
    expect(saved(env).TIME_ZONE).toBe("Australia/Melbourne");
    expect(seenKeys.at(-1)).toBe("ct-key-saved");
  });

  it("takes another zone, refusing one that doesn't exist, and saves its proper name", async () => {
    const env = envWithKey();
    const r = await run(["--step", "timezone"], "Mars/Base\naustralia/perth\n", env);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`"Mars/Base" isn't a time zone name.`);
    expect(saved(env).TIME_ZONE).toBe("Australia/Perth");
  });

  it("on a rerun, Enter keeps the zone saved before", async () => {
    const env = envWithKey("TIME_ZONE='Pacific/Auckland'\n");
    const r = await run(["--step", "timezone"], "\n", env);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Saved now: Pacific/Auckland.");
    expect(saved(env).TIME_ZONE).toBe("Pacific/Auckland");
  });

  it("stops before asking anything when no key is saved", async () => {
    const env = tempEnv();
    const r = await run(["--step", "timezone"], "\n", env);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Run the key step first: npm run setup -- --step key");
  });

  it("stops when Connecteam rejects the saved key", async () => {
    answers = [{ status: 403 }];
    const r = await run(["--step", "timezone"], "\n", envWithKey());
    expect(r.code).toBe(1);
    expect(r.out).toContain("Connecteam didn't accept the API key.");
  });
});

describe("steps 4 to 6, the Compliance Form, Shift Date Question and where to find it (--step form)", { timeout: SLOW }, () => {
  it("lists the live forms, flags the ones that can't work per shift, and saves the pick with the recommended date question", async () => {
    const env = envWithKey();
    const r = await run(["--step", "form"], "1\n\n\n", env);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/1\) Daily Compliance Form\n/);
    expect(r.out).toContain("Incident Report  ⚠ anonymous");
    expect(r.out).toContain("Weekly Site Audit  ⚠ one entry per person");
    // Only the top-level question with a date: not the time-only one, not the one in a group.
    expect(r.out).toContain("1) Which shift is this form for?");
    expect(r.out).not.toContain("Finish time");
    expect(r.out).not.toContain("Inner date");
    expect(r.out).toContain("You'll find it in");
    expect(saved(env)).toMatchObject({
      COMPLIANCE_FORM_ID: "501",
      SHIFT_DATE_QUESTION_ID: "q-shift",
      WHERE_TO_FIND: "the Forms tab in the Connecteam app",
    });
  });

  it("warns on an anonymous form, and picking again saves the other one", async () => {
    const env = envWithKey();
    const r = await run(["--step", "form"], "2\nn\n1\n\n\n", env);
    expect(r.code).toBe(0);
    expect(flat(r.out)).toContain("It's anonymous, so we can't tell who submitted it.");
    expect(saved(env).COMPLIANCE_FORM_ID).toBe("501");
  });

  it("warns on a once-per-user form, saves it if told to, and recommends adding a date question it lacks", async () => {
    const env = envWithKey("SHIFT_DATE_QUESTION_ID='q-shift'\n");
    const r = await run(["--step", "form"], "3\ny\n\n", env);
    expect(r.code).toBe(0);
    expect(flat(r.out)).toContain("It lets each person submit only once, so it can't work as a per-shift form.");
    expect(flat(r.out)).toContain('"Weekly Site Audit" has no date question.');
    expect(saved(env)).toMatchObject({ COMPLIANCE_FORM_ID: "503", SHIFT_DATE_QUESTION_ID: "" });
  });

  it("the Shift Date Question is optional: 0 is none", async () => {
    const env = envWithKey();
    const r = await run(["--step", "form"], "1\n0\n\n", env);
    expect(r.code).toBe(0);
    expect(saved(env).SHIFT_DATE_QUESTION_ID).toBe("");
  });

  it("refuses a number not on the list", async () => {
    const env = envWithKey();
    const r = await run(["--step", "form"], "9\n1\n\n\n", env);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Type a number from the list.");
    expect(saved(env).COMPLIANCE_FORM_ID).toBe("501");
  });

  it("the place finishes \"You'll find it in …\": a leading \"in\" and full stop are dropped, and an overlong one is refused", async () => {
    const env = envWithKey();
    const long = "x".repeat(101);
    const r = await run(["--step", "form"], `1\n\n${long}\nIn the Site folder under Forms.\n`, env);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Keep it to 100 characters or fewer");
    expect(r.out).toContain('Messages will say: "Where: the Site folder under Forms"');
    expect(saved(env).WHERE_TO_FIND).toBe("the Site folder under Forms");
  });

  it("on a rerun, Enter keeps the form, date question and place saved before", async () => {
    const env = envWithKey("COMPLIANCE_FORM_ID='501'\nSHIFT_DATE_QUESTION_ID='q-shift'\nWHERE_TO_FIND='the red folder'\n");
    const r = await run(["--step", "form"], "\n\n\n", env);
    expect(r.code).toBe(0);
    expect(saved(env)).toMatchObject({ COMPLIANCE_FORM_ID: "501", SHIFT_DATE_QUESTION_ID: "q-shift", WHERE_TO_FIND: "the red folder" });
  });
});

describe("steps 7 and 8, the Grace Period and escalation delay (--step timings)", { timeout: SLOW }, () => {
  it("defaults to 30 minutes and 4 hours, with the worked example and the timeline", async () => {
    const env = tempEnv();
    const r = await run(["--step", "timings"], "\n\n", env);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Jordan clocks out at 5:00 pm. With a grace period of 30 minutes,");
    expect(r.out).toContain(" 5:30 pm   no form yet → reminder to Jordan");
    expect(r.out).toContain(" 9:30 pm   still no form, 4 hours later → your admins and Jordan's manager are told");
    expect(saved(env)).toMatchObject({ GRACE_PERIOD_MINUTES: "30", ESCALATION_DELAY_MINUTES: "240" });
  });

  it("builds the timeline from the chosen Grace Period, and shows it again for a new delay", async () => {
    const env = tempEnv();
    const r = await run(["--step", "timings"], "soon\n45\n1.5\n", env);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`"soon" isn't a number of minutes.`);
    expect(r.out).toContain(" 5:45 pm   no form yet → reminder to Jordan");
    expect(r.out).toContain(" 7:15 pm   still no form, 1 hour 30 minutes later");
    expect(saved(env)).toMatchObject({ GRACE_PERIOD_MINUTES: "45", ESCALATION_DELAY_MINUTES: "90" });
  });
});

describe("step 9, Quiet Hours (--step quiet-hours)", { timeout: SLOW }, () => {
  it("defaults to on, 9 pm to 7 am, shown with the 10 pm example", async () => {
    const env = tempEnv();
    const r = await run(["--step", "quiet-hours"], "\n\n\n", env);
    expect(r.code).toBe(0);
    expect(r.out).toContain("A shift ends at 10:00 pm.");
    expect(r.out).toContain("10:30 pm   reminder to the employee (sent: reminders are never held)");
    expect(r.out).toContain(" 2:30 am   (next day) escalation due → held until 7:00 am, then sent in the morning summary");
    expect(saved(env)).toMatchObject({ QUIET_HOURS_ENABLED: "true", QUIET_HOURS_FROM: "21:00", QUIET_HOURS_UNTIL: "07:00" });
  });

  it("can be changed, in 12- or 24-hour times, refusing the same start and end", async () => {
    const env = tempEnv();
    const r = await run(["--step", "quiet-hours"], "y\n7am\n07:00\n10 pm\n6:30am\n", env);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Quiet hours can't start and end at the same time.");
    expect(saved(env)).toMatchObject({ QUIET_HOURS_ENABLED: "true", QUIET_HOURS_FROM: "22:00", QUIET_HOURS_UNTIL: "06:30" });
  });

  it("can be turned off", async () => {
    const env = tempEnv();
    const r = await run(["--step", "quiet-hours"], "n\n", env);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Escalations will go out at any hour, day or night.");
    expect(saved(env).QUIET_HOURS_ENABLED).toBe("false");
  });

  it("the example uses the saved timings", async () => {
    const env = tempEnv();
    writeFileSync(env, "GRACE_PERIOD_MINUTES='15'\nESCALATION_DELAY_MINUTES='60'\n");
    const r = await run(["--step", "quiet-hours"], "\n\n\n", env);
    expect(r.code).toBe(0);
    expect(r.out).toContain("10:15 pm   reminder to the employee");
    expect(r.out).toContain("11:15 pm   escalation due → held until 7:00 am");
  });
});

describe("step 10, who receives escalations (--step recipients)", { timeout: SLOW }, () => {
  it("lists every Admin ticked (not archived ones, not invites), says direct managers are used, and saves no one excluded", async () => {
    const env = envWithKey();
    const r = await run(["--step", "recipients"], "\n", env);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Direct managers: found. 1 of 2 staff have one");
    expect(r.out).toContain("[✔] Marcus Webb");
    expect(r.out).toContain("[✔] Okky Stafford (owner)");
    expect(r.out).toContain("[✔] Priya Shah");
    expect(r.out).not.toContain("Gone Admin");
    expect(r.out).not.toContain("Invited Admin");
    expect(saved(env).EXCLUDED_ADMIN_IDS).toBe("");
  });

  it("unticking excludes; ticking again includes", async () => {
    const env = envWithKey();
    // Sorted by name: 1 Marcus, 2 Okky, 3 Priya.
    const r = await run(["--step", "recipients"], "2\n3\n3\n1\n\n", env);
    expect(r.code).toBe(0);
    expect(r.out).toContain("[ ] Okky Stafford (owner)");
    expect(r.out).toContain("1 of 3 admins");
    expect(saved(env).EXCLUDED_ADMIN_IDS).toBe("3,1");
  });

  it("keeps at least one ticked", async () => {
    const env = envWithKey("EXCLUDED_ADMIN_IDS='1,2'\n");
    const r = await run(["--step", "recipients"], "1\n\n", env);
    expect(r.code).toBe(0);
    expect(r.out).toContain("At least one admin must stay ticked");
    expect(saved(env).EXCLUDED_ADMIN_IDS).toBe("1,2");
  });

  it("drops a saved exclusion for someone who's no longer an Admin", async () => {
    const env = envWithKey("EXCLUDED_ADMIN_IDS='4,2'\n");
    const r = await run(["--step", "recipients"], "\n", env);
    expect(r.code).toBe(0);
    expect(saved(env).EXCLUDED_ADMIN_IDS).toBe("2");
  });
});

describe("step 11, the Reminder Task (--step reminder-task)", { timeout: SLOW }, () => {
  it("is on by default, with a board picked from the live ones", async () => {
    const env = envWithKey();
    const r = await run(["--step", "reminder-task"], "\n2\n", env);
    expect(r.code).toBe(0);
    expect(r.out).toContain("1) Task Management");
    expect(r.out).not.toContain("Old board");
    expect(saved(env)).toMatchObject({ REMINDER_TASK_ENABLED: "true", TASK_BOARD_ID: "703" });
  });

  it("can be turned off without a board", async () => {
    const env = envWithKey();
    const r = await run(["--step", "reminder-task"], "n\n", env);
    expect(r.code).toBe(0);
    expect(saved(env).REMINDER_TASK_ENABLED).toBe("false");
    expect(saved(env).TASK_BOARD_ID).toBeUndefined();
  });

  it("with no board in use, says to add one and looks again", async () => {
    const before = boards;
    boards = [];
    const env = envWithKey();
    const r = await run(["--step", "reminder-task"], "y\n", env);
    boards = before;
    expect(r.code).toBe(1);
    expect(flat(r.out)).toContain("There's no task board in use. Add one in Connecteam (Tasks)");
  });
});

describe("step 12, the sender name (--step sender)", { timeout: SLOW }, () => {
  it("explains the custom publisher, takes its id and saves its name from Connecteam", async () => {
    const env = envWithKey();
    const r = await run(["--step", "sender"], "2480518\n", env);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Settings > Feed settings > Custom publishers");
    expect(saved(env)).toMatchObject({ CT_PUBLISHER_ID: "2480518", CT_PUBLISHER_NAME: "Compliance Reminders (Automated)" });
    expect(r.out).not.toContain("doesn't say it's automated");
  });

  it("takes its number in the list too, and hints when the name doesn't say it's automated", async () => {
    const env = envWithKey();
    const r = await run(["--step", "sender"], "1\n", env);
    expect(r.code).toBe(0);
    expect(flat(r.out)).toContain(`"Implementation Publisher" doesn't say it's automated`);
    expect(saved(env).CT_PUBLISHER_ID).toBe("2040969");
  });

  it("refuses an id that isn't a publisher, and lists them again", async () => {
    const env = envWithKey();
    const r = await run(["--step", "sender"], "999\n2480518\n", env);
    expect(r.code).toBe(0);
    expect(r.out).toContain("That isn't one of your custom publishers.");
    expect(saved(env).CT_PUBLISHER_ID).toBe("2480518");
  });
});

describe("step 13, the Alerts Channel (--step alerts)", { timeout: SLOW }, () => {
  it("lists channels first, finds a chat by part of its name past Connecteam's first page, and doesn't ask about a support link", async () => {
    const env = envWithKey();
    const r = await run(["--step", "alerts"], "manag\n", env);
    expect(r.code).toBe(0);
    expect(r.out.indexOf("• Managers (channel)")).toBeLessThan(r.out.indexOf("• Team 1 (team chat)"));
    expect(r.out).not.toContain("Support link (optional)");
    expect(saved(env).ALERTS_CHANNEL_ID).toBe("chat-12");
    expect(saved(env).INTEGRATOR_RELAY_URL).toBeUndefined();
  });

  it("with many chats, shows only the channels and narrows the rest by name", async () => {
    const before = CHATS;
    CHATS = [...Array.from({ length: 40 }, (_, i) => ({ id: `team-${i + 1}`, title: `Time & Attendance ${i + 1}`, type: "team" })), { id: "chat-ops", title: "Ops", type: "channel" }];
    const env = envWithKey();
    const r = await run(["--step", "alerts"], "\ntime\nattendance 3\n2\n", env);
    CHATS = before;
    expect(r.code).toBe(0);
    expect(r.out).toContain("• Ops (channel)");
    expect(r.out).not.toContain("• Time & Attendance 1 (team chat)");
    expect(r.out).toContain("Plus 40 more chats: type part of a name to find one.");
    expect(r.out).toContain("Type part of a name.");
    expect(r.out).toContain("40 chats match. Type more of the name.");
    // "attendance 3" is 3 and 30 to 39, in Connecteam's order.
    expect(r.out).toContain("1) Time & Attendance 3 (team chat)");
    expect(saved(env).ALERTS_CHANNEL_ID).toBe("team-30");
  });

  it("on a rerun, Enter keeps the chat saved before", async () => {
    const env = envWithKey("ALERTS_CHANNEL_ID='chat-3'\n");
    const r = await run(["--step", "alerts"], "\n", env);
    expect(r.code).toBe(0);
    expect(saved(env).ALERTS_CHANNEL_ID).toBe("chat-3");
  });

  it("0 creates a channel whose members are the ticked Admins", async () => {
    const env = envWithKey("EXCLUDED_ADMIN_IDS='1'\n");
    created.length = 0;
    const r = await run(["--step", "alerts"], "0\n\ny\n", env);
    expect(r.code).toBe(0);
    expect(created).toEqual([{ title: "Form Reminder Alerts", type: "channel", assignedUserIds: [3, 2] }]);
    expect(saved(env).ALERTS_CHANNEL_ID).toBe("chat-new");
  });

  it("a refused create explains making it in the app, then a chat can be picked instead", async () => {
    const env = envWithKey();
    createStatus = 403;
    const r = await run(["--step", "alerts"], "0\nAlerts\ny\nManagers (channel)\n", env);
    createStatus = 200;
    expect(r.code).toBe(0);
    expect(flat(r.out)).toContain("that needs an API key made by the account owner");
    expect(saved(env).ALERTS_CHANNEL_ID).toBe("chat-12");
  });

});

describe("step 14, the support link (--step support)", { timeout: SLOW }, () => {
  it("takes the link, a public-safe name and the secret, never showing the secret", async () => {
    const env = envWithKey();
    const r = await run(["--step", "support"], "y\nhttp://relay.example\nhttps://relay.example.workers.dev/\nAcme Cleaning!\nAcme-Cleaning\nrelay-secret-123\n", env);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`"http://relay.example" isn't an https:// address.`);
    expect(r.out).toContain("Use letters, numbers and dashes only");
    expect(r.out).not.toContain("relay-secret-123");
    expect(saved(env)).toMatchObject({
      INTEGRATOR_RELAY_URL: "https://relay.example.workers.dev",
      INTEGRATOR_CLIENT_SLUG: "acme-cleaning",
      INTEGRATOR_RELAY_SECRET: "relay-secret-123",
    });
  });

  it("a y by mistake: Enter at the link, with nothing typed, saves no support link", async () => {
    const env = envWithKey();
    const r = await run(["--step", "support"], "y\n\n", env);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Saved: no support link.");
    expect(saved(env)).toMatchObject({ INTEGRATOR_RELAY_URL: "", INTEGRATOR_CLIENT_SLUG: "", INTEGRATOR_RELAY_SECRET: "" });
  });
});

/**
 * A stand-in for wrangler: databases kept in a state file, every call and
 * every secret logged, and a deploy that prints a workers.dev address as the
 * real one does.
 */
function fakeWrangler(opts: { databaseId?: string; counts?: Record<string, number>; whoami?: string } = {}): { env: Record<string, string>; log: () => string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "wrangler-"));
  const bin = join(dir, "wrangler");
  if (opts.databaseId) writeFileSync(join(dir, "d1.json"), JSON.stringify([{ uuid: opts.databaseId, name: "clock-out-form-reminder" }]));
  // As \`wrangler d1 execute --json\` prints a query's one row; none, and the query fails.
  if (opts.counts) writeFileSync(join(dir, "counts.json"), JSON.stringify([{ results: [opts.counts], success: true, meta: {} }]));
  writeFileSync(join(dir, "whoami.txt"), opts.whoami ?? "You are logged in.  │ Example Pty Ltd │ 3f2a91c0 │\n");
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
state="${dir}/d1.json"; log="${dir}/calls.log"
[[ -f "$state" ]] || echo '[]' > "$state"
echo "wrangler $*" >> "$log"
case "$1 $2" in
  "whoami "*|"whoami") cat "${dir}/whoami.txt" ;;
  "d1 list") cat "$state" ;;
  "d1 execute") if [[ -f "${dir}/counts.json" ]]; then cat "${dir}/counts.json"; else echo "✘ [ERROR] no such table: shifts" >&2; exit 1; fi ;;
  "d1 create") echo '[{"uuid":"11111111-2222-3333-4444-555555555555","name":"'"$3"'"}]' > "$state"
               echo 'Created your new D1 database. "database_id": "11111111-2222-3333-4444-555555555555"' ;;
  "d1 migrations") echo "Migrations applied" ;;
  "deployments status") echo "This Worker does not exist on your account. [code: 10007]" >&2; exit 1 ;;
  "deploy "*|"deploy") echo "Uploaded clock-out-form-reminder"; echo "  https://clock-out-form-reminder.test.workers.dev" ;;
  "secret put") echo "secret $3=$(cat)" >> "$log"; echo "Success! Uploaded secret $3" ;;
  *) echo "fake wrangler: unexpected $*" >&2; exit 9 ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return {
    dir,
    env: { WRANGLER_CMD: bin, WIZARD_DEPLOY_CONFIG: join(dir, "wrangler.deploy.json") },
    log: () => (existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8") : ""),
  };
}

/** Every answer a first-time setup takes, in order (Enter takes a default). */
const FIRST_RUN = [
  "", // banner
  "y", "y", // Workers Paid; the right account
  "ct-key-full", // API key
  "", // time zone
  "1", "", "", // form, date question, where
  "", "", // grace, delay
  "", "", "", // quiet hours on, from, until
  "", // recipients
  "", "1", // reminder task on, board
  "2480518", // publisher
  "Managers", // alerts channel (no support link asked)
  "", // tip
  "y", // summary
  "", "y", "y", // test: the owner, send, arrived
].join("\n") + "\n";

describe("steps 16 to 18: summary, turn it on, test message (a whole first run)", { timeout: 180_000 }, () => {
  beforeEach(() => {
    answers = [{ status: 200, dayLimit: 20_000 }];
    dmAnswer = { status: 200 };
  });

  it("summarises, creates the database, deploys, stores the secrets, subscribes the three webhooks and sends the test", async () => {
    webhooks = [{ id: 1, name: "Someone else's", url: "https://other.example/hook", featureType: "users", eventTypes: ["user_updated"] }];
    webhookCalls.length = 0;
    dms.length = 0;
    const cf = fakeWrangler();
    const env = tempEnv();
    const r = await run([], FIRST_RUN, env, cf.env);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Stage 17/17 · Test message");
    expect(r.out).not.toContain("Support link (optional)");
    const v = saved(env);
    const url = "https://clock-out-form-reminder.test.workers.dev/webhook";

    // 16: every setting, by name.
    expect(r.out).toMatch(/Compliance Form \.{3,} Daily Compliance Form/);
    expect(r.out).toMatch(/Shift date question \.{3,} Which shift is this form for\?/);
    expect(r.out).toMatch(/Quiet hours \.{3,} 9:00 pm to 7:00 am/);
    expect(r.out).toMatch(/Escalations to \.{3,} 3 of 3 admins, plus direct managers/);
    expect(r.out).toMatch(/Reminder task \.{3,} on, board "Task Management"/);
    expect(r.out).toMatch(/Alerts channel \.{3,} Managers \(channel\)/);

    // 17: database, checked config, migrations, deploy, then secrets.
    expect(v.D1_DATABASE_ID).toBe("11111111-2222-3333-4444-555555555555");
    expect(v.CT_WEBHOOK_SECRET).toMatch(/^[0-9a-f]{64}$/);
    const calls = cf.log();
    expect(calls).toContain("wrangler d1 create clock-out-form-reminder");
    expect(calls).toMatch(/wrangler d1 migrations apply clock-out-form-reminder --remote --config .*wrangler\.deploy\.json/);
    expect(calls.indexOf("wrangler deploy --config")).toBeLessThan(calls.indexOf("wrangler secret put CT_API_KEY"));
    expect(calls).toContain("secret CT_API_KEY=ct-key-full");
    expect(calls).toContain(`secret CT_WEBHOOK_SECRET=${v.CT_WEBHOOK_SECRET}`);
    expect(calls).not.toContain("INTEGRATOR_RELAY_SECRET");
    const built = JSON.parse(readFileSync(cf.env.WIZARD_DEPLOY_CONFIG!, "utf8"));
    expect(built.d1_databases[0].database_id).toBe(v.D1_DATABASE_ID);
    expect(built.vars.COMPLIANCE_FORM_ID).toBe("501");
    expect(r.out).toContain("Deployed: https://clock-out-form-reminder.test.workers.dev");

    // The three subscriptions; the other integration's left alone.
    expect(webhooks.find((w) => w.id === 1)?.name).toBe("Someone else's");
    const ours = webhooks.filter((w) => w.url === url);
    expect(ours.map((w) => [w.featureType, w.entityId, w.eventTypes])).toEqual([
      ["time_activity", null, expect.arrayContaining(["clock_out", "auto_clock_out", "admin_edit", "admin_delete", "admin_approved_edit_request"])],
      ["forms", "501", ["form_submission"]],
      ["tasks", "701", ["task_completed"]],
    ]);
    for (const w of ours) expect(w).toMatchObject({ secretKey: v.CT_WEBHOOK_SECRET, isDisabled: false });
    expect((ours[0]!.eventTypes as string[]).some((e) => e.startsWith("user_") || e.startsWith("admin_declined"))).toBe(false);

    // 18: one real Reminder to the owner, as the publisher.
    expect(dms).toHaveLength(1);
    expect(dms[0]!.userId).toBe(1);
    expect(dms[0]!.body.senderId).toBe(2480518);
    expect(dms[0]!.body.text).toMatch(/^Hi Okky 👋\n\nWe haven't received your form for this shift yet\.\n\nShift: \w{3} \d+ \w{3}, 9:00 am – 5:00 pm\nForm: Daily Compliance Form\nWhere: the Forms tab in the Connecteam app\n\nPlease submit it now\. Your manager is notified if it's still missing in 4 hours\.$/);
    expect(r.out).toContain("Sent to Okky Stafford (owner):");
    expect(r.out).toContain("All set.");
    expect(r.out).toContain("The reminder is on.");

    // A rerun: same database, same secret, the webhooks updated (an extra from earlier removed), not added.
    webhooks.push({ id: 950, url, featureType: "forms", eventTypes: ["form_submission"] });
    webhookCalls.length = 0;
    const again = await run([], FIRST_RUN.replace("ct-key-full", "").replace("\n1\n\n\n\n\n", "\n\n\n\n\n\n").replace("\n\n1\n2480518", "\n\n\n2480518"), env, cf.env);
    expect(again.code, again.out).toBe(0);
    expect(saved(env).D1_DATABASE_ID).toBe(v.D1_DATABASE_ID);
    expect(saved(env).CT_WEBHOOK_SECRET).toBe(v.CT_WEBHOOK_SECRET);
    expect(cf.log().match(/d1 create/g)).toHaveLength(1);
    expect(again.out).toContain("Reusing the database already on this account.");
    expect(webhookCalls.filter((c) => c.startsWith("POST"))).toEqual([]);
    expect(webhookCalls.filter((c) => c.startsWith("PUT"))).toHaveLength(3);
    expect(webhookCalls).toContain("DELETE 950");
    expect(webhooks.filter((w) => w.url === url)).toHaveLength(3);
    rmSync(cf.dir, { recursive: true });
  });
});

describe("step 18 on its own (--step test)", { timeout: SLOW }, () => {
  const ready = () =>
    envWithKey(
      [
        "COMPLIANCE_FORM_ID='501'", "WHERE_TO_FIND='the red folder'", "GRACE_PERIOD_MINUTES='30'", "ESCALATION_DELAY_MINUTES='90'",
        "QUIET_HOURS_ENABLED='false'", "TIME_ZONE='Australia/Perth'", "REMINDER_TASK_ENABLED='false'", "CT_PUBLISHER_ID='2480518'",
        "CT_PUBLISHER_NAME='Compliance Reminders (Automated)'", "ALERTS_CHANNEL_ID='chat-12'",
      ].join("\n") + "\n",
    );

  beforeEach(() => {
    answers = [{ status: 200, dayLimit: 20_000 }];
    dms.length = 0;
    dmAnswer = { status: 200 };
  });

  it("finds someone by part of their name and sends them the real wording", async () => {
    const r = await run(["--step", "test"], "jor\ny\ny\n", ready());
    expect(r.code).toBe(0);
    expect(dms).toEqual([{ userId: 5, body: { senderId: 2480518, text: expect.stringContaining("Hi Jordan 👋") } }]);
    expect(dms[0]!.body.text).toContain("Where: the red folder");
    expect(dms[0]!.body.text).toContain("still missing in 1 hour 30 minutes.");
  });

  it("lists the matches when several people match", async () => {
    // "admin" matches the label "(admin)" on Priya and Marcus, and the name of the invited one.
    const r = await run(["--step", "test"], "admin\n2\ny\ny\n", ready());
    expect(r.code).toBe(0);
    expect(r.out).toContain("1) Invited Admin");
    expect(dms).toHaveLength(1);
  });

  it("reports a send that didn't go, and why", async () => {
    dmAnswer = { status: 404, detail: "Sender id not found" };
    const r = await run(["--step", "test"], "jordan\ny\n", ready());
    expect(r.code).toBe(1);
    expect(r.out).toContain("Connecteam doesn't know the sender (the custom publisher). Rerun: npm run setup -- --step sender");
    expect(r.out).not.toContain("Sent to");
  });

  it("sends nothing when told not to", async () => {
    const r = await run(["--step", "test"], "jordan\nn\n", ready());
    expect(r.code).toBe(0);
    expect(dms).toHaveLength(0);
    expect(r.out).toContain("Not sent.");
  });
});

describe("step 1, the Cloudflare account (the parts after the browser)", { timeout: SLOW }, () => {
  it("shows only the account table, and says plainly when wrangler's sign-in is missing permissions", async () => {
    // As wrangler 4 prints it, with the warning it adds when the token lacks a scope.
    const whoami = [
      "👋 You are logged in with an OAuth Token, associated with the email okky@example.com.",
      "┌─────────────────┬──────────┐",
      "│ Account Name    │ Account ID │",
      "├─────────────────┼──────────┤",
      "│ Example Pty Ltd │ 3f2a91c0 │",
      "└─────────────────┴──────────┘",
      "🔓 Token Permissions:",
      "Scope (Access)",
      "- account (read)",
      "- user (read)",
      "",
      "▲ [WARNING] Wrangler is missing some expected Oauth scopes. To fix this, run `wrangler login` to refresh your token. The missing scopes are:",
      "  - containers (write)",
      "",
    ].join("\n");
    const cf = fakeWrangler({ whoami });
    const r = await run([], "\ny\nn\n", tempEnv(), cf.env);
    expect(r.code).toBe(1);
    expect(r.out).toContain("│ Example Pty Ltd │ 3f2a91c0 │");
    expect(r.out).not.toContain("- account (read)");
    expect(r.out).not.toContain("containers");
    expect(r.out).toContain("missing some permissions: npx wrangler login refreshes them.");
    rmSync(cf.dir, { recursive: true });
  });
});

describe("step 18's picker, with more than one owner", { timeout: SLOW }, () => {
  it("Enter with nothing typed asks for part of a name", async () => {
    const before = USERS;
    USERS = [...USERS, { userId: 7, firstName: "Second", lastName: "Owner", userType: "owner", isArchived: false, customFields: [] }];
    const env = envWithKey(
      "COMPLIANCE_FORM_ID='501'\nWHERE_TO_FIND='x'\nGRACE_PERIOD_MINUTES='30'\nESCALATION_DELAY_MINUTES='90'\nQUIET_HOURS_ENABLED='false'\nTIME_ZONE='Australia/Perth'\nREMINDER_TASK_ENABLED='false'\nCT_PUBLISHER_ID='2480518'\nCT_PUBLISHER_NAME='P'\nALERTS_CHANNEL_ID='chat-12'\n",
    );
    const r = await run(["--step", "test"], "\njordan\nn\n", env);
    USERS = before;
    expect(r.code).toBe(0);
    expect(r.out).toContain("Type part of a name.");
    expect(r.out).not.toContain('No one matches ""');
  });
});

/** A Deployment that's on: every setting saved, the database made, the Worker deployed. */
const RUNNING = [
  "CT_API_KEY='ct-key-saved'", "D1_DATABASE_ID='11111111-2222-3333-4444-555555555555'", "CT_WEBHOOK_SECRET='hook-secret-abc'",
  "TIME_ZONE='Australia/Melbourne'", "COMPLIANCE_FORM_ID='501'", "SHIFT_DATE_QUESTION_ID='q-shift'", "WHERE_TO_FIND='the red folder'",
  "GRACE_PERIOD_MINUTES='30'", "ESCALATION_DELAY_MINUTES='240'", "QUIET_HOURS_ENABLED='true'", "QUIET_HOURS_FROM='21:00'",
  "QUIET_HOURS_UNTIL='07:00'", "EXCLUDED_ADMIN_IDS=''", "REMINDER_TASK_ENABLED='true'", "TASK_BOARD_ID='701'",
  "CT_PUBLISHER_ID='2480518'", "CT_PUBLISHER_NAME='Compliance Reminders (Automated)'", "ALERTS_CHANNEL_ID='chat-12'",
].join("\n") + "\n";
const running = () => {
  const env = tempEnv();
  writeFileSync(env, RUNNING, { mode: 0o600 });
  return env;
};
const COUNTS = { needs_form: 12, scheduled: 3, not_escalated: 9, held: 0, tasks_open: 2, alerts_open: 0 };
const WORKER = "https://clock-out-form-reminder.test.workers.dev/webhook";

describe("rerunning a step on a running Deployment (--step, #41)", { timeout: SLOW }, () => {
  beforeEach(() => {
    answers = [{ status: 200, dayLimit: 20_000 }];
    webhookCalls.length = 0;
  });

  it("a form switch shows what it affects, read from D1, then deploys and moves the form webhook", async () => {
    webhooks = [
      { id: 1, name: "Someone else's", url: "https://other.example/hook", featureType: "users" },
      { id: 11, url: WORKER, featureType: "time_activity" },
      { id: 12, url: WORKER, featureType: "forms", entityId: "501" },
      { id: 13, url: WORKER, featureType: "tasks", entityId: "701" },
    ];
    const cf = fakeWrangler({ databaseId: "11111111-2222-3333-4444-555555555555", counts: COUNTS });
    const env = running();
    // Form 3 (once per person: use it anyway), no date question in it, Enter keeps the place; apply.
    const r = await run(["--step", "form"], "3\ny\n\ny\n", env, cf.env);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("What this changes");
    expect(flat(r.out)).toContain("12 Shifts are in progress. They'll accept either form; Shifts from now on need the new one.");
    expect(flat(r.out)).toContain("Submissions from now on count by time");
    const calls = cf.log();
    expect(calls).toMatch(/wrangler d1 execute clock-out-form-reminder --remote --json --config \S+ --command SELECT/);
    expect(calls.indexOf("d1 execute")).toBeLessThan(calls.indexOf("wrangler deploy --config"));
    expect(JSON.parse(readFileSync(cf.env.WIZARD_DEPLOY_CONFIG!, "utf8")).vars.COMPLIANCE_FORM_ID).toBe("503");
    expect(webhooks.find((w) => w.id === 12)?.entityId).toBe("503");
    expect(webhooks.find((w) => w.id === 1)?.name).toBe("Someone else's");
    expect(calls).not.toContain("secret put");
    expect(r.out).toContain("Applied.");
    rmSync(cf.dir, { recursive: true });
  });

  it("answering n puts .dev.vars back and deploys nothing", async () => {
    const cf = fakeWrangler({ databaseId: "11111111-2222-3333-4444-555555555555", counts: COUNTS });
    const env = running();
    const r = await run(["--step", "timings"], "45\n\nn\n", env, cf.env);
    expect(r.code, r.out).toBe(0);
    expect(flat(r.out)).toContain("3 Shifts are waiting for a reminder or escalation already scheduled. Those keep their times.");
    expect(r.out).toContain(`Not applied.`);
    expect(readFileSync(env, "utf8")).toBe(RUNNING);
    expect(cf.log()).not.toMatch(/wrangler deploy --config/);
    rmSync(cf.dir, { recursive: true });
  });

  it("Ctrl-C at the question puts .dev.vars back and deploys nothing", async () => {
    const cf = fakeWrangler({ databaseId: "11111111-2222-3333-4444-555555555555", counts: COUNTS });
    const env = running();
    const r = await interrupt(["--step", "timings"], "45\n\n", "Apply it now?", env, cf.env);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("Not applied.");
    expect(readFileSync(env, "utf8")).toBe(RUNNING);
    expect(cf.log()).not.toMatch(/wrangler deploy --config/);
    rmSync(cf.dir, { recursive: true });
  });

  it("nothing changed: nothing to apply, and Cloudflare isn't touched", async () => {
    const cf = fakeWrangler({ databaseId: "11111111-2222-3333-4444-555555555555", counts: COUNTS });
    const r = await run(["--step", "quiet-hours"], "\n\n\n", running(), cf.env);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Nothing changed, so there's nothing to apply.");
    expect(cf.log()).toBe("");
    rmSync(cf.dir, { recursive: true });
  });

  it("a new key is stored on Cloudflare after the deploy; the preview goes without counts when D1 can't be read", async () => {
    const cf = fakeWrangler({ databaseId: "11111111-2222-3333-4444-555555555555" });
    const r = await run(["--step", "key"], "ct-key-new\ny\n", running(), cf.env);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Couldn't read what's in progress from the database, so no counts.");
    expect(r.out).toContain("The new key is used from the next check, within a minute.");
    expect(r.out).not.toContain("ct-key-new");
    const calls = cf.log();
    expect(calls.indexOf("wrangler deploy --config")).toBeLessThan(calls.indexOf("secret put CT_API_KEY"));
    expect(calls).toContain("secret CT_API_KEY=ct-key-new");
    rmSync(cf.dir, { recursive: true });
  });

  it("--step support adds the link on a running Deployment and stores its secret", async () => {
    const cf = fakeWrangler({ databaseId: "11111111-2222-3333-4444-555555555555", counts: COUNTS });
    const r = await run(["--step", "support"], "y\nhttps://relay.example.workers.dev\nacme\nrelay-secret-9\ny\n", running(), cf.env);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Problems are also sent to your integrator from now on");
    expect(cf.log()).toContain("secret INTEGRATOR_RELAY_SECRET=relay-secret-9");
    expect(JSON.parse(readFileSync(cf.env.WIZARD_DEPLOY_CONFIG!, "utf8")).vars.INTEGRATOR_RELAY_URL).toBe("https://relay.example.workers.dev");
    rmSync(cf.dir, { recursive: true });
  });

  it("before the reminder is turned on, a rerun only saves", async () => {
    const cf = fakeWrangler();
    const env = envWithKey();
    const r = await run(["--step", "quiet-hours"], "n\n", env, cf.env);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("It goes live when you finish setup: npm run setup");
    expect(saved(env).QUIET_HOURS_ENABLED).toBe("false");
    expect(cf.log()).toBe("");
    rmSync(cf.dir, { recursive: true });
  });
});

describe("rerunning the webhooks (--step webhook)", { timeout: SLOW }, () => {
  beforeEach(() => {
    answers = [{ status: 200, dayLimit: 20_000 }];
    webhookCalls.length = 0;
  });

  it("shows what changes in Connecteam, then replaces only this Deployment's own subscriptions", async () => {
    webhooks = [
      { id: 1, name: "Someone else's", url: "https://other.example/hook", featureType: "forms", entityId: "501" },
      { id: 11, name: "Clock-out Form Reminder: clock-outs", url: WORKER, featureType: "time_activity" },
      { id: 12, name: "Clock-out Form Reminder: form submissions", url: WORKER, featureType: "forms", entityId: "501" },
      { id: 14, name: "Clock-out Form Reminder: form submissions", url: WORKER, featureType: "forms", entityId: "501" },
    ];
    const cf = fakeWrangler({ databaseId: "11111111-2222-3333-4444-555555555555" });
    const env = running();
    const r = await run(["--step", "webhook"], "y\n", env, cf.env);
    expect(r.code, r.out).toBe(0);
    // The address came from the webhooks themselves: nothing deployed.
    expect(r.out).toContain("This reminder is at https://clock-out-form-reminder.test.workers.dev.");
    expect(cf.log()).toBe("");
    expect(r.out).toContain("Update: time_activity (id 11)");
    expect(r.out).toContain("Update: forms (id 12)");
    expect(r.out).toContain("Add: tasks");
    expect(r.out).toContain("Remove: extra webhook (id 14)");
    expect(r.out).toContain("Left alone: 1 other webhook on your account");
    expect(webhookCalls).toEqual(["PUT 11", "PUT 12", "POST tasks", "DELETE 14"]);
    expect(webhooks.find((w) => w.id === 1)).toEqual({ id: 1, name: "Someone else's", url: "https://other.example/hook", featureType: "forms", entityId: "501" });
    expect(readFileSync(env, "utf8")).toBe(RUNNING);
    rmSync(cf.dir, { recursive: true });
  });

  it("with none of its webhooks left, asks before deploying to read its address", async () => {
    webhooks = [{ id: 1, name: "Someone else's", url: "https://other.example/hook", featureType: "forms" }];
    const cf = fakeWrangler({ databaseId: "11111111-2222-3333-4444-555555555555" });
    const no = await run(["--step", "webhook"], "n\n", running(), cf.env);
    expect(no.code, no.out).toBe(0);
    expect(no.out).toContain("No webhooks of this reminder's in Connecteam.");
    expect(cf.log()).not.toMatch(/wrangler deploy --config/);
    expect(webhookCalls).toEqual([]);
    const yes = await run(["--step", "webhook"], "y\ny\n", running(), cf.env);
    expect(yes.code, yes.out).toBe(0);
    expect(cf.log()).toMatch(/wrangler deploy --config/);
    expect(webhookCalls).toEqual(["POST time_activity", "POST forms", "POST tasks"]);
    rmSync(cf.dir, { recursive: true });
  });

  it("changes nothing in Connecteam when told not to", async () => {
    webhooks = [{ id: 11, name: "Clock-out Form Reminder: clock-outs", url: WORKER, featureType: "time_activity" }];
    const cf = fakeWrangler({ databaseId: "11111111-2222-3333-4444-555555555555" });
    const r = await run(["--step", "webhook"], "n\n", running(), cf.env);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Nothing changed in Connecteam.");
    expect(webhookCalls).toEqual([]);
    rmSync(cf.dir, { recursive: true });
  });

  it("stops before the reminder is turned on", async () => {
    const r = await run(["--step", "webhook"], "", envWithKey());
    expect(r.code).toBe(1);
    expect(r.out).toContain("The reminder isn't on yet. Turn it on first: npm run setup");
  });
});
