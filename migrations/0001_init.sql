-- D1 is the work list (ADR-0002): one row per Shift, holding when its next
-- step is due; a one-minute cron does whatever is due. Runtime state only;
-- every setting lives in the Worker's config. Times are Unix seconds, the time
-- clock's own unit.

-- One row per Shift. `id` is the first Shift Segment's time-activity id.
CREATE TABLE shifts (
  id                 TEXT PRIMARY KEY,
  user_id            INTEGER NOT NULL,
  time_clock_id      INTEGER,
  -- The Shift's first clock-in, and the zone it was recorded in.
  start_at           INTEGER NOT NULL,
  start_tz           TEXT NOT NULL,
  -- The recorded end (`end.timestamp`), never when the webhook arrived. NULL while open.
  end_at             INTEGER,
  scheduler_shift_id TEXT,
  -- JSON array of the Compliance Form ids that count for this Shift (#17).
  form_ids           TEXT NOT NULL,
  -- The Grace Period's end: submissions up to here count without a Reminder.
  grace_ends_at      INTEGER,
  -- open: no end yet. grace: waiting for the Grace Period to end.
  -- submitted: a submission was found in time. reminded: the Reminder went out.
  status             TEXT NOT NULL,
  -- When the next step is due; NULL when nothing is scheduled.
  due_at             INTEGER,
  -- A cron run holds the row until this time, so overlapping runs never work the same Shift.
  lease_until        INTEGER,
  credited_submission_id TEXT,
  created_at         INTEGER NOT NULL
);
CREATE INDEX shifts_due ON shifts (due_at) WHERE due_at IS NOT NULL;

-- Each Shift Segment (Connecteam time activity) and the Shift it belongs to (ADR-0001).
CREATE TABLE shift_segments (
  time_activity_id TEXT PRIMARY KEY,
  shift_id         TEXT NOT NULL REFERENCES shifts (id),
  start_at         INTEGER NOT NULL,
  end_at           INTEGER
);

-- Every accepted webhook delivery, keyed for de-duplication on
-- requestId + eventType + userId + timeActivity.id (requestId alone isn't unique).
CREATE TABLE webhook_deliveries (
  dedupe_key  TEXT PRIMARY KEY,
  event_type  TEXT NOT NULL,
  user_id     INTEGER,
  received_at INTEGER NOT NULL
);

-- At-most-once sends: a send is claimed here before it goes out, marked done
-- only when Connecteam reports `ok`, and the claim is deleted on any other outcome.
CREATE TABLE send_claims (
  claim_key  TEXT PRIMARY KEY,
  shift_id   TEXT NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('claimed', 'done')),
  claimed_at INTEGER NOT NULL,
  done_at    INTEGER
);
