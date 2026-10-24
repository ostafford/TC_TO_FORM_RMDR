# Clock-out Form Reminder: Integrator Relay

This project's own **Integrator Relay** (#35, spec #19): a small standalone
Cloudflare Worker the **integrator** hosts **once**, outside every Deployment.
It is not shared with EH_Webhook; it started as a copy of EH_Webhook's
`integrator-relay` (at `0c5ec92`) and is adapted here.

A Deployment with `INTEGRATOR_RELAY_URL` set (#36) sends it:

- `{ kind: "alert", client, condition, state: "raised" | "cleared", text, at }`:
  every Failure Alert and all clear, with the Alerts Channel's text but counts
  in place of staff names: this repo is public, and so are its issues. The
  client slug is in every issue title, so pick one you're happy to make public.
- `{ kind: "check_in", client, at }`: once a day.

The relay turns those into **GitHub issues on this repo**, so the integrator
hears about a problem through GitHub's notifications, even when Connecteam
can't deliver the alert (a rejected API key, a missing publisher), and without
any GitHub credential in a Deployment.

## Behaviour

| Push | What the relay does |
|---|---|
| `alert` raised, first for a `client` + `condition` | opens `[clock-out reminder] <condition> — <client>`, labels `clock-out-relay` + `failure-alert`, quoting the alert |
| `alert` raised again, issue still open | adds a comment: one issue, not many |
| `alert` cleared (the all clear) | comments with the all clear and **closes** the issue; with none open, nothing |
| `alert` raised after the issue was closed | opens a fresh one |
| `check_in` | stores the time; closes an open missed-check-in issue with a comment |
| hourly cron | opens `[clock-out reminder] missed check-in — <client>` (labels `clock-out-relay` + `missed-check-in`) for each Deployment silent for more than 36 hours, once |

Check-ins are kept in a SQLite-backed Durable Object (`CHECK_INS`): created on
deploy, no id to keep in the config, removed with the Worker.

`EMAIL_WEBHOOK_URL` (optional) also gets a compact `{ subject, text }` POST for
an integrator who wants a direct email hop (Zapier / Make / an SMTP bridge).

## Deploy (integrator, once)

From the repo root, logged in to the integrator's own Cloudflare account
(`npx wrangler whoami`), not a client's:

```bash
npm install

# 1. GitHub token: a fine-grained PAT scoped to ostafford/TC_TO_FORM_RMDR only,
#    Permissions -> Issues: Read and write. Nothing else.
npm run relay:secret -- GITHUB_TOKEN

# 2. The shared secret Deployments send as x-relay-secret.
#    Generate one: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm run relay:secret -- RELAY_SECRET

npm run relay:deploy
```

The first `relay:secret` creates the Worker if it doesn't exist yet. `vars` in
`relay/wrangler.jsonc` hold nothing account-specific (`GITHUB_REPO` is this
repo), so that file is deployed as it is.

Then, in this repo, **create the labels once**: `clock-out-relay`,
`failure-alert`, `missed-check-in` (any colour). The relay finds its own open
issues by `clock-out-relay`; without that label a repeat alert opens a second
issue instead of commenting.

Check it's live: `curl https://<relay>.workers.dev/health` →
`{ "ok": true, "service": "clock-out-form-reminder-relay" }`.

## Point a Deployment at it

In the Deployment's `.dev.vars` (the setup wizard's "Support link" step):

| Key | Value |
|---|---|
| `INTEGRATOR_RELAY_URL` | `https://<relay>.workers.dev/` |
| `INTEGRATOR_CLIENT_SLUG` | a short slug for this client, e.g. `acme`: one issue per client and condition |
| `INTEGRATOR_RELAY_SECRET` (secret) | the relay's `RELAY_SECRET` |

Blank `INTEGRATOR_RELAY_URL`: the Deployment sends nothing.

A Deployment torn down on purpose stops checking in, so the relay opens one
missed-check-in issue for it 36 hours later. Close that issue by hand; it isn't
reopened.

## Tearing down

The relay is torn down on its own, never with a Deployment:

```bash
npm run relay:teardown        # deletes the Worker and its check-ins
```

Then revoke the GitHub token in GitHub (Settings → Developer settings →
Fine-grained tokens), and clear `INTEGRATOR_RELAY_URL` in any Deployment still
pointing at it.

## Develop / test

```bash
npm test -- --project relay   # the relay's tests, in workerd; GitHub is faked
npm run typecheck
cp relay/.dev.vars.example relay/.dev.vars   # then `npm run relay:dev`
```
