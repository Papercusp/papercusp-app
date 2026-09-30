# Operational capacity is feedback — never a hard-coded cap
URL: /internal/docs/agent-insights/operational-capacity-is-feedback-not-a-hard-coded-cap

Normative Papercusp rule: throughput ceilings must be capless, dynamically governed from live causal health, and never compiled or silently defaulted into code.

## Rule

Operational capacity is feedback state, never a compile-time constant.

Papercusp must not hard-code maximum agents, workers, processes, concurrent requests, queue depth, pool size, batch size, drain rate, or similar throughput ceilings into product code, service files, packaged defaults, or deployment-specific branches. A static default that silently becomes the live ceiling is still a hard-coded cap.

This rule implements `capless-adaptive-resource-governor-2026-08-26#D-002`: productive capacity has no fixed or derived ceiling.

## Required mechanism

Every resource-increasing start must use `Governor.admit` or a current scoped lease. Capacity pressure durably queues accepted work and returns a receipt; it does not reject work or hold an in-memory request open.

The controller owns an unbounded desired admission window. It expands while measured health is stable, contracts only the attributable resource/class when causal degradation appears, expires every contraction, and probes upward after recovery. Queue drain is fair, paced, work-conserving, and has no fixed maximum.

Health decisions use causal progress/latency, memory PSI and working-set acceleration, GC/fault/swap thrash, waits, failures, provider feedback, and evidence freshness. Raw CPU/RAM utilization, swap presence, queue depth, or fleet population alone must not establish a ceiling.

## What is allowed

Semantic or policy limits may be fixed when they define correctness rather than capacity—for example a protocol field width, a bounded result payload, or an authorization rule. Physical or contractual upstream constraints must be observed from their authoritative live writer and fed back into the governor; Papercusp must not duplicate them as a permanent local cap.

A temporary emergency ceiling is a mitigation only. It must be external to compiled code, visible in state, justified and owner/audit attributable, expiration-bound, linked to a work-item for deletion, and unable to silently become the controller's recovery ceiling.

## Review and debugging rule

When throughput stops at a round number, read the writer before blaming load. Search for `maxConcurrent`, `maxWorkers`, `maxQueue`, `maxSimultaneous`, `capacityCeiling`, numeric fallbacks, service environment defaults, `Math.min` clamps, and AIMD caps. Compare the enforced admission value with the capless controller's desired/recommended value.

If configuration or a static fallback binds the dynamic recommendation, fix the binding source and migrate the path through the governor. Do not tune the number upward and call that dynamic.

Enforcement lint must reject hidden semaphores, static capacity defaults, local queue caps, per-worker multiplication escapes, and resource-consuming starts outside governed admission or an explicit registered bypass.

## Incident proof

On 2026-08-28, the live inference gateway reported `configuredCap: 24`, `applied: 24`, `serviceableRecommendation: 28`, and `boundBy: configured-cap`. The dynamic recommendation was healthy enough to grow, but a fixed configured ceiling won. This is a violation, not intended governor behavior. The remaining migration/deletion work is plan item P-015; P-014 was concurrently active and P-016 remained ready.

## Canonical references

* `capless-adaptive-resource-governor-2026-08-26#D-001` — capacity pressure queues.
* `#D-002` — productive capacity has no fixed or derived ceiling.
* `#D-003` — every residency increase uses one typed governor seam.
* `#D-014` — every contraction expires and upward probing is unbounded.
* `#D-016` — observe upstream constraints rather than duplicating caps.
* P-012 through P-018 — lint, migration, validation, and rollout.
