/**
 * The wizard's people and channel steps (#39): who's listed as an Admin,
 * whether direct managers are used, the chat labels, and the support link's
 * values. Shapes as the demo account returned them (tested live 2026-10-24).
 */
import { describe, it, expect } from "vitest";
import type { ConnecteamUser } from "../src/connecteam/types.js";
import {
  adminRows,
  checkClientSlug,
  checkRelayUrl,
  conversationLabels,
  directManagerLine,
  directManagers,
  soundsAutomated,
} from "../scripts/lib/wizard-people.js";

const dm = (value: unknown) => ({ customFieldId: 9, name: "Direct manager", type: "directManager", value });
const user = (userId: number, userType: string, over: Partial<ConnecteamUser> = {}): ConnecteamUser => ({
  userId,
  firstName: `First${userId}`,
  lastName: `Last${userId}`,
  userType,
  isArchived: false,
  customFields: [],
  ...over,
});

describe("adminRows", () => {
  it("lists owners and managers, not archived Admins or users (an invite not yet accepted is a user), sorted by name", () => {
    const rows = adminRows([
      user(1, "owner", { firstName: "Zed", lastName: "Owner" }),
      user(2, "manager", { firstName: "Amy", lastName: "Admin" }),
      user(3, "manager", { isArchived: true }),
      user(4, "user"),
      user(5, "user", { firstName: "", lastName: "" }),
    ]);
    expect(rows).toEqual([
      { userId: 2, label: "Amy Admin" },
      { userId: 1, label: "Zed Owner (owner)" },
    ]);
  });

  it("names a user with no name by id", () => {
    expect(adminRows([user(7, "manager", { firstName: "", lastName: "" })])).toEqual([{ userId: 7, label: "user 7" }]);
  });
});

describe("directManagers", () => {
  it("counts staff (not Admins) with a direct manager set, as the Worker reads it", () => {
    const d = directManagers([user(1, "owner", { customFields: [dm(2)] }), user(4, "user", { customFields: [dm(1)] }), user(5, "user", { customFields: [dm(null)] })]);
    expect(d).toEqual({ field: true, set: 1, staff: 2 });
    expect(directManagerLine(d)).toBe("Direct managers: found. 1 of 2 staff have one, who also gets their escalations.");
  });

  it("says so when the account has no such field, or no one has one set", () => {
    expect(directManagerLine(directManagers([user(4, "user")]))).toContain("not used in this account");
    expect(directManagerLine(directManagers([user(4, "user", { customFields: [dm("")] })]))).toContain("no one has one set yet");
  });
});

describe("conversationLabels", () => {
  it("say channel or team chat, adding the id where titles repeat", () => {
    expect(
      conversationLabels([
        { id: "a", title: "Managers", type: "channel" },
        { id: "b", title: "Ops", type: "team" },
        { id: "c", title: "Ops", type: "team" },
      ]),
    ).toEqual(["Managers (channel)", "Ops (team chat, id b)", "Ops (team chat, id c)"]);
  });
});

describe("soundsAutomated", () => {
  it("is a hint that the sender says it isn't a person", () => {
    for (const n of ["Compliance Reminders (Automated)", "Form Bot", "Shift Reminder", "No-reply"]) expect(soundsAutomated(n)).toBe(true);
    for (const n of ["Implementation Publisher", "Okky", "Robotics Team"]) expect(soundsAutomated(n)).toBe(false);
  });
});

describe("the support link's values", () => {
  it("the link must be https, without a trailing slash", () => {
    expect(checkRelayUrl(" https://relay.example.workers.dev/ ")).toEqual({ ok: true, value: "https://relay.example.workers.dev" });
    expect(checkRelayUrl("http://relay.example").ok).toBe(false);
    expect(checkRelayUrl("relay").ok).toBe(false);
  });

  it("the name keeps to what the relay keeps intact, lowered", () => {
    expect(checkClientSlug("Acme-Cleaning")).toEqual({ ok: true, value: "acme-cleaning" });
    expect(checkClientSlug("site_2.b").ok).toBe(true);
    for (const t of ["", "Acme Cleaning", "-acme", "x".repeat(65)]) expect(checkClientSlug(t).ok).toBe(false);
  });
});
