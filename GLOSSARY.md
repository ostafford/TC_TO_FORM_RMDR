# Clock-out Form Reminder

Reminds staff who finish a shift without submitting the required Connecteam form, and escalates to their manager and admins. Built to be deployed once per client account, each with its own settings.

## Language

**Deployment**:
One client's install of the integration, against one Connecteam account, with its own settings.
_Avoid_: instance, tenant

**Compliance Form**:
The single Connecteam form a Deployment requires staff to submit for each shift. Chosen from the account's form list at setup.
_Avoid_: the form, checklist

**Shift**:
One clock-in to clock-out by a user in Connecteam's time clock.
_Avoid_: time entry, session

**Scheduled Shift**:
A planned shift on the client's Connecteam schedule, with a planned start and end. Not the same as a **Shift**, which is what actually happened on the time clock.
_Avoid_: plain "shift" when meaning the schedule

**Grace Period**:
The configurable wait after a Shift ends before checking for a submission. A submission counts if it arrives between clock-in and the end of the Grace Period. A Shift ends at clock-out; a Shift still open after its **Scheduled Shift**'s planned end is treated as ending then. An open Shift with no Scheduled Shift waits for the real clock-out.

**Missed Form**:
A Shift whose Grace Period has ended with no Compliance Form submission from that user.

**Reminder**:
The chat direct message sent to the employee when a Missed Form is found. If their Shift is still open, it also tells them they're still clocked in.

**Reminder Task**:
An optional Connecteam Quick Task assigned to the employee for a Missed Form, which closes once the form is submitted.
_Avoid_: quick task (on its own, it's ambiguous with any other Quick Task)

**Escalation**:
The chat direct message sent to each **Admin**, and to the employee's direct manager where the account uses direct managers, when a Missed Form is still unsubmitted after a further configurable delay.

**Admin**:
Any user with an admin role in the client's Connecteam account. Not a list chosen at setup.
_Avoid_: Deployment admins, recipients

## Relationships

- A **Shift** has at most one **Missed Form**
- A Compliance Form submission counts toward at most one **Shift**; each Shift needs its own
- A **Missed Form** produces one **Reminder**, an optional **Reminder Task**, and at most one **Escalation**
- A submission made after the **Reminder** but before the **Escalation** cancels the Escalation and closes the **Reminder Task**
- Every user who clocks in is covered; there is no narrowing by group or time clock

## Example dialogue

> **Dev:** "If they submit during the **Grace Period**, do we still send a **Reminder**?"
> **Domain expert:** "No: it isn't a **Missed Form** until the **Grace Period** ends with nothing submitted."
> **Dev:** "And if they submit after the **Reminder** went out?"
> **Domain expert:** "Then there's no **Escalation**, and the **Reminder Task** closes."
