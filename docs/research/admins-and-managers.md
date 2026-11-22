# Research: listing Admins and finding a user's direct manager

Ticket: #5 "Can we list every Admin and find a user's direct manager?"
Researched 2026-10-18 from Connecteam's API reference and help center, plus code
in the sibling EH_Webhook project. No live API calls were made.

## Short answer

- **Admins: yes.** `GET /users/v1/users` returns every user with a `userType`
  field whose values are `user`, `manager`, `owner`. In the API, `manager` is
  what the Connecteam app and our glossary call an **Admin**; `owner` is also an
  admin (the top level). There is no server-side filter on `userType`, so we page
  through all users and filter on our side.
- **Direct manager: yes, when the account has one set.** "Direct manager" is a
  user custom field of type `directManager`. Its value on a user is the
  manager's Connecteam `userId`.
- **Does the account use direct managers?** Ask
  `GET /users/v1/custom-fields?customFieldTypes=directManager`. No field means
  the account doesn't use them. A field that exists but is blank on a user means
  that user has no direct manager.

## Findings

### 1. `userType` identifies Admins; `manager` means Admin

The `User` schema in the Get users reference has `userType`, typed by the enum
`UserType = ["user", "manager", "owner"]`. Its description treats `manager` and
"admin" as the same thing:

> "The type of the user is 'user' by default. To promote a user to 'admin',
> first create the user and then use the users/v1/admins endpoint to send an
> invite by mail. On edit (PUT /users), only 'manager' <-> 'owner' transitions
> are supported via this field; transitions that cross the user/manager boundary
> are rejected with 400 and must go through the /admins endpoint."

The same schema says `email` is "mandatory for managers and owners".

Source: <https://developer.connecteam.com/reference/get_users_users_v1_users_get>
(the OpenAPI definition embedded in the page; schemas `User`, `UserType`).

The help center describes three user types: **User** (no special permissions),
**Admin** (star icon; "Admins do not have access to anything on the platform
automatically, as they must be granted admin permissions by existing admins or
owners"), and **Owner** (crown icon; "automatically assigned to all system
settings, features, assets, capabilities, and groups").

Sources: <https://help.connecteam.com/en/articles/8390681-user-types-on-connecteam>
(updated 2024-09-04); <https://help.connecteam.com/en/articles/1990076-owner-vs-admin>
(updated 2026-03-16).

**So the Admin set is `userType in ("manager", "owner")`.** Confidence: high for
the mapping. Confirming it against a test account's real data is still worth
doing (see Gaps).

### 2. Listing every user: paging, archived users, no type filter

`GET /users/v1/users` query parameters: `limit` (default 10, max 500), `offset`,
`sort` (only `created_at`), `order`, `userIds`, `userStatus` (enum `active`,
`archived`, `all`; **default `active`**), `fullNames`, `phoneNumbers`,
`emailAddresses`, `createdAt`, `modifiedAt`, `lastLogin`, `archivedAt`.

There is **no `userType` filter**. To list Admins, page through
`GET /users/v1/users?limit=500&offset=…` and keep the `manager`/`owner` rows. At
500 per page that is one call for most accounts, so it fits the light shape.
The default `userStatus=active` already leaves out archived admins, which is
what we want for Escalation recipients.

Response shape: `{ data: { users: User[] }, paging: { offset } }`. EH_Webhook
reads `data.users` the same way (`~/IDP/EH_Webhook/src/connecteam/client.ts`,
`getUser`, which also notes there is no single-user GET, only
`?userIds={id}`).

Other `User` fields that matter here: `isArchived`, `customFields[]`,
`smartGroupsIds[]`, `invitedToBeManager` ("Is the user invited to be a
manager"), `lastLogin`.

Source: Get users reference (above).

### 3. Admin changes: `user_promoted` and `user_demoted` webhooks

The webhook list has **User promoted** and **User demoted** events (plus
created, updated, deleted, archived and restored). The Admin list could be
cached and refreshed on these events instead of fetched for every Escalation.
That is optional: one paged GET per Escalation run is cheap.

Not related, despite the name: the **Manager Field Updated** webhook is about
form-submission "manager fields" (`FormSubmissionManagerFieldsResponse`), not
the direct manager.

Source: webhook definitions in the same embedded OpenAPI document, and
<https://developer.connecteam.com/reference/user_promoted_eventuser_promoted_post>.

Promotion goes through `POST /users/v1/admins` (body `userId`, `email`,
`title`), which "sends an invitation link ... Once the user acknowledges the
email, the user will become an admin of the account."
Source: <https://developer.connecteam.com/reference/invite_admin_users_v1_admins_post>.
So a user who has been invited but has not accepted yet probably still has
`userType: "user"` with `invitedToBeManager: true`, and is not an Admin yet.
(Inferred, not verified.)

### 4. Direct manager is a `directManager`-type custom field

The custom field type enum `UserCustomFields` is `email, date, phone, number,
str, dropdown, file, directManager, birthday, link, location`. Each user's
`customFields[]` entry is `{ customFieldId, value, type, name }`
(`CustomFieldResponse`).
Source: Get users reference (schemas `UserCustomFields`, `CustomFieldResponse`).

`GET /users/v1/custom-fields` "Retrieves all custom fields associated with the
account. Optionally, filter the results by categories, names, types, or custom
field IDs." It has a `customFieldTypes` filter that takes the same enum, so
`?customFieldTypes=directManager` returns just the direct-manager field(s).
It is paginated (default 10, max 500).
Source: <https://developer.connecteam.com/reference/get_custom_fields_users_v1_custom_fields_get>.

The help center describes the Direct Manager as a custom field an admin assigns
per employee in User Details. Once it is set, it can drive Smart Groups, chat
permissions and directory permissions.
Source: <https://help.connecteam.com/en/articles/6668957-how-to-assign-a-direct-manager-to-your-employees>
(2024-09-04); see also
<https://help.connecteam.com/en/articles/10634540-why-should-i-set-up-direct-managers-for-branches-and-departments>
(2025-02-27).

**Value shape from real data.** EH_Webhook reads this field in production code:

- `~/IDP/EH_Webhook/docs/field-mapping.md`: "`directManager` → `int` (a
  Connecteam `userId`)".
- `~/IDP/EH_Webhook/test/fixtures/demo-custom-fields.ts`: the demo account's
  live `GET /users/v1/custom-fields` (fetched 2026-10-03) includes
  `f(25145114, "Direct manager", "directManager")`. Its id sits next to
  built-in-looking fields such as `Title` (25145108), which suggests Connecteam
  creates the field with the account, though this hasn't been confirmed.
- `~/IDP/EH_Webhook/src/sync/cycles.ts` `directManagerUserId()` reads the
  value. It **hard-codes the field id** (`DIRECT_MANAGER_FIELD_ID = 25145114`),
  which only works for that one account. It also accepts a number, a numeric
  string, a single-element array, or `{ value }`, as a defensive measure.
- `~/IDP/EH_Webhook/src/sync/consumer.ts` sends the Escalation DM to that id
  with `sendDirectMessage(managerId, …)` (the `POST
  /chat/v1/conversations/privateMessage/{userId}` endpoint), with a de-dup claim
  for each recipient.

**For this project:** don't hard-code the id. Find the field at setup (or on
each run) by `type === "directManager"`, not by its name or id, and read each
user's value from `customFields` on the user record we already fetch.

