import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import {
  DATABASE_ID_KEY,
  DATABASE_ID_PLACEHOLDER,
  DEPLOY_CONFIG_PATH,
  SECRET_KEYS,
  VAR_KEYS,
  checkSettings,
  compareWithLive,
  parseDevVars,
  renderDeployConfig,
  stripJsonc,
  type LiveBinding,
} from "../scripts/lib/deploy-config.js";

const read = (p: string) => readFileSync(p, "utf8");
const template = read("wrangler.jsonc");

/** A complete, valid .dev.vars. */
const goodVars: Record<string, string> = {
  [DATABASE_ID_KEY]: "11111111-2222-3333-4444-555555555555",
  CT_API_KEY: "secret-never-copied",
  CT_WEBHOOK_SECRET: "webhook-secret-never-copied",
  COMPLIANCE_FORM_ID: "9001",
  SHIFT_DATE_QUESTION_ID: "",
  WHERE_TO_FIND: "the Forms tab in the Connecteam app",
  GRACE_PERIOD_MINUTES: "30",
  ESCALATION_DELAY_MINUTES: "240",
  QUIET_HOURS_ENABLED: "true",
  QUIET_HOURS_FROM: "21:00",
  QUIET_HOURS_UNTIL: "07:00",
  TIME_ZONE: "Australia/Sydney",
  EXCLUDED_ADMIN_IDS: "101, 102",
  REMINDER_TASK_ENABLED: "true",
  TASK_BOARD_ID: "board-1",
  CT_PUBLISHER_ID: "4242",
  CT_PUBLISHER_NAME: "Form Reminder (automated)",
  ALERTS_CHANNEL_ID: "chan-1",
  INTEGRATOR_RELAY_URL: "",
  INTEGRATOR_CLIENT_SLUG: "",
  INTEGRATOR_RELAY_SECRET: "",
};

const keysOf = (problems: Array<{ key: string }>) => problems.map((p) => p.key);

describe("stripJsonc", () => {
  it("drops comments and trailing commas but not // inside a string", () => {
    const text = '{\n  // a comment\n  "url": "https://x.dev", /* block */\n  "a": [1, 2,],\n}';
    expect(JSON.parse(stripJsonc(text))).toEqual({ url: "https://x.dev", a: [1, 2] });
  });

  it("parses the real wrangler.jsonc", () => {
    expect(() => JSON.parse(stripJsonc(template))).not.toThrow();
  });
});

describe("parseDevVars", () => {
  it("reads KEY=VALUE, skipping comments and blanks, removing quotes", () => {
    expect(parseDevVars('# c\n\nA=1\nB="two"\nC=a=b\n  D = x \n')).toEqual({ A: "1", B: "two", C: "a=b", D: "x" });
  });
});

