# What userType is an Admin, and what shapes can the direct manager field take?

Research for #128 (Spec #19, "Check at build", Users and managers), 2026-11-22. Run against the demo account under `int_MCP`'s rules, with the research key through `int_MCP/scripts/ct.sh`.

## Answers

| Question | Answer | How verified |
| :-- | :-- | :-- |
| An Admin's `userType` | `manager`. The API reference's `UserType` enum is exactly `user`, `manager`, `owner`, and the guides call the role "Admin (Manager)". | **Per docs, not tested.** The demo account has no Admin (2 `owner`, the rest `user`), and testing it means promoting a user, which sends an invite that must be accepted. |
| A blank direct-manager value | **No entry at all.** A user with no direct manager comes back with `customFields: []`, with no `directManager` entry in it, from both `?userIds=<id>` and `?userIds=<id>&userStatus=all`. An archived user with no fields set also has `customFields: []`. | **Tested live (2026-11-22)**, on a `[research]` user created without a direct manager. |
| A set direct-manager value | A single number, the manager's `userId`: `{customFieldId, name: "Direct manager", type: "directManager", value: <userId>}`. | **Tested live (2026-11-22)**: all 10 users who have one. The guides agree: "The ID of the DM user". |
| More than one `directManager` field | **Possible.** "Direct manager" is one of the field types an account can create ("email/date/number/text/phone number/file/direct manager"). | **Per docs, not tested.** The demo account has exactly one. |
| Several managers in one field | Not seen, and not documented: the value is one user id. | **Tested live (2026-11-22)** that every value is a single number. Whether the app can set more is untested. |
| Built in, or created per account | The demo account's field looks built in: its id sits in the block created with the account, next to Title, Employment Start Date, Birthday, Gender and Street Address. Unlike several of those, it has no `specialType`. | **Tested live (2026-11-22)** as to what's there. "Built in" is an inference from the ids, not stated anywhere. |
| Must a direct manager be an Admin | **No.** The update guide says only that the value "must reference a valid and active user". | **Per docs, not tested.** On the demo account every direct manager happens to be an owner. |

## What it means for the Worker

- **Admins are escalated to correctly, per docs.** `isAdmin` (`src/escalation/recipients.ts`) takes `manager` and `owner`, which matches the enum. It's still untested live.
- **A blank direct manager is already handled.** `directManagerId` finds no `directManager` entry and returns `null`, so the Escalation goes to Admins only, as the Spec says.
- **A second `directManager` field isn't handled.** `directManagerId` reads the first `directManager` entry it finds. An account with two such fields (say "Direct manager" and "Site manager") would escalate to whichever comes first. The Spec doesn't say what should happen; see the follow-up issue linked from #128.
- **A direct manager who isn't an Admin** is still escalated to, which is what the Spec asks: they're added as the direct manager, not as an Admin.

## Sources

- API reference, Get users: https://developer.connecteam.com/reference/get_users_users_v1_users_get.md (the `UserType` enum).
- Create users: https://developer.connecteam.com/docs/create-users-data.md ("three main user types in the system: Owner, Admin (Manager), and User"; "Direct Manager: The ID of the DM user"). It also says "our API supports 'user' and 'admin' types only", which contradicts the enum and the update guide; the enum is taken as authoritative.
- Update users: https://developer.connecteam.com/docs/update-users-data.md ("the API supports 'user' and 'manager' types only"; the direct manager "must reference a valid and active user").
- Create custom fields: https://developer.connecteam.com/docs/create-custom-fields.md (the creatable types, including "direct manager").
- Live: `GET /users/v1/users?limit=500&userStatus=all`, `GET /users/v1/custom-fields?limit=100`.

## Demo-account changes

- **Created:** one user, "[research] No manager", userType `user`, with a phone number from Australia's range reserved for fiction (+61 491 570 156). No activation SMS (`sendActivation` not set), so nobody was notified.
- **Deleted:** that user, permanently (`DELETE /users/v1/users/{id}?deletionType=delete`). A lookup with `userStatus=all` then returns no user.
- Nothing else was changed.
