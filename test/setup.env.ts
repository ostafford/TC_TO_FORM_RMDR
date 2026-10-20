/**
 * Loads a local, git-ignored `.dev.vars` (KEY=VALUE lines) into process.env so
 * the live integration tests can pick up credentials without them ever being
 * passed on a command line or committed. No-op if the file is absent.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

try {
  const path = fileURLToPath(new URL("../.dev.vars", import.meta.url));
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
} catch {
  // no .dev.vars - fine, integration tests self-skip
}