describe("checkSettings", () => {
  it("passes a complete .dev.vars", () => {
    expect(checkSettings(goodVars)).toEqual([]);
  });

  it("names every required value that's blank", () => {
    const blank = Object.fromEntries(Object.keys(goodVars).map((k) => [k, ""]));
    expect(keysOf(checkSettings(blank))).toEqual([
      DATABASE_ID_KEY,
      "COMPLIANCE_FORM_ID",
      "WHERE_TO_FIND",
      "GRACE_PERIOD_MINUTES",
      "ESCALATION_DELAY_MINUTES",
      "QUIET_HOURS_ENABLED",
      "TIME_ZONE",
      "REMINDER_TASK_ENABLED",
      "CT_PUBLISHER_ID",
      "CT_PUBLISHER_NAME",
      "ALERTS_CHANNEL_ID",
    ]);
  });

  it("treats the template's placeholder database id as missing", () => {
    expect(keysOf(checkSettings({ ...goodVars, [DATABASE_ID_KEY]: DATABASE_ID_PLACEHOLDER }))).toEqual([DATABASE_ID_KEY]);
  });

  it("needs Quiet Hours times only when Quiet Hours are on", () => {
    const noTimes = { ...goodVars, QUIET_HOURS_FROM: "", QUIET_HOURS_UNTIL: "" };
    expect(keysOf(checkSettings(noTimes))).toEqual(["QUIET_HOURS_FROM", "QUIET_HOURS_UNTIL"]);
    expect(checkSettings({ ...noTimes, QUIET_HOURS_ENABLED: "false" })).toEqual([]);
  });

  it("needs a task board only when the Reminder Task is on", () => {
    const noBoard = { ...goodVars, TASK_BOARD_ID: "" };
    expect(keysOf(checkSettings(noBoard))).toEqual(["TASK_BOARD_ID"]);
    expect(checkSettings({ ...noBoard, REMINDER_TASK_ENABLED: "false" })).toEqual([]);
  });

  it("needs a client slug once the Integrator Relay URL is set", () => {
    const relay = { ...goodVars, INTEGRATOR_RELAY_URL: "https://relay.example.workers.dev/telemetry" };
    expect(keysOf(checkSettings(relay))).toEqual(["INTEGRATOR_CLIENT_SLUG"]);
    expect(checkSettings({ ...relay, INTEGRATOR_CLIENT_SLUG: "acme" })).toEqual([]);
  });

  it.each([
    ["COMPLIANCE_FORM_ID", "form-1"],
    ["GRACE_PERIOD_MINUTES", "0"],
    ["ESCALATION_DELAY_MINUTES", "4h"],
    ["QUIET_HOURS_ENABLED", "yes"],
    ["QUIET_HOURS_FROM", "9pm"],
    ["QUIET_HOURS_UNTIL", "24:00"],
    ["TIME_ZONE", "Sydney"],
    ["EXCLUDED_ADMIN_IDS", "101;102"],
    ["CT_PUBLISHER_ID", "-1"],
    ["INTEGRATOR_RELAY_URL", "http://relay.example"],
  ])("refuses %s = %j, saying what form it needs", (key, value) => {
    const problems = checkSettings({ ...goodVars, [key]: value, INTEGRATOR_CLIENT_SLUG: "acme" });
    expect(keysOf(problems)).toEqual([key]);
    expect(problems[0]!.problem).toContain(`not "${value}"`);
  });
});

