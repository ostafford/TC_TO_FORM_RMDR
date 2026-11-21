-- Lost-webhook alert counts only clock-outs (#81).
--
-- `webhook`: which of the three webhooks a delivery came by, as its
-- Connecteam feature type: 'time_activity' (clock-outs), 'forms' (form
-- submissions) or 'tasks' (ticked tasks). The alert asks only when the last
-- clock-out delivery arrived, so form and task deliveries can't keep it quiet
-- while the clock-outs webhook is dead.
--
-- Deliveries already stored are classified by event type: form and task
-- events start `form_` and `task_`; no time activity event does.
ALTER TABLE webhook_deliveries ADD COLUMN webhook TEXT NOT NULL DEFAULT 'time_activity';
UPDATE webhook_deliveries SET webhook = 'forms' WHERE event_type LIKE 'form\_%' ESCAPE '\';
UPDATE webhook_deliveries SET webhook = 'tasks' WHERE event_type LIKE 'task\_%' ESCAPE '\';

-- Replaces 0010's index on `received_at` alone: the alert now asks per webhook.
DROP INDEX webhook_deliveries_received;
CREATE INDEX webhook_deliveries_received ON webhook_deliveries (webhook, received_at);
