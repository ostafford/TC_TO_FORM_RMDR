-- Escalation (#25).
--
-- When the Reminder went out. The escalation point is due this long after it
-- (the escalation delay, fixed for the Shift when the Reminder is sent), and the
-- Escalation says how long ago it was.
--
-- `shifts.status` gains `escalated`: every recipient's Escalation went out, or
-- there was nobody to send it to.
ALTER TABLE shifts ADD COLUMN reminded_at INTEGER;
