/**
 * #25: if the Compliance Form is still missing once the escalation delay has
 * passed after the Reminder, each Admin (except Excluded Admins) and the
 * employee's direct manager get an Escalation DM.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { FORM_ID, PUBLISHER_ID, harness, resetDb, timeActivity } from "./harness.js";
import type { FakeUser } from "./fake-connecteam.js";

// Tue 6 Oct 2026, 9:00 am to 5:02 pm in Sydney (AEDT, UTC+11).
const START = Date.UTC(2026, 9, 5, 22, 0) / 1000;
const END = Date.UTC(2026, 9, 6, 6, 2) / 1000;
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const GRACE = 30 * MINUTE;
const DELAY = 4 * HOUR;
const REMINDED = END + GRACE;
const ESCALATE = REMINDED + DELAY;

const JORDAN: FakeUser = { userId: 501, firstName: "Jordan", lastName: "Lee", directManager: 30 };
const OWNER: FakeUser = { userId: 10, firstName: "Olive", lastName: "Owner", userType: "owner" };
const ADMIN: FakeUser = { userId: 20, firstName: "Ari", lastName: "Admin", userType: "manager" };
const MANAGER: FakeUser = { userId: 30, firstName: "Max", lastName: "Manager" };
const STAFF: FakeUser = { userId: 40, firstName: "Sam", lastName: "Staff" };

const TEXT =
  "MISSING COMPLIANCE FORM\n\n" +
  "Employee: Jordan Lee\n" +
  "Shift: Tue 6 Oct, 9:00 am – 5:02 pm\n" +
  "Form: Daily Safety Checklist\n" +
  "Reminded: 4 hours ago";

let h: ReturnType<typeof harness>;

function setUp(settings: Partial<Record<string, string>> = {}) {
  h = harness(settings);
  h.ct.addForm(FORM_ID, "Daily Safety Checklist");
  for (const u of [JORDAN, OWNER, ADMIN, MANAGER, STAFF]) h.ct.addUser({ ...u });
}

beforeEach(async () => {
  await resetDb();
  setUp();
});

const clockOut = () => timeActivity({ eventType: "clock_out", userId: JORDAN.userId, id: "ta-1", start: START, end: END });

/** Clock out, and let the Reminder go out at the end of the Grace Period. */
async function reminded() {
  await h.webhook(clockOut());
  await h.tick(REMINDED);
  expect(h.ct.dms.map((d) => d.userId)).toEqual([JORDAN.userId]);
}

const escalations = () => h.ct.dms.filter((d) => d.userId !== JORDAN.userId);
const checks = () => h.ct.callsTo("GET", `/forms/v1/forms/${FORM_ID}/form-submissions`);

describe("the escalation point", () => {
  it("isn't reached before the escalation delay has passed after the Reminder", async () => {
    await reminded();
    const calls = h.ct.calls.length;
    await h.tick(ESCALATE - MINUTE);
    expect(h.ct.calls).toHaveLength(calls);
  });

  it("checks again, then escalates to every Admin and the direct manager, as the custom publisher", async () => {
    await reminded();
    await h.tick(ESCALATE);

    expect(checks().map((c) => c.query)).toEqual([
      expect.objectContaining({ submittingEndTime: String(REMINDED) }),
      expect.objectContaining({ submittingStartTimestamp: String(START), submittingEndTime: String(ESCALATE) }),
    ]);
    expect(escalations()).toEqual([
      { userId: OWNER.userId, senderId: PUBLISHER_ID, text: TEXT },
      { userId: ADMIN.userId, senderId: PUBLISHER_ID, text: TEXT },
      { userId: MANAGER.userId, senderId: PUBLISHER_ID, text: TEXT },
    ]);
  });

  it("sends nothing when a submission arrived after the Reminder", async () => {
    await reminded();
    h.ct.submit({ formSubmissionId: "s-1", formId: FORM_ID, submittingUserId: JORDAN.userId, submissionTimestamp: REMINDED + HOUR });
    await h.tick(ESCALATE);
    await h.tick(ESCALATE + HOUR);

    expect(escalations()).toEqual([]);
    expect(h.ct.callsTo("GET", "/users/v1/users")).toHaveLength(1); // the Reminder's only
  });

  it("is timed from when the Reminder actually went out", async () => {
    h.ct.failNext("POST", "/chat/v1/conversations/privateMessage/", 503);
    await h.webhook(clockOut());
    await h.tick(REMINDED);
    await h.tick(REMINDED + MINUTE);

    await h.tick(ESCALATE);
    expect(escalations()).toEqual([]);
    await h.tick(ESCALATE + MINUTE);
    expect(escalations()).toHaveLength(3);
    expect(escalations()[0]?.text).toMatch(/Reminded: 4 hours ago$/);
  });

  it("keeps the delay it was given when the Reminder went out", async () => {
    await reminded();
    setUp({ ESCALATION_DELAY_MINUTES: "60" });
    await h.tick(REMINDED + HOUR);
    expect(escalations()).toEqual([]);
    await h.tick(ESCALATE);
    expect(escalations()).toHaveLength(3);
  });

  it("goes out once: later runs send nothing and call nothing", async () => {
    await reminded();
    await h.tick(ESCALATE);
    const calls = h.ct.calls.length;
    await h.tick(ESCALATE + MINUTE);
    await h.tick(ESCALATE + 24 * HOUR);
    expect(h.ct.calls).toHaveLength(calls);
    expect(escalations()).toHaveLength(3);
  });

  it("isn't reached for a Shift deleted after the Reminder", async () => {
    await reminded();
    await h.webhook({
      requestId: "del-1",
      eventType: "admin_delete",
      userId: JORDAN.userId,
      activityType: "shift",
      timeActivityId: "ta-1",
      eventTimestamp: REMINDED + HOUR,
    });
    await h.tick(ESCALATE);
    expect(escalations()).toEqual([]);
  });
});

