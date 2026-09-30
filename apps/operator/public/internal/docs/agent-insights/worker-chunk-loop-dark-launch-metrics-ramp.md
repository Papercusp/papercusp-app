# worker:chunk-loop routing retired — ordinary invoke is the supported path
URL: /internal/docs/agent-insights/worker-chunk-loop-dark-launch-metrics-ramp

The operator-hosted worker:chunk-loop routing experiment is retired. Ordinary invoke is unconditional, stale flags/knobs cannot re-enable it, and historical chunk rows remain read-compatible while new chunk writes and active placement are disabled.

## Status

The operator-hosted `worker:chunk-loop` routing experiment is retired. Current coding workers always use the ordinary `invoke-once` worker path; stale feature flags, cohort settings, and per-harness `useChunkLoop` values cannot re-enable the route.

## What changed

* `invoke-once` no longer imports or dispatches `shouldUseWorkerChunkLoop`.
* The DBOS pipeline always calls `spawnInvokeOnce`; `useWorkerChunkLoopOp` is a compatibility guard that returns `false`.
* The worker chunk-loop blueprint and deterministic-op registration are retired. The historical implementation modules remain only for migration/forensics and unit fixtures.
* The public `work_item.kind='chunk'` write path is retired. New tool, HTTP, scheduled-plan, and blueprint-run attempts are rejected or normalized to `feature`; existing chunk rows remain readable with explicit historical filters (for example `work_items:list { kind: "chunk" }`) and parent reads.
* Active placement and self-selection admit `feature` plus explicitly opted-in generic kinds, never historical chunks. The resumed drain fleet therefore uses a positive `feature` + `change` claim specification.

## Verification

Focused route, blueprint-parameter, public-create, historical-read, and claim-floor tests cover the retirement boundary. The old ramp metrics below are retained as historical evidence only; there is no remaining ramp to run.
