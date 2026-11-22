# Do archived forms list, do anonymous forms name the submitter, and does entityId filter form webhooks?

Research for #126 (Spec #19, "Check at build", Forms), 2026-11-22. Run against the demo account under `int_MCP`'s rules, with the research key through `int_MCP/scripts/ct.sh`. Read-only: nothing was created or changed.

## Answers

| Question | Answer | How verified |
| :-- | :-- | :-- |
| Does an anonymous form still return `submittingUserId`? | **Yes, but as `-1`**, a placeholder, not the person. The submission also says `isAnonymous: true`. | **Tested live (2026-11-22)**: the one submission to the demo account's anonymous form ("Anonymous Form Test"). `GET /users/v1/users?userIds=-1` is refused (400, "greater than or equal to 1"), so it names nobody. |
| Do archived forms appear in the forms list? | **Unknown.** No form in `GET /forms/v1/forms` carries an archived or status flag (each has only `formId`, `formName`, `createdAt`, `lastUpdatedAt`, `questions`, `settings`), and the list's only filters are `name`, `startDate`, `endDate`, `limit` and `offset`. So the list can't say whether a form is archived, and whether any of the 27 forms are is not visible through the API. | **Tested live (2026-11-22)** that there's no flag. The docs don't mention archived forms. **Needs a person** to archive a `[research]` form in the app and list again. |
| Does `entityId = formId` limit the `form_submission` webhook to that form? | **Probably, per docs; not tested.** `entityId` is the subscription's "Preferred scope ID", and omitting it gives "matching events from all supported entities in the company". The only worked example scopes a time clock; forms aren't named. | **Per docs, not tested.** The API can't create a submission, so a live test **needs a person** to submit to another form while a `[research]` subscription listens. |

## What it means for the Worker

- **Anonymous forms:** a submission credits to no one. `creditSubmission` looks up Shifts for user `-1`, finds none, and does nothing. The wizard's warning that an anonymous form "can't tell who submitted it" is right and stays.
- **Archived forms:** if the list does include them, the wizard could offer one as the Compliance Form, and nobody could submit to it. The Worker's form block only catches a form that's gone (404). Low risk, since a client picks a form they use.
- **entityId:** low stakes either way. The Worker credits only submissions to a form the Shift accepts (`src/crediting/choose.ts`), so another form's deliveries are ignored. The answer only decides how much webhook traffic a Deployment gets.

## Sources

- Live: `GET /forms/v1/forms?limit=100`, `GET /forms/v1/forms/{anonymous form}/form-submissions?limit=100`, `GET /users/v1/users?userIds=-1&userStatus=all`.
- Get forms (reference): https://developer.connecteam.com/reference/get_forms_forms_v1_forms_get.md (query parameters; no archive filter).
- Setting up a webhook via API: https://developer.connecteam.com/docs/setting-up-webhook-via-api.md (`entityId`).
- Form submission webhook: https://developer.connecteam.com/docs/forms-webhook.md (nothing on scoping).

## Demo-account changes

None. Every call was a read.
