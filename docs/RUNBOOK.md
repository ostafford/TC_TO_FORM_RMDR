# Runbook: Clock-out Form Reminder

How to deploy, update and tear down one **Deployment**. Terms follow
`GLOSSARY.md`. The setup wizard (`npm run setup`, `npm run setup -- --step
NAME` to rerun one step) does these steps for you; this page is the manual
equivalent and the reference for what the wizard does. So far the wizard
covers the Cloudflare account and the Connecteam API key (#37), and the
time zone, Compliance Form, Shift Date Question, "where to find it" phrase,
Grace Period, escalation delay and Quiet Hours (#38), and the escalation
recipients, Reminder Task, sender, Alerts Channel and the Shift Entry tip
(#39), then the settings summary, "Turn it on" and the test message (#40),
and rerunning one step (#41).

## Deploying

### Where the Deployment's values live

`wrangler.jsonc` is the **template**, the same for every client: its vars are
blank and its `database_id` is a placeholder. **Don't put real values in it,
and don't deploy it directly.** Each Deployment's own values live in the
git-ignored `.dev.vars` (copy `.dev.vars.example`; `D1_DATABASE_ID` is the
database). `npm run deploy` runs `scripts/deploy-config.ts`, which builds
`wrangler.deploy.json` (also git-ignored) from the two, then deploys that.

Why: values kept in the tracked config were silently reset to the blank
template by ordinary git use (a branch switch, a discard, a pull), and a plain
`wrangler deploy` then pushed blank settings and a dead database id to the live
Worker. It deployed cleanly and then did nothing (playbook, `../CLAUDE.md`). A
file git ignores can't be reset that way.

Before anything changes, `deploy:config --check-live` refuses when:

- `.dev.vars` is missing the database id or a required setting, or a setting is
  in the wrong form (it names each one);
- that database isn't on the Cloudflare account wrangler is logged in to
  (wrong account, or a stale id);
- the deploy would point the live Worker at a **different** database
  (`--allow-database-change` for a deliberate move).

It lists, without blocking, any setting the deploy would change on the live
Worker. A raw `npx wrangler deploy` of the template fails on its placeholder
`database_id`. Every other remote command that finds the database or the Worker
through the config (`d1 migrations`, `d1 export`, `d1 execute`, `secret put`)
also takes `--config wrangler.deploy.json`.

### First deploy

```bash
# Log in to the account the Deployment runs on, and check it's the right one
npx wrangler login
npx wrangler whoami

# One D1 database. Add the id it prints to .dev.vars as D1_DATABASE_ID=<id>
npx wrangler d1 create clock-out-form-reminder

# Fill in the rest of .dev.vars, then build and check the config
npm run deploy:config -- --check-live
npm run db:migrate

# Secrets
npx wrangler secret put CT_API_KEY --config wrangler.deploy.json
npx wrangler secret put CT_WEBHOOK_SECRET --config wrangler.deploy.json

# Verify, then deploy
npm run typecheck && npm test
npm run deploy
```

The Workers **Paid** plan is required (ADR-0002). Then subscribe the
webhooks (next section).

The wizard's "Turn it on" step does all of this in this order: keep (or make)
`CT_WEBHOOK_SECRET`, reuse the database already saved or named
`clock-out-form-reminder` (else create it), `deploy:config --check-live`,
migrations, deploy, the secrets, then the webhooks. Secrets go after the
deploy because `secret put` on a Worker that doesn't exist yet stops to ask
whether to create one.

### Subscribing the webhooks

Three subscriptions, all to the Worker's `https://…workers.dev/webhook`, each
with `"secretKey": "<CT_WEBHOOK_SECRET>"` and `"isDisabled": false`, created with
`POST /settings/v1/webhooks` (per the docs; the wizard sends exactly these):

| `featureType` | `entityId` | `eventTypes` |
|---|---|---|
| `time_activity` | `null` (every time clock) | `clock_in`, `clock_out`, `auto_clock_out`, `admin_add`, `admin_edit`, `admin_delete`, and the eight `admin_approved_*` / `auto_approved_*` events (`scripts/lib/wizard-turn-on.ts`) |
| `forms` | the Compliance Form id | `form_submission` |
| `tasks` | the task board id (left out with no board) | `task_completed` |

**Register once.** A second `POST` adds a second subscription and every event
arrives twice. To change one, `PUT /settings/v1/webhooks/<id>` with the same
body. A rerun of the wizard does that (`npm run setup -- --step webhook`
does only that, after listing what it will change): it updates the
subscriptions whose `url` is this Worker's, adds any missing, and removes
repeats. It never touches another integration's.

### Updating

Rerun the wizard's step: `npm run setup -- --step NAME` (see `--help`). It
saves the new value, then says what the change affects, counted from the
live database (Shifts in progress, escalations held, open Reminder Tasks),
and asks before applying it. On a yes it runs the checking deploy below,
stores a changed key on the Worker, and moves the form or
task board webhook when that changed. On a no, `.dev.vars` goes back as it
was.

By hand: change the value in `.dev.vars`, then:

```bash
npm run db:migrate
npm run deploy
```

Reading the live database, e.g. for a backup:

```bash
npm run deploy:config && npx wrangler d1 export clock-out-form-reminder --remote --output=backup.sql --config wrangler.deploy.json
```

## Tearing down / starting over

> **Deleting the Worker alone is not a reset.** Deleting
> `clock-out-form-reminder` leaves its D1 database behind. A re-run of the setup
> then reuses the old database, and its Shifts, send claims and Reminder Task
> ids carry over into what was meant to be a clean Deployment. Delete the
> database too.

> **Check the account first.** These commands delete by name, and every
> Deployment uses the same names. Run `npx wrangler whoami` and confirm it's the
> account you mean to clear.

This Deployment Worker has **no queues** (ADR-0002), so there are no queue
consumers to detach: delete the Worker, then the database. **Starting over** on
the same Connecteam account is steps 1 to 4. **Removing for good** adds step 5.

1. **Back up the database (optional).** It holds runtime state only (Shifts,
   send claims, credited submission ids, Reminder Task ids), never form answers:

   ```bash
   npm run deploy:config && npx wrangler d1 export clock-out-form-reminder --remote --output=backup.sql --config wrangler.deploy.json
   ```

2. **Delete this Deployment's Connecteam webhooks first**, so Connecteam stops
   posting to a URL that's about to disappear. There are three: the
   `time_activity`, `form_submission` and `task_completed` subscriptions whose
   `url` is this Worker's `/webhook`. Find their ids, then delete each:

   ```bash
   curl -sS -H "X-API-KEY: $CT_API_KEY" https://api.connecteam.com/settings/v1/webhooks
   curl -sS -X DELETE -H "X-API-KEY: $CT_API_KEY" https://api.connecteam.com/settings/v1/webhooks/<id>
   ```

   Leave any other webhook alone: other integrations on the account have their own.

3. **Delete the Worker.** This also removes its secrets and its one-minute
   cron. `--dry-run` first shows what it would do:

   ```bash
   npx wrangler delete clock-out-form-reminder --dry-run
   npx wrangler delete clock-out-form-reminder
   ```

4. **Delete the D1 database.** This is the step that makes it a real reset, and
   it **cannot be undone**:

   ```bash
   npx wrangler d1 delete clock-out-form-reminder
   ```

   A fresh setup creates a new database; put its id in `.dev.vars`
   (`D1_DATABASE_ID`). The next deploy would otherwise stop, saying the database
   isn't on the account.

5. **Removing for good only:**
   - **API key:** revoke the Connecteam API key (Settings → API keys). On a
     restart, keep it.
   - **Local files:** delete `.dev.vars` (it holds the keys and names the
     client's accounts), or the whole clone.

**Leave these in Connecteam either way:** the Compliance Form, the custom
publisher, the task board and the Alerts Channel. A restart reuses them, and
deleting them is the client's decision, not part of a teardown. Open Reminder
Tasks stay on the board until someone closes them.
