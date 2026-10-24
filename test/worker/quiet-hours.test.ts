/**
 * #29: Admins aren't woken at night. An Escalation due during Quiet Hours
 * waits, and when they end each recipient gets one Escalation Summary of
 * everything held for them, split only past 500 characters. Only Escalations
 * wait; daytime ones go one at a time; with Quiet Hours off, any hour will
 * do; and the settings are read at send time.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { FORM_ID, formSubmission, harness, resetDb, timeActivity } from "./harness.js";
import type { FakeUser } from "./fake-connecteam.js";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const GRACE = 30 * MINUTE;
const DELAY = 4 * HOUR;

/** Unix seconds for a Sydney wall-clock time in October 2026 (AEDT, UTC+11). */
const syd = (day: number, hour: number, minute = 0) => Date.UTC(2026, 9, day, hour - 11, minute) / 1000;

// Tue 6 Oct, 9:00 am to 5:02 pm: reminded 5:32 pm, escalation due 9:32 pm, inside Quiet Hours.
const START = syd(6, 9);
const END = syd(6, 17, 2);
const REMINDED = END + GRACE;
const ESCALATE = REMINDED + DELAY;
/** Quiet Hours end: 7:00 am Wed 7 Oct. */
const MORNING = syd(7, 7);

const QUIET = { QUIET_HOURS_ENABLED: "true", QUIET_HOURS_FROM: "21:00", QUIET_HOURS_UNTIL: "07:00" };

const JORDAN: FakeUser = { userId: 501, firstName: "Jordan", lastName: "Lee", directManager: 30 };
const AVERY: FakeUser = { userId: 502, firstName: "Avery", lastName: "Ng" };
const OWNER: FakeUser = { userId: 10, firstName: "Olive", lastName: "Owner", userType: "owner" };
const ADMIN: FakeUser = { userId: 20, firstName: "Ari", lastName: "Admin", userType: "manager" };
const MANAGER: FakeUser = { userId: 30, firstName: "Max", lastName: "Manager" };

let h: ReturnType<typeof harness>;

function setUp(settings: Partial<Record<string, string>> = QUIET, staff: FakeUser[] = [JORDAN, AVERY]) {
  h = harness(settings);
  h.ct.addForm(FORM_ID, "Daily Safety Checklist");
  for (const u of [...staff, OWNER, ADMIN, MANAGER]) h.ct.addUser({ ...u });
}

beforeEach(async () => {
  await resetDb();
  setUp();
});

/** The user clocks out `afterEnd` seconds after END and is reminded at the end of their Grace Period. */
async function reminded(user: FakeUser, afterEnd = 0) {
  await h.webhook(
    timeActivity({ eventType: "clock_out", userId: user.userId, id: `ta-${user.userId}`, start: START + afterEnd, end: END + afterEnd }),
  );
  await h.tick(REMINDED + afterEnd);
}

const staffIds = new Set([JORDAN.userId, AVERY.userId]);
const escalations = () => h.ct.dms.filter((d) => !staffIds.has(d.userId) && d.userId < 500);
const to = (userId: number) => escalations().filter((d) => d.userId === userId).map((d) => d.text);

