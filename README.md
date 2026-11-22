# Clock-out Form Reminder

Reminds **Connecteam** staff who finish a shift without submitting the required
form, then escalates to their manager and admins if it's still missing.

Many businesses need a form filled in for every shift (a safety checklist, a
job report, a handover). Connecteam can ask staff to *confirm* they did it
before clocking out, but that's only their word. This integration checks for a
real submission and follows up when there isn't one.

A reusable, single-tenant integration: deployed once per client, into the
client's own Cloudflare account, with every client-specific value (API key,
form, timings, recipients) supplied as config, never code.

## How it works

1. **A shift ends.** Connecteam's time clock webhook reports clock-ins,
   clock-outs and breaks. A worker who takes lunch has one shift and owes one
   form ([ADR-0001](docs/adr/0001-a-shift-spans-manual-breaks.md)).
2. **Grace Period.** After a configurable wait (default 30 minutes), it checks
   whether the Compliance Form was submitted for that shift.
3. **Reminder.** If not, the employee gets a chat message, plus an optional
   Reminder Task on a task board. If they're still clocked in, the Reminder
   tells them.
4. **Escalation.** If the form is still missing after a further delay
   (default 4 hours), each admin and the employee's direct manager are
   messaged. Escalations raised overnight (9 pm to 7 am) are held and sent as
   one summary in the morning.
5. **Late submissions count.** A submission at any point cancels the
   Escalation and closes the Reminder Task. It's matched to the right shift by
   an optional "which shift is this for?" date question, then by timing, then
   to the oldest missed form.

The full vocabulary (Shift, Grace Period, Missed Form, Escalation, and so on)
is defined in [`GLOSSARY.md`](GLOSSARY.md).

## Design

- **One Cloudflare Worker, no queue.** Webhooks only record what happened. A
  cron runs every minute, working through a D1 table of shifts that each know
  when their next step is due, so an edit or a late form just updates a row
  ([ADR-0002](docs/adr/0002-d1-work-list-and-one-minute-cron-no-queue.md)).
- **Sends are at most once.** Every message is claimed in the database before
  it goes out, and overlapping cron runs lease their rows, so nobody is
  messaged twice.
- **A polling sweep catches lost webhooks.** Connecteam retries a webhook at
  most 3 times, so a sweep re-reads the time clocks, using at most 20% of the
  daily API allowance that other integrations on the account share.
- **Failure Alerts.** If the integration itself has a problem (a rejected API
  key, a setting pointing at something deleted, a send that keeps failing),
  the client's chosen chat channel is told once, with an "all clear" when it
  recovers.
- **No form content leaves Connecteam.** Messages say who missed a form and
  for which shift, never what was in it. The database holds runtime state
  only.
- **Webhooks are verified.** Every delivery's signature is checked against
  the Deployment's secret.

## What you need

- A **Connecteam** account with API access, a Compliance Form to require, and
  a custom publisher to send messages as.
- A **Cloudflare account on the Workers Paid plan** (about US$5/month).
- **Node.js** and `npm`.

## Set it up for a client

Run the setup wizard from the repo root:

```sh
npm install
npm run setup
```

It walks through every step: the Cloudflare account, the API key, the form,
timings, recipients, the sender and the Alerts Channel. Then it turns the
integration on (database, deploy, secrets, webhooks) and sends a test message.

To change one setting on a live Deployment:

```sh
npm run setup -- --step NAME    # see --help for the step names
```

It shows what the change affects (shifts in progress, held escalations, open
tasks) and asks before applying it.

Each Deployment's values live in the git-ignored `.dev.vars` (template:
[`.dev.vars.example`](.dev.vars.example)). `wrangler.jsonc` is a blank template
and is never deployed directly. Manual deploy, update and teardown steps are in
the [runbook](docs/RUNBOOK.md).

## Development

```sh
npm run typecheck
npm test                  # unit tests and Worker tests against a fake Connecteam
npm run test:integration  # live API tests; they skip themselves without .dev.vars
```

## Stack

TypeScript · Cloudflare Workers · D1 · Cron Triggers · Connecteam REST API and
webhooks · Vitest
