-- Every way a Shift ends, plus edits and deletes (#22).
--
-- A deleted Shift keeps its row, so a record Connecteam deletes and recreates
-- (a geofence approval) maps back to the same Shift. While `deleted_at` is set
-- the cron skips the row: its pending steps are cancelled. A recreated record
-- clears it, and the Shift carries on where it was.
--
-- `shifts.status` gains `too_late`: first known more than 24 hours after its
-- recorded end, so never checked.
ALTER TABLE shifts ADD COLUMN deleted_at INTEGER;
