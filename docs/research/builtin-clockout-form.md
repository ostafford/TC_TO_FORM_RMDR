# What Connecteam's built-in clock-out form already does

Research for [#7](https://github.com/ostafford/TC_TO_FORM_RMDR/issues/7). Sources read 2026-10-18: Connecteam Help Center (help.connecteam.com) and the official API docs (developer.connecteam.com). No live API calls were made.

## Short answer

Connecteam has **no built-in way to require a Forms-app form at clock-in or clock-out.** Its own help center says so and points to a workaround: a required **Shift Entry** (also called a Shift Attachment) on the time clock, typically a dropdown like "Have you completed the form? Confirmed / Unable to confirm". That blocks a manual clock-out until the employee picks an answer, but it only records the employee's word: nothing checks that a **Compliance Form** submission exists. That gap is the one this integration fills.

## Findings

### 1. A Forms-app form cannot be attached to the time clock or to a job

- "you cannot directly use a Form as a shift attachment within the Time Clock feature at the moment." The article suggests adding a Shift Attachment such as "Have you completed the form?" and tells admins to vote for the feature request. ([Can I Use a Form as a Shift Attachment?](https://help.connecteam.com/en/articles/10253753-can-i-use-a-form-as-a-shift-attachment), updated 2024-12-18)
- "Although it's not possible to directly attach a form to the specific job the employee is clocking into", the recommended workaround is a required dropdown Shift Entry with options like "Confirmed" / "Unable to Confirm". ([How Can I Set Requirements for Completing a Form Before Clocking Out?](https://help.connecteam.com/en/articles/9293586-how-can-i-set-requirements-for-completing-a-form-before-clocking-out), updated 2025-08-31)
- A form *can* be linked to a **Scheduled Shift** in the Job Scheduler (Attach icon, then Shortcut, then Form), so the employee can open it from the shift's details. Nothing in the article says this is required or enforced; it is a convenience link. ([Can I Attach a Form to a Job?](https://help.connecteam.com/en/articles/9051841-can-i-attach-a-form-to-a-job), updated 2024-09-04; [I Created A Form - Can It Be Attached To Other Places?](https://help.connecteam.com/en/articles/8352393-i-created-a-form-can-it-be-attached-to-other-places-in-connecteam), updated 2024-09-04)

### 2. What Shift Entries are, and what is enforced

- Shift Entries are set in Time Clock, then Settings, then the **Shift Entries** tab. The **Clock In** section is about picking a resource (job), "Flexible" or "Fixed" per device. The **"During shift or before clocking out"** section holds the custom fields. ([Shift Entries](https://help.connecteam.com/en/articles/1441916-shift-entries), updated 2026-07-29)
- Field types: dropdown list, text box, number, image attachment, file attachment, signature. "Every field can be marked as required, such that users must complete them before clocking out." (same article)
- **Enforced at clock-out only.** If the employee tries to end the shift without completing a required field, "they won't be able to complete their shift, and the field will be highlighted in red." The same applies to a required signature (article 9293586; [Can My Employees Sign Off for Every Clock In & Out?](https://help.connecteam.com/en/articles/9639512-can-my-employees-sign-off-for-every-clock-in-out), updated 2025-08-31). Despite its title, the signature article describes only a clock-out requirement. No source describes a required custom field at clock-in beyond the job picker.
- **Scope: per time clock, not per job.** "The shift entries will be available to complete for all employees assigned to the Time Clock." Nothing in the docs sets fields per job or sub-job. (Shift Entries article)
- **Plan limits:** "Adding up to 2 shift entries is available on the Advanced Plan and unlimited in the Expert Plan." (Shift Entries article). Accounts below Advanced appear to have none. This is inferred from that sentence; check against the pricing page if it matters.

### 3. Ways round the requirement (where it is skippable)

- **Auto clock-out bypasses it.** "If your organization uses auto clock-out functionality, shift attachments will not activate, and employees won't receive notification messages." (article 10253753). The time activity carries `isAutoClockOut: true` and the webhook has a separate `auto_clock_out` event (API section below).
- **Admin clock-in/out bypasses it.** When an admin adds a clock-in on a user's behalf, the employee can't clock out themselves; the admin types the End time, and shift attachment values are optional in that row. ([How Admins Can Clock In on Behalf of Their Employees](https://help.connecteam.com/en/articles/9414409-how-admins-can-clock-in-on-behalf-of-their-employees), updated 2025-10-26)
- **Retroactive fill.** "If users forgot to submit shift entries when clocking out, admins can manually add them retroactively, directly in the users' timesheets." (Shift Entries article). This confirms a shift can end up with required entries empty.
- **Self-attestation only.** Even when enforced, the employee just picks "Confirmed". Connecteam does not compare that answer with Forms submissions. The compliance check the help center suggests is manual: export the timesheet report with the attachment columns, or review each timesheet. (article 10253753)
- Not covered by any source: whether kiosk or offline clock-outs enforce required entries. Shifts created via the API cannot carry entries at all (next section).

### 4. What the API exposes

- **Read the definitions:** `GET /time-clock/v1/time-clocks/{timeClockId}/shift-attachments` (scope `time_clock.read`) returns each entry's `id`, `type` (`freeText | dropdownList | number | image | file | signature`), `name`, `isRequired`, `isEnabled`, and for dropdowns the `items` (`id`, `name`, `isEnabled`). ([Get shift attachments](https://developer.connecteam.com/reference/get_shift_attachments_time_clock_v1_time_clocks__timeclockid__shift_attachments_get), schema `ShiftAttachmentsGetResponse`)
- **Read the values per Shift:** each shift from `GET .../time-activities` has `shiftAttachments: [{ shiftAttachmentId, attachment: { itemId | freeText | number | fileName/fileUrl | files | images ... } }]`, plus `isAutoClockOut`. ([Time Activities](https://developer.connecteam.com/docs/time-clock-time-activities); schema `GeneralActivityShiftAttachmentResponse`)
- **Webhook:** the time-activity webhook sends `clock_in`, `clock_out` and `auto_clock_out` events. The `clock_out` payload includes `shiftAttachments`; the `clock_in` payload does not. ([Time activity webhook](https://developer.connecteam.com/docs/time-activity-webhook-1))
- **No write and no settings control:** the create-shift fields documented are `start`, `end`, `jobId`, `subJobId`, `employeeNote`, `managerNote`, with no `shiftAttachments`. No endpoint is documented to create, edit or require a Shift Entry, or to link a time clock to a form. (Time Activities docs)
- **No link to Forms:** the docs loosely describe `shiftAttachments` as "Attached data (forms, files, etc.)", but the documented type enum has no form type. Form submissions are a separate API (Forms, then Form Submissions) with their own webhook; nothing joins them to a Shift.

## What this means for the integration

- The built-in option is a **self-declared checkbox at manual clock-out**, set per time clock, for paid plans. It is skipped by auto clock-out and by admin entry, and it never checks that a real form was submitted.
- The Clock-out Form Reminder fills these gaps: it checks for an **actual Compliance Form submission** per Shift, covers auto clock-outs and Shifts still open (the Grace Period rule), and follows up with a Reminder and an Escalation, where Connecteam only blocks the button.
- The two can sit side by side. A Deployment could read the shift-attachment definitions and values (read-only) to report "claimed Confirmed but no submission", if the spec wants that. Not required.

## Gaps to check in a real account

1. Kiosk and offline clock-outs: are required entries enforced there?
2. Whether a required Shift Entry blocks clock-out by routes other than the app's clock-out button (e.g. a geofence or NFC clock-out request).
3. Exact plan gating (Basic: zero entries?) against the live pricing page.
4. The real `shiftAttachments` value shape for a dropdown in a `clock_out` webhook (the docs example shows only the `files` variant).
5. Whether linking a form to a Scheduled Shift (Shortcut) leaves any trace in the Scheduler API (`attachments` on the shift), which might help find the expected form per shift.
