/** The wizard's timing and wording steps (#38): reading what's typed, and the worked examples. */
import { describe, it, expect } from "vitest";
import {
  MAX_WHERE,
  clock12,
  delayTimeline,
  graceExample,
  normaliseWhere,
  parseClockInput,
  parseDuration,
  quietExample,
} from "../scripts/lib/wizard-values.js";

describe("parseDuration", () => {
  it("reads a bare number in the step's unit", () => {
    expect(parseDuration("30", "minutes")).toBe(30);
    expect(parseDuration("4", "hours")).toBe(240);
    expect(parseDuration("1.5", "hours")).toBe(90);
  });

  it("reads minutes and hours written out, alone or together", () => {
    expect(parseDuration("90m", "hours")).toBe(90);
    expect(parseDuration("45 minutes", "hours")).toBe(45);
    expect(parseDuration("2h", "minutes")).toBe(120);
    expect(parseDuration("1 hour", "minutes")).toBe(60);
    expect(parseDuration("1h 30m", "minutes")).toBe(90);
    expect(parseDuration(" 4 Hours ", "minutes")).toBe(240);
  });

  it("refuses nothing, zero, part-minutes and words", () => {
    for (const t of ["", "0", "0.5", "soon", "4 days", "-5", "1h soon"]) expect(parseDuration(t, "minutes")).toBeNull();
  });
});

describe("parseClockInput", () => {
  it("reads 12- and 24-hour times as HH:MM", () => {
    expect(parseClockInput("9 pm")).toBe("21:00");
    expect(parseClockInput("9pm")).toBe("21:00");
    expect(parseClockInput("7:30 a.m.")).toBe("07:30");
    expect(parseClockInput("12 am")).toBe("00:00");
    expect(parseClockInput("12 pm")).toBe("12:00");
    expect(parseClockInput("21:00")).toBe("21:00");
    expect(parseClockInput("7:05")).toBe("07:05");
  });

  it("refuses a bare hour, which could be morning or evening, and impossible times", () => {
    for (const t of ["7", "", "13 pm", "0 am", "24:00", "9:60", "noon"]) expect(parseClockInput(t)).toBeNull();
  });
});

describe("clock12", () => {
  it("writes minutes after midnight as the messages do, wrapping past midnight", () => {
    expect(clock12(0)).toBe("12:00 am");
    expect(clock12(17 * 60 + 30)).toBe("5:30 pm");
    expect(clock12(12 * 60)).toBe("12:00 pm");
    expect(clock12(26 * 60 + 30)).toBe("2:30 am");
  });
});

describe("normaliseWhere", () => {
  it("finishes \"You'll find it in …\": a leading \"in\" and a full stop are dropped", () => {
    expect(normaliseWhere("  In the Forms tab.  ")).toEqual({ ok: true, value: "the Forms tab" });
    expect(normaliseWhere("the  Site   folder")).toEqual({ ok: true, value: "the Site folder" });
    expect(normaliseWhere("inbox")).toEqual({ ok: true, value: "inbox" });
  });

  it("refuses an empty phrase, and one longer than a message shows", () => {
    expect(normaliseWhere(" in ").ok).toBe(false);
    expect(normaliseWhere("x".repeat(MAX_WHERE)).ok).toBe(true);
    expect(normaliseWhere("x".repeat(MAX_WHERE + 1)).ok).toBe(false);
  });
});

describe("the worked examples", () => {
  it("the Grace Period: a 5:00 pm clock-out and when the reminder goes", () => {
    expect(graceExample(30).join("\n")).toContain("if the form isn't in by 5:30 pm, Jordan gets a reminder");
    expect(graceExample(420).join("\n")).toContain("by 12:00 am (next day)");
  });

  it("the escalation delay: a timeline built from the chosen Grace Period", () => {
    expect(delayTimeline(30, 240)).toEqual([
      " 5:00 pm   Jordan clocks out",
      " 5:30 pm   no form yet → reminder to Jordan",
      " 9:30 pm   still no form, 4 hours later → your admins and Jordan's manager are told",
      "If Jordan submits any time before 9:30 pm, nobody else hears about it.",
    ]);
    expect(delayTimeline(45, 480)[2]).toBe(" 1:45 am   (next day) still no form, 8 hours later → your admins and Jordan's manager are told");
  });

  it("Quiet Hours: the 10 pm example, held or not by the chosen window", () => {
    const night = { from: "21:00", until: "07:00" };
    expect(quietExample(30, 240, night)).toEqual([
      "A shift ends at 10:00 pm.",
      "10:30 pm   reminder to the employee (sent: reminders are never held)",
      " 2:30 am   (next day) escalation due → held until 7:00 am, then sent in the morning summary",
    ]);
    expect(quietExample(30, 600, night)[2]).toBe(" 8:30 am   (next day) escalation sent straight away (outside quiet hours)");
    expect(quietExample(30, 240, { from: "01:00", until: "05:00" })[2]).toContain("held until 5:00 am");
    expect(quietExample(30, 240, null)[2]).toBe(" 2:30 am   (next day) escalation sent straight away (quiet hours off)");
  });
});
