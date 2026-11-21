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

  it.each([
    ["no API key", {}],
    ["the wrong API key", { "X-API-KEY": "another-key" }],
  ])("answers 401 to a call with %s", async (_, headers) => {
    expect((await ct.fetch(URL, { headers })).status).toBe(401);
  });
});
