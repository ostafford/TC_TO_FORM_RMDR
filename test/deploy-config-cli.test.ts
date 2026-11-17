/**
 * `scripts/deploy-config.ts --check-live` run as `npm run deploy` runs it,
 * against a fake wrangler: the live Worker's secrets (#80).
 */
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const DB = "11111111-2222-3333-4444-555555555555";

const DEV_VARS = [
  `D1_DATABASE_ID=${DB}`,
  "CT_API_KEY=ct-key",
  "CT_WEBHOOK_SECRET=hook-secret",
  "COMPLIANCE_FORM_ID=9001",
  "WHERE_TO_FIND=the Forms tab",
  "GRACE_PERIOD_MINUTES=30",
  "ESCALATION_DELAY_MINUTES=240",
  "QUIET_HOURS_ENABLED=true",
  "TIME_ZONE=Australia/Sydney",
  "REMINDER_TASK_ENABLED=false",
  "CT_PUBLISHER_ID=4242",
  "CT_PUBLISHER_NAME=Reminders (automated)",
  "ALERTS_CHANNEL_ID=alerts-1",
].join("\n");

/**
 * A stand-in for wrangler. `secrets` set: a live Worker exists with those
 * secret names (and the same database). Unset: no Worker yet.
 */
function fakeWrangler(secrets?: string[]): { bin: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "deploy-config-"));
  const bin = join(dir, "wrangler");
  const live = secrets !== undefined;
  // As wrangler 4.151.2 prints them.
  const status = JSON.stringify({ versions: [{ version_id: "v1", percentage: 100 }] });
  const version = JSON.stringify({ resources: { bindings: [{ name: "DB", type: "d1", database_id: DB }] } });
  const list = JSON.stringify((secrets ?? []).map((name) => ({ name, type: "secret_text" })));
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
case "$1 $2" in
  "d1 list") echo '[{"uuid":"${DB}","name":"clock-out-form-reminder"}]' ;;
  "deployments status") ${live ? `echo '${status}'` : `echo "This Worker does not exist on your account. [code: 10007]" >&2; exit 1`} ;;
  "versions view") echo '${version}' ;;
  "secret list") echo '${list}' ;;
  *) echo "fake wrangler: unexpected $*" >&2; exit 9 ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return { bin, dir };
}

function checkLive(secrets?: string[], args: string[] = []): Promise<{ code: number; out: string }> {
  const { bin, dir } = fakeWrangler(secrets);
  const devVars = join(dir, ".dev.vars");
  writeFileSync(devVars, DEV_VARS);
  return new Promise((resolve) => {
    execFile(
      join(root, "node_modules/.bin/tsx"),
      ["scripts/deploy-config.ts", "--check-live", ...args],
      {
        cwd: root,
        env: { ...process.env, WRANGLER_CMD: bin, DEV_VARS_FILE: devVars, DEPLOY_CONFIG_FILE: join(dir, "wrangler.deploy.json") },
      },
      (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
    );
  });
}

describe("npm run deploy and the live Worker's secrets", { timeout: 30_000 }, () => {
  it("refuses while the live Worker is missing a secret, and names it", async () => {
    const r = await checkLive(["CT_API_KEY"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("✗ The live Worker is missing CT_WEBHOOK_SECRET. Without CT_API_KEY and CT_WEBHOOK_SECRET, it deploys and then does nothing.");
    expect(r.out).toContain("Set it, then deploy again");
    expect(r.out).toContain("Nothing was deployed or changed.");
  });

  it("names both when both are missing", async () => {
    const r = await checkLive([]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("✗ The live Worker is missing CT_API_KEY and CT_WEBHOOK_SECRET.");
    expect(r.out).toContain("Set them, then deploy again");
    expect(r.out).toMatch(/secret put CT_API_KEY --config \S+wrangler\.deploy\.json/);
    expect(r.out).toMatch(/secret put CT_WEBHOOK_SECRET --config \S+wrangler\.deploy\.json/);
  });

  it("on a first deploy, warns to set the secrets and carries on", async () => {
    const r = await checkLive();
    expect(r.code).toBe(0);
    expect(r.out).toContain("! It has no secrets yet: set CT_API_KEY and CT_WEBHOOK_SECRET now, or the Worker will do nothing.");
  });

  it("with --secrets-follow (the wizard, about to set them), a missing secret is noted, not refused", async () => {
    const r = await checkLive(["CT_API_KEY"], ["--secrets-follow"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("missing CT_WEBHOOK_SECRET, set right after this deploy");
  });

  it("with --secrets-follow, a first deploy doesn't warn", async () => {
    const r = await checkLive(undefined, ["--secrets-follow"]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("now, or the Worker will do nothing");
  });
});
