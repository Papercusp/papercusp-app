# Papercup chat: one component, one contract — where it lives, how a host mounts it
URL: /internal/docs/agent-insights/papercup-chat-one-component-one-contract

The shared PapercupChat view and controller contract used by the portal shell and Tauri desktop, including host responsibilities, trust boundaries, D-011 identity/timestamp rules, and retired duplicate renderers.

## What is canonical

Papercup chat has one renderer and one host contract:

* `packages/operator-ui/src/papercup-chat/PapercupChat.tsx` exports `PapercupChat`, the host-free view.
* `packages/operator-ui/src/papercup-chat/use-papercup-chat.ts` exports the transport-backed `usePapercupChat` implementation for hosts that do not already own a conversation store.
* `packages/operator-ui/src/papercup-chat/index.ts` is the public seam; `PAPERCUP_CHAT_CSS` is injected once by the host.
* `@papercusp/chat-protocol` owns the turn/event wire types and `@papercusp/chat-cards` owns shared card renderers.

The former operator-local `ChatConversation` renderer is deleted. The portal's `AskPapercupPanel`/`AskPapercupPanelView` renderer is retired. Do not add a third transcript implementation or import the deleted operator path. Provider message types belong in the operator's `chat-types.ts`; host-only identity marks belong in `chat-agent-marks.tsx`.

## How a host mounts it

1. Choose the state owner. A new host normally implements `PapercupChatAdapter` and calls `usePapercupChat({ adapter, conversationId })`. The operator is the intentional exception: `OperatorConversationProvider` already owns persisted history, live-tail reconciliation, proactive/voice turns, card answers, and busy state, so `OperatorChat` adapts that state into a `PapercupChatController` and must not start a second hook/store for the same conversation.
2. Mount `<PapercupChat chat={controller} hostTrust="public" | "owner" ... />`. Inject `PAPERCUP_CHAT_CSS` and theme the `--pc-chat-*` variables.
3. Supply host seams only through props: navigation (`onWorkRefActivate`, `harnessSlug`/`planSlug`), action bars and composer chrome, local cards, report/card render overrides, identity/avatar rendering, and banners/footers. The shared view owns transcript layout, markdown trust rules, timestamps, and card placement.
4. Keep the backend contract on the shared protocol. Both hosts speak the converse conversation model through their appropriate host boundary; host trust controls capability disclosure and tool/ref/image behavior, not a second renderer.

## D-011 visual contract

The Papercup mark carries visible assistant identity; do not add a visible `Papercup` wordmark or role label beside it. Preserve accessible names/tooltips for assistive technology. Message timestamps are semantic `<time>` elements rendered inline to the left of the bubble: same-local-day turns show `HH:MM`; older turns show `Mon D · HH:MM`, while `dateTime`/`title` retain the full instant.

## Verify a change

Run the shared view/protocol suites and the operator adapter suites that cover the host seams, then run the operator TypeScript lint. The parity guard at `packages/operator-ui/src/papercup-chat/parity-matrix.test.ts` must remain green; it records the retired portal rows and the ported operator behaviour against `PapercupChat`.
