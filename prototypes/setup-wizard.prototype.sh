#!/usr/bin/env bash
# PROTOTYPE, throwaway. Branch prototype/setup-wizard, never merged.
# Question: what does the setup wizard walk a non-technical client through,
# step by step, and what does each step say?
#
# Fake demo data only: no network calls, nothing written. Real actions print
# "[prototype: would ...]".
#
#   bash prototypes/setup-wizard.prototype.sh               full first-time setup
#   bash prototypes/setup-wizard.prototype.sh --yes         same, accepting every default
#   bash prototypes/setup-wizard.prototype.sh --step NAME   rerun one step
#        NAME: key | timezone | form | timings | quiet-hours | recipients | reminder-task | sender | alerts | webhook | test
set -uo pipefail

YES=0; ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes) YES=1 ;;
    --step) ONLY="${2:-}"; shift ;;
  esac
  shift
done

if [[ -t 1 ]]; then B=$'\e[1m'; D=$'\e[2m'; G=$'\e[32m'; Y=$'\e[33m'; C=$'\e[36m'; R=$'\e[0m'; else B= D= G= Y= C= R=; fi
N=0
stage()   { N=$((N+1)); printf '\n%s━━ %d. %s ━━%s\n' "$B" "$N" "$1" "$R"; }
why()     { printf '%sWhy:%s ' "$C" "$R"; printf '%s\n' "$1"; shift; for l in "$@"; do printf '     %s\n' "$l"; done; }
todo()    { printf '%sWhat to do:%s\n' "$C" "$R"; local i=1; for l in "$@"; do printf '  %d. %s\n' "$i" "$l"; i=$((i+1)); done; }
example() { printf '%sExample:%s\n' "$Y" "$R"; for l in "$@"; do printf '  %s\n' "$l"; done; }
would()   { printf '  %s[prototype: would %s]%s\n' "$D" "$1" "$R"; }
ok()      { printf '  %s✔ %s%s\n' "$G" "$1" "$R"; }
warn()    { printf '  %s⚠ %s%s\n' "$Y" "$1" "$R"; }
next_up() { printf '\n%sNext up:%s %s\n' "$D" "$R" "$1"; }
ask()     { # ask VAR "Question" default
  local __v="$1" __q="$2" __def="${3:-}" __a
  if [[ $YES == 1 ]]; then __a="$__def"; printf '  %s %s[%s]%s %s\n' "$__q" "$D" "$__def" "$R" "$__a"
  else read -r -p "  $__q [$__def] " __a; __a="${__a:-$__def}"; fi
  printf -v "$__v" '%s' "$__a"
}
confirm() { local a; ask a "$1 (y/n)" "${2:-y}"; [[ "$a" =~ ^[Yy] ]]; }

# ── fake demo data ──────────────────────────────────────────────────────
FORMS=("Daily Compliance Form" "Vehicle Pre-Start Check" "Incident Report|anonymous" "Weekly Site Audit|one entry per user")
DATE_QS=("Which shift is this form for?|date" "Date of incident|datetime")
ADMINS=("Okky Stafford (owner)" "Priya Shah" "Marcus Webb" "Dana Ortiz" "Lee Chen")
BOARDS=("Daily tasks" "Compliance follow-ups")
CHANNELS=("Managers" "Announcements")
TZ_CLOCK="Australia/Melbourne"
IN_PROGRESS=12

# settings, with defaults (in the real wizard these land in .dev.vars)
TZ="$TZ_CLOCK"; FORM=""; DATEQ=""; WHERE="the Forms tab in the Connecteam app"
GRACE=30; DELAY=4; QH_ON=y; QH_FROM="9 pm"; QH_TO="7 am"; EXCLUDED=()
TASK=y; BOARD=""; PUB_NAME="Compliance Reminders (Automated)"; ALERTS=""; RELAY=n

