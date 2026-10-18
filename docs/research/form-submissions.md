# Finding a user's Compliance Form submissions in a time window

Research for [#3](https://github.com/ostafford/TC_TO_FORM_RMDR/issues/3). Gathered 2026-10-18 from Connecteam's developer docs (guides last updated 2026-01 to 2026-09) and help center. No live API calls were made; items marked **live check** need confirming against the test account.

## Answer in brief

Yes to both parts.

- **(a) Pick list:** `GET /forms/v1/forms` lists the account's forms with `formId` and `formName`, paginated up to 300 per page.
- **(b) Window search:** `GET /forms/v1/forms/{formId}/form-submissions` filters by `userIds` and by submission time (`submittingStartTimestamp` to `submittingEndTime`, Unix seconds, both inclusive per the guide). Each submission carries `submittingUserId`, `submissionTimestamp` (submitted) and `submissionStartTimestamp` (opened).
- **Alternative to polling:** a `form_submission` webhook exists. It pushes the same submission fields the moment a form is submitted.
- **No link to Shifts:** a submission has no Shift or time-activity id, so the time window is the only way to tie a submission to a Shift.

## (a) Listing forms for the setup wizard

`GET /forms/v1/forms` ([reference](https://developer.connecteam.com/reference/get_forms_forms_v1_forms_get), [guide](https://developer.connecteam.com/docs/forms-get-forms.md)).

| Query param | Notes |
| :-- | :-- |
| `name` | Partial, case-insensitive match on the form name (reference only; the guide omits it). |
| `startDate` / `endDate` | `YYYY-MM-DD`, inclusive, filter on the form's **creation** date (UTC). Not useful for us. |
| `limit` | Default 10, max **300**. |
| `offset` | Default 0. |

Response: `data.forms[]` with `formId` (int), `formName`, `createdAt`, `lastUpdatedAt`, `questions[]`, `settings`; plus `paging.offset`. `settings` holds `isAnonymous`, `limitEntriesPerUser`, `limitTotalEntries`, `limitEntriesUntilTimestamp`, `enableUsersToDownloadPdf`, `managerFields` (from the OpenAPI schema embedded in the reference page).

Points for the wizard:

- The form object has **no archived/active flag** and **no assigned-users/groups field**, so the wizard can't hide archived forms or show who a form is assigned to. **Live check:** whether archived forms appear in the list.
- `GET /forms/v1/forms/{formId}` returns one form, for re-checking the stored Compliance Form still exists ([forms overview](https://developer.connecteam.com/docs/forms-overview.md); 404 if not found per the guide).
- Visibility follows the API key's admin: "Results respect the authenticated admin's form permissions. You only see forms and submissions you are authorized to view." ([forms overview](https://developer.connecteam.com/docs/forms-overview.md)). An owner-level key avoids a form or submission being silently invisible.
- `settings.isAnonymous`: a submission has its own `isAnonymous` flag. An anonymous form likely can't be matched to a user (**live check**: is `submittingUserId` blanked?). The wizard should refuse or warn on an anonymous form.
- `settings.limitEntriesPerUser`: if the client caps entries per user, staff can't submit once per Shift. Worth a warning in the wizard.
- Auth: API key (`X-API-KEY`) or OAuth scope `forms.read`. A `403` can mean "plan does not include the Forms API" ([guide](https://developer.connecteam.com/docs/forms-get-forms.md)).

## (b) A user's submissions between two times

`GET /forms/v1/forms/{formId}/form-submissions` ([reference](https://developer.connecteam.com/reference/get_form_submissions_forms_v1_forms__formid__form_submissions_get), [guide](https://developer.connecteam.com/docs/forms-form-submissions.md)).

| Query param | Type | Guide's description |
| :-- | :-- | :-- |
| `formId` (path) | int | Form to query. Required. |
| `userIds` | array of int | "Filter by submitting user IDs." Default all users. |
| `submittingStartTimestamp` | int | "Include submissions submitted **at or after** this Unix timestamp." Default 0. |
| `submittingEndTime` | int | "Include submissions submitted **at or before** this Unix timestamp." Default now. |
| `limit` | int | Default 10, max **100**. |
| `offset` | int | Default 0. |

Note the inconsistent names (`...StartTimestamp` vs `...EndTime`); both are integers.

**Units are seconds.** The parameter descriptions don't state a unit, but the guide's example window uses `submittingStartTimestamp=1704067200&submittingEndTime=1706745599` (2024-01-01 00:00:00 to 2024-01-31 23:59:59 UTC in seconds), and the webhook examples use 10-digit values (`1736760013`). Time-clock timestamps are documented as "Unix format (in seconds)" (`TimestampWithTimezone` schema), so clock-in/clock-out values from the `clock_out` webhook can be passed straight through.

**Which timestamp the filter uses:** the guide says "submitted", i.e. `submissionTimestamp`, not the open time. **Live check:** confirm with a submission opened before clock-in and submitted after it.

**Array encoding:** the schema says `array of integer` but not how to send it. The spec is FastAPI-generated (`HTTPValidationError`, `PaginatedBaseResponse[...]` names), where a list query param is a repeated key (`?userIds=1&userIds=2`). For our case we only ever send one user, so `?userIds=123` sidesteps the question; EH_Webhook already does this for `/users/v1/users` (`/Users/okky.stafford/IDP/EH_Webhook/src/connecteam/client.ts:66`). sch_import's client encodes arrays as repeated keys (`/Users/okky.stafford/IDP/sch_import/packages/shared/src/connecteam/client.ts:96`), not yet verified live there either.

### Response shape

`{ requestId, data: { formSubmissions: [...] }, paging: { offset, total? } }` (OpenAPI schema `PaginatedBaseResponse_FormsSubmissionsGetResponse_`). Each `FormSubmissionResponse`, all fields required:

| Field | Meaning |
| :-- | :-- |
| `formSubmissionId` | string id (Mongo-style hex in examples) |
| `formId` | int |
| `submittingUserId` | int; compare with the Shift's `userId` |
| `submissionTimestamp` | when submitted ("The timestamp of the submission") |
| `submissionStartTimestamp` | "when the employee opened the form to begin filling it out" |
| `submissionTimezone` | e.g. `America/New_York` |
| `entryNum` | running entry number for the form |
| `isAnonymous` | bool |
| `answers[]`, `managerFields[]` | not needed for a yes/no check |

We need only "is there ≥1 submission from this user in the window?", so `limit=1` answers it in **one call**; no paging needed. `paging.total` ("Only populated by endpoints that compute it") is unreliable.

### Pagination (if ever needed)

Offset/limit. The [pagination guide](https://developer.connecteam.com/docs/pagination-1.md) says to keep adding `limit` to `offset` until a page returns fewer than `limit` items.

## Rate limits

From [Rate limiting](https://developer.connecteam.com/docs/rate-limiting-1.md):

| Plan | Per minute | Per day |
| :-- | --: | --: |
| SBP | 5 | 100 |
| Expert | 100 | 10,000 |
| Enterprise | 200 | 20,000 |

- Limits are **per account, not per API key**, so this integration shares the budget with any other integration on the client's account.
- `429` when exceeded. Headers `x-ratelimit-minute-{limit,remaining,reset}` and `x-ratelimit-day-{limit,remaining,reset}` (reset is UTC epoch seconds). EH_Webhook's `ConnecteamClient` already reads these (`/Users/okky.stafford/IDP/EH_Webhook/src/connecteam/client.ts:135-137`).
- Budget per Shift if we poll: 1 submissions check at Grace Period end, plus a Reminder send (1), plus an Escalation-time re-check (1) and Escalation sends (one per Admin, plus a lookup of Admins/manager). On **SBP's 100/day** that caps out at a few dozen Shifts a day. Worth a note in the wizard about which plan the client is on. **Gap:** which Connecteam plans include API access at all is not on this page.

## The webhook alternative: `form_submission`

From [Form submission webhook](https://developer.connecteam.com/docs/forms-webhook.md) and [Setting up webhook via API](https://developer.connecteam.com/docs/setting-up-webhook-via-api.md):

- Feature type `forms`; events `form_submission`, `form_submission_edited`, `manager_field_updated`.
- Payload: envelope (`requestId`, `company`, `activityType: "forms"`, `eventType`, `eventTimestamp`) with `data` holding the same fields as the GET (`formSubmissionId`, `formId`, `submittingUserId`, `submissionTimestamp`, `submissionStartTimestamp`, `isAnonymous`, `answers`).
- Created with `POST /settings/v1/webhooks` (`featureType: "forms"`, `eventTypes: [...]`, optional `entityId`, optional `secretKey` sent back verbatim as `x-webhook-secret`). Needs `settings.write`; the [overview](https://developer.connecteam.com/docs/overview-1.md) says only account Owners can create webhooks in the UI.
- Delivery ([overview](https://developer.connecteam.com/docs/overview-1.md)): respond 2xx within 10 s; failures retried **up to 3 times with no fixed delay**; a `404` is permanent; `requestId` is not a unique event id. So a webhook can be lost after a short outage.
- **Gap:** what `entityId` means for `forms`. For time activity it's the Time Clock id; the reference says "numeric-scoped features ... pass the numeric ID as a string", and the UI asks to pick an "Object", so it is probably the `formId`. **Live check:** create a forms webhook with `entityId` = the Compliance Form's id and confirm only that form's submissions arrive. Without scoping, every form submission in the account hits the Worker (cheap to filter by `formId`, but noisier).

Implication for architecture (#10): the webhook could record submissions in D1 as they arrive, so most checks cost **zero** API calls. Because delivery isn't guaranteed, the Grace-Period-end check should still fall back to one GET before declaring a Missed Form (or use the GET alone and skip the webhook). Either way the GET is the source of truth.

## Linking a submission to a Shift

- The submission has **no Shift, time-activity, job or Scheduled Shift reference** (all fields listed above). The match is purely `submittingUserId` + `submissionTimestamp` inside clock-in → Grace Period end.
- Connecteam can't natively attach a Form to a time-clock Shift: "you cannot directly use a Form as a shift attachment within the Time Clock feature at the moment" ([help: form as shift attachment](https://help.connecteam.com/en/articles/10253753-can-i-use-a-form-as-a-shift-attachment)). The help center's only "before clock-out" option is a required self-confirmation Shift Entry dropdown, which isn't a Forms submission ([help: requirements before clocking out](https://help.connecteam.com/en/articles/9293586-how-can-i-set-requirements-for-completing-a-form-before-clocking-out)). It also says shift attachments don't trigger on auto clock-out.
- Because "a submission counts toward at most one Shift" (GLOSSARY), two back-to-back Shifts whose windows overlap (Shift A's Grace Period runs into Shift B's clock-in) could both see the same submission. The window query can't prevent that; the Worker must record which `formSubmissionId` it already credited to a Shift.

## Edits and timestamps

- `form_submission_edited` exists and its example keeps the original `submissionTimestamp` (1736760013) while `eventTimestamp` is later. So an edit appears **not** to move a submission into or out of a window. **Live check.**
- Per-answer `submissionTimestamp` / `updateTimestamp` exist but aren't needed.
- Offline submissions: the docs don't say whether a form submitted offline gets its device time or its sync time as `submissionTimestamp`, or how late it can arrive. **Gap** (unverified, not a documented behaviour).

## Live checks for the test account

1. Pass clock-in/out seconds as `submittingStartTimestamp`/`submittingEndTime` and confirm both ends are inclusive and the filter is on `submissionTimestamp` (not open time).
2. `userIds=<one id>` filters correctly; also try two ids as repeated keys.
3. Do archived forms show in `GET /forms/v1/forms`? Does an anonymous form's submission still carry `submittingUserId`?
4. Forms webhook `entityId` = `formId` scopes to that form.
5. Check the test account's `x-ratelimit-*` headers to see which plan tier it's on.

## Sources

- Connecteam API reference, Get form submissions (includes embedded OpenAPI schema): https://developer.connecteam.com/reference/get_form_submissions_forms_v1_forms__formid__form_submissions_get
- Connecteam API reference, Get forms: https://developer.connecteam.com/reference/get_forms_forms_v1_forms_get
- Connecteam API reference, Create webhook: https://developer.connecteam.com/reference/create_webhook_settings_v1_webhooks_post
- Guides: [Forms overview](https://developer.connecteam.com/docs/forms-overview.md), [Get Forms](https://developer.connecteam.com/docs/forms-get-forms.md), [Form Submissions](https://developer.connecteam.com/docs/forms-form-submissions.md), [Form submission webhook](https://developer.connecteam.com/docs/forms-webhook.md), [Webhooks overview](https://developer.connecteam.com/docs/overview-1.md), [Setting up webhook via API](https://developer.connecteam.com/docs/setting-up-webhook-via-api.md), [Rate limiting](https://developer.connecteam.com/docs/rate-limiting-1.md), [Pagination](https://developer.connecteam.com/docs/pagination-1.md)
- Help center: [Can I use a Form as a shift attachment?](https://help.connecteam.com/en/articles/10253753-can-i-use-a-form-as-a-shift-attachment), [Requirements for completing a form before clocking out](https://help.connecteam.com/en/articles/9293586-how-can-i-set-requirements-for-completing-a-form-before-clocking-out)
- Existing code: `/Users/okky.stafford/IDP/EH_Webhook/src/connecteam/client.ts` (single-id `userIds`, rate-limit headers), `/Users/okky.stafford/IDP/sch_import/packages/shared/src/connecteam/client.ts` (array params as repeated keys)
- Prior feasibility note naming the same endpoint and filters: `/Users/okky.stafford/IDP/int_MCP/clients/glow-care-solutions/2026-09-29-clockout-form-alert.md`
