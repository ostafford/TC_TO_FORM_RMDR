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

**Grace Period**:
The configurable wait after clock-out before checking for a submission. A submission counts if it arrives between clock-in and the end of the Grace Period.

**Missed Form**:
A Shift whose Grace Period has ended with no Compliance Form submission from that user.

**Reminder**:
The chat direct message sent to the employee when a Missed Form is found.

**Reminder Task**:
An optional Connecteam Quick Task assigned to the employee for a Missed Form, which closes once the form is submitted.
_Avoid_: quick task (on its own, it's ambiguous with any other Quick Task)

**Escalation**:
The notice sent to the employee's direct manager and the Deployment's admins when a Missed Form is still unsubmitted after a further configurable delay.

## Relationships

- A **Shift** has at most one **Missed Form**
- A **Missed Form** produces one **Reminder**, an optional **Reminder Task**, and at most one **Escalation**

## Example dialogue

> **Dev:** "If they submit during the **Grace Period**, do we still send a **Reminder**?"
> **Domain expert:** "No: it isn't a **Missed Form** until the **Grace Period** ends with nothing submitted."
