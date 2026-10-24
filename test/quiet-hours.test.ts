/** Quiet Hours clock maths (#29): a window across midnight or not, in the Deployment's zone, through daylight saving. */
import { describe, it, expect } from "vitest";
import { isQuiet, parseClock, quietEnds } from "../src/escalation/quietHours.js";
import { escalationSummaries, type SummaryEntry } from "../src/messages/escalation.js";

const at = (iso: string) => Date.parse(iso) / 1000;
const SYD = "Australia/Sydney";
const NIGHT = { from: 21 * 60, until: 7 * 60 };

describe("parseClock", () => {
  it.each([
    ["21:00", 1260],
    ["07:00", 420],
    ["00:00", 0],
    ["23:59", 1439],
  ])("%s is %i minutes", (text, minutes) => expect(parseClock(text)).toBe(minutes));

  it.each(["9pm", "24:00", "7:00", "21:60", ""])("refuses %j", (text) => expect(parseClock(text)).toBeNull());
});

describe("isQuiet", () => {
  it("runs across midnight when from is after until", () => {
    expect(isQuiet(at("2026-10-06T09:59:00Z"), SYD, NIGHT)).toBe(false); // 8:59 pm AEDT
    expect(isQuiet(at("2026-10-06T10:00:00Z"), SYD, NIGHT)).toBe(true); // 9:00 pm
    expect(isQuiet(at("2026-10-06T15:00:00Z"), SYD, NIGHT)).toBe(true); // 2:00 am
    expect(isQuiet(at("2026-10-06T19:59:00Z"), SYD, NIGHT)).toBe(true); // 6:59 am
    expect(isQuiet(at("2026-10-06T20:00:00Z"), SYD, NIGHT)).toBe(false); // 7:00 am
  });

  it("stays within one day when from is before until", () => {
    const early = { from: 60, until: 360 };
    expect(isQuiet(at("2026-10-06T13:59:00Z"), SYD, early)).toBe(false); // 12:59 am
    expect(isQuiet(at("2026-10-06T14:00:00Z"), SYD, early)).toBe(true); // 1:00 am
    expect(isQuiet(at("2026-10-06T19:00:00Z"), SYD, early)).toBe(false); // 6:00 am
  });

  it("is never quiet with equal ends", () => {
    expect(isQuiet(at("2026-10-06T15:00:00Z"), SYD, { from: 420, until: 420 })).toBe(false);
  });

  it("reads the Deployment's zone, not UTC", () => {
    // 11:00 pm in Perth (AWST, UTC+8) is 2:00 am in Sydney.
    expect(isQuiet(at("2026-10-06T15:00:00Z"), "Australia/Perth", NIGHT)).toBe(true);
    expect(isQuiet(at("2026-10-06T08:00:00Z"), "Australia/Perth", NIGHT)).toBe(false); // 4:00 pm Perth
  });
});

describe("quietEnds", () => {
  it("is the next morning's until, local time", () => {
    expect(quietEnds(at("2026-10-06T10:32:00Z"), SYD, NIGHT)).toBe(at("2026-10-06T20:00:00Z")); // 9:32 pm -> 7:00 am
    expect(quietEnds(at("2026-10-06T15:00:00Z"), SYD, NIGHT)).toBe(at("2026-10-06T20:00:00Z")); // 2:00 am -> 7:00 am
  });

  it("follows daylight saving: 7:00 am on the morning the clocks change", () => {
    // Sun 4 Oct 2026, Sydney goes from AEST (UTC+10) to AEDT (UTC+11) at 2:00 am.
    expect(quietEnds(at("2026-10-03T12:00:00Z"), SYD, NIGHT)).toBe(at("2026-10-03T20:00:00Z"));
    // Sun 5 Apr 2026, back from AEDT to AEST at 3:00 am.
    expect(quietEnds(at("2026-04-04T12:00:00Z"), SYD, NIGHT)).toBe(at("2026-04-04T21:00:00Z"));

    // Ending at 1:00 am, still AEST (UTC+10), an hour before the clocks go forward.
    expect(quietEnds(at("2026-10-03T13:00:00Z"), SYD, { from: 22 * 60, until: 60 })).toBe(at("2026-10-03T15:00:00Z"));
  });
});

describe("escalationSummaries", () => {
  const entry = (i: number, over: Partial<SummaryEntry> = {}): SummaryEntry => ({
    fullName: `Employee ${i}`,
    userId: 600 + i,
    shift: { startSeconds: at("2026-10-05T22:00:00Z") + i * 60, endSeconds: at("2026-10-06T06:00:00Z"), timeZone: SYD },
    remindedMinutesAgo: 600 + i,
    ticked: false,
    ...over,
  });

  it("notes a Reminder not confirmed and a tick, and the youngest Reminder's age", () => {
    const [m] = escalationSummaries({
      formName: "Daily Safety Checklist",
      deploymentZone: SYD,
      entries: [entry(1, { remindedMinutesAgo: null }), entry(0, { ticked: true })],
    });
    expect(m!.text).toBe(
      "MISSING COMPLIANCE FORMS (2)\n\n" +
        "Form: Daily Safety Checklist\n" +
        "Held overnight (quiet hours):\n\n" +
        "- Employee 0 · Tue 6 Oct, 9:00 am – 5:00 pm · ticked the task\n" +
        "- Employee 1 · Tue 6 Oct, 9:01 am – 5:00 pm · reminder not confirmed\n\n" +
        "Each was reminded at least 10 hours ago.",
    );
  });

  it("splits only past 500 characters, keeping every entry once, in order", () => {
    const entries = Array.from({ length: 20 }, (_, i) => entry(i));
    const messages = escalationSummaries({ formName: "Form", deploymentZone: SYD, entries });
    expect(messages.length).toBeGreaterThan(1);
    for (const m of messages) expect(m.text.length).toBeLessThanOrEqual(500);
    expect(messages.flatMap((m) => m.entries)).toEqual(entries);
    // Each but the last is full: the next entry wouldn't have fitted.
    expect(escalationSummaries({ formName: "Form", deploymentZone: SYD, entries: entries.slice(0, 3) })).toHaveLength(1);
  });
});
