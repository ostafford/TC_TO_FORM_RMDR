/** The wizard's last steps (#40): the webhook plan, the settings check before going live, and the test's sample Shift. */
import { describe, it, expect } from "vitest";
import { formatShift } from "../src/messages/format.js";
import { TIME_ACTIVITY_EVENTS, planWebhooks, sampleShift, settingProblems, STEP_OF, summaryRow, wantedWebhooks } from "../scripts/lib/wizard-turn-on.js";
import { SETTINGS } from "../scripts/lib/deploy-config.js";

const URL = "https://clock-out-form-reminder.acme.workers.dev/webhook";

describe("wantedWebhooks", () => {
  it("time clock events on every clock, submissions of this form only, ticks on this board only", () => {
    const w = wantedWebhooks(URL, "s3cret", { COMPLIANCE_FORM_ID: "501", TASK_BOARD_ID: "701" });
    expect(w.map((x) => [x.featureType, x.entityId, x.eventTypes])).toEqual([
      ["time_activity", null, [...TIME_ACTIVITY_EVENTS]],
      ["forms", "501", ["form_submission"]],
      ["tasks", "701", ["task_completed"]],
    ]);
    for (const x of w) expect(x).toMatchObject({ url: URL, secretKey: "s3cret", isDisabled: false });
  });

  it("leaves out requests (requested times) and declines, which the Worker ignores", () => {
    expect(TIME_ACTIVITY_EVENTS.some((e) => /^user_|declined|timesheet|day_/.test(e))).toBe(false);
    expect(TIME_ACTIVITY_EVENTS).toContain("auto_clock_out");
    expect(TIME_ACTIVITY_EVENTS).toContain("admin_delete");
  });

  it("no board, no task subscription", () => {
    expect(wantedWebhooks(URL, "s", { COMPLIANCE_FORM_ID: "501" }).map((x) => x.featureType)).toEqual(["time_activity", "forms"]);
  });
});

describe("planWebhooks", () => {
  const wanted = wantedWebhooks(URL, "s", { COMPLIANCE_FORM_ID: "501", TASK_BOARD_ID: "701" });

  it("creates all three on a first run, leaving other integrations' webhooks alone", () => {
    const plan = planWebhooks([{ id: 1, url: "https://other.example/hook", featureType: "users" }], wanted, URL);
    expect(plan.create.map((b) => b.featureType)).toEqual(["time_activity", "forms", "tasks"]);
    expect(plan.update).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it("updates ours instead of adding (a second POST delivers twice), and removes repeats and kinds no longer wanted", () => {
    const plan = planWebhooks(
      [
        { id: 10, url: URL, featureType: "time_activity" },
        { id: 11, url: URL, featureType: "forms" },
        { id: 12, url: URL, featureType: "forms" },
        { id: 13, url: URL, featureType: "users" },
        { id: 14, url: "https://other.example/hook", featureType: "forms" },
      ],
      wanted,
      URL,
    );
    expect(plan.update.map((u) => [u.id, u.body.featureType])).toEqual([
      ["10", "time_activity"],
      ["11", "forms"],
    ]);
    expect(plan.create.map((b) => b.featureType)).toEqual(["tasks"]);
    expect(plan.remove).toEqual(["12", "13"]);
  });
});

describe("settingProblems", () => {
  it("names each missing setting, but not the database id that turning it on makes", () => {
    const problems = settingProblems({ COMPLIANCE_FORM_ID: "501" });
    expect(problems.map((p) => p.key)).toContain("WHERE_TO_FIND");
    expect(problems.map((p) => p.key)).not.toContain("D1_DATABASE_ID");
    expect(problems.map((p) => p.key)).not.toContain("COMPLIANCE_FORM_ID");
  });

  it("every setting the deploy needs has a step to rerun", () => {
    for (const [key, spec] of Object.entries(SETTINGS)) if (spec.kind === "var") expect(STEP_OF[key], key).toBeTruthy();
  });
});

describe("summaryRow", () => {
  it("lines the values up", () => {
    const rows = ["Time zone", "Shift date question", "Sender"].map((l) => summaryRow(l, "X"));
    expect(new Set(rows.map((r) => r.indexOf(" X")))).toEqual(new Set([rows[0]!.indexOf(" X")]));
  });
});

describe("sampleShift", () => {
  it("is 9 am to 5 pm today in the Deployment's zone, daylight saving included", () => {
    // 2026-10-04 02:00 UTC is Sunday 4 Oct, the day Sydney moves to daylight saving.
    const s = sampleShift(Date.UTC(2026, 9, 4, 2) / 1000, "Australia/Sydney");
    expect(formatShift(s, "Australia/Sydney")).toBe("Sun 4 Oct, 9:00 am – 5:00 pm");
    expect(s.endSeconds - s.startSeconds).toBe(8 * 3600);
  });
});
