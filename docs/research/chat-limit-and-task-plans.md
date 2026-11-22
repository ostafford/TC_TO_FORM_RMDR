# What do chat and Quick Tasks show the employee, and which plans have Quick Tasks?

Research for #127 (Spec #19, "Check at build", Chat and Quick Tasks), 2026-11-22. Docs only: nothing was sent or created on the demo account. It builds on the earlier research for #4, [chat-and-quick-tasks.md](chat-and-quick-tasks.md) (2026-10-18).

## Answers

| Question | Answer | How verified |
| :-- | :-- | :-- |
| The real chat limit: 500 or 1,000 characters | **The docs disagree.** The Private Messages and Chat overview guides say 1,000 ("max 1000 chars"; "Max message length: 1000 characters"), and the OpenAPI schema has `maxLength: 1000`, but the same schema's description says "less than 500 characters" (found in the #4 research). The Worker writes to 500 (`MAX_MESSAGE`, and the client clamps at 500), which fits either reading. | **Per docs, not tested.** A live test (DMs of 500, 501 and 1,000 characters to a `[research]` user) was judged not worth the writes: the Worker already stays at 500, so no answer changes the code. |
| Which plans include Quick Tasks | **Every plan this integration can run on.** Quick Tasks are in the Operations Hub, on every paid tier (Basic, Advanced, Expert, Enterprise) and on the free Small Business plan. API access, which the integration needs, starts at Expert, and the wizard already refuses anything below it. Some task features are capped on lower tiers (tags, sub-tasks); the integration uses neither. | **Per docs, not tested**: Connecteam's pricing page (no date shown, read 2026-11-22). The Quick Tasks help article doesn't mention plans. |
| Whether a URL in a DM or a task description shows as a link | **Not needed.** Messages never carry a link: the Spec's fixed wording says "where to find it, never a link". (The #4 research found the API is plain text only, with no link field.) | Dropped. |
| Whether emoji and line breaks show as expected | **Line breaks in chat: kept.** EH_Webhook relies on `\n` in production DMs, per the #4 research. **Emoji in chat, and both in a Quick Task description: open.** Task descriptions come back as HTML (`{ type: "html", html }`), so how a plain-text `\n` shows there is unknown. | Chat line breaks: **seen in production** (EH_Webhook), not tested here. The rest **needs a person** to look in the app, on a phone and on the web. |
| Whether an API-created published task sends the employee a push notification | **Open.** Reopening a task through the API does push one (tested live 2026-10-24, #28); creating one hasn't been checked. | **Needs a person** with the app on a phone. |

## What it means for the Worker

- **No code change.** Every message stays at or under 500 characters, which fits both readings of the limit. Every account the wizard accepts (Expert or above) has Quick Tasks, so the Reminder Task step needs no plan warning.
- The open questions are about what the employee sees, not what the Worker does. If emoji or line breaks render badly in a Reminder Task, or a new task doesn't notify, the fix is in the wording, or in leaning on the Reminder DM, not in the logic.

## Sources

- Private Messages: https://developer.connecteam.com/docs/chat-private-messages.md
- Chat overview: https://developer.connecteam.com/docs/chat-overview.md
- The #4 research (OpenAPI `ConversationPostMessageRequest.text`, line breaks, task description shape): [chat-and-quick-tasks.md](chat-and-quick-tasks.md).
- Pricing: https://connecteam.com/pricing/ (Operations Hub, "includes ... Quick Tasks"; "API access" listed at Expert).
- Quick Tasks starting guide: https://help.connecteam.com/en/articles/6690969-quick-tasks-starting-guide (no plan information).

## Demo-account changes

None.
