# @papercusp/bench-metrics

Benchmark scoring + cost/Pareto metrics for the **impartial benchmark suite**
(`impartial-benchmark-suite-2026-06-15`, BRIEF 7 / P-011). This lib owns the
canonical **run-result schema** (co-defined with P-010), a **published model
price table**, per-arm **token/$ accounting** with coordination overhead
counted, **iso-budget** verification, the **cost/accuracy Pareto**, and
**pass@1-over-seeds + confidence intervals** plus a uniform **pass@k / pass^k**
protocol.

```ts
import { buildSuiteReport, type TaskRunResult } from '@papercusp/bench-metrics';

const rows: TaskRunResult[] = await loadRunResults(runId); // emitted by P-010's layer
const report = buildSuiteReport(rows);
// report.arms      → per-arm pass@1 + CI, pass@k/pass^k, cost account
// report.frontier  → cost/accuracy Pareto points (onFrontier flag)
// report.deltas    → papercusp − each baseline (accuracy delta, cost ratio, dominance)
// report.isoBudget → did every arm run under the same generation cap?
```

## The contract (who emits, who reads)

`TaskRunResult` is the per-(task × arm × seed) row. **P-010's reproducibility
layer emits it** (PG `run_result`, migration 291); the **arm runners** (Papercusp
+ Baselines A/B/C) and the **grader adapter** (P-005) fill it; **this lib reads
it** and folds it into reports for the Evaluation UI (P-020) and the methodology
doc (P-016). One TS type, imported everywhere, so nothing drifts.

## Fairness invariants encoded here

- **Coordination overhead is counted in our own number.** Every row's
  `tokensTotal` is summed across all spine roles + coordination (Papercusp) or
  all N candidates + verifier (best-of-N), so `accountTokens` counts it by
  construction — it is never subtracted.
- **Iso-budget caps GENERATION only; grading is uncapped and identical across
  arms** (P-001 §5). `verifyIsoBudget` asserts every arm ran under the same
  generation cap and flags any run that exceeded its cap without the `capped`
  flag (an un-enforced cap is a bug, surfaced loudly).
- **Cost is DERIVED, never trusted off the row.** `cost_usd = priceRun(tokens,
  model_id, price_table)` from one published table applied identically to every
  arm — so a third party recomputes the same $ from the stored tokens, and
  correcting a price is a version bump, not a re-run.
- **Infra errors are not fails.** `resolved` is `boolean | null`; a row whose
  generation or grading hit an infra error (`generationStatus` /`graderStatus`
  ∈ {error, timeout}) is `null` and excluded from accuracy, surfaced separately
  as `infraErrors` (METR elicitation discipline).
- **Same pass@k protocol on every arm.** `protocolKs` is shared; pass@k uses the
  unbiased Chen-et-al estimator and pass^k the reliability counterpart.

## Modules

| module | what |
|---|---|
| `schema.ts` | `TaskRunResult` (the canonical row) + report types (`ArmReport`, `SuiteReport`, `ParetoPoint`, `ArmDelta`) + `ArmId` vocab |
| `pass-k.ts` | unbiased `passAtK`, `passHatK`, `meanPassAtK` — domain-free |
| `intervals.ts` | `wilsonInterval`, `bootstrapMeanCI` (deterministic), `meanStderr` — domain-free |
| `pareto.ts` | directional `dominates`/`paretoFrontier` + `costAccuracyFrontier` — domain-free |
| `pricing.ts` | `PRICE_TABLE_V1` + pure `priceRun` (cost = f(tokens, model, table)) |
| `cost.ts` | `accountTokens`, `budgetExceeded` (the shared generation cap-check every arm calls), `verifyIsoBudget`, `isScored` |
| `aggregate.ts` | `aggregateArm`, `buildSuiteReport` — composes the above |

The pure cores (`pass-k`, `intervals`, `pareto`) import nothing from the
benchmark layer and are independently borrowable.

## Arm vocabulary (LOCKED)

`papercusp` · `baseline-a-ablation` · `baseline-b-native` · `baseline-c-bestofn`

## Price table

`price-table-v1` carries Anthropic list prices per 1M tokens (model catalog as
of 2026-06-04): Opus 4.8/4.7/4.6 `$5 / $25`, Sonnet 4.6 `$3 / $15`, Haiku 4.5
`$1 / $5`, Fable 5 `$10 / $50`. Cache prices follow the documented multipliers
(read ≈ 0.1× input, 5-minute write ≈ 1.25× input). **Verify against
platform.claude.com/pricing before external publication**; correcting a price is
a version bump — cost re-derives from the stored raw tokens, no re-run.

Pure, zero runtime dependencies. `npm test` runs the Vitest suite.