pick() { # pick VAR "Question" default item...
  local __p="$1" __pq="$2" __pd="$3"; shift 3; local __i=1
  for it in "$@"; do printf '    %d) %s\n' "$__i" "${it%%|*}"; __i=$((__i+1)); done
  local __pa; ask __pa "$__pq" "$__pd"; printf -v "$__p" '%s' "$__pa"
}

# ── steps ───────────────────────────────────────────────────────────────
s_welcome() {
  printf '\n%sClock-out Form Reminder: setup%s\n' "$B" "$R"
  cat <<EOF

This sets up a small program that watches your Connecteam time clock. When
someone clocks out and hasn't submitted your compliance form, it reminds them
in Connecteam chat. If the form is still missing a few hours later, it tells
your admins.

If we host this for you, we run this together on a call: we sign in to
Cloudflare, you do the Connecteam steps.

You'll need, about 20 minutes:
  • a Cloudflare account (we'll check the plan together)
  • admin access to Connecteam, on the Expert plan or above
  • your phone with the Connecteam app, for a test message at the end

You can stop at any time and run this again. Nothing goes live until the
"Turn it on" step near the end.
EOF
  confirm "Ready to start?" || exit 0
  next_up "the Cloudflare account it runs on."
}

s_cloudflare() {
  stage "Cloudflare account"
  why "The reminder runs as a small program (a \"Worker\") on Cloudflare, in your own" \
      "account, so you own it and everything it stores. It needs the Workers Paid" \
      "plan (about US\$5 a month): one escalation can message all your admins at" \
      "once, which goes past what the free plan allows."
  todo "Sign in on the page that opens, and make sure the account is on Workers Paid." \
       "Sign this computer in to that account when the next browser tab opens."
  would "open https://dash.cloudflare.com/?to=/:account/workers/plans"
  confirm "Is your Cloudflare account on the Workers Paid plan?" || { warn "Upgrade on the page above, then run this again."; exit 1; }
  would "run: wrangler login, then show the signed-in account"
  ok "Signed in as: Example Pty Ltd (account 3f2a…)"
  next_up "the Connecteam key it uses."
}

s_key() {
  stage "Connecteam: API key"
  why "The reminder uses this key to see clock-outs and form submissions, and to send" \
      "messages. It's stored only in your Cloudflare account."
  todo "On the page that opens (Connecteam: Settings > API keys), create a new key." \
       "Paste it here. It won't show as you type."
  would "open https://app.connecteam.com/#/settings/integrations/api"
  local k; ask k "Paste the Connecteam API key:" "••••••••"
  would "make one test call and read the account's daily limit"
  ok "Key works. Daily API allowance: 10,000 calls (Expert plan)."
  printf '  %sThis account needs the Expert plan or above. On a smaller plan the reminder would%s\n  %srun out of calls by lunchtime, so setup would stop here and say so.%s\n' "$D" "$R" "$D" "$R"
  next_up "your time zone."
}

s_timezone() {
  stage "Time zone"
  why "Used for quiet hours (the next steps explain those). Shift times in messages" \
      "always show the time where the shift happened."
  ok "Your time clock is set to $TZ_CLOCK."
  ask TZ "Use this time zone?" "$TZ"
  next_up "the form staff must submit."
}

s_form() {
  stage "Compliance Form"
  why "This is the form every staff member must submit for every shift. The reminder" \
      "checks for a real submission of it, not a tick box."
  [[ -n "$ONLY" ]] && warn "$IN_PROGRESS shifts are in progress. They'll accept either the old or the new form; shifts from now on need the new one."
  printf '  Forms in your account:\n'
  local a; pick a "Which form? (number)" 1 "${FORMS[@]}"
  local f="${FORMS[$((a-1))]}"; FORM="${f%%|*}"
  case "$f" in
    *anonymous*) warn "\"$FORM\" is anonymous, so we can't tell who submitted it. Choose another form, or turn off anonymous submissions in Connecteam." ;;
    *"one entry"*) warn "\"$FORM\" only lets each person submit once, so it can't work as a per-shift form. Change that setting in Connecteam, or choose another form." ;;
    *) ok "Using \"$FORM\"." ;;
  esac
  s_dateq
  stage "Where staff find the form"
  why "The API can't give us a link to the form, so messages say where to find it." \
      "This phrase finishes the sentence \"You'll find it in …\"."
  ask WHERE "Where do staff find it?" "$WHERE"
  next_up "how long people get before a reminder."
}

