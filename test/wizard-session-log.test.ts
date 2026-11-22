/**
 * The setup wizard's session log (#90, user story 70): an API key or webhook
 * secret pasted during setup comes out as [redacted]. Every other wizard test
 * runs with WIZARD_LOG=off, so this calls `clean_log` itself, on a recorded
 * session, with the script's own definition of it.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const wizard = fileURLToPath(new URL("../scripts/setup-wizard.sh", import.meta.url));

const API_KEY = "3f9c2a71-5d4e-4b8a-9c6f-0e1d2c3b4a59";
// As the wizard makes it: 32 random bytes in hex.
const WEBHOOK_SECRET = "9b1f4c7e2a8d5f0369c1e4b7a2d8f5c0e3b6a9d2f5c8e1b4a7d0f3c6e9b2a5d8";

/** `clean_log`, and the helpers that write and read .dev.vars, as the wizard defines them. */
function functions(): string {
  const script = readFileSync(wizard, "utf8");
  return ["write_env", "_existing", "clean_log"]
    .map((name) => {
      const m = script.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, "m"));
      if (!m) throw new Error(`${name} not found in setup-wizard.sh`);
      return m[0];
    })
    .join("\n");
}

function cleanLog(session: string, devVars: string): { log: string; mode: number } {
  const dir = mkdtempSync(join(tmpdir(), "wizard-log-"));
  const log = join(dir, "setup-wizard.log");
  const env = join(dir, ".dev.vars");
  writeFileSync(log, session);
  writeFileSync(env, devVars);
  execFileSync("bash", ["-c", `${functions()}\nENV_FILE="$2"; clean_log "$1"`, "test", log, env]);
  return { log: readFileSync(log, "utf8"), mode: statSync(log).mode & 0o777 };
}

/** Save `value` as the wizard does, then read it back as a rerun does. */
function roundTrip(value: string): string {
  const env = join(mkdtempSync(join(tmpdir(), "wizard-env-")), ".dev.vars");
  return execFileSync("bash", ["-c", `${functions()}\nENV_FILE="$2"; write_env CT_PUBLISHER_NAME "$1" >/dev/null; _existing CT_PUBLISHER_NAME`, "test", value, env], {
    encoding: "utf8",
  });
}

describe("the wizard's session log", () => {
  // As `script` records it: colour codes, carriage returns, and the key
  // pasted before its prompt appeared, so the terminal echoed it.
  const session =
    "\x1b[1mConnecteam API key\x1b[0m\r\n" +
    `${API_KEY}\r\n` +
    "\x1b[2mPaste it (hidden): \x1b[0m\r\n" +
    `  webhook secret saved: ${WEBHOOK_SECRET}\r\n` +
    "\x1b[32m✓\x1b[0m Compliance Form 9001 found\r\n";
  // Single-quoted, as the wizard's write_env saves every value.
  const devVars = [`CT_API_KEY='${API_KEY}'`, `CT_WEBHOOK_SECRET='${WEBHOOK_SECRET}'`, "COMPLIANCE_FORM_ID='9001'"].join("\n");

  it("hides a pasted API key and webhook secret as [redacted]", () => {
    const { log } = cleanLog(session, devVars);
    expect(log).not.toContain(API_KEY);
    expect(log).not.toContain(WEBHOOK_SECRET);
    expect(log).toBe(
      "Connecteam API key\n" +
        "[redacted]\n" +
        "Paste it (hidden): \n" +
        "  webhook secret saved: [redacted]\n" +
        "✓ Compliance Form 9001 found\n",
    );
  });

  it("is readable by its owner only", () => {
    expect(cleanLog(session, devVars).mode).toBe(0o600);
  });

  // macOS's own bash 3.2 kept a backslash in the decoded value, so the log
  // was searched for the wrong text (#114).
  it("hides a secret containing a quote", () => {
    const secret = "it's-a-secret-9b1f4c7e";
    const { log } = cleanLog(`  webhook secret saved: ${secret}\n`, `CT_WEBHOOK_SECRET='it'\\''s-a-secret-9b1f4c7e'`);
    expect(log).toBe("  webhook secret saved: [redacted]\n");
  });
});

describe("a saved setting read back on a rerun (#114)", () => {
  it.each(["Sam's bot", "'quoted'", "it''s", "plain"])("comes back exactly: %s", (value) => {
    expect(roundTrip(value)).toBe(value);
  });
});
