-- Failure Alerts: send failures (#33).
--
-- Backoff. A step that fails (a 429, 5xx, timeout, or any other non-ok
-- answer) is tried again on a later run, after 1, 2, 4, 8, 16 then 32
-- minutes, by moving its own `due_at`. `attempts` counts its failures in a
-- row and `failing_since` is when the first of them happened; a step that
-- succeeds resets both. The 7th failure, about an hour in, gives up.
ALTER TABLE shifts ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shifts ADD COLUMN failing_since INTEGER;
ALTER TABLE reminder_tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reminder_tasks ADD COLUMN failing_since INTEGER;

-- Recovery is a send marked done after the latest give-up.
CREATE INDEX send_claims_done ON send_claims (done_at) WHERE done_at IS NOT NULL;

-- Each send given up on, for the "Messages not sending" Failure Alert and its
-- all clear, which list who wasn't reached. One row per send and Shift
-- (`reminder:<shiftId>` and so on).
--
-- outcome: failed (it kept failing for about an hour, so it was never sent) or
-- unconfirmed (its claim was stuck for more than 10 minutes: a run stopped
-- mid-send, so it may or may not have gone out, and is never sent again).
-- `status` is the last failure's HTTP status, NULL for a timeout or a stuck
-- claim. Every alert lists the rows not yet cleared; the all clear lists them
-- once more, to follow up by hand, and sets `cleared_at`.
CREATE TABLE undelivered (
  send_key      TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('reminder', 'escalation', 'task', 'tick')),
  user_id       INTEGER NOT NULL,
  -- The employee's full name when it was known; blank otherwise.
  name          TEXT NOT NULL,
  shift_start   INTEGER NOT NULL,
  shift_tz      TEXT NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('failed', 'unconfirmed')),
  status        INTEGER,
  failing_since INTEGER NOT NULL,
  given_up_at   INTEGER NOT NULL,
  cleared_at    INTEGER
);
CREATE INDEX undelivered_open ON undelivered (given_up_at) WHERE cleared_at IS NULL;

-- One row per Failure Alert condition (`messages`, `sweep`). Each alert and
-- all clear is claimed here before it's posted, as a send is in send_claims:
-- clear -> alerting (claimed) -> raised (posted `ok`) -> clearing (claimed)
-- -> clear (posted `ok`). A failed post goes back a step. A claim stuck for
-- more than 10 minutes counts as posted: never twice.
--
-- `alerted_at` is when the last alert went out. The condition alerts again
-- only 24 hours after that.
CREATE TABLE failure_alerts (
  condition  TEXT PRIMARY KEY,
  state      TEXT NOT NULL CHECK (state IN ('clear', 'alerting', 'raised', 'clearing')),
  claimed_at INTEGER,
  alerted_at INTEGER
);
