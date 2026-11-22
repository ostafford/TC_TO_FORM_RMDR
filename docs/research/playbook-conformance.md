# Are the playbook and the repo's own conventions actually followed?

Research for [#71](https://github.com/ostafford/TC_TO_FORM_RMDR/issues/71) (map [#69](https://github.com/ostafford/TC_TO_FORM_RMDR/issues/69)). Done 2026-11-17 against `main` at `8bfc08a`. Sources: the playbook `../CLAUDE.md`, this repo's `CLAUDE.md`, `GLOSSARY.md`, `docs/adr/0001`, `docs/adr/0002`, `docs/RUNBOOK.md`, and the code, config and scripts they describe. The one outside source is Cloudflare's [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) page (read 2026-11-17). Nothing was deployed, no live API calls were made, and the test suite was not run (no `node_modules` in this checkout).

**Labels.** *Verified* means I read the code path end to end and the claim follows from it. *Suspected* means it depends on something I couldn't check here (a Connecteam behaviour, a real account's size, or a branch no test pins). Line numbers are as of `8bfc08a`.

## Answer

**Mostly yes.** Every playbook gotcha that fits this shape is followed in code, and most of them are pinned by tests. Every Connecteam send's `outcome` is checked before any "done" state is written. Deployment values live in the git-ignored `.dev.vars`, behind a non-UUID placeholder. Every remote command goes through the built config. The teardown order is right, and a test keeps it matched to `wrangler.jsonc`. The gaps are narrower:

1. **A send that times out is released and retried**, so a DM Connecteam actually delivered can go out twice. ADR-0002 says "sends are at most once". The Reminder Task create already guards against exactly this; the DMs and channel posts don't. (Conflict, verified in code; whether Connecteam delivers on a timeout is suspected.)
2. **Missing secrets deploy cleanly and then do nothing.** The deploy check never looks at `CT_API_KEY` or `CT_WEBHOOK_SECRET`. With either missing, the cron returns early and only logs, and the webhook answers 500. No Failure Alert is raised. This is the playbook's "deploys cleanly and then quietly does nothing" failure, one layer down. (Gap, verified.)
3. **The RUNBOOK's manual first deploy runs `secret put` before `deploy`.** The RUNBOOK's own next paragraph says that order makes Wrangler stop and ask. (Conflict, verified.)
4. **The GLOSSARY says a Failure Alert is "sent once per problem"**, but a condition still raised after 24 hours is claimed and posted again. (Conflict, verified by reading the SQL; no test pins either behaviour.)
5. Smaller items: `backup.sql` isn't git-ignored, nothing tells clients to back up `.dev.vars`, several inner loops ignore the "stopped for the minute" flag, and the subrequest budget for one Escalation Summary run grows with the number of Admins.

## Playbook gotchas: what applies

From ADR-0002, the shape is one write-heavy Worker on the Paid plan. A D1 work list replaces a Queue, and a one-minute cron does the due steps. `fetch` handles only webhooks and makes no Connecteam calls (`src/index.ts:1-3`).

