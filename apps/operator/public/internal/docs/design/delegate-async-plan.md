# Delegate fire-and-forget refactor
URL: /internal/docs/design/delegate-async-plan

Lift the 2-minute ceiling on delegate_to_claude by making it an async dispatch + later contextual update.

> **Implemented (with refinements).** The async race-with-timeout path (Q1
> Option B) shipped in `packages/operator-core/lib/commands/defs/delegation.ts`:
> a sync window races a deadline, and on overrun the handler returns
> `{ status: 'started', agentSessionId, message }` and drains the SSE stream in
> the background. The EL voice tool is still `delegate_to_claude`
> (`response_timeout_secs: 15` in `apps/operator/scripts/el-agent-sync.mjs`).
> Completion fires two browser events — `operator:delegation-complete`
> (panel-targeted) and `operator:delegation-async-complete` (voice-targeted) —
> and the voice-mode listener does the live-session push as **`sendSystem()`**
> (not the plan's `sendContextualUpdate`). The ack shape also changed from the
> draft below: it carries a `message` hint, not `expectedSeconds`, and the
> session id field is `agentSessionId`, not `claudeSessionId`.
>
> Two further refinements vs. the draft below:
>
> * **The per-delegate Haiku summary was NOT shipped.** The contextual
>   update carries a raw `fullText.slice(0, 280)` headline (with an ellipsis
>   when truncated) built in `OperatorDelegationListener.tsx` — there is no
>   model call. So the "Contextual update path" step 1 and the Risk-register
>   "extra Haiku call per delegate" cost concern no longer apply.
> * **Q3 resolved to a hindsight-inbox (Option B-style), not the recommended
>   panel-only Option A.** When no live EL session is present,
>   `OperatorDelegationListener.tsx` POSTs the headline to the operator
>   coord-inbox hindsight channel (`/api/agent-mcp/operator-hindsight`,
>   `kind: 'delegate-complete'`). `drainHindsightOnConnect()` in `voice-mode.ts`
>   folds pending items into a single `[While you were away, N update(s)]`
>   `sendSystem()` on the next EL connect (cites "collapse-delegate D-003").

## Why

EL caps `response_timeout_secs` at **120s** (the API rejects 121+).
Real delegates regularly run 30s–2min today, with a long tail past
that for file-heavy reasoning. When EL hits its 120s wall, the agent
sees "tool errored" even though the SSE stream is still running and
the result eventually lands in the panel via
`operator:delegation-complete`.

Symptoms users have already hit:

* Agent says "the delegate timed out" while the SSE stream finishes
  cleanly seconds later (we hit this; bumped 20s → 120s; still
  vulnerable to >2min runs).
* Agent can't summarize the result because the tool returned an
  error instead of the `fullText`.

## What changes

`delegate_to_claude` returns **immediately** with a small ack and the
result lands later via two channels:

1. **The panel** (already wired — `operator:delegation-complete`
   updates the panel's lastDelegation; user can read details there).
2. **The agent** — via `sendContextualUpdate(text)` from EL's SDK,
   triggered server-side when the SSE stream finishes. The agent
   gets a system-style note (`[Delegate ID completed] one-sentence summary`)
   on its NEXT turn, and can speak about it then.

### Tool return shape

Today (synchronous):

```js
{ status: 'complete', fullText, claudeSessionId, costUsd }
```

After (async-by-default for >5s expected runs; sync for short):

```js
// Returned within ~100ms of the call:
{ status: 'started', claudeSessionId, expectedSeconds: 90 }
```

The agent's persona will already speak "looking into that" at the
moment the tool returns. No "details in the panel" — that line moves
to the contextual-update handler when the result actually lands.

### Contextual update path

When the SSE stream completes server-side:

1. Build a one-sentence summary of `fullText` (Haiku call,
   capped at 80 tokens, \<$0.001).
2. Stream a contextual update into the active EL session:
   ```js
   conv.sendContextualUpdate(
     `[Delegate ID-PREFIX completed] SUMMARY. Full text in the panel.`
   );
   ```
3. The agent's persona (already updated) tells
   it: "if a contextual update mentions a delegate completing,
   speak the summary aloud and say 'details in the panel' on the
   next turn." So the user hears the update naturally.

If the user is mid-conversation (not idle), the contextual update
queues until their next turn. EL handles this internally.

## Open design choices (need user input)

### Q1: keep a sync path for fast delegates?

A small delegate ("what's a Bell number?", "summarize this 200-line
file") finishes in 5-15s. Going async for those is dumb — the agent
already returns the summary in the same turn, which is the natural
UX.

**Option A** (always async): one code path, simpler. Adds latency
to fast delegates (the user hears "looking into that, hang on" then
30s of nothing then the summary on next turn).

**Option B** (race-with-timeout): sync path tries to return within
\~10s; if not, the tool returns `{ status: 'started', ... }` and the
SSE stream keeps running in the background, completing via the
contextual-update path. Best UX, more code complexity.

Recommend **B**. \~30 extra lines.

### Q2: what does "started" look like in the panel?

Currently the panel shows the delegate row immediately on session
creation, then updates with the result. With async-by-default, the
row will sit in "running" state for minutes. Today there's no
visual cue for "this is actively in flight."

**Option A** (no UI change): the row shows up in the Delegates tab;
you can tell it's still running because turnCount=0 and there's no
summary yet.

**Option B** (running indicator): add a spinner/dot to delegates
that haven't received a `done` event yet. \~10 lines of CSS + one
boolean.

Recommend **B**. Cheap and visible.

### Q3: failure mode when EL session disconnects mid-flight?

If the user's EL session ends before the SSE stream completes, the
contextual update has nowhere to land. The result still goes to the
panel — but the agent never speaks about it.

**Option A** (panel-only): result hits the panel, agent forgets.
The user can reconnect and ask the operator about it (via the
existing `delegates.list` + `delegates.get` queries).

**Option B** (hindsight memory): write a session-completion record
to a small "agent inbox" table; on next session start, EL fetches
and surfaces ("you have 2 delegate results waiting from the prior
session: \[...]").

Recommend **A** for now. **B** is real work and the panel + voice
hint pattern (Q1's contextual-update + chaining) makes it
discoverable enough.

## Implementation order

Once the above is settled:

1. **`delegation.ts` handler refactor** — pull the SSE consumer
   into a separate function that runs in the background. Tool
   handler returns `{ status: 'started', claudeSessionId }` after
   \~10s of waiting (Q1 Option B).

2. **Background completion path** — when the SSE finishes, build
   the summary (cheap Haiku call), call `conv.sendContextualUpdate`
   on the live EL session. Need to thread the live `conv` reference
   through to the background callback — that's the trickiest piece;
   probably an in-process `Map<sessionId, conv>`.

3. **`el-agent-sync.mjs` description update** — `delegate_to_claude`
   description gets simpler ("returns immediately; result arrives
   via contextual update"). Drop the timeout knob since we're not
   waiting on EL's tool wall anymore.

4. **Persona update** — current persona says "always summarize
   after the tool returns." Becomes "say 'looking into that' when
   the tool returns; when you receive a contextual update about a
   delegate completing, summarize then."

5. **Panel running indicator** (Q2 Option B).

6. **Suite scenarios** — at least one for the new "long delegate
   completes via contextual update" path. Tricky to test in the
   text-only suite because contextual updates fire on the NEXT
   turn — would need to send a follow-up user message after the
   ack and assert the agent speaks the result then.

## Risk register

| Risk                                                                                | Mitigation                                                                                                                         |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| In-process Map of active EL sessions doesn't survive server restart                 | Sessions are per-tab anyway; restart loses the conv ref. Result still hits the panel; agent just won't speak about it. Acceptable. |
| Contextual updates land mid-sentence and confuse the agent                          | EL queues them until end-of-turn. Tested, documented in their SDK.                                                                 |
| Persona drift — agent could ad-lib the summary before the contextual update arrives | Suite scenario for it; el-tools-check + drift gate stays strict.                                                                   |
| Cost: extra Haiku call per delegate for the one-sentence summary                    | \<$0.001 per call. Probably noise. Could fall back to a regex-extracted first-line if budget gets touchy.                          |

## What we're NOT doing in this refactor

* **Multi-tab sessionId routing.** If the user has two tabs both
  running EL and a delegate completes, the contextual update goes
  to whichever tab the delegate was originally fired from. That's
  the leader tab anyway (focus-follows-tab keeps things consistent),
  so this is fine.
* **Delegate cancellation.** No "cancel running delegate" UI. Add
  later if asked.
* **Multi-delegate contention.** Two delegates running at once (rare)
  each get their own contextual update on completion. Already works
  this way today; the panel listener already handles concurrent.
