# Does the fake Connecteam behave like the real one?

Research for [#73](https://github.com/ostafford/TC_TO_FORM_RMDR/issues/73) (map [#69](https://github.com/ostafford/TC_TO_FORM_RMDR/issues/69)). Gathered 2026-11-17, against `main` at `8bfc08a`.

It covers every assumption that `test/worker/fake-connecteam.ts`, the webhook builders in `test/worker/harness.ts`, `src/connecteam/types.ts`, `src/connecteam/client.ts` and `src/connecteam/signature.ts` make about Connecteam's Open API. I checked each one against Connecteam's developer docs (guides updated 2026-01 to 2026-09, plus the OpenAPI schemas embedded in the reference pages). Where a check could be done read-only, I also ran it against the demo account using `int_MCP/scripts/ct.sh`.

**Verdicts:**
- **matches (tested live)**: I saw it on the demo account on 2026-11-17, unless an earlier dated test is cited.
- **matches (docs only)**: the docs say so, and I didn't test it live.
- **differs**: the fake or the client disagrees with reality. Each one says how, with the evidence.
- **unverifiable**: neither the docs nor a read-only call settles it.

No writes were made, so nothing that needs a write (sends, task create/PUT/DELETE, webhook deliveries) was re-tested today. Those rows cite the earlier live tests recorded in #23, #28 and `int_MCP/research/`.

## Headline findings

1. **Differs: looking a user up by id does not return an archived user.** The fake says "asking by id finds archived users too". In reality `GET /users/v1/users?userIds=<archived id>` returns `users: []`, because the default `userStatus=active` still applies. With `&userStatus=all` the archived user comes back (tested live). So the test "still name an employee archived since the Shift" (`test/worker/escalation.test.ts:181`) passes only against the fake. Live, `getUser` returns `null`, and an Escalation for an employee archived since the Shift would name nobody. The same `getUser` is also read for the Reminder (`src/cron/dueSteps.ts:150`) and the reopened Reminder Task (`src/cron/reminderTask.ts:198`).
2. **Differs (low impact): `form-submissions` comes back newest first.** The fake returns submissions in insertion order, oldest first in every test. `checkSubmitted` (`src/crediting/check.ts:36`) credits them in the order they come back, so with two or more submissions in one window, live order can credit a different one than the tests expect.
3. **Fake narrower than reality: the sweep's `GET .../time-activities`** ignores the date range, never returns `schedulerShiftId`, and always says `isAutoClockOut: false`. Live, the range is applied to each record's *local start date* (tested), and `schedulerShiftId` is present when linked. So no sweep test can cover a swept segment linked to a Scheduled Shift, or a record outside yesterday and today.
4. **Differs (cosmetic): error bodies and statuses.** A revoked key is **403** `{"detail":"Invalid API key"}` live, while the fake's `rejectKey()` defaults to 401. A missing key is 401. Query validation is **400** (`error_code` 1003), not the 422 the docs and OpenAPI give. Some fake 404 bodies use different wording or keys. The client only branches on status, plus the two bodies it matches ("Sender id not found" and "not found in course_modules"), and the fake has both of those exactly. So none of this changes behaviour today.
5. **Latent: `listConversations()` doesn't page.** Live returns 10 by default (79 exist on the demo account). Nothing in the Worker calls it (the wizard pages on its own), and the fake doesn't implement it.
6. **Everything else matches:**
   - the webhook secret scheme: a static `x-webhook-secret`, no HMAC
   - the webhook envelopes for `time_activity` (flat), `forms` (`data` object) and `Task` (`data` array)
   - endpoint paths and methods
   - Unix **seconds** everywhere
   - the inclusive submitted-time window on `form-submissions`
   - users paging
   - rate-limit header names
   - scheduler V1/V2 id rules
   - the behaviour of task PUT and DELETE on deleted tasks
   - "Sender id not found" being checked before the recipient

## Auth, base URL, timestamps

| Assumption | Where | Verdict |
| :-- | :-- | :-- |
| Base `https://api.connecteam.com`, auth header `X-API-KEY` | client.ts | **matches (tested live)** |
| Every time field is Unix **seconds**: punches, `modifiedAt`, `createdAt`, `submissionTimestamp`, datetime answers' `timestamp`, Scheduled Shift `startTime`/`endTime` | types.ts, fake | **matches (tested live)**: every value seen has 10 digits. A `form-submissions` window given in milliseconds matches nothing. Docs: `TimestampWithTimezone` is "Unix seconds and TZ database timezone" ([time activity webhook](https://developer.connecteam.com/docs/time-activity-webhook-1.md)) |
| A punch is `{timestamp, timezone}`, with timezone an IANA zone | types.ts `Punch` | **matches (tested live)**: live punches also carry `locationData` and `source`, which are ignored |
| Invalid key gives 401 or 403, and both set `keyRejected` | client.ts | **matches (tested live)**: a bad key is **403** `{"detail":"Invalid API key"}` (forms and users alike) with no rate-limit headers; no key is 401 `{"error":"No authentication provided",...}` |
| Fake `rejectKey()` answers 401 by default | fake | **differs (cosmetic)**: live is 403. The client treats the two the same |

## Webhooks and signature

| Assumption | Where | Verdict |
| :-- | :-- | :-- |
| `webhookVersion: 1` doesn't sign the body. The registered `secretKey` is sent verbatim in `x-webhook-secret`, and is compared in constant time | signature.ts | **matches (docs only)**: "It does **not** sign or hash the request body" ([setting up webhook via API](https://developer.connecteam.com/docs/setting-up-webhook-via-api.md)). Earlier live confirmation is cited in signature.ts (#22). The demo account's time_activity/forms/tasks subscriptions are all `webhookVersion: 1` (tested live) |
| `time_activity` payload is **flat**: `requestId, company, eventTimestamp, webhookVersion, userId, timeClockId, activityType, eventType, timeActivity` | harness `timeActivity()`, webhook/timeActivity.ts | **matches (docs only)**: "Time Activity is flat" ([webhooks overview](https://developer.connecteam.com/docs/overview-1.md)). Also tested live 2026-10-21 (#23) |
| `end` is **omitted** while a segment is open in the webhook | harness, types.ts | **matches (docs only)**: "`end` is omitted for an open activity"; "Empty optional fields are omitted, not sent as `null`" |
| Delete events carry a bare `timeActivityId` (`admin_delete`, `*_approved_delete_request`) | harness `deletion()` | **matches (docs only)**: `admin_delete` example. `user_delete_request` and `admin_declined_*` also send only `timeActivityId`, and the code ignores those |
| A manual break is the ordinary events with `activityType: "manual_break"` and `manualBreakId` | harness `manualBreak()` | **matches (docs only)**, and tested live 2026-10-21 (#23) |
| `admin_approved_*` / `auto_approved_*` carry a saved segment, while `user_*_request` and `admin_declined_*` are only requests | webhook/timeActivity.ts | **matches (docs only)**: "`user_edit_request` includes the **requested** times" |
| An approved clock-out outside the geofence or without NFC arrives as a segment with the new id | webhook/timeActivity.ts | **unverifiable**: docs say "the original clock-in shift is deleted and a new shift is created for the approved times". They don't say whether a separate delete event is sent for the original, which the Worker would need in order to drop the open segment. Worth a live test before relying on it |
| `form_submission` payload: envelope with `activityType: "forms"` and the submission in `data` (same fields as the GET) | harness `formSubmission()` | **matches (docs only)** ([form submission webhook](https://developer.connecteam.com/docs/forms-webhook.md)) |
| `form_submission_edited` keeps the original `submissionTimestamp` (ignored by the code) | webhook/formSubmission.ts | **matches (docs only)**: example keeps `1736760013` |
| Tasks payload: `activityType: "Task"`, `data` is an **array** of `{id, taskBoardId (number), userIds, status, ...}`, with nothing saying who completed it | harness `taskCompleted()` | **matches (docs only)** ([tasks webhook](https://developer.connecteam.com/docs/tasks-webhook.md)), and tested live 2026-10-24 (#28). The misspelt `evnetTimestamp` is real too |
| De-dup key is `requestId` + `eventType` + entity | webhook/*.ts | **matches (docs only)**: "Do not deduplicate on `requestId` alone. Combine it with `eventType` and the affected entity" |

## Users

| Assumption | Where | Verdict |
| :-- | :-- | :-- |
| `GET /users/v1/users` returns `{requestId, data:{users}, paging:{offset}}`, with `paging.offset` = offset + returned | fake | **matches (tested live)**: live also sends `paging.total`, which the fake omits and nothing reads |
| Default `limit` 10, max 500, offset paging, stop on a short page | client `listActiveUsers`, fake | **matches (docs only)** ([get users](https://developer.connecteam.com/docs/read-users-data.md), [pagination](https://developer.connecteam.com/docs/pagination-1.md)) |
| Default `userStatus` is active, so the list excludes archived users | fake | **matches (tested live)**: 10 users, none archived. The archived user only appears with `userStatus=archived` |
| **Asking by `userIds` also finds archived users** | fake (`query.userIds ? all.filter(...)`), client `getUser` | **differs (tested live)**: `?userIds=<archived id>&limit=1&offset=0` returns `users: []`. Adding `&userStatus=all` returns the user with `isArchived: true` |
| `userType` is `user` / `manager` / `owner` | fake, recipients.ts | **matches (tested live)** for `owner` and `user`. The demo account has no `manager` right now. `manager` is **docs only** |
| `customFields[]` of `{customFieldId, value, type, name}`, where the `directManager` value is a user id (number) | fake, types.ts | **matches (tested live)** |

## Forms and submissions

| Assumption | Where | Verdict |
| :-- | :-- | :-- |
| `GET /forms/v1/forms/{id}` returns `data.formId` (number) and `data.formName` (string) | client `getForm`, fake | **matches (tested live)**: also returns `createdAt`, `lastUpdatedAt`, `questions`, `settings` |
| Missing form gives 404 | client (`gone.add("form")`), fake | **matches (tested live)**: body `{"detail":"the requested form id - <id> doesn't exist"}`, while the fake says `"form not found"` (cosmetic). `form-submissions` on a missing form is also 404 `{"detail":"Form not found"}` |
| `GET .../form-submissions` takes `userIds`, `submittingStartTimestamp`, `submittingEndTime` (note the mismatched names) and `limit`, and returns `data.formSubmissions` | client, fake | **matches (tested live)** |
| The window is **inclusive at both ends** and filters on the **submitted** time, not the opened time | fake filter, client comment | **matches (tested live)**: one submission opened 23 days before it was submitted. `[ts, ts]` returns it. `[ts+1, ...]`, `[..., ts-1]` and a window around its open time all return nothing |
| `limit` max 100 | client `SUBMISSIONS_PAGE` | **matches (tested live)**: `limit=101` gives **400** `{"details":{"error_code":1003,...},"error":{"query.limit":...}}`, not 422 |
| Rows come back in insertion (oldest-first) order | fake (`.filter().slice()`) | **differs (tested live)**: live order is newest first. Low impact: see headline 2 |
| Submission fields: `formSubmissionId` (string), `formId` and `submittingUserId` (numbers), `submissionTimestamp`, `submissionTimezone`, `answers` | types.ts | **matches (tested live)**: live also has `submissionStartTimestamp`, `entryNum`, `isAnonymous`, `managerFields` |
| A `datetime` answer carries `timestamp` (seconds), `timezone` and `isDateSubmitted` (types.ts says "not seen live") | types.ts `FormAnswer`, crediting/choose.ts | **matches (tested live)**: seen today on several forms, with `isTimeSubmitted` too. **Caution, now confirmed:** an *empty* answer can still carry a `timestamp` (with `wasSubmittedEmpty: true` and `isDateSubmitted: false`). `choose.ts:60` already rejects those, so the "not seen live" note in types.ts can be updated |

## Time clocks and time activities (the sweep)

| Assumption | Where | Verdict |
| :-- | :-- | :-- |
| `GET /time-clock/v1/time-clocks` returns `data.timeClocks[]` of `{id (number), name, isArchived}`, archived clocks included | client, fake | **matches (tested live)**: 4 clocks, 3 archived |
| `GET .../time-activities?startDate&endDate` (`YYYY-MM-DD`) returns `data.timeActivitiesByUsers[]` of `{userId, shifts, manualBreaks, timeOffs}` and isn't paged | client, fake | **matches (tested live)**: no `paging` key. Live lists **every** user on the clock, even those with no records, while the fake lists only users with records (harmless) |
| A range over 92 days is refused | none (sweep asks for two days) | **matches (tested live)**: 400 `{"detail":["Date range cannot exceed 3 months (92 days)"]}` |
| Record fields `id` (string), `start`, `end`, `modifiedAt` (seconds), `isAutoClockOut` | client `records()`, fake | **matches (tested live)**: 174 shifts and 46 breaks checked. Breaks also carry `manualBreakId` and `createdAt` |
| `schedulerShiftId` is a string when linked and **absent** (not null or "") otherwise | client | **matches (tested live)**: 1 of 174 present, 173 absent. The id is `<24 hex>:<uuid>` (61 chars) |
| Fake never returns `schedulerShiftId`, and `isAutoClockOut` is always `false` | fake | **differs (fake narrower)**: see headline 3 |
| An open record's `end` is `null` on the GET (the fake sends `null`, the client accepts null or absent) | fake, client | **matches (docs only)**: the field table says "End time point (null if shift is ongoing)" ([time activities](https://developer.connecteam.com/docs/time-clock-time-activities.md)). Not tested live: no record was open today |
| The fake returns every record "whatever the dates" | fake | **differs**: live applies the range to the record's **local start date**. A shift starting 2026-08-19 23:00 UTC (09:00 Melbourne on 08-20) comes back for `2026-08-20`, not `2026-08-19`. Whether the time clock's zone or the punch's zone decides is **unverifiable** here, since both are Melbourne on the demo account. Whether a record that started before `startDate` is returned is also unverified |

## Scheduler

| Assumption | Where | Verdict |
| :-- | :-- | :-- |
| `GET /scheduler/v1/schedulers` returns `data.schedulers[]` of `{schedulerId, name, isArchived, timezone}` | client, fake | **matches (tested live)** |
| `GET /scheduler/v1/.../shifts/{id}` takes a colon id raw or URL-encoded, and returns `data.{id, startTime, endTime, assignedUserIds}` (seconds) | client (`encodeURIComponent`), fake | **matches (tested live)**: the encoded colon id is accepted and the returned `id` is identical |
| V2 refuses a colon id with 400 `{"error":"shift id is invalid","details":{"error_code":1004,...}}` and accepts the 24-hex base id | fake, client | **matches (tested live)**: the V2 base-id GET returns the same shape |
| Missing shift gives 404 `{"detail":"shift not found"}`, and a missing scheduler gives 400 `{"detail":"schedule id doesn't exist"}` | fake, client (both become `null`) | **matches (tested live)**: the one time activity linked on the demo account now points at a deleted Scheduled Shift, and V1 answers 404 for it |
| Fake checks the scheduler before V2's colon rule | fake | **unverifiable** (live order), and harmless: both give `null` |

## Chat sends

| Assumption | Where | Verdict |
| :-- | :-- | :-- |
| `POST /chat/v1/conversations/privateMessage/{userId}` and `POST /chat/v1/conversations/{id}/message`, body `{senderId, text}` | client, fake | **matches (docs only)** ([private messages](https://developer.connecteam.com/docs/chat-private-messages.md), [conversations](https://developer.connecteam.com/docs/chat-conversations.md)) |
| Success returns `{requestId, data: {}}`, and the client returns `null` | fake, client | **matches (docs only)**: OpenAPI `APIResponseV2_BaseResponseV2_` |
| Text clamped to 500 characters | client `MAX_TEXT` | **matches (docs only)**, conservatively: the docs allow 1000 |
| A deleted publisher gives 404 `{"detail":"Sender id not found"}`, checked before the recipient or conversation | fake, client `#notePublisher` | **matches**: tested live 2026-10-24 (`int_MCP/research/2026-10-24-error-responses-for-missing-settings.md`) |
| `GET /chat/v1/conversations` in one call | client `listConversations` | **differs (latent)**: paged, default 10, max 100 (tested live: 10 by default, 79 with `limit=100`). Unused by the Worker, and the fake has no handler for it |

## Quick Tasks

| Assumption | Where | Verdict |
| :-- | :-- | :-- |
| `POST /tasks/v1/taskboards/{board}/tasks` with `{userIds, status:"published", title, description:{content}}` returns `data.id` (string) | client `createTask`, fake | **matches (docs only)**: OpenAPI `CreateTaskResponse` requires `id`. Existing task ids are 24-char strings (tested live, read) |
| One `userId` makes an individual task, and several make a group task | client comment | **matches (docs only)** ([managing tasks](https://developer.connecteam.com/docs/tasks-managing-tasks.md)) |
| A deleted board on create gives 400 with "... not found in course_modules" | fake, client | **matches**: tested live 2026-10-24 (int_MCP note above) |
| `PUT` is a full replace. It returns 200, even on a deleted task (which stays deleted). A never-existing task gives 404 | fake, client | **matches**: tested live 2026-10-24 (#28). The real PUT returns the task (`UpdateTaskResponse`), while the fake returns `data: {}` or the body. The client ignores it |
| `DELETE` returns 200 `{data:{}}`, and a second DELETE gives 404 `Task not found` | fake | **matches**: tested live 2026-10-24 (#28). Live 404 bodies use `{"error": ...}`, while the fake uses `{"detail": ...}` (cosmetic) |
| A completion made through the API sends no `task_completed` | fake (no webhook on PUT) | **matches**: tested live 2026-10-24 (#28) |
| A `PUT` after its board is deleted | fake (200 if the task is still in the map) | **unverifiable** without writes |

## Rate limits, 5xx and timeouts

| Assumption | Where | Verdict |
| :-- | :-- | :-- |
| Headers `x-ratelimit-{minute,day}-{limit,remaining}` on responses | client `readRateLimit`, fake | **matches (tested live)**: present on every 200, with integer values, and `-reset` as a float (`1794873600.0`, unread). Absent on a 403 |
| Limits are per account (demo: 200/min, 20,000/day, Enterprise) | ADR-0002, sweep | **matches (tested live)** for the values. "Per account, not per API key" is **docs only** ([rate limiting](https://developer.connecteam.com/docs/rate-limiting-1.md)) |
| Over the limit gives `429` | http/json.ts, fake `failNext(..., 429)` | **matches (docs only)**: not provoked, because that would spend the shared live budget |
| Fake sends rate-limit headers only when a test sets them | fake | **differs (fake narrower)**: live always sends them on success. Tests without them never exercise the 20% headroom stop, which is only a coverage point |
| 5xx and dropped connections are transient | http/json.ts, fake `failAll`/`null` | **unverifiable**: not documented and not provokable |

## Not checked

- `src/connecteam/client.ts` is the whole surface the Worker uses. The wizard's own calls (`scripts/wizard-helper.ts`) are out of scope for #73.
- Nothing was tested on a JS Vision-migrated account (the demo account's V1 ids already have colons). See the Vision docs for the V1/V2 id table.

## Demo-account changes

Every call was a GET. Created: nothing. Deleted: nothing. Reads touched users (including one archived test user), forms and submissions, time clocks and activities, schedulers and one Scheduled Shift, chat conversations, task boards and tasks, and the webhook list. No secrets are returned by that list, and none were printed.
