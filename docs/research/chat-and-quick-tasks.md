# Research: chat DMs and Quick Tasks (issue #4)

**Question.** (a) Can we send a chat direct message to one user, and within what formatting limits (length, links, line breaks)? (b) Can we create a Connecteam Quick Task assigned to one user for the **Reminder Task**, then close or delete it later by id? Can a Quick Task link to the **Compliance Form**?

**Short answer.** (a) Yes. (b) Yes: create, complete and delete all work by task id. But the API has no way to put a link to the form into a Quick Task: form shortcuts can only be added by an Admin in the Connecteam UI. A Reminder Task can only name the form in plain text.

Researched 2026-10-18 from Connecteam's developer docs (pages fetched as Markdown via `developer.connecteam.com/llms.txt`, including the OpenAPI JSON embedded in each reference page) and the Connecteam help center. No live API calls were made. Items marked **live check** need a test against the developer's own account before the spec relies on them.

## (a) Chat direct messages

### Endpoint

`POST https://api.connecteam.com/chat/v1/conversations/privateMessage/{userId}` with body `{ senderId, text, attachments? }`. `senderId` is a **custom publisher** id (an integer), not a user. The message appears as coming from that publisher. If a private conversation between the publisher and the user already exists, the message goes into it. Otherwise one is created. Success returns `{ requestId, data: {} }`. There is no message id to keep.
- Sources: [Private Messages guide](https://developer.connecteam.com/docs/chat-private-messages.md) (updated 2026-01-28); [Send private message reference](https://developer.connecteam.com/reference/send_message_to_private_conversation_chat_v1_conversations_privatemessage__userid__post.md) (updated 2026-05-31).
- Custom publishers are created by an Admin in **Settings → Feed settings**, which gives the publisher id. Each Deployment therefore needs a setup step to create or choose a publisher, and its id becomes a Deployment value. Source: [Custom Publishers guide](https://developer.connecteam.com/docs/chat-custom-publishers.md).
- Scope `chat.write` (OAuth). An API key covers it. Source: [Chat overview](https://developer.connecteam.com/docs/chat-overview.md).
- Documented errors: 404 `User not found`, `User is suspended`, `Sender id not found`, and 400 when `text` is empty. The spec has `422` for validation. Source: Private Messages guide.
- Proven in production: EH_Webhook's `ConnecteamClient.sendDirectMessage` (`/Users/okky.stafford/IDP/EH_Webhook/src/connecteam/client.ts`, lines 100-107) calls exactly this endpoint, and its header comment says it was verified against the live API. It returns `{ outcome: "ok" | "retryable" | "error" }` and never throws, per the playbook. sch_import's `postChatMessage` (`/Users/okky.stafford/IDP/sch_import/packages/shared/src/connecteam/client.ts`, lines 257-274) uses the sibling channel endpoint `/chat/v1/conversations/{id}/message` with the same body shape. It confirms that `senderId` must be sent as a JSON number and that the response is an empty object.

### Length

**The docs contradict themselves. Design for 500 characters.**
- The OpenAPI schema `ConversationPostMessageRequest.text` has `"maxLength": 1000`, and its own description says *"Must be in UTF-8 and less than 500 characters."* (send private message reference).
- The Chat overview and Private Messages guides say "max 1000 chars".
- Both IDP clients use 500: EH_Webhook clamps every message to 500 (`MAX_TEXT = 500`, `client.ts` line 33; `MAX_LEN = 500` in `/Users/okky.stafford/IDP/EH_Webhook/src/sync/messages.ts`), and sch_import says "keep `text` well under 500 chars".
- Recommendation: keep the **Reminder** and **Escalation** templates under 500 characters, including any personalised parts (names, shift times), and clamp in the client as EH_Webhook does. **Live check (optional):** send a 501-1000 character message to learn whether the real limit is 500 or 1000. This only matters if the wording ticket wants long messages.
- Whether the limit counts characters or bytes is not documented, so stay well under it when using emoji or non-Latin text.

### Line breaks

- `\n` line breaks are kept. EH_Webhook relies on this in production: *"Connecteam chat keeps line breaks, and without the gap a message reads as one block"* (`/Users/okky.stafford/IDP/EH_Webhook/src/sync/messages.ts`, around line 255). It separates sections with `\n\n` and uses `• ` bullets joined by `\n`. The developer docs say nothing about line breaks. Confidence: high (evidence from live use).

### Links and formatting

- **The API is plain text only.** `text` is a plain string. The schema has no field for markup, rich text or link text. Source: send private message reference.
- In the UI, chat supports bold/italic/underline/strikethrough, lists, and hyperlinks on chosen words. Those are editor features, and nothing shows the API reads Markdown or HTML. Source: help center [Messaging Tools](https://help.connecteam.com/en/articles/9099879-messaging-tools) (2026-09-17).
- **Whether a bare URL in API-sent text turns into a clickable link is undocumented.** EH_Webhook never sends one: it tells users where to go in words (`profilePath`, e.g. "Profile > Personal Information"; see `/Users/okky.stafford/IDP/EH_Webhook/clients/self/README.md`). **Live check needed** if the Reminder wants a link. Also, the Forms API returns no form URL or deep link (`FormResponse` fields: `formId, formName, createdAt, lastUpdatedAt, questions, settings`; [Get forms reference](https://developer.connecteam.com/reference/get_forms_forms_v1_forms_get.md)). So even a clickable URL would have to be copied from the Connecteam UI at setup, if the app has such a link at all. The safe default for the wording ticket is to **name the Compliance Form and say where to find it** ("open Forms and submit *Daily Vehicle Check*"), as EH_Webhook does.
- Attachments: images and one file per message, uploaded first via the Attachments API (`featureType: chat`). The Reminder is unlikely to need them. Source: Chat overview.

### Rate limits (affects Escalation fan-out)

- Per **account**, not per key: SBP 5/min and 100/day; Expert 100/min and 10,000/day; Enterprise 200/min and 20,000/day. Going over returns HTTP 429. The headers `x-ratelimit-minute-remaining` / `-day-remaining` / `-reset` are returned. Source: [Rate limiting](https://developer.connecteam.com/docs/rate-limiting-1.md) (2026-01-28).
- One DM is one call. An Escalation to *N* Admins plus a direct manager costs N+1 calls, and the client's other integrations share the same budget. On SBP, 100 calls a day is tight. That matters to the architecture ticket.

## (b) Quick Tasks for the Reminder Task

### Create

`POST /tasks/v1/taskboards/{taskBoardId}/tasks`. Required fields: `userIds` (integer array), `status` (`draft` | `published` | `completed`), `title`. Optional: `startTime`, `dueDate` (Unix **seconds**), `labelIds`, `type` (`oneTime` by default), `isArchived`, `subTasks`, `description: { content, attachments? }`. The response `data` contains the task `id` (**a string**, e.g. `680e0f66cdbaf2dd5d47bae7`), which we store in order to close the task later.
- **One user means an individual task.** More than one `userId` makes a single *group* task, so each Missed Form gets its own call with `userIds: [employeeId]`.
- Send `status: "published"` so the employee sees it (a draft is not shown to assignees).
- Sources: [Create task reference](https://developer.connecteam.com/reference/create_task_tasks_v1_taskboards__taskboardid__tasks_post.md); [Managing Tasks guide](https://developer.connecteam.com/docs/tasks-managing-tasks.md); [Tasks overview](https://developer.connecteam.com/docs/tasks-overview.md) (2026-01-28).
- **A task board id is required.** `GET /tasks/v1/taskboards` returns `{ id, name, isArchived }` for each board ([Task Boards guide](https://developer.connecteam.com/docs/tasks-task-boards.md)). The wizard must have the person choose a board, and that board id becomes a Deployment value. Creating tasks on archived boards "may be restricted". The OpenAPI types `taskBoardId` as a string in the path, while the guide shows integers. Either works in a URL.
- Scopes: `quick_tasks.write` to create and update, `quick_tasks.delete` to delete, `quick_tasks.read` to list.

### Close or delete by id

Both work from the stored `taskBoardId` + `taskId`:
- **Close (mark done):** `PUT /tasks/v1/taskboards/{taskBoardId}/tasks/{taskId}` with `status: "completed"`. **Watch out:** `UpdateTaskRequest` requires `userIds`, `status` and `title` on every update. It is a full replace, not a patch, and new attachments replace the old ones. So we must resend the same `title` and `userIds`, which means storing them alongside the task id or reading the task back first (`GET .../tasks?taskIds=<id>`). Source: [Update task reference](https://developer.connecteam.com/reference/update_task_tasks_v1_taskboards__taskboardid__tasks__taskid__put.md); the guide's "Complete a Task" example sends exactly those three fields.
- **Delete:** `DELETE /tasks/v1/taskboards/{taskBoardId}/tasks/{taskId}` returns `{ data: {} }`, or 404 `Task not found`. Source: [Delete task reference](https://developer.connecteam.com/reference/delete_task_tasks_v1_taskboards__taskboardid__tasks__taskid__delete.md).
- Product choice for the grilling/architecture tickets: **completing** leaves a done task in the employee's list and the board's history. **Deleting** removes every trace. Completing seems to match the glossary's "closes".
- Idempotency (playbook rule for retries): the PUT that sets `completed` is safe to repeat. A repeated DELETE probably 404s, which should count as success. A **create is not idempotent**: a retried create makes a second task. The task id must be stored right after the create, and a retry must check for a stored id before creating again (or look one up with `GET ...?userIds=` and a recognisable title or label).

### Can the Reminder Task link to the form?

**Not through the API.**
- The UI can attach a form to a task as a **shortcut**. The help center even gives the example "Attach an 'End of shift' form to a task" ([I created a form, can it be attached to other places?](https://help.connecteam.com/en/articles/8352393-i-created-a-form-can-it-be-attached-to-other-places-in-connecteam), 2024-09-04). But shortcuts are UI-only, added by an Admin, and need the **Expert plan or above** ([What are Shortcuts?](https://help.connecteam.com/en/articles/5937063-what-are-shortcuts), 2026-03-24; [Quick Tasks: Task Description](https://help.connecteam.com/en/articles/6474694-quick-tasks-task-description-and-comment-board), 2024-09-04).
- The API's `TaskDescription` has only `content` (a UTF-8 string) and `attachments` (`fileId`s from the Attachments API with `featureType: quicktasks`). It has no shortcut, form-id or link field. Source: create task reference schema `TaskDescription` / `TaskAttachment`.
- When tasks are read back, descriptions come back as `{ type: "html", html }` (`HTMLDescription` in the get-tasks schema). So the stored description is HTML, but whether we can *write* HTML or an `<a href>` through `content` is undocumented. **Live check:** create a task whose `content` holds a bare URL and an `<a>` tag, then see what the mobile app shows. As with chat, there is no API-provided form URL to put in it anyway.
- Practical answer: the Reminder Task's title and description name the Compliance Form, e.g. title "Submit *Daily Vehicle Check* for your 18 Oct shift". A sub-task checklist item would be optional extra clutter.

### Webhook signal: the employee ticks the task themselves

- The Tasks webhook sends `task_published` and `task_completed` events with `{ id, taskBoardId, title, userIds, status, ... }` (no description). Source: [Tasks webhook guide](https://developer.connecteam.com/docs/tasks-webhook.md).
- The employee can mark the Reminder Task done **without submitting the form**. Ticking the task does not count as a submission. The Escalation decision must use form submissions, never task status. A `task_completed` webhook is optional: at most, it could stop a pointless later close call.

## Gaps for a live check against the test account

1. Real chat length limit: 500 or 1000 characters? (Design for 500 either way.)
2. Does a bare `https://` URL in API-sent chat `text` turn into a clickable link in the mobile app? Does the Connecteam UI give any shareable URL or deep link to a specific form?
3. Does Quick Task `description.content` show a URL, an `<a>` tag, or `\n` line breaks as written, as a link, or escaped?
4. Does the employee get a push notification when a task is created through the API with `status: "published"`? This is not documented. It decides whether the Reminder Task adds anything beyond the DM.
5. Exact responses for closing an already-completed task and deleting an already-deleted task (expected: success and 404), to confirm the retry logic.
6. Is the Quick Tasks feature (and the `quick_tasks.*` API) on every Connecteam plan the client might be on? The docs do not tie it to a plan; shortcuts are Expert+. This bears on the Reminder Task staying off by default.
