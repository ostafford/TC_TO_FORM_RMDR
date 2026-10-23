-- Tick without submitting (#28).
--
-- The employee marked the Reminder Task done with no credited submission
-- (`task_completed`; an API completion, such as our own close, sends none:
-- tested live 2026-10-24). ticked: reopening it and the tick DM are due.
-- reopened: both done once; a later tick leaves it closed. NULL: never ticked.
-- Any tick puts the note on the Escalation.
ALTER TABLE reminder_tasks ADD COLUMN tick TEXT CHECK (tick IN ('ticked', 'reopened'));
