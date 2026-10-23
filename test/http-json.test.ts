/** The per-call timeout (#33): a call that hangs is a retryable failure with no status, not a stalled run. */
import { describe, it, expect } from "vitest";
import { httpJson } from "../src/http/json.js";

const never = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;

describe("httpJson's timeout", () => {
  it("gives up on a call that never answers", async () => {
    const r = await httpJson({ method: "GET", url: "https://api.example/x" }, never, 20);
    expect(r).toEqual({ kind: "retryable", status: null, detail: "timed out after 0.02 s" });
  });

  it("aborts the request, for a fetch that honours the signal", async () => {
    let signal: AbortSignal | undefined;
    const listening = ((_: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
    await httpJson({ method: "POST", url: "https://api.example/x", body: {} }, listening, 20);
    expect(signal?.aborted).toBe(true);
  });

  it("gives up on a body that never finishes", async () => {
    const stalledBody = (async () =>
      new Response(new ReadableStream({ start() {} }), { status: 200 })) as unknown as typeof fetch;
    const r = await httpJson({ method: "GET", url: "https://api.example/x" }, stalledBody, 20);
    expect(r.kind).toBe("retryable");
  });

  it("answers as before within the time", async () => {
    const ok = (async () => new Response('{"a":1}', { status: 200 })) as unknown as typeof fetch;
    const r = await httpJson({ method: "GET", url: "https://api.example/x" }, ok, 1000);
    expect(r).toMatchObject({ kind: "success", status: 200, body: { a: 1 } });
  });
});
