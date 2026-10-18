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
One working stretch by a user: one or more **Shift Segments** joined by manual breaks, from the first clock-in to a clock-out with no break after it. A user who takes lunch has one Shift.
_Avoid_: time entry, session

**Shift Segment**:
One clock-in to clock-out record in Connecteam's time clock. A manual break ends one Shift Segment, and resuming starts the next.
_Avoid_: Connecteam shift, time activity

**Scheduled Shift**:
A planned shift on the client's Connecteam schedule, with a planned start and end. Not the same as a **Shift**, which is what actually happened on the time clock.
_Avoid_: plain "shift" when meaning the schedule

**Grace Period**:
The configurable wait after a Shift ends before checking for a submission. A submission counts if it arrives between the Shift's first clock-in and the end of the Grace Period. A Shift ends at its last clock-out, or at the end of a break it never resumes from; a Shift still open (including one on a break) after its **Scheduled Shift**'s planned end is treated as ending then. An open Shift with no Scheduled Shift waits for the real clock-out.

**Shift Entry**:
Connecteam's own field an employee can be made to fill in before clocking out (e.g. "Completed the form? Confirmed"). It is only the employee's word, not a Compliance Form submission, and this integration ignores it.
_Avoid_: shift attachment, clock-out form

**Missed Form**:
A Shift whose Grace Period has ended with no Compliance Form submission from that user.

**Reminder**:
The chat direct message sent to the employee when a Missed Form is found. If their Shift is still open, it also tells them they're still clocked in.

**Reminder Task**:
An optional Connecteam Quick Task assigned to the employee for a Missed Form, which closes once the form is submitted.
_Avoid_: quick task (on its own, it's ambiguous with any other Quick Task)

**Escalation**:
The chat direct message sent to each **Admin** except **Excluded Admins**, and to the employee's direct manager where the account uses direct managers, when a Missed Form is still unsubmitted after a further configurable delay. It says who missed the form and for which Shift, never any form content.

**Admin**:
Any user with an admin role in the client's Connecteam account, whatever that role's permissions cover. Not a list chosen at setup: someone who becomes an Admin later is included automatically.
_Avoid_: Deployment admins, recipients

**Excluded Admin**:
An **Admin** the client has chosen at setup not to send Escalations to. Still receives Escalations for employees they are the direct manager of.
_Avoid_: muted, opted-out (both suggest the Admin chose it)

**Failure Alert**:
A message telling people the integration itself has a problem (a send that kept failing, a rejected API key, a setting that points at something gone, a lost webhook, the daily API allowance nearly used), as opposed to a staff member missing a form. Sent once per problem, with an "all clear" once it recovers.
_Avoid_: system alert, error notification

**Alerts Channel**:
The Connecteam chat channel, chosen at setup, where a Deployment's Failure Alerts are posted for the client.
_Avoid_: admin channel

**Integrator Relay**:
A small service the integrator hosts once, outside every Deployment, that receives Failure Alerts and daily health check-ins and turns them into issues for the integrator. It also notices a Deployment that stops checking in. It reaches the integrator when Connecteam itself can't.

## Relationships

- A **Shift** is one or more **Shift Segments**: a Shift Segment that ends exactly when a manual break starts and the Shift Segment that starts exactly when that break ends belong to the same Shift
- A **Shift** has at most one **Missed Form**
- A Compliance Form submission counts toward at most one **Shift**; each Shift needs its own
- A **Missed Form** produces one **Reminder**, an optional **Reminder Task**, and at most one **Escalation**
- A submission made after the **Reminder** but before the **Escalation** cancels the Escalation and closes the **Reminder Task**
- Every user who clocks in is covered; there is no narrowing by group or time clock
- A **Shift** first known of more than 24 hours after it ended (e.g. one an **Admin** adds for a past day) is not checked: no **Reminder**, no **Escalation**
- Editing a **Shift** already checked (new times, or a break added that splits it into new **Shift Segments**) does not start a second check

## Example dialogue

> **Dev:** "If they submit during the **Grace Period**, do we still send a **Reminder**?"
> **Domain expert:** "No: it isn't a **Missed Form** until the **Grace Period** ends with nothing submitted."
> **Dev:** "And if they submit after the **Reminder** went out?"
> **Domain expert:** "Then there's no **Escalation**, and the **Reminder Task** closes."
