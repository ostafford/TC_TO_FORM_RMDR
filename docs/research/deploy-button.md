# Could a Deploy-to-Cloudflare button set this up as reliably as the wizard?

Research for [#8](https://github.com/ostafford/TC_TO_FORM_RMDR/issues/8). Researched 2026-10-18 against Cloudflare's docs (pages last updated 2026-10-12 to 2026-10-17) and the two earlier IDP builds. Nothing was deployed and no live API calls were made.

## Answer

**No.** The button can put the Worker and its Cloudflare resources into a client's account, but it can't finish setting up a Deployment. It can't look anything up in Connecteam, so the client can't pick the Compliance Form from a list. It can't teach the settings or run an end-to-end test. Its "pull settings from the committed config" model also conflicts with the playbook's rule to keep each Deployment's values in a git-ignored file and deploy through a checking script. The most it could do is install the code. The client would still have to run a setup step afterwards, and that step is the wizard. The Bash wizard should stay the only supported path, as map #1 already assumes.

## What the button does

Source: [Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/).

- It **clones the repo into the user's own GitHub/GitLab account**, then builds and deploys it with [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/). The source repo must be public and hosted on github.com or gitlab.com, so the person installing needs a GitHub or GitLab account.
- It shows **one setup page** where the user can change "repository name, Worker name, and required resource names".
- After that, every push to the cloned repo's production branch triggers a rebuild and redeploy ([Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)). The client ends up owning a CI pipeline.

## What it can provision

From "Automatic resource provisioning" on the same page:

| Need for this project | Button? | Notes |
|---|---|---|
| D1 database | Yes | It provisions the database and binds it. Cloudflare says to "make sure your source repository includes default values for resource names, resource IDs". The [Wrangler auto-provisioning docs](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning) say that for a dashboard/Git deploy, the new IDs are "only accessible via the dashboard" and are **not written back to the repository**. |
| D1 migrations | Partly | There's no dedicated step. The docs suggest chaining `wrangler d1 migrations apply <BINDING> --remote` into the `deploy` npm script, which Workers Builds detects and runs. |
| Queues (and DLQ) | Yes | Listed under Compute. The `max_retries`/consumer settings come from `wrangler.jsonc` as usual. |
| Cron trigger | Yes, implicitly | Not a provisioned resource: `triggers.crons` in `wrangler.jsonc` is applied by `wrangler deploy` like any other config ([Wrangler config, Triggers](https://developers.cloudflare.com/workers/wrangler/configuration/#triggers)). |
| Durable Objects, KV, R2 | Yes | Not needed here as far as the map shows. |
| Workers **Paid** plan | **No** | The button can't change a plan. If this project needs more than 50 subrequests in one invocation ([limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests)), the client must upgrade separately. Otherwise it fails with "Too many subrequests" (playbook). |

## What it can ask the user for

- **Plain vars**: only as defaults committed in the `vars` block of `wrangler.jsonc`. Per the playbook, that tracked file must stay a blank template, so the defaults would be blank.
- **Secrets**: declared in a committed `.dev.vars.example` / `.env.example` (dotenv format). The setup page then asks for them.
- **Help text**: `package.json` → `cloudflare.bindings.<NAME>.description` gives each var/secret a description. It supports inline Markdown and links, e.g. "Generate a random string using `openssl rand -hex 32`."
- That's everything: free-text fields with a static description. It can't fetch data, offer a dropdown, validate an answer, or run any code before the deploy.

## What it can't do that the wizard must

1. **Pick the Compliance Form from the account's form list** (GLOSSARY: "Chosen from the account's form list at setup"). This needs a live Connecteam API call using the key the user just entered. The button can't make that call. The client would have to find and paste a raw form ID.
2. **Validate the Connecteam API key** before deploying. EH_Webhook's wizard calls Connecteam with `curl` while it runs (`~/IDP/EH_Webhook/scripts/setup-wizard.sh`, `ct_api()` at line 266).
3. **Explain each setting with a worked example** (map #1: Grace Period, escalation delay). The only room for that is a one-line field description.
4. **Register anything in Connecteam** (e.g. a webhook pointing at the new Worker URL), because the URL doesn't exist until the deploy finishes.
5. **Run the end-of-setup test** that sends one real Reminder to the installer (map #1, "Not yet specified").
6. **Check the plan**, or warn that the Paid plan is needed.
7. **Recover cleanly from a half-finished run.** If the build fails, the client is left with a GitHub repo and possibly provisioned resources. Clearing those up follows the playbook's strict teardown order: consumers, then Worker, then queues, then D1.

## How it fits the playbook

- **Values in a git-ignored file, deployed via a checking script.** The button deploys from the *committed* config of the client's clone. It has no `.dev.vars`, so a checking `deploy-config.ts` (EH_Webhook's pattern) has nothing to read there.
- **The placeholder database ID conflicts with the button.** The playbook's non-UUID `database_id` placeholder exists so that a raw deploy fails up front. The button needs real defaults or no ID at all, so it would fail on that guard. Supporting both means the button path drops the guard.
- **Dashboard edits get overwritten.** If a client fixes a var in the dashboard afterwards, the next Workers Build deploy overwrites it ("Wrangler will override them the next time you deploy") unless `keep_vars: true` is set ([source of truth](https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth)). This is the same "deploys cleanly, quietly does nothing" failure the playbook warns about, triggered by any push to the client's repo.
- **The monorepo gotcha mostly doesn't apply.** This repo is standalone, and map #1 says to *copy* `ConnecteamClient` rather than import it. The button's "fully isolated within that subdirectory" limitation therefore only matters if the Worker ever moves into a subfolder.

## Evidence from earlier IDP builds

- **sch_import used the button, and it went poorly.** `~/IDP/sch_import/README.md` lines 125 and 137 have buttons for the Relay and Importer. Line 139 records "Known issue (2026-09-26): this button can fail with 'Invalid repository URL — Monorepos are not yet fully supported'... use Manually (CLI) instead." Lines 141-145 then have the client add every secret and var by hand in the dashboard (Settings → Variables and Secrets) after the deploy, including building a JSON string (`TIME_CLOCKS_JSON`) with a `node -e` command. So the button only removed the terminal for the deploy step itself.
- **sch_import needed workarounds to make the button build at all.** `packages/importer-cloudflare/wrangler.jsonc` lines 4-11 point `main` at a committed `release/index.js` bundle. `package.json` lists the workspace package under `optionalDependencies`. `typecheck.mjs` lines 2-25 skip `tsc` when the shared package is missing, because Workers Builds runs the `build` script and failed there live. `packages/relay-cloudflare/src/vocabulary.ts` lines 1-7 duplicate code to avoid a workspace dependency. These are the sources of the playbook's monorepo gotcha.
- **sch_import's setup values still came from a separate tool.** `.scratch/connecteam-schedule-import/issues/14-cloudflare-deployment-mechanics.md` ("Answer" §5 and its update) chose the button as the headline path, but `npm run importer -- setup` still had to run first to discover IDs. Issue 17 in the same map then found that setup didn't print the values the Cloudflare path needed.
- **EH_Webhook avoided the button entirely.** Nothing in `~/IDP/EH_Webhook` mentions a deploy button. It uses `scripts/setup-wizard.sh` (889 lines: live Connecteam lookups, `wrangler secret put` via `put_secret()` at line 283, and D1 checks) together with `scripts/deploy-config.ts`. Its `wrangler.jsonc` is a blank template with the deliberate `"database_id": "set-D1_DATABASE_ID-in-.dev.vars"` placeholder, which a button deploy would trip over.

## If it's ever wanted later

Two shapes could work, both as nice-to-haves on top of the wizard:

- **Hybrid**: the button only installs the code, and the Worker serves its own first-run setup page (enter API key → choose the Compliance Form from a live list → settings with explanations → test Reminder), storing the answers in D1 instead of vars. This moves the wizard into the Worker; it doesn't remove it, and it needs its own auth and its own decision record.
- **Button as a demo/trial only**, clearly labelled, with the Bash wizard as the supported install.
