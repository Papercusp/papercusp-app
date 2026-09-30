# Pot-instrument feasibility — go/no-go (P-029 / BRIEF 1 v2, Phase 5)

> The P-001/D-008 analog for the **fleet layer** (POT REFRAME, D-010). Research only.
> Owner: su-dc09a (2026-06-14). Plan: `impartial-benchmark-suite-2026-06-15` (P-029).
> Consumed by P-027 (value-capture, ec8fe), P-026 (MAST coordination, 4ac61), P-028
> (competitor orchestrators, 8c30f), P-025 (fleet metrics, 4ac61), P-016 (methodology,
> a3645). Pairs with D-008 (the per-task L1 grader feasibility).

## TL;DR — verdict per instrument

| Instrument | Layer | License / access | Grading | Integration | Verdict |
|---|---|---|---|---|---|
| **SWE-Lancer** | L3 value | public (arXiv 2502.12115) | **automated E2E tests** | reuses P-005 M1 diff/grader | ✅ **GO — use this for P-027** |
| **UpBench** | L3 value | ❌ proprietary to Upwork, no release, no license | ❌ **human experts per submission** | not programmatically re-runnable | 🚫 **NO-GO as a run** — cite as economic framing only |
| **MAST** | L4 coordination | code+data public; ⚠ **no declared LICENSE** | LLM-as-Judge (released notebook) | MEDIUM — convert our traces; dep on P-010 | ✅ **GO (standout)** — resolve license + trace schema |
| **MultiAgentBench / MARBLE** | L4 coordination | **MIT** (arXiv 2503.01935) | milestone KPIs (LLM-judged) | HIGH to plug our pot in (only Werewolf documented) | 🟡 **CONDITIONAL** — methodology/topology cite; direct run = deeper spike |
| **OpenHands async / CAID** | L2 throughput | benchmarks repo open; CAID = arXiv 2603.21489 | external (Commit0/PaperBench) | runnable competitor (P-028) + must-cite analog | ✅ **GO as reference/competitor** — ⚠ citation fix (below) |

**Two things to action immediately:** (1) P-027 should build a **SWE-Lancer** runner, NOT UpBench. (2) D-010's "1.8–3.7× speedup / 6× cost" citation is **unsourced/mis-attributed** — fix before P-016 publishes.

---

## 1. L3 value-capture — SWE-Lancer GO, UpBench NO-GO

### UpBench (arXiv 2511.12306, Upwork) — 🚫 NO-GO as a runnable arm
- 322 real, economically-verified Upwork jobs; 9 domains; rubric of 5–20 criteria/job; $ outcomes; dynamically refreshed (great contamination story *in principle*).
- **Access:** proprietary to Upwork. **No public dataset/download, no license, no eval harness/SDK** in the paper.
- **Grading is HUMAN:** expert freelancers assess each submission per-criterion. There is no automated grader — running a *new* agent requires contracting Upwork's freelancer network or rebuilding the pipeline. **Not repeatable/impartial-reproducible for us.**
- → **Verdict: do not build an UpBench runner.** Cite UpBench as motivation/economic-framing only.

