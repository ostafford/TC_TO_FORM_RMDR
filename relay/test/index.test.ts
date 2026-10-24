/*
 * Adapted from EH_Webhook (~/IDP/EH_Webhook/integrator-relay/test/index.test.ts
 * at 0c5ec92): this relay's secret header, plus check-ins kept in the real
 * Durable Object and the hourly scheduled check (#35).
 */
import { env, createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, afterEach, vi } from "vitest";
import worker from "../src/index.js";

type Req = Request<unknown, IncomingRequestCfProperties>;

const post = (body: unknown, headers: Record<string, string> = {}) =>
  worker.fetch(new Request("https://relay.test/", { method: "POST", body: JSON.stringify(body), headers }) as Req, env);

const SECRET = { "x-relay-secret": "shhh" };

/** A GitHub that answers the issue list, create, comment and update, recording each call. */
function fakeGitHub() {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const open: Array<{ number: number; title: string; state: string; body: string; html_url: string }> = [];
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: u, body });
    if (method === "GET" && u.includes("/issues?state=open")) return new Response(JSON.stringify(open), { status: 200 });
    if (method === "POST" && u.endsWith("/repos/ostafford/TC_TO_FORM_RMDR/issues")) {
      const issue = { number: 40 + open.length, title: body.title, state: "open", body: body.body, html_url: "u" };
      open.push(issue);
      return new Response(JSON.stringify(issue), { status: 201 });
    }
    const patch = u.match(/\/issues\/(\d+)$/);
    if (method === "PATCH" && patch) {
      if (body.state === "closed") open.splice(open.findIndex((i) => i.number === Number(patch[1])), 1);
      return new Response("{}", { status: 200 });
    }
    if (method === "POST" && u.endsWith("/comments")) return new Response("{}", { status: 201 });
    throw new Error(`unexpected ${method} ${u}`);
  }) as unknown as typeof fetch;
  return { calls, open };
}

async function scheduledAt(ms: number) {
  vi.setSystemTime(ms);
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ scheduledTime: ms, cron: "0 * * * *" }), env);
  await waitOnExecutionContext(ctx);
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("relay fetch handler", () => {
  it("GET /health is public", async () => {
    const res = await worker.fetch(new Request("https://relay.test/health") as Req, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: "clock-out-form-reminder-relay" });
  });

  it("rejects a POST with no secret header", async () => {
    expect((await post({ kind: "check_in", client: "acme", at: "t" })).status).toBe(401);
  });

  it("rejects a POST with the wrong secret, including EH_Webhook's header", async () => {
    expect((await post({ kind: "check_in", client: "acme", at: "t" }, { "x-relay-secret": "nope" })).status).toBe(401);
    expect((await post({ kind: "check_in", client: "acme", at: "t" }, { "x-eh-sync-secret": "shhh" })).status).toBe(401);
  });

  it("rejects a non-POST, non-health request", async () => {
    expect((await worker.fetch(new Request("https://relay.test/", { method: "PUT" }) as Req, env)).status).toBe(405);
  });

  it("400s on invalid JSON", async () => {
    const res = await worker.fetch(new Request("https://relay.test/", { method: "POST", body: "{not json", headers: SECRET }) as Req, env);
    expect(res.status).toBe(400);
  });

  it("with the right secret, an alert creates a GitHub issue on this repo", async () => {
    const gh = fakeGitHub();
    const res = await post({ kind: "alert", client: "acme", condition: "webhook", state: "raised", text: "ALERT", at: "t" }, SECRET);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ok: true, issue: 40, deduped: false });
    expect(gh.open.map((i) => i.title)).toEqual(["[clock-out reminder] clock-outs not arriving — acme"]);
  });

  it("502s when GitHub is unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const res = await post({ kind: "alert", client: "acme", condition: "key", state: "raised", text: "x", at: "t" }, SECRET);
    expect(res.status).toBe(502);
  });
});

describe("check-ins, end to end", () => {
  it("are kept in the Durable Object; the hourly check opens an issue after 36 hours of silence, and the next check-in closes it", async () => {
    const gh = fakeGitHub();
    const t0 = Date.parse("2026-10-24T00:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t0);
    expect((await post({ kind: "check_in", client: "acme", at: "t0" }, SECRET)).status).toBe(202);

    await scheduledAt(t0 + 36 * 3600_000);
    expect(gh.open).toEqual([]);
    await scheduledAt(t0 + 37 * 3600_000);
    expect(gh.open.map((i) => i.title)).toEqual(["[clock-out reminder] missed check-in — acme"]);
    await scheduledAt(t0 + 38 * 3600_000);
    expect(gh.calls.filter((c) => c.method === "POST" && c.url.endsWith("/issues"))).toHaveLength(1);

    expect((await post({ kind: "check_in", client: "acme", at: "t1" }, SECRET)).status).toBe(202);
    expect(gh.open).toEqual([]);
  });
});
