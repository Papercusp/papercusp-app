# The gym is a blueprint (gym-as-blueprint port)
URL: /internal/docs/agent-insights/gym-as-blueprint

How the self-improving "gym" became the third built-in Harness Blueprint (D-022). A gym is a harness whose work is "improve another harness's blueprint"; the target declares its own rubric/signals/collectTrace; the lib/gym primitives are re-exposed as engine-primitives + gym:* tools; live-edit = commit→reproject.

## What

The "harness gym" (eval-driven prompt/orchestration optimizer) is no longer bespoke
machinery — it is the third **built-in Harness Blueprint** (`gym`), alongside
`coding` and `research` (`harness-blueprint-orchestration-2026-06-03` Phase D /
D-022). A **gym is just a harness whose work is "improve *another* harness's
blueprint."** Everything special about it is data in a blueprint, not a separate
code path.

The split that makes this work:

* **The `gym` blueprint** owns the optimization **spine**: `generate-tasks →
  run-target-variant (sub-harness) → judge → propose → A/B-gate → accept (commit the
  target blueprint)`. Roles: `task-generator` / `variant-runner` / `judge` /
  `proposer` / `committer`, driven by a `gym-director`. It is layer-4 **recursive**
  (`recursion.spawnOn: variant-runner`) — running a target variant spawns the target
  as a durable sub-harness. It is `requiresRepo:false` and `gym.collectTrace:
  work-item-output` (the gym is itself gym-able).
  File: `libs/papercusp/packages/harness/blueprints/gym/blueprint.yaml`.

