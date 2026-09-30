# Unbounded LLM/IO on a tool's response path drops the MCP transport
URL: /internal/docs/agent-insights/unbounded-llm-on-tool-response-path-drops-transport

A tool handler that awaits a slow, un-timed-out LLM (or any unbounded IO) call before returning can exceed the MCP CLIENT's request timeout (~60s) under load — the write commits but the caller sees 'transport dropped; response lost' and blind-retries. Keep slow/unbounded work off the response path.

## Symptom

A single tool call (e.g. `memory:remember`) intermittently fails with **"transport
dropped; response lost"** — while *other* tools on the **same MCP connection** work
fine immediately before and after. The side effect (the DB write) actually
**committed**; only the response never arrived. Callers that retry blindly create
near-duplicates.

That "only this one tool, only sometimes, but the write landed" shape is the tell:
it is **not** a connection teardown and **not** a logic bug. The handler simply took
**longer than the MCP client's request timeout** (the SDK default is \~60s), so the
client gave up while the server was still working.

## Why it happens

The MCP server does **not** enforce a per-call deadline — in this codebase the
handler's `ctx.signal` is `new AbortController().signal` and is **never aborted**
(`_mcp-handler.ts`). So the only ceiling on a tool call is the **client's** timeout.
Any handler that `await`s an **unbounded** operation before returning can blow past it:

* an LLM call with **no timeout/abort budget** (the original `memory:remember`
  awaited mem0's Haiku "condense" step — `extraction-llm.ts` had no deadline),
* made worse by the busy dev-box **429 backoff**, which stretches a normally-fast
  LLM call into tens of seconds,
* or any slow network/IO fan-out done synchronously on the write path.

The write commits first, then the slow enrichment runs, then the (now-too-late)
response is written to a transport the client already abandoned.

## The fix pattern

**Keep slow, unbounded work off the response path.** Return as soon as the durable
part is done. In order of preference:

1. **Remove the slow call from the path** when it isn't load-bearing for the result.
   `memory:remember` now stores the agent's text **verbatim** (`verbatim:true` →
   mem0 `infer:false`) — no LLM condense call on the explicit-write path (EI-622).
   The conversation-extraction path keeps the LLM step, where it earns its cost.
2. **Defer enrichment** — do the minimal durable write, return, run the slow part
   fire-and-forget (the anchor-persist + sync-invalidate in `remember.ts` already do
   this).
3. **Bound it** — if the slow step must run inline, give it a hard timeout well under
   the client's, with a fast fallback, so the handler can never outlive the response
   channel.

Progress notifications (`ctx.progress`) can keep a *cooperating* client's timer
alive, but they're a **no-op** when the client didn't send a `progressToken`
(`_mcp-handler.ts`), so don't rely on them as the primary guard.

**Update (B1, `infra-fail-fast-build-integrity-2026-06-19`):** pattern 3 ("bound
it") is now a shared primitive rather than a one-off — `memory/op-deadline.ts`'s
`withMemoryToolTimeout` races every explicit memory-tool backend call (the
`available()` probe, the dedup/conflict neighbor search, and the write itself)
against a deadline (`PAPERCUSP_MEMORY_TOOL_TIMEOUT_MS`, default 10s — well under
the \~55–60s transport cap) and returns a clean `{ ok:false, reason:
'memory_timeout' }` instead of riding the client's timeout out. `remember.ts`
also wraps its write in `withMemoryWriteRetry` (EI-6684) so a single *transient*
timeout gets one bounded retry instead of silently dropping the fact — a
sustained wedge (the process already in the degraded cooldown) skips the retry
and fails fast. This does not replace patterns 1/2 above (removing/deferring the
slow call is still strictly better than bounding it); it's the fallback for
whatever slow step still has to run inline.

## Rule of thumb

If a tool handler can take more than a few seconds in the worst case, the slow part
belongs **off the response path** (removed, deferred, or hard-bounded) — never as a
bare `await` the caller's timeout has to outlast.

Related: [Workspace-agnostic tools need `crossWorkspace: true`](/agent-insights/cross-workspace-tools-and-workspace-required) (the other half of the EI-178 memory-tool cleanup).
