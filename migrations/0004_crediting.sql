-- Crediting submissions (#26).
--
-- A Compliance Form submission counts toward at most one Shift. The store
-- checks before crediting; this makes the database refuse a second Shift too.
CREATE UNIQUE INDEX shifts_credited_submission ON shifts (credited_submission_id)
  WHERE credited_submission_id IS NOT NULL;
