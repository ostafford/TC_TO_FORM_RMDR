# Is the test suite set up the TDD way?

Research for #72 (map #69). Yardstick: the `tdd` skill (tests at agreed seams, behaviour through public interfaces, mock only at system boundaries, no implementation-coupled or tautological tests). Contract: the Spec, #19, especially its **Testing Decisions** section. Read against `main` at `8bfc08a` on 2026-11-17.

Each claim is labelled **verified** (I ran it or read the code) or **suspected** (inferred, not proven).

## Headline

- **`npm test` passes and `npm run typecheck` is clean** (verified). 32 files and 479 tests passed in 107.6 s.
- **The suite is mostly what the Spec asked for** (verified). The worker tests drive the Worker as a black box: signed webhooks go in, `scheduled` runs at an injected clock, and a fake Connecteam answers. They assert on DMs, channel posts and Connecteam calls, and every Spec testing scenario has at least one worker test.
- **The weak spots are few and small.** Two tests read D1 or the store directly. Some pure-function tests sit below the agreed seam. A few paths have no test at any seam: incomplete settings, the deploy script's live-database refusals, the session-log redaction, and the dedupe key's shape. The fake Connecteam doesn't record request headers. **Nothing runs the integration test**, and there is no CI.

## 1. Real results (verified)

```
$ npm test
> vitest run --project node --project worker
 Test Files  32 passed (32)
      Tests  479 passed (479)
   Duration  107.55s (transform 1.33s, setup 3.13s, import 1.61s, tests 124.36s, environment 2ms)

$ npm run typecheck
> tsc -p tsconfig.json && tsc -p tsconfig.worker.json
(no output, exit 0)
```

There were no failures and no skips. I didn't measure coverage, because installing a coverage provider was refused in this session. Section 4 therefore checks what tests reach by reading the code, not with a coverage report.

## 2. `test:integration`: what it needs, and whether anything runs it (verified)

- **What it is.** `npm run test:integration` runs `vitest run --project integration`, which is only `test/connecteam-client.integration.test.ts`. That file holds 3 read-only checks through the real `ConnecteamClient`: `getForm`, a `listFormSubmissions` with an impossible user id, and `listActiveUsers` with at least one Admin (`vitest.config.ts`, the test file).
- **What it needs.** `test/setup.env.ts` loads the project's own git-ignored `.dev.vars`. The checks self-skip unless `CT_API_KEY` and a positive integer `COMPLIANCE_FORM_ID` are both set. `CT_PUBLISHER_ID` is read but optional. The file warns never to copy the research key from `~/IDP/.research.env`, which matches the playbook. This worktree has no `.dev.vars`, so here it would skip.
- **Who runs it: nobody automatically.** The repo has no `.github/` directory and no hooks (husky, lefthook or pre-commit). `git ls-files` finds no workflow. `npm test` leaves the integration project out on purpose. `npm run test:all` (plain `vitest run`) would include it. RUNBOOK line 65 tells a person to run `npm run typecheck && npm test` by hand. **No CI runs even the unit and worker suites**, so a red `main` would only show up on someone's laptop.
- **It doesn't do the job the Spec gives it.** The Spec makes the live tests "the home for the 'Check at build' items". None of the roughly 30 Check-at-build items is a test here. For example, whether both submission-window bounds are inclusive, what a blank `directManager` value looks like, and the real `userType` values are not tested. Whether those were settled by the `research/*` branches instead belongs to the fake-versus-reality ticket. For this ticket it's a gap: those assumptions live only in `fake-connecteam.ts`.

## 3. Seams: what the tests drive

### The Worker as a black box (the main agreed seam): done well (verified)

