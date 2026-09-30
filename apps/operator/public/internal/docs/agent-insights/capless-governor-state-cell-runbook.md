# Runbook — capless governor state cells
URL: /internal/docs/agent-insights/capless-governor-state-cell-runbook

Runbook: the five registered governor.* state cells, what each assessment code means, and why a bespoke read of governor state is a lint failure.

## The five cells

Governor visibility reuses the registered state-cell plane (D-008). There are exactly five, all resolved from the same snapshot, all read with `state:read { cell }`:

| cell                 | headline  | assessment codes                        | shape                                                                                                        |
| -------------------- | --------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `governor.health`    | health    | healthy · degraded · unknown            | `{ state, severity, actionable, confidence, evidenceRef }`                                                   |
| `governor.admission` | admission | open · constrained · paused · unknown   | `{ state, reason, generation, constrainedClasses[], nextProbeAtMs, confidence }`                             |
| `governor.queue`     | queue     | empty · draining · growing · unknown    | `{ depth, oldestAgeMs, arrivalRatePerSec, drainRatePerSec, trend, byClass[], populationClasses, truncated }` |
| `governor.resources` | resources | unconstrained · constrained · unknown   | `{ constrained[], byResource[], truncated }`                                                                 |
| `governor.recovery`  | recovery  | stable · recovering · stalled · unknown | `{ state, completed, total, progress, nextProbeAtMs, evidenceRef, confidence }`                              |

```
state:read { cell: 'governor.admission' }
state:read           // no args — lists every cell you may read
```

## `unknown` is a reading, not a zero

Every cell can answer `unknown`, and it is **in-band and branchable** — never read it as "fine", "zero", or "open":

* `not-measured` — no writer has published this signal. Asking again will not help; enable or fix the writer.
* `resolver-failed` — retry, then escalate.
* `insufficient-data` — the analyzer is still warming its healthy baseline. Supply more input or wait a cadence.

A governor that cannot see is *not* a governor that is happy. Treat `unknown` as a visibility incident.

## Read the cell at the moment you act on it

These values change under you mid-turn. Transcribing one into a message, a plan, a report or a checkpoint and acting on it later is the whole class of "I acted on a stale number" bug. Re-read at the point of use.

Waiting for a cell to cross a threshold is `state:subscribe { cell, on: { op, value } }` followed by ending your turn — never a poll loop.

## Never hand-roll a governor read

`npm run lint:no-bespoke-state-read` fails a new bespoke reader, and its baseline is shrink-only. If you need a live value that has no cell, **register a cell** — do not mint a private read path. A second reader of the same state is how two surfaces start disagreeing about whether admission is paused.

## Writer scoping is load-bearing

Signals are selected **per writer** (`liveHealthFrameFromSnapshot` with `writerIds` / `writerKinds`), and the selection deliberately fails closed rather than borrowing an unrelated writer's reading from the compact summary. A verdict that cited a sibling process's provider latency would attribute a contraction to the wrong lane. `p017-profile-matrix.integration.test.ts` asserts this per profile.

## What is deliberately NOT a cell

Raw capacity numbers. CPU utilization, host memory used, runnable count and friends are declared **non-causal** (`NON_CAUSAL_CAPACITY_SIGNALS`) and appear in a verdict only as `ignoredCapacitySignals`. Utilization alone is never a throttle reason (D-013), so it is never a governor state either.
