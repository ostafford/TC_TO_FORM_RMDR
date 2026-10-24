/**
 * #24: a forgotten clock-out doesn't delay the Reminder forever. A Shift
 * still open (clocked in, or on a break) after its Scheduled Shift's planned
 * end is treated as ending then, and the employee gets the Reminder that
 * fits. One with no Scheduled Shift waits for the real clock-out. The
 * Scheduled Shift is found only through `schedulerShiftId`, and its planned
 * end is read when it comes, so an Admin's edit counts.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { FORM_ID, harness, manualBreak, resetDb, timeActivity } from "./harness.js";
import type { FakeUser } from "./fake-connecteam.js";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const GRACE = 30 * MINUTE;

/** Unix seconds for a Sydney wall-clock time on Tue 6 Oct 2026 (AEDT, UTC+11). */
const syd = (hour: number, minute = 0) => Date.UTC(2026, 9, 6, hour - 11, minute) / 1000;
const START = syd(9);
const PLANNED_END = syd(17);

const SCHEDULER = 16396569;
const SHIFT_ID = "6a4765acf53a91b0ea084fb4:74692f68-51e8-4e4e-a8c8-cd4ac8918446";
const JORDAN: FakeUser = { userId: 501, firstName: "Jordan", lastName: "Lee" };

let h: ReturnType<typeof harness>;

beforeEach(async () => {
  await resetDb();
  h = harness();
  h.ct.addForm(FORM_ID, "Daily Safety Checklist").addUser({ ...JORDAN }).addScheduler(SCHEDULER);
  h.ct.addScheduledShift({ schedulerId: SCHEDULER, id: SHIFT_ID, start: START, end: PLANNED_END, userId: JORDAN.userId });
});

/** `null`: a segment with no Scheduled Shift. */
const clockIn = (schedulerShiftId: string | null = SHIFT_ID) =>
  h.webhook(
    timeActivity({ eventType: "clock_in", userId: JORDAN.userId, id: "ta-1", start: START, ...(schedulerShiftId ? { schedulerShiftId } : {}) }),
  );
const clockOut = (end: number, schedulerShiftId: string | null = SHIFT_ID) =>
  h.webhook(
    timeActivity({
      eventType: "clock_out",
      userId: JORDAN.userId,
      id: "ta-1",
      start: START,
      end,
      ...(schedulerShiftId ? { schedulerShiftId } : {}),
    }),
  );
const lookups = () => h.ct.calls.filter((c) => c.path.startsWith("/scheduler/"));
const reminders = () => h.ct.dms.filter((d) => d.userId === JORDAN.userId).map((d) => d.text);

