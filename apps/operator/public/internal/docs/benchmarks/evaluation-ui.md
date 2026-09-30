# Evaluation UI — run, monitor, grade, compare & export
URL: /internal/docs/benchmarks/evaluation-ui

The operator's Evaluation dock tab — launch a real SWE-bench Pro run, monitor it live, grade it with the official grader, compare arms with the validity gate + honest caveats, and export a 3rd-party-reproducible bundle.

import { Aside } from '@astrojs/starlight/components';

The **Evaluation** dock tab (`?tab=evals`) is the full UI for the impartial
benchmark: launch a real run, watch it live, grade it with the official grader,
compare arms, and export a reproducible bundle. Built on
`benchmark-evaluation-ui-2026-06-16`.

The tab id `'evals'` and its sidebar metadata (label **Evaluation**, Trophy
icon) are **declared** in `apps/operator-vite/src/components/adv/AdvShell.tsx`;
the `AdvEvalsTab` component is **routed** in
`apps/operator-vite/src/routes/adv/index.tsx` (the `renderAdvTab` switch — `case
'evals': return <AdvEvalsTab />`). The component itself lives at
`apps/operator-vite/src/components/adv/AdvEvalsTab.tsx`; the shared viz helpers +
the validity module are under `apps/operator/app/eval-viz/` (imported via the
`@/app` alias).

The Evaluation UI is part of the desktop app. Drive it through the running Tauri
shell (`cd papercusp-desktop && npm run dev` → the Evaluation tab), per
[testing](/internal/docs/testing) — not a browser against `:3055`/`:3070`.

## The two stores (why there are two)

* **Operational run store** — `bench_runs` / `bench_run_tasks` / `bench_run_events`
  (migration 296). MUTABLE, lifecycle-driven (`pending → running → grading → done | error | cancelled`), lenient while in-flight. This is the live source the UI
  reads via `@papercusp/sync` (`evals.benchRuns`, `evals.benchRun`,
  `evals.benchRunLive`). Preserved file-dir runs are imported one-way (dir → store).
* **Reproducibility cards** — `benchmark_rollout` / `benchmark_run_result` /
  `benchmark_fleet_run` (migrations 291–293). IMMUTABLE, firewall-gated
  (`prereg_hash`), for PUBLISHED graded results. Distinct concern — a live run
  exists long before any reproducibility card.

## Subtabs

| Subtab             | What it does                                                                                                                                                                                                                                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Launch**         | Pick arm / task set / cap / `$`-budget, see a cost+time estimate, owner-confirm when the estimate is `>= $20` of opus (`OWNER_CONFIRM_USD`), launch. opus is pinned (fail-closed). Arms: `hive-realqueen` (treatment), `fifo-noqueen` (no-Mug control), `mini-swe-agent` (reference harness); task sets: 11-task pilot, full \~731, custom ids. |
| **Preserved runs** | Browse runs (imports + live) — id · arm · resolved% · status. Per-run: Grade, Export, Re-run, Delete. Validity badges, live fleet panel, coordination timeline.                                                                                                                                                                                 |
| **Compare**        | Arm-vs-arm over the same task set: resolved% delta + Frontier + per-task table + the honest-caveats panel.                                                                                                                                                                                                                                      |

## Launch a run (P-004 / P-005)

The launch form posts to `POST /api/external-bench/runs/launch`. The run goes
through the **real bench engine** (not a `/tmp` launcher) as a detached managed
job: it persists `status=running`, returns a `run_id` immediately, and streams
live. Only **one run at a time** (spend-safety). The launch form offers three
arms — `hive-realqueen` (treatment), `fifo-noqueen` (no-Mug control),
`mini-swe-agent` (the reference harness) — over three task sets (11-task pilot /
full \~731 / custom ids), and requires an explicit **owner-confirm when the
estimate is `>= $20`** of opus (`OWNER_CONFIRM_USD`). Launches are gated on the
`papercusp-external-bench` flag (default OFF — the owner's spend gate; enable at
`/admin/features`).

Every launched run dissolves its pot on completion/cancel — stopping the Mug
wake, cancelling cups, and DELETING the gym/scout learning-loop rows
(`teardownHiveLearningLoop`) so no orphan re-spins opus. A run left in flight by
a CRASHED host is reaped on the next operator boot (heartbeat-gated, so a run
legitimately running in another live host is untouched). A UI run can never
orphan-respin opus on a `:3170` restart.

