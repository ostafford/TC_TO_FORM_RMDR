/**
 * The wizard's form steps (#38): the pick list, the warnings on a form that
 * can't work per Shift, and the date questions offered. Shapes as the demo
 * account returned them (tested live 2026-10-24).
 */
import { describe, it, expect } from "vitest";
import { dateQuestions, formLabels, formTags, formWarnings, plainText, zoneOfSettings, type ApiForm } from "../scripts/lib/wizard-forms.js";

const off = { enabled: false, limitEntriesPerUser: 10 };
const form = (over: Partial<ApiForm> & { settings?: ApiForm["settings"] } = {}): ApiForm => ({
  formId: 1,
  formName: "Daily Compliance Form",
  questions: [],
  ...over,
  settings: {
    isAnonymous: false,
    limitEntriesPerUser: off,
    limitTotalEntries: { enabled: false, limitTotalEntries: 200 },
    limitEntriesUntilTimestamp: { enabled: false, limitEntriesUntilTimestamp: 0 },
    ...over.settings,
  },
});

describe("formWarnings and formTags", () => {
  it("say nothing about a form that works per shift (limits present but off)", () => {
    expect(formWarnings(form())).toEqual([]);
    expect(formTags(form())).toEqual([]);
  });

  it("flag an anonymous form", () => {
    const f = form({ settings: { isAnonymous: true } });
    expect(formTags(f)).toEqual(["anonymous"]);
    expect(formWarnings(f)[0]).toMatch(/^It's anonymous, so we can't tell who submitted it\./);
  });

  it("flag a once-per-user form, and any other cap on entries per person", () => {
    const once = form({ settings: { limitEntriesPerUser: { enabled: true, limitEntriesPerUser: 1 } } });
    expect(formTags(once)).toEqual(["one entry per person"]);
    expect(formWarnings(once)[0]).toContain("submit only once, so it can't work as a per-shift form");
    const few = form({ settings: { limitEntriesPerUser: { enabled: true, limitEntriesPerUser: 5 } } });
    expect(formTags(few)).toEqual(["5 entries per person"]);
    expect(formWarnings(few)[0]).toContain("submit only 5 times in all");
  });

  it("flag a total cap and a closing date too, since either stops per-shift submissions", () => {
    const f = form({
      settings: {
        limitTotalEntries: { enabled: true, limitTotalEntries: 200 },
        limitEntriesUntilTimestamp: { enabled: true, limitEntriesUntilTimestamp: 1_800_000_000 },
      },
    });
    expect(formTags(f)).toEqual(["200 entries in all", "closing date"]);
    expect(formWarnings(f)).toHaveLength(2);
  });

  it("cope with a form missing its settings", () => {
    expect(formWarnings({ formId: 1, formName: "Bare" })).toEqual([]);
  });
});

describe("formLabels", () => {
  it("add the id only where names repeat, and the tags", () => {
    const labels = formLabels([
      form({ formId: 10, formName: "Signed Form" }),
      form({ formId: 11, formName: "Signed Form" }),
      form({ formId: 12, formName: "Incident\tReport", settings: { isAnonymous: true } }),
    ]);
    expect(labels).toEqual(["Signed Form (id 10)", "Signed Form (id 11)", "Incident Report  ⚠ anonymous"]);
  });
});

describe("dateQuestions", () => {
  it("offer top-level date questions only: not time-only, not inside a group, not other types", () => {
    const f = form({
      questions: [
        { questionId: "a", title: "Notes", questionType: "openEnded" },
        { questionId: "b", title: "Start Date 🗓", questionType: "datetime", isDateActive: true },
        { questionId: "c", title: "Finish time", questionType: "datetime", isDateActive: false },
        { questionId: "d", title: "<p>Which <b>shift</b>?</p>", questionType: "datetime", isDateActive: true },
        { questionId: "e", title: "Group", questionType: "group" },
        { questionId: "f", title: "", questionType: "datetime", isDateActive: true },
      ],
    });
    expect(dateQuestions(f)).toEqual([
      { questionId: "b", title: "Start Date 🗓" },
      { questionId: "d", title: "Which shift?" },
      { questionId: "f", title: "(untitled date question)" },
    ]);
  });
});

describe("plainText and zoneOfSettings", () => {
  it("plainText makes one tab-free line", () => {
    expect(plainText(" a\tb\n<p>c<i>d</i></p>e ")).toBe("a b cd e");
  });

  it("zoneOfSettings reads data.general.timezone", () => {
    expect(zoneOfSettings({ data: { general: { weekStartDay: 2, timezone: "Australia/Melbourne" } } })).toBe("Australia/Melbourne");
    expect(zoneOfSettings({ data: { general: {} } })).toBeNull();
    expect(zoneOfSettings(null)).toBeNull();
  });
});
