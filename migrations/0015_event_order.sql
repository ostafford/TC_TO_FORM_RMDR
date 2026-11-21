-- Ignore a segment or break write older than the last one applied (#83).
--
-- `event_at`: the `eventTimestamp` of the last `time_activity` delivery whose
-- times were saved for this record. A delivery older than it is ignored: a
-- first edit whose delivery failed (5xx, so never stored or de-duplicated) and
-- that Connecteam re-sends after a newer edit would otherwise put the old
-- times back. NULL until a delivery carries one. A sweep write has no event
-- time: it applies whatever the stamp, as the record it read is current, and
-- leaves the stamp as it was.
ALTER TABLE shift_segments ADD COLUMN event_at INTEGER;
ALTER TABLE manual_breaks ADD COLUMN event_at INTEGER;
