# The unified owner Inbox — capture, adapters, reply routing, and the chat popup
URL: /internal/docs/agent-insights/owner-inbox-single-pane-capture-architecture

How an owner-directed ask (from any client — Claude/Codex/OMP, hook or transcript-derived) becomes one Inbox item, how it's answered from that one pane, and how the reply reaches a live asker with authoritative turn-provenance instead of a generic wake.

## What this is

Before this plan, an owner-directed question from an agent could reach the
human through several disconnected paths (a live `ctx.askUser` card, a raw
coord escalation, a Claude `AskUserQuestion` dialog the owner might not be
looking at, a Codex/OMP client with no structured mirror at all) — and there
was no single place to answer all of them, or to know a session was sitting
blocked. `owner-inbox-single-pane-2026-07-17` makes **the Inbox the one pane**
for every owner-gate, regardless of which client raised it, and closes the
reply loop so an answer given from the Inbox reaches the *live* asker with the
same authority as if the owner had answered inline.

The pipeline has four stages. Each is independently useful; together they are
what makes "answer it from the inbox" actually resume the right session.

## 1. Capture — hook-cooperative and transcript-derived (P-001/P-002/P-004)

Two capture paths feed the same event, because not every client cooperates
with hooks the same way:

* **Hook-cooperative (Claude today)**: `apps/operator/scripts/hooks/cc/ask-gate-mirror.sh`
  is wired via the existing `install-standalone-mcp.sh` merge-function pattern
  (idempotent, alongside `merge_lock_hooks`). A `PreToolUse` mirror captures an
  `AskUserQuestion`/`ExitPlanMode` call (question + options + the asking
  session's id) into a gate event; a `Notification`-hook capture does the same
  for a bare permission-wait. A `PostToolUse` sees the matching `tool_result`
  and auto-resolves the mirror — no polling, the close is driven by the same
  hook family that opened it.
* **Transcript-derived (client-agnostic fallback)**: `gate-watch.ts` tails each
  session's transcript file (same byte-watermark discipline as
  `interactive-usage/ingest-claude-transcripts.ts`, watermarks in their own
  table `session_gate_watcher_files`, migration 619) and detects a gate purely
  from the JSONL shape: an `AskUserQuestion`/`ExitPlanMode` `tool_use` with no
  later `tool_result` in the file = blocked-on-owner; the gate closes the
  moment the matching `tool_result` line appears. This is what covers a client
  with **no turn-end hook** (Codex today — see `role-codex-home.ts`'s header
  gap note) — Claude transcripts are watched first, other client roots are a
  same-shape follow-on once each adapter's tool\_use/tool\_result line format is
  confirmed.

Both paths converge on `gate-store.ts` (`openOrTouchGate` /
`closeGateByToolUseId`), so the attention adapter (stage 2) never needs to
know which capture path produced a given pending gate.