s_dateq() {
  stage "Shift date question (optional, recommended)"
  why "If someone misses the form on Monday and catches up on Wednesday, the reminder" \
      "needs to know which day it's for. A date question in the form (\"Which shift" \
      "is this form for?\") answers that exactly. Without one, we go by the time it" \
      "was submitted, which is usually right."
  printf '  Date questions in \"%s\":\n' "$FORM"
  local a; pick a "Which one asks for the shift date? (number, or 0 for none)" 1 "${DATE_QS[@]}"
  if [[ "$a" == 0 ]]; then
    warn "No shift date question. Consider adding one to the form later, then rerun: --step form"; DATEQ=""
  else DATEQ="${DATE_QS[$((a-1))]%%|*}"; ok "Using \"$DATEQ\"."; fi
}

s_timings() {
  stage "Grace period"
  why "After someone clocks out, the reminder waits this long before checking for" \
      "the form, so people who fill it in straight away never get a message."
  [[ -n "$ONLY" ]] && warn "Shifts already in progress keep their current times. New values apply to shifts that end from now on."
  example "Jordan clocks out at 5:00 pm. With a 30-minute grace period, if the form" \
          "isn't in by 5:30 pm, Jordan gets a reminder in Connecteam chat."
  ask GRACE "Grace period in minutes?" "$GRACE"
  stage "Escalation delay"
  why "If the form is still missing this long after the reminder, your admins are" \
      "told. It gives the employee a fair chance to fix it first."
  example "5:00 pm  Jordan clocks out" \
          "5:$(printf '%02d' "$GRACE") pm  no form yet → reminder to Jordan" \
          "+${DELAY} h    still no form → your admins and Jordan's manager are told" \
          "If Jordan submits at any point before then, nobody else hears about it."
  ask DELAY "Escalation delay in hours?" "$DELAY"
  next_up "quiet hours."
}

s_quiet() {
  stage "Quiet hours"
  why "Escalations go to every admin, so they shouldn't arrive in the middle of the" \
      "night. During quiet hours they wait, then go out as one summary per admin" \
      "when quiet hours end. Reminders to the employee are never held: they've just" \
      "finished work and can fix it now."
  example "A shift ends at 10:00 pm. Reminder at 10:${GRACE} pm (sent). Escalation due at" \
          "2:${GRACE} am → held until ${QH_TO}, then sent in the morning summary."
  if confirm "Use quiet hours?" "$QH_ON"; then
    QH_ON=y; ask QH_FROM "Quiet from?" "$QH_FROM"; ask QH_TO "Quiet until?" "$QH_TO"
  else QH_ON=n; warn "Escalations will go out at any hour."; fi
  next_up "who receives escalations."
}

