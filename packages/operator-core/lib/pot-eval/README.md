# pot-eval — the Pot-run-evaluation battery (HE-03)

Plan: `pot-run-evaluation-2026-06-13` (HE-03 = P-020/P-021/P-022, D-009). A **sibling
slice of the apiary IQ-battery** (D-006): it runs the WHOLE Pot (Mug + cups) on a seeded
scenario in a throwaway pot and records the run. It builds nothing parallel — it reuses the
apiary/gym machinery and the `@papercusp/eval-battery` engine.

## What HE-03 ships (judge-free)

| File | Item | What |
|------|------|------|
| `scenario.ts` | P-020 | `HiveScenario` type · `computeParallelismStructure` (the computable ideal wall-clock + ideal cup-count from the work-item DAG, D-004) · `validateScenario`. |
| `scenarios.ts` + `fixtures/seed-app/` | P-020 | 4 seeded scenarios (serial / wide-parallel / deep-dependency / diamond), each with a known-good acceptance gate, a latent planted defect, and a computable optimum, over the real `seed-app` fixture. |
| `run-identity.ts` | P-022 | deterministic, collision-free throwaway-pot slug + run id per `(instance × scenario × repeat × seed)`. |
| `run-harness.ts` | P-021 | `runHiveScenarioOnce` (boot → seed → drive → collect → teardown, with teardown-on-failure) + the `@papercusp/eval-battery` `Subject` adapter (`hiveScenarioSubject`) + deterministic fake ports. |
| `battery.ts` | P-022 | `runHiveScenarioBattery` — scenarios × N repeats, recorded so each scenario's result is a **distribution** (reuses `gym/variance.ts`). |
| `store.ts` / `store-pg.ts` + migration `264` | P-021/P-022 | the run store, keyed `(instance, scenario, repeat)` — every repeat kept (unlike the beekeeper's `UNIQUE(instance, case_id)`). |

**The phase boundary (D-009):** this slice is JUDGE-FREE. It records raw runs + the
distribution. **HE-04/05** read `hive_eval_runs.observations` to compute outcome / efficiency /
speed metrics; **HE-06** layers the LLM judge / composite / un-gameable gate over the recorded
runs (each carries a `distilledTrace` a judge reads); **HE-07** schedules the cadence + trend.

## The LIVE ports — BOUND (P-063 / D-011); arming is a budget-flip (P-051)

The live `HiveRunPorts` + the score extractor are **built and green**. P-051 is now a
budget-flip, not a build: set a budget + activate the routine and the cadence runs the whole
Pot on the seeded corpus and trends the composite.

**The capture→replay architecture (the load-bearing constraint).** `runHiveScenarioOnce`
(`run-harness.ts`) runs `collectRunData` then **tears the pot down** (drops the member schema +
removes the clone) in a `finally`, *before* the record reaches the battery; `runHiveEvalGeneration`
scores each record afterward, when every throwaway pot is gone. So the live reads (acceptance over
the clone, the ground-truth rows, the seed-app baseline, the spawn rows) **cannot** happen in the
extractor. They happen in `collectRunData` (pre-teardown), are serialized into
`record.observations.extra.capture` as a `LiveRunCapture`, and the extractor **replays** them — the
judge-free separation (D-009) is preserved; the capture is just the recorded run's reality made
replayable.

| File | What |
|------|------|
| `live-ports.ts` | `makeLiveHivePorts(ops, { workspaceId })` — the `HiveRunPorts` over the injected `LiveHiveOps` seam (boot/seed/drive/collect/teardown orchestration + the pure materialize/seed-DAG/drained helpers). Unit-tested over fake ops. |
| `live-ops.ts` | `liveHiveOps({ workspaceId })` — the **concrete** `LiveHiveOps`: git/fs, `createHiveHarness` (Mug seat) + registry-member + `scaffoldHarnessSchema`, the HFC seed insert + `syncFeatureBlockEdges`, `setHiveStarted` + `requestUrgentHiveWake` (start), `surveyHive` + the `hive_placements` in-flight read (drive), the spawn/HFC reads + the live `captureRunData`, and the dissolve/drop teardown. |
| `live-capture.ts` | `LiveRunCapture` + `makeReplayExtractor()` (the live `HiveEvalScoreExtractor`) + the pure `behaviorFromSpawnRows` / `timingsFromSpawnRows` transforms. The extractor derives behavior/timings using the record's authoritative `wallClockMs` + `startedAt` (the single source of timing truth) and runs the same `computeOutcomeMetrics`/`Efficiency`/`Speed` the fake extractor does. |
| `ground-truth-live.ts` (P-062, b459e) | `liveGroundTruthPortsFromSql({ sql })` — the claims↔reality reads `captureRunData` composes. |
| `gen-loop.ts` | the cadence default `runBattery` is now the live runner: `makeLiveHivePorts(liveHiveOps(…))` + `makeReplayExtractor()` → `runHiveEvalGeneration`. The budget gate still refuses every unattended tick without an owner `budgetUsd`. |

**First-live-run validation surface (genuinely owner-gated, P-051).** Everything above is
typecheck-clean + tested (the read SQL by `live-ops.integration.test.ts`, the replay extractor by
`live-capture.test.ts`), EXCEPT what only a real armed run can confirm:
- The **real Mug drive** (`driveToCompletion`) — the one real-LLM-spend seam.
- **Cost / tokens / coord-volume / collisions / lock-contention** behavior fields — there is no
  cost column on `spawned_agents`; these are EKG/cost-ledger wiring, defaulted to `0` for now (each
  is a denominator or a failure-pair, so `0` never inflates a score — the **outcome gate + the
  un-gameable floor** are fully sourced from ground-truth + baseline + timings).
- The exact **commit convention** the cups use (the `commitBacksWorkItem` token match) and the
  precise **pot:start** incantation — confirmed at the first run.

Arm it: `tsx lib/pot-eval/seed-pot-eval-routine.ts --active --budget=<usd>` (migrations 264/268
boot-apply on the next operator restart).

## Tests

`scenario.test.ts` · `run-harness.test.ts` · `battery.test.ts` · `live-ports.test.ts` ·
`live-capture.test.ts` (Vitest) + `store-pg.integration.test.ts` · `ground-truth-live.integration.test.ts`
· `live-ops.integration.test.ts` (synthetic-row DB reads — no LLM). Registered as the `run-eval`
section of the `pot` test domain (sibling of `apiary`). The `seed-app` fixture's own `node --test`
suite is the scenario's regression floor, not an operator test.
