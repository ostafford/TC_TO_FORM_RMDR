# A D1 work list driven by a one-minute cron, no Queue

The integration playbook (`../CLAUDE.md`) gives a write-heavy Worker a Queue consumer from day one. We don't. Every step here waits on a clock (the end of the Grace Period, the escalation delay, a Scheduled Shift's planned end, the polling sweep), so one Worker on the Workers Paid plan keeps a D1 table of Shifts, each with the time its next step is due, and a cron every minute does whatever is due. The table already is the queue: an unfinished row is picked up by the next run, backoff means moving its due time, and an edit, a deletion or a late submission just updates the row. That can't be done to a delayed Queue message, which can't be cancelled.

## Considered Options

- **Queue messages with `delaySeconds`**: they can't be cancelled when a Shift is edited or a form arrives, and the polling sweep would still need a cron. That's two schedulers.
- **A Durable Object alarm per Shift**: precise and cancellable, but it's a second storage system and still needs the cron.

## Consequences

- The playbook's two reasons for a Queue are covered another way. The 50-call cap is gone on the Paid plan. Retry safety comes from each cron run **leasing** the rows it takes, so overlapping runs never work the same Shift, and from **claiming every send in D1 before it goes out** (released on a failed send, marked done on `ok`).
- Sends are at most once. If the Worker dies between a claim and its send, the message is lost, not duplicated, and a claim stuck for more than 10 minutes raises a failure alert instead of being retried.
- Each run stays polite to the account's shared rate limit: oldest due first, and it stops for the minute once less than 20% of the limit remains, or on a 429.