- `test/worker/harness.ts` builds the real Worker with `createWorker({ fetchImpl: ct.fetch, now })`. The only things replaced are the network (`fetchImpl`) and the clock (`now`, plus `scheduledTime`), which are the two system boundaries `mocking.md` allows. D1 is real local D1 with the migrations applied (`apply-migrations.ts`).
- `webhook()` POSTs a real `Request` with the `x-webhook-secret` header to `fetch`. `tick()` calls `scheduled` with `createScheduledController`. `configure()` changes settings the way a rerun step and redeploy do.
- The payload builders (`timeActivity`, `manualBreak`, `deletion`, `taskCompleted`, `formSubmission`) are written in the shapes recorded live (#2, #23, #28). Two are faithful down to Connecteam's quirks: `task_completed` has an array `data` and the `evnetTimestamp` typo.
- Every worker test file except two (see 5.1) imports only the harness and the fake. Assertions are on `ct.dms`, `ct.posts`, `ct.tasks` and `ct.calls`, which is exactly what the Spec's Testing Decisions ask for: "what an employee, an Admin or the Alerts Channel would see, and … which Connecteam calls were made."
- The tests use no `vi.fn`, `vi.mock` or `toHaveBeenCalled` anywhere. The only spy is on `console.log` in `sweep.test.ts` (see 5.3).

### The fake Connecteam: done well, with one blind spot

- It throws on any unmatched route (`fake Connecteam: unmatched …`), so a new or misspelt call fails loudly instead of answering 200 (verified).
- It keeps the sweep's reads in `sweepCalls`, apart from `calls`, so `expect(h.ct.calls).toEqual([])` still means "nothing was done about a Shift" (verified).
- Its failure scripts (`failNext`, `failAll`, `rejectKey`, `stallNext`, `duringDm`, `deletePublisher`, `deleteBoard`) cover the 429, 5xx, timeout, 401, 404 and mid-call-death cases the Spec lists (verified).
- **Blind spot: it ignores request headers.** `RecordedCall` has `method`, `path`, `query` and `body`, but no headers. If the client stopped sending `X-API-KEY` (`src/connecteam/client.ts:86`), or sent the wrong key, every worker test would still pass (verified). The wizard's fake, by contrast, records `seenKeys`.
- Whether the fake's answers match the real API (inclusive bounds, paging, the 200 for a `PUT` on a deleted task) is for the fake-versus-reality ticket, not judged here.

### The Bash wizard: really exercised (verified)

`test/setup-wizard.test.ts` (59 tests) runs the real `scripts/setup-wizard.sh` with `spawn("bash", …)` and typed stdin. It points the script at a local HTTP fake Connecteam (`CT_API_BASE`) and a fake `wrangler` shell script (`WRANGLER_CMD`). So the Bash, `scripts/wizard-helper.ts`, `scripts/check-api-key.ts` and the `scripts/deploy-config.ts` CLI all run for real, as a person would run them. One test drives a whole first run and checks:
- every summary line;
- `d1 create`, then the migrations with the built config;
- the deploy before `secret put`;
- the three webhook subscriptions, leaving another integration's alone;
- the real test Reminder, word for word;
- a rerun that reuses the database and secret and does PUTs, not POSTs.

What it can't reach, or doesn't check, is listed in 6.3.

### Pure-function seams

- **Message wording** (`message-wording`, `escalation`'s wording half, `failure-alert-wording`, `quiet-hours`'s summary half) is an agreed supporting seam. Its expected values are known-good literals, so the tests aren't tautological (verified).
- **Deploy config** (`deploy-config`, `dev-vars-example`, `runbook-teardown`) is an agreed supporting seam, and the tests follow the playbook (verified).
- **Wizard libraries** (`wizard-forms`, `-people`, `-rerun`, `-turn-on`, `-values`, `api-allowance`): every module in `scripts/lib/` has a test file. #72 names "wizard helpers" as a boundary, so these count as their own seam (verified).
- **Below the agreed seam:** `crediting.test.ts` (`src/crediting/choose.ts`), the recipients half of `escalation.test.ts` (`src/escalation/recipients.ts`), `quiet-hours.test.ts` (`isQuiet`, `quietEnds`, `inWindow`), `http-json.test.ts` and `test/worker/settings.test.ts` (`readSettings`). See 5.2.

## 4. Modules no test reaches

- **`src/`:** every module is reachable through `src/index.ts`, which the harness drives, so none is entirely unreached (verified, from the import graph). `src/connecteam/client.ts` has no unit test of its own, although the Spec's prior-art list mentions "the ConnecteamClient unit … tests". It is exercised only through the worker tests and the unrun integration test (verified). Its outcome classification (429 and 5xx are `retryable`, a dropped connection too, 401 and 404 are `error`) is pinned only indirectly, through the behaviour it drives. That's acceptable at the black-box seam.
- **`scripts/lib/`:** all 7 modules have direct tests (verified).
- **`scripts/*.ts` CLIs:** reached only through the wizard test (verified). The `--check-live` branches in `scripts/deploy-config.ts` are mostly not reached. See 6.2.
- **Untested branches in reachable modules** are listed in section 6, with the behaviour each leaves unpinned.

## 5. Tests coupled to implementation

### 5.1 Side channels into D1 or the store

1. **`test/worker/shift-endings.test.ts:99`, "is stored as too late, with nothing due"** runs `SELECT status, due_at FROM shifts` and asserts `{ status: "too_late", due_at: null }` (verified). That is the anti-pattern the Spec names ("doesn't reach into D1 rows"). Renaming the column or the status would break it with behaviour unchanged. The behaviour is already pinned by the test above it ("is never checked: no Reminder, then or later") and by `crediting.test.ts:109` ("never credits a Shift … back-filled too late"). **Suggested ruling:** delete it, or restate it through the interface, e.g. "a submission for it is credited nowhere and the sweep doesn't revive it".
2. **`test/worker/store-crediting.test.ts`** (3 tests) builds a `WorkList` on `env.DB` and calls `recordSegment`, `credit`, `creditedTo` and `creditSubmission` directly (verified). It pins US 15 ("one submission counts for one Shift only") at the store's API, below the Worker. The black-box file `crediting.test.ts` already has 5 tests under "one submission counts for one Shift only", including the race cases (`:94`, `:184`). **Suspected:** the store test is redundant at the agreed seam and would break under a store refactor. The comment at its head says it guards "whatever chooses the Shift". That's a real defence-in-depth concern, so a ruling should keep it only if no black-box race reaches that guard.

### 5.2 Pure tests below the agreed seam (refactor-fragile, mostly duplicated)

None of these is wrong; they're fast and readable. But the Spec agreed only two supporting seams (wording and deploy config), and these pin internal function signatures whose behaviour the worker tests already pin:

| Test file | Internal it calls | Black-box equivalent |
|---|---|---|
| `test/crediting.test.ts` (15) | `chooseShift`, `answeredDate` | `worker/crediting.test.ts` "the Shift Date Question", "one submission…" |
| `test/escalation.test.ts`, recipients half (9) | `escalationRecipients`, `directManagerId` | `worker/escalation.test.ts` "recipients, read live at send time" |
| `test/quiet-hours.test.ts`, `isQuiet`/`quietEnds` (6) | `isQuiet`, `quietEnds`, `inWindow` | `worker/quiet-hours.test.ts` incl. daylight saving |
| `test/worker/settings.test.ts` (7) | `readSettings` | none (see 6.1) |

(Counts verified. "Duplicated" is suspected: I matched test names, not every case.) A few cases exist only at the unit level. Examples: "is never read from a field of another type, even one named Direct manager", "never include the employee themselves", and the Shift Date Question's zone fallbacks. If the unit files are ever dropped, those cases should move to the black box first.

**Leftover from #67 (verified):** `quiet-hours.test.ts` "stays within one day when from is before until" and "is never quiet with equal ends" test a configurable window (`{from: 60, until: 360}`, `{420, 420}`). Since #67 the window is fixed: production passes only `QUIET_HOURS` (`src/cron/escalate.ts:44`, `scripts/lib/wizard-values.ts:110`). These tests pin flexibility no user story needs.

### 5.3 Asserting on log shape

`test/worker/sweep.test.ts` spies on `console.log` and sums `sweep.found` from the cron's JSON log line (`:36`, `:62`) (verified). The log is an operator-facing output, so this isn't a mock of a collaborator. But it couples the sweep tests to the log's field names, and the user-visible behaviour ("clock-outs not arriving" after 3 misses, US 61) is already tested in `blocks-and-alerts.test.ts:287`. **Suspected:** acceptable, but fragile.

### 5.4 Limits read from the code under test

Most wording tests assert `length <= MAX_MESSAGE`, importing `MAX_MESSAGE` from `src/messages/format.ts` (verified). If someone raised it to 1,000, those tests would still pass. Only the Escalation Summary tests pin the literal `500` (`quiet-hours.test.ts:97`, `worker/quiet-hours.test.ts:136`). It's a mild tautology. A single `expect(MAX_MESSAGE).toBe(500)`, or the literal in each assertion, would tie them to the Spec.

### Calls asserted at the Connecteam boundary: fine

Many tests assert exact queries and counts on `ct.calls`: the one `form-submissions` check with its bounds, "lists the schedulers once…", "one call a minute while paused". These are calls across the system boundary, the Spec explicitly allows them, and API budget is itself a requirement (US 64, ADR-0002). They aren't implementation coupling in the `tdd` sense.

One Spec conflict for the Spec-versus-code ticket (verified): the Spec says the check uses `limit=1`, but `basic-path.test.ts:62` pins `limit: "100"` (`SUBMISSIONS_PAGE`, `src/connecteam/client.ts:170`). It's probably deliberate (crediting needs more than the first row), but the Spec wasn't amended.

## 6. Weak or missing tests, by the behaviour left unpinned

Ranked roughly by risk. Each item is a candidate red-green fix issue.

### 6.1 The Worker

1. **Webhook with incomplete settings returns 500 and records nothing** (verified untested). `src/index.ts` returns `500 "settings incomplete"` on each of the three paths, and `500 "webhook secret not configured"` when `CT_WEBHOOK_SECRET` is blank. No test sends a webhook with a setting missing. This leaves unpinned the half of US 65 that matters at runtime: a deploy with blank values must fail loudly. Connecteam sees a non-2xx, and nothing quietly does nothing. The same parsing is tested only through `readSettings` (5.2).
2. **Cron with incomplete settings skips and calls nothing** (verified untested). `scheduled` logs `skipped: "settings incomplete"` and returns. No test pins that it makes no Connecteam calls and sends no Failure Alert. Whether it *should* alert is a Spec question (an alert needs an Alerts Channel id, which may be the missing value).
3. **The dedupe key is more than `requestId`** (verified untested). The Spec requires de-duplication on `requestId + eventType + userId + timeActivity.id` "because `requestId` alone isn't unique". The harness gives every payload a fresh `requestId` (`req-${++requests}`), and no test sends two different deliveries that share one. A regression to dedupe on `requestId` alone would silently drop a real clock-out (US 1, US 29), and every test would still pass. The same applies to the form and task keys (`src/webhook/formSubmission.ts:26`, `task.ts:27`).
4. **Non-`POST /webhook` returns 404** (verified untested). This is low risk.
5. **The API key header is sent** (verified unpinned; see "The fake Connecteam" in section 3). The fake doesn't record headers, so US 58's precondition, that the Worker authenticates at all, rests only on the unrun integration test.

### 6.2 The deploy script

6. **`--check-live` refuses a database that isn't on the logged-in account** (verified untested). This check lives in the CLI `scripts/deploy-config.ts`, not in `scripts/lib`, so no unit test reaches it. The wizard's fake `wrangler` always lists the database it created, so the refusal never runs. The playbook and Spec require it (US 65, "the database on the logged-in account").
7. **`--check-live` refuses pointing the live Worker at a different database, unless `--allow-database-change` is passed** (verified untested end to end). `compareWithLive` is unit-tested ("flags a different database"), but the CLI's `stop(...)`, its exit code 1, the removal of the built config ("must not be left lying around"), and the override flag are not. The wizard's fake `wrangler` always answers "Worker does not exist", and it has no `versions view` (the call would exit 9). This means the "same database as the live Worker" check never runs under test (US 65).
8. **A changed or removed live setting is listed before the deploy.** This is only partly pinned: `compareWithLive` is tested, the CLI's printing of it isn't, and the wizard's rerun preview depends on it (US 52).

### 6.3 The wizard

9. **The session log is saved with keys redacted** (US 70; verified untested). Every wizard test sets `WIZARD_LOG=off`. The `script` recording and `clean_log`'s perl redaction run only with a real TTY (`scripts/setup-wizard.sh:1309`). Nothing pins that an API key or webhook secret pasted during setup comes out as `[redacted]`. It's the one security-relevant wizard behaviour with no test. `clean_log` can be called on a file without a TTY, so a test can reach it.
10. **The Shift Entry tip stage** (US 46; verified unasserted). The first-run input answers it with Enter, but no assertion checks what it says. Recent commits (`8a836ff`, "say what the Shift Entry tip does and doesn't do") changed that wording with no test to hold it.
11. **"No" to Workers Paid stops the wizard** (US 49; verified untested). The only Cloudflare-step test answers yes, then no to the account. The Paid refusal itself isn't driven.
12. **Stale stage numbers in test names** (verified). The describes are named "steps 16 to 18" and "step 18 on its own", and comments read "// 16:", "// 17:", "// 18:". The wizard has 17 stages since #67, and the same test asserts `Stage 17/17 · Test message`. Only the names are wrong; the behaviour is right. Fixing them is cosmetic, but they mislead a reader mapping tests to stages.

### 6.4 The integration project

13. **No Check-at-build item is a live test**, and nothing runs the 3 that exist (section 2). Every fake-Connecteam assumption is pinned only against itself.

### 6.5 Small

14. `test/escalation.test.ts:7` says "Mon 20 Oct 2026", but 20 Oct 2026 is a Tuesday, as the assertion itself expects (verified). The comment is stale; the assertion is right.

## 7. What's done well

- **The suite matches the Spec's Testing Decisions closely.** I checked each scenario bullet against the test names, and every one has a worker test. That includes:
  - the break joins, open past the planned end, and the break variant;
  - the escalation recipients (Excluded, direct manager, de-duplicated);
  - the Quiet Hours summary split;
  - the crediting order and one submission per Shift;
  - the tick twice;
  - the 7-day delete and the hourly re-check;
  - back-fill, edits, geofence recreate and delete;
  - the sweep;
  - form switches and timings mid-flight;
  - backoff, stuck claims, 401 pause and all clear with the skipped list, 404 settings, the lost webhook, the 80% allowance, and once per condition;
  - oldest first, under 20%, 429, and leases.
- **Test names read as a specification** in the domain's language, e.g. "a Shift still clocked in past its planned end is treated as ending then: the 'still clocked in' Reminder comes a Grace Period later". They follow `GLOSSARY.md` terms throughout.
- **Mocking is limited to system boundaries:** the network, the clock and wrangler. D1 is real.
- **Expected values are independent literals.** Message tests spell out the whole text, and timestamps are built from wall-clock dates, not recomputed the way the code does.
- **Concurrency is tested properly.** `stallNext` and `duringDm` reproduce a run dying mid-call and a webhook racing a send, which is where at-most-once sends break in practice.
- **The wizard test runs the real Bash** against fake HTTP and a fake `wrangler`. That's unusual and worth keeping.
- **Playbook guards are tests:** `.dev.vars.example` matches the settings, the template has a non-UUID database id, every deploy path uses the built config, and the teardown order matches `wrangler.jsonc`.
- **Typecheck covers both the Node and Worker configs.**

## Sources

All from this repo at `8bfc08a`: `package.json`, `vitest.config.ts`, `test/**` (especially `test/worker/harness.ts`, `test/worker/fake-connecteam.ts`, `test/setup-wizard.test.ts`), `src/index.ts`, `src/connecteam/client.ts`, `src/escalation/quietHours.ts`, `src/webhook/*.ts`, `scripts/deploy-config.ts`, `scripts/setup-wizard.sh`, `.gitignore`, `docs/RUNBOOK.md`. Spec: issue #19 (Testing Decisions, Check at build, Further Notes on #67). Yardstick: the `tdd` skill (`SKILL.md`, `tests.md`, `mocking.md`). Command output: `npm test` and `npm run typecheck`, run 2026-11-17.