| Playbook gotcha | Applies? | Status |
|---|---|---|
| Split into light and write-heavy pieces | Yes, within one Worker | Followed: `fetch` makes 0 outbound calls, and the cron does all the writes (`src/index.ts:29-115`). |
| Subrequest cap, Paid plan | Yes | Followed. The wizard confirms the Paid plan (`scripts/setup-wizard.sh:448-457`), and the RUNBOOK requires it (`docs/RUNBOOK.md:69`). See S1 for the per-run budget. |
| Same-zone `fetch()` 404, `global_fetch_strictly_public` | No | N/A: the Worker calls only `api.connecteam.com`. The relay that would have needed it was removed (#67). |
| `max_retries: 0` / retry backoff / dead-letter queue | No queue | N/A as written. Its intent (no duplicate writes on a re-run, surface failures to a human) is met by leases, send claims, backoff and Failure Alerts (ADR-0002). See C1 for one hole. |
| Teardown: detach queue consumers first | Partly (no queues) | Followed (T1). |
| Deployment values git-ignored, blank template, non-UUID placeholder | Yes | Followed (D1–D3). |
| Per-client data files | Barely | No field map or similar file exists, so it is mostly N/A. The backup advice is missing (P1). |
| Remote D1 / `secret put` through the built config | Yes | Followed (D4). |
| Check every send's `outcome` | Yes | Followed at every call site (O1). See C1 for what happens on a timeout. |
| Deploy button / monorepo workspace dependency | No | N/A: no workspace dependencies, and `main` is `src/index.ts`. The Deploy button was ruled out ([deploy-button.md](deploy-button.md)). |
| Research key never in `.dev.vars` | Yes | Followed: `.dev.vars.example:9` says so. |

## Correctly followed

**O1. Every Connecteam send checks `outcome` before writing "done" (verified).** I found every send call site with `grep -n "sendDirectMessage|sendChannelMessage|createTask|completeTask|reopenTask|deleteTask"` across `src/` and `scripts/`. Each one claims in D1, sends, then marks done only when the send returns `ok`, and releases the claim otherwise:

- Reminder: `src/cron/dueSteps.ts:159` claims, `:185` sends, `:186-189` releases and retries on any non-ok answer, and `:190` runs `markReminded` (marking the claim done in the same batch, `src/store.ts:680-688`) only after an `ok`.
- Escalation, per recipient: `src/cron/escalate.ts:131-138` claims, `:68` sends, and `settle` (`:141-156`) marks done only on `ok` and releases otherwise.
- Escalation Summary: `src/cron/summary.ts:53-65` claims each (Shift, recipient) pair, and `settle` handles each claim the same way.
- Tick DM: `src/cron/reminderTask.ts:214` claims, `:227-232` sends, then releases or marks done.
- Reminder Task create (not idempotent): `src/cron/reminderTask.ts:107` claims, `:124` creates, `:137` stores the id and marks the claim done in one batch (`src/store.ts:795-811`). A create that got no answer keeps its claim, so the task is never created twice (`:126-132`).
- Complete, reopen and delete task are safe to repeat (full-replace `PUT`, or `DELETE` where a 404 counts as gone). Each checks `outcome` before calling `finishTask` (`:169-173`, `:204-212`, `:254-258`).
- Failure Alerts: `src/cron/failureAlerts.ts:184-201` returns `true` only on `ok`. `alertPosted` and `allClearPosted` run only then. Otherwise `raiseQuietly` or `releaseAllClear` runs and the next run retries (`:103-106`, `:124-128`).
- Wizard test message: `scripts/wizard-helper.ts:341-350` treats any non-2xx as a failure.
- The client keeps the result-object contract and says so at its head (`src/connecteam/client.ts:1-7`).

**D1. Deployment values are git-ignored (verified).** `.gitignore` ignores `.dev.vars`, `.dev.vars.*` (except the example) and `wrangler.deploy.json`. `wrangler.jsonc:9-15` says the template must stay blank, and every var in it is `""`.

**D2. Non-UUID placeholder (verified).** `wrangler.jsonc:46` is `"set-D1_DATABASE_ID-in-.dev.vars"`, matching `DATABASE_ID_PLACEHOLDER` (`scripts/lib/deploy-config.ts:26`). `checkSettings` rejects that placeholder as a value (`:93`).

**D3. A checking deploy script (verified).** `npm run deploy` and `npm run db:migrate` both run `deploy-config.ts --check-live` first (`package.json` scripts). The check covers each required value (present and in the right form), the database on the logged-in account, and the live Worker's database (`scripts/deploy-config.ts:93-148`). It deletes a config that failed a check, so the file can't be deployed by hand (`:39-45`). `test/deploy-config.test.ts:215-221` pins the deploy script and checks that the RUNBOOK has no bare `npx wrangler deploy`.

**D4. Remote commands use the built config (verified).** In the wizard: `secret put` (`scripts/setup-wizard.sh:947`), `d1 migrations apply` (`:967`), `deploy` (`:976`) and `d1 execute` (`:1204`) all pass `--config "$DEPLOY_CONFIG"`. In the RUNBOOK: `secret put` (`:61-62`, `:135`) and `d1 export` (`:141`, `:164`) pass `--config wrangler.deploy.json`. `wrangler delete <name>` and `d1 delete <name>` take names, so they need no config.

**T1. Teardown order (verified).** The RUNBOOK deletes the webhooks, then the Worker, then D1 (`docs/RUNBOOK.md:167-192`), and says there are no queues to detach (`:156-157`). `test/runbook-teardown.test.ts` reads `wrangler.jsonc` and fails if a database or queue consumer is added without a matching teardown step.

**A1. ADR-0002's mechanics are in the code (verified).** Each run leases its rows (`LEASE_SECONDS` = 5 min, `src/store.ts:59`, `:468-486`), oldest due first (`ORDER BY due_at`, `:471`). A claim counts as stuck after 10 minutes and is given up on, never retried (`STUCK_CLAIM_SECONDS`, `:114`, `:661-668`; `dueSteps.ts:167`; `escalate.ts:135`; `reminderTask.ts:111`, `:196`). The run stops for the minute below 20% headroom or on a 429 (`client.ts:59`, `:110-114`). There is no queue in `wrangler.jsonc`, and the cron is `* * * * *` (`:51`).

**A2. ADR-0001 (verified, briefly).** Manual-break deliveries are recorded and the Shift's end is decided again after each one (`src/index.ts:100-107`, `store.recordBreak` / `deleteBreak`). GLOSSARY "Shift" and "Shift Segment" match.

**G1. Several GLOSSARY claims match the code (verified):**

- Quiet Hours are fixed at 9 pm to 7 am (`src/escalation/quietHours.ts:15`), with only an on/off setting.
- Failure Alerts are never held and go to the channel only (`failureAlerts.ts:2-4`).
- The Reminder Task is removed after 7 days (`TASK_LIFETIME_SECONDS`, `store.ts:74`), and only a credited submission closes it (`reminderTask.ts:16-17`, `:152-173`).
- The 24-hour backfill cutoff is in place (`BACKFILL_CUTOFF_SECONDS`, `store.ts:187`).

**R1. The RUNBOOK's wizard order matches the wizard (verified).** `docs/RUNBOOK.md:72-77` and `scripts/setup-wizard.sh:1050-1088` agree on the order: keep the secret, reuse or create the database, `check_config`, migrate, deploy, secrets, webhooks.

## Findings

### C1. A timed-out DM is retried, so it can go out twice (conflict with ADR-0002)

- **Where:** `src/http/json.ts:47-48` and `:67-71` turn a timeout or dropped connection into `retryable` with `status: null`. Four call sites then release the claim and retry:
  - `src/cron/dueSteps.ts:186-189` (Reminder)
  - `src/cron/escalate.ts:152` (Escalation and Summary, via `settle`)
  - `src/cron/reminderTask.ts:228-231` (tick DM)
  - `src/cron/failureAlerts.ts:105`, `:128` (alert and all clear posts)
- **Conflict:** ADR-0002 says "Sends are at most once. If the Worker dies between a claim and its send, the message is lost, not duplicated." A timeout after Connecteam accepted the `POST` is the same unknown as a dead run, but the code treats it as a clean failure and sends again on the next try. The code already recognises the case for task creation: `reminderTask.ts:126-132` keeps the claim when `status === null` because "Connecteam may have saved it". The DM paths don't make the same distinction.
- **Status:** The code path is verified. Whether Connecteam delivers a chat message whose response never arrived is suspected (not tested live). I found no test of a DM timing out mid-send. `fake-connecteam.ts:13` can drop a connection, but I saw no test asserting what happens to the DM in that case.
- **To rule on:** accept the duplicate risk and amend ADR-0002's wording, or treat `status: null` on a send as unconfirmed (keep the claim and let it go stuck), as `createTask` does.

### C2. Missing secrets deploy cleanly and then nothing happens (gap)

- **Where:**
  - `scripts/lib/deploy-config.ts:45-46` lists `CT_API_KEY` and `CT_WEBHOOK_SECRET` as `required: false`, and the deploy check never looks at the Worker's secrets.
  - `src/index.ts:117-122`: with any setting missing (secrets included, `src/env.ts:82-83`), `scheduled` logs `skipped: "settings incomplete"` and returns.
  - `src/index.ts:35`, `:54-58`, `:90-94`: the webhook answers 500.
- **Conflict:** The playbook's rule ("deploys cleanly and then quietly does nothing" must be caught before anything changes) covers vars. The same failure through a missing secret is caught by nothing. No Failure Alert can fire either: the run exits before `runFailureAlerts`, and without the API key no post would get through anyway. After Connecteam's 3 webhook retries, deliveries are lost. Only the Worker logs show it.
- **Who's exposed:** A wizard install is safe, because it sets both secrets right after deploying (`setup-wizard.sh:1082-1085`) and stops if either fails. The manual path, or a secret deleted later, is not.
- **Status:** Verified by reading. No test covers the cron's "settings incomplete" branch (`grep -rn "incomplete" test/` finds nothing).
- **To rule on:** for example, have `--check-live` run `wrangler secret list --config …` and refuse while a live Worker lacks either secret. I have not checked whether `secret list` supports `--json`.

### R2. The RUNBOOK's manual first deploy runs `secret put` before the Worker exists (conflict)

- **Where:** `docs/RUNBOOK.md:60-66` runs `secret put` (lines 61-62), then `npm run deploy` (line 66). Ten lines later, `:75-77` says the wizard puts secrets "after the deploy because `secret put` on a Worker that doesn't exist yet stops to ask whether to create one".
- **Status:** Verified. The doc contradicts itself, and the wizard follows the second version.
- **Fix shape:** reorder the manual block so the deploy comes before the secrets.

### G2. "Sent once per problem" vs a daily repeat (conflict, GLOSSARY vs code)

- **Where:** `GLOSSARY.md:66` says a Failure Alert is "Sent once per problem, with an 'all clear' once it recovers." The code is `src/store.ts:982-994`: `claimAlert` matches `state IN ('clear', 'raised') AND alerted_at <= now - 24h`.
- **Conflict:** A condition that stays `raised` for more than 24 hours, such as a deleted Compliance Form nobody fixes, is claimed and posted again once a day. The code's own header (`failureAlerts.ts:19-21`) and tests (`test/worker/failure-alerts.test.ts:8`, `:240-270`) describe the rule as "at most once per 24 hours" and test only a *new* outage after 24 hours. Neither says whether a *continuing* problem should repeat.
- **Status:** The SQL behaviour is verified by reading. That it repeats in practice is suspected, since no test pins it.
- **To rule on:** a daily reminder of an unfixed problem may well be intended. If so, the GLOSSARY wording is out of date.

### S1. Subrequests per cron run grow with the number of Admins (suspected, low)

- **Fact:** Cloudflare's limits page says Paid allows "10,000 (up to 10M)" subrequests per invocation, and counts "requests … to Cloudflare services like R2, KV, or D1". So the D1 queries count, not only the Connecteam calls. Cron wall time is 15 minutes, and CPU time is 30 s for a one-minute cron.
- **Estimate:** Connecteam calls are bounded by the 20% headroom stop, mostly checked between Shifts. D1 queries are not bounded. One Escalation Summary run takes up to 100 held Shifts (`summary.ts:20`). For each (Shift, recipient) pair it runs a `claimSend` plus a `markSendDone` or `releaseSend` (`escalate.ts:133`, `:149-152`), plus a `sendState` when the claim is refused. With 100 held Shifts and *R* recipients, that is roughly 200·*R* D1 queries, on top of each Shift's own. *R* = 20 is about 4,000. *R* ≈ 50 Admins could approach the default 10,000 in the first run after Quiet Hours.
- **Status:** Suspected. This is arithmetic, not a measurement, and I don't know any client's Admin count. Note that the limit is configurable up to 10M (`limits.subrequests` in `wrangler.jsonc`, not set today).

### S2. Some loops ignore "stopped for the minute" (minor conflict with ADR-0002)

- **Where:**
  - `src/cron/escalate.ts:65-70`: the per-recipient send loop never checks `ct.stopped()`.
  - `src/cron/summary.ts:61-66`: so does the Summary's per-message loop.
  - `src/connecteam/client.ts:129-142`: `listActiveUsers` pages without checking.
  - `src/escalation/scheduledShift.ts:25-30`: so does the per-scheduler lookup.
- **Conflict:** ADR-0002 says each run "stops for the minute … on a 429". After a 429 mid-Escalation, the loop keeps sending to the remaining recipients. Those calls will mostly 429 too, get released, and back off, so nothing is lost or duplicated. The account's shared limit just takes a few extra hits.
- **Status:** Verified by reading. The impact is low.

### P1. Backups: `backup.sql` isn't ignored, and nothing says to keep `.dev.vars` (gap)

- **Where:** `docs/RUNBOOK.md:141`, `:164` write `--output=backup.sql` to the repo root. `.gitignore` has no `*.sql` or `backup.sql` entry, and can't ignore `*.sql` outright because `migrations/` uses that extension. The export holds employee names and user ids (`migrations/0010_blocks_and_alerts.sql:31`, the `undelivered.name` column), so a stray `git add .` would commit them.
- **Separately:** the playbook says to "tell clients to back these files up with `.dev.vars`, since none of them is on GitHub". `.dev.vars` is the only record of the D1 id and every setting, and the RUNBOOK never says to back it up. It mentions `.dev.vars` only as something to delete when removing a Deployment for good (`:201-202`).
- **Status:** Verified by reading `.gitignore` and searching the RUNBOOK for "back up".

### E1. The deploy check and the Worker read blank switches differently (minor, consistent in practice)

- **Where:** `src/env.ts:28`, `:32` say a blank `REMINDER_TASK_ENABLED` or `QUIET_HOURS_ENABLED` "reads as off". `scripts/lib/deploy-config.ts:52`, `:55` mark both `required: true`, so a blank one never deploys.
- **Status:** Verified. There is no runtime effect, because the deploy check blocks the blank value first. Only the comments disagree.

## Not checked here

- Whether the *Spec* (#19) still matches the code: that's #70.
- Whether the suite is TDD-shaped (#72), or `fake-connecteam.ts` matches the real API (#73).
- Running the suite: no `node_modules` in this checkout, so every "pinned by a test" above means I read the test, not ran it.
