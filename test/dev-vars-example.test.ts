/**
 * `.dev.vars.example` is what a fresh setup copies. It must list exactly the
 * values the deploy script knows (the database id and every setting from #19),
 * and be tracked by git, while the real `.dev.vars` stays ignored.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEV_VARS_KEYS, parseDevVars } from "../scripts/lib/deploy-config.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const example = readFileSync(`${root}.dev.vars.example`, "utf8");

describe(".dev.vars.example", () => {
  it("lists every value the deploy script knows, and nothing else", () => {
    expect(Object.keys(parseDevVars(example)).sort()).toEqual([...DEV_VARS_KEYS].sort());
  });

  it("holds no real secret", () => {
    const values = parseDevVars(example);
    for (const key of ["CT_API_KEY", "CT_WEBHOOK_SECRET", "INTEGRATOR_RELAY_SECRET", "D1_DATABASE_ID"]) {
      expect(values[key]).toBe("");
    }
  });
});

const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
/** `git check-ignore` exits 0 when the path is ignored, 1 when it isn't. */
const ignored = (path: string): boolean => {
  try {
    git("check-ignore", "-q", "--no-index", path);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!existsSync(`${root}.git`))("git", () => {
  it("doesn't ignore .dev.vars.example, so a fresh clone has it", () => {
    expect(ignored(".dev.vars.example")).toBe(false);
  });

  it.each([".dev.vars", ".dev.vars.local", "wrangler.deploy.json"])("ignores %s", (path) => {
    expect(ignored(path)).toBe(true);
  });
});
