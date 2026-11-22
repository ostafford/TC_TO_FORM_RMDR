# What do time clock webhooks send for a resumed segment, an auto clock-out and an edit?

Research for #124 (Spec #19, "Check at build", Time clock and webhooks), 2026-11-22. Run against the demo account under `int_MCP`'s rules, with the research key through `int_MCP/scripts/ct.sh`. Read-only: nothing was created or changed.

All four questions are about webhook *deliveries*, which the API can't show after the fact. Two sources stand in:

- **The stored records:** nine months of them (`GET .../time-activities`, 22 Feb to 22 Nov 2026, every time clock, archived ones included): 464 segments, 101 manual breaks and 9 time offs.
- **This integration's own delivery log** (added 2026-11-23): the `clock-out-form-reminder` Deployment on the demo account, from the live end-to-end run (#40), records every webhook it accepted in `webhook_deliveries` (de-dup key `requestId|eventType|userId|timeActivityId`, and when it arrived; not the payload). Read with `SELECT`s only: 275 time-activity deliveries in 179 requests, 24 Oct to 18 Nov 2026.

## Answers

| Question | Answer | How verified |
| :-- | :-- | :-- |
| Does the resumed segment (after a manual break) carry `schedulerShiftId`? | **Not seen either way.** 97 of the 101 breaks sit exactly between two segments, but in every one the segment before the break is unlinked, so none shows whether a link carries over. Separately, two segments linked to the same Scheduled Shift (2026-10-25 research, #125). | **Tested live (2026-11-22)** that the history has no linked segment followed by a break. **Needs a person**: a clock-in from a Scheduled Shift on a phone, a break, then a resume. |
| The `auto_clock_out` payload as delivered | **The record, not the delivery:** an auto clock-out has `isAutoClockOut: true`, and its `end.source` is `{ type: "autoClockOut", mode }`, with `mode` `hourLimit` (6 of 7) or `geofenceExit` (1, which also names the geofence). `start.source` is whatever started it (mobile, kiosk, NFC). No `schedulerShiftEnded` mode appears in these 7. **The delivery log** has one `auto_clock_out`, and it carries the *same* `requestId` as that time activity's `clock_in`, 4.5 hours earlier. The Worker's de-dup key includes the event type, so both are handled. | **Tested live (2026-11-22)** for the stored record; **seen in the delivery log (2026-11-23)** for the shared `requestId`. The payload itself isn't logged: it **needs a receiver** and an auto clock-out. |
| Is a dashboard clock-out edit one `admin_edit` delivery or several? | **One.** All 5 `admin_edit` deliveries in the log came one per request, and no other delivery followed for the same time activity. The one whose record still exists has `start` and `end` sources of `admin`, so it was a dashboard edit; the other 4 records have been deleted since, so their source is unknown. Which field each edit changed isn't logged. | **Seen in the delivery log (2026-11-23)**: 5 edits, 1 confirmed from the dashboard. |
| Do edits made through the API fire webhooks? | **Not answerable.** API punches do (tested live 2026-10-21, #23), and the log shows plenty of adds: 117 `admin_add`s, each in its own request, often 7 for one user within a few seconds, as a batch of API writes would make (`sch_import` writes time activities through the API). Four of the 5 edits came 6 seconds to 3 minutes after a batch of adds to the same user, but nothing records whether a person or the API made them, and no project here edits time activities through the API. | **Needs a receiver** and an API edit. This integration was receiving the demo account's webhooks until at least 18 Nov 2026, so an API edit to a clock-out may reach it too: **ask first**. |

## Found on the way (for #125)

**Which clock-ins carry `schedulerShiftId`:** of 9 linked segments, 7 started from mobile, 1 from NFC and 1 from PC; none from the API (264 segments) or the dashboard (153). That fits "a clock-in from a Scheduled Shift fills it", and it shows NFC and PC clock-ins can too. It doesn't show that a *general* mobile clock-in leaves it out: 29 mobile segments are unlinked, but whether any of those had a Scheduled Shift isn't known.

## What it means for the Worker

- **Auto clock-outs need nothing special.** The Worker reads `isAutoClockOut` but ends the Shift at the recorded `end.timestamp` whatever the source (Spec: "Connecteam's own auto clock-out ... is an ordinary Shift end").
- **Nothing here changes the code.** A dashboard edit arriving as one `admin_edit` matches what the fake sends. A `requestId` shared by a `clock_in` and an `auto_clock_out` hours apart is the case the de-dup key already allows for (Spec: "`requestId` alone isn't unique").

## Sources

- Live: `GET /time-clock/v1/time-clocks`, and `GET /time-clock/v1/time-clocks/{id}/time-activities` for each clock in three 3-month windows (the API refuses more than 92 days).
- The Deployment's D1 database, `clock-out-form-reminder`: `SELECT` on `webhook_deliveries` through `wrangler d1 execute --remote`, with a throwaway config in the scratchpad (the repo's config untouched).

## Demo-account changes

None. Every call and query was a read.