describe("a Shift still clocked in past its planned end", () => {
  it("is treated as ending then: the 'still clocked in' Reminder comes a Grace Period later", async () => {
    await clockIn();
    await h.tick(START + MINUTE); // reads the planned end
    await h.tick(PLANNED_END + GRACE - MINUTE);
    expect(reminders()).toEqual([]);
    await h.tick(PLANNED_END); // still open: ended then
    await h.tick(PLANNED_END + GRACE);
    expect(reminders()).toEqual([
      "Hi Jordan 👋\n\n" +
        "You're still clocked in, and we haven't received your form for this shift yet.\n\n" +
        "Shift: Tue 6 Oct, 9:00 am, scheduled to end 5:00 pm\n" +
        "Form: Daily Safety Checklist\n" +
        "Where: the Forms tab in the Connecteam app\n\n" +
        "1. Clock out if you've finished.\n" +
        "2. Submit the form.\n\n" +
        "Your manager is notified if it's still missing in 4 hours.",
    ]);
  });

  it("reads the planned end again when it comes, so an Admin's edit counts", async () => {
    await clockIn();
    await h.tick(START + MINUTE);
    h.ct.scheduledShifts.get(`1:${SCHEDULER}:${SHIFT_ID}`)!.endTime = syd(18);
    await h.tick(PLANNED_END); // reads 6:00 pm: not yet
    await h.tick(PLANNED_END + GRACE);
    expect(reminders()).toEqual([]);
    await h.tick(syd(18));
    await h.tick(syd(18) + GRACE);
    expect(reminders()).toEqual([expect.stringContaining("Shift: Tue 6 Oct, 9:00 am, scheduled to end 6:00 pm\n")]);
  });

  it("checks the schedule only when something is due: at the clock-in, then at the planned end", async () => {
    await clockIn();
    for (let t = START + MINUTE; t < PLANNED_END; t += 30 * MINUTE) await h.tick(t);
    const read = lookups().length;
    expect(read).toBe(2); // the schedulers, then the Scheduled Shift
    await h.tick(PLANNED_END);
    expect(lookups().length).toBe(read + 2);
  });

  it("that clocks out during the Grace Period gets the usual Reminder, timed from the real clock-out", async () => {
    await clockIn();
    await h.tick(START + MINUTE);
    await h.tick(PLANNED_END);
    await clockOut(syd(17, 10));
    await h.tick(PLANNED_END + GRACE);
    expect(reminders()).toEqual([]);
    await h.tick(syd(17, 40));
    expect(reminders()).toEqual([expect.stringMatching(/We haven't received your form[\s\S]*Shift: Tue 6 Oct, 9:00 am – 5:10 pm\n/)]);
  });

  it("that clocks out after the Reminder starts no second check", async () => {
    await clockIn();
    await h.tick(START + MINUTE);
    await h.tick(PLANNED_END);
    await h.tick(PLANNED_END + GRACE);
    const checks = () => h.ct.callsTo("GET", `/forms/v1/forms/${FORM_ID}/form-submissions`).length;
    const before = checks();
    await clockOut(syd(19));
    await h.tick(syd(19) + GRACE);
    await h.tick(syd(19) + GRACE + MINUTE);
    expect(checks()).toBe(before);
    expect(reminders()).toHaveLength(1);
  });

  it("stays treated as ended through an edit that leaves it open", async () => {
    await clockIn();
    await h.tick(START + MINUTE);
    await h.tick(PLANNED_END);
    await h.webhook(
      timeActivity({ eventType: "admin_edit", userId: JORDAN.userId, id: "ta-1", start: START, schedulerShiftId: SHIFT_ID }),
    );
    await h.tick(PLANNED_END + GRACE);
    expect(reminders()).toEqual([expect.stringContaining("You're still clocked in")]);
  });

  it("that submits within the Grace Period after its planned end gets nothing", async () => {
    await clockIn();
    await h.tick(START + MINUTE);
    await h.tick(PLANNED_END);
    h.ct.submit({ formSubmissionId: "sub-1", formId: FORM_ID, submittingUserId: JORDAN.userId, submissionTimestamp: syd(17, 15) });
    await h.tick(PLANNED_END + GRACE);
    expect(reminders()).toEqual([]);
  });
});

describe("a Shift on a break past its planned end", () => {
  it("gets the 'break never ended' Reminder", async () => {
    await clockIn();
    await h.tick(START + MINUTE);
    // Starting a break closes the segment at the break's start (#23).
    await clockOut(syd(16));
    await h.webhook(manualBreak({ eventType: "clock_in", userId: JORDAN.userId, id: "br-1", start: syd(16) }));
    await h.tick(syd(16) + MINUTE);
    await h.tick(PLANNED_END);
    await h.tick(PLANNED_END + GRACE);
    expect(reminders()).toEqual([
      expect.stringMatching(
        /^Hi Jordan 👋\n\nYour break is still running, and we haven't received your form for this shift yet\.\n\n[\s\S]*1\. End your break and clock out if you've finished\.\n2\. Submit the form\./,
      ),
    ]);
  });

  it("that clocks back in after its planned end is still treated as ended then, now clocked in", async () => {
    await clockIn();
    await h.tick(START + MINUTE);
    await clockOut(syd(16));
    await h.webhook(manualBreak({ eventType: "clock_in", userId: JORDAN.userId, id: "br-1", start: syd(16) }));
    await h.tick(PLANNED_END);
    await h.webhook(manualBreak({ eventType: "clock_out", userId: JORDAN.userId, id: "br-1", start: syd(16), end: syd(17, 5) }));
    await h.webhook(timeActivity({ eventType: "clock_in", userId: JORDAN.userId, id: "ta-2", start: syd(17, 5) }));
    // Ending the break closed the Shift for a moment, so it's checked against its planned end once more first.
    await h.tick(syd(17, 6));
    await h.tick(PLANNED_END + GRACE);
    expect(reminders()).toEqual([expect.stringContaining("You're still clocked in")]);
  });
});

describe("a Shift with no Scheduled Shift", () => {
  it("open with no schedulerShiftId waits for the real clock-out, and makes no lookup", async () => {
    await clockIn(null);
    for (const t of [START + MINUTE, PLANNED_END, PLANNED_END + GRACE, syd(22)]) await h.tick(t);
    expect(reminders()).toEqual([]);
    expect(lookups()).toEqual([]);
    await clockOut(syd(22), null);
    await h.tick(syd(22) + GRACE);
    expect(reminders()).toEqual([expect.stringContaining("We haven't received your form for this shift yet.")]);
  });

  it("whose Scheduled Shift isn't found (deleted) waits for the real clock-out, and isn't looked up again", async () => {
    h.ct.scheduledShifts.clear();
    await clockIn();
    await h.tick(START + MINUTE);
    const read = lookups().length;
    for (const t of [PLANNED_END, PLANNED_END + GRACE, syd(22)]) await h.tick(t);
    expect(reminders()).toEqual([]);
    expect(lookups().length).toBe(read);
    // A colon id is V1's: not looked for in V2.
    expect(lookups().map((c) => c.path)).toEqual(["/scheduler/v1/schedulers", `/scheduler/v1/schedulers/${SCHEDULER}/shifts/${encodeURIComponent(SHIFT_ID)}`]);
  });
});

describe("finding the Scheduled Shift", () => {
  it("tries each non-archived scheduler, and V2 too for an id with no colon", async () => {
    h.ct.addScheduler(111, true).addScheduler(222);
    h.ct.addScheduledShift({ schedulerId: 222, id: "6a4765acf53a91b0ea084fb4", start: START, end: PLANNED_END, userId: JORDAN.userId, version: 2 });
    await clockIn("6a4765acf53a91b0ea084fb4");
    await h.tick(START + MINUTE);
    expect(lookups().map((c) => c.path)).toEqual([
      "/scheduler/v1/schedulers",
      `/scheduler/v1/schedulers/${SCHEDULER}/shifts/6a4765acf53a91b0ea084fb4`,
      `/scheduler/v2/schedulers/${SCHEDULER}/shifts/6a4765acf53a91b0ea084fb4`,
      "/scheduler/v1/schedulers/222/shifts/6a4765acf53a91b0ea084fb4",
      "/scheduler/v2/schedulers/222/shifts/6a4765acf53a91b0ea084fb4",
    ]);
    await h.tick(PLANNED_END);
    await h.tick(PLANNED_END + GRACE);
    expect(reminders()).toEqual([expect.stringContaining("You're still clocked in")]);
  });

  it("uses V1 only for an id with a colon", async () => {
    await clockIn();
    await h.tick(START + MINUTE);
    expect(lookups().map((c) => c.path)).toEqual(["/scheduler/v1/schedulers", `/scheduler/v1/schedulers/${SCHEDULER}/shifts/${encodeURIComponent(SHIFT_ID)}`]);
  });

  it("tries again after a wait when the lookup fails", async () => {
    await clockIn();
    h.ct.failNext("GET", "/scheduler/v1/schedulers", 503);
    await h.tick(START + MINUTE);
    await h.tick(START + 2 * MINUTE);
    expect(lookups().length).toBe(3);
    await h.tick(PLANNED_END);
    await h.tick(PLANNED_END + GRACE);
    expect(reminders()).toHaveLength(1);
  });

  it("takes the Scheduled Shift's id from a later delivery of the same segment", async () => {
    await clockIn(null);
    await h.tick(START + MINUTE);
    await h.webhook(timeActivity({ eventType: "admin_edit", userId: JORDAN.userId, id: "ta-1", start: START, schedulerShiftId: SHIFT_ID }));
    await h.tick(START + 2 * MINUTE);
    await h.tick(PLANNED_END);
    await h.tick(PLANNED_END + GRACE);
    expect(reminders()).toEqual([expect.stringContaining("You're still clocked in")]);
  });

  it("lists the schedulers once for every open Shift checked in a run", async () => {
    const AVERY: FakeUser = { userId: 502, firstName: "Avery", lastName: "Ng" };
    h.ct.addUser({ ...AVERY }).addScheduledShift({ schedulerId: SCHEDULER, id: "other:1", start: START, end: PLANNED_END, userId: AVERY.userId });
    await clockIn();
    await h.webhook(timeActivity({ eventType: "clock_in", userId: AVERY.userId, id: "ta-9", start: START, schedulerShiftId: "other:1" }));
    await h.tick(START + MINUTE);
    expect(lookups().filter((c) => c.path === "/scheduler/v1/schedulers")).toHaveLength(1);
    expect(lookups()).toHaveLength(3);
  });

  it("takes the Scheduled Shift's id from a later segment when the first had none", async () => {
    await clockIn(null);
    await h.tick(START + MINUTE);
    await clockOut(syd(12), null);
    await h.webhook(manualBreak({ eventType: "clock_in", userId: JORDAN.userId, id: "br-1", start: syd(12) }));
    await h.webhook(manualBreak({ eventType: "clock_out", userId: JORDAN.userId, id: "br-1", start: syd(12), end: syd(12, 30) }));
    await h.webhook(timeActivity({ eventType: "clock_in", userId: JORDAN.userId, id: "ta-2", start: syd(12, 30), schedulerShiftId: SHIFT_ID }));
    await h.tick(syd(12, 31));
    await h.tick(PLANNED_END);
    await h.tick(PLANNED_END + GRACE);
    expect(reminders()).toEqual([expect.stringContaining("You're still clocked in")]);
  });
});