A **non-Claude agent that wants to raise a structured ask directly** (rather
than relying on a client's own dialog + hook mirror) emits the `<ask>{json}</ask>`
wire tag from `libs/generic/chat-protocol/src/index.ts`
(`parseAskTag`/`serializeAskTag`/`AskBlock`) in its final turn text — a
tolerant parser beside the existing `ReportBlock`, unit-tested against
malformed input. This is the P-003/P-004 convention: **any owner-directed
question MUST ride a durable channel** — `coord:escalate` with options
preferred, the `<ask>` block as the floor for a client with neither hooks nor
`coord:escalate` wired.

## 2. Attention adapters — every owner-gate becomes one `AttentionItem` (P-005)

`packages/operator-core/lib/attention/adapters.ts` follows the existing pure-mapper
convention (see [inbox-cards](/agent-insights/inbox-cards)): each source is a
small function from its native shape to `AttentionItem`, I/O stays in the
calling tool. This plan added:

* `needsHumanToAttention` — **every** kind's `needsHuman`/`blocked` work-item
  (not just the `engineer_issues` improvements slice the feed covered before).
* `ownerWallToAttention` — a wall registered via `loop:checkpoint { walls }` or
  a `needs-human`-parked work-item, reusing the same union `coord:walls`
  already reads (no new store) — a `stranded` wall (the raising agent's
  session has since died) is flagged in the body so the owner knows answering
  alone won't resume the work.
* `darkFlagRatificationToAttention` — a `KNOWN_DARK_FLAGS` allowlist entry
  awaiting owner ratification (the dark-flag policy in the root `CLAUDE.md`:
  the allowlist is shrink-only, so every entry is a standing decision).
* the watcher's blocked-session + mirrored-ask sources from stage 1.

D-008 dedupe canonicalization and D-004 tiering (existing conventions this
plan didn't change) still apply across the merged set.

## 3. Reply routing + provenance (P-006)

Resolving an item (picking an option, submitting an Answer) was already
wired end-to-end for the **inbox itself** — but a named-option pick only
resolved the item server-side; nothing told the *asking session* that an
answer had landed, so an agent parked on a live `ctx.askUser` (or waiting on
its own escalation) never woke up. `attention-card.ts`'s
`replyToAttentionItem` (P-006) closes that gap:

1. The existing per-kind resolve path runs first (`resolveEscalation` /
   `answerAttentionItem` / etc. — D-007: no new route class).
2. **When the asker (`item.ownerAgentId`) is LIVE** (`coord:presence`), the
   reply is *also* delivered straight to their coord inbox and they are woken
   — `packages/operator-core/lib/agent-tools/coordination/inbox-reply.ts`,
   reached only via the admin-UI-only `POST /api/admin/coord-inbox-reply`
   route (loopback/verified trust, same posture as `/api/admin/coord/*`).
3. A dead/unknown asker is left untouched by this step — the existing Discuss
   (Papercup) button remains the fallback (D-007) — never a silent drop, since
   the resolve in step 1 already landed regardless.

**The provenance detail (D-006), and why it's security-sensitive**: an inbox
reply is authored by the *authenticated human* through the admin UI — not a
spoofable agent claim — so `inbox-reply.ts` stamps the delivered wake with the
distinguished turn-provenance origin `coord-inject:owner` (see
[turn-provenance-owner-vs-agent](/agent-insights/turn-provenance-owner-vs-agent)),
which downstream persona directive-provenance rules may treat as a genuine
owner directive — unlike an ordinary peer's `coord-inject:<peerId>`.
`coord-inject:owner` **must never be mintable through the general-purpose,
agent-callable `coord:send` MCP tool** — any agent could otherwise forge an
"owner directive" to a peer, exactly the confusion class the turn-provenance
protocol exists to prevent. That's why `inbox-reply.ts` is deliberately **not**
registered as a `defineTool` in the agent-tools catalog — it is reachable only
from the admin-UI route.

`resolveAttentionAction`'s `coord-escalation` branch calls `deliverInboxReply`
best-effort after a successful named-option `resolveEscalation` — a delivery
fault never fails the resolve (falls through to a plain `{resolved:true}`).

## 4. The chat-grade popup (P-007/P-008)

Answering isn't always a single option pick — sometimes the owner wants to
see the session's actual conversation. `SessionChatModal.tsx` opens from an
inbox item click (item → originating session id) and renders a live,
two-way chat view of that session:

* `session-transcript-mapping.ts` is a pure `TimelineEntry[] → ChatMessage[]`
  mapper (reuses `groupEntriesIntoTurns` from `harness/AgentThinkingStream`)
  with **tool-noise filtering** — an su transcript is \~90% tool calls, so a
  `tool_use` collapses to a one-line `ChatToolCall` chip, `tool_result`/status
  entries are dropped, and per-turn final text + cards are what's shown.
  `LiveSessionChat` only mounts once a `streamUrl` is available.
  A generalized `OperatorChat` (props audit confirmed `messages`/`busy`/`onSend`
  were already props) is the render target — the popup and the harness pane
  share one component.
* Escalations-with-options render inline as the same `AskChoiceCard` the
  Queue/inbox already use (reuse, not a new card type) — answering from the
  popup goes through the exact P-006 reply path above.
* The composer wires to `coord:send { to: asker, wake:'required' }`, so typing
  a free-text message in the popup is a real two-way chat with any running su
  session, not just an option pick.
* Data flows through `@papercusp/sync` (`useSyncQuery` + `notifySyncInvalidate`)
  per the repo's data-sync convention — never a hand-rolled fetch/poll — and
  open/selection state lives in nuqs.

## Gotcha: an unrelated SSE mock capture can get silently clobbered in tests

While verifying this plan end-to-end (P-009), `SessionChatModal.test.tsx`
flaked nondeterministically — a different subtest failing each run. Root
cause: `OperatorChat` (the popup's render target) transitively imports
`OperatorConversationProvider` (for `CardAnswerError`), which imports
`voice-mode.ts`, which — on some renders — async-inits a cross-tab "leader
bridge" (`packages/operator-core/lib/commands/leader-bridge.ts`) that
**independently calls the same mocked `createResilientEventSource`** for an
unrelated `/api/agent-mcp/run-command/sse?...` URL. A test's `let captured =
null` mock-factory variable that unconditionally overwrites on every call gets
clobbered by that unrelated call, racing with the assertion under test.

**Fix pattern**: filter the mock's capture logic by a distinguishing property
(here, the URL prefix `/api/adv/session/thinking`) rather than blindly
overwriting `captured` on every invocation — the general lesson being that a
component's *transitive* imports can call the same globally-mocked module for
a purpose the test never intended to exercise, so a shared capture variable
needs to assert it's capturing the call it thinks it is.

## Pointers

* The renderer-reuse convention this plan builds on:
  [inbox-cards](/agent-insights/inbox-cards).
* The provenance/authority model a reply's wake relies on:
  [turn-provenance-owner-vs-agent](/agent-insights/turn-provenance-owner-vs-agent).
* The plan-item/importance feed this plan's adapters extend:
  [attention-importance-system](/agent-insights/attention-importance-system).
* Isolated-shell E2E verification pattern used for P-009 (never the owner's
  live window): `/internal/docs/testing/agent-e2e`,
  `scripts/verify-tauri-headless.sh`.
