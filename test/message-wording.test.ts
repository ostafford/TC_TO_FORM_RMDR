import { describe, it, expect } from "vitest";
import { reminderShiftEnded, type ReminderInput } from "../src/messages/reminder.js";
import { formatDuration, formatShift, MAX_MESSAGE } from "../src/messages/format.js";
import { reminderTaskDescription, reminderTaskTitle, type ReminderTaskInput } from "../src/messages/reminderTask.js";

// Mon 20 Oct 2026, 9:00 am to 5:02 pm in Sydney (AEDT, UTC+11).
const SYD_9AM = Date.UTC(2026, 9, 19, 22, 0) / 1000;
const SYD_502PM = Date.UTC(2026, 9, 20, 6, 2) / 1000;

const sample: ReminderInput = {
  firstName: "Jordan",
  shift: { startSeconds: SYD_9AM, endSeconds: SYD_502PM, timeZone: "Australia/Sydney" },
  deploymentZone: "Australia/Sydney",
  formName: "Daily Safety Checklist",
  whereToFind: "the Forms tab in the Connecteam app",
  escalationDelayMinutes: 240,
};

const long = (n: number) => "W".repeat(n);

describe("Reminder (Shift ended)", () => {
  it("reads as the variant D wording", () => {
    expect(reminderShiftEnded(sample)).toBe(
      "Hi Jordan 👋\n\n" +
        "We haven't received your form for this shift yet.\n\n" +
        "Shift: Tue 20 Oct, 9:00 am – 5:02 pm\n" +
        "Form: Daily Safety Checklist\n" +
        "Where: the Forms tab in the Connecteam app\n\n" +
        "Please submit it now. Your manager is notified if it's still missing in 4 hours.",
    );
  });

  it("greets 'there' when the user has no first name", () => {
    expect(reminderShiftEnded({ ...sample, firstName: "" })).toMatch(/^Hi there 👋/);
  });

  it(`stays at or under ${MAX_MESSAGE} characters with long sample names`, () => {
    const text = reminderShiftEnded({
      ...sample,
      firstName: long(200),
      formName: long(400),
      whereToFind: long(400),
      shift: { ...sample.shift, timeZone: "Australia/Perth" },
    });
    expect(text.length).toBeLessThanOrEqual(MAX_MESSAGE);
    // Long names are cut, not the closing sentence that states the escalation delay.
    expect(text).toMatch(/still missing in 4 hours\.$/);
  });
});

describe("Reminder Task", () => {
  const task: ReminderTaskInput = {
    shift: sample.shift,
    deploymentZone: sample.deploymentZone,
    formName: sample.formName,
    whereToFind: sample.whereToFind,
  };

  it("reads as the variant D wording", () => {
    expect(reminderTaskTitle(task)).toBe("Daily Safety Checklist – Tue 20 Oct");
    expect(reminderTaskDescription(task)).toBe(
      "Shift: Tue 20 Oct, 9:00 am – 5:02 pm\n" +
        "Where: the Forms tab in the Connecteam app\n\n" +
        "Closes automatically when the form is received. Ticking it does not count as submitting.",
    );
  });

  it("names the Shift's day in the zone it was recorded in, with the short name only when it differs", () => {
    const perth = { ...task, shift: { ...task.shift, timeZone: "Australia/Perth" } };
    expect(reminderTaskTitle(perth)).toBe("Daily Safety Checklist – Tue 20 Oct");
    expect(reminderTaskDescription(perth)).toMatch(/^Shift: Tue 20 Oct, 6:00 am – 2:02 pm \(AWST\)\n/);
  });

  it("cuts long names, keeping the Shift's day and the closing sentence", () => {
    const longer = { ...task, formName: long(400), whereToFind: long(400) };
    expect(reminderTaskTitle(longer)).toMatch(/^W{99}… – Tue 20 Oct$/);
    expect(reminderTaskDescription(longer).length).toBeLessThanOrEqual(MAX_MESSAGE);
    expect(reminderTaskDescription(longer)).toMatch(/Ticking it does not count as submitting\.$/);
  });
});

describe("Shift times", () => {
  it("shows the zone's short name only when it differs from the Deployment's zone", () => {
    const perth = { ...sample.shift, timeZone: "Australia/Perth" };
    expect(formatShift(perth, "Australia/Sydney")).toBe("Tue 20 Oct, 6:00 am – 2:02 pm (AWST)");
    expect(formatShift(perth, "Australia/Perth")).toBe("Tue 20 Oct, 6:00 am – 2:02 pm");
  });

  it("keeps the start's day for a Shift that crosses midnight", () => {
    const night = { startSeconds: SYD_502PM, endSeconds: SYD_9AM + 86_400, timeZone: "Australia/Sydney" };
    expect(formatShift(night, "Australia/Sydney")).toBe("Tue 20 Oct, 5:02 pm – 9:00 am");
  });
});

describe("durations", () => {
  it.each([
    [30, "30 minutes"],
    [1, "1 minute"],
    [60, "1 hour"],
    [240, "4 hours"],
    [90, "1 hour 30 minutes"],
  ])("%i minutes reads as %s", (minutes, text) => {
    expect(formatDuration(minutes)).toBe(text);
  });
});
