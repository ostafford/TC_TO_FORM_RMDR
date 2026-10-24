/**
 * The setup wizard (#37, #38), driven as a person would: the real script
 * with typed input, no browser, and a fake Connecteam on localhost answering
 * in the shapes the live API sends (rate-limit headers, time clock settings
 * and forms, tested live 2026-10-24). The Cloudflare step needs a person and
 * a real account, so only its entry points are checked here.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
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

beforeAll(async () => {
  server = createServer((req, res) => {
    seenKeys.push(String(req.headers["x-api-key"] ?? ""));
    const url = new URL(req.url ?? "/", "http://fake");
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
    send(404, { detail: "Not Found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function run(args: string[], input = "", envFile?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", [SCRIPT, ...args], {
      cwd: root,
      env: {
        ...process.env,
        NO_COLOR: "1",
        WIZARD_NO_BROWSER: "1",
        WIZARD_LOG: "off", // no `script` recording under test
        WIZARD_DETAILS: join(tmpdir(), "wizard-test-wrangler.log"),
        CT_API_BASE: base,
        ...(envFile ? { WIZARD_ENV_FILE: envFile } : {}),
      },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
    child.stdin.end(input);
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
    expect(r.out).toContain("Steps: key timezone form timings quiet-hours recipients reminder-task sender alerts webhook test");
  });

  it("refuses an unknown step, and a step not built yet, before asking anything", async () => {
    const unknown = await run(["--step", "nope"]);
    expect(unknown.code).toBe(2);
    expect(unknown.out).toContain("unknown step: nope");
    const later = await run(["--step", "recipients"]);
    expect(later.code).toBe(2);
    expect(later.out).toContain(`The "recipients" step isn't in this version of the wizard yet.`);
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
