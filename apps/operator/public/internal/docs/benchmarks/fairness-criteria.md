# Benchmark Fairness Criteria
URL: /internal/docs/benchmarks/fairness-criteria

The binding conditions a benchmark comparison between agent systems (su-agent / pot vs a reference like mini-swe-agent) MUST meet to be a fair, defensible measurement. Every benchmark run is audited against this checklist BEFORE any result is claimed.

import { Aside } from '@astrojs/starlight/components';

This is the standard for **every** agent-system benchmark we run. Before reporting *any* number, produce a **fairness-audit table** (one row per criterion below, PASS/FAIL/N-A with evidence). A claim of "system A beats system B" is only valid when **every applicable criterion passes**. If a criterion fails, either fix it and re-run, or state the claim is provisional and name exactly which criteria failed. No exceptions, no "directional" hand-waving.

## Why this exists

We compare our multi-agent systems (the **su-agent spine** and the **pot/Mug coordination** path) against external references (mini-swe-agent, SEAL, etc.) on coding benchmarks (SWE-bench-Pro, etc.). It is very easy to produce a number that *looks* like a win but isn't a fair measurement — different denominators, different compute, different models, or (worst) not even exercising the capability being claimed. This document is the checklist that makes a comparison real.

The 2026-06-17 su-vs-mini-swe Opus-4.6 run **failed several of these** (audited at the bottom). That run is the cautionary example, not the template.

## The criteria

### C1 — Identical task set AND identical scoring denominator

* Both arms run the **exact same instance\_ids** (same source file, same N). ✔ is necessary but **not sufficient**.
* Both arms are **scored on the same set**: `resolved / N` with the **same N** for both. An arm that produces no patch on a task **scores `false` on that task** — it is **never silently excluded**. Excluding one arm's failures-to-produce (empty diff, infra-fail, timeout) while the other attempted all N is the single most common way to fake a win.
* Report the **full per-instance result matrix** (instance\_id × arm × resolved), so the denominator is auditable.
* "Real-diff intersection" or "graded-subset" numbers are **secondary, clearly-labelled** views — never the headline, because they drop the tasks one arm couldn't attempt (which flatters the weaker-coverage arm).

### C2 — Identical model, verified from telemetry (not config)

