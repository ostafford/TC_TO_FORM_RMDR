/**
 * The Failure Alerts' wording (#33): variant D, labelled lines, at most 500
 * characters, and every one ends with an `Action:` line however long the list.
 */
import { describe, it, expect } from "vitest";
import { MAX_MESSAGE } from "../src/messages/format.js";
import { allClear, clockOutCheckFailing, failureCause, messagesNotSending, type MissedSend } from "../src/messages/failureAlert.js";

// Tue 20 Oct 2026, 9:00 am in Sydney.
const SHIFT = Date.UTC(2026, 9, 19, 22, 0) / 1000;

const send = (name: string, over: Partial<MissedSend> = {}): MissedSend => ({
  kind: "reminder",
  userId: 501,
  name,
  shiftStart: SHIFT,
  shiftTz: "Australia/Sydney",
  outcome: "failed",
  ...over,
});

const many = (n: number) => Array.from({ length: n }, (_, i) => send(`Employee With A Long Name ${i}`, { userId: 600 + i }));

describe("ALERT · MESSAGES NOT SENDING", () => {
  it("reads as the variant D wording, grouping who wasn't reached by kind", () => {
    expect(
      messagesNotSending({
        sinceMinutes: 63,
        cause: "Connecteam not responding",
        sends: [
          send("Jordan Lee"),
          send("Sam Patel"),
          send("Alex Kim", { kind: "escalation" }),
          send("", { userId: 777, kind: "task", outcome: "unconfirmed" }),
        ],
      }),
    ).toBe(
      "ALERT · MESSAGES NOT SENDING\n\n" +
        "Since: 1 hour 3 minutes ago\n" +
        "Cause: Connecteam not responding\n" +
        "Undelivered: 2 reminders (Jordan Lee, Sam Patel), 1 escalation (Alex Kim)\n" +
        "Unconfirmed: 1 reminder task (User 777)\n\n" +
        "Action: none yet. An all-clear follows when it recovers.",
    );
  });

  it(`stays at or under ${MAX_MESSAGE} characters with many people, keeping the Action line and the counts`, () => {
    const text = messagesNotSending({ sinceMinutes: 63, cause: "Connecteam not responding", sends: many(40) });
    expect(text.length).toBeLessThanOrEqual(MAX_MESSAGE);
    expect(text).toMatch(/\n\nAction: none yet\. An all-clear follows when it recovers\.$/);
    expect(text).toMatch(/Undelivered: 40 reminders \(.+ and \d+ more\)/);
  });
});

describe("ALL CLEAR", () => {
  it("lists what wasn't delivered, marking the unconfirmed", () => {
    expect(allClear({ recovered: "messages", sends: [send("Jordan Lee"), send("Sam Patel", { kind: "escalation", outcome: "unconfirmed" })] })).toBe(
      "ALL CLEAR\n\n" +
        "Messages are sending again.\n" +
        "Not delivered:\n" +
        "- Reminder: Jordan Lee, Tue 20 Oct\n" +
        "- Escalation: Sam Patel, Tue 20 Oct (unconfirmed)\n\n" +
        "Action: follow these up by hand if needed.",
    );
  });

  it("with nothing to list, says there's nothing to do", () => {
    expect(allClear({ recovered: "sweep", sends: [] })).toBe("ALL CLEAR\n\nThe clock-out check is working again.\n\nAction: none.");
  });

  it(`stays at or under ${MAX_MESSAGE} characters with many people, keeping the Action line`, () => {
    const text = allClear({ recovered: "messages", sends: many(40) });
    expect(text.length).toBeLessThanOrEqual(MAX_MESSAGE);
    expect(text).toMatch(/\n- and \d+ more\n\nAction: follow these up by hand if needed\.$/);
  });
});

describe("ALERT · CLOCK-OUT CHECK FAILING", () => {
  it("ends with an Action line", () => {
    expect(clockOutCheckFailing({ sinceMinutes: 60, cause: "Connecteam not responding" })).toMatch(/\n\nAction: .+$/);
  });
});

describe("the Cause line", () => {
  it.each([
    [{ outcome: "failed", status: null }, "Connecteam not responding"],
    [{ outcome: "failed", status: 503 }, "Connecteam not responding"],
    [{ outcome: "failed", status: 429 }, "Connecteam's rate limit"],
    [{ outcome: "failed", status: 400 }, "Connecteam refused it (HTTP 400)"],
    [{ outcome: "unconfirmed", status: null }, "the integration stopped mid-send"],
  ] as const)("%j reads %j", (f, cause) => {
    expect(failureCause(f)).toBe(cause);
  });
});
