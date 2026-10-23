import { describe, it, expect } from "vitest";
import type { ConnecteamUser } from "../src/connecteam/types.js";
import { directManagerId, escalationRecipients } from "../src/escalation/recipients.js";
import { escalation, type EscalationInput } from "../src/messages/escalation.js";
import { MAX_MESSAGE } from "../src/messages/format.js";

// Mon 20 Oct 2026, 9:00 am to 5:02 pm in Sydney (AEDT, UTC+11).
const SYD_9AM = Date.UTC(2026, 9, 19, 22, 0) / 1000;
const SYD_502PM = Date.UTC(2026, 9, 20, 6, 2) / 1000;

const sample: EscalationInput = {
  fullName: "Jordan Lee",
  userId: 501,
  shift: { startSeconds: SYD_9AM, endSeconds: SYD_502PM, timeZone: "Australia/Sydney" },
  deploymentZone: "Australia/Sydney",
  formName: "Daily Safety Checklist",
  remindedMinutesAgo: 240,
  ticked: false,
};

describe("Escalation wording", () => {
  it("reads as the variant D wording: labelled lines, no form content", () => {
    expect(escalation(sample)).toBe(
      "MISSING COMPLIANCE FORM\n\n" +
        "Employee: Jordan Lee\n" +
        "Shift: Tue 20 Oct, 9:00 am – 5:02 pm\n" +
        "Form: Daily Safety Checklist\n" +
        "Reminded: 4 hours ago",
    );
  });

  it("adds the note when the employee ticked the Reminder Task without submitting", () => {
    expect(escalation({ ...sample, ticked: true })).toMatch(
      /\nReminded: 4 hours ago\nNote: ticked the reminder task without submitting$/,
    );
  });

  it("names the user by id when Connecteam has no name", () => {
    expect(escalation({ ...sample, fullName: "" })).toContain("Employee: User 501\n");
  });

  it("says how long ago the Reminder went out, to the minute", () => {
    expect(escalation({ ...sample, remindedMinutesAgo: 241 })).toMatch(/Reminded: 4 hours 1 minute ago$/);
  });

  it("says the Reminder wasn't confirmed when it was given up on (#33)", () => {
    expect(escalation({ ...sample, remindedMinutesAgo: null })).toMatch(/\nReminded: not confirmed \(sending failed\)$/);
  });

  it(`stays at or under ${MAX_MESSAGE} characters with long sample names, keeping the Reminded line`, () => {
    const text = escalation({
      ...sample,
      fullName: "W".repeat(400),
      formName: "W".repeat(400),
      shift: { ...sample.shift, timeZone: "Australia/Perth" },
    });
    expect(text.length).toBeLessThanOrEqual(MAX_MESSAGE);
    expect(text).toMatch(/Reminded: 4 hours ago$/);
    const ticked = escalation({ ...sample, ticked: true, fullName: "W".repeat(400), formName: "W".repeat(400) });
    expect(ticked.length).toBeLessThanOrEqual(MAX_MESSAGE);
    expect(ticked).toMatch(/Note: ticked the reminder task without submitting$/);
  });
});

const user = (userId: number, over: Partial<ConnecteamUser> = {}): ConnecteamUser => ({
  userId,
  userType: "user",
  customFields: [],
  ...over,
});
const managedBy = (value: unknown, name = "Direct manager"): Partial<ConnecteamUser> => ({
  customFields: [{ customFieldId: 25145114, name, type: "directManager", value }],
});

const OWNER = user(1, { userType: "owner" });
const ADMIN = user(2, { userType: "manager" });
const ADMIN_2 = user(3, { userType: "manager" });
const STAFF = user(4);
const users = [OWNER, ADMIN, ADMIN_2, STAFF];

describe("Escalation recipients", () => {
  it("are every Admin (userType manager or owner), not plain users or archived Admins", () => {
    const archived = user(5, { userType: "manager", isArchived: true });
    expect(escalationRecipients({ users: [...users, archived], employee: user(501), excludedAdminIds: [] })).toEqual([1, 2, 3]);
  });

  it("leave out Excluded Admins", () => {
    expect(escalationRecipients({ users, employee: user(501), excludedAdminIds: [2, 3] })).toEqual([1]);
  });

  it("add the direct manager, even a plain user", () => {
    expect(escalationRecipients({ users, employee: user(501, managedBy(4)), excludedAdminIds: [] })).toEqual([1, 2, 3, 4]);
  });

  it("include an Excluded Admin who is the employee's direct manager", () => {
    expect(escalationRecipients({ users, employee: user(501, managedBy(2)), excludedAdminIds: [2, 3] })).toEqual([1, 2]);
  });

  it("include an Admin who is also the direct manager once, not twice", () => {
    expect(escalationRecipients({ users, employee: user(501, managedBy(2)), excludedAdminIds: [] })).toEqual([1, 2, 3]);
  });

  it("never include the employee themselves", () => {
    expect(escalationRecipients({ users, employee: ADMIN, excludedAdminIds: [] })).toEqual([1, 3]);
  });
});

describe("the direct manager", () => {
  it("is the value of the custom field whose type is directManager, whatever it's called", () => {
    expect(directManagerId(user(501, managedBy(77, "Line manager")))).toBe(77);
  });

  it("is never read from a field of another type, even one named Direct manager", () => {
    const wrongType = user(501, { customFields: [{ customFieldId: 9, name: "Direct manager", type: "number", value: 77 }] });
    expect(directManagerId(wrongType)).toBeNull();
  });

  it.each([[77], ["77"], [[77]], [{ value: 77 }]])("reads the user id from %j", (value) => {
    expect(directManagerId(user(501, managedBy(value)))).toBe(77);
  });

  it.each([[null], [""], [[]], [{ value: null }], [0], ["not an id"]])("is none for a blank value: %j", (value) => {
    expect(directManagerId(user(501, managedBy(value)))).toBeNull();
  });

  it("is none when the account has no such field: Admins only", () => {
    expect(directManagerId(user(501))).toBeNull();
    expect(escalationRecipients({ users, employee: user(501), excludedAdminIds: [] })).toEqual([1, 2, 3]);
  });
});
