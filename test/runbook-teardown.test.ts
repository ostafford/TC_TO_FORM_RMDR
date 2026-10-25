/**
 * Deleting the Worker alone leaves its D1 database behind, and a re-run then
 * reuses the old database. The RUNBOOK's teardown section must name every
 * Cloudflare resource wrangler.jsonc declares, in an order Cloudflare accepts,
 * so renaming or adding one can't leave the runbook out of date.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stripJsonc } from "../scripts/lib/deploy-config.js";

const config = JSON.parse(stripJsonc(readFileSync("wrangler.jsonc", "utf8"))) as {
  name: string;
  d1_databases?: Array<{ database_name: string }>;
  queues?: { consumers?: Array<{ queue: string; dead_letter_queue?: string }>; producers?: Array<{ queue: string }> };
};
const runbook = readFileSync("docs/RUNBOOK.md", "utf8");

const worker = config.name;
const databases = (config.d1_databases ?? []).map((d) => d.database_name);
const consumed = (config.queues?.consumers ?? []).map((c) => c.queue);

/** The "Tearing down" section: from its heading to the next top-level heading. */
const teardown = (() => {
  const start = runbook.search(/^## Tearing down/m);
  if (start < 0) return "";
  const rest = runbook.slice(start + 1);
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
})();

const deleteWorker = teardown.search(new RegExp(`wrangler delete ${worker}(?! --dry-run)`));

describe("RUNBOOK teardown section", () => {
  it("exists, and found resources in wrangler.jsonc to check against", () => {
    expect(teardown).not.toBe("");
    expect(worker).toBeTruthy();
    expect(databases.length).toBeGreaterThan(0);
  });

  it("warns that deleting the Worker alone is not a reset", () => {
    expect(teardown).toMatch(/deleting the worker alone is not a reset/i);
  });

  it("deletes the Worker, then every D1 database", () => {
    expect(deleteWorker).toBeGreaterThan(-1);
    for (const db of databases) {
      const deleteDb = teardown.indexOf(`wrangler d1 delete ${db}`);
      expect(deleteDb, `d1 delete ${db}`).toBeGreaterThan(deleteWorker);
    }
  });

  it("detaches every queue consumer before deleting the Worker, if any are added", () => {
    // Cloudflare refuses to delete a Worker that is still a queue consumer
    // (code 10064). This Worker has none today (ADR-0002); the section must
    // say so, and must grow these steps if that changes.
    if (consumed.length === 0) {
      expect(teardown).toMatch(/no queues/i);
      return;
    }
    for (const queue of consumed) {
      const remove = teardown.indexOf(`wrangler queues consumer remove ${queue} ${worker}`);
      expect(remove, `consumer remove for ${queue}`).toBeGreaterThan(-1);
      expect(remove, `consumer remove for ${queue} comes first`).toBeLessThan(deleteWorker);
    }
  });

  it("removes the Deployment's Connecteam webhooks before deleting the Worker", () => {
    const webhooks = teardown.search(/settings\/v1\/webhooks/);
    expect(webhooks).toBeGreaterThan(-1);
    expect(webhooks).toBeLessThan(deleteWorker);
    for (const feature of ["time_activity", "form_submission", "task_completed"]) expect(teardown).toContain(feature);
  });
});
