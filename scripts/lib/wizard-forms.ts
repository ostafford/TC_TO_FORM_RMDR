/**
 * What the setup wizard's form steps (#38, user stories 35 to 37) make of
 * Connecteam's forms: the pick list, the warnings on a form that can't work
 * per Shift, and the form's date questions for the Shift Date Question.
 * Pure, so the rules are tested without a network.
 *
 * Shapes tested live 2026-10-24 on the demo account (#38): `GET
 * /forms/v1/forms` returns `data.forms[]` with `formId`, `formName`,
 * `questions[]` and `settings`; `settings.isAnonymous` is a boolean and each
 * `limit*` setting is `{ enabled, <limit> }`; a date question is `questionType:
 * "datetime"` with `isDateActive` / `isTimeActive`; a `group` question nests
 * its own `questions[]`.
 */

export interface ApiLimit {
  enabled?: boolean;
  [limit: string]: unknown;
}

export interface ApiQuestion {
  questionId?: string;
  title?: string;
  questionType?: string;
  isDateActive?: boolean;
}

export interface ApiForm {
  formId: number;
  formName: string;
  questions?: ApiQuestion[];
  settings?: {
    isAnonymous?: boolean;
    limitEntriesPerUser?: ApiLimit;
    limitTotalEntries?: ApiLimit;
    limitEntriesUntilTimestamp?: ApiLimit;
  };
}

const limitOf = (l: ApiLimit | undefined, field: string): number | null => {
  if (!l?.enabled) return null;
  const n = Number(l[field]);
  return Number.isFinite(n) ? n : 0;
};

/** One line, no tabs: a name or title as the wizard prints it. HTML tags (seen in question titles) are dropped. */
export function plainText(text: string): string {
  return text
    .replace(/<\/?(p|br|div|li|ul|ol|h\d)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Short tags for the pick list, one per problem {@link formWarnings} explains. */
export function formTags(form: ApiForm): string[] {
  const s = form.settings ?? {};
  const tags: string[] = [];
  if (s.isAnonymous) tags.push("anonymous");
  const perUser = limitOf(s.limitEntriesPerUser, "limitEntriesPerUser");
  if (perUser !== null) tags.push(perUser === 1 ? "one entry per person" : `${perUser} entries per person`);
  const total = limitOf(s.limitTotalEntries, "limitTotalEntries");
  if (total !== null) tags.push(`${total} entries in all`);
  if (limitOf(s.limitEntriesUntilTimestamp, "limitEntriesUntilTimestamp") !== null) tags.push("closing date");
  return tags;
}

/**
 * Why this form can't work as a per-Shift Compliance Form, one plain line
 * each, or none. Every Shift needs its own submission from a known person,
 * so an anonymous form or any cap on entries breaks it sooner or later.
 */
export function formWarnings(form: ApiForm): string[] {
  const s = form.settings ?? {};
  const out: string[] = [];
  if (s.isAnonymous) {
    out.push("It's anonymous, so we can't tell who submitted it. Turn off anonymous submissions on the form in Connecteam, or choose another form.");
  }
  const perUser = limitOf(s.limitEntriesPerUser, "limitEntriesPerUser");
  if (perUser !== null) {
    out.push(
      perUser === 1
        ? "It lets each person submit only once, so it can't work as a per-shift form. Turn off the entries-per-user limit in Connecteam, or choose another form."
        : `It lets each person submit only ${perUser} times in all, so it stops working after that many shifts. Turn off the entries-per-user limit in Connecteam, or choose another form.`,
    );
  }
  const total = limitOf(s.limitTotalEntries, "limitTotalEntries");
  if (total !== null) {
    out.push(`It stops taking entries after ${total} in all. Turn off the total-entries limit in Connecteam, or choose another form.`);
  }
  if (limitOf(s.limitEntriesUntilTimestamp, "limitEntriesUntilTimestamp") !== null) {
    out.push("It has a closing date, after which nobody can submit it. Turn off the closing date in Connecteam, or choose another form.");
  }
  return out;
}

/** The pick list's labels: the name, with the id added where two forms share a name, and any tags. */
export function formLabels(forms: ApiForm[]): string[] {
  const count = new Map<string, number>();
  for (const f of forms) count.set(plainText(f.formName), (count.get(plainText(f.formName)) ?? 0) + 1);
  return forms.map((f) => {
    const name = plainText(f.formName) || `(untitled form)`;
    const tags = formTags(f);
    return `${name}${(count.get(plainText(f.formName)) ?? 0) > 1 ? ` (id ${f.formId})` : ""}${tags.length ? `  ⚠ ${tags.join(", ")}` : ""}`;
  });
}

export interface DateQuestion {
  questionId: string;
  title: string;
}

/**
 * The form's questions that can name a Shift's date: top-level `datetime`
 * questions with the date part on. Time-only questions name no day, and a
 * question inside a group isn't offered: a group can repeat, and crediting
 * reads the submission's top-level answers (src/crediting/choose.ts).
 */
export function dateQuestions(form: ApiForm): DateQuestion[] {
  return (form.questions ?? [])
    .filter((q) => q.questionType === "datetime" && q.isDateActive !== false && typeof q.questionId === "string" && q.questionId)
    .map((q) => ({ questionId: q.questionId!, title: plainText(q.title ?? "") || "(untitled date question)" }));
}

/** The zone in `GET /time-clock/v1/time-clocks/{id}/settings` (`data.general.timezone`, tested live 2026-10-24), or `null`. */
export function zoneOfSettings(body: unknown): string | null {
  const z = (body as { data?: { general?: { timezone?: unknown } } } | null)?.data?.general?.timezone;
  return typeof z === "string" && z.trim() ? z.trim() : null;
}
