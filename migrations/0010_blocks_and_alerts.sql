-- Failure Alerts: pause, missing setting, lost webhook, allowance (#34).
--
-- Small values the Worker keeps between runs, no longer only the sweep's: it
-- gains `day_remaining` (the account's daily API allowance left, from the last
-- `x-ratelimit-day-remaining` header seen).
ALTER TABLE sweep_state RENAME TO worker_state;

-- What stops work until the client fixes it. key: Connecteam rejected the API
-- key (401/403); every step waits. form, publisher, board: the Compliance
-- Form, the custom publisher or the task board is gone (404); the steps that
-- need it wait. `setting` is the setting's value when it was found (for the
-- key, a hash of it, never the key): the block lifts when the setting changes
-- (the client reran that setup step), or for the key and the form, when a
-- re-check works. `checked_at` is when it was last re-checked. Each block is
-- also a Failure Alert condition of the same name.
CREATE TABLE blocks (
  block      TEXT PRIMARY KEY CHECK (block IN ('key', 'form', 'publisher', 'board')),
  since      INTEGER NOT NULL,
  setting    TEXT,
  checked_at INTEGER NOT NULL
);

-- `undelivered` gains `skipped` sends: more than an hour overdue when a block
-- lifted, so never sent. `alert` is the condition whose all clear lists the
-- row: `messages` for failed and unconfirmed sends, the block for skipped ones.
-- SQLite can't change a CHECK constraint in place, so the table is rebuilt.
CREATE TABLE undelivered_new (
  send_key      TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('reminder', 'escalation', 'task', 'tick')),
  user_id       INTEGER NOT NULL,
  name          TEXT NOT NULL,
  shift_start   INTEGER NOT NULL,
  shift_tz      TEXT NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('failed', 'unconfirmed', 'skipped')),
  alert         TEXT NOT NULL DEFAULT 'messages',
  status        INTEGER,
  failing_since INTEGER NOT NULL,
  given_up_at   INTEGER NOT NULL,
  cleared_at    INTEGER
);
INSERT INTO undelivered_new
  (send_key, kind, user_id, name, shift_start, shift_tz, outcome, status, failing_since, given_up_at, cleared_at)
SELECT send_key, kind, user_id, name, shift_start, shift_tz, outcome, status, failing_since, given_up_at, cleared_at
FROM undelivered;
DROP TABLE undelivered;
ALTER TABLE undelivered_new RENAME TO undelivered;
CREATE INDEX undelivered_open ON undelivered (alert, given_up_at) WHERE cleared_at IS NULL;

-- The lost-webhook alert asks when the last delivery arrived.
CREATE INDEX webhook_deliveries_received ON webhook_deliveries (received_at);

-- A condition raised without its alert reaching the client (held back, or
-- the post failed, as it must with the API key rejected). Its all clear is
-- posted only if it has sends to list; otherwise it clears without a word,
-- so a problem that comes and goes can't post an all clear for nothing.
ALTER TABLE failure_alerts ADD COLUMN quiet INTEGER NOT NULL DEFAULT 0;
