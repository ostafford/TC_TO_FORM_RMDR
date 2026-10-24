-- Failure Alerts and check-ins to the Integrator Relay (#36).
--
-- Whether the relay has been told this condition is raised (1) or not (0).
-- Kept apart from `state`, which follows the Alerts Channel: an alert whose
-- channel post keeps failing (a rejected API key) is claimed again every run,
-- but the relay hears of it once. Raised goes out when the condition is
-- raised and `relayed` is 0; cleared when it's clear and `relayed` is 1. Each
-- is claimed by flipping `relayed` before the send, and flipped back if the
-- relay doesn't answer 2xx, so the next run tries again.
ALTER TABLE failure_alerts ADD COLUMN relayed INTEGER NOT NULL DEFAULT 0;
