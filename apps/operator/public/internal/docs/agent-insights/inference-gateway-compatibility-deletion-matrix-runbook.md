# Inference gateway compatibility and deletion matrix runbook
URL: /internal/docs/agent-insights/inference-gateway-compatibility-deletion-matrix-runbook

Terminal-disposition contract for legacy inference-gateway capacity fields: what each family settled to, the evidence that settled it, and the two validators a release gate must see empty.

# Inference gateway compatibility and deletion matrix runbook

This runbook is the release contract for migrating legacy gateway capacity fields to the capless resource governor. The machine-readable matrix is exported from packages/operator-core/lib/inference-gateway/capacity-inventory.ts as INFERENCE\_GATEWAY\_CAPACITY\_COMPATIBILITY\_MATRIX (one row per exact writer) and INFERENCE\_GATEWAY\_CAPACITY\_COMPATIBILITY\_GROUPS (one row per legacy field family).

## The migration is COMPLETE — read this before you plan a deletion

P-015 closed the last focused gate. **No family is waiting on a removal release any more, and no live productive-capacity ceiling remains to delete.** Every family now carries a TERMINAL disposition plus the measurement that settled it.

The practical consequence: if you arrive here because a number looks like a cap, the answer is almost certainly that it is a floor, a guaranteed share, a readback, or a bound on a different subject — and the group's `dispositionEvidence` tells you which, with the probe that would prove you right. Re-run the probe before concluding you have found a live ceiling.

## Terminal dispositions

`CapacityCompatibilityDisposition` has exactly one non-terminal member. A family sitting on it means a gate is still pending, and `validateInferenceGatewayCapacityCompatibilityGroups()` reports it:

| Disposition                         | Terminal | Means                                                                                            |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `remove-after-gate`                 | NO       | A focused gate has not run yet. The validator reports this as `compatibility-non-terminal:<id>`. |
| `removed`                           | yes      | Every binding writer in the family is deleted from the tree. `writerIds` is empty.               |
| `readback-only`                     | yes      | The value is computed and REPORTED but never applied.                                            |
| `feedback-only`                     | yes      | The value survives as controller feedback or bootstrap state, never as a maximum.                |
| `retain-semantic-safety`            | yes      | Deliberately retained for a protocol or safety reason that is not productive capacity.           |
| `retain-measured-physical-contract` | yes      | Retained because an engine reports a matching physical partition.                                |

## Every terminal disposition carries evidence

A disposition is a claim about live behaviour that no static check can prove, so it is recorded WITH its measurement rather than asserted as prose. `dispositionEvidence` is REQUIRED on every terminal family:

* `verdict` — `deleted` (no live writer remains) or `non-capacity` (a live writer, measured not to bind). Cross-checked against `writerIds`: claiming `deleted` while the census still lists a writer is a finding, and so is claiming `non-capacity` for a family with nothing left to measure.
* `measuredAt` — the UTC date, `YYYY-MM-DD`. An undated "this no longer binds" is unfalsifiable and is rejected.
* `measurement` — what was actually observed: the source trace and/or the live values, with the numbers.
* `recheck` — the concrete probe that would FALSIFY the verdict. This is the field that matters most to a later reader: it is what lets them re-run the claim instead of trusting it.
* `caveat` — optional, and load-bearing when present. Several families are non-binding only on the default path (see below).

## The caveats worth knowing

Three terminal rows are conditional, and the condition is the interesting part:

* **MAX\_QUEUED** is retired only while the durable payload spool is active. With no spool the resident queue still bounds at `PAPERCUSP_GATEWAY_MAX_QUEUED || 256` — a MEMORY-safety bound on requests that have nowhere durable to spill, not an admission ceiling.
* **Priority reserve** is not a pool ceiling: tier 1 may use the whole pool. The per-tier number is a guaranteed MINIMUM SHARE, and since WI-4541 a tier at its share borrows idle slots — which is why live in-flight routinely sits far above it. The readback field is named `minShare` for exactly this reason.
* **Resource-profile limits** govern fleet agent SPAWN, not gateway admission. They are a real operator control; deleting them would remove a live placement bound in another subsystem.

## Contract for a NEW legacy field, if one ever arrives

