/** Rerunning one setup step (#41): what a change affects, said before it's applied. */
import { describe, it, expect } from "vitest";
import { changedKeys, impactLines, parseCounts, type Counts } from "../scripts/lib/wizard-rerun.js";

const counts = (over: Partial<Counts> = {}): Counts => ({ needsForm: 0, scheduled: 0, notEscalated: 0, held: 0, tasksOpen: 0, alertsOpen: 0, ...over });
const d1 = (row: Record<string, unknown>) => JSON.stringify([{ results: [row], success: true, meta: {} }]);

describe("parseCounts", () => {
  it("reads the one row `wrangler d1 execute --json` prints, after anything before it", () => {
    const out = `some banner\n${d1({ needs_form: 12, scheduled: 3, not_escalated: 9, held: 1, tasks_open: 4, alerts_open: 0 })}`;
    expect(parseCounts(out)).toEqual({ needsForm: 12, scheduled: 3, notEscalated: 9, held: 1, tasksOpen: 4, alertsOpen: 0 });
  });

  it("is null for nothing, an error, or a row missing a count", () => {
    expect(parseCounts("")).toBeNull();
    expect(parseCounts("✘ [ERROR] no such table: shifts")).toBeNull();
    expect(parseCounts(d1({ needs_form: 1 }))).toBeNull();
  });
});

describe("changedKeys", () => {
  it("lists what differs, ignoring order and surrounding spaces, and keys added or removed", () => {
    expect(changedKeys({ A: "1", B: "2", C: "x" }, { B: " 2 ", A: "9", D: "new" })).toEqual(["A", "D", "C"]);
    expect(changedKeys({ A: "1" }, { A: "1" })).toEqual([]);
  });
});

describe("impactLines", () => {
  const lines = (keys: string[], after: Record<string, string>, c: Counts | null = counts(), before: Record<string, string> = {}) =>
    impactLines(keys, before, after, c);

  it("a form switch: Shifts in progress accept either form (#19 user story 52's wording)", () => {
    expect(lines(["COMPLIANCE_FORM_ID"], { COMPLIANCE_FORM_ID: "503" }, counts({ needsForm: 12 }))).toEqual([
      "12 Shifts are in progress. They'll accept either form; Shifts from now on need the new one.",
    ]);
    expect(lines(["COMPLIANCE_FORM_ID"], {}, counts({ needsForm: 1 }))[0]).toMatch(/^1 Shift is in progress\./);
    expect(lines(["COMPLIANCE_FORM_ID"], {}, counts())[0]).toBe("No Shifts are in progress, so every Shift from now on needs the new form.");
  });

  it("timings: what's already scheduled keeps its times", () => {
    expect(lines(["GRACE_PERIOD_MINUTES"], {}, counts({ scheduled: 3 }))).toEqual([
      "3 Shifts are waiting for a reminder or escalation already scheduled. Those keep their times. Everything scheduled from now on uses the new timings.",
    ]);
  });

  it("quiet hours: held escalations go out when the new ones end, or at once when turned off", () => {
    expect(lines(["QUIET_HOURS_FROM"], { QUIET_HOURS_ENABLED: "true" }, counts({ held: 2 }))[0]).toBe(
      "2 escalations are held for quiet hours. They go out when the new quiet hours end, or at the next check if it isn't quiet then.",
    );
    expect(lines(["QUIET_HOURS_ENABLED"], { QUIET_HOURS_ENABLED: "false" }, counts({ held: 1 }))[0]).toBe("1 escalation is held for quiet hours. It goes out at the next check.");
    expect(lines(["QUIET_HOURS_ENABLED"], { QUIET_HOURS_ENABLED: "false" })[0]).toBe("Escalations from now on go out at any hour.");
  });

  it("recipients are read at send time, so Shifts not escalated yet go to the new list", () => {
    expect(lines(["EXCLUDED_ADMIN_IDS"], {}, counts({ notEscalated: 5 }))[0]).toBe(
      "5 Shifts are not escalated yet. If they are, their escalations go to the new list of admins, plus the employee's direct manager.",
    );
  });

  it("a new board: open tasks still close on the form, but a tick on the old board isn't noticed", () => {
    expect(
      lines(["TASK_BOARD_ID"], { REMINDER_TASK_ENABLED: "true", TASK_BOARD_ID: "703" }, counts({ tasksOpen: 2 }), { REMINDER_TASK_ENABLED: "true", TASK_BOARD_ID: "701" }),
    ).toEqual([
      "New reminder tasks go on the new board.",
      "2 reminder tasks are open. They still tick themselves off when the form arrives, but a tick by hand on the old board is no longer noticed.",
    ]);
    expect(lines(["REMINDER_TASK_ENABLED"], { REMINDER_TASK_ENABLED: "false" })).toEqual(["No new reminder tasks from now on."]);
  });

  it("sender, alerts channel and support link", () => {
    expect(lines(["CT_PUBLISHER_ID", "CT_PUBLISHER_NAME"], { CT_PUBLISHER_NAME: "Bot" }, counts({ needsForm: 4 }))).toEqual([
      'Messages from now on come from "Bot", including those for the 4 Shifts in progress.',
    ]);
    expect(lines(["ALERTS_CHANNEL_ID"], {}, counts({ alertsOpen: 1 }))).toEqual(["1 problem is being reported now. Updates on it go to the new chat."]);
    expect(lines(["INTEGRATOR_RELAY_URL"], { INTEGRATOR_RELAY_URL: "https://r.example" })[0]).toMatch(/^Problems are also sent to your integrator/);
    expect(lines(["INTEGRATOR_RELAY_URL"], { INTEGRATOR_RELAY_URL: "" }, counts(), { INTEGRATOR_RELAY_URL: "https://r.example" })[0]).toMatch(/^Problems are no longer sent/);
  });

  it("without counts, says what changes without numbers", () => {
    expect(lines(["COMPLIANCE_FORM_ID", "WHERE_TO_FIND"], { WHERE_TO_FIND: "the red folder" }, null)).toEqual([
      "Shifts in progress will accept either form; Shifts from now on need the new one.",
      'Messages from now on say: "Where: the red folder"',
    ]);
  });
});