describe("Quiet Hours", () => {
  it("hold an Escalation due at night, with no calls made, until they end", async () => {
    await reminded(JORDAN);
    const before = h.ct.calls.length;
    await h.tick(ESCALATE);
    for (let t = ESCALATE + HOUR; t < MORNING; t += HOUR) await h.tick(t);
    expect(escalations()).toEqual([]);
    expect(h.ct.calls.length).toBe(before);
  });

  it("end with one Escalation Summary per recipient, checked once more first", async () => {
    await reminded(JORDAN);
    await h.tick(ESCALATE);
    const checks = () => h.ct.callsTo("GET", `/forms/v1/forms/${FORM_ID}/form-submissions`).length;
    const before = checks();
    await h.tick(MORNING);
    expect(checks()).toBe(before + 1);
    expect(escalations().map((d) => d.userId).sort()).toEqual([OWNER.userId, ADMIN.userId, MANAGER.userId]);
    expect(to(ADMIN.userId)).toEqual([
      "MISSING COMPLIANCE FORMS (1)\n\n" +
        "Form: Daily Safety Checklist\n" +
        "Held overnight (quiet hours):\n\n" +
        "- Jordan Lee · Tue 6 Oct, 9:00 am – 5:02 pm\n\n" +
        "Each was reminded at least 13 hours 28 minutes ago.",
    ]);
    await h.tick(MORNING + MINUTE);
    expect(escalations()).toHaveLength(3);
  });

  it("combine everything held for a recipient; a direct manager gets only their own people", async () => {
    await reminded(JORDAN);
    await reminded(AVERY, 30 * MINUTE);
    await h.tick(ESCALATE);
    await h.tick(ESCALATE + 30 * MINUTE);
    const userLists = () => h.ct.callsTo("GET", "/users/v1/users").filter((c) => !c.query.userIds).length;
    const before = userLists();
    await h.tick(MORNING);
    expect(userLists()).toBe(before + 1); // read once for every held Shift
    expect(to(ADMIN.userId)).toHaveLength(1);
    expect(to(ADMIN.userId)[0]).toMatch(/^MISSING COMPLIANCE FORMS \(2\)\n/);
    expect(to(ADMIN.userId)[0]).toContain("- Jordan Lee · Tue 6 Oct, 9:00 am – 5:02 pm\n- Avery Ng · Tue 6 Oct, 9:30 am – 5:32 pm\n");
    expect(to(ADMIN.userId)[0]).toContain("Each was reminded at least 12 hours 58 minutes ago.");
    expect(to(MANAGER.userId)).toEqual([expect.stringMatching(/^MISSING COMPLIANCE FORMS \(1\)\n[\s\S]*Jordan Lee/)]);
    expect(to(MANAGER.userId)[0]).not.toContain("Avery");
  });

  it("drop a Shift whose submission was credited while it was held", async () => {
    await reminded(JORDAN);
    await reminded(AVERY, 30 * MINUTE);
    await h.tick(ESCALATE);
    await h.tick(ESCALATE + 30 * MINUTE);
    const late = { formSubmissionId: "sub-1", formId: FORM_ID, submittingUserId: JORDAN.userId, submissionTimestamp: syd(7, 0, 15) };
    h.ct.submit(late);
    await h.webhook(formSubmission(late));
    await h.tick(MORNING);
    expect(to(ADMIN.userId)).toEqual([expect.stringMatching(/^MISSING COMPLIANCE FORMS \(1\)\n[\s\S]*Avery Ng/)]);
    expect(to(MANAGER.userId)).toEqual([]);
  });

  it("drop a Shift whose submission the morning check finds, though no webhook said so", async () => {
    await reminded(JORDAN);
    await h.tick(ESCALATE);
    h.ct.submit({ formSubmissionId: "sub-1", formId: FORM_ID, submittingUserId: JORDAN.userId, submissionTimestamp: syd(7, 0, 15) });
    await h.tick(MORNING);
    expect(escalations()).toEqual([]);
  });

  it("split a Summary only past 500 characters, each message counting its own", async () => {
    const many: FakeUser[] = Array.from({ length: 10 }, (_, i) => ({ userId: 600 + i, firstName: "Employee", lastName: `Number ${i}` }));
    setUp(QUIET, many);
    for (const [i, u] of many.entries()) await reminded(u, i * MINUTE);
    for (let i = 0; i < many.length; i++) await h.tick(ESCALATE + i * MINUTE);
    await h.tick(MORNING);
    const texts = to(ADMIN.userId);
    expect(texts.length).toBe(2);
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(500);
    const counts = texts.map((t) => Number(/\((\d+)\)/.exec(t)![1]));
    expect(counts.reduce((a, b) => a + b)).toBe(10);
    expect(texts.join("\n").match(/^- Employee Number/gm)).toHaveLength(10);
  });

  it("never hold a Reminder: one due at night goes out then", async () => {
    await h.webhook(timeActivity({ eventType: "clock_out", userId: JORDAN.userId, id: "ta-late", start: syd(6, 15), end: syd(6, 23) }));
    await h.tick(syd(6, 23) + GRACE);
    expect(h.ct.dms.map((d) => d.userId)).toEqual([JORDAN.userId]);
  });

  it("send a daytime Escalation when it's due, on its own", async () => {
    setUp({ ...QUIET, ESCALATION_DELAY_MINUTES: "120" });
    await reminded(JORDAN);
    await h.tick(REMINDED + 2 * HOUR);
    expect(to(ADMIN.userId)).toEqual([expect.stringMatching(/^MISSING COMPLIANCE FORM\n/)]);
  });

  it("turned off, let Escalations go at any hour", async () => {
    setUp({ QUIET_HOURS_ENABLED: "false" });
    await reminded(JORDAN);
    await h.tick(ESCALATE);
    expect(to(ADMIN.userId)).toEqual([expect.stringMatching(/^MISSING COMPLIANCE FORM\n/)]);
  });

  it("are read at send time: turned off while an Escalation is held, the Summary goes at the next run", async () => {
    await reminded(JORDAN);
    await h.tick(ESCALATE);
    h.configure({ QUIET_HOURS_ENABLED: "false" });
    await h.tick(ESCALATE + MINUTE);
    expect(to(ADMIN.userId)).toEqual([expect.stringMatching(/^MISSING COMPLIANCE FORMS \(1\)\n/)]);
  });

  it("across midnight or not, follow the Deployment's own zone through daylight saving", async () => {
    // Sun 4 Oct 2026: Sydney's clocks go forward at 2:00 am. Quiet 1:00 am to 6:00 am.
    setUp({ QUIET_HOURS_ENABLED: "true", QUIET_HOURS_FROM: "01:00", QUIET_HOURS_UNTIL: "06:00" });
    const start = Date.UTC(2026, 9, 3, 9, 0) / 1000; // Sat 3 Oct, 7:00 pm AEST (UTC+10)
    const end = start + 2 * HOUR; // 9:00 pm
    await h.webhook(timeActivity({ eventType: "clock_out", userId: JORDAN.userId, id: "ta-dst", start, end }));
    await h.tick(end + GRACE); // reminded 9:30 pm; escalation due 1:30 am, quiet
    await h.tick(end + GRACE + DELAY);
    const sixAm = Date.UTC(2026, 9, 3, 19, 0) / 1000; // 6:00 am AEDT (UTC+11)
    await h.tick(sixAm - MINUTE);
    expect(escalations()).toEqual([]);
    await h.tick(sixAm);
    expect(to(ADMIN.userId)).toHaveLength(1);
  });

  it("a Summary that fails to one recipient is retried to them alone, after a wait", async () => {
    await reminded(JORDAN);
    await h.tick(ESCALATE);
    h.ct.failNext("POST", `/chat/v1/conversations/privateMessage/${ADMIN.userId}`, 503);
    await h.tick(MORNING);
    expect(to(OWNER.userId)).toHaveLength(1);
    expect(to(ADMIN.userId)).toEqual([]);
    await h.tick(MORNING + MINUTE);
    expect(to(ADMIN.userId)).toHaveLength(1);
    expect(to(OWNER.userId)).toHaveLength(1);
    expect(to(MANAGER.userId)).toHaveLength(1);
    await h.tick(MORNING + 5 * MINUTE);
    expect(escalations()).toHaveLength(3);
  });
});
