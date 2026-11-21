/**
 * User story 71: the project installs on its own. Nothing in `src/` or
 * `scripts/` imports from a sibling project (EH_Webhook's client was copied
 * in, not imported), and every package it names is one it installs itself.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
const installed = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };

function sources(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(ts|mts|js|mjs)$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
}

/** Every module a file imports: static `import`/`export ... from`, side-effect `import "x"`, and `import("x")`. */
function specifiers(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const patterns = [
    /^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm,
    /^\s*import\s+["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  return patterns.flatMap((p) => [...text.matchAll(p)].map((m) => m[1]!));
}

/** The package a bare specifier names: `@scope/name` or `name`. */
const packageOf = (spec: string) => spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");
const builtin = (spec: string) => spec.startsWith("node:") || builtinModules.includes(spec);

describe("the project stands alone (US 71)", () => {
  const files = [...sources("src"), ...sources("scripts")];

  it("finds the source files to check", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("imports nothing from outside the repo by path", () => {
    const outside = files.flatMap((f) =>
      specifiers(f)
        .filter((s) => s.startsWith("."))
        .filter((s) => relative(root, resolve(dirname(f), s)).startsWith(".."))
        .map((s) => `${relative(root, f)}: ${s}`),
    );
    expect(outside).toEqual([]);
  });

  it("names only Node's own modules and packages it installs itself", () => {
    const unknown = files.flatMap((f) =>
      specifiers(f)
        .filter((s) => !s.startsWith(".") && !builtin(s) && !s.startsWith("cloudflare:"))
        .filter((s) => !(packageOf(s) in installed))
        .map((s) => `${relative(root, f)}: ${s}`),
    );
    expect(unknown).toEqual([]);
  });

  it("installs no package from a local path or workspace", () => {
    const local = Object.entries(installed).filter(([, v]) => /^(file:|link:|workspace:|\.{0,2}\/)/.test(v));
    expect(local).toEqual([]);
  });
});