* **The *target* blueprint** owns its own gym rubric: `blueprint.gym.collectTrace`
  (the trace seam), `blueprint.gym.signals` (the deterministic guardrails), and
  `blueprint.gym.rubric` (the judge's dimensions/weights). The gym **reads the
  target's** gym block — so a `coding` target is judged on a git diff and a
  `research` target on its work-item output, with no gym-side change.

## How the pieces map (Phase D)

| Concern                                    | Where                                                                                                                                                                                                           | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The `gym` blueprint                        | `harness/blueprints/gym/blueprint.yaml` + role prompts at the package-level `harness/prompts/{gym-director,task-generator,variant-runner,judge,proposer,committer}.md` (NOT a per-blueprint `gym/prompts/` dir) | Validates clean (engine `loadBuiltinBlueprint('gym')`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Re-exposed primitives                      | `packages/operator-core/lib/gym/primitives.ts`                                                                                                                                                                  | One import surface: the **signal registry** (`resolveSignals`/`evaluateSignals` over `GYM_SIGNAL_REGISTRY`) + the **rubric mapper** (`rubricFromBlueprintGym` → a concrete `GymJudgeRubric`, falling back to `GYM_JUDGE_RUBRIC_V1`) + re-exports of `judgeGymRun`/`runAbEvaluation`/`collectTrace`.                                                                                                                                                                                                                               |
| Gym tools                                  | `packages/operator-core/lib/agent-tools/gym/{judge,signals}.ts`                                                                                                                                                 | `gym:judge` (frozen Opus judge, target's rubric — testable inner `runGymJudge`) + `gym:signals` (resolve a target's declared signals by name). The judge/proposer roles call these. `gym:signals` also resolves **drill-ground-truth signals** (`drillResolveRate` / `drillTriageAccuracy` / `drillMttsh`, FB-23/P-048) over red-queen drill rows (`lib/red-queen/store.ts`) — pass `drillOutcomes` explicitly, or set `loadDrillOutcomes` to pull the live sandbox corpus from PG (`drillSource` in the response reports which). |
| A/B eval-matrix                            | `packages/operator-core/lib/gym/ab-matrix.ts`                                                                                                                                                                   | The matrix `variants × tasks × repeats` as a **Level-2 runtime DAG** (cells = wave 0, all parallel; `aggregate` = wave 1) — maps onto the planner's wave + `blocked_by` model. `aggregateAbMatrix` / `compareVariantsFromOutcomes` are the pure comparison/aggregation primitive (mean-based, excludes non-scored cells).                                                                                                                                                                                                         |
| collectTrace seam (D-015)                  | `packages/operator-core/lib/gym/collect-strategies.ts`                                                                                                                                                          | `collectTraceByStrategy('git-diff' \| 'work-item-output' \| <custom>)` breaks the gym's repo-coupling: `git-diff` diffs the clone (coding); `work-item-output` collects the work-item output + transcripts with **NO git** (research/gym). Wired into `ab-runner-real.ts` `collectAndDistill`, dispatching on the target's `gym.collectTrace`.                                                                                                                                                                                    |
| Live-edit = commit→reproject (D-007/D-021) | `packages/operator-core/lib/blueprint/commit-reproject{,-real}.ts`                                                                                                                                              | An accepted edit writes the target's `.papercusp/blueprint.yaml` / `.papercusp/prompts/<role>.md`, **commits it** (the target's own git tree), then **reloads + re-projects** via `projectBlueprintToPg`. Order is the contract: file → commit → project (the cache is never ahead of the committed file). `acceptProposalViaCommit` is the gym-accept path that replaces the ungated `PUT /harness/:slug/prompts/:role`.                                                                                                         |

## Gym extensions = harness plugins (P-015)

Because the gym is now a blueprint, you do **not** extend it by editing core gym
code. Two extension points:

1. **New gym behavior → a harness plugin.** Custom signals, custom collectors, or
   custom proposer strategies are added as `<plugin>.<verb>` harness plugins (the
   plugin host), not as new branches in `packages/operator-core/lib/gym`. The built-in signal registry
   (`GYM_SIGNAL_REGISTRY`) and the `collect-strategies` dispatch both have a clear
   "unknown name → error" boundary, so a custom name must be host/plugin-registered
   — it never silently no-ops.

2. **The control plane stays.** `packages/operator-core/lib/gym/control-plane.ts` (`gym_proposals` +
   `gym_autoloop_config`, migration 110) is **retained as the gym blueprint's
   UI/state surface** — the persistent, user-facing review queue + autoloop config
   the `/api/gym/*` routes read. The gym's heavy *execution* data still lives in the
   ephemeral gym run DB; the small control plane the human acts on persists in
   `harness_shared`, scoped by `(workspace_id, harness_slug)`. The accept action is
   what changed: it now goes through commit→reproject, not a direct
   `harness_prompt_overrides` write.

## Gotchas

* **The judge reads the *target's* rubric, not a constant.** Use
  `rubricFromBlueprintGym(targetBlueprint.gym)` — a target that declares only
  `weights` still gets a complete rubric (the rest falls back to V1).
* **`plantedBugCaught` is fuzzy by design** — it matches on location tokens of
  length ≥ 4, so `src/x.ts` (no ≥4 token) never matches. Use a real path.
* **A signal that lacks its inputs reports `applicable:false`, not `false`** — a
  repo-less (work-item-output) target has no pre/post tests, so `regressionsFromTests`
  is inapplicable, never a misleading "no regression."
* **commit→reproject commits the TARGET repo, not the operator tree.** The target
  harness is its own git repo; committing its `.papercusp/` files is D-007, not a
  violation of the "git-sync owns the papercup tree" rule.
* **A failed commit or reprojection leaves the proposal PENDING.** Never mark a
  proposal accepted on a half-applied edit — that discipline is what the old ungated
  PUT lacked.
* **A gym target need not be a repo at all — the learning system can be its own
  target.** `lib/gym/learning-targets.ts` + `lib/gym/seed-learning-gym-targets.ts`
  (self-learning-frontier P-048/FB-23) register the learning system's own roles
  (currently the auto-implement worker, the only one with a gym-native
  `harness_prompt_overrides` surface) as a gym autoloop target judged on
  vaccination's planted-drill ground truth instead of a code diff. Registration is
  DARK by construction (D-001): the created autoloop row is `enabled:false` with a
  null budget, doubly refused by the gym-cycle tick until an owner arms it
  (enable + set the governor budget).

## See also

* Plan `harness-blueprint-orchestration-2026-06-03` (Phase D: P-011–P-016, D-022 /
  D-015 / D-007 / D-021). Absorbs `harness-gym-eval-optimizer-2026-06-02`.
* The engine: `@papercusp/orchestrator/blueprint` (`GymSchema`, `RecursionSchema`,
  `deriveNext`, the loader) — **frozen**; the gym needed no schema change.
* Plan `self-learning-frontier-2026-06-12` (P-031 vaccination / FB-20 red-queen
  drill corpus, P-048 / FB-23 drills-as-gym-corpus) — the drill-ground-truth
  signals and the learning-system-as-gym-target extension.
