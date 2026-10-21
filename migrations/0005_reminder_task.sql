-- Reminder Task lifecycle (#27).
--
-- One row per Shift whose Reminder came with a Reminder Task, written when the
-- Reminder goes out. It's a second work list beside `shifts`: the task's own
-- steps (create, the hourly re-check after the Escalation, close, delete) run
-- on their own schedule, and keep going after the Shift's own steps are done.
--
-- state: pending (not created yet), open (created; `task_id` is set),
-- completed (closed by us once a submission was credited), deleted (7 days
-- after the Shift, or the Shift was deleted), skipped (never created: credited
-- or deleted first, or the Reminder Task was turned off).
CREATE TABLE reminder_tasks (
  shift_id    TEXT PRIMARY KEY REFERENCES shifts (id),
  -- The board it was created on. Kept per task, so a later board change leaves
  -- existing tasks to finish their lifecycle where they are.
  board_id    TEXT NOT NULL,
  -- Stored together the moment Connecteam returns the id: creating isn't
  -- idempotent, and the close `PUT` is a full replace that needs them again.
  task_id     TEXT,
  title       TEXT,
  user_ids    TEXT,
  description TEXT,
  state       TEXT NOT NULL CHECK (state IN ('pending', 'open', 'completed', 'deleted', 'skipped')),
  -- When the task's next step is due; NULL once it's finished.
  due_at      INTEGER,
  -- A cron run holds the row until this time, as for `shifts`.
  lease_until INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX reminder_tasks_due ON reminder_tasks (due_at) WHERE due_at IS NOT NULL;