### 5. "Does this account use direct managers?" decision rule

1. `GET /users/v1/custom-fields?customFieldTypes=directManager`:
   - **no rows** means the account doesn't use direct managers, so the
     Escalation goes to Admins only.
   - **one or more rows**: the field exists.
2. For the employee with a Missed Form, find the `customFields` entry with
   `type === "directManager"`:
   - missing, null or blank: no direct manager for this user, so Admins only.
   - a userId: also DM that user. If the manager is also an Admin, send one DM,
     not two.

Because the field might exist in an account but be filled in for nobody, step
2 is the deciding check. Step 1 is useful mainly at setup, to report whether
direct managers are in use.

## Gaps to check against a test account

1. **`userType` values on real admins.** Confirm an Admin returns `"manager"`
   and the account creator returns `"owner"`, and check what an invited but
   not yet accepted admin returns (`userType`, `invitedToBeManager`).
2. **Does the default page include admins?** Check that `GET /users/v1/users`
   (with `userStatus=active` by default) lists managers and owners alongside
   users, and that the API key's permissions don't hide any.
3. **Direct manager value when blank**: is the entry missing from
   `customFields`, or is it present with `null` / `""` / `[]`?
4. **Can there be more than one `directManager` field**, and can a single field
   hold several managers? The docs don't say. EH_Webhook's array handling is
   defensive and not based on observed data.
5. **Is the field built in or created per account?** Does a fresh account
   already have "Direct manager", or does the client create it?
6. **Must the direct manager be an Admin?** The help center doesn't say. If a
   plain user can be a direct manager, the Escalation DM still works (any
   userId can receive a private message), but the design should decide whether
   that's acceptable.
7. **Admins with limited permissions.** Admin access is per feature and per
   user. An Admin who doesn't have the time clock or this employee in scope
   still gets the Escalation under the glossary's "any user with an admin role"
   definition. That's a product decision rather than an API gap, but worth
   raising.
