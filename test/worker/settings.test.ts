/** Reading the Reminder Task setting (#27). Pure, but `Env` needs the Worker types. */
import { describe, it, expect } from "vitest";
import { readSettings, type Env } from "../../src/env.js";

const env = {
  CT_API_KEY: "key",
  CT_WEBHOOK_SECRET: "secret",
  COMPLIANCE_FORM_ID: "9001",
  CT_PUBLISHER_ID: "4242",
  WHERE_TO_FIND: "the Forms tab",
  GRACE_PERIOD_MINUTES: "30",
  ESCALATION_DELAY_MINUTES: "240",
  TIME_ZONE: "Australia/Sydney",
} as Env;

describe("the Reminder Task setting", () => {
  it("is on with its board when REMINDER_TASK_ENABLED is true", () => {
    const r = readSettings({ ...env, REMINDER_TASK_ENABLED: "true", TASK_BOARD_ID: " board-7 " });
    expect(r.ok && r.settings.reminderTask).toEqual({ boardId: "board-7" });
  });

  it.each([["false"], [""]])("is off when REMINDER_TASK_ENABLED is %j", (value) => {
    const r = readSettings({ ...env, REMINDER_TASK_ENABLED: value, TASK_BOARD_ID: "board-7" });
    expect(r.ok && r.settings.reminderTask).toBeNull();
  });

  it("is off when REMINDER_TASK_ENABLED is missing", () => {
    const r = readSettings(env);
    expect(r.ok && r.settings.reminderTask).toBeNull();
  });

  it("needs a board when on", () => {
    expect(readSettings({ ...env, REMINDER_TASK_ENABLED: "true" })).toEqual({ ok: false, problems: ["TASK_BOARD_ID"] });
  });

  it("refuses anything but true or false", () => {
    expect(readSettings({ ...env, REMINDER_TASK_ENABLED: "yes" })).toEqual({ ok: false, problems: ["REMINDER_TASK_ENABLED"] });
  });
});
