# How do Scheduled Shift links and planned ends behave live?

Research for #125 (Spec #19, "Check at build", Scheduler), 2026-11-22. Run against the demo account under `int_MCP`'s rules, with the research key through `int_MCP/scripts/ct.sh`. It builds on earlier read-only research, `int_MCP/research/2026-10-25-scheduler-shift-lookup.md` (a local note, not on GitHub; its findings that matter here are copied below).

## Answers

| Question | Answer | How verified |
| :-- | :-- | :-- |
| Does an edited planned end show up on `GET`? | **Yes, at once.** After `PUT /scheduler/v1/schedulers/{id}/shifts` moved a Scheduled Shift's `endTime` an hour later, the next `GET .../shifts/{shiftId}` returned the new `endTime` and a newer `updateTime`. The edit kept the same shift id: the update answered with no `deletedShiftIds` and no `createdShifts`. | **Tested live (2026-11-22)**, on an unpublished, unassigned `[research]` Scheduled Shift. |
| Does the id resolve under the right scheduler? | **Under its own scheduler, yes.** 5 of 7 linked time activities resolved under the account's scheduler, each to a Scheduled Shift for the same user; the other 2 answered 404 (deleted since). Whether it answers 404 under *another* scheduler can't be tested here: the demo account has one scheduler. | **Tested live (2026-10-25)** for one scheduler. Several schedulers: **not tested**. |
| Is the shifts list filter `shiftId` or `shiftIds`? | `shiftId`; `shiftIds` is ignored. The Worker doesn't use the list: it reads one Scheduled Shift by id. | **Tested live (2026-10-25)**. |
| Does a mobile clock-in from a Scheduled Shift fill `schedulerShiftId`, and a general one not? | **Not compared.** Linked records carry it (7 time activities, Feb to Jun 2026), and two separate segments linked to the same Scheduled Shift, so a later segment of a Shift can carry the link. Which kind of clock-in made each isn't recorded. | **Tested live (2026-10-25)** that linked records carry it. **Needs a person** to clock in both ways on a phone. |
| The id format on a Vision-migrated account | **Unknown.** On the demo account (V1) the id is `<24 hex>:<uuid>`. V2 rejects an id with a colon (400, "shift id is invalid") and returns the same Scheduled Shift for the 24-hex part. | **Tested live (2026-10-25)** on V1 only. A Vision-migrated account: **not tested**. |

## What it means for the Worker

- **An Admin's edit to the planned end is picked up.** For a Shift still open, the Worker reads the Scheduled Shift again when its planned end comes (`src/cron/scheduledEnd.ts`), so a planned end edited before then is the one it uses. The id doesn't change on an edit, so the Shift's stored `schedulerShiftId` still finds it.
- **Several schedulers:** the Worker tries each non-archived scheduler until one returns the Scheduled Shift (`findScheduledShift`). If another scheduler answered 200 for a foreign id, the wrong planned end could be used; the 2026-10-25 research saw a missing scheduler answer 400 and a missing shift 404, so a foreign id most likely answers 404, but that's untested.

## Sources

- Live: `POST`, `PUT`, `GET` and `DELETE` on `/scheduler/v1/schedulers/{schedulerId}/shifts` (2026-11-22); the 2026-10-25 note above.
- Creating, Updating and Deleting Shifts: https://developer.connecteam.com/docs/scheduler-create-shifts.md, https://developer.connecteam.com/docs/scheduler-update-shifts.md, https://developer.connecteam.com/docs/scheduler-delete-shifts.md ("Draft shifts (isPublished=false) never trigger notifications").

## Demo-account changes

- **Created:** one Scheduled Shift, "[research] edited end", on 1 Dec 2026, unpublished and assigned to nobody, with `notifyUsers=false`, so nobody was notified.
- **Changed:** its `endTime`, an hour later (`notifyUsers=false`).
- **Deleted:** that Scheduled Shift. A `GET` for it then answered 404 "shift not found".
- Nothing else was changed.
