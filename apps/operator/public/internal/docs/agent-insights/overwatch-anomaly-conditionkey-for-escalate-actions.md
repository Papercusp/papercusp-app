# Overwatch/Kettle/Sentinel anomalies carry a stable conditionKey for escalate actions — pass it to coord:escalate verbatim
URL: /internal/docs/agent-insights/overwatch-anomaly-conditionkey-for-escalate-actions

The 'N aging owner-attention escalations' advisory self-inflated its own count (279→283 over ~2h) because Overwatch/Kettle escalates via an LLM turn reading a rendered anomaly line, not a code-side coord:escalate call — so the dedup key can't be enforced by code alone. Before EI-13557, the agent had to invent its own conditionKey (or forget one), and a message embedding a live count produced a fresh un-coalesced escalation every time the count changed. Fix: every escalate-type Anomaly now carries suggestedAction.conditionKey — a stable string derived from the anomaly kind alone (never from the live count/duration in message/detail) — and both anomaly-line renderers (overwatch/brief-types.ts, papercup/papercup-context.ts) surface it inline as `[conditionKey: …]` with explicit instructions to pass it to coord:escalate's conditionKey arg and keep any count/duration in body, never in summary.

## The signal

An "N aging owner-attention escalations require owner triage" / "N human-attention
escalations are aging" advisory kept re-firing with a DIFFERENT count on every wake
(279 → 280 → 283 over \~2h, 2026-07-17 02:54Z→04:40Z) instead of coalescing onto one
open row. The advisory that reports the aging-escalation backlog was, itself, a member
of that backlog — a detector eating its own tail.

## What it actually means

`coord:escalate`'s dedup is keyed by `conditionKey` (→ `meta.subjectSignature`); without
one, the dedup key falls back to the prose `summary`. The overwatch/Kettle anomaly
detector (`detectAnomalies` in `compute-brief.ts`) does **not** call `coord:escalate`
itself — it produces an `Anomaly[]` with a `suggestedAction: { type: 'escalate', message }`
that gets **rendered into an LLM's wake prompt** (`renderOverwatchBrief` /
`renderSentinelContext`), and the agent reading that prompt decides whether/how to call
`coord:escalate`. Some emit paths (agent turns) passed a stable `conditionKey`; others
didn't, or derived one from the message text — which embeds the live count
("283 human-attention escalations are aging"). A dedup key containing the count never
repeats, so every wake where the count moved produced a fresh, un-coalesced escalation.

This is the SAME class of bug `known-open-aging.ts` already fixed for its own (unrelated,
code-side) `coord:escalate` call via `agingConditionKey(watchdogKey)` (EI-14854) — but that
fix only covers the per-issue known-open-aging watchdog path, not the overwatch/Kettle
anomaly-brief path, because the brief path's escalate call is LLM-mediated, not code-side.

## The fix (EI-13557)

Since the actual `coord:escalate` call is made by an LLM reading rendered text, the dedup
key can't be enforced by code alone — the fix makes the correct key impossible to miss:

1. `SuggestedAction.conditionKey?: string` (brief-types.ts) — present ONLY for
   `type: 'escalate'` actions.
2. `escalationConditionKey(kind: AnomalyKind): string` (compute-brief.ts) returns
   `` `overwatch:${kind}` `` — derived from the anomaly's closed `kind` enum alone, so it is
   IDENTICAL regardless of any count/duration in that anomaly's `message`/`detail`. Applied
   to **every** escalate-type anomaly (`queen-placement-stalled`, `token-paused`,
   `gateway-wedge`, `gateway-admission-starved`, `work-feed-stuck`, `invalid-model-config`,
   `escalation-aging`), not just the one that was observed self-inflating — every one of
   them embeds a live count/duration and was equally exposed.
3. Both anomaly-line renderers (`overwatch/brief-types.ts` renderOverwatchBrief,
   `papercup/papercup-context.ts` renderSentinelContext) now print
   `[conditionKey: overwatch:<kind>]` inline on the escalate line, and their intro text
   explicitly instructs: pass that string verbatim as `coord:escalate`'s `conditionKey`
   argument, and put any count/duration in `body`, never in `summary`.

## The guard

`compute-brief.test.ts` asserts the `escalation-aging` conditionKey is identical across
different `agingEscalations` counts (279 vs 283) AND that every escalate-type anomaly this
detector can produce carries a conditionKey with no embedded digits. `brief-types.test.ts`
and `papercup-context.test.ts` assert the renderers surface `[conditionKey: …]` only on
escalate lines, never on nudge/observe lines.

## The takeaway

When a recurring condition is escalated by an **LLM reading a rendered digest** rather than
a direct code-side `coord:escalate` call, you cannot rely on the agent to invent a
consistent dedup key — compute the stable key in code, and make the rendered text carry it
explicitly (not just document the convention in a persona/prompt) so the agent copies it
instead of re-deriving it from whatever count happens to be in the message that wake.
