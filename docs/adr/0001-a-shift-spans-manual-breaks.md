# A Shift spans manual breaks

Connecteam ends the open record when a manual break starts and opens a new one, with a new id, when the worker resumes (tested live 2026-10-18). We define a **Shift** as the whole working stretch instead: Shift Segments that meet a manual break exactly at both ends count as one Shift. So a worker who takes lunch owes one Compliance Form, and gets no Reminder during the break. A Shift that ends in a break with no resume ends at the break's end, so the break doesn't use up the Grace Period.

## Considered Options

- **Each Connecteam record is a Shift**: simplest to build, but it asks for two forms on an ordinary day and can send a Reminder mid-lunch.
- **Join records separated by any gap under N minutes**: catches manual re-clock-ins, but it delays every Reminder by N and merges genuine split shifts (morning plus evening). Rejected for guessing; the break is Connecteam's own explicit signal.

## Consequences

The join is by timestamps only: nothing in the data links a break to its Shift Segments by id. A break an admin adds later splits a finished record into new ids, so the state must map those back to the Shift already checked rather than start a second check.
