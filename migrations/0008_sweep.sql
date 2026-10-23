-- Polling sweep safety net (#32).
--
-- The time clocks the sweep reads, each with when it's next due. The cron
-- claims a clock by moving `next_at` on before it calls, so overlapping runs
-- never read the same clock twice in one interval.
CREATE TABLE sweep_clocks (
  time_clock_id INTEGER PRIMARY KEY,
  next_at       INTEGER NOT NULL
);

-- Small values the sweep keeps between runs: `clocks_listed_at` (when the time
-- clocks were last listed) and `day_limit` (the account's daily API allowance,
-- from the last `x-ratelimit-day-limit` header seen).
CREATE TABLE sweep_state (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

-- Each record the sweep had to add or correct because no webhook told us: an
-- unknown Shift Segment or manual break, or one whose times we had wrong. The
-- lost-webhook Failure Alert (#34) counts these.
CREATE TABLE sweep_finds (
  time_activity_id TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('segment', 'break')),
  user_id          INTEGER NOT NULL,
  found_at         INTEGER NOT NULL
);
CREATE INDEX sweep_finds_found ON sweep_finds (found_at);
