import { describe, it, expect } from "vitest";
import type { FormAnswer, FormSubmission } from "../src/connecteam/types.js";
import { answeredDate, chooseShift, type CreditCandidate, type CreditRules } from "../src/crediting/choose.js";

const FORM = 9001;
const OLD_FORM = 8001;
const SYD = "Australia/Sydney";
const HOUR = 3600;

/** Sydney wall-clock time (AEDT, UTC+11, in Oct 2026) as Unix seconds. */
const syd = (day: number, hour: number, minute = 0) => Date.UTC(2026, 9, day, hour - 11, minute) / 1000;

const rules: CreditRules = { shiftDateQuestionId: "q-date", complianceFormId: FORM, deploymentZone: SYD };
const noQuestion: CreditRules = { ...rules, shiftDateQuestionId: "" };

const shift = (id: string, start: number, over: Partial<CreditCandidate> = {}): CreditCandidate => ({
  id,
  startAt: start,
  startTz: SYD,
  graceEndsAt: start + 8 * HOUR + HOUR / 2,
  status: "grace",
  formIds: [FORM],
  ...over,
});

const dateAnswer = (seconds: number, over: Partial<FormAnswer> = {}): FormAnswer => ({
  questionId: "q-date",
  questionType: "datetime",
  timestamp: seconds,
  timezone: SYD,
  isDateSubmitted: true,
  ...over,
});

const submitted = (at: number, over: Partial<FormSubmission> = {}): FormSubmission => ({
  formSubmissionId: "s-1",
  formId: FORM,
  submissionTimestamp: at,
  submittingUserId: 501,
  answers: [],
  ...over,
});

// Mon 19 Oct 9 am – 5 pm: a Missed Form. Tue 20 Oct 9 am – 5 pm: today's Shift.
const MON = shift("mon", syd(19, 9), { status: "reminded" });
const TUE = shift("tue", syd(20, 9));

describe("crediting order", () => {
  it("2: the Shift the submission was made during", () => {
    expect(chooseShift(submitted(syd(20, 12)), [MON, TUE], noQuestion)).toBe("tue");
  });

  it("2: ...or within the Grace Period of, inclusive at both ends", () => {
    expect(chooseShift(submitted(TUE.graceEndsAt!), [TUE], noQuestion)).toBe("tue");
    expect(chooseShift(submitted(TUE.startAt), [TUE], noQuestion)).toBe("tue");
    expect(chooseShift(submitted(TUE.graceEndsAt! + 1), [TUE], noQuestion)).toBeNull();
  });

  it("2: ...or a Shift still open", () => {
    const open = shift("open", syd(20, 9), { graceEndsAt: null, status: "open" });
    expect(chooseShift(submitted(syd(20, 23)), [open], noQuestion)).toBe("open");
  });

  it("2: the older Shift when two windows overlap", () => {
    const early = shift("early", syd(20, 6), { graceEndsAt: syd(20, 12, 30) });
    const late = shift("late", syd(20, 12, 10));
    expect(chooseShift(submitted(syd(20, 12, 20)), [late, early], noQuestion)).toBe("early");
  });

  it("3: otherwise the user's oldest outstanding Missed Form", () => {
    const older = shift("older", syd(12, 9), { status: "escalated" });
    expect(chooseShift(submitted(syd(21, 8)), [TUE, MON, older], noQuestion)).toBe("older");
  });

  it("3: a Shift still in its Grace Period or open isn't a Missed Form", () => {
    const open = shift("open", syd(21, 9), { graceEndsAt: null, status: "open" });
    expect(chooseShift(submitted(syd(21, 8)), [TUE, open], noQuestion)).toBeNull();
  });

  it("1: the Shift on the date the Shift Date Question names, before the time rules", () => {
    const s = submitted(syd(20, 12), { answers: [dateAnswer(syd(19, 0))] });
    expect(chooseShift(s, [MON, TUE], rules)).toBe("mon");
  });

  it("1: a date matching no Shift that needs a form falls back to 2, then 3", () => {
    const s = (at: number) => submitted(at, { answers: [dateAnswer(syd(15, 0))] });
    expect(chooseShift(s(syd(20, 12)), [MON, TUE], rules)).toBe("tue");
    expect(chooseShift(s(syd(21, 8)), [MON, TUE], rules)).toBe("mon");
  });

  it("1: not when no Shift Date Question is configured", () => {
    const s = submitted(syd(20, 12), { answers: [dateAnswer(syd(19, 0))] });
    expect(chooseShift(s, [MON, TUE], noQuestion)).toBe("tue");
  });

  it("1: a Shift's date is the day it started, in the zone it was recorded in", () => {
    // 10 pm Mon to 6 am Tue in Perth (AWST, UTC+8): Mon in Perth, though Tue in Sydney.
    const night = shift("night", Date.UTC(2026, 9, 19, 14, 0) / 1000, { startTz: "Australia/Perth" });
    const s = submitted(syd(21, 8), { answers: [dateAnswer(Date.UTC(2026, 9, 18, 16) / 1000, { timezone: "Australia/Perth" })] });
    expect(chooseShift(s, [night], rules)).toBe("night");
  });

  it("only Shifts that accept the submission's form", () => {
    expect(chooseShift(submitted(syd(20, 12), { formId: 7777 }), [MON, TUE], rules)).toBeNull();
  });

  it("an old form is matched by time only, never by its date answer (#17)", () => {
    // Both Shifts started before the form switch, so both accept either form.
    const monBoth = { ...MON, formIds: [OLD_FORM, FORM] };
    const tueBoth = { ...TUE, formIds: [OLD_FORM, FORM] };
    const oldSub = submitted(syd(20, 12), { formId: OLD_FORM, answers: [dateAnswer(syd(19, 0))] });
    expect(chooseShift(oldSub, [monBoth, tueBoth], rules)).toBe("tue");
    expect(chooseShift({ ...oldSub, formId: FORM }, [monBoth, tueBoth], rules)).toBe("mon");
  });
});

describe("the Shift Date Question's answer", () => {
  const read = (answers: FormAnswer[], over: Partial<FormSubmission> = {}) =>
    answeredDate(submitted(0, { answers, ...over }), rules);

  it("is the date of the datetime answer, in its own zone", () => {
    // 2 pm UTC on 18 Oct is 1 am on 19 Oct in Sydney.
    expect(read([dateAnswer(Date.UTC(2026, 9, 18, 14) / 1000)])).toBe("2026-10-19");
    expect(read([dateAnswer(Date.UTC(2026, 9, 18, 14) / 1000, { timezone: "UTC" })])).toBe("2026-10-18");
  });

  it("falls back to the submission's zone, then the Deployment's", () => {
    const at = Date.UTC(2026, 9, 18, 14) / 1000;
    expect(read([dateAnswer(at, { timezone: "" })], { submissionTimezone: "UTC" })).toBe("2026-10-18");
    expect(read([dateAnswer(at, { timezone: "Not/AZone" })])).toBe("2026-10-19");
  });

  it.each<[string, FormAnswer]>([
    ["another question", dateAnswer(syd(19, 0), { questionId: "q-other" })],
    ["not a datetime answer", dateAnswer(syd(19, 0), { questionType: "openEnded" })],
    ["left empty", dateAnswer(syd(19, 0), { wasSubmittedEmpty: true })],
    ["a time with no date", dateAnswer(syd(19, 0), { isDateSubmitted: false })],
  ])("is none for %s", (_, answer) => {
    expect(read([answer])).toBeNull();
  });
});
