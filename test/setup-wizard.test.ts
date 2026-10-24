/**
 * The setup wizard's groundwork (#37), driven as a person would: the real
 * script with typed input, no browser, and a fake Connecteam on localhost
 * answering with the rate-limit headers the live API sends. The Cloudflare
 * step needs a person and a real account, so only its entry points are
 * checked here.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(root, "scripts/setup-wizard.sh");

/** What the fake Connecteam answers next, in order; the last one repeats. */
let answers: { status: number; dayLimit?: number }[] = [];
const seenKeys: string[] = [];
let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    seenKeys.push(String(req.headers["x-api-key"] ?? ""));
    const a = answers.length > 1 ? answers.shift()! : answers[0]!;
    res.writeHead(a.status, {
      "content-type": "application/json",
      ...(a.dayLimit !== undefined ? { "x-ratelimit-day-limit": String(a.dayLimit), "x-ratelimit-day-remaining": String(a.dayLimit - 1) } : {}),
    });
    res.end(a.status === 200 ? '{"data":{"timeClocks":[]}}' : '{"detail":"Invalid API key"}');
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
    const later = await run(["--step", "form"]);
    expect(later.code).toBe(2);
    expect(later.out).toContain(`The "form" step isn't in this version of the wizard yet.`);
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
