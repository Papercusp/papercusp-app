# Impartial Benchmark Methodology + Reproducer
## Papercusp Pot — the reproducible evaluation guide

> **Status:** Methodology skeleton + reproducer procedures. Finalize numerical results after mini-swe-agent baseline completes. Author: WI-191 (P-016). Published: no (D-005 hard gate: owner sign-off required before external publication).

> **Date:** 2026-06-17. Mini-swe-agent baseline: in progress (expected completion ~2026-06-18).

---

## I. Executive Summary

This document specifies the **reproducible methodology** for the Papercusp Pot benchmark suite — the framework by which we demonstrate that the Pot (the Mug + cup fleet + coordination substrate) solves real software engineering tasks more effectively, faster, and per dollar than existing single-agent and multi-agent baselines.

**The thesis under test:**
> Given a real backlog under a fixed budget, the same model embedded in the Papercusp Pot delivers **more value, faster, per dollar** — with **dramatically lower coordination-failure rates** — than the same fleet with the Mug ablated (naive FIFO), and than other multi-agent frameworks.

**The control framework:**
- **Treatment**: Papercusp Pot (Mug + fleet + coordination substrate)
- **Primary baseline**: Same fleet with Mug ablated (naive FIFO placement)
- **Secondary baselines**: 
  - **A** (internal ablation): per-task single-agent worker vs multi-agent spine
  - **B** (native harness floor): same model in its provider's native harness (Claude Code)
  - **C** (best-of-N): single agent sampled N times with test-verifier at matched token budget

**The benchmark suite** (layered):
- **L1 — competence floor**: SWE-bench Pro, Terminal-Bench 2.0 (per-task, baseline = single agent)
- **L2 — throughput / cost**: same backlog handed to the Pot; wall-clock speedup, tasks/$, backlog-drain time, autonomy (% with zero human gate); baseline = Mug-ablated fleet
- **L3 — value-capture**: SWE-Lancer $-weighted backlog under a fixed budget; $ captured by Mug placement; baseline = naive scheduler
- **L4 — coordination-quality**: MAST taxonomy (duplication, coordination-breakdown, misalignment) vs published 41–86% MAS baseline
- **L5 — long-horizon / dependency**: SWE-EVO, RoadmapBench (sequencing + multi-step)

**Impartiality commitment**: public third-party tasks + external official graders + reproducible rollout records + third-party re-execution (no self-authored, self-graded results).

---

## II. What's Held Constant (Fairness Protocol)

All arms run under **identical constraints** except for the harness/orchestration itself:

| Dimension | Constraint | Notes |
|-----------|-----------|-------|
| **Model ID** | Exact same Claude model (e.g., claude-opus-4-8) | No different models across arms; no fallbacks to weaker models mid-run |
| **Reasoning effort** | Identical (e.g., `thinking: 3000`) or off for all | No partial-mode heterogeneity |
| **Temperature, max-tokens** | Fixed per-arm (e.g., T=0.7, 8192 tokens) | Set before the run, never tuned on early results |
| **Base tool capabilities** | Identical set (read, edit, bash, test-exec, search) | No feature gating per arm; no "we gave arm A better tools" |
| **Task instances** | Exact same tasks + test suites + base commits | Each arm solves the identical problem, not a variant |
| **External grader** | Single official grader per benchmark family (e.g., swe_bench_pro_eval) | Byte-for-byte identical grading logic across arms |
| **Infra-failure retry policy** | Same retry logic + timeouts for all arms | No special recovery for one arm |
| **Automation level** | Zero human gates for any arm, or identical gates for all | No human oversight asymmetry |

**Why this matters**: "We win" must not secretly mean "we spent 7× tokens" or "we gave ourselves better tools." The cost/accuracy Pareto (below) is the honest statement: net of ALL overhead, better per dollar.

---

## III. The Three Baselines — Run All Three

Each baseline proves a distinct property. Running only one leaves a hole a skeptic can exploit.

### Baseline A — Internal Ablation (Spine-OFF)

**Hypothesis:** the coordination *itself* causes the lift, not more compute or better plumbing.

**Setup**: Papercusp framework, identical tools/model/infra/budget — **only difference: the multi-agent spine is collapsed to a single worker agent** (no scoper, no architect review, no hand-offs; one agent runs the entire feature to DONE).

**What it proves**: if Baseline A and the Pot are identical except orchestration, any delta in **A** is purely the effect of the multi-agent spine and coordination substrate (locks, `work_items`, peer hand-offs, async review). Causal isolation.

**Implementation**: use the existing `gym` A/B ablation machinery (`libs/papercusp/packages/external-bench/coding-solo.ts` blueprint, spine-collapsed; run as an internal experiment).