* Same model **and** reasoning effort for every model call each system makes.
* **Verify from usage telemetry per arm** (`agent_usage_samples.model` / the run's `usage.json`), not just the launch config — a tier/route remap can silently serve a different model (this has happened: a pin to opus-4-6 silently served opus-4-8).
* A system that internally **escalates** some calls to a stronger model (or falls back to a weaker floor) is **not** on the same model — detect and disclose it.

### C3 — Compute parity (iso-budget) — REQUIRED for any capability claim

* A multi-role spine or a multi-agent pot spends **far more inference per task** than a single-agent loop. Winning by spending 3–4× the compute is **not** "a better agent" — it's "more compute."
* The comparison MUST be **one** of:
  1. **Iso-budget**: both arms capped to the **same per-task budget** and the cap reported; **or**
  2. **Explicitly labelled "best-effort, NOT compute-matched"**, with **per-task compute disclosed for both arms**, and **no capability claim** drawn from it.
* **The budget is multi-dimensional — report ALL of: `calls/task`, `$/task`, tokens/task, AND `wall-clock/task`.** Wall-clock is load-bearing for long-horizon benchmarks (FrontierSWE tasks run hours): a topology that finishes in 1h vs 5h at the same call-count is a different result, and a multi-agent arm can trade wall-clock for parallelism. The default headline is **score at equal model-call budget** (call-count is the cleanest cross-topology unit), but a long-horizon benchmark MUST also report the **score-vs-wall-clock** curve. Never claim a win without disclosing all four budget axes for every arm.
* **The auto-generated audit only partly satisfies C3.** `buildFairnessAudit`'s C3 row surfaces just `$/task` and `calls/task`; **tokens/task and wall-clock/task must still be added manually** for a full C3 pass. And its `calls/task` is computed from `row.turns` (`totalTurns / scoredRows`), so it is a **turns proxy, not the `maxModelCalls` axis** the iso-budget can cap on — don't read the auto-table's `calls/task` as the model-call budget. The persisted `TaskRunResult` row currently records `budgetTokens`, but not `maxModelCalls`, `maxCostUsd`, or `maxWallMs`; therefore the generated C3 row can auto-detect uniform token caps only. When a run uses call/cost/wall caps, the report must state those caps from the run config beside the auto-table.

### C4 — Test what you claim (the capability must actually be exercised)

* **The benchmark config must exercise the feature whose advantage you are claiming.**
* Our differentiator is **multi-agent coordination**: multiple workers coordinating + correcting each other on overlapping work. That advantage **only** appears when workers **coordinate** — two workers on two *different* tasks with no communication get **zero** coordination benefit (just parallelism).
* **The real research question is COORDINATION TOPOLOGY: central coordinator (Mug) vs totally-distributed (peer-to-peer) coordination — which collaborates better?** Both topologies use MULTIPLE coordinating agents; they differ only in *how* coordination happens.

**Arm taxonomy (name the topology, don't conflate):**

| Arm                     | Agents                                                                                                              | Coordination                          | Exists today?                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------ |
| mini-swe-agent          | 1                                                                                                                   | none (baseline floor)                 | ✅ external                                             |
| `su-independent` (code) | N, **one task each**                                                                                                | **NONE** — isolated, no comms         | ✅ but it's the *no-coordination* pole, NOT distributed |
| `fifo-noqueen`          | N over a backlog                                                                                                    | none (scripted FIFO, Mug never wakes) | ✅ also a no-coordination pole                          |
| **distributed / peer**  | **N, coordinating peer-to-peer** (coord:claim / declare-intent / messages / correct each other), **NO central Mug** | **distributed**                       | ❌ **MUST BE BUILT**                                    |
| `pot-realqueen`         | N, central Mug places/evicts/re-places/briefs/wakes                                                                 | **central**                           | ✅ (currently reliability-degraded — EI-1293)           |

The code's `su-independent` is the **NO-coordination** pole ("N independent agents, one task each, NO Mug and NO pot orchestration" — per its own header), **not** distributed coordination. A central-vs-distributed comparison therefore **cannot be run until a distributed/peer-coordination arm is built**. Do not label a no-coordination run as "distributed."

* State explicitly which topology each arm tests. The 2026-06-17 run used `su-independent` = **no coordination** → it tested neither topology, so it says nothing about central-vs-distributed.

### C5 — Identical grader, environment, and exclusion policy

* Same grading harness, same `FAIL_TO_PASS`/`PASS_TO_PASS` (or the benchmark's own scorer), same docker images, same per-task timeouts, same repo base commit.
* **The clone/grade mechanism is PER-BENCHMARK (pluggable), but identical across ARMS within a benchmark.** Two grading models exist and the shared driver supports both via a `clone/grade` seam: (a) **diff-extraction** — clone repo → agent edits → extract `git diff` → score the patch out-of-band (SWE-bench-Pro: `swe_bench_pro_eval.py --use_local_docker`); (b) **in-container / own-scorer** — the task runs inside its own container and the benchmark's *own* scorer judges the end state, never a diff (FrontierSWE, TheAgentCompany). A benchmark picks one; every arm in that benchmark uses it identically. Fairness is across arms, not across benchmarks.
* The grader's **omission/exclusion policy is applied identically** to both arms, and any omission is **reconciled into the C1 denominator** (an omitted row is a `false`, not a vanished row).
* **Grader statuses MUST be canonical** (`passed`/`failed`/`error`/`timeout`). An empty or wrong submission is a **scored `failed`** (`resolved:false`) — never a bespoke status like `empty-diff`. A non-canonical status coerces to `error`, which `bench-metrics` reads as **infra** and silently drops the row from the exclude-infra denominator — flattering the arm (a one-layer-down C1 denominator-shrink; D-023). Keep nuance like `empty-diff` in the detail field, not in the status.
* Run both arms through the **same grader code path** (don't grade arm A one way and arm B another).

### C6 — Reliability / coverage parity (infra must not differentially penalize)

* Infra faults (rate-limit false-pause, heartbeat-reclaim of slow-but-alive workers, gateway wedges, OOM, timeouts) must **not** hit one arm harder than the other.
* If an arm has infra-induced non-completions, you MUST either (a) **fix the infra and re-run**, or (b) **count them as `false`** in the shared denominator and **disclose** them — never silently drop. A coverage gap caused by *our* infra is still a real result, but it must be visible and not asymmetric.
* Track per-arm: attempted, produced-output, infra-failed, capability-failed — separately.

### C7 — No contamination / leakage

* No solution/test-patch leakage into any agent's context. Same context budget and same allowed tools class (modulo the capability under test).
* Same retrieval/hints available to both arms.

### C8 — Statistical validity

* N large enough and **stratified** (e.g. easy/medium/hard); report **per-tier**.
* For a headline claim, **≥ 2 seeds/repeats** per arm to expose variance (agent runs are stochastic); report mean ± spread, not a single run.
* Don't claim a win inside the noise band (a 53% vs 50% single-run gap on N=30 is \~1.5 tasks — almost certainly not significant).

### C9 — Reference validation

* The **reference arm's score must reproduce its published number** (within noise). If mini-swe-agent scores far from its SEAL-published \~52%, the harness is miscalibrated — fix before comparing.

### C10 — Transparent reporting

* Every report includes: N (and the shared denominator), the per-instance matrix, per-arm model (telemetry-verified), per-arm `$/task` + `calls/task`, the budget regime (iso-budget or best-effort), which capability each arm tests, infra-failure counts, seeds, and **this fairness-audit table**.

## The mandatory pre-claim audit table

Produce this for every run; fill PASS/FAIL/N-A with evidence:

| #   | Criterion                                 | Status | Evidence |
| --- | ----------------------------------------- | ------ | -------- |
| C1  | Same task set + same scoring denominator  |        |          |
| C2  | Same model (telemetry-verified)           |        |          |
| C3  | Compute parity (iso-budget) or disclosed  |        |          |
| C4  | Capability-under-claim actually exercised |        |          |
| C5  | Same grader/env/exclusion                 |        |          |
| C6  | Reliability/coverage parity               |        |          |
| C7  | No contamination                          |        |          |
| C8  | Statistical validity (N, tiers, seeds)    |        |          |
| C9  | Reference reproduces published number     |        |          |
| C10 | Transparent reporting                     |        |          |

## Worked audit — 2026-06-17 su-independent vs mini-swe-agent (Opus 4.6, stratified-30)

| #   | Criterion              | Status             | Evidence                                                                                                                                                                                                   |
| --- | ---------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Same set + denominator | **FAIL**           | Same 30 input, but su **scored on 22**, mini-swe on **30** (su produced no diff on 8 huge repos). Headline leaned on the 72.7% real-diff-22 view, which drops su's 8 non-attempts.                         |
| C2  | Same model             | **PASS**           | Per-arm telemetry verified `claude-opus-4-6` (su `agent_usage_samples`; mini-swe litellm).                                                                                                                 |
| C3  | Compute parity         | **FAIL**           | Not iso-budget. mini-swe 14.5 calls / $1.13 per task; su \~$4.97/task (≥2–4× even excluding retries). No budget cap.                                                                                       |
| C4  | Capability exercised   | **FAIL**           | Ran `su-independent` = **one cup per task, no coordination**. The coordination/communication advantage was **never tested**. cap=2 was 2 *different* tasks (no overlap).                                   |
| C5  | Same grader/env        | **PASS**           | Both via the same `_xbench_grade.py` → `swe_bench_pro_eval.py --use_local_docker`.                                                                                                                         |
| C6  | Reliability parity     | **FAIL**           | su's 8 non-attempts were largely infra (heartbeat-reclaim of slow cups on huge repos, \[EI-1293]); the run was also repeatedly degraded by a governor false-pause. Asymmetric vs mini-swe (0 infra-fails). |
| C7  | No contamination       | **PASS** (assumed) | Same task inputs; no leakage identified.                                                                                                                                                                   |
| C8  | Statistical validity   | **FAIL**           | Single seed; 53% vs 50% on N=30 is \~1.5 tasks — inside noise.                                                                                                                                             |
| C9  | Reference validation   | **PASS**           | mini-swe 50% ≈ SEAL-published \~52%.                                                                                                                                                                       |
| C10 | Transparent reporting  | **PARTIAL**        | Initial report over-led with 72.7%; corrected after audit.                                                                                                                                                 |

**Verdict:** that run is **not a fair comparison** and supports **no** capability claim. The only mildly-robust signal (su solved 2 hard tasks, mini-swe 0) is single-seed and not compute-matched.

## Coordination-topology roster (the study)

The benchmark is a **coordination-topology comparison**, all arms on the same tasks, same model, **same per-task model-call budget (iso-call-budget)**, same denominator. Each arm is a pluggable **topology strategy** over one shared pool driver (so adding/removing an arm is a small config, not a new driver). Axes: *locus* (none / central / distributed-flat / hierarchical) × *mechanism* (none / direct-message / shared-artifact / review / aggregation) × *granularity* (per-backlog / per-task).

Most arms map 1:1 to a topology **blueprint** (the `spine.claimModel` + `coordination` schema section); the run driver resolves the spec → the right spawn shape. "blueprint+driver ✅" = the topology is declared + the unit-tested driver runs it; the only remaining step for a live run is the consumer's `runAgent` binding (fleet-spawn-backed) — see *Runtime enforcement* below.

The column below is the **arm id** (the `ArmId` on every `TaskRunResult` row), which is **not always a literal `blueprint.yaml` id**. The `dist-*` / `pair` / `hier-lead-worker` / `ensemble-solve` arms *are* topology blueprint ids, but the three poles resolve differently: `mini-swe` is the external baseline (its su-side floor solver is the `coding-solo` blueprint); `su-independent` is the **default** `resolveCoordinationSpec` resolution (no `coordination` block → `decider-dispatch`, no comms), not a file named `id: su-independent`; and `pot` resolves from any `kind:'pot'` blueprint (e.g. `coding` or `work`), since `central` is set by `bp.kind==='pot'`, not by an id literally `pot`.

| Arm (id)           | Locus                        | Mechanism                                                                                  | Status                                                               |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `mini-swe`         | none (1 agent)               | —                                                                                          | ✅ baseline floor (solver: `coding-solo`)                             |
| `su-independent`   | none (N isolated)            | —                                                                                          | ✅ no-coordination pole (default spec, not a file id)                 |
| `dist-broadcast`   | distributed-flat             | self-claim + declare-intent + broadcast findings                                           | ✅ blueprint+driver                                                   |
| `dist-peer-review` | distributed-flat             | self-claim + peer-review diffs before submit                                               | ✅ blueprint+driver                                                   |
| `dist-repo-huddle` | distributed (per-repo group) | same-repo agents share understanding + co-edit                                             | ✅ blueprint+driver                                                   |
| `dist-blackboard`  | distributed-flat             | indirect via shared scratchpad (stigmergic; `coord:send` forbidden)                        | ✅ blueprint+driver                                                   |
| `ensemble-solve`   | none-during, aggregate-after | solve-N-independently → judge picks/merges (`aggregate:judge-best`)                        | ✅ blueprint+driver (key control)                                     |
| `pair`             | per-task pair                | driver writes / navigator continuously reviews                                             | ✅ blueprint+driver                                                   |
| `hier-lead-worker` | hierarchical (elected lead)  | a lead runs a coordination pass (charged to the iso-budget), then workers execute under it | ✅ blueprint+driver                                                   |
| `pot`              | central                      | Mug places/evicts/re-places/briefs/wakes                                                   | ✅ (`kind:'pot'` blueprint; reliability-degraded → F-FIX-038/EI-1293) |

**Framework (built):** a topology is a blueprint, resolved to a `CoordinationSpec` by `resolveCoordinationSpec` (`coordination-topology.ts`), mapped to per-team spawn plans (directive + tool-scope + team grouping) by `coordination-runtime.ts`, and executed by `runTopology` (`run-topology.ts`). The driver is generic across benchmarks via two injected seams: a per-benchmark `CloneGradeSeam` (clone/grade — identical across arms, C5) and a `runAgent` (the fleet-spawn-backed agent invocation). SWE-bench-Pro (diff) and FrontierSWE (in-container) both wire onto it.

### Runtime enforcement — how the driver makes C1 + C3 + C4 mechanical (not aspirational)

* **C1 (same denominator):** `runTopology` emits a `TaskRunResult` row only for tasks it actually ran. A task the iso-budget couldn't reach gets **no row** — and `buildCapabilityAttribution` (default `sameDenominator:true`) counts a task with no row, or one whose rows are all infra-failed, as **`false`**. So a less-efficient arm that finishes fewer tasks is penalised, never flattered by exclusion (the exact failure mode of the 2026-06-17 audit). The report's task universe is the full backlog; `skippedTaskIds` is surfaced for the C6 coverage table.
* **C3 (iso-budget):** one `IsoBudget` (`maxModelCalls` primary when configured, + `$`/tokens/wall) is applied **uniformly** across every arm and is a **hard ceiling** checked before each task-unit dispatches (bounded ≤`cap` overshoot, since a unit's call cost is only known after it runs). A cap-terminated attempt sets `capped:true` (graded normally — a capped run ≠ a genuine fail). The row contract persists `budgetTokens`; call/cost/wall ceilings are enforced by the driver but must be carried in the run report/config evidence until the row contract grows those fields. The driver's operative defaults (both overridable per run): per-task concurrency **`cap = 2`** and ensemble size **3 solvers/task** — these are the knobs behind the worked-audit's `cap=2` reference.
* **C4 (capability actually exercised):** each agent run reports `coordCalls` (the count of coordination tool calls it actually made); the driver sums it onto `armMeta.coordCalls`. A coordination arm whose rows show `coordCalls ≈ 0` is **C4 NEEDS-EVIDENCE** — the topology was never exercised, so any "delta" is variance, not capability (the trap that sank a peer's tau2 +memory "lift": the +memory arm made zero memory calls). Verify coordination is non-zero on a probe before any claim.
* **No-debris teardown:** each run retires its **own** work-items (`retireBenchDebris`, scoped to the run's pot slug) on clean exit AND signal-kill/crash — scoped so it can never deprecate a concurrent peer benchmark's in-flight items.
* **Constant per-task solver (D-006 — the topology study's fairness factorization):** the topology study isolates *cross-agent coordination* as the only variable, so the *per-task solver* must be held CONSTANT across every one-agent-per-task arm. Every su-system arm (`su-independent`, `dist-*`, `hier-lead-worker` workers, `pot` cups) runs the **full external-bench su spine** (scoper→architect→worker→validator→reviewer→documenter→curator) as its per-task solver — never a single plain worker. `ensemble-solve` = N full-spine attempts + a judge; `pair` = two su-**role** workers on one task (the spine already has an internal reviewer); the coordinators (`hier` lead, `pot` Mug) are su-role coordinators, not solvers. The baseline (`mini-swe`/`vanilla`) is `coding-solo` (a single plain agent — the floor, deliberately NOT the su system). Using a weaker solver for the coordinated arms would confound "topology" with "weaker agent than su-independent." Wired by `sweProSolverBlueprint(arm)` in `swe-pro-seam.ts`; `vanilla` ≠ `su-independent` (same `su-independent` topology, different solver → isolates the su-spine capability; `su` vs `pot` share the spine, differ in topology → isolates coordination).

## What a fair run requires (the build target)

1. **Same denominator**: score both arms on all N; an empty/infra-failed task is `false`, not excluded.
2. **Iso-budget**: cap both arms to the same per-task budget (token or `$` or call-count); report score-at-budget.
3. **Fix the infra** so coverage is symmetric (\[EI-1293]: don't reclaim slow-but-alive workers; the governor false-pause fix; gateway resilience) — then re-run; a coverage gap must be capability, not infra.
4. **Run the arm that tests the claim**: for the coordination advantage, the **pot/Mug multi-worker-per-task** config — multiple workers overlapping + communicating on the same task — against the same reference.
5. **≥ 2 seeds**, per-tier, full per-instance matrix.
6. **Audit table above, all PASS**, before any claim.