1. Observe only: read the legacy value once with source, units, generation, timestamp, and freshness. It may seed desired controller state once; it is never passed as a maximum or recovery ceiling.
2. Warn and read back: report the raw value beside desired, effective, recommendation, applied, queue, and measured physical state. Missing or stale evidence remains unknown; it is never coerced to zero or safe.
3. Focused removal release: run the named plan gate, prove parity with the canonical durable queue/controller, then delete the binding writer or reclassify it.
4. Settle it: replace `remove-after-gate` with the terminal disposition the gate actually established, and attach `dispositionEvidence` measured at that gate. A gate that runs without producing evidence has not settled anything.
5. Rollback: switch the affected lane to observe-only while preserving durable receipts, queue history, state snapshots, and telemetry. Rollback must never reinstall a numeric productive-capacity ceiling.
6. Consumers: update the exact docs/runbook, API/tool route, and durable state/read-model paths listed in the matrix. Do not infer meaning from a field name alone.

## Field-family matrix

| Family                                                   | Terminal disposition              | What the evidence establishes                                                                      |
| -------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------- |
| PAPERCUSP\_GATEWAY\_CONCURRENCY / Claude default         | readback-only                     | Zero live reads; a present value is warned on. The live window is learned, not seeded.             |
| Cold-lane admission seed                                 | feedback-only                     | The seed is 8; live windows reached 503 and 231. A ceiling cannot be exceeded.                     |
| PAPERCUSP\_GATEWAY\_CODEX\_CONCURRENCY / account scaling | removed                           | Every Codex-specific writer is deleted; the group is kept so the legacy names stay greppable.      |
| MAX\_QUEUED / resident queue                             | retain-semantic-safety            | Uncapped sentinel with the spool active; the 256 is a memory bound on the un-spooled path.         |
| Per-account/min-admission                                | readback-only                     | One consumer, the diagnostics readback. Applied admission ran 18x the recommendation.              |
| AIMD floor/cap/tuning                                    | feedback-only                     | What remains is a FLOOR of 4; each cap is the controller's own learned high-water mark.            |
| Priority reserve/map/shares                              | retain-semantic-safety            | Shares do not cap (borrowing); the reserve is an interactive-lane guarantee under D-007.           |
| Provider floors/global rate gate                         | feedback-only                     | globalCap is Infinity; the baked numbers are cold-start floors a header supersedes.                |
| Operator rate-limit cap/provider bounds                  | readback-only                     | Only RATE\_LIMIT\_SANITY\_BOUND remains, validating operator input three orders of magnitude away. |
| Resource-profile limits                                  | feedback-only                     | Governs agent SPAWN, not gateway admission.                                                        |
| Local-backend maxConcurrent/parallel slots               | retain-measured-physical-contract | The registered value equals the engine's provisioned slot count.                                   |
| UI/API/state readbacks                                   | readback-only                     | Every published capacity number travels with its binding term.                                     |

## Verification

Run the focused tests:

npm --workspace @papercusp/operator-core test -- lib/inference-gateway/capacity-inventory.test.ts lib/inference-gateway/capacity-compatibility.test.ts

Before a release gate, confirm BOTH validators return an empty list:

* `validateInferenceGatewayCapacityCompatibilityMatrix()` — per-writer contract. Note it now folds in the group contract automatically when called on the real matrix.
* `validateInferenceGatewayCapacityCompatibilityGroups()` — per-family terminal + evidence contract. Call this one directly when you are checking families rather than writers, because a family whose writers are all deleted flattens to ZERO rows and the per-writer validator cannot see it. That is not hypothetical: `gateway-codex-concurrency` is exactly that shape.

A row with a missing writer, a rollback contract that permits a numeric cap, a non-terminal disposition, or a terminal disposition without dated evidence is a release blocker.

## Governing decisions

D-001: use the canonical admission contract, durable queue/receipts, CaplessAdaptiveController, causal health, leases, snapshots, and lint; do not build a second governor.
D-002: legacy values are bootstrap state, never ceilings.
D-005/D-009: external constraints and every reported capacity number carry live writer, units, source, freshness, and binding term.
D-007: priority is work-conserving scheduling, not capacity.
D-010: rollback disables enforcement without restoring any numeric cap.