**Cost**: same as the Pot arm (both run the same total token budget).

---

### Baseline B — Native Harness (Baseline Competence Floor)

**Hypothesis**: the Pot beats the provider's *own* shipped agent — the real purchase decision for a buyer.

**Setup**: the model (e.g., Claude) in its *native harness* (e.g., Claude Code on the same Opus), NOT a deliberately weak toy scaffold. **Apply the same per-task problem statement, run to DONE, extract final diff, grade by the same official grader.**

**What it proves**: (1) we beat the best real alternative (not a strawman); (2) models are tuned for their native harness, so using a minimal generic scaffold (e.g., mini-SWE-agent) would *understate* them — unfair in our favor, and a skeptic will call it. Using the provider's shipped agent is immune to that criticism.

**Implementation**: Harbor-based runner (`external-bench/native-harness-*.ts`), routing to Claude Code via `--agent claude-code` (the provider's first-class SDK). Elicit to its best: full tool access, chain-of-thought, retries.

**Cost**: single agent, one task at a time. Throughput baseline (L2 serial floor).

**Elicitation discipline** (METR): if Baseline B fails even easy tasks, the elicitation is broken, not the harness. Fix the setup rather than scoring the failure — both for fairness and credibility.

---

### Baseline C — Best-of-N at Matched Token Budget

**Hypothesis**: the extra tokens the Pot spends (on coordination overhead) are *justified* by the improvement.

**Setup**: a **single agent** sampled **N times** with a **test-verifier** (independent samples run in parallel; after all N finish, a validator runs the visible tests on each; best-passing solution is selected) — all at the **same total token budget as the Pot arm**.

**What it proves**: (1) a strong, cheap baseline (repeated sampling + verification is simple and effective); (2) if the Pot doesn't beat it, the orchestration overhead isn't earning its tokens.

**Implementation**: `external-bench/baseline-best-of-n*.ts`, with `runBestOfNPilotTask`. Uses the same external-bench spine (for fairness), but N independent runs instead of 1. Test-verifier selects best passing result.

**Cost**: total tokens capped to match the Pot's iso-budget spend, divided across N samples.

---

## IV. Cost Model + Fair-Comparison Controls

### Iso-Budget Frame

**Every arm runs under the same total token budget (or $)**, to ensure no "we win because we spent 7×" claims.

- **Pot arm**: full fleet orchestration cost (Mug placement, cup coordination, locks, hand-offs, roll-up) **counted in our own token total**.
- **Mug-ablated arm** (L2 baseline): same fleet, same coordination substrate, but naive FIFO placement (no Mug intelligence).
- **Native harness arm** (Baseline B): single agent, serial throughput.
- **Best-of-N arm** (Baseline C): N samples at same total-token budget, test-verifier selects.

**The honest claim**: "Net of all coordination overhead, better per dollar."

### Cost/Accuracy Pareto

Report a **Pareto scatter**: x-axis = tokens/$ spent, y-axis = pass@1 (or % resolved). Show **every arm on the same plot**. The Pot should occupy a **strictly better point** (higher accuracy, lower cost) than other arms.

- If the Pot is lower-left (cheaper, worse), it's not a win.
- If it's right (expensive, better), we spent more tokens to win — which is fine if the delta is large enough to justify it, but the Pareto makes the trade-off transparent.

### Statistics + Confidence

- **Pass@1** averaged over **≥3 seeds** with **95% confidence intervals** (these benchmarks are noisy; one seed is unreliable).
- **Same pass@k protocol for every arm** (never "our pass@5 vs their pass@1"); use the same definition of "pass" (e.g., FAIL_TO_PASS ∧ PASS_TO_PASS for SWE-bench Pro).
- **Reliability metric** (pass^k or "consistent success rate") if consistency is part of the story.

---

## V. Contamination Handling

### Firewall: Gym ↔ Benchmark Sets

The **gym** (internal self-referential loop) must **NEVER** tune on any set this suite reports on. Optimize-on and report-on sets stay strictly disjoint.

- **Report-on sets**: SWE-bench Pro, Terminal-Bench 2.0, SWE-Lancer, SWE-EVO, MAST (D-012 in code + CI guard: `report-set-firewall.ts`).
- **Gym optimize-on sets**: internal iq-battery, pot-eval, ablation_report (self-authored, not third-party).

**Enforcement**: pre-registered config in git before the run (no post-hoc tuning).

### Contamination-Resistant Freshness

Preferred (strongest):
1. **SWE-bench-Live** (OpenHands-maintained, fresh tasks added monthly)
2. **SWE-rebench** (fresh tasks, once the adapter is proven)

Current baseline (susceptible to historical contamination, but mitigated by pre-registration + external grading):
1. **SWE-bench Pro** (public, but released ~9 months ago; LLMs may have seen it in training)

Retired (do NOT use as headline):
1. **SWE-bench Verified** (OpenAI retired it 2026-02-23: 59.4% flawed tests + universal contamination)
2. **HumanEval / MBPP** (saturated; model-level, not harness-level)
3. **LiveCodeBench** (contamination-free but single-agent only, not fleet-oriented)

---

## VI. How to Reproduce

### Prerequisites

1. **Infrastructure**:
   - Docker 29.4.0+ on a dedicated host (for grader images; ~100 GB available for `jefzda/sweap-images:*` pulls).
   - Papercusp running (operator `:3070`, Tauri or server mode).
   - Claude model API access (Opus-level token budget under the iso-budget cap).

2. **Datasets**:
   - SWE-bench Pro: HF dataset `ScaleAI/SWE-bench_Pro` (`split='test'`), or local clone.
   - Terminal-Bench 2.0: Snorkel repos, installed via Harbor.
   - SWE-Lancer: arXiv 2502.12115 repo (local clone for task definitions).

3. **Registered configs** (pre-run, in git, not tuned after seeing results):
   - Arm blueprints (`external-bench`, `coding-solo`).
   - Seed values (random per task, fixed per arm).
   - Token budgets per arm (iso-budget cap).
   - Model + reasoning-effort settings (frozen).

### Workflow

#### Phase 1: Task Instantiation

For each task in the benchmark set:

1. **Clone the repository** at the specified base commit (e.g., `git clone <repo> && git checkout <baseCommit>`).
2. **Instantiate a fresh harness** (`external-bench` blueprint) with the problem statement as a feature.
3. **Seed the feature** with the task's issue description and acceptance criteria.

#### Phase 2: Arm Execution (Parallel)

Run each arm **independently**:

- **Pot arm**: `startHive(harnessBlueprintId='external-bench', ...); waitForDone()`
  - The Mug orchestrates the cup fleet over the backlog.
  - Cups run per-task `coding` pipelines to DONE.
  - Measure: wall-clock time, tokens (from `agent_usage_samples`), final diff.

- **Mug-ablated arm**: `startHive(harnessBlueprintId='external-bench', planner=fifoPlacement, ...)` (or equivalent: no Mug agent, just FIFO placement).
  - Identical harness + cup fleet + coordination substrate.
  - Only change: placement strategy.

- **Baseline A (spine-OFF)**: `startHive(blueprintId='coding-solo', ...)` (or internal ablation mode).
  - Single worker agent, same tools/model/budget.

- **Baseline B (native)**: Harbor runner, `harbor run -d terminal-bench@2.0 --agent claude-code ...` (or Claude Code instance for SWE-bench Pro).

- **Baseline C (best-of-N)**: N parallel samples (`externalBench/baseline-best-of-n`), test-verifier selects best.

#### Phase 3: Diff Extraction + Grading

For each arm's per-task result:

1. **Extract final diff** (`git diff baseCommit...HEAD > task.patch`).
2. **Submit to official grader** (batch mode, e.g., `swe_bench_pro_eval.py`).
3. **Record**: `resolved` (FAIL_TO_PASS ∧ PASS_TO_PASS), tokens, wall-clock, raw grader output.

#### Phase 4: Analysis + Reporting

1. **Per-seed results**: average pass@1 over ≥3 seeds, compute 95% CIs.
2. **Cost/accuracy Pareto**: scatter plot (tokens vs pass@1), highlight the Pot arm.
3. **Throughput metrics** (L2): wall-clock speedup vs serial, tasks/$, tasks/hour, backlog-drain time, autonomy.
4. **MAST coordination scores** (L4): duplication, coordination-breakdown, misalignment vs 41–86% baseline.
5. **Value-captured** (L3): $ captured under fixed budget (SWE-Lancer arm).

---

## VII. Publication Gate + Integrity Commitments

### D-005 Hard Gate: Owner Sign-Off Required

**Before any external publication**:

1. Owner reviews + approves methodology, results, caveats.
2. Numerical claims verified against official graders.
3. Rollout records public (exact configs, seeds, model versions, raw outputs).
4. Pre-registration confirmed (no post-hoc tuning).
5. Caveat section explicit (model limitations, compute budget, contamination risks).

**No external publication without this approval.**

### Rollout Records (Reproducibility)

Publish **with every result**:

- Blueprint configs (`external-bench.yaml`, etc.) — exact versions used.
- Per-arm seeds (RNG state, task order).
- Model + settings (model ID, reasoning-effort, temperature, max-tokens, tool set).
- Token budgets (iso-budget caps, per-arm breakdowns).
- Raw grader output (`swe_bench_pro_eval.json`, test details, logs).
- Runbook (this document + any modifications, exact command-line invocations).

A third party should be able to reproduce the result by following the runbook + configs.

---

## VIII. Known Issues + Mitigations

### Citation Issue (D-011): OpenHands Speedup

**Current claim in D-010**: "1.8–3.7× speedup, up to 6× cost reduction" (attributed to arXiv 2603.21489, the CAID paper).

**Status**: UNSOURCED. Neither the CAID paper nor the OpenHands async blog state these multipliers — both report accuracy gains (+14.3% Commit0, +26.7% PaperBench), not throughput speedups.

**Resolution (choose one before publishing)**:
1. **Source the claim** (find the paper/blog post that states 1.8–3.7× speedup).
2. **Replace with measured Pot data** (P-025 measured throughput delta from the full run).
3. **Reframe the claim** (cite OpenHands accuracy gains, or MAST coordination-failure reductions).

**Current status**: This methodology doc leaves the citation placeholder. Finalize after mini-swe-agent baseline + first full run complete.

### Pot-Level Concurrency Cap

Early benchmark runs showed placement contention only manifests when **backlog ≫ fleet** (e.g., 11+ tasks, fleet cap 4–5 concurrent cups). The Mug's ranking/eviction/warm-inject only become differentiated under saturation.

**Design implication**: configure benchmarks with **long backlogs** (≥30 tasks) and **tight fleet caps** (≤6 concurrent cups) to exercise the Mug's placement value.

---

## IX. Definitions + Terminology

- **Pot**: Mug + cup fleet + coordination substrate (locks, work_items, coord:*, messages:*).
- **Cup fleet**: collection of autonomous agents placed by the Mug.
- **Mug**: the orchestration agent (autonomous placement / ranking / eviction / warm-inject / adaptive wake).
- **Mug-ablated**: the same cup fleet running under naive FIFO scheduling (no Mug intelligence).
- **Baseline A** (spine-OFF): single-agent worker, same tools/model/budget — isolates orchestration effect.
- **Baseline B** (native harness): the model in its provider's native harness (e.g., Claude Code).
- **Baseline C** (best-of-N): single agent sampled N times with test-verifier, matched token budget.
- **Iso-budget**: all arms run under the same total token budget.
- **MAST**: Multi-Agent Systems Failure Taxonomy (NeurIPS 2025) — measures coordination-failure rates.
- **Firewall**: the gym must NOT tune on the sets this suite reports on.
- **Rollout record**: complete run record (configs, seeds, model versions, raw grader output) enabling third-party reproduction.

---

## X. References + Normative Sources

**Benchmark families**:
- SWE-bench Pro: arXiv 2509.16941
- Terminal-Bench 2.0: Snorkel AI
- SWE-Lancer (value-capture): arXiv 2502.12115
- SWE-EVO (long-horizon): arXiv 2512.18470
- RoadmapBench (long-horizon): arXiv 2605.15846
- MAST (coordination-quality): NeurIPS 2025

**Fair-evaluation methodology**:
- "AI Agents That Matter": arXiv 2407.01502
- METR capability-elicitation guidelines
- "Large Language Monkeys": arXiv 2407.21787
- Rollout Cards (reproducibility): arXiv 2605.12131
- Artificial Analysis Coding Agent Index (third-party leaderboard)

**Related frameworks**:
- Harness-Bench: arXiv 2605.27922
- OpenHands async-SWE work
- Papercusp suite plan: `apps/operator/docs/plans/impartial-benchmark-suite-2026-06-15.md` (decisions D-001–D-027)

---

## XI. Next Steps

1. **Await mini-swe-agent baseline completion** (~2026-06-18): finalize Phase 4 numerical results.
2. **Fix D-011 speedup citation** (source it or replace with measured data).
3. **Run full pilot** (P-032): Pot vs Mug-ablated vs Baseline B/C, ≥3 seeds, official grading.
4. **Compile rollout records** (configs, raw outputs, runbook).
5. **Owner review + sign-off** (D-005 gate).
6. **Submit to third-party index** (Artificial Analysis Coding Agent Index).
7. **Publish** (blog + paper + reproducible runbook).

---

**Document version:** 2026-06-17 · **Status:** Skeleton + reproducer procedures, awaiting numerical results · **Owner approval:** Pending (D-005 gate)
