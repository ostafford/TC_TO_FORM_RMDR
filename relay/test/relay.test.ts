/*
 * Adapted from EH_Webhook (~/IDP/EH_Webhook/integrator-relay/test/relay.test.ts
 * at 0c5ec92): alerts per (client, condition) with an all clear, and missed
 * check-ins (#35).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MISSED_CHECK_IN_MS, handleMissedCheckIns, handleTelemetry, type RelayDeps } from "../src/relay.js";
import type { GitHubIssues, Issue } from "../src/github.js";
import type { CheckInRecord, CheckInStore } from "../src/types.js";

/** In-memory GitHub Issues, enough to assert dedupe / create / close. */
function fakeGitHub() {
  const issues: (Issue & { labels: string[] })[] = [];
  const comments: Array<{ number: number; body: string }> = [];
  let seq = 100;
  let failing = false;
  const gh: GitHubIssues = {
    async findOpenByTitle(title) {
      if (failing) throw new Error("GitHub down");
      return [...issues].reverse().find((i) => i.title === title && i.state === "open") ?? null;
    },
    async create({ title, body, labels }) {
      if (failing) throw new Error("GitHub down");
      const issue = { number: ++seq, title, state: "open" as const, body, html_url: `https://github.test/i/${seq}`, labels };
      issues.push(issue);
      return issue;
    },
    async comment(number, body) {
      if (failing) throw new Error("GitHub down");
      comments.push({ number, body });
    },
    async update(number, patch) {
      if (failing) throw new Error("GitHub down");
      const i = issues.find((x) => x.number === number);
      if (!i) throw new Error(`no issue ${number}`);
      if (patch.body !== undefined) i.body = patch.body;
      if (patch.state !== undefined) i.state = patch.state;
    },
  };
  return { gh, issues, comments, fail: (on: boolean) => (failing = on) };
}

function memoryCheckIns(): CheckInStore & { rows: Map<string, CheckInRecord> } {
  const rows = new Map<string, CheckInRecord>();
  return {
    rows,
    async get(client) {
      return rows.get(client) ?? null;
    },
    async set(client, record) {
      rows.set(client, { ...record });
    },
    async all() {
      return Object.fromEntries(rows);
    },
  };
}

const T0 = Date.parse("2026-10-24T00:00:00Z");
const HOUR = 60 * 60 * 1000;

let world: ReturnType<typeof fakeGitHub>;
let checkIns: ReturnType<typeof memoryCheckIns>;
let emails: Array<{ subject: string; text: string }>;
let clock: number;
let deps: RelayDeps;

beforeEach(() => {
  world = fakeGitHub();
  checkIns = memoryCheckIns();
  emails = [];
  clock = T0;
  deps = {
    gh: world.gh,
    checkIns,
    now: () => new Date(clock),
    forwardEmail: async (subject, text) => {
      emails.push({ subject, text });
    },
  };
});

const PAUSED =
  "ALERT · PAUSED\n\nCause: Connecteam rejected the API key\nEffect: no reminders or escalations\n\n" +
  'Action: create a new API key (Settings → API keys), then rerun setup step "API key".';

const alert = (over: Record<string, unknown> = {}) => ({
  kind: "alert",
  client: "acme",
  condition: "key",
  state: "raised",
  text: PAUSED,
  at: "2026-10-24T00:00:00Z",
  ...over,
});

describe("handleTelemetry — alert", () => {
  it("opens one issue for the first alert, naming the condition and quoting the alert", async () => {
    const r = await handleTelemetry(alert(), deps);
    expect(r).toEqual({ status: 202, body: { ok: true, issue: 101, deduped: false } });
    expect(world.issues).toHaveLength(1);
    expect(world.issues[0]!.title).toBe("[clock-out reminder] paused, API key rejected — acme");
    expect(world.issues[0]!.labels).toEqual(["clock-out-relay", "failure-alert"]);
    expect(world.issues[0]!.body).toContain("> ALERT · PAUSED\n>\n> Cause: Connecteam rejected the API key");
    expect(emails).toHaveLength(1);
  });

  it("comments on the open issue for a repeat (client + condition), no new issue", async () => {
    await handleTelemetry(alert(), deps);
    const r = await handleTelemetry(alert({ at: "2026-10-25T00:00:00Z" }), deps);
    expect(r.body).toMatchObject({ deduped: true, issue: 101 });
    expect(world.issues).toHaveLength(1);
    expect(world.comments[0]!.body).toMatch(/^Raised again at 2026-10-25T00:00:00Z\./);
  });

  it("opens a separate issue for a different condition, and for a different client", async () => {
    await handleTelemetry(alert(), deps);
    await handleTelemetry(alert({ condition: "messages" }), deps);
    await handleTelemetry(alert({ client: "globex" }), deps);
    expect(world.issues.map((i) => i.title)).toEqual([
      "[clock-out reminder] paused, API key rejected — acme",
      "[clock-out reminder] messages not sending — acme",
      "[clock-out reminder] paused, API key rejected — globex",
    ]);
  });

  it("names a condition it doesn't know by its slug", async () => {
    await handleTelemetry(alert({ condition: "something_new" }), deps);
    expect(world.issues[0]!.title).toBe("[clock-out reminder] something_new — acme");
  });

  it("the all clear comments on the issue and closes it", async () => {
    await handleTelemetry(alert(), deps);
    const r = await handleTelemetry(
      alert({ state: "cleared", text: "ALL CLEAR\n\nConnecteam accepts the API key again.\n\nAction: none." }),
      deps,
    );
    expect(r.body).toMatchObject({ closed: true, issue: 101 });
    expect(world.issues[0]!.state).toBe("closed");
    expect(world.comments.at(-1)!.body).toContain("> Connecteam accepts the API key again.");
  });

  it("an all clear with no issue open does nothing", async () => {
    const r = await handleTelemetry(alert({ state: "cleared" }), deps);
    expect(r.body).toMatchObject({ noop: true });
    expect(world.issues).toHaveLength(0);
  });

  it("opens a fresh issue once the last one was closed", async () => {
    await handleTelemetry(alert(), deps);
    await handleTelemetry(alert({ state: "cleared" }), deps);
    const r = await handleTelemetry(alert(), deps);
    expect(r.body).toMatchObject({ deduped: false });
    expect(world.issues).toHaveLength(2);
  });

  it("falls back to unknown-client when no slug is given, and keeps a slug plain", async () => {
    await handleTelemetry(alert({ client: "" }), deps);
    await handleTelemetry(alert({ client: "acme co\n[x]", condition: "form" }), deps);
    expect(world.issues.map((i) => i.title)).toEqual([
      "[clock-out reminder] paused, API key rejected — unknown-client",
      "[clock-out reminder] Compliance Form not found — acme-co-x-",
    ]);
  });

  it("does not fail the request when the email forward throws", async () => {
    deps.forwardEmail = async () => {
      throw new Error("smtp down");
    };
    expect((await handleTelemetry(alert(), deps)).status).toBe(202);
  });
});

