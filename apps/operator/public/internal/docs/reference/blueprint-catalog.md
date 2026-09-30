# Blueprint catalog
URL: /internal/docs/reference/blueprint-catalog

The built-in harness blueprints — each a declarative harness shape (work-item kind, spine decider, roles, dispatch policy, gates). Generated from the blueprint.yaml source of truth.


> **Generated — do not edit by hand.** Run `npm run gen:doc-projections` (or `npm run gen:doc-blueprint-catalog`).
> Source: `scripts/gen-doc-blueprint-catalog.ts`. Part of `starlight-projection-generators-2026-06-05` (Brief 29).

# Blueprint catalog

A **blueprint** is a harness's declarative shape — its work-item kind, the role spine the engine routes work through (`deriveNext`), its dispatch/concurrency policy, and its finalize gates. Concrete blueprints `extends: base`. The operator instantiates a harness from one of these (`harness:create` / `blueprint:extend`).

Source: `libs/papercusp/packages/harness/blueprints/<id>/blueprint.yaml` (43 concrete + 6 abstract).

## Built-in blueprints

| Blueprint | Extends | Work item | Decider | Dispatch | Roles | Description |
|---|---|---|---|---|---|---|
| `audit` | base | audit-task (`AUD`) | auditor | inherited | 1 | The G2 user-protection gate: a read-only adversarial auditor screens a remote-authored feature and emits an admit/reject verdict; a reject quarantines the feature behind a blocker escalation until a human resolves it. |
| `calibration` | base | mining-run (`CAL`) | — | inherited | 0 | Deterministic learning loop: mature open calibration bets against their domain probes, resolving or voiding past the grace window (the calibration-markets resolution sweep) on a cadence. Pure SQL, no agent. |
| `change-ledger` | base | mining-run (`CLG`) | — | inherited | 0 | Deterministic recorder: git-log the prompt-source roots over a trailing window and offer one behavior-change-ledger row per (commit, file) (the change-ledger repo-edit scan) on a cadence. Pure bookkeeping — git + SQL, no agent, no LLM. |
| `coding` | base | hive-wake (`POT`) | mug | inherited | 2 | The Hive/Hive operator — the Queen in charge of the bee fleet. Wakes on its own self-declared schedule (or an event it subscribed to), surveys the work frontier and bee slots, places ranked tasks onto bees (free slot / graceful-evict+fresh / warm-inject), attaches situational briefs, and declares its next wake. Two roles, both carrying the full Queen role (two-plane coordination, steer-don't-dispatch): the `operator` (the canonical full-role judgment layer, the default decider) and the `queen` (the same role with the dial turned toward placement automation). |
| `coding-factory` | base | feature (`F`) | director | concurrency 4, plan-order | 11 | RETIRED — NOT ACTIVE (2026-06-24, by owner decision). Preserved-but-dormant: its `director` autoloop last fired 2026-05-01 and nothing currently instantiates it. Do NOT treat this as "the active/default coding harness" and do NOT wire new work to it. (It is the per-feature coding spine: director → scoper → architect → worker → validator → reviewer → documenter → curator, opt-in gates tester / security / crosscheck / ui-qa.) Kept intact for future revival — to revive, re-enable instantiation (generate-from-repo `extends`) and restore the director dispatch. |
| `coding-solo` | single-agent | feature (`F`) | worker | inherited | 1 | Baseline A internal ablation: the coding harness with the multi-agent spine collapsed to a single end-to-end worker — identical model / base tools / infra / budget to the full coding spine, only orchestration OFF. The single-agent generation unit for the impartial benchmark suite (also the per-sample unit Baseline C best-of-N samples). |
| `content-fix` | single-agent | content-fix (`CFX`) | content-fixer | inherited | 1 | Fix a git-sync content-guard quarantine: a content-fixer agent fixes ONLY the syntax of the named files so they pass their content detector (an .mdx that won't compile, a curly quote used as code), changes nothing else, leaves the tree clean, and does not push. |
| `cup` | single-agent | task (`BEE`) | cup | inherited | 1 | Launch one generic Pot worker (the `cup` role) — a plain implementation agent the Mug places ranked work + a brief onto. Decoupled from the pipeline guards (no chunk, no spine); the brief rides `extras`, the persona is prompts/cup.md. A cup is kind:'harness' (NOT a pot). |
| `deferral-interest` | base | mining-run (`DIR`) | — | inherited | 0 | Deterministic learning loop: backfill realized deferral costs from history and re-fit the learned deferral-pricing model the queue ranker reads (the deferral-interest refit) on a cadence. Pure SQL + math, no agent. |
| `deliberate` | base | decision (`DLIB`) | — | inherited | 0 | Resolve a decision via the uncertainty ladder: ask the owner, then a diverse vote if unanswered, then a curated escalation if the vote is split. |
| `deploy` | single-agent | deploy-run (`DEP`) | release-manager | inherited | 1 | The release-gate deploy launch: the release-manager agent reviews the gathered deploy plan + staged migrations, makes the go/no-go call, runs the deploy, reads health, and decides rollback. Opus-4.8 @ xhigh — the blast radius is the fleet. |
| `dist-blackboard` | base | feature (`W`) | — | concurrency 4 | 1 | Stigmergic distributed coordination: N peer workers self-claim from a shared queue (no Queen) and coordinate ONLY via a shared blackboard (work-item/scratchpad state) — no direct messaging. |
| `dist-broadcast` | base | feature (`W`) | — | concurrency 4 | 1 | Flat-distributed coordination: N peer workers self-claim from a shared queue (no Queen) and broadcast findings to peers. The fully-distributed pole of the central-vs-distributed study. |
| `dist-peer-review` | base | feature (`W`) | — | concurrency 4 | 2 | Flat-distributed coordination with a peer-review gate: N peer workers self-claim from a shared queue (no Queen); each result is reviewed by a nominated peer before submit. |
| `dist-repo-huddle` | base | feature (`W`) | — | concurrency 4 | 1 | Distributed per-repo huddle: N peer workers self-claim (no Queen); same-repo agents form a group that shares repo-understanding + peer-reviews within the repo — coordination scoped to overlap. |
| `doc-steward` | single-agent | doc-drift (`DOC`) | doc-steward | inherited | 1 | Bring drifted docs back in sync with the code: a doc-steward re-verifies/regenerates each stale doc the freshness sweep flagged (code is truth; preserve historical runbook knowledge), harness_docs:verify to clear the flag, leave the tree clean, and does NOT push. |
| `ensemble-solve` | base | feature (`W`) | — | concurrency 4 | 2 | Ensemble: N agents solve the same task independently (no coordination during), then a judge picks the best solution. The aggregation-after control arm for the coordination-topology study. |
| `fleet-ekg` | base | scan-run (`EKG`) | — | inherited | 0 | Deterministic learning loop: embed recent agent sessions into behavioral vectors, detect fleet-wide distribution shifts vs the trailing baseline, attribute against the behavior-change ledger, and alarm unattributable MAJOR shifts (the Fleet EKG) on a cadence. Pure SQL, no agent. |
| `gaia-agent` | single-agent | feature (`F`) | gaia-worker | inherited | 1 | General-assistant GAIA solver: one agent researches a question with native web_search/fetch/bash/file tools and writes its FINAL ANSWER to answer.txt. The non-coding single-agent bench unit placed by the su-independent pool or the real Queen. |
| `graduation` | base | mining-run (`GRD`) | — | inherited | 0 | Deterministic learning loop: count per-class clean auto-passes over the outcome rails and file an owner ratification report for any class that crosses the graduation threshold (the graduation tracker) on a cadence. Pure SQL, no agent; files an owner report — never auto-widens autoKinds. |
| `gym` | base | gym-task (`G`) | gym-director | inherited | 6 | A meta-harness that optimizes another harness's blueprint: a gym-director drives generate-tasks → run-target-variant (sub-harness) → judge → propose → A/B-gate → accept (commit the target blueprint). The target declares its own gym rubric. |
| `hier-lead-worker` | base | feature (`W`) | — | concurrency 4 | 2 | Hierarchical elected-lead team: one lead runs a coordination pass (plan/assign/strategize) over the team backlog, then workers execute under it. The in-team-coordinator pole between flat-distributed and the Queen. |
| `implement` | single-agent | improvement (`IMP`) | worker | inherited | 1 | Auto-implement an eligible captured improvement (kind=bug): reproduce, fix with a regression test, keep it self/inline-sized; lands via the release gate. Flag-gated OFF + seeded inactive. |
| `iq-battery` | base | benchmark-run (`IQB`) | — | inherited | 0 | Monthly IQ-battery benchmark: when the code SHA changed, run one owner-budget-capped generation (solver/judge bees through the governed chokepoint) beside gen-0 in the beekeeper trend — the "is the system improving" yardstick. |
| `memory-live-recall-canary` | base | benchmark-run (`MRC`) | — | inherited | 0 | Daily memory recall canary: replay frozen known-item queries against the live memory stack (read-only), record recall@10 vs baseline, and alert on degradation — so live-store silent failures surface within a day, not whenever someone notices recall feels off. |
| `memory-precision` | base | benchmark-run (`MPB`) | — | inherited | 0 | Weekly memory-precision monitoring: replay the frozen gold set against the production hybrid backend at the push floor and record FP@5 / R@10 / precision — so the injection floor (solved) is monitored, not benchmarked-once. |
| `merge-resolution` | single-agent | merge-conflict (`MRG`) | merge-resolver | inherited | 1 | Resolve a git-sync auto-merge conflict: a merge-resolver agent redoes the merge fresh on main, resolves, commits, leaves the tree clean, and does not push. |
| `migration` | base | migration-task (`M`) | migration-director | concurrency 4 | 4 | A migration/codemod harness: a migration-director drives a discoverer (find all sites matching the pattern), a worktree-isolated transformer (transform ONE site), and a verifier (tests/build green per site + overall) — safe large mechanical change. |
| `negative-space` | base | mining-run (`NSM`) | — | inherited | 0 | Deterministic learning loop: recompute the zero-hit-search demand map and file the capped missing-knowledge candidates (the negative-space miner) on a cadence. Pure-SQL, no agent — the simplest deterministic blueprint. |
| `neologism` | base | mining-run (`NEO`) | — | inherited | 0 | Deterministic learning loop: mine coord traffic + the insights corpus for emergent recurring vocabulary with no corresponding primitive and file the capped abstraction-proposal candidates (the neologism miner) on a cadence. Pure SQL/fs, no agent. |
| `pair` | base | feature (`W`) | — | concurrency 4 | 2 | Driver/navigator pair: two agents on one task — a driver writes, a navigator continuously reviews + corrects. The tightest real-time peer-correction loop in the topology study. |
| `papercup` | single-agent | task (`SENTINEL`) | papercup | inherited | 1 | Launch one fleet WATCHER (the `papercup` role) — the read-mostly observer split out of the overloaded operator (D-004). It sweeps fleet liveness, the coord substrate, and harness health, and raises alarms via coord:escalate/send. It never acts (no spawn/cancel/mutate) — the Mug steers, the papercup watches. |
| `pot-eval` | base | hive-eval-run (`HEV`) | — | inherited | 0 | Monthly Pot-run evaluation: when the code SHA changed, run one owner-budget-capped SCORED generation of the seeded scenario corpus (whole-Pot runs graded on outcome quality / efficiency / speed by the un-gameable gate) — the acceptance yardstick for whether mug-execution / wave-dispatch / autonomy made the Pot better. |
| `prompt-ablation` | base | ablation-run (`ABL`) | — | inherited | 0 | Prompt sedimentology: shadow-ablate ONE SU-playbook governance rule and replay the llm-testing `su` suite baseline-vs-ablated, recording the behavioral-delta evidence — on a weekly cadence. Never mutates a live prompt. |
| `red-queen` | base | drill-run (`RQ`) | — | inherited | 0 | Red-queen vaccination: plant a known synthetic friction in the SANDBOX, detect + heal it with a real watchdog, and record MTTSH + the zero-leak assertion — one drill cycle per cadence tick. |
| `regret` | base | mining-run (`RGT`) | — | inherited | 0 | Regret miner: select bad historical sessions, price candidate rule changes via a governed counterfactual replay, and file scored what-would-have-helped reports. |
| `release-fix` | single-agent | release-fix (`RFX`) | release-fixer | inherited | 1 | Fix a green-checkpoint gate failure: a release-fixer agent reads the checkpoint log, reproduces the failing test to classify regression-vs-flake, then fixes the code or removes a proven flake (hermetic / tier-out / accountable quarantine), leaves the tree clean, and does not push. |
| `research` | base | task (`R`) | research-director | concurrency 1 | 4 | A minimal research harness: a research-director drives a single researcher per research task, with searcher/verifier as reactive helpers. Repo-less. |
| `review` | base | review-task (`RV`) | review-director | inherited | 4 | A review/audit harness: a review-director drives one dimension-reviewer per review dimension, an adversarial finding-verifier refutes each finding before it counts, and a findings-synthesizer dedups + ranks the survivors into one report. |
| `scan` | single-agent | scan-run (`SCAN`) | scanner | inherited | 1 | Proactive workspace scan: the scanner sweeps for latent problems + improvement opportunities no agent flagged and captures each as a tracked work-item (kind=change\|improvement) into the self-improvement triage backlog. |
| `scout` | base | ideation-cycle (`SCT`) | — | inherited | 0 | Scout autonomous-ideation cadence: idle/friction-gated, budgeted ideation cycles (ideator → critic → route to draft plans / the gym / improvements) on a frequent heartbeat. The op runs the same self-gated tick as the bespoke routine. |
| `transfer` | base | distillation-run (`TRF`) | — | inherited | 0 | Transfer harness: distill transferable lessons from the day's transcripts (admitted probationary), then student-transfer-test them via a governed replay battery to promote/demote/retire — on a nightly cadence. |
| `vote` | base | decision (`VOTE`) | — | inherited | 2 | Decide between options via a diverse-lens, confidence-weighted vote: one voter per lens + an advocate arguing against the lead; resolve decisively or escalate a curated split to the human. |

### Abstract (not directly runnable)

| Blueprint | Description |
|---|---|
| `base` | Abstract base blueprint — common knobs + defaults. Not directly runnable; extended by concrete blueprints. |
| `external-bench` | The full Papercusp arm of the impartial benchmark suite: the complete coding spine + coordination substrate run autonomously to DONE over one cloned public benchmark task, under an iso-budget cap, graded by the benchmark's OWN external harness. The spine-ON pole of the `coding-solo` causal-isolation pairing (arm 'papercusp'); we neither author nor grade. Spun by the `instantiateBenchHarness` port (./run-loop.ts). |
| `papercusp-engineer` | IDENTITY (abstract — a layer, never runnable alone): the software-engineering profession. Fills the exclusive `domain` slot with su.md's engineering discipline, extracted verbatim by P-002; P-023 makes it the coding hive's domain document. |
| `single-agent` | Abstract parent for single-role run-to-done launches — the shared single-role spine (one decider role + DONE/ESCALATE/IDLE edges + inline planner) plus the governed + durable launch contract. Not directly runnable; extended by implement / scan / merge-resolution / deploy. |
| `su-collaborator` | IDENTITY (abstract — a layer, never runnable alone): the interactive su's collaborator stance toward the owner. Fills the exclusive `collaboration-stance` slot with su.md's Who-you-are address rule, Default-posture ask gate and Delivery discipline, extracted verbatim by P-002. |
| `work` | A generic (non-coding) Hive — the Queen places research / analysis / deliberation work onto a fleet of bees that produce DELIVERABLES (reports, decisions, documents). "Done" is decided by an LLM judge against a rubric; output lands in the artifacts store; the Queen co-locates work by topic, not file. Repo-less. The non-coding counterpart of the coding `hive`. |

## Details

### `audit`

The G2 user-protection gate: a read-only adversarial auditor screens a remote-authored feature and emits an admit/reject verdict; a reject quarantines the feature behind a blocker escalation until a human resolves it.

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `audit-task` (id prefix `AUD`)
- **Spine decider:** `auditor` (maxTurns 10)
- **Planner:** inline
- **Roles (1):** `auditor`

### `base`

Abstract base blueprint — common knobs + defaults. Not directly runnable; extended by concrete blueprints.

- **Version:** 0.1.0

### `calibration`

Deterministic learning loop: mature open calibration bets against their domain probes, resolving or voiding past the grace window (the calibration-markets resolution sweep) on a cadence. Pure SQL, no agent.

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `mining-run` (id prefix `CAL`)

### `change-ledger`

Deterministic recorder: git-log the prompt-source roots over a trailing window and offer one behavior-change-ledger row per (commit, file) (the change-ledger repo-edit scan) on a cadence. Pure bookkeeping — git + SQL, no agent, no LLM.

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `mining-run` (id prefix `CLG`)

### `coding`

The Hive/Hive operator — the Queen in charge of the bee fleet. Wakes on its own self-declared schedule (or an event it subscribed to), surveys the work frontier and bee slots, places ranked tasks onto bees (free slot / graceful-evict+fresh / warm-inject), attaches situational briefs, and declares its next wake. Two roles, both carrying the full Queen role (two-plane coordination, steer-don't-dispatch): the `operator` (the canonical full-role judgment layer, the default decider) and the `queen` (the same role with the dial turned toward placement automation).

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `hive-wake` (id prefix `POT`)
- **Spine decider:** `mug` (maxTurns 50)
- **Planner:** inline
- **Roles (2):** `operator`, `mug`

### `coding-factory`

RETIRED — NOT ACTIVE (2026-06-24, by owner decision). Preserved-but-dormant: its `director` autoloop last fired 2026-05-01 and nothing currently instantiates it. Do NOT treat this as "the active/default coding harness" and do NOT wire new work to it. (It is the per-feature coding spine: director → scoper → architect → worker → validator → reviewer → documenter → curator, opt-in gates tester / security / crosscheck / ui-qa.) Kept intact for future revival — to revive, re-enable instantiation (generate-from-repo `extends`) and restore the director dispatch.

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `feature` (id prefix `F`)
- **Spine decider:** `director` (maxTurns 200)
- **Planner:** features-import
- **Dispatch:** concurrency 4, plan-order
- **Finalize gates:** done: curator → postCuratorOutputs → documenter → archive; escalate: curator
- **Roles (11):** `director`, `scoper`, `architect`, `worker`, `validator`, `debugger` (reactive), `documenter`, `curator`, `security-reviewer` (reactive), `crosscheck` (reactive), `ui-qa` (reactive)

### `coding-solo`

Baseline A internal ablation: the coding harness with the multi-agent spine collapsed to a single end-to-end worker — identical model / base tools / infra / budget to the full coding spine, only orchestration OFF. The single-agent generation unit for the impartial benchmark suite (also the per-sample unit Baseline C best-of-N samples).

- **Extends:** `single-agent`
- **Version:** 0.1.0
- **Work item:** `feature` (id prefix `F`)
- **Spine decider:** `worker` (maxTurns 200)
- **Roles (1):** `worker`

### `content-fix`

Fix a git-sync content-guard quarantine: a content-fixer agent fixes ONLY the syntax of the named files so they pass their content detector (an .mdx that won't compile, a curly quote used as code), changes nothing else, leaves the tree clean, and does not push.

- **Extends:** `single-agent`
- **Version:** 0.1.0
- **Work item:** `content-fix` (id prefix `CFX`)
- **Spine decider:** `content-fixer` (maxTurns 15)
- **Roles (1):** `content-fixer`

### `cup`

Launch one generic Pot worker (the `cup` role) — a plain implementation agent the Mug places ranked work + a brief onto. Decoupled from the pipeline guards (no chunk, no spine); the brief rides `extras`, the persona is prompts/cup.md. A cup is kind:'harness' (NOT a pot).

- **Extends:** `single-agent`
- **Version:** 0.1.0
- **Work item:** `task` (id prefix `BEE`)
- **Spine decider:** `cup` (maxTurns 80)
- **Roles (1):** `cup`

### `deferral-interest`

Deterministic learning loop: backfill realized deferral costs from history and re-fit the learned deferral-pricing model the queue ranker reads (the deferral-interest refit) on a cadence. Pure SQL + math, no agent.

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `mining-run` (id prefix `DIR`)

### `deliberate`

Resolve a decision via the uncertainty ladder: ask the owner, then a diverse vote if unanswered, then a curated escalation if the vote is split.

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `decision` (id prefix `DLIB`)

### `deploy`

The release-gate deploy launch: the release-manager agent reviews the gathered deploy plan + staged migrations, makes the go/no-go call, runs the deploy, reads health, and decides rollback. Opus-4.8 @ xhigh — the blast radius is the fleet.

- **Extends:** `single-agent`
- **Version:** 0.1.0
- **Work item:** `deploy-run` (id prefix `DEP`)
- **Spine decider:** `release-manager` (maxTurns 20)
- **Roles (1):** `release-manager`

### `dist-blackboard`

Stigmergic distributed coordination: N peer workers self-claim from a shared queue (no Queen) and coordinate ONLY via a shared blackboard (work-item/scratchpad state) — no direct messaging.

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `feature` (id prefix `W`)
- **Dispatch:** concurrency 4
- **Roles (1):** `worker`

### `dist-broadcast`

Flat-distributed coordination: N peer workers self-claim from a shared queue (no Queen) and broadcast findings to peers. The fully-distributed pole of the central-vs-distributed study.

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `feature` (id prefix `W`)
- **Dispatch:** concurrency 4
- **Roles (1):** `worker`

### `dist-peer-review`

Flat-distributed coordination with a peer-review gate: N peer workers self-claim from a shared queue (no Queen); each result is reviewed by a nominated peer before submit.

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `feature` (id prefix `W`)
- **Dispatch:** concurrency 4
- **Roles (2):** `worker`, `reviewer`

### `dist-repo-huddle`

Distributed per-repo huddle: N peer workers self-claim (no Queen); same-repo agents form a group that shares repo-understanding + peer-reviews within the repo — coordination scoped to overlap.

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `feature` (id prefix `W`)
- **Dispatch:** concurrency 4
- **Roles (1):** `worker`

### `doc-steward`

Bring drifted docs back in sync with the code: a doc-steward re-verifies/regenerates each stale doc the freshness sweep flagged (code is truth; preserve historical runbook knowledge), harness_docs:verify to clear the flag, leave the tree clean, and does NOT push.

- **Extends:** `single-agent`
- **Version:** 0.1.0
- **Work item:** `doc-drift` (id prefix `DOC`)
- **Spine decider:** `doc-steward` (maxTurns 40)
- **Roles (1):** `doc-steward`

### `ensemble-solve`

Ensemble: N agents solve the same task independently (no coordination during), then a judge picks the best solution. The aggregation-after control arm for the coordination-topology study.

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `feature` (id prefix `W`)
- **Dispatch:** concurrency 4
- **Roles (2):** `solver`, `judge`

### `external-bench`

The full Papercusp arm of the impartial benchmark suite: the complete coding spine + coordination substrate run autonomously to DONE over one cloned public benchmark task, under an iso-budget cap, graded by the benchmark's OWN external harness. The spine-ON pole of the `coding-solo` causal-isolation pairing (arm 'papercusp'); we neither author nor grade. Spun by the `instantiateBenchHarness` port (./run-loop.ts).

- **Extends:** `coding-factory`
- **Version:** 0.1.0

### `fleet-ekg`

Deterministic learning loop: embed recent agent sessions into behavioral vectors, detect fleet-wide distribution shifts vs the trailing baseline, attribute against the behavior-change ledger, and alarm unattributable MAJOR shifts (the Fleet EKG) on a cadence. Pure SQL, no agent.

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `scan-run` (id prefix `EKG`)

### `gaia-agent`

General-assistant GAIA solver: one agent researches a question with native web_search/fetch/bash/file tools and writes its FINAL ANSWER to answer.txt. The non-coding single-agent bench unit placed by the su-independent pool or the real Queen.

- **Extends:** `single-agent`
- **Version:** 0.1.0
- **Work item:** `feature` (id prefix `F`)
- **Spine decider:** `gaia-worker` (maxTurns 60)
- **Roles (1):** `gaia-worker`

### `graduation`

Deterministic learning loop: count per-class clean auto-passes over the outcome rails and file an owner ratification report for any class that crosses the graduation threshold (the graduation tracker) on a cadence. Pure SQL, no agent; files an owner report — never auto-widens autoKinds.

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `mining-run` (id prefix `GRD`)

### `gym`

A meta-harness that optimizes another harness's blueprint: a gym-director drives generate-tasks → run-target-variant (sub-harness) → judge → propose → A/B-gate → accept (commit the target blueprint). The target declares its own gym rubric.

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `gym-task` (id prefix `G`)
- **Spine decider:** `gym-director` (maxTurns 100)
- **Planner:** inline
- **Finalize gates:** done: committer
- **Roles (6):** `gym-director`, `task-generator`, `variant-runner`, `judge`, `proposer`, `committer`

### `hier-lead-worker`

Hierarchical elected-lead team: one lead runs a coordination pass (plan/assign/strategize) over the team backlog, then workers execute under it. The in-team-coordinator pole between flat-distributed and the Queen.

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `feature` (id prefix `W`)
- **Dispatch:** concurrency 4
- **Roles (2):** `lead`, `worker`

### `implement`

Auto-implement an eligible captured improvement (kind=bug): reproduce, fix with a regression test, keep it self/inline-sized; lands via the release gate. Flag-gated OFF + seeded inactive.

- **Extends:** `single-agent`
- **Version:** 0.1.0
- **Work item:** `improvement` (id prefix `IMP`)
- **Spine decider:** `worker` (maxTurns 80)
- **Roles (1):** `worker`

### `iq-battery`

Monthly IQ-battery benchmark: when the code SHA changed, run one owner-budget-capped generation (solver/judge bees through the governed chokepoint) beside gen-0 in the beekeeper trend — the "is the system improving" yardstick.

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `benchmark-run` (id prefix `IQB`)

### `memory-live-recall-canary`

Daily memory recall canary: replay frozen known-item queries against the live memory stack (read-only), record recall@10 vs baseline, and alert on degradation — so live-store silent failures surface within a day, not whenever someone notices recall feels off.

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `benchmark-run` (id prefix `MRC`)

### `memory-precision`

Weekly memory-precision monitoring: replay the frozen gold set against the production hybrid backend at the push floor and record FP@5 / R@10 / precision — so the injection floor (solved) is monitored, not benchmarked-once.

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `benchmark-run` (id prefix `MPB`)

### `merge-resolution`

Resolve a git-sync auto-merge conflict: a merge-resolver agent redoes the merge fresh on main, resolves, commits, leaves the tree clean, and does not push.

- **Extends:** `single-agent`
- **Version:** 0.1.0
- **Work item:** `merge-conflict` (id prefix `MRG`)
- **Spine decider:** `merge-resolver` (maxTurns 40)
- **Roles (1):** `merge-resolver`

### `migration`

A migration/codemod harness: a migration-director drives a discoverer (find all sites matching the pattern), a worktree-isolated transformer (transform ONE site), and a verifier (tests/build green per site + overall) — safe large mechanical change.

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `migration-task` (id prefix `M`)
- **Spine decider:** `migration-director` (maxTurns 200)
- **Planner:** inline
- **Dispatch:** concurrency 4
- **Roles (4):** `migration-director`, `discoverer`, `transformer`, `migration-verifier`

### `negative-space`

Deterministic learning loop: recompute the zero-hit-search demand map and file the capped missing-knowledge candidates (the negative-space miner) on a cadence. Pure-SQL, no agent — the simplest deterministic blueprint.

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `mining-run` (id prefix `NSM`)

### `neologism`

Deterministic learning loop: mine coord traffic + the insights corpus for emergent recurring vocabulary with no corresponding primitive and file the capped abstraction-proposal candidates (the neologism miner) on a cadence. Pure SQL/fs, no agent.

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `mining-run` (id prefix `NEO`)

### `pair`

Driver/navigator pair: two agents on one task — a driver writes, a navigator continuously reviews + corrects. The tightest real-time peer-correction loop in the topology study.

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `feature` (id prefix `W`)
- **Dispatch:** concurrency 4
- **Roles (2):** `driver`, `navigator`

### `papercup`

Launch one fleet WATCHER (the `papercup` role) — the read-mostly observer split out of the overloaded operator (D-004). It sweeps fleet liveness, the coord substrate, and harness health, and raises alarms via coord:escalate/send. It never acts (no spawn/cancel/mutate) — the Mug steers, the papercup watches.

- **Extends:** `single-agent`
- **Version:** 0.1.0
- **Work item:** `task` (id prefix `SENTINEL`)
- **Spine decider:** `papercup` (maxTurns 40)
- **Roles (1):** `papercup`

### `papercusp-engineer`

IDENTITY (abstract — a layer, never runnable alone): the software-engineering profession. Fills the exclusive `domain` slot with su.md's engineering discipline, extracted verbatim by P-002; P-023 makes it the coding hive's domain document.

- **Extends:** `base`
- **Version:** 0.1.0

### `pot-eval`

Monthly Pot-run evaluation: when the code SHA changed, run one owner-budget-capped SCORED generation of the seeded scenario corpus (whole-Pot runs graded on outcome quality / efficiency / speed by the un-gameable gate) — the acceptance yardstick for whether mug-execution / wave-dispatch / autonomy made the Pot better.

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `hive-eval-run` (id prefix `HEV`)

### `prompt-ablation`

Prompt sedimentology: shadow-ablate ONE SU-playbook governance rule and replay the llm-testing `su` suite baseline-vs-ablated, recording the behavioral-delta evidence — on a weekly cadence. Never mutates a live prompt.

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `ablation-run` (id prefix `ABL`)

### `red-queen`

Red-queen vaccination: plant a known synthetic friction in the SANDBOX, detect + heal it with a real watchdog, and record MTTSH + the zero-leak assertion — one drill cycle per cadence tick.

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `drill-run` (id prefix `RQ`)

### `regret`

Regret miner: select bad historical sessions, price candidate rule changes via a governed counterfactual replay, and file scored what-would-have-helped reports.

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `mining-run` (id prefix `RGT`)

### `release-fix`

Fix a green-checkpoint gate failure: a release-fixer agent reads the checkpoint log, reproduces the failing test to classify regression-vs-flake, then fixes the code or removes a proven flake (hermetic / tier-out / accountable quarantine), leaves the tree clean, and does not push.

- **Extends:** `single-agent`
- **Version:** 0.1.0
- **Work item:** `release-fix` (id prefix `RFX`)
- **Spine decider:** `release-fixer` (maxTurns 30)
- **Roles (1):** `release-fixer`

### `research`

A minimal research harness: a research-director drives a single researcher per research task, with searcher/verifier as reactive helpers. Repo-less.

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `task` (id prefix `R`)
- **Spine decider:** `research-director` (maxTurns 30)
- **Planner:** inline
- **Dispatch:** concurrency 1
- **Roles (4):** `research-director`, `researcher`, `searcher` (reactive), `verifier` (reactive)

### `review`

A review/audit harness: a review-director drives one dimension-reviewer per review dimension, an adversarial finding-verifier refutes each finding before it counts, and a findings-synthesizer dedups + ranks the survivors into one report.

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `review-task` (id prefix `RV`)
- **Spine decider:** `review-director` (maxTurns 40)
- **Planner:** inline
- **Roles (4):** `review-director`, `dimension-reviewer`, `finding-verifier` (reactive), `findings-synthesizer`

### `scan`

Proactive workspace scan: the scanner sweeps for latent problems + improvement opportunities no agent flagged and captures each as a tracked work-item (kind=change\|improvement) into the self-improvement triage backlog.

- **Extends:** `single-agent`
- **Version:** 0.1.0
- **Work item:** `scan-run` (id prefix `SCAN`)
- **Spine decider:** `scanner` (maxTurns 30)
- **Roles (1):** `scanner`

### `scout`

Scout autonomous-ideation cadence: idle/friction-gated, budgeted ideation cycles (ideator → critic → route to draft plans / the gym / improvements) on a frequent heartbeat. The op runs the same self-gated tick as the bespoke routine.

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `ideation-cycle` (id prefix `SCT`)

### `single-agent`

Abstract parent for single-role run-to-done launches — the shared single-role spine (one decider role + DONE/ESCALATE/IDLE edges + inline planner) plus the governed + durable launch contract. Not directly runnable; extended by implement / scan / merge-resolution / deploy.

- **Extends:** `base`
- **Version:** 0.1.0
- **Planner:** inline

### `su-collaborator`

IDENTITY (abstract — a layer, never runnable alone): the interactive su's collaborator stance toward the owner. Fills the exclusive `collaboration-stance` slot with su.md's Who-you-are address rule, Default-posture ask gate and Delivery discipline, extracted verbatim by P-002.

- **Extends:** `base`
- **Version:** 0.1.0

### `transfer`

Transfer harness: distill transferable lessons from the day's transcripts (admitted probationary), then student-transfer-test them via a governed replay battery to promote/demote/retire — on a nightly cadence.

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `distillation-run` (id prefix `TRF`)

### `vote`

Decide between options via a diverse-lens, confidence-weighted vote: one voter per lens + an advocate arguing against the lead; resolve decisively or escalate a curated split to the human.

- **Extends:** `base`
- **Version:** 0.1.0
- **Work item:** `decision` (id prefix `VOTE`)
- **Roles (2):** `voter`, `advocate`

### `work`

A generic (non-coding) Hive — the Queen places research / analysis / deliberation work onto a fleet of bees that produce DELIVERABLES (reports, decisions, documents). "Done" is decided by an LLM judge against a rubric; output lands in the artifacts store; the Queen co-locates work by topic, not file. Repo-less. The non-coding counterpart of the coding `hive`.

- **Extends:** `coding`
- **Version:** 0.1.0
