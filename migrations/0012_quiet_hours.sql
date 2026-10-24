-- Quiet Hours and Escalation Summary (#29).
--
-- An Escalation due during Quiet Hours is held: the Shift stays `reminded`
-- (so a credit, a delete or a block's overdue skip treat it as before), its
-- `due_at` moves to when Quiet Hours end, and `held` is set. When they end,
-- the held Shifts go out together as one Escalation Summary per recipient,
-- not through the ordinary escalation point. Cleared when the Shift is
-- escalated or credited.
ALTER TABLE shifts ADD COLUMN held INTEGER NOT NULL DEFAULT 0;
