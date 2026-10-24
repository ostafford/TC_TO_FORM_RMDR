/**
 * #36: a Deployment with the Integrator Relay set up sends it every Failure
 * Alert and all clear, and checks in once a day, so the integrator hears
 * about a problem even when Connecteam can't deliver it. Without the relay
 * settings, nothing is sent and nothing fails. A relay send that fails
 * doesn't block or repeat the Alerts Channel post.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { FORM_ID, harness, resetDb, timeActivity } from "./harness.js";
import type { FakeUser } from "./fake-connecteam.js";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const GRACE = 30 * MINUTE;

// Tue 6 Oct 2026, 9:00 am to 5:02 pm in Sydney (AEDT, UTC+11).
const START = Date.UTC(2026, 9, 5, 22, 0) / 1000;
const END = Date.UTC(2026, 9, 6, 6, 2) / 1000;
const DUE = END + GRACE;
const TRIES = [0, 1, 3, 7, 15, 31, 63];

const JORDAN: FakeUser = { userId: 501, firstName: "Jordan", lastName: "Lee" };
const DMS = "/chat/v1/conversations/privateMessage/";
const RELAY = {
  INTEGRATOR_RELAY_URL: "https://relay.example.workers.dev/",
  INTEGRATOR_CLIENT_SLUG: "acme",
  INTEGRATOR_RELAY_SECRET: "shhh",
};

let h: ReturnType<typeof harness>;

function setUp(settings: Partial<Record<string, string>> = RELAY) {
  h = harness(settings);
  h.ct.addForm(FORM_ID, "Daily Safety Checklist").addUser({ ...JORDAN });
}

beforeEach(async () => {
  await resetDb();
  setUp();
});

const clockOut = () =>
  h.webhook(timeActivity({ eventType: "clock_out", userId: JORDAN.userId, id: "ta-1", start: START, end: END }));

/** Jordan's Reminder fails for an hour: the "Messages not sending" alert is due the next run. */
async function failReminder() {
  await clockOut();
  h.ct.failAll("POST", DMS, 503);
  for (const m of TRIES) await h.tick(DUE + m * MINUTE);
}