## Monitor live (P-007 / P-008 / P-009)

While a run is active the detail view polls `evals.benchRunLive` (the manual PG
checks made visual, from `spawned_agents` / `agent_usage_samples` scoped to the
run's pot):

* **Mug survival** — alive / age / reclaims.
* **Cup status** — placed / working / done / evicted / failed.
* **Per-task progress**, cumulative spend, wall-clock.
* **Coordination timeline** — placements, evictions, recoveries, wakes, event by event.

### Validity badges — the integrity guarantee (D-003)

Every run shows red/green validity badges (`computeValiditySignals` returns
**seven**, in order): `OPUS-ONLY`, `MUG-SURVIVAL`, `EMPTY-DIFF`,
`GENERATION-ATTRIBUTED`, `FLEET-CAP`, `SUBSET-SIZE`, `SINGLE-SEED`. A **fail** (a
non-opus leak, a mug reclaim, a 0-work arm, a phantom win) means the run is NOT
a clean result — and the Compare view will refuse to render it as a valid delta.
Warn/unknown are honest caveats, not invalidating. The same function renders the
badges in both the live monitor and the Preserved-runs view.

* **`GENERATION-ATTRIBUTED`** (D-027) guards against **phantom wins**: a
  non-empty, grade-passing diff with `turns=0` AND `cost=0` AND 0 tokens — a
  recovered / re-placed win that would inflate `resolved%` with work the run
  never measured. It **fails** when any resolved task has zero recorded
  generation (`resolvedZeroGen > 0`), so like the other six it gates validity.
  This was the gap that hid two of the m3 wins until the credibility roadmap
  added it.

## Grade (P-010)

**Grade** runs the OFFICIAL `swe_bench_pro_eval` (`--use_local_docker`, jefzda
images) over the run's collected diffs — the proven `_xbench_grade.py` path. It
persists the per-instance resolved map + `resolvedCount`/`resolvedPct`, and is
re-gradeable (`status: grading → done`). Requires the run's on-disk snapshot
(written on launch completion; preserved/imported runs already have it).

Grading is **dispatched by suite** (`runGradeBySuite`): `swe-bench-pro` (the
default) uses the proven `_xbench_grade.py` / `swe_bench_pro_eval` path;
`swe-bench-verified` is a **separate harness that is not installed here** — rather
than mis-grade Verified instances with the Pro images, the grader throws an
actionable `verified_harness_not_installed` error (with the exact install steps).

## Compare arms (P-011 / P-012)

Pick run **A** (baseline) and **B** (treatment). The headline comparison is
**hive-realqueen vs mini-swe-agent** (the SWE-bench Pro reference harness), same
model + same tasks (D-005). The view shows the resolved% delta, the cost/accuracy
Frontier, and the per-task table.

* **The validity gate (D-003):** if EITHER arm fails a validity check, the view
  renders **“No valid delta”** + the failing badges — never a fabricated number.
* **Honest caveats (P-012):** auto-surfaced per-arm (opus-leak, empty-diff,
  subset, seed, cap) + cross-arm (task-set mismatch, task-count mismatch,
  cap-asymmetry, spawn-path parity). A delta is never presented cleaner than its
  caveats.

## Export for 3rd-party reproduction (P-013)

**Export** downloads `predictions.json` (`[{instance_id, patch, prefix}]`) + a
`README.md` with the EXACT public re-grade command. A third party reproduces the
resolved verdicts with the public `swe_bench_pro_eval` + public images, with zero
access to our harness — also the shape for a SWE-bench Pro / SEAL leaderboard
submission.

## Verifying changes

* Unit/integration: `run-store`, `run-launcher` (incl. the kill-mid-run hard
  gate), `grade-runner`, `live-state`, `validity`, `export-bundle`, `AdvEvalsTab`.
* Where the code lives: the UI is `apps/operator-vite/src/components/adv/AdvEvalsTab.tsx`
  (routed in `src/routes/adv/index.tsx`, declared in `src/components/adv/AdvShell.tsx`);
  the shared viz + `validity.ts` are under `apps/operator/app/eval-viz/`.
* A full **live** walkthrough (launch → monitor → grade → compare → export with a
  real opus run) is **owner-gated** — it spends real budget and needs the
  `papercusp-external-bench` flag on. Drive it through the Tauri shell.