s_recipients() {
  stage "Who receives escalations"
  why "Every admin in your Connecteam account receives escalations, plus the" \
      "employee's direct manager. Untick anyone who shouldn't be on every one." \
      "New admins are included automatically. An unticked admin still hears about" \
      "their own direct reports."
  ok "Direct managers: found (your account uses the Direct manager field)."
  local excl=" " a
  while :; do
    printf '  Admins (✔ = receives escalations):\n'
    local i=1
    for ad in "${ADMINS[@]}"; do
      if [[ "$excl" == *" $i "* ]]; then printf '    %d) [ ] %s\n' "$i" "$ad"; else printf '    %d) [✔] %s\n' "$i" "$ad"; fi
      i=$((i+1))
    done
    ask a "Number to tick or untick, or Enter when done:" ""
    [[ -z "$a" ]] && break
    if [[ "$excl" == *" $a "* ]]; then excl="${excl/ $a / }"; else excl="$excl$a "; fi
    local kept=0; for j in $(seq 1 ${#ADMINS[@]}); do [[ "$excl" == *" $j "* ]] || kept=$((kept+1)); done
    if (( kept == 0 )); then warn "At least one admin must stay ticked, or escalations would reach nobody."; excl="${excl/ $a / }"; fi
  done
  EXCLUDED=(); for j in $(seq 1 ${#ADMINS[@]}); do [[ "$excl" == *" $j "* ]] && EXCLUDED+=("${ADMINS[$((j-1))]}"); done
  ok "$(( ${#ADMINS[@]} - ${#EXCLUDED[@]} )) of ${#ADMINS[@]} admins receive escalations."
  next_up "the reminder task."
}

s_task() {
  stage "Reminder task (on by default)"
  why "With the chat reminder, the employee also gets a task in their Connecteam" \
      "task list, so it stays visible after the message scrolls away. It ticks itself" \
      "off once the form arrives. Ticking it by hand doesn't count, and the employee" \
      "is told so."
  if confirm "Create reminder tasks?" "$TASK"; then
    TASK=y; printf '  Task boards:\n'; local a; pick a "Which board should the tasks go on? (number)" 2 "${BOARDS[@]}"
    BOARD="${BOARDS[$((a-1))]}"; ok "Tasks go on \"$BOARD\"."
  else TASK=n; fi
  next_up "the sender name staff will see."
}

s_publisher() {
  stage "Sender name"
  why "Every message comes from this sender. Its name is the first thing staff see," \
      "so it should say the message is automated, not from a person."
  todo "In Connecteam, open Settings > Feed settings > Custom publishers." \
       "Create one named as below, and copy its number (the publisher ID)."
  ask PUB_NAME "Sender name?" "$PUB_NAME"
  local id; ask id "Paste the publisher ID:" "48213"
  ok "Messages will come from \"$PUB_NAME\"."
  next_up "where problems are reported."
}

s_alerts() {
  stage "Alerts channel"
  why "If the reminder itself has a problem (Connecteam is down, the key stops" \
      "working, the form is deleted), it posts here, once per problem, with what to" \
      "do. This is about the system, never about staff."
  printf '  Channels:\n'; local a; pick a "Which channel? (number, or 0 to create \"Form Reminder Alerts\")" 0 "${CHANNELS[@]}"
  if [[ "$a" == 0 ]]; then ALERTS="Form Reminder Alerts"; would "create the channel and add the ticked admins"; else ALERTS="${CHANNELS[$((a-1))]}"; fi
  ok "Alerts go to \"$ALERTS\"."
  stage "Support link (optional)"
  why "If we support this setup for you, problems are also sent to us directly, even" \
      "when Connecteam itself can't deliver them, plus a daily \"still running\" check."
  if confirm "Send problems to your integrator as well?" "y"; then RELAY=y; ask a "Integrator link:" "https://relay.example.workers.dev"; fi
  next_up "a tip about Connecteam's own clock-out question."
}

s_tip() {
  stage "Tip: a clock-out question in Connecteam (optional)"
  why "Connecteam can ask staff a required question before they clock out, such as" \
      "\"Completed the compliance form?\". It's only their word, so this reminder" \
      "still checks for the real form, but it's a useful nudge at the right moment."
  todo "If you'd like one: Connecteam > Time Clock > Settings > Shift attachments."
  printf '  Nothing to enter here.\n'
}

s_summary() {
  stage "Check your settings"
  cat <<EOF
  Time zone ............ $TZ
  Compliance Form ...... $FORM
  Shift date question .. ${DATEQ:-none (by time)}
  Where to find it ..... $WHERE
  Grace period ......... $GRACE minutes
  Escalation delay ..... $DELAY hours
  Quiet hours .......... $( [[ $QH_ON == y ]] && echo "$QH_FROM to $QH_TO" || echo off )
  Escalations to ....... every admin$( (( ${#EXCLUDED[@]} )) && printf ' except: %s' "$(IFS=,; echo "${EXCLUDED[*]}")" ), plus direct managers
  Reminder task ........ $( [[ $TASK == y ]] && echo "on, board \"$BOARD\"" || echo off )
  Sender ............... $PUB_NAME
  Alerts channel ....... $ALERTS
  Support link ......... $( [[ $RELAY == y ]] && echo on || echo off )
EOF
  confirm "Is this right?" || { warn "Run again, or rerun one step with --step."; exit 1; }
}

s_deploy() {
  stage "Turn it on"
  why "This installs the reminder on your Cloudflare account and asks Connecteam to" \
      "tell it about clock-outs, form submissions and ticked tasks."
  would "save every setting to .dev.vars (kept on this computer, never in git)"
  would "create the database, then run the checking deploy (it stops if any setting is missing)"
  would "subscribe the webhooks: time_activity, form_submission (this form only), task_completed"
  ok "Installed. Checking every minute from now on."
  next_up "a test message to you."
}

s_webhook_only() {
  stage "Reconnect Connecteam notifications"
  why "Use this if the alerts channel said clock-outs aren't arriving. It replaces the" \
      "subscriptions; nothing else changes."
  would "delete this Deployment's own webhooks and subscribe them again"
  ok "Reconnected."
}

s_test() {
  stage "Test message"
  why "To make sure it all works, we'll send one real reminder to you, exactly as" \
      "staff will see it."
  printf '  Pick someone who has the Connecteam app on hand (you, or the client on the call):\n'
  local n; pick n "Send the test to? (number)" 1 "${ADMINS[@]%% (owner)}" "Jordan Lee"
  local all=("${ADMINS[@]%% (owner)}" "Jordan Lee"); local me="${all[$((n-1))]}"
  would "send the Reminder DM to $me, using the real wording and a sample shift"
  if confirm "Did the message arrive on your phone?"; then ok "All set."
  else warn "Check the sender name, and that you're in the Connecteam app as $me. Then run: --step webhook"; fi
}

s_done() {
  printf '\n%s━━ Done ━━%s\n' "$B" "$R"
  cat <<EOF

From now on, when someone clocks out without submitting "$FORM",
they'll get a reminder after $GRACE minutes, and your admins hear about it if
it's still missing $DELAY hours later.

To change one thing later, run this again with --step and one of:
  key, timezone, form, timings, quiet-hours, recipients, reminder-task,
  sender, alerts, webhook, test
A copy of this session (with keys hidden) is saved next to the wizard.
EOF
}

rerun_tail() { would "save to .dev.vars and run the checking deploy"; ok "Updated. Shifts already in progress are unaffected except as noted above."; }

case "$ONLY" in
  "") s_welcome; s_cloudflare; s_key; s_timezone; s_form; s_timings; s_quiet; s_recipients; s_task; s_publisher; s_alerts; s_tip; s_summary; s_deploy; s_test; s_done ;;
  form) FORM="Daily Compliance Form"; s_form; rerun_tail ;;
  timings) s_timings; rerun_tail ;;
  quiet-hours) s_quiet; rerun_tail ;;
  recipients) s_recipients; rerun_tail ;;
  reminder-task) s_task; rerun_tail ;;
  webhook) s_webhook_only ;;
  key) s_key; rerun_tail ;;
  timezone) s_timezone; rerun_tail ;;
  sender) s_publisher; rerun_tail ;;
  alerts) s_alerts; rerun_tail ;;
  test) s_test ;;
  *) echo "unknown step: $ONLY"; exit 2 ;;
esac