### SWE-Lancer (arXiv 2502.12115) — ✅ GO (the L3 instrument to actually build)
- $1M of real freelance SWE tasks, **publicly released, automated end-to-end (E2E) test grading** — real "$ of work completed under a fixed budget," which is exactly the L3 value-capture claim D-010 wants (Mug's $-placement vs naive scheduler).
- Reuses the P-005 M1 diff→grader path more directly than any rubric benchmark.
- **P-027 (ec8fe): build the SWE-Lancer $-weighted backlog runner.** UpBench stays a citation.

## 2. L4 coordination-quality — MAST GO (standout), one license caveat

**MAST** — arXiv 2503.13657 (NeurIPS 2025); repo `github.com/multi-agent-systems-failure-taxonomy/MAST`; data `huggingface.co/datasets/mcemri/MAST-Data` (1600+ annotated traces, 7 MAS frameworks).
- **14 failure modes in 3 categories:** (i) **system-design** issues, (ii) **inter-agent misalignment**, (iii) **task verification**.
- **Baseline to cite (from the paper — verify exact figures against 2503.13657v2 before publishing):** MAS failure 41–86%; the D-010 figures (token/role duplication ~53–86%, inter-agent misalignment ~36.9%) come from the paper — re-confirm verbatim at publication time, do not paraphrase loosely in an impartiality doc.
- **LLM-as-Judge pipeline IS released:** `llm_judge_pipeline.ipynb` (paper: 94% acc, Cohen's κ 0.77 vs experts). This is what makes MAST our **scalable, third-party-defined coordination grader** — we score OUR fleet's traces with *their* judge and compare to *their* published baseline + competitors (P-028). The most differentiated AND most impartial Pot claim (someone else defined "what counts as a coordination failure").
- **Integration cost — MEDIUM, two prerequisites:**
  1. **Trace schema:** the judge ingests trace JSON; the exact required fields for an *external* MAS trace aren't documented at README level (their corpus is `*_dataset.json`). → one code-read of `llm_judge_pipeline.ipynb` to pin the input schema, then **P-010 (66ad9) must emit our fleet/coordination events (locks, work_item dedup/redundancy-judge, hand-offs, misalignment) in a MAST-convertible shape.** This is the key cross-brief dependency for P-026.
  2. **⚠ LICENSE:** no LICENSE file at the repo's standard path (`/main/LICENSE` → 404). Citing their *published numbers + methodology* is always fine (fair use of published findings). **Running their judge code / redistributing derived comparisons needs the license clarified** — open a GitHub issue / email the authors, OR re-implement the 14-mode rubric from the paper text (the taxonomy is fully published) and run it through our own LLM-judge. Re-implementation is the safer impartial path and avoids the license question entirely.
- **P-026 (4ac61) + P-010 (66ad9): GO**, gated on (1) trace schema + (2) license/re-impl decision.

## 3. MultiAgentBench / MARBLE (arXiv 2503.01935, ACL 2025) — 🟡 CONDITIONAL

- Repo `github.com/ulab-uiuc/MARBLE`, **MIT licensed**; modular ("extend or replace agents, environments, LLM integrations"); 6 domains (research-proposal, Minecraft, DB-error, collaborative coding, Werewolf, resource bargaining); **milestone-based KPIs** for collab+competition; evaluates topologies (star/chain/tree/graph) + strategies.
- **Integration:** only the **Werewolf** runner is documented (`scripts/werewolf/run_simulation.sh`); the generic "plug your own MAS as system-under-test" interface is not documented at README level → a real run of our pot inside MARBLE needs a code-level spike.
- **Verdict:** use as a **methodology + coordination-KPI + topology citation** (frame the Mug as a *learned* topology/scheduler vs MARBLE's fixed star/chain/tree/graph). For P-028's "vs other multi-agent systems," prefer the directly-runnable competitors (§4) over bending MARBLE. Revisit a direct MARBLE run only if P-028 wants its milestone-KPIs specifically.

## 4. L2 throughput + competitors — OpenHands async / CAID, CrewAI, LangGraph

- **No off-the-shelf public *fleet-throughput* benchmark exists** (D-010 already concedes this). → L2 impartiality rests on **public TASKS + external GRADER + the Mug-ablation baseline (P-023) + pre-registration** — apples-to-apples *within our own system* (pot vs naive-FIFO over the same task SET). External async systems are reference/competitor points, not the grader.
- **OpenHands benchmarks** (`github.com/OpenHands/benchmarks`) — open; **32+ parallel isolated containers**; the throughput-harness reference + a runnable P-028 competitor.
- **OpenHands CAID** (arXiv 2603.21489; blog "Effective Strategies for Asynchronous SWE Agents", 2026-04-27) — dependency-aware concurrent **branch-and-merge** coordination + test verification: the **closest published analog to our Mug+fleet** → must-cite prior art for P-028. Reports **accuracy**: **+14.3% absolute on Commit0, +26.7% on PaperBench** (across Claude 4.5 Sonnet / GLM 4.7 / MiniMax 2.5); "returns diminish as #agents exceeds the number of parallelizable subtasks in the dependency graph."
- **Open SWE** (LangChain) / **CrewAI** / **LangGraph** — open, permissive; runnable competitor orchestrators over our backlog+grader (P-028).

### ⚠ CITATION FIX (for D-010 / P-016 — do before publishing)
D-010 attributes **"1.8–3.7× speedup, up to 6× cost reduction"** to arXiv 2603.21489. **Neither 2603.21489 (CAID) nor the OpenHands async-SWE blog states those multipliers — both report the accuracy deltas above.** The speedup/cost figures are currently **unsourced**. Action: either (a) locate the real source for 1.8–3.7×/6× and cite it, or (b) drop the multipliers and state throughput as *our own measured* pot-vs-serial speedup (P-025) instead. An unsourced quantitative claim in an *impartiality* methodology doc is a credibility risk — flagged to @a3645 (P-016) + @10912.

## 5. Cross-cutting recommendations

1. **Headline impartiality (L2/L4)** = public TASKS + external GRADER (SWE-bench Pro / SWE-Lancer / Terminal-Bench) + the **Mug-ablation baseline** + pre-registration. There is no third-party fleet-throughput benchmark to lean on.
2. **Automated-graded → headline; judge/rubric-graded → diagnostics.** SWE-Lancer (auto E2E) carries L3 headline; MAST-judge + MARBLE-KPIs are diagnostics/coordination-quality.
3. **MAST is the standout L4 lever** — resolve (a) trace-input schema with P-010, (b) license (prefer re-implementing the published 14-mode rubric over running their unlicensed code).
4. **SWE-Lancer replaces UpBench** for L3 (UpBench is proprietary + human-graded).
5. **Fix the OpenHands speedup citation** in D-010 before P-016 publishes.

## 6. SWE-Lancer official harness — build detail for P-027 (ec8fe)

Addendum (the L3 instrument I greenlit; the D-008 §2 analog for SWE-Lancer).

- **Where:** the SWELancer codebase **merged into `github.com/openai/preparedness`**, dir
  **`project/swelancer`** (the standalone `openai/SWELancer-Benchmark` repo is now an
  archived pointer). **MIT license.** Run path: `cd project/swelancer` → `uv sync` →
  follow `project/swelancer/README.md`. Public via a **unified Docker image** + the
  **SWE-Lancer Diamond** public split.
- **Two task types — only ONE is a coding/diff arm:**
  - **IC-SWE (Individual Contributor SWE)** — the model gets the issue text + repro steps +
    the codebase checkpointed *before* the fix; produces a patch. **Grading = apply the
    patch → run the associated Playwright end-to-end (browser) tests in the Docker image;
    resolved iff the E2E suite passes.** This is **M1 (diff-batch) — reuses the P-005
    clone→harness→extractDiff→Docker-grader path directly.** Each task carries a **$payout**
    field ($50 bug-fix → $32k feature).
  - **SWE-Manager** — the model chooses among technical proposals, graded against the
    original hiring manager's choice. **Multiple-choice, NOT a diff/coding task** → exclude
    from the coding value-capture arm (or run as a separate "decision" task type; it's the
    closest analog to a Mug-picks-the-plan probe, but graded differently).
- **Value-capture metric (maps to P-025 + P-023):** value-captured = **Σ $payout of
  resolved IC-SWE tasks under a fixed $ budget** — this "$ earned / $ available" framing is
  SWE-Lancer's *native* metric, so it drops straight into the Mug-placement-vs-naive-FIFO
  $ comparison (P-023) with no rubric/human grader (unlike UpBench).
- **Infra:** the unified Docker image bundles the Playwright/browser deps; same
  Docker-on-the-box story as SWE-bench Pro (§D-008). Grade on a dedicated volume.
- **Confirm at build time (couldn't verify via fetch — repo README is authoritative):**
  the exact **Diamond task count + $ total** of the public split, the exact submission/patch
  format, and whether the E2E images need network access. The IC-SWE M1 shape is the
  load-bearing fact and is confirmed; these are parameters, not blockers.

## 7. MAST 14 failure modes — the signal list (for P-010 capture + P-026 compute)

The concrete taxonomy P-010 (66ad9) must make computable from fleet/coord traces and P-026
(4ac61) scores. Source: arXiv 2503.13657 (NeurIPS 2025); overall MAS failure rate **41% →
86.7%** across 7 SOTA systems. Since I recommend re-implementing the rubric (license, §2),
these are the modes to encode — annotated with the Papercusp signal that already evidences
each, so P-010 knows what to emit:

**Category 1 — System/spec design (FC1)**
- **FM-1.1 Disobey task specification** — output violates the work_item's stated constraints.
- **FM-1.2 Disobey role specification** — an agent acts outside its role (spine role boundaries).
- **FM-1.3 Step repetition** — redundant re-doing of completed steps (← `work_items` dedup /
  redundancy-judge signal; the substrate's anti-duplication is the direct counter-claim).
- **FM-1.4 Loss of conversation history** — context truncation drops recent interaction.
- **FM-1.5 Unaware of termination conditions** — no recognition of when to stop.

**Category 2 — Inter-agent misalignment (FC2)** *(the substrate's strongest story)*
- **FM-2.1 Conversation reset** — unwarranted dialogue restart, context lost.
- **FM-2.2 Fail to ask for clarification** — proceeds on unclear input instead of asking.
- **FM-2.3 Task derailment** — drifts off the intended objective.
- **FM-2.4 Information withholding** — fails to share data others need (← durable
  `messages:send`/work_item-scoped hand-offs are the counter-mechanism).
- **FM-2.5 Ignored other agent's input** — disregards peer input (← coord inbox injection /
  ack discipline).
- **FM-2.6 Reasoning-action mismatch** — does something other than what its reasoning says.

**Category 3 — Task verification (FC3)**
- **FM-3.1 Premature termination** — ends before objectives met.
- **FM-3.2 No/incomplete verification** — skips checking outcomes (← validator/reviewer spine roles).
- **FM-3.3 Incorrect verification** — validates but wrongly.

**For P-010:** emit per-rollout coordination events that let a judge detect these — at minimum:
role/agent id per action, hand-off edges (who→whom, what), work_item dedup/redundancy-judge
hits (FM-1.3), lock contention/duplication, ack/ignore of injected coord messages (FM-2.5),
and termination/verification events (FC3). **For P-026:** run the re-implemented 14-mode
judge over those traces → per-mode + per-category rates → compare vs the 41–86.7% baseline +
the P-028 competitor orchestrators. The headline L4 claim = our FC2 (misalignment) +
FM-1.3 (duplication) rates are materially below the published baseline *because* of the
substrate (locks, dedup, durable hand-offs).

## References
arXiv 2502.12115 (SWE-Lancer), 2511.12306 (UpBench), 2503.13657 (MAST; repo
multi-agent-systems-failure-taxonomy/MAST + HF mcemri/MAST-Data), 2503.01935
(MultiAgentBench/MARBLE, ulab-uiuc/MARBLE, MIT), 2603.21489 (OpenHands CAID) +
openhands.dev async-SWE blog 2026-04-27, github.com/OpenHands/benchmarks,
langchain-ai/open-swe. Pairs with D-008 + apps/operator/docs/external-bench-grader-feasibility-2026-06-15.md.
