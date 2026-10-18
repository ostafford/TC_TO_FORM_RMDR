# Can we link a Shift to its Scheduled Shift?

Research for [#6](https://github.com/ostafford/TC_TO_FORM_RMDR/issues/6), part of map [#1](https://github.com/ostafford/TC_TO_FORM_RMDR/issues/1). Researched 2026-10-18 from Connecteam's developer docs (raw Markdown at `developer.connecteam.com/docs/<page>.md`), its help center, and the sibling `~/IDP/sch_import` project. No live API calls were made.

Terms follow `GLOSSARY.md`: a **Shift** is a clock-in to clock-out (a Connecteam *time activity* of type `shift`); a **Scheduled Shift** is an entry in a Connecteam *scheduler* (Job Schedule).

## Short answer

Yes, through an explicit ID. Connecteam stores a `schedulerShiftId` on a Shift when the clock-in was made against a Scheduled Shift. It arrives on the `clock_in` webhook and on `GET .../time-activities`. We do not need to match by user and overlapping times. The ID is only there when the account has set the Time Clock up so employees clock in from their Scheduled Shifts, so "no `schedulerShiftId`" has to be treated as "no Scheduled Shift". That case is already covered by the Grace Period rule: wait for the real clock-out.

Two things the docs leave open, which need a live check (below): which scheduler the ID belongs to (the Shift doesn't say), and the ID's format on JS Vision-migrated accounts.

## Findings

### 1. A Shift carries an explicit link: `schedulerShiftId`

- **Time activities API.** `GET /time-clock/v1/time-clocks/{timeClockId}/time-activities` returns, per shift, `schedulerShiftId` (string), "Linked scheduler shift ID", next to `jobId` and `subJobId`. `end` is "null if shift is ongoing", so an open Shift appears in this listing with its link. Source: [Time Activities](https://developer.connecteam.com/docs/time-clock-time-activities), "Shift Response Fields".
- **Time activity webhook.** The `clock_in` (and `clock_out`) event for `activityType: shift` carries `timeActivity.schedulerShiftId`. The webhook's field table lists `jobId, subJobId, schedulerShiftId, shiftAttachments, isAutoClockOut` as the shift-specific fields. "Empty optional fields are omitted, not sent as `null`", so an unlinked clock-in has no `schedulerShiftId` key at all. "`end` is omitted for an open activity." Source: [Time activity webhook](https://developer.connecteam.com/docs/time-activity-webhook-1), "`timeActivity` fields" and the "clock_in - shift" example.
- **Clock-in API.** `POST .../clock-in` takes an optional `schedulerShiftId`, "Link to a scheduled shift", and the example response shows `"schedulerShiftId": null` for a clock-in without one. So the link is fixed when the clock-in happens, not worked out afterwards. Source: [Real-Time Clocking](https://developer.connecteam.com/docs/time-clock-real-time-clocking), "Request Body" and "Example: Clock In with Scheduler Shift".

**Confidence: high.** Three separate official pages agree on the field. Not yet confirmed live: whether a clock-in from the mobile app against a Scheduled Shift really fills it (the docs only show it on API and webhook shapes).

### 2. Reading the Scheduled Shift's planned end

- A Scheduled Shift has `startTime` / `endTime` (Unix seconds, never null) and `timezone`. Source: [Getting Shifts](https://developer.connecteam.com/docs/scheduler-get-shifts), "Shift Object".
- Fetch one by ID with `GET /scheduler/v1/schedulers/{schedulerId}/shifts/{shiftId}`, or filter a list with `GET /scheduler/v1/schedulers/{schedulerId}/shifts?startTime=…&endTime=…&shiftId=…` (`startTime`/`endTime` required; overlapping shifts are returned). Same source.
- **Gap: the Shift does not say which scheduler.** The time activity and the `clock_in` webhook carry `timeClockId` and `schedulerShiftId` but no `schedulerId`, and every scheduler-shift endpoint needs `schedulerId` in the path. Nothing in the API maps a Time Clock to its schedulers either. The help center says an Admin picks "the schedules they can clock into" in the Time Clock's settings ([Customizing How Your Employees Clock In and Out](https://help.connecteam.com/en/articles/4903952-customizing-how-your-employees-clock-in-and-out), updated 2026-08-03), but the Time Clock settings API exposes only shift attachments and manual breaks ([Settings & Configuration](https://developer.connecteam.com/docs/time-clock-settings)), and the Time Clock object is just `id`, `name`, `isArchived` (sch_import found the same: `~/IDP/sch_import/.scratch/multi-time-clock-routing/issues/01-time-clock-signal-source.md`, "The `TimeClock` object itself is minimal"). The workable approach: list the schedulers once (`GET /scheduler/v1/schedulers`), then try the ID against each non-archived scheduler until one returns it, or filter by `shiftId` plus `assignedUserIds` over a narrow time window. Most accounts have few schedulers, so this costs one to a few calls per open Shift. That fits the light shape, but count it against the 50-subrequest Free-plan cap if one invocation sweeps many open Shifts.
- **Doc inconsistency:** the Getting Shifts table names the filter `shiftId` (array), but the JS Vision page's bulk example uses `?shiftIds=`. Check which one the API accepts.

**Confidence: high** that the planned end can be read. **Medium** on the lookup shape (scheduler unknown), which needs a live check.

### 3. How reliable the link is

- **The ID is reliable when it's present; the problem is when it's missing.** Whether a Shift gets a `schedulerShiftId` depends on how each client set up their Time Clock. In Time Clock Settings > Time Tracking, an Admin chooses "users can clock in only to scheduled shifts, without a scheduled shift, or both", and "these options are not exclusive". With "Users Can Clock In Without Scheduled Shifts" on, employees "can clock in at any time, even if they do not have a scheduled shift". Source: [Customizing How Your Employees Clock In and Out](https://help.connecteam.com/en/articles/4903952-customizing-how-your-employees-clock-in-and-out). So an employee who *has* a Scheduled Shift can still clock in without one (for example on a Time Clock that only allows that mode, or by tapping the general clock-in), and then no link is recorded.
- **Restricting clock-in to the schedule's hours** ("Users can only Clock in within their schedule shift") is a separate Limitations setting, "available in the Expert plan and above". Source: [How can employees clock in and out only from their shifts](https://help.connecteam.com/en/articles/8333109-how-can-employees-clock-in-and-out-only-from-their-shifts) (2025-09-11); [Time Clock Limitations](https://help.connecteam.com/en/articles/4331813-time-clock-limitations) (2026-07-29).
- **Matching on user plus overlapping times** (when there's no ID) would be a guess: Scheduled Shifts can be open, unpublished drafts, group shifts or reassigned, and an employee can have more than one Scheduled Shift in a day. The docs give no rule for which Scheduled Shift an unlinked clock-in "belongs" to. **Recommendation: do not fall back to time matching.** Treat a Shift without `schedulerShiftId` as having no Scheduled Shift, which is what the glossary's Grace Period rule already says to do.
- **The Scheduled Shift can change after clock-in.** Admins edit shifts (`shift_updated` webhook, "title, time, users, status") or delete them (`shift_deleted`). Source: [Scheduler webhook](https://developer.connecteam.com/docs/scheduler-webhook). Read `endTime` when the Grace Period is decided, not only at clock-in, and handle a 404 (deleted Scheduled Shift) by falling back to "no Scheduled Shift".
- **JS Vision IDs (gap).** On a JS Vision-migrated company, V1 shift IDs are *slot IDs* (`<24-hex>:<uuid>`, one per assigned user), V2 uses *base IDs* (the 24-hex part), V1 rejects post-migration base IDs (404) and V2 rejects slot IDs (400). Source: [Shift IDs and Response Shapes](https://developer.connecteam.com/docs/scheduler-shifts-vision-ids-responses). No time-clock or time-activity page says which form `schedulerShiftId` takes on a migrated account. The doc examples (`"sched-789"`, `"cc6e0b98c02d55a362d8"`) are placeholders. Store it as a variable-length string (the Vision page says to allow at least 64 chars). If it contains `:`, call V1. If it doesn't, try V1, and on a 404 retry V2 with the same ID (V2 "always requires Vision", 403 otherwise).

**Confidence: high** on the settings behaviour (help center, recently updated). **Gap** on the Vision ID format.

### 4. Telling whether an account uses the scheduler

- **Account level:** `GET /scheduler/v1/schedulers` lists every scheduler with `isArchived`. If the list is empty or every scheduler is archived, the account doesn't schedule. With an API key no scope is needed; OAuth needs `schedule.read`. Source: [Get Schedulers](https://developer.connecteam.com/docs/scheduler-get-schedulers).
- **That isn't enough on its own.** An account can have schedulers while its Time Clock never links clock-ins to them (the clock-in options above), and the API doesn't expose that Time Clock setting (see §2). The reliable per-Shift signal is whether `schedulerShiftId` is there. A setup-wizard check could list schedulers and, if there are any, look at recent time activities to see whether any carry `schedulerShiftId`, then tell the installer in plain words whether the "treat as ended at the scheduled end" rule will ever fire for them.

**Confidence: high** for the endpoint; the "recent Shifts carry links" check is a suggestion, not a documented feature.

### 5. Related: Connecteam can already clock people out at the scheduled end

The Time Clock overview lists auto clock-out modes, including `schedulerShiftEnded` ("Scheduled shift ended"), and the time activity webhook has an `auto_clock_out` event whose `end.source` "may include `mode`". Source: [Time Clock overview](https://developer.connecteam.com/docs/time-clock-overview), "Auto Clock-Out Modes"; [Time activity webhook](https://developer.connecteam.com/docs/time-activity-webhook-1). The help center describes auto clock-out "immediate[ly] at shift conclusion, or … X minutes after their shift ends", available only with scheduled-shift clock-in and on the Expert plan and above ([Time Clock Limitations](https://help.connecteam.com/en/articles/4331813-time-clock-limitations)). On accounts using it, an open Shift past its Scheduled Shift's end closes itself and arrives as an ordinary clock-out (`auto_clock_out`), so our "treat as ended" logic is only needed for accounts without it. The architecture should still listen for `auto_clock_out` as a Shift end.

### 6. What sch_import tells us

- sch_import never calls the scheduler API. It parses an exported Schedule file and writes completed Shifts through `POST /time-clock/v1/time-clocks/{id}/time-activities`, without a `schedulerShiftId` (`~/IDP/sch_import/packages/shared/src/connecteam/client.ts`, `createShiftTimeActivity`, around lines 290-316). So imported Shifts are never linked, which is consistent with the field being set only at clock-in.
- Its `listTimeActivities` (`client.ts` around lines 362-392) types the shift as `id, start, end, jobId, subJobId` and notes "Response shape unconfirmed live as of writing". It is not evidence for or against `schedulerShiftId`. Copying that wrapper means adding `schedulerShiftId` and an optional `end`.
- Its Job lookup shows Jobs scoped by `instanceIds`, "List of scheduler or time clock IDs", so scheduler IDs and Time Clock IDs live in one ID space for Jobs (`~/IDP/sch_import/.scratch/multi-time-clock-routing/issues/02-job-and-break-type-scoping.md`). That doesn't connect a Shift to a scheduler, but a Job shared by a scheduler and a Time Clock could narrow which scheduler to search. Not tested.
- It confirms the scheduler-break model and the docs at `developer.connecteam.com/docs/scheduler-shifts` (`~/IDP/sch_import/.scratch/connecteam-schedule-import/issues/02-scheduler-break-support.md`).

## Gaps that need a live check (developer's test account)

1. Clock in from the mobile app against a published Scheduled Shift on a Time Clock set to "Users Can Clock Into Scheduled Shifts". Confirm the `clock_in` webhook and `GET .../time-activities` both carry `schedulerShiftId`, and that the general "clock in without a scheduled shift" path leaves it absent.
2. Confirm that `schedulerShiftId` resolves through `GET /scheduler/v1/schedulers/{schedulerId}/shifts/{id}` for the right scheduler (and 404s on the others), and whether the list filter is `shiftId` or `shiftIds`.
3. Note whether the account is JS Vision-migrated and what form the ID takes (slot `bson:uuid` vs bare BSON).
4. Edit the Scheduled Shift's end after clock-in. Confirm the GET returns the new `endTime` and that the Shift's `schedulerShiftId` is unchanged.
5. If the plan allows it, turn on auto clock-out at shift end and record what `auto_clock_out` carries (`end.source.mode`).