describe("renderDeployConfig", () => {
  it("fills the database id and every var from .dev.vars", () => {
    const r = renderDeployConfig(template, goodVars);
    if (!r.ok) throw new Error(JSON.stringify(r.problems));
    expect(r.config.d1_databases?.[0]?.database_id).toBe(goodVars[DATABASE_ID_KEY]);
    expect(Object.keys(r.vars)).toEqual(VAR_KEYS);
    for (const key of VAR_KEYS) expect(r.vars[key]).toBe(goodVars[key]);
  });

  it("never copies a secret into the config", () => {
    const r = renderDeployConfig(template, goodVars);
    expect(JSON.stringify(r)).not.toContain("never-copied");
    if (r.ok) for (const key of SECRET_KEYS) expect(r.vars).not.toHaveProperty(key);
  });

  it("keeps everything else in the template as it is (name, entry, cron)", () => {
    const r = renderDeployConfig(template, goodVars);
    if (!r.ok) throw new Error("render failed");
    const t = JSON.parse(stripJsonc(template));
    for (const key of ["name", "main", "compatibility_date", "triggers", "observability"]) {
      expect(r.config[key]).toEqual(t[key]);
    }
  });

  it("refuses, naming each problem, and builds nothing", () => {
    const { [DATABASE_ID_KEY]: _db, ...rest } = goodVars;
    const r = renderDeployConfig(template, { ...rest, TIME_ZONE: "Nowhere/Else" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(keysOf(r.problems)).toEqual([DATABASE_ID_KEY, "TIME_ZONE"]);
  });
});

describe("compareWithLive", () => {
  const rendered = { databaseId: "db-new", vars: { COMPLIANCE_FORM_ID: "9001", ALERTS_CHANNEL_ID: "chan-2" } };
  const live: LiveBinding[] = [
    { name: "DB", type: "d1", database_id: "db-new" },
    { name: "COMPLIANCE_FORM_ID", type: "plain_text", text: "9001" },
    { name: "ALERTS_CHANNEL_ID", type: "plain_text", text: "chan-1" },
    { name: "CT_API_KEY", type: "secret_text" },
  ];

  it("lists only the settings that change; secrets are never compared", () => {
    expect(compareWithLive(rendered, live)).toEqual({
      databaseChange: null,
      varChanges: [{ name: "ALERTS_CHANNEL_ID", live: "chan-1", next: "chan-2" }],
    });
  });

  it("flags a different database", () => {
    const moved = live.map((b) => (b.type === "d1" ? { ...b, database_id: "db-old" } : b));
    expect(compareWithLive(rendered, moved).databaseChange).toEqual({ live: "db-old", next: "db-new" });
  });
});

// The npm scripts, the runbook, any shell script (the wizard, when it lands)
// and the template must all agree on where a Deployment's values live. A slip
// in any one of them brings back the deploy that blanks a live Worker.
describe("every deploy path uses the built config, never the template", () => {
  const CFG = `--config ${DEPLOY_CONFIG_PATH}`;
  const runbookCode = [...read("docs/RUNBOOK.md").matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");
  const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
  const shellScripts = readdirSync("scripts")
    .filter((f) => f.endsWith(".sh"))
    .map((f) => read(`scripts/${f}`))
    .join("\n");

  /** Lines that run a wrangler command which reads the config's database or Worker, or deploys. */
  const configReaders = (text: string) =>
    text
      .split(/\n|&&/)
      .filter((l) => !l.trim().startsWith("#"))
      .filter((l) => /wrangler(?:["' ]| \S+ )*(deploy\b(?! --dry-run)|d1 (migrations|export|execute)|secret put)/.test(l));

  it("the template holds no Deployment's values, and its database id is not a UUID", () => {
    const t = JSON.parse(stripJsonc(template));
    expect(t.d1_databases[0].database_id).toBe(DATABASE_ID_PLACEHOLDER);
    expect(DATABASE_ID_PLACEHOLDER).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(Object.keys(t.vars)).toEqual(VAR_KEYS);
    for (const key of VAR_KEYS) expect(t.vars[key]).toBe("");
  });

  it("git ignores the values and the built config", () => {
    const ignored = read(".gitignore").split("\n");
    expect(ignored).toContain(".dev.vars");
    expect(ignored).toContain(DEPLOY_CONFIG_PATH);
  });

  it("npm run deploy and db:migrate check against the live Worker first, then use the built config", () => {
    expect(scripts.deploy).toBe(`tsx scripts/deploy-config.ts --check-live && wrangler deploy ${CFG}`);
    expect(scripts["db:migrate"]).toMatch(/^tsx scripts\/deploy-config\.ts --check-live && wrangler d1 migrations apply /);
    // The relay (relay:*) has its own config, with nothing account-specific in it (#35).
    const deployment = Object.entries(scripts).filter(([name]) => !name.startsWith("relay:")).map(([, v]) => v);
    for (const line of configReaders(deployment.join("\n"))) expect(line).toContain(CFG);
  });

  it("the runbook's commands use the built config", () => {
    expect(runbookCode).not.toMatch(/^npx wrangler deploy\s*$/m);
    const lines = configReaders(runbookCode);
    expect(lines.some((l) => /secret put/.test(l))).toBe(true);
    expect(lines.some((l) => /d1 export/.test(l))).toBe(true);
    for (const line of lines) expect(line).toContain(CFG);
  });

  it("any shell script's remote commands use the built config", () => {
    for (const line of configReaders(shellScripts)) expect(line).toContain(CFG);
  });
});
