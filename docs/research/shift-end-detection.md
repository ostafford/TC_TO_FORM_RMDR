# How do we learn a Shift has ended?

Research for [#2](https://github.com/ostafford/TC_TO_FORM_RMDR/issues/2). Read 2026-10-18. Terms follow `GLOSSARY.md` (a **Shift** is one clock-in to clock-out; a **Scheduled Shift** is the planned one).

No live API calls were made. Everything below is from Connecteam's published docs and help center, plus code in sibling IDP projects. Items marked **live check** need confirming against the test account.

## Answer in brief

- **Use the Time Activity webhook as the main signal, plus a polling sweep as a safety net.** Connecteam pushes a delivery for every way a Shift can end, and `GET .../time-activities` can find open and closed Shifts for reconciliation. [1][2]
- **One webhook can cover the whole account.** Set `featureType: "time_activity"` and leave out `entityId`, and it delivers events from every Time Clock in the company. That fits "every user is covered". [1][3]
- **The webhook is not a guaranteed channel.** A failed delivery gets at most 3 retries with no fixed delay, a `404` reply is never retried, and nothing documents a dead-letter or replay. If the Worker is down longer than that, the clock-out is lost. A periodic poll is what catches it. [3][4]

## Every way a Shift ends, and the event it fires

All of these arrive on the same `time_activity` webhook with `activityType: "shift"`. The payload is flat (no `data` wrapper) and includes `userId`, `timeClockId` and a `timeActivity` with `id`, `start`, `end`, `schedulerShiftId` and `isAutoClockOut`. [1]

| How the Shift ends | `eventType` | Source |
|---|---|---|
| Employee clocks out (app, kiosk, NFC, or API `POST .../clock-out`) | `clock_out` | [1][5] |
| Connecteam's auto clock-out (hour limit, daily limit, Scheduled Shift ended, left geofence, GPS off) | `auto_clock_out`; `timeActivity.isAutoClockOut: true`; end `source.type: "autoClockOut"` with a `mode` such as `schedulerShiftEnded` | [1][6] |
| Admin adds a whole Shift afterwards | `admin_add` | [1] |
| Admin edits a Shift, including adding or changing its clock-out | `admin_edit` | [1] |
| Employee asks to add or edit a Shift and it is approved | `admin_approved_add_request` / `admin_approved_edit_request`, or `auto_approved_*` when no approval is needed | [1] |
| Clock-out outside the geofence or without NFC is approved | `admin_approved_clock_out_outside_geo_fence_request` (this **deletes the original Shift and creates a new one**, so it has a new `id`), `auto_approved_clock_out_outside_geo_fence_request`, `admin_approved_clock_out_without_nfc_request`, `auto_approved_clock_out_without_nfc_request` | [1] |
| Employee starts a live manual break | The open Shift is **closed** and a break opens. When the break ends, a **new** Shift opens on the same job. Which event the closing Shift fires is not documented. **Live check.** | [7] |
| Shift deleted (admin, or an approved delete request) | `admin_delete` / `admin_approved_delete_request` / `auto_approved_delete_request`, carrying only `timeActivityId` | [1] |

Do **not** act on these, because they are only requests and nothing has been saved yet: `user_add_request` and `user_edit_request` (they carry the *requested* times), `user_delete_request`, and the `admin_declined_*` events. [1]

### Things to watch

- **Retroactive punches.** Clock-in and clock-out through the API or an offline kiosk can carry a `timestamp` up to 12 hours in the past. A `clock_out` can therefore arrive with an `end.timestamp` hours earlier than the delivery. Count the Grace Period from `end.timestamp`, not from when the event arrived, or from whichever is later (product decision). [5]
- **Breaks split a working day into several Shifts.** A live manual break closes the Shift and the resume opens a new one with a new `id` [7]. Under the glossary's "one submission per Shift" rule, a worker who takes lunch has two Shifts and would need two Compliance Forms. Product needs to decide whether that is intended; it may need a grilling ticket.
- **Shift `id` is not always stable.** The geofence-approval flow replaces the Shift with a new `id` [1]. Key Reminder state on `(userId, timeActivity.id)`, but treat a delete plus an add for the same user and times as the same Shift.
- **Shifts can be edited after a Reminder.** Every edit fires `admin_edit` with the full new times [1]. The design must decide what happens when a Shift's end moves after a Reminder went out, or when the Shift is deleted.
- **Connecteam can already end open Shifts at the Scheduled Shift's end.** Its "auto clock-out by shift limitations" option clocks out at the Scheduled Shift's end, or X minutes after, and fires `auto_clock_out` with mode `schedulerShiftEnded` [6][8]. It needs the Expert plan, and the client must turn it on. If it is off, our own rule ("a Shift still open past its Scheduled Shift's end is treated as ending then") needs a timer, because no event fires when a Scheduled Shift's end passes.

## Open Shifts: can we see them, and how fresh is the data?

- **Webhook:** `clock_in` fires when a Shift opens. Its `timeActivity` has `start` and no `end`, and includes `schedulerShiftId` when the Shift is linked to a Scheduled Shift [1]. Storing these gives a live list of open Shifts, as fresh as the webhook (no latency figure is published).
- **Polling:** `GET /time-clock/v1/time-clocks/{timeClockId}/time-activities?startDate&endDate&activityTypes=shift` returns Shifts with `end` left out while open. The schema requires only `id` and `start` [2][9]. It reads live data with no documented caching or delay. Limits: one call per Time Clock (list them with `GET /time-clock/v1/time-clocks`), dates only (`YYYY-MM-DD`), at most 92 days, optional `userIds` filter [2][9]. Its `modifiedAt` field lets a sweep spot edits [2].
- **No "who is clocked in now" endpoint** is listed in the docs index [10]. Use the time-activities query or the stored `clock_in` events.
- **Gaps (live check):** Does a Shift open since yesterday appear in a query for today's date only? In other words, is the date range matched on start, on end, or on overlap, and in which timezone? Sweeps need to query a window of yesterday to today until that is confirmed.

## Limits that size the design

- **Rate limits apply per account**, not per key: Expert 100/min and 10,000/day; Enterprise 200/min and 20,000/day. API access needs the Expert plan or higher [11][12]. A sweep every 5 minutes uses 288 calls per Time Clock per day, so 10 Time Clocks use about 2,900 of Expert's 10,000. Make the sweep interval a setting, and count Time Clocks at setup.
- **Webhook receiver contract:** reply `2xx` within 10 seconds and process later. Retries resend the same JSON. `requestId` is not unique per event, so de-duplicate on `requestId + eventType + userId + timeActivity.id` [1][3]. Never return `404` for a valid delivery, because Connecteam treats that as permanent [3][4].
- **Auth on deliveries:** `secretKey` is echoed verbatim in `x-webhook-secret` (no HMAC). It can only be set through `POST /settings/v1/webhooks`, so register the webhook from the API, not the UI [3]. EH_Webhook confirmed both against real deliveries (`~/IDP/EH_Webhook/docs/RUNBOOK.md` §6, `~/IDP/EH_Webhook/src/connecteam/signature.ts`). Only account Owners can create webhooks in the UI [4].
- **Plan:** a light piece in the playbook's terms. One webhook delivery leads to about 0-1 outbound calls, while sweeps are one call per Time Clock. The timed parts (Grace Period, Escalation delay, Scheduled-Shift-end fallback) need a scheduler such as Cron Triggers, Durable Object alarms or delayed Queue messages. That is the architecture ticket's call.

## Evidence from sibling projects

- `~/IDP/sch_import/packages/shared/src/connecteam/client.ts`, `listTimeActivities` (around line 362), already calls `GET .../time-activities` with `startDate`/`endDate`/`userIds`. Its comment says the response shape was **not** confirmed live, and it types `end` as always present, which is wrong for open Shifts per [9]. Don't copy that type as-is.
- The same file, `createConversationWebhook`, found that `webhookVersion: 0` is required for `featureType: "chat"`, contrary to the docs. For `time_activity` the docs say version `1` [1]. **Live check** that the default is accepted.
- `~/IDP/EH_Webhook/docs/RUNBOOK.md` §6: register once and `PUT` to update, because a second `POST` creates a duplicate webhook and every event is then delivered twice. Users webhooks fire once per changed field, so check whether `admin_edit` behaves the same (**live check**).

## Live checks for the test account

1. Clock in, start a live manual break, end it, and clock out. Record which events fire, and whether the closed first Shift gets `clock_out`.
2. Trigger an auto clock-out (a short hour limit, or Scheduled Shift end) and capture the `auto_clock_out` payload, including `end.source.mode`.
3. An admin adds a clock-out to an open Shift in the dashboard. Is that `admin_edit` or `clock_out`, and does one edit produce one delivery?
4. Do API-made changes (`POST .../clock-out`, `PUT .../time-activities`) fire webhooks?
5. Run `GET .../time-activities` while a Shift that began yesterday is still open. Is it returned for a today-only range, and is `end` left out or `null`?
6. Does a broadcast `time_activity` subscription (no `entityId`) with `webhookVersion` left at its default get accepted, and does it deliver from every Time Clock?

## Sources

1. Connecteam, "Time activity webhook" (updated 2026-09-02). https://developer.connecteam.com/docs/time-activity-webhook-1
2. Connecteam, "Time Activities" guide (updated 2026-09-02). https://developer.connecteam.com/docs/time-clock-time-activities
3. Connecteam, "Setting up webhook via API" (updated 2026-09-02). https://developer.connecteam.com/docs/setting-up-webhook-via-api
4. Connecteam, Webhooks "Overview" (updated 2026-09-02). https://developer.connecteam.com/docs/overview-1
5. Connecteam, "Real-Time Clocking" (updated 2026-09-02). https://developer.connecteam.com/docs/time-clock-real-time-clocking
6. Connecteam, Time Clock "Overview": punch source types and auto clock-out modes. https://developer.connecteam.com/docs/time-clock-overview
7. Connecteam, "Manual Break Clocking" (updated 2026-09-02). https://developer.connecteam.com/docs/time-clock-manual-break-clocking
8. Connecteam Help Center, "Can I Prevent Employees From Forgetting to Clock Out?" https://help.connecteam.com/en/articles/8283183-can-i-prevent-employees-from-forgetting-to-clock-out and "Auto Clock Out" https://help.connecteam.com/en/articles/9360668-auto-clock-out
9. Connecteam API reference, "Get time activities" (OpenAPI `ShiftActivityResponse`: required `id`, `start`). https://developer.connecteam.com/reference/get_time_activities_time_clock_v1_time_clocks__timeclockid__time_activities_get
10. Connecteam docs index. https://developer.connecteam.com/llms.txt
11. Connecteam, "Rate limiting" (updated 2026-01-28). https://developer.connecteam.com/docs/rate-limiting-1
12. Connecteam, "API access". https://developer.connecteam.com/docs/api-access
