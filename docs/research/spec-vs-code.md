# Spec vs code: does each user story hold?

Research for #70 (map #69). The contract is "Spec: Clock-out Form Reminder" (#19), including its comments and the "Decided after the build (#67)" note. The code is `main` at `8bfc08a`.

**How each claim was checked.** *Verified* means I read the implementing code and the named test, and the suite ran green: `npm test` gave 32 files and 479 tests passing on 2026-11-17, after `npm ci` in a fresh worktree. *Suspected* means an inference from reading that no test or run confirms. No mutation testing was done, so "the test that would fail" means the test that asserts the behaviour, not one proven to fail on a mutant. Where a story's test exists only at a pure-function seam and not at the Worker boundary, the table says so.

Classes: **T** implemented and tested · **U** implemented, untested · **D** diverges from Spec · **M** missing.

## Headline

- **No story is missing.** Of the 68 live stories (1–65 and 69–71; #67 dropped 66–68), 60 are implemented and tested, 3 diverge (20, 50, 61) and 5 are implemented but untested (46, 49, 69, 70, 71). The full wizard (17 stages, 11 `--step` names) and every Failure Alert condition are there.
- **Five divergences, all small. Three were deliberate build decisions recorded in PRs but never written back into the Spec:**
  1. The submission check asks for up to 100 submissions, not `limit=1`, and makes one call per accepted form (PR #46). This is needed so a submission already credited to another Shift can be skipped.
  2. The Escalation's "ticked" note appears after *any* tick, not only after a second one (PR #49, "any tick"). Story 20 is satisfied; the Implementation Decisions and Testing Decisions wording isn't.
  3. The test message defaults to the account's sole owner, not "the person running it" (PR #64), because the API can't tell who's running the wizard.
  4. *Drift:* the lost-webhook alert counts Shift **Segments** the sweep found, including stale edits, not **Shifts** the webhook missed. Its "no webhook for 24 hours" check counts form and task deliveries too.
  5. *Drift:* webhook de-duplication records the key but never skips on it. Repeats are safe because processing is idempotent, which is not the same as de-duplicating.
- **One Spec gap the code had to fill:** the Spec's `time_activity` event list leaves out `clock_in`, but stories 5, 6 and 30 (open past the Scheduled Shift's end) can't work without it. The code subscribes to it.
- **Untested:** 46 (the Shift Entry tip's wording), 49 (refusing when not on Workers Paid), 69 (run on a call), 70 (session log with keys redacted) and 71 (no sibling imports). So is the "no" path of 47 (stopping at the summary).
- **The Relay removal (#67) is already in the Spec**, so it isn't a divergence. It left one stale comment (`scripts/lib/wizard-people.ts:4`, "the support link's values") and an unused column (`failure_alerts.relayed`, migration 0011, kept on purpose).

## Employees (1–15)

| # | Story | Code | Test | Class | Note |
|---|---|---|---|---|---|
| 1 | Reminder when the form is missing | `src/cron/dueSteps.ts:132-192` (`endOfGracePeriod`) | `test/worker/basic-path.test.ts:62` | T | verified |
| 2 | No Reminder if submitted in the Grace Period | `src/crediting/check.ts:24-42` (window: first clock-in to `graceEndsAt`, `dueSteps.ts:146`) | `basic-path.test.ts:101`; `crediting.test.ts:79` (worker) | T | verified |
| 3 | Reminder names the form, the Shift's date and times, and where to find it | `src/messages/reminder.ts:19-29`, `format.ts:35-41` | `test/message-wording.test.ts:22` (pure); `basic-path.test.ts:62` (worker) | T | verified |
| 4 | Says the manager is notified after the delay | `reminder.ts:27`, `:49` | `message-wording.test.ts:22`, `:147` | T | verified |
| 5 | Still-clocked-in Reminder | `src/cron/scheduledEnd.ts:19-45`, `dueSteps.ts:183-184`, `store.ts:557` (`openState`) | `test/worker/open-past-end.test.ts:55` | T | verified |
| 6 | Break-never-ended Reminder | `reminder.ts:36-51` (`onBreak`) | `open-past-end.test.ts:142`; `message-wording.test.ts:160` | T | verified |
| 7 | One form across a lunch break | `src/store.ts:336-366` (`#joinAcrossBreaks`), `:381-418` (`#refreshTimes`) | `test/worker/manual-breaks.test.ts:56`, `:75`, `:81`, `:112` | T | verified |
| 8 | Reminder Task | `src/cron/reminderTask.ts:85-139` (`create`), `client.ts:269` | `test/worker/reminder-task.test.ts:64` | T | verified |
| 9 | Task ticks itself off when the form arrives | `store.ts:623-645` (`credit` sets the task due), `reminderTask.ts:169-173` | `reminder-task.test.ts:126`, `:148`, `:200` | T | verified. Closes on the next cron run (within a minute), not inside the webhook. |
| 10 | Tick without submitting: one DM, task reopened | `store.ts:821-840` (`recordTick`), `reminderTask.ts:181-234` (`reopen`) | `test/worker/tick.test.ts:73`, `:131`, `:167` | T | verified |
| 11 | A catch-up submission is credited to the right Shift | `src/crediting/choose.ts:34-55` | `test/crediting.test.ts:48-115` (pure); `test/worker/crediting.test.ts:149`, `:215` | T | verified |
| 12 | Reminder at once, even at 3:30 am | Reminders never consult Quiet Hours (`dueSteps.ts:132-192`) | `test/worker/quiet-hours.test.ts:142` | T | verified |
| 13 | Times in the Shift's recorded zone | `format.ts:35-41` (start zone; short name only when it differs) | `basic-path.test.ts:128`; `message-wording.test.ts:120` | T | verified |
| 14 | Clearly automated sender | `client.ts:244-250` (`senderId` = publisher); wizard hint `scripts/lib/wizard-people.ts:68` | `basic-path.test.ts:62` (senderId); `test/wizard-people.test.ts:73`; `setup-wizard.test.ts:560` | T | verified |
| 15 | One submission counts for one Shift | `store.ts:623-645` (`NOT EXISTS ... credited_submission_id`), `crediting/credit.ts:18-32` | `worker/crediting.test.ts:149`, `:161`, `:184`; `test/worker/store-crediting.test.ts:35` | T | verified |

## Admins and direct managers (16–27)

| # | Story | Code | Test | Class | Note |
|---|---|---|---|---|---|
| 16 | Escalation after the delay | `src/cron/escalate.ts:49-72` | `test/worker/escalation.test.ts:66` | T | verified |
| 17 | Never at the same time as the employee | `dueSteps.ts:158` (`escalateAt` = actual Reminder time + delay); a Reminder given up on keeps `graceEndsAt + delay` (`:141`) | `escalation.test.ts:59`, `:91` | T | verified |
| 18 | Says who, which Shift, which form, how long ago reminded | `src/messages/escalation.ts:23-35` | `test/escalation.test.ts:22`, `:42` | T | verified |
| 19 | Never carries form content | `escalation.ts:23-35` builds from no answers | `test/escalation.test.ts:22` ("no form content") | T | verified at the pure seam. The Worker-level test doesn't feed answers in to check they don't leak. |
| 20 | Says when the employee ticked without submitting | `escalate.ts:118` → `store.ts:857` (`taskTicked`: `tick IS NOT NULL`) | `tick.test.ts:97`, `:167` | **D** | verified. The note appears after the **first** tick. The Spec's Implementation Decisions ("If the employee ticks it again ... the Escalation adds the line") and Testing Decisions ("A second tick → the Escalation note") tie it to the second. The story itself is met. A build decision (PR #49: "any tick"). |
| 21 | No Escalation if submitted before it's due | `escalate.ts:91` (check again), `store.ts:623` | `escalation.test.ts:81`; `worker/crediting.test.ts:69` | T | verified |
| 22 | Held during Quiet Hours | `escalate.ts:42-56`, `store.ts:573` (`hold`) | `quiet-hours.test.ts:62` | T | verified |
| 23 | One Escalation Summary per recipient, split past 500 characters | `src/cron/summary.ts:22-71`, `messages/escalation.ts:55-88` | `quiet-hours.test.ts:71`, `:90`, `:128`; `test/quiet-hours.test.ts:93` | T | verified |
| 24 | Daytime Escalations one at a time | `escalate.ts:65-70` | `quiet-hours.test.ts:148` | T | verified |
| 25 | A direct manager gets them even if Excluded | `src/escalation/recipients.ts:45-57` | `escalation.test.ts:139` (worker); `test/escalation.test.ts:95` | T | verified |
| 26 | Admin who is also the direct manager gets one | `recipients.ts:56` (`new Set`) | `escalation.test.ts:147`; `test/escalation.test.ts:99` | T | verified |
| 27 | A newly promoted Admin is included automatically | `escalate.ts:94` (live `listActiveUsers` at send time) | `escalation.test.ts:161` | T | verified |

## The client (28–65)

| # | Story | Code | Test | Class | Note |
|---|---|---|---|---|---|
| 28 | Everyone who clocks in is covered | Broadcast subscription `scripts/lib/wizard-turn-on.ts:73-79` (`entityId: null`); no user filter in `src/index.ts:29-115` | `test/wizard-turn-on.test.ts:10`; `setup-wizard.test.ts:696` | T | verified |
| 29 | Every way a Shift ends is checked | `src/webhook/timeActivity.ts:37-39` | `test/worker/shift-endings.test.ts:34-61` (12 event types + `auto_clock_out`) | T | verified |
| 30 | Open past the scheduled end is treated as ended then | `scheduledEnd.ts:37-44`, `store.ts:540` (`endBySchedule`) | `open-past-end.test.ts:55`, `:74` | T | verified. Needs `clock_in`, which the Spec's event list omits (see Spec gaps). |
| 31 | Open with no Scheduled Shift waits | `scheduledEnd.ts:22`, `:32-35`; `store.ts:526` | `open-past-end.test.ts:174`, `:184` | T | verified |
| 32 | Back-filled more than 24 hours late is never checked | `store.ts:187`, `:398-400` (`created_at - end_at > 24 h` → `too_late`) | `shift-endings.test.ts:92-126`; `test/worker/sweep.test.ts:112` | T | verified |
| 33 | An edit doesn't start a second check | `store.ts:221-233` (map back by id / start / inside a checked Shift), `:411` (only `open`/`grace` refresh) | `shift-endings.test.ts:129`, `:141`, `:177`; `manual-breaks.test.ts:191`, `:203` | T | verified |
| 34 | A deleted Shift cancels its steps and deletes its open task | `store.ts:428-460`, `reminderTask.ts:149-150`, `:249-259` | `shift-endings.test.ts:210`; `reminder-task.test.ts:227` | T | verified |
| 35 | Choose the form from the live list | `scripts/setup-wizard.sh:566` (`s_form`), `scripts/lib/wizard-forms.ts:97` | `setup-wizard.test.ts:361` | T | verified |
| 36 | Warn on anonymous or once-per-user forms | `wizard-forms.ts:72` (`formWarnings`) | `test/wizard-forms.test.ts:30`, `:36`; `setup-wizard.test.ts:380`, `:388` | T | verified. Also flags a total cap and a closing date (extra). |
| 37 | Optional Shift Date Question | `setup-wizard.sh:598` (`s_dateq`), `wizard-forms.ts:118`; Worker `choose.ts:43-47` | `setup-wizard.test.ts:361`, `:397`; `wizard-forms.test.ts:73` | T | verified |
| 38 | Set where staff find the form | `setup-wizard.sh:629`, `scripts/lib/wizard-values.ts:52` | `setup-wizard.test.ts:412`; `test/wizard-values.test.ts:44` | T | verified |
| 39 | Grace Period and delay with a worked timeline | `setup-wizard.sh:648`, `:667`; `wizard-values.ts:82`, `:92` | `setup-wizard.test.ts:431`, `:441`; `wizard-values.test.ts:58`, `:63` | T | verified |
| 40 | Quiet Hours can be turned off | `setup-wizard.sh:693`; `src/env.ts:96-98` | `setup-wizard.test.ts:463`; `quiet-hours.test.ts:155` | T | verified |
| 41 | One time zone, defaulting to the time clock's | `setup-wizard.sh:527`; `wizard-forms.ts:125` | `setup-wizard.test.ts:319`; `quiet-hours.test.ts:170` (DST) | T | verified |
| 42 | Every Admin ticked, untick to exclude, at least one kept | `setup-wizard.sh:733`; `wizard-people.ts:28` | `setup-wizard.test.ts:482`, `:495`, `:505` | T | verified |
| 43 | Reminder Task on/off and board | `setup-wizard.sh:781-816` | `setup-wizard.test.ts:522`, `:531`; `test/worker/settings.test.ts:17-40` | T | verified |
| 44 | Sender name through a custom publisher | `setup-wizard.sh:818` | `setup-wizard.test.ts:551`, `:568` | T | verified |
| 45 | Pick or create an Alerts Channel | `setup-wizard.sh:856` | `setup-wizard.test.ts:578`, `:610`, `:619` | T | verified |
| 46 | Shift Entry tip | `setup-wizard.sh:909-921` (`s_tip`) | Only passed through in `setup-wizard.test.ts:696` (a full run's stage count); its wording isn't asserted | U | verified (read). PR #65 reworded it; no test pins it. |
| 47 | Review a summary before anything goes live | `setup-wizard.sh:1007-1032` | `setup-wizard.test.ts:696` (the "y" path, summary rows asserted) | T / U | verified. The "n → Nothing went live" path (`:1026-1030`) has no test. |
| 48 | Stop below Expert | `scripts/lib/api-allowance.ts:10-19`; `setup-wizard.sh:482` | `test/api-allowance.test.ts:22`; `setup-wizard.test.ts:278` | T | verified |
| 49 | Confirm Workers Paid | `setup-wizard.sh:456-457` (a y/n; no API check) | `setup-wizard.test.ts:675` answers "y" only | U | verified (read). The refusal on "n" isn't tested. It asks the human and never checks the plan, which is how the Spec words it ("confirm"). |
| 50 | Test Reminder, real wording, to a picked user (by default me) | `setup-wizard.sh:1139-1171` | `setup-wizard.test.ts:696` (exact wording asserted), `:783`, `:845` | **D** | verified. The default is the sole owner when there is exactly one, otherwise none, not "the person running it". Deliberate (PR #64: "the API can't tell who is running the wizard"). |
| 51 | Change one setting with `--step` | `setup-wizard.sh:221` (`STEPS`), `:1249-1297` | `setup-wizard.test.ts:243`, `:250` and each step's rerun test | T | verified. The step names match the Spec exactly. |
| 52 | See what a change affects first | `setup-wizard.sh:1186-1223` (`apply_rerun`), `scripts/lib/wizard-rerun.ts:32`, `:82` | `test/wizard-rerun.test.ts:32` (the Spec's own sentence); `setup-wizard.test.ts:881`, `:907`, `:919` | T | verified |
| 53 | A form switch accepts either form mid-flight | `store.ts:1094-1117` (`noteComplianceForm`); `index.ts:60`; `dueSteps.ts:76` | `test/worker/settings-mid-flight.test.ts:68-147` | T | verified |
| 54 | Shorter timings keep scheduled steps' times | `store.ts:382` (Grace kept while in `grace`), `dueSteps.ts:158` (delay fixed at Reminder) | `settings-mid-flight.test.ts:150`, `:160`, `:175` | T | verified |
| 55 | Excluded Admins, Quiet Hours and "where" take effect on the next send | `escalate.ts:94`, `:107`; `escalate.ts:42-46`; `dueSteps.ts:179` | `settings-mid-flight.test.ts:189`, `:197`, `:204`; `quiet-hours.test.ts:162` | T | verified |
| 56 | Turning the Reminder Task off lets existing tasks finish | `reminderTask.ts:141-174` (uses the row's board, not settings); `index.ts:74-76`; `wizard-turn-on.ts:63-69` (keeps the board's webhook) | `reminder-task.test.ts:257`; `tick.test.ts:154` | T | verified. A board **change** (not off) moves the `task_completed` webhook, so a tick on an old-board task is no longer noticed. The rerun preview says so (`wizard-rerun.test.ts:61`). |
| 57 | Alert after about an hour of failing sends, listing who | `src/cron/backoff.ts:12`, `failureAlerts.ts:132-145` | `test/worker/failure-alerts.test.ts:72`, `:84` | T | verified |
| 58 | Alert and pause on a rejected key | `client.ts:92`, `src/cron/blocks.ts:46-48`, `messages/failureAlert.ts:101-104` | `test/worker/blocks-and-alerts.test.ts:58` | T | verified |
| 59 | All clear listing sends skipped as over an hour late | `blocks.ts:106-145`, `failureAlerts.ts:116-129` | `blocks-and-alerts.test.ts:97`, `:129`, `:140` | T | verified |
| 60 | Alert when a setting points at something gone | `client.ts:147`, `:259`, `:276`; `failureAlert.ts:108-126` | `blocks-and-alerts.test.ts:153`, `:188`, `:246` | T | verified |
| 61 | Alert when clock-out webhooks seem lost | `failureAlerts.ts:165-173`, `store.ts:1193-1210` | `blocks-and-alerts.test.ts:287`, `:300`, `:319` | **D** | verified (read). See divergence 4: it counts sweep-found **segments** (`kind = 'segment'`), including stale edits of known records (`sweep.ts:139`), not Shifts. "Last delivery" is the latest of *any* webhook (form and task deliveries included). Tests use one segment per Shift, so they don't tell these apart. |
| 62 | Alert when over 80% of the daily allowance is used | `failureAlerts.ts:176-181` | `blocks-and-alerts.test.ts:331`, `:352` | T | verified |
| 63 | Each alert once per problem | `failureAlerts.ts:40`, `:93-113`; `store.ts:982` | `failure-alerts.test.ts:209`, `:240`, `:326` | T | verified |
| 64 | Leave room in the shared rate limit | `client.ts:59`, `:100-114`; `sweep.ts:23`, `:40-44` | `test/worker/overlap-and-rate-limit.test.ts:95`, `:123`, `:131`; `sweep.test.ts:183` | T | verified |
| 65 | Settings survive ordinary git use | `scripts/lib/deploy-config.ts`, `scripts/deploy-config.ts`; `wrangler.jsonc` template | `test/deploy-config.test.ts:66-238`; `test/dev-vars-example.test.ts` | T | verified |

## The integrator (69–71)

| # | Story | Code | Test | Class | Note |
|---|---|---|---|---|---|
| 69 | Run the wizard on a call | `setup-wizard.sh:444` (browser `wrangler login`), `:1143` ("on a call, the client") | none | U | verified (read). A process story: nothing in the code needs to differ for it. |
| 70 | Session log with keys redacted | `setup-wizard.sh:417-440` (`clean_log`), `:1308-1325` | none. Tests set `WIZARD_LOG=off` (`setup-wizard.test.ts:188`, `:212`) | U | verified (read). Redaction swaps every `.dev.vars` secret for `[redacted]` with `perl`; nothing tests it. |
| 71 | Installable on its own, no sibling imports | `src/connecteam/client.ts:1-6` (copied, with a note on where from); no `../../EH_Webhook` imports (grep) | none | U | verified (grep). No test guards against a future sibling import. |

## Stated defaults

| Default | Where | Test | Class |
|---|---|---|---|
| 30-minute Grace Period | `.dev.vars.example` (`GRACE_PERIOD_MINUTES=30`); wizard `s_grace` | `setup-wizard.test.ts:431` | T |
| 4-hour escalation delay | `.dev.vars.example` (`240`); wizard `s_delay` | `setup-wizard.test.ts:431` | T |
| Quiet Hours on, 9 pm to 7 am | `src/escalation/quietHours.ts:15`; wizard `s_quiet` default y | `test/quiet-hours.test.ts:11`; `setup-wizard.test.ts:453` | T |
| Reminder Task on | wizard `s_task` default y | `setup-wizard.test.ts:522` | T |
| Time zone from the time clock | wizard `s_timezone` | `setup-wizard.test.ts:319` | T |

In the Worker itself, a blank `QUIET_HOURS_ENABLED` or `REMINDER_TASK_ENABLED` reads as **off** (`src/env.ts:96-101`). That's safe only because the deploy check makes both required (`scripts/lib/deploy-config.ts:52`, `:55`), so a blank value can't reach a live Worker. Verified (read).

## Implementation Decisions checked against the code

| Decision | Finding | Class |
|---|---|---|
| Webhook: verify, store, 2xx, no Connecteam calls | `index.ts:29-115`; `basic-path.test.ts:26`, `:32` | T |
| De-duplicate on `requestId + eventType + userId + timeActivity.id` | The key is built exactly so (`timeActivity.ts:49`) and stored with `INSERT OR IGNORE` (`store.ts:1311-1315`), but **nothing skips a repeat delivery**: it's processed again, and is harmless only because every write is idempotent. `basic-path.test.ts:44` would pass with no de-dup at all. *Suspected* risk: a retried old `admin_edit` arriving after a newer edit overwrites the segment's times (`store.ts:263-267`, "saved as sent"). An exact-key skip would stop that for a true duplicate. | **D** (drift) |
| Ignore `user_*_request` | `timeActivity.ts:59-61`; `shift-endings.test.ts:70-89` | T |
| Leasing | `store.ts:468-486`; `overlap-and-rate-limit.test.ts:49`, `:56` | T |
| Sends at most once; stuck claim over 10 min → alert | `store.ts:114`, `:648-668`; `failure-alerts.test.ts:279`, `:308` | T |
| Rate etiquette: oldest first, stop under 20% or on 429 | `store.ts:472` (`ORDER BY due_at`), `client.ts:100-114`; `overlap-and-rate-limit.test.ts:95-131` | T |
| Client copied from EH_Webhook with a note; `schedulerShiftId` and `end` added | `client.ts:1-6`; `types.ts:42-49` | U (no test needed) |
| "Did they submit?" is one call with `limit=1` | `client.ts:162-178` sends `limit=100`; `check.ts:29-41` calls once **per accepted form** and puts each result through crediting. Deliberate (PR #46: `findFormSubmission(limit=1)` → `listFormSubmissions(limit=100)`), so a submission already credited elsewhere doesn't hide this Shift's own. After a form switch, a check costs 2 calls. | **D** (post-Spec decision) |
| Crediting order 1 → 2 → 3, date fallback | `choose.ts:34-55`; `crediting.test.ts:48-115` | T |
| Scheduled Shift: id only, each non-archived scheduler, `:` → V1 | `src/escalation/scheduledShift.ts:17-32`; `open-past-end.test.ts:198`, `:215` | T |
| Sweep: yesterday and today, one call per clock, at most 20% of the day | `sweep.ts:40-44`, `:83-91`; `sweep.test.ts:157-205` | T |
| Recipients: `manager`/`owner`, minus Excluded, plus direct manager by field type | `recipients.ts:14-57`; `test/escalation.test.ts:82-128` | T |
| Reminder Task: 7-day delete, hourly re-check after the Escalation | `store.ts:71`, `:74`, `:91-97`; `reminder-task.test.ts:177`, `:210` | T |
| Failure backoff 1, 2, 4, 8, 16, 32 min | `backoff.ts:12`; `failure-alerts.test.ts:72` | T |
| Teardown: delete the Worker, then D1 | RUNBOOK plus `test/runbook-teardown.test.ts:44`, which also removes the Connecteam webhooks first (`:67`) | T (plus extra) |
| Wizard: 17 stages in the Spec's order; the 11 `--step` names | `setup-wizard.sh:221`, `:1344-1358`; `setup-wizard.test.ts:243`, `:256` | T |

## Spec gaps the code had to fill

- **`clock_in` isn't in the Spec's event list** ("Events: `clock_out`, `auto_clock_out`, `admin_add`, …"), but an open Shift can only be known through it. The code handles it (`timeActivity.ts:37`) and subscribes to it (`wizard-turn-on.ts:26`). Stories 5, 6, 30 and 31 depend on this. Verified (read). The Spec should list it.
- **What a skipped Reminder does to the Escalation.** When a Reminder is given up on (it failed for an hour, or was skipped after a block), the Shift still escalates on its original schedule, and the Escalation says `Reminded: not confirmed (sending failed)` (`escalation.ts:30-32`; `failure-alerts.test.ts:126`). The Spec doesn't say what happens here. It's a reasonable reading, but not one the Spec states.

## Behaviour the Spec never asked for

All verified (read), each with a test unless marked otherwise:

- **A sweep-failing alert,** "ALERT · CLOCK-OUT CHECK FAILING": the sweep's reads have failed for about an hour (`failureAlerts.ts:147-159`; `failure-alerts.test.ts:336`).
- **Blocks for a gone form, publisher or board pause the steps that need them,** as well as alerting (`blocks.ts:22-29`). The Spec asks only for an alert, and pauses only for a 401. The "skip if more than an hour overdue" rule also applies to these blocks, not only the key (`blocks.ts:31-37`; `blocks-and-alerts.test.ts:188`).
- **A rejected key and a gone form are re-checked every 15 minutes,** and lift on their own if they're fixed (`blocks.ts:43`, `:82-88`; `blocks-and-alerts.test.ts:177`).
- **When a board block lifts, uncreated tasks move to the new board** (`blocks.ts:95-96`; `blocks-and-alerts.test.ts:246`).
- **The employee is never an Escalation recipient,** and archived Admins are left out (`recipients.ts:18`, `:56`; `test/escalation.test.ts:82`, `:103`).
- **Escalation Summary lines carry " · reminder not confirmed" and " · ticked the task"** (`messages/escalation.ts:60-63`; `test/quiet-hours.test.ts:77`).
- **The Escalation still names an employee archived since the Shift** (`escalate.ts:96-102`; `escalation.test.ts:181`).
- **A Reminder Task create that got no answer keeps its claim,** so it's never created twice; once stuck, it's listed as unconfirmed (`reminderTask.ts:126-133`; `failure-alerts.test.ts:308`).
- **The webhook answers 500 when settings are incomplete** (`index.ts:55-58`, `:91-94`), so Connecteam retries it. Untested. *Suspected:* harmless, but Connecteam gives only 3 retries.
- **`admin_declined_*` events are ignored,** along with `user_*_request` (`timeActivity.ts:34-36`).
- **A form edit (`form_submission` edit events) is ignored** (`formSubmission.ts:28`; `worker/crediting.test.ts:128`).
- **Wizard extras:** a channel created in the wizard gets the ticked Admins as members (`setup-wizard.test.ts:610`); a saved exclusion for someone no longer an Admin is dropped (`:513`); forms with a total cap or a closing date are flagged (`wizard-forms.test.ts:45`); Ctrl-C during a rerun puts `.dev.vars` back (`setup-wizard.test.ts:919`).

## Post-Spec decisions or drift

| Divergence | Source | Kind |
|---|---|---|
| Submission check: `limit=100`, one call per form | PR #46 body | Post-Spec build decision; Spec not amended |
| Ticked note after any tick | PR #49 body ("`# any tick`") | Post-Spec build decision; Spec not amended |
| Test message defaults to the sole owner | PR #64 body | Post-Spec build decision, forced by the API; Spec not amended |
| Lost-webhook alert counts segments, and any delivery | none found | Drift |
| De-dup key recorded, never used to skip | none found | Drift (behaviourally covered by idempotence) |
| Relay removed, Quiet Hours fixed at 9 pm to 7 am | PR #67; Spec "Decided after the build (2026-10-26)" | Already in the Spec, so not a divergence. Leftovers: the stale comment `scripts/lib/wizard-people.ts:4` and the unused `failure_alerts.relayed` column (kept deliberately, PR #67). |
| `--support` / `--step support` (Spec comment, 2026-10-24) | Superseded by #67 | Gone, as #67 intends; the comment on #19 is out of date |

Minor wording drift: the test titles in `test/setup-wizard.test.ts:690` and `:767` still say "steps 16 to 18" and "step 18", while the wizard and its own assertion (`:704`, "Stage 17/17") have 17 stages. Verified.

## Not covered here

- The "Check at build" live items in the Spec, and whether the fake Connecteam matches the real one (#73).
- Whether the tests are TDD-shaped, for example de-dup passing by accident (#72).
- Practices and playbook conformance (#71).
