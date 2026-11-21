/**
 * #91: the fake answers only a call with the account's `X-API-KEY`, as
 * Connecteam does, so every other test also proves the Worker sends it.
 */
import { describe, it, expect } from "vitest";
import { FakeConnecteam } from "./fake-connecteam.js";

const URL = "https://api.connecteam.com/users/v1/users?limit=500&offset=0";

describe("the fake Connecteam", () => {
  const ct = new FakeConnecteam({ apiKey: "the-key" });

  it("answers a call with the account's API key", async () => {
    expect((await ct.fetch(URL, { headers: { "X-API-KEY": "the-key" } })).status).toBe(200);
  });

  // As tested live (fake-vs-reality research): a bad key is 403, a missing one 401.
  it("answers 403 to a call with the wrong API key", async () => {
    const res = await ct.fetch(URL, { headers: { "X-API-KEY": "another-key" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ detail: "Invalid API key" });
  });

  it("answers 401 to a call with no API key", async () => {
    const res = await ct.fetch(URL, { headers: {} });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "No authentication provided" });
  });
});
