-- A Shift spans manual breaks (#23, ADR-0001).
--
-- Each manual break, from the `time_activity` webhook's `activityType:
-- "manual_break"` deliveries. Nothing links a break to its Shift Segments by
-- id, only by exact timing (tested live 2026-10-21, #23): starting a break
-- sends the segment's ordinary `clock_out` ending exactly at the break's start,
-- and resuming opens a new segment starting exactly at the break's end.
-- `end_at` is NULL while the break is open.
CREATE TABLE manual_breaks (
  time_activity_id TEXT PRIMARY KEY,
  user_id          INTEGER NOT NULL,
  start_at         INTEGER NOT NULL,
  end_at           INTEGER
);
CREATE INDEX manual_breaks_start ON manual_breaks (user_id, start_at);