describe("Failure Alerts to the relay", () => {
  it("go out with the alert's text but no staff names (the relay's issues are public), the client slug and the shared secret", async () => {
    await failReminder();
    await h.tick(DUE + 64 * MINUTE);
    expect(h.ct.posts).toHaveLength(1);
    expect(h.ct.posts[0]!.text).toContain("Undelivered: 1 reminder (Jordan Lee)");
    const alerts = h.relay.pushes.filter((p) => p.body.kind === "alert");
    expect(alerts).toEqual([
      {
        url: "https://relay.example.workers.dev/",
        secret: "shhh",
        body: {
          kind: "alert",
          client: "acme",
          condition: "messages",
          state: "raised",
          text:
            "ALERT · MESSAGES NOT SENDING\n\n" +
            "Since: 1 hour 4 minutes ago\n" +
            "Cause: Connecteam not responding\n" +
            "Undelivered: 1 reminder\n\n" +
            "Action: none yet. An all-clear follows when it recovers.",
          at: new Date((DUE + 64 * MINUTE) * 1000).toISOString(),
        },
      },
    ]);
  });

  it("go out once per condition, and the all clear once", async () => {
    await failReminder();
    for (let m = 64; m < 70; m++) await h.tick(DUE + m * MINUTE);
    h.ct.recover();
    await h.webhook(timeActivity({ eventType: "clock_out", userId: JORDAN.userId, id: "ta-2", start: START + DAY, end: END + DAY }));
    for (let m = 0; m < 3; m++) await h.tick(DUE + DAY + m * MINUTE);
    expect(h.relay.alerts()).toEqual([
      ["messages", "raised"],
      ["messages", "cleared"],
    ]);
    const cleared = h.relay.pushes.find((p) => p.body.state === "cleared")!;
    expect(h.ct.posts[1]!.text).toContain("- Reminder: Jordan Lee, Tue 6 Oct");
    expect(cleared.body.text).toBe(
      "ALL CLEAR\n\nMessages are sending again.\nNot delivered: 1 reminder, named in the Alerts Channel\n\n" +
        "Action: follow these up by hand if needed.",
    );
    expect(JSON.stringify(h.relay.pushes)).not.toContain("Jordan");
  });

  it("reach the relay when Connecteam can't deliver them, once, not every run the channel post is retried", async () => {
    await clockOut();
    h.ct.rejectKey();
    for (let m = 0; m <= 5; m++) await h.tick(DUE + m * MINUTE);
    expect(h.ct.posts).toEqual([]);
    expect(h.relay.alerts()).toEqual([["key", "raised"]]);
    expect(h.relay.pushes.find((p) => p.body.kind === "alert")!.body.text).toMatch(/^ALERT · PAUSED\n/);

    // Recovered within the hour: nothing was skipped, so the channel hears nothing, but the relay's issue closes.
    h.ct.recover();
    await h.tick(DUE + 20 * MINUTE);
    await h.tick(DUE + 21 * MINUTE);
    expect(h.ct.posts).toEqual([]);
    expect(h.relay.alerts()).toEqual([
      ["key", "raised"],
      ["key", "cleared"],
    ]);
  });

  it("a relay that fails doesn't block or repeat the channel post, and gets it on a later run", async () => {
    await failReminder();
    h.relay.status = 500;
    await h.tick(DUE + 64 * MINUTE);
    h.relay.status = null;
    await h.tick(DUE + 65 * MINUTE);
    expect(h.ct.posts).toHaveLength(1);

    h.relay.status = 202;
    await h.tick(DUE + 66 * MINUTE);
    await h.tick(DUE + 67 * MINUTE);
    expect(h.ct.posts).toHaveLength(1);
    expect(h.relay.pushes.filter((p) => p.body.kind === "alert").map((p) => p.body.state)).toEqual(["raised", "raised", "raised"]);
    expect(h.relay.alerts()).toHaveLength(3); // two failed, then one taken; none after
  });

  it("a held-back alert the channel never gets isn't relayed either", async () => {
    // The sweep fails for an hour, recovers, then fails again within 24 hours: held back.
    h.ct.addTimeClock(67);
    h.ct.failAll("GET", "/time-clock/", 503);
    await h.tick(DUE);
    await h.tick(DUE + HOUR);
    h.ct.recover();
    await h.tick(DUE + HOUR + MINUTE);
    await h.tick(DUE + HOUR + 2 * MINUTE);
    h.ct.failAll("GET", "/time-clock/", 503);
    await h.tick(DUE + 3 * HOUR);
    await h.tick(DUE + 4 * HOUR + MINUTE);
    expect(h.relay.alerts()).toEqual([
      ["sweep", "raised"],
      ["sweep", "cleared"],
    ]);
  });
});

describe("the daily check-in", () => {
  it("goes out on the first run and then once a day, even while paused", async () => {
    await h.tick(DUE);
    await h.tick(DUE + MINUTE);
    expect(h.relay.checkIns()).toBe(1);
    expect(h.relay.pushes[0]!.body).toEqual({ kind: "check_in", client: "acme", at: new Date(DUE * 1000).toISOString() });

    h.ct.rejectKey();
    await h.tick(DUE + DAY - MINUTE);
    expect(h.relay.checkIns()).toBe(1);
    await h.tick(DUE + DAY);
    expect(h.relay.checkIns()).toBe(2);
  });

  it("is tried again next run when the relay doesn't take it", async () => {
    h.relay.status = 503;
    await h.tick(DUE);
    h.relay.status = 202;
    await h.tick(DUE + MINUTE);
    await h.tick(DUE + 2 * MINUTE);
    expect(h.relay.checkIns()).toBe(2);
    await h.tick(DUE + MINUTE + DAY - MINUTE);
    expect(h.relay.checkIns()).toBe(2);
  });

  it("goes out once however many runs overlap", async () => {
    await Promise.all([h.tick(DUE), h.tick(DUE), h.tick(DUE)]);
    expect(h.relay.checkIns()).toBe(1);
  });
});

describe("without the relay set up", () => {
  it.each([
    ["none of it", {}],
    ["no secret", { ...RELAY, INTEGRATOR_RELAY_SECRET: "" }],
    ["no client slug", { ...RELAY, INTEGRATOR_CLIENT_SLUG: "" }],
  ])("%s: nothing is sent, and alerts and Reminders go on as before", async (_, settings) => {
    setUp(settings);
    await failReminder();
    await h.tick(DUE + 64 * MINUTE);
    expect(h.ct.posts).toHaveLength(1);
    expect(h.relay.pushes).toEqual([]);
  });
});
