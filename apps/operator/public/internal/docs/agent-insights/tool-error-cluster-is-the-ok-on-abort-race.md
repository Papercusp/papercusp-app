# A "tool X erroring/timing-out repeatedly" watchdog cluster is usually ONE dispatch race, not N tool bugs
URL: /internal/docs/agent-insights/tool-error-cluster-is-the-ok-on-abort-race

>-

## What

The improvement-watchdog periodically files a *cluster* of look-alike EIs:

> **Tool `plans:list` erroring repeatedly** — returned error/timeout 1177× in the
> last 60 min. Sample: `tool "plans:list" exceeded timeout of 60s (handler
> returned but signal had aborted)`

…repeated for `plans:list`, `plans:search`, `coord:inbox`, `activity:recent`,
`activity:report` (EI-98/99/105/111/174/175 were one such cluster). They look
like N independent tool bugs. **They are one dispatch race.**

The tell is the exact phrase **`handler returned but signal had aborted`**. The
handler *completed successfully* — but the 60s timeout (or the idle watchdog) had
already fired, so the dispatch threw the valid result away and returned a
`timeout` error instead. Under fleet load the operator event-loop is saturated,
so even a *cheap* read's wall-clock exceeds 60s (it's queued behind other work).
The highest-frequency tools (here `plans:list` at 121807 calls, 22% "timing out")
get flooded first. Every false timeout is also a `tool_invocations` error row, so
the watchdog re-files the EI hourly.

## Why it was wrong

Discarding a *completed* result is only correct for a **caller cancellation** or
a **mutation** (don't claim success for a write the caller may have abandoned /
re-dispatched). For an **idempotent read** that already produced valid data, the
result is useful and side-effect-free — discarding it both wastes the read and
manufactures a false error.

## The fix (one place: the dispatch ok-on-abort race)

`libs/generic/tooldef/src/dispatch-stack.ts`, the `invoke` step's post-handler
abort check: if the handler returned a result AND the tool is a **low-tier read**,
return the result; otherwise keep the authoritative-abort timeout.

```ts
if (exec.abort.signal.aborted) {
  const caps = exec.tool.capabilities;
  const isLowTierRead = caps.length > 0 && caps.every((c) => tierFor(c) === 'low');
  if (!isLowTierRead) return { ok: false, error: { code: 'timeout', ... } };
  exec.handlerResult = result;
  return { ok: true, result }; // completed read surfaces past the deadline
}
```

## Two traps that bit me here

1. **Tier is NOT on `ProjectedTool`.** `exec.tool` is a `ProjectedTool` and has
   `capabilities: string[]` but **no `tier` field** (that lives on
   `ToolDefinition`/`ProjectedToolDefinition`). Resolve the tier in the dispatch
   with `tierFor(capability)` from `./capability-tiers` (the host-registered
   resolver; defaults to `'low'`). Effective tier = the max across capabilities ⇒
   "low read" ⟺ every declared capability is `'low'`.

2. **A read capability missing from the tier table silently becomes a write.**
   `papercuspTierFor` (`packages/agent-mcp/src/capability-tiers-papercusp.ts`)
   **defaults unenumerated capabilities to `'medium'`**, not `'low'`.
   `activity:recent` (capability `activity:read`) was unlisted → tiered `medium`
   → treated as a mutation → excluded from the read-fix above AND wrongly recorded
   in the decision-ledger. Whenever you add a read tool, add its `*:read`
   capability to the tier table. (`activity:report` is fire-and-forget telemetry —
   also tiered `'low'`, like `storage:plugin-private`, so it's de-noised from the
   ledger and absorbed by the read-fix.)

## When you see this

A watchdog cluster of "Tool X erroring/timing-out repeatedly" with the
`handler returned but signal had aborted` sample → **don't open N per-tool fixes.**
Confirm the shared signature, check the tools are reads (tier `low`), and the
dispatch fix resolves the whole cluster. If a member is genuinely a slow *write*,
that's a real latency bug in that tool — investigate it on its own. (The
underlying *call volume* — e.g. 121K `plans:list` calls — is a separate caller-side
load problem worth chasing; the dispatch fix only stops the false-error flood.)