describe("recipients, read live at send time", () => {
  it("leave out Excluded Admins, but not one who is the employee's direct manager", async () => {
    setUp({ EXCLUDED_ADMIN_IDS: `${OWNER.userId}, ${ADMIN.userId}` });
    h.ct.users.get(JORDAN.userId)!.directManager = ADMIN.userId;
    await reminded();
    await h.tick(ESCALATE);
    expect(escalations().map((d) => d.userId)).toEqual([ADMIN.userId]);
  });

  it("send an Admin who is also the direct manager one Escalation, not two", async () => {
    h.ct.users.get(JORDAN.userId)!.directManager = ADMIN.userId;
    await reminded();
    await h.tick(ESCALATE);
    expect(escalations().map((d) => d.userId)).toEqual([OWNER.userId, ADMIN.userId]);
  });

  it("are Admins only when the employee has no direct manager", async () => {
    delete h.ct.users.get(JORDAN.userId)!.directManager;
    await reminded();
    await h.tick(ESCALATE);
    expect(escalations().map((d) => d.userId)).toEqual([OWNER.userId, ADMIN.userId]);
  });

  it("include an Admin promoted after the Reminder, with nobody adding them", async () => {
    await reminded();
    h.ct.users.get(STAFF.userId)!.userType = "manager";
    await h.tick(ESCALATE);
    expect(escalations().map((d) => d.userId)).toContain(STAFF.userId);
  });

  it("come from every page of users", async () => {
    for (let i = 0; i < 600; i++) h.ct.addUser({ userId: 1000 + i, firstName: "U", lastName: String(i) });
    h.ct.addUser({ userId: 5000, firstName: "Late", lastName: "Admin", userType: "manager" });
    await reminded();
    await h.tick(ESCALATE);
    expect(escalations().map((d) => d.userId)).toContain(5000);
    expect(h.ct.callsTo("GET", "/users/v1/users").map((c) => c.query.offset)).toEqual([
      "0", // the Reminder's lookup by id
      "0",
      "500",
    ]);
  });

  it("still name an employee archived since the Shift", async () => {
    await reminded();
    h.ct.users.get(JORDAN.userId)!.isArchived = true;
    await h.tick(ESCALATE);
    expect(escalations()[0]?.text).toContain("Employee: Jordan Lee\n");
    expect(escalations().map((d) => d.userId)).toEqual([OWNER.userId, ADMIN.userId, MANAGER.userId]);
  });
});

describe("sending each Escalation at most once", () => {
  it("retries only the recipient whose send failed, next minute", async () => {
    await reminded();
    // Owner first, then Admin: the Admin's send fails.
    h.ct.failNext("POST", `/chat/v1/conversations/privateMessage/${ADMIN.userId}`, 503);
    await h.tick(ESCALATE);
    expect(escalations().map((d) => d.userId)).toEqual([OWNER.userId, MANAGER.userId]);

    await h.tick(ESCALATE + MINUTE);
    expect(escalations().map((d) => d.userId)).toEqual([OWNER.userId, MANAGER.userId, ADMIN.userId]);
    // Sent a minute late, and it says so.
    expect(escalations()[2]?.text).toMatch(/Reminded: 4 hours 1 minute ago$/);

    // Everyone has it now: later runs send nothing and call nothing.
    const calls = h.ct.calls.length;
    await h.tick(ESCALATE + 2 * MINUTE);
    expect(h.ct.calls).toHaveLength(calls);
  });

  it("sends nothing while the users list can't be read, then sends next minute", async () => {
    await reminded();
    h.ct.failNext("GET", "/users/v1/users", 503);
    await h.tick(ESCALATE);
    expect(escalations()).toEqual([]);

    await h.tick(ESCALATE + MINUTE);
    expect(escalations()).toHaveLength(3);
  });

  it("sends nothing while the submission check fails", async () => {
    await reminded();
    h.ct.failNext("GET", `/forms/v1/forms/${FORM_ID}/form-submissions`, 503);
    await h.tick(ESCALATE);
    expect(escalations()).toEqual([]);
    await h.tick(ESCALATE + MINUTE);
    expect(escalations()).toHaveLength(3);
  });
});