describe("check-ins", () => {
  const checkIn = (client = "acme") => handleTelemetry({ kind: "check_in", client, at: new Date(clock).toISOString() }, deps);

  it("stores each Deployment's last check-in, and opens no issue", async () => {
    expect((await checkIn()).status).toBe(202);
    expect(checkIns.rows.get("acme")).toEqual({ lastAt: T0, flaggedAt: null });
    expect(world.issues).toHaveLength(0);
  });

  it("a Deployment silent for more than 36 hours gets one issue, however often the check runs", async () => {
    await checkIn();
    clock = T0 + MISSED_CHECK_IN_MS;
    expect(await handleMissedCheckIns(deps)).toEqual({ opened: [], failed: [] });

    clock = T0 + MISSED_CHECK_IN_MS + HOUR;
    expect(await handleMissedCheckIns(deps)).toEqual({ opened: ["acme"], failed: [] });
    clock += HOUR;
    expect(await handleMissedCheckIns(deps)).toEqual({ opened: [], failed: [] });
    expect(emails).toHaveLength(1);
    expect(world.issues.map((i) => [i.title, i.labels])).toEqual([
      ["[clock-out reminder] missed check-in — acme", ["clock-out-relay", "missed-check-in"]],
    ]);
    expect(world.issues[0]!.body).toContain("**Last check-in:** 2026-10-24T00:00:00.000Z");
  });

  it("only the silent Deployment is reported", async () => {
    await checkIn("acme");
    clock = T0 + 30 * HOUR;
    await checkIn("globex");
    clock = T0 + 40 * HOUR;
    expect((await handleMissedCheckIns(deps)).opened).toEqual(["acme"]);
  });

  it("the next check-in comments on the issue and closes it", async () => {
    await checkIn();
    clock = T0 + 40 * HOUR;
    await handleMissedCheckIns(deps);
    const r = await checkIn();
    expect(r.body).toMatchObject({ closed: true });
    expect(world.issues[0]!.state).toBe("closed");
    expect(world.comments.at(-1)!.body).toMatch(/^Checked in again at /);
    expect(checkIns.rows.get("acme")).toEqual({ lastAt: clock, flaggedAt: null });
  });

  it("an issue GitHub couldn't open is tried again at the next check", async () => {
    await checkIn();
    clock = T0 + 40 * HOUR;
    world.fail(true);
    expect(await handleMissedCheckIns(deps)).toEqual({ opened: [], failed: ["acme"] });
    world.fail(false);
    clock += HOUR;
    expect((await handleMissedCheckIns(deps)).opened).toEqual(["acme"]);
    expect(world.issues).toHaveLength(1);
  });

  it("a check-in GitHub couldn't close the issue for stays flagged, so the next one closes it", async () => {
    await checkIn();
    clock = T0 + 40 * HOUR;
    await handleMissedCheckIns(deps);
    world.fail(true);
    await expect(checkIn()).rejects.toThrow(/GitHub down/);
    expect(checkIns.rows.get("acme")!.flaggedAt).not.toBeNull();
    world.fail(false);
    await checkIn();
    expect(world.issues[0]!.state).toBe("closed");
  });
});

describe("handleTelemetry — bad input", () => {
  it("400 on an unrecognised body", async () => {
    for (const b of [
      null,
      {},
      42,
      { kind: "nope" },
      { kind: "alert" },
      { kind: "alert", condition: "key" },
      { kind: "alert", condition: "Not A Slug", state: "raised" },
      { kind: "alert", condition: "key", state: "maybe" },
      { kind: "health", ok: true },
    ]) {
      expect((await handleTelemetry(b, deps)).status).toBe(400);
    }
    expect(world.issues).toHaveLength(0);
  });
});
