-- Open past the Scheduled Shift's end (#24).
--
-- `scheduled_end_at`: the Scheduled Shift's planned end, as last read (Admins
-- can edit it, so it's read again when it comes). While the Shift is open,
-- the step due then checks it. NULL until read.
--
-- `ended_by_schedule`: the Shift was still open (clocked in, or on a break)
-- at its planned end, so it's treated as ending then: `end_at` is the planned
-- end, and its Grace Period runs from there. The Reminder says whether they
-- are still clocked in or on a break. A real clock-out before the check takes
-- over (`end_at` becomes the real end, this goes back to 0); after the
-- Reminder it changes nothing.
ALTER TABLE shifts ADD COLUMN scheduled_end_at INTEGER;
ALTER TABLE shifts ADD COLUMN ended_by_schedule INTEGER NOT NULL DEFAULT 0;
