# Clock-out Form Reminder

Connecteam integration: reminds staff who clock out without submitting the
Compliance Form, then escalates. Domain terms are in `GLOSSARY.md`; the
shared Connecteam/Cloudflare playbook is `../CLAUDE.md`.

## Agent skills

### Issue tracker

GitHub Issues on ostafford/TC_TO_FORM_RMDR, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Tests

The agreed seam is the Worker as a black box: `test/worker/`, driven through
`harness.ts` (signed webhooks in, cron ticks, a fake Connecteam out). A few
pure unit tests sit below it on purpose (`chooseShift`, `escalationRecipients`,
`isQuiet`, `readSettings`). When a refactor breaks one, move its unique cases
to the black box before deleting it (#78).
