# Rate-limit governor is ACTIVE — and two gotchas in its top half
URL: /internal/docs/agent-insights/rate-limit-governor-activation

PAPERCUSP_AGENT_GOVERNOR=1 (+_PG=1) is live on :3170/:3070 since 2026-06-05. Anthropic SDK MessageStream hides rate-limit headers unless you read stream.response; AIMD must halve once per pause-EXTENSION or co-failing agents collapse eff to the floor.

## What changed (rate-limit-layer-v2-2026-06-05)

The `RateLimitGovernor` is no longer dormant: `PAPERCUSP_AGENT_GOVERNOR=1` and
`PAPERCUSP_AGENT_GOVERNOR_PG=1` are set in **both** `apps/operator/.env.local`
(staging `:3170` + Tauri dev spawns) and the release checkout's `.env.local`
(`:3070`). Every orchestrator spawn + stateless anthropic-direct call now paces through the shared
per-`(provider, modelClass)` buckets, the fleet-wide `maxSimultaneousAgents`
gate (live-editable via `operator:rate_limit_config` / the `/adv` top-bar
`<FleetRateControl>`), AIMD effective concurrency, and staggered resume. Don't
re-add ad-hoc retry/backoff at call sites — classify + let the governor pace.

## Gotcha 1 — streaming SDK calls hide the rate-limit headers

`client.messages.stream(...).finalMessage()` returns the **Message**, which has
no headers — so a naive implementation never sees `anthropic-ratelimit-*` on
the success path (only thrown SDK errors carry `.headers`). The fix (SDK
`@anthropic-ai/sdk` 0.73.0): keep the `MessageStream` object; after
`finalMessage()` resolves, `stream.response` is the raw `Response` whose
headers carry the live limits. `chat-stream.ts` now does exactly this and
returns the headers in the governed `TurnOutcome`, which both activates
header-driven pacing (`governor.recordResponse`) and feeds the usage-telemetry
sink (`setStatelessUsageSink`, named `setMeridianUsageSink` pre-EI-399 → `agent_usage_samples`, migration 161).

## Gotcha 2 — AIMD must dedupe penalties per backpressure EVENT

The first AIMD cut halved `eff` on every `penalize()` call. Under a fleet, ONE
429 manifests as N near-simultaneous penalize calls (every in-flight turn on
the bucket fails together), which collapsed `eff` straight to the floor —
multiplicative decrease to the power of N. The shipped rule: the governor calls
`gate.notePenalty()` only when the penalty **extends** `pausedUntil` (a
distinct backpressure event); duplicate same-reset 429s don't re-halve.
Mirror of TCP's once-per-window loss response. (Clean-turn detection stays
per-call: any penalty during a turn's flight marks it not-clean via a
`penaltySeq` snapshot.)

## Where the pieces live

* Taxonomy/disposition: `libs/papercusp-shared/src/agent/turn-error.ts` (D-001
  `usage_limit` ≠ `rate_limited`).
* Gate + AIMD + stagger: `libs/papercusp-shared/src/resilience/governor.ts` +
  `src/agent/governor-registry.ts`.
* Live config + bus: `packages/operator-core/lib/rate-limit-config.ts`
  (PG `operator_rate_limit_config`, no restart).
* Read-model: `packages/operator-core/lib/fleet-rate-status.ts`, served by
  `dev:rate_governor_status` + `GET /api/operator/rate-limit-config`.
* Acceptance proof: `turn-robustness.fault-injection.test.ts` ("ACCEPTANCE
  P-022") — one agent's 429 parks the shared bucket for every caller.
