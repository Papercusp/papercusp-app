# pot-eval seed-app (fixture)

The fixed sandbox the Pot-run-evaluation battery stands a **throwaway Pot** over
(`pot-run-evaluation-2026-06-13`, P-020 / D-004). A tiny real Node app the Pot
*extends* per scenario. **Not shipped** — a test fixture; the throwaway pot clones
it at a pinned commit (gym hermetic runner), drains the scenario's work-item DAG,
then `node acceptance.mjs --scenario <id>` is the objective bar.

## Two independent ground-truth signals (never the Pot's own report)

1. **Regression floor** — `npm test` (node --test, `test/baseline.test.js`) is **GREEN
   at the seeded commit** and must stay green. `regressionsFromTests` (HE-04) keys on it.
2. **Objective acceptance** — `node acceptance.mjs --scenario <id>` exit 0 == known-good.
   It **FAILS at the seeded commit** (feature artifacts absent + planted defect present)
   and passes only when the Pot does the work correctly.

## Planted defects (latent — green baseline, caught by a careful reviewer)

| # | Module | Defect | Detection signature |
|---|--------|--------|---------------------|
| 1 | `src/ranker.js` `topN` | off-by-one: `slice(0, n - 1)` returns n−1 items | `topN(items, 3).length` is 2, not 3 |
| 2 | `src/parser.js` `parseRecord` | no empty-segment guard: trailing/`;;` leaks a `""` key | `parseRecord('a=1;;b=2')` has key `""` |

Each scenario's `plantedBug.inWorkItem` names the work-item whose area touches the
defect, so a good worker/reviewer of that item fixes it; `plantedBugCaught` (HE-04)
checks the detection signature appears in the run output. The defects are LATENT —
`test/baseline.test.js` never exercises them, so the baseline stays green.

## Scenario shapes (the DAG, in `scenarios.ts`)

- `serial-pipeline` — strict chain (critical path 4, ideal cups 1).
- `wide-fanout` — base → 4 parallel feats → aggregate (critical path 3, ideal cups 4).
- `deep-chain` — long chain + one branch (critical path 5, ideal cups 2).
- `diamond` — A → {B,C,D} → E (critical path 3, ideal cups 3).
