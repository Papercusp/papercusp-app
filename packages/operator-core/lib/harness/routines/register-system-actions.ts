/**
 * Side-effect imports that populate the system-action registry
 * (`system-actions.ts`). The routines engine imports this module once, so every
 * `system:<action>` handler is registered before the first tick dispatches.
 *
 * Add a new system action in TWO steps — the import alone is not enough:
 *   1. Import its module here (the module body calls `registerSystemAction(...)`).
 *   2. Classify its spend in `TARGET_ROLE_SPEND`
 *      (`lib/automation/routine-classification.ts`) as `{ spend: 'llm' | 'none', why }`.
 *      `llm` means a fire can DIRECTLY bill model turns — it spawns an agent, or
 *      launches/wakes a session, or dispatches queued work to the pipeline.
 *
 * Step 2 is NOT optional and NOT deferrable: `routine-classification.registry.test.ts`
 * cross-checks this registry against `TARGET_ROLE_SPEND` and fails on any unclassified
 * action, so skipping it reds the green-checkpoint for the whole fleet hours later,
 * far from the change that caused it. That has now happened four separate times
 * (`system:scout-cycle`, `system:task-reconcile`, `system:gitnexus-reindex`,
 * `system:pot-git-gc`) — every one an author who did step 1 and stopped, because
 * this comment used to describe only step 1. Classify it in the same edit as the import.
 *
 * ⚠ A RENAME IS BOTH STEPS, TWICE — and this comment used to say only "add a NEW
 * action", which is why the 4th instance happened to a rename (P-051,
 * `hive-git-gc` → `pot-git-gc`). Renaming an action ADDS one key and REMOVES
 * another, so `TARGET_ROLE_SPEND` needs BOTH edits or the cross-check fails from
 * either side: the new name unclassified, or the old name classified-but-no-longer-
 * registered. Renaming also desyncs every OTHER registry keyed by the action NAME as
 * a STRING — `scripts/ungated-mug-kettle-baseline.json` is one, where a stale key
 * additionally reports the surface as having SHRUNK. Before renaming an action,
 * grep the whole tree for its name as a literal, not just for its constants.
 *
 * Registered handlers:
 *   - `system:git-sync` — git-sync-auto-commit P-005/P-009/P-010/P-012.
 *   - `system:blueprint-run` — harness-blueprint-orchestration P-021 / D-018.
 *
 * NOTE (deterministic-blueprints-migration P-144 / D-026): the 13 migrated learning loops
 * below (negative-space, neologism, fleet-ekg, calibration, deferral-interest, graduation,
 * red-queen, regret, transfer, prompt-ablation, change-ledger, scout, iq-battery) NO LONGER
 * fire a bespoke `system:<loop>` action and are NO LONGER seeded by a `seed-*-routine.ts`
 * script (all retired). Each now fires `system:blueprint-run` from a single workspace-singleton
 * routine `@singleton/bp-singleton-<id>-0` (the blueprint declares `singleton: true`; the
 * always-on ones — change-ledger/scout/iq-battery — declare `singletonActive: true`).
 * Materialize/seed them via `blueprint/seed-learning-singletons.ts`; arm a dark one by setting
 * its `@singleton` row `active=true`. The per-loop "(seed-*-routine.ts)" mentions below are
 * historical.
 *   - `system:green-checkpoint` + `system:release-trigger` —
 *     release-gate-ready-branch-2026-06-04 (Phase 1 + D-010). Seeded INACTIVE.
 *   - `system:improvement-watchdog` + `system:improvement-implement` —
 *     papercusp-self-improvement-loop-2026-06-04 (the HARD feed-in + Phase 3).
 *     Seeded INACTIVE; implement is additionally flag-gated
 *     (papercusp-improvement-auto-implement, OFF). (The `system:improvement-digest`
 *     routine was removed — operator-learning-tab-2026-06-09 D-001 — the backlog is
 *     now PULLED in the Learning tab, not pushed to the human inbox.)
 *   - `system:p2p-perf-tier1` (nightly) + `system:p2p-perf-tier2` (weekly) —
 *     p2p-performance-suite-2026-06-07 P-014. Advisory bench runs; findings
 *     auto-file to the improvements backlog. Tier 3 stays on-demand (D-004).
 *   - `system:scout-cycle` — hive-creative-ideation-2026-06-08 P-008 (the Scout
 *     autonomous-ideation cadence; D-010). Self-gates on idle/friction + budget;
 *     provisioned INACTIVE per-pot at pot:create
 *     (lib/pot/provision-learning-loop.ts), bring-up human-gated. Registered by
 *     `register-scout-action.ts` (EI-18741240128927188 — was exported but never
 *     called, so arming the per-pot row silently no-op'd).
 *   - `system:session-dir-gc` — the per-session isolation-dir janitor (the EI-155
 *     follow-on). Sweeps `session-claude/`, `session-mcp/`, codex homes of
 *     not-live, not-resumable sessions past a retention window. Seeded INACTIVE
 *     (seed-session-dir-gc-routine.ts).
 *   - `system:claim-discipline-watch` — claim-discipline-enforcement-2026-06-10.
 *     Nudges (inject, never wake) alive agents declared on a plan with no claim
 *     backing it; teaches claim-on-wip / declare-intent items. Outbox-throttled
 *     1/hr per agent. Seeded ACTIVE (seed-claim-discipline-routine.ts) — a nudge
 *     is non-destructive.
 *   - `system:wake-brain` — the autonomous-Queen cadence (hive-agent-tabs-psu-tui
 *     P-005 / D-006). Wakes the EXISTING pinned brain session on cadence so it
 *     takes autonomous turns. Flag-gated by POT_AGENT_TABS (OFF → no-op); the
 *     cadence routine seed + live verify are the remaining P-005 wip.
 *   - `system:gym-cycle` — learning-system-audit-improvements-2026-06-09
 *     P-031/P-032. The gym's pulse: per tick, run ONE bounded human-gated gym
 *     cycle for the least-recently-run enabled+idle+budgeted autoloop, with
 *     triage-routed gym ideas fed to the proposer. The per-hive autoloop ROWS it
 *     sweeps are provisioned inline at pot:create (provision-learning-loop.ts,
 *     dark) — the standalone per-hive `seed-gym-routine.ts` env-slug seed was
 *     RETIRED (per-hive-learning-loops-2026-06-14 P-022).
 *   - `system:interactive-usage-ingest` + `system:token-weekly-report` —
 *     token-usage-reduction-audit-2026-06-09 P-001/P-003. Tail local Claude Code
 *     transcripts into `agent_usage_samples` (source='interactive'); broadcast a
 *     week-over-week token/spend report. Both SQL/FS-only (no LLM calls); seeded
 *     INACTIVE (seed-token-telemetry-routines.ts).
 *   - `system:hive-canary` — hive-loop-e2e-testing-2026-06-10 P-009. The daily
 *     live canary: queue one trivial feature into the dedicated canary harness;
 *     a canary still un-terminal past its deadline files a forensics-laden
 *     improvement. Self-gates on the canary harness being registered.
 *     ⚠ RETIRED + DISARMED (retire-mug-kettle-su-only-2026-08-09 P-051 / D-045):
 *     it (and `system:hive-canary-sla`) measure whether the AUTONOMOUS CUP LOOP
 *     carries queued work end-to-end — the only valid pass is a cup session — and
 *     no cup can spawn at all, so every tick could only file a false alarm. Both
 *     rows are `active=false` AND both actions gate on `mugKettleSystemEnabled()`,
 *     which P-068 made unconditionally false when it DELETED the
 *     `papercusp-mug-kettle-system` flag. There is no flag to flip and no toggle
 *     in /admin/features: the retirement is PERMANENT, so these canaries are not
 *     restorable — reviving them means measuring a different subject.
 *   - `system:coord-probe-canary` + `system:coord-invariant-monitor` —
 *     coord-system-e2e-testing-2026-06-10 P-012/P-013 (Layer D). The live
 *     probe-pair verb-cycle canary (15 min, SLO'd, self-sweeping) and the
 *     hourly substrate invariant checks (stuck handoffs, unacked escalations,
 *     expired-unswept locks, presence ghosts, wake-queue growth); violations
 *     file deduped improvements. The ONE home for substrate monitors — the
 *     shared-hive-loop P-012/P-013 checks plug in here. Seeded ACTIVE
 *     (seed-coord-invariant-routines.ts).
 *   - `system:cross-hive-outbox-drain` — hive-network-surface-2026-06-11 P-001
 *     (B-01). Per tick: reconcile the boot-wired cross-Hive boundaries against
 *     the directory-publish state (publish/visibility changes converge without
 *     a restart), then run one backoff-aware drain pass over every wired
 *     Hive's durable outbox. Self-gates on zero published Hives; seeded ACTIVE
 *     (seed-cross-hive-drain-routine.ts).
 *   - `system:iq-battery-gen` — self-improvement-consume-edges-2026-06-12
 *     P-033 (B-12). Monthly benchmark cadence: one budget-capped gen-N
 *     IQ-battery run per new code generation (skip at an already-measured
 *     SHA). REFUSES without an owner-set payload budget (gym precedent).
 *     Seeded INACTIVE (lib/iq-battery/seed-benchmark-routine.ts).
 *   - `system:improvement-human-digest` — self-improvement-consume-edges
 *     P-022 (B-08). Weekly owner digest: the top-5 human-lane items ranked by
 *     blocking impact (blocks edges, references, re-captures, watchdog
 *     persistence) via the inbox + attention rails. Read-only; seeded ACTIVE
 *     (seed-human-digest-routine.ts).
 *   - `system:change-ledger-scan` — self-learning-frontier-2026-06-12 P-004
 *     (FB-02). The repo-edit leg of the behavior-change ledger: git-log the
 *     prompt-source roots, one ledger row per (commit, file), idempotent via
 *     the dedupe index. No LLM; flag-gated by CHANGE_LEDGER (ON); seeded
 *     ACTIVE (seed-change-ledger-scan-routine.ts) — pure bookkeeping.
 *   - `system:negative-space-mine` — self-learning-frontier-2026-06-12 P-010
 *     (FB-04). Every-6h demand-map recompute over zero-hit docs/plans/memory
 *     searches (tool_invocations) + capped kind=change candidate filing via
 *     the capture core. SQL-only; flag-gated OFF
 *     (papercusp-negative-space-miner — the frontier D-001 arming gate) AND
 *     seeded INACTIVE (lib/negative-space/seed-negative-space-routine.ts).
 *   - `system:neologism-mine` — self-learning-frontier-2026-06-12 P-011
 *     (FB-05). Every-6h mine of coord traffic + insights for emergent
 *     recurring vocabulary with no corresponding primitive; capped
 *     abstraction-proposal candidates route into Scout's improvement rail
 *     via the capture core. SQL/fs-only; flag-gated OFF
 *     (papercusp-neologism-miner — the frontier D-001 arming gate), governor-
 *     preflighted (loop `neologism-miner`), AND seeded INACTIVE
 *     (lib/neologism/seed-neologism-routine.ts).
 *   - `system:regret-mine` — self-learning-frontier-2026-06-12 P-021
 *     (FB-07). Every-6h bad-session selection (burn percentile, bounces,
 *     rescue markers) + divergence-turn detection over persisted transcripts
 *     (regret_findings, mig 248); the counterfactual replay + report-filing
 *     legs activate when FB-06's lib/replay runner is wired. Flag-gated OFF
 *     (papercusp-regret-mining — the frontier D-001 arming gate), governor-
 *     preflighted (loop `regret-mining`, per-cycle replay budget), AND
 *     seeded INACTIVE (lib/replay/regret/seed-regret-routine.ts).
 *   - `system:transfer-distill` — self-learning-frontier-2026-06-12 P-022
 *     (FB-08, D-006). Nightly lesson distillation from the day's transcripts
 *     (admitted FREE at memory tier 'probationary') + student-transfer tests
 *     (with-lesson vs baseline on the source historical task via lib/replay)
 *     that promote/demote/retire via the pure gate; knowledge-pack candidate
 *     adoption inherits the bar. LLM spend; flag-gated OFF
 *     (papercusp-transfer-harness — the frontier D-001 arming gate),
 *     governor-preflighted (loop `frontier:transfer-harness`, lifetime
 *     budget), AND seeded INACTIVE (lib/transfer/seed-transfer-routine.ts).
 *     The testing leg self-skips until frontier:replay-landed is wired.
 *   - `system:fleet-ekg-scan` — self-learning-frontier-2026-06-12 P-030
 *     (FB-10). Every-6h behavioral-embedding pass over agent sessions
 *     (agent_activity → fleet_ekg_sessions) + distribution-shift detection
 *     vs the trailing baseline, attributed against the behavior-change
 *     ledger (D-003); unattributable MAJOR shifts alarm the attention rail.
 *     SQL-only; flag-gated OFF (papercusp-fleet-ekg — the frontier D-001
 *     arming gate), governor-preflighted (loop `fleet-ekg`), AND seeded
 *     INACTIVE (lib/fleet-ekg/seed-fleet-ekg-routine.ts).
 *   - `system:prompt-ablation` — self-learning-frontier-2026-06-12 P-023
 *     (FB-09). Weekly prompt sedimentology: SHADOW-ablate ONE SU-playbook
 *     governance rule and replay the llm-testing `su` suite baseline-vs-
 *     ablated (lib/ablation); dead-weight evidence rows land in
 *     harness_shared.prompt_ablation_runs for owner review. NEVER mutates a
 *     live prompt. Real LLM spend — flag-gated OFF (papercusp-prompt-ablation
 *     — the frontier D-001 arming gate), governor-preflighted with the
 *     per-cycle budget as the hard cycle cap (loop `prompt-ablation`), AND
 *     seeded INACTIVE (lib/ablation/seed-prompt-ablation-routine.ts).
 *   - `system:deferral-interest-refit` — self-learning-frontier-2026-06-12
 *     P-042 (FB-14, D-006). Nightly backfill of realized deferral costs from
 *     history (human-lane items → downstream blockage accrued in-window over
 *     coord_links + same-signature re-captures) + re-fit of the learned
 *     pricing model (lib/deferral-interest/, mig 252) the one queue ranker
 *     (P-040/FB-12) reads as its deferral-interest feature. SQL-only;
 *     flag-gated OFF (papercusp-deferral-interest — the frontier D-001
 *     arming gate), governor-preflighted (loop `deferral-interest-refit`),
 *     AND seeded INACTIVE (lib/deferral-interest/seed-deferral-interest-routine.ts).
 *   - `system:calibration-resolve` — self-learning-frontier-2026-06-12 P-041
 *     (FB-13). Every-6h maturity sweep over calibration bets
 *     (calibration_predictions, mig 253): each matured bet resolves against
 *     its domain probe (fix-survival re-capture check, plan-ship status,
 *     flake-recurrence re-capture) and feeds the per-persona Brier scores the
 *     one queue ranker (P-040/FB-12) + calibration:summary read. SQL-only;
 *     flag-gated OFF (papercusp-calibration-markets — the frontier D-001
 *     arming gate, which also gates the capture seams), governor-preflighted
 *     (loop `calibration-markets`), AND seeded INACTIVE
 *     (lib/calibration/seed-calibration-routine.ts).
 *   - `system:red-queen-drill` — self-learning-frontier-2026-06-12 P-031
 *     (FB-20). The vaccination cadence: per tick, ONE drill cycle — plant a
 *     known origin=drill friction in the SANDBOX workspace, detect it with a
 *     real watchdog tick, triage it through the real path (drill-opted-in),
 *     heal it with the class's known remedy; MTTSH + the zero-leak assertion
 *     land on harness_shared.red_queen_drills (mig 255). SQL-only; flag-gated
 *     OFF (papercusp-red-queen — the frontier D-001 arming gate, which also
 *     gates the out-of-band engine-death sentinel), governor-preflighted
 *     (loop `red-queen`), AND seeded INACTIVE
 *     (lib/red-queen/seed-red-queen-routine.ts).
 *   - `system:graduation-scan` — self-learning-frontier-2026-06-12 P-045/P-046
 *     (FB-19, D-008). Daily per-class clean-pass counting over the outcome
 *     rails (resolve evidence, decay verification, dispatch ledger, gym/EKG
 *     regressions); a class crossing the graduation threshold files an OWNER
 *     ratification report through the capture rails — NEVER an automatic
 *     autoKinds edit. SQL-only; flag-gated OFF (papercusp-graduation-tracker
 *     — the frontier D-001 arming gate), governor-preflighted (loop
 *     `graduation-tracker`), AND seeded INACTIVE
 *     (lib/graduation/seed-graduation-routine.ts).
 *   - `system:cargo-test` — production-test-readiness-2026-07-06 P-009 (WI-3206).
 *     Hourly (:45) native Rust/cargo suite run for the desktop shell
 *     (papercusp-desktop/src-tauri), recorded into harness_shared.test_runs as
 *     framework='cargo' via scripts/report-cargo-tests.mjs — the same signal path
 *     vitest/playwright already feed on their own routine cadence. Self-gates to
 *     the operator-home installSlug (the desktop shell only exists there). Seeded
 *     ACTIVE (seed-cargo-test-routine.ts) — read-only w.r.t. the repo, safe live.
 *   - `system:autoloop-release-readiness-monitor` — WI-5144 (follow-up from WI-4964 /
 *     rubric-system-and-auto-loop-release-profile-2026-07-15 P-011). Hourly (:15)
 *     evaluateAutoloopReleaseProfile() run (shells out to apps/operator/lib/release/
 *     run-autoloop-release-profile.ts — operator-core must not import the apps/operator
 *     tier, same layering as system:green-checkpoint/system:release-trigger). Records
 *     the verdict as a workspace fact every tick; emits the `release-pass:autoloop`
 *     awaited event ONLY on go:true. Seeded INACTIVE
 *     (seed-autoloop-release-readiness-routine.ts --active to arm).
 *   - `system:gate-canary-sweep` — WI-5977 (explicit-presence-as-convention-2026-07-26).
 *     The previously-missing SCHEDULED counterpart of the on-demand `gates:canary-check`
 *     tool: hourly, runs a KNOWN-GOOD sample through the federation-probe apparatus for
 *     the routine's own install_slug and records a per-harness fact
 *     (gate-canary-sweep-verdict) — so a gate that goes silently unreachable-by-
 *     construction (the 2026-07-10 cause #10 class) is caught by the system on a cadence,
 *     not only when an agent happens to run the on-demand check. A non-federated target
 *     harness reads as indeterminate (alarm:'none'), never a false 'gate-broken' (EI-11574
 *     precedent). Does NOT yet sweep the green-checkpoint result-parser canary
 *     (apps/operator tier — layering-excluded, same as system:autoloop-release-readiness-
 *     monitor; a named follow-on, not silently dropped) and does not yet escalate on a
 *     'gate' alarm (fact + log line only this pass). Seeded INACTIVE; the seed script
 *     ALSO requires an explicit `--harness=<slug>` (no safe default — see
 *     seed-gate-canary-sweep-routine.ts's header for why).
 */
import '../git-sync/git-sync-action';
// `system:foreign-git-sync` — the P-109 foreign-workspace commit lane (a
// SEPARATE routine from canonical git-sync by ratified design Q3).
import './foreign-git-sync-action';
// `system:sweep-orphaned-foreign-harnesses` — WI-1937/P-406 item 3: the
// ephemeral-harness ORPHAN-REGISTRY cleanup sweep (registerEphemeralForeignHarness
// rows left behind by a missed deregister). NOT the same as P-104's H12/H13
// superviseForeignSessions liveness/orphan-ORIGIN sweep (foreign-supervision.ts) —
// see foreign-supervision-action.ts below, which now closes that gap.
import './sweep-orphaned-foreign-harnesses-action';
// `system:p2p-foreign-supervision` — p2p-public-release-remaining-lanes-2026-07-16
// P-407 (D-004): P-104's H12/H13 foreign-session liveness + orphan-origin
// wind-down sweep, now bound to production data (foreign-supervision-production.ts)
// + scheduled. Seeded at boot by p2p/ensure-host-routines.ts.
import './foreign-supervision-action';
// papercusp-dogfood-phase7-pr-lifecycle P-042 (un-vaporware, PR-1): `system:pr-poll`
// — per-harness inbound-PR poll daemon (notice PR → track → trigger reviewer →
// decideAutoReview → auto-approve/merge). Seeded INACTIVE; the pr-reviewer-settings
// route flips it active when the reviewer role is enabled for a harness.
import '../../pr-host/poll-daemon';
import '../../blueprint/blueprint-run-action';
// scheduled-recurring-plans-2026-06-16 P-007: `system:plan-run` — one fire of a
// scheduled plan (instance plan → plan_runs row → run-scoped frontier work_items).
import './plan-run-action';
// blueprint-backed-work-item-execution P-016 / D-020: operation-backed plan
// schedules materialize on demand and reuse the routine fire workflow id.
import './blueprint-operation-action';
// work-on-everything-goal-2026-08-23 P-020 (D-006 ruling 3): `system:goal-start` —
// one scheduled activation of an existing goal via the startGoalById primitive.
import './goal-start-action';
import './external-trigger-dispatch-action';
import './facebook-personal-vault-poll-action';
import './google-calendar-poll-action';
import './google-gmail-poll-action';
import './personal-vault-import-action';
// overwatch-role-2026-06-15 B-04 (C-3): the `system:overwatch-launch` action the
// one-shot `overwatch-wake` routine fires — computes the OverwatchBrief + launches
// role=overwatch. Importing it here also registers the B-07 wake-bridge waker at
// boot (the module body calls registerOverwatchWaker). Self-gated on FLAGS.OVERWATCH
// + B-07's started bit; fully inert until the flag flips (B-12).
import '../../overwatch/loop';
import './release-actions';
import './fleet-headcount-action';
// goal-live-holder-guarantee-2026-08-18 P-007: the deterministic launch door
// for replacing the holder of an EXISTING goal. The P-009 reconciler calls the
// exported core directly; this registration also makes the operation available
// as `system:goal-holder-launch` with goalId in payload_template.
import './goal-holder-launch-action';
import './improvement-actions';
// knowledge-pack-loop-integrity-2026-07-19: fleet-lessons last-mile delivery
// (P-006) + the knowledge-hygiene cleanup routine (P-008).
import './knowledge-pack-actions';
import './p2p-perf-actions';
// `system:scout-cycle` — the workspace-singleton bespoke action was retired at
// P-130 (scout now runs via the `scout` blueprint's `blender:cycle` step). EI-18741240128927188:
// the PER-POT routine row `provision-learning-loop.ts` seeds INACTIVE at pot:create was left
// unwired though — its own docstring promised human-gated bring-up, but nothing registered a
// `system:scout-cycle` handler, so arming it silently no-op'd forever. register-scout-action.ts
// now self-registers it, reusing the SAME `productionScoutRunner` blender:cycle already runs.
import '../../scout/register-scout-action';
// `system:dream-cycle` — REM recombination P-005. Two inactive per-pot
// routines (manual control and the separate default-OFF auto setting) share
// this replay-safe, governor-bounded action.
import '../../dream/dream-cycle-action';
import './session-dir-gc-action';
// `system:telemetry-retention` — daily prune of the unbounded high-volume
// diagnostic tables (route_invocations/tool_invocations); infra-audit R2 (plan
// infra-perf-robustness-audit-2026-06-18 P-006). Seeded INACTIVE
// (seed-telemetry-retention-routine.ts --active).
import './telemetry-retention-action';
// `system:gc-plan-runs` — WI-5273: wires the already-built-and-tested
// gcScheduledPlanRuns (gc-plan-runs.ts) to an actual cadence — it had NEVER
// been invoked outside its own test since scheduled-recurring-plans-2026-06-16,
// so terminal scheduled-plan runs' instance plans accumulated unbounded (946
// dead rows from ONE 15-min plan over ~10.5 days, live-caught 2026-07-17).
// Seeded ACTIVE by default (seed-gc-plan-runs-routine.ts) — pure retention
// housekeeping over the routine's OWN already-terminal runs, no owner-authority
// surface.
import './gc-plan-runs-action';
// `system:gc-dead-loops` — the same unbounded-growth class, one table over
// (agents-system-pane-split-2026-07-26 P-007). `loop:arm` materialises one
// `loop-<ownerId>` routine row per looping session; `loop:end` and the dead-man
// sweep DEACTIVATE it and nothing ever deletes it, so the workspace was carrying
// 770 loop rows — 750 of them dead — accruing ~30/day since June. Reaps only
// INACTIVE loop rows whose owning session has been silent past the retention
// window (14d default); an armed loop is never touched at any age.
import './gc-dead-loops-action';
// `system:sweep-stalled-loops` — the COHERENCE sibling of gc-dead-loops above
// (WI-6639). gc-dead-loops reaps already-INACTIVE loop rows past a long retention
// window; this disarms an ARMED loop whose `computeTurnsStalled` verdict says fires
// are landing (or have stopped) with no turn actually produced — the "armed but
// dead" class nothing previously acted on (turnsStalled's only consumer was the
// read-only loop:status tool). Auto-pause + a single fleet-wide broadcast naming
// every disarmed owner (a cluster is usually one systemic event, not N failures).
import './stalled-loops-action';
// `system:reconcile-silent-halts` — the STRANDED-WORK sibling of the two loop-liveness sweeps
// (WI-35718). sweep-stalled-loops acts on ARMED loops that stopped producing turns;
// unguarded-halt-rescue WAKES a halted session when there is a reason to (fleet active, load 0,
// work claimable). Neither covers a halted session that HOLDS a claimed work-item — that is
// unguarded-halt-rescue's conjunct (2) excluding it by design, and it is the case where the harm
// is concrete rather than speculative: the owner is heartbeat-fresh so the dead-owner claim
// reaper will not reclaim the item, and the session takes no turns so nothing advances it. The
// item sits claimed and unworkable whether the agent is recoverable OR abandoned — which is why
// this is the one case that does not require resolving that distinction. Pages the OWNER (never
// the halted agent's inbox, which does not wake a session) and touches no loop.
import './silent-halt-action';
// `system:sweep-wedged-pty-hosts` — the LIVENESS sibling of sweep-stalled-loops above
// (EI-20287339148365013). That one keys on ARMED LOOPS, so it cannot see a session that
// never armed one — and a psu-pty host whose owner-composer wedges defers every wake
// while its process stays healthy, its socket stays live, and its wake receipts keep
// reporting `delivered`. The host CANNOT report this about itself: it acks `accepted`
// before its delivery gate runs, so the on-disk lifecycle ledger is the only channel
// carrying the outcome. Reads those ledgers from outside — which is also what lets it
// observe hosts too old to run the in-host breaker, since a code fix cannot reach a
// process that started before it.
import './pty-host-wedge-action';
import './gc-verify-instances-action';
// `system:gc-desktop-sessions` — the desktop lifecycle governor
// (agent-virtual-desktops-2026-08-23 P-005). Applies the idle ladder to live
// DesktopSession rows: demote → FREEZE the cgroup → reap. The freeze rung is the
// durable fix for the WI-5978 class, where three idle QEMU guests spin-burned
// 12.8 cores (11% of this box) continuously for 5-9 days because a guest whose
// idle loop never reaches HLT cannot tell it is idle — the host can.
import './gc-desktop-sessions-action';
// `system:psu-pty-host-events-ingest` — the Postgres tier + retention for psu-pty host
// delivery telemetry (psu-pty-turn-boundary-generalization-2026-09-22 P-007 / D-006). The
// host's own appendHostEvent is synchronous and fail-soft by contract and runs on teardown
// paths, so it must keep writing a local JSONL write-ahead log rather than reaching for a
// pool; this sweep is what makes that log queryable and bounded. It also supplies the
// denominator the plan needed: until P-007 added a `turn-delivered` row, all 51 host event
// kinds were failures or lifecycle markers, so a wake DELIVERY RATE was not computable and no
// fix to the wake path could be proven to work. Ingest strictly precedes GC, and a file whose
// insert failed is never deleted.
import './psu-pty-host-events-ingest-action';
// `system:precompute-derived-reads` — the cadence behind the derived-read substrate
// (precompute-derived-sync-reads-2026-07-19, WI-5460). Computes the three expensive
// derived sync reads (storage.usage 20.0s, plans.lint 13.8s, learning.soakReport
// 27.3s when measured inline) into harness_shared.derived_read_snapshots so their
// resolvers become plain SELECTs instead of blocking a user-facing page load.
// Pure derived-data maintenance — no agent, no LLM, no owner-authority surface —
// so seeded ACTIVE by default (seed-precompute-derived-reads-routine.ts), same
// class as gc-plan-runs.
import './precompute-derived-reads-action';
// `system:doc-anchor-reconcile` — periodic FULL doc-anchor reconcile (#5 PART B): the safety net for
// the git-sync re-anchor-on-change path. Re-derives anchors from CURRENT frontmatter for all
// anchor-derived docs so a stale anchor cache that slipped past re-anchor-on-change is caught. Pure
// DB/git maintenance (no agent, no LLM); seeded INACTIVE (seed-doc-anchor-reconcile-routine.ts --active).
import './doc-anchor-reconcile-action';
// operator-memory-and-psu-resilience-2026-06-14 P-011 (D-007): the idle-session
// reaper — marks dead-process open adv_sessions ended (reclaims roster +
// unblocks session-dir-gc). Flag-gated DEFAULT-OFF + seeded INACTIVE.
import './idle-session-reaper-action';
import './idle-backend-reaper-action';
// WI-1442 fix (c) / WI-1628: the Hetzner orphan-frame reaper — destroys ad-hoc
// federation-rig VMs (hzdeb* / pcusp-fed-*) whose creating agent's coord:presence
// is confirmed `ended`, closing the billing leak + the permanent-2-server-cap
// deadlock a dead agent's leftover frames cause. Not flag-gated (a destructive
// reaper deleting real billed VMs is the owner-authority carve-out); seeded
// INACTIVE (seed-hetzner-orphan-frame-reaper-routine.ts --active --dry-run first).
import './hetzner-orphan-frame-reaper-action';
// EI-18691186726153223: the orphaned-mcp-reaper — SIGTERM/SIGKILLs leaked
// agent-spawned `playwright-mcp` server processes (a long-running session's
// mcpServers config still listed `playwright`; P-020 already stops NEW fleet
// sessions from spawning it, this cleans up the already-running population).
// Only touches processes carrying PAPERCUSP_ADV_SESSION_ID and matching the
// playwright-mcp package/binary signature specifically. Flag-gated
// (ORPHANED_MCP_REAPER, DEFAULT ON) + seeded INACTIVE (double-gate — activate
// via seed-orphaned-mcp-reaper-routine.ts --active --dry-run first).
import './orphaned-mcp-reaper-action';
// infra-perf-reliability-audit-round3-2026-06-19 P-013 / WI-345 (F12): the
// test-webview reaper — DETECTION (toast) + KILL of leaked agent-spawned
// papercusp-desktop/WebKitWebProcess instances whose adv_session is ENDED.
// Flag-gated (TEST_WEBVIEW_REAPER, DEFAULT ON) + seeded INACTIVE (double-gate).
// Seed: seed-test-webview-reaper-routine.ts. Core: test-desktop-reaper.ts.
import './test-webview-reaper-action';
// RETIRED (P-059, D-090): `bee-transcript-cap-action` — the cup transcript-cap backstop.
// Its sole decider (`pot/cup-transcript-cap.ts`) retired with it; the routine row it
// registered never existed in `harness_shared.routines`, so nothing was orphaned. Restore
// contract: `_retired/mug-kettle-deciders/RESTORE.md` § `bee-transcript-cap`.
import './claim-discipline-action';
// WI-6054 (turn-end-tracking P-016): the SYSTEM-side unguarded-halt sweep. The
// detector's only caller was the agent-invoked `journal:record-turn`, so it never
// fired for an agent that simply stopped. This runs the same sweep from a system
// path and WAKES halted agents. Flag-gated DEFAULT-ON; throttled + capped.
import './unguarded-halt-rescue-action';
import './wake-brain-action';
import './gym-actions';
// Official app-template anti-rot runner. The active system:template-gym row
// must never outlive its handler again (EI-18741229858124453).
import './template-gym-action';
import '../../interactive-usage/interactive-usage-action';
// owner-inbox-single-pane-2026-07-17 P-002: client-agnostic session-gate
// transcript watcher (AskUserQuestion/ExitPlanMode tool_use with no
// tool_result = blocked on the owner). Seeded inactive until a routine-seed
// script activates it post-deploy, same discipline as the token-telemetry
// routines below.
import '../../attention/gate-watch-action';
import './token-report-action';
import './hive-canary-action';
import './coord-invariant-actions';
// P-009 / D-008: the derived half of the fleet leader transition feed
// (member-dead + member-left + context-critical), so a leader parks on an event instead of
// polling leader-brief on a 60s loop.
import './fleet-transition-sweep-action';
import './presence-transition-sweep-action';
import './cross-hive-drain-action';
import './human-queue-digest-action';
// platform-ops-batch-2026-07-09 P-001: the daily 09:00 UTC unclaimed-work digest —
// broadcasts (`to: ['*']`) a summary of currently-unclaimed papercusp work-items to
// the coord feed so the fleet sees what is going stale. Read-only; seeded ACTIVE
// (seed-unclaimed-work-digest-routine.ts).
import './unclaimed-work-digest-action';
// P-130 (deterministic-blueprints-migration-2026-06-13): TWELVE bucket-A learning
// loops migrated to deterministic blueprints — their bespoke `system:<loop>` action
// handlers are RETIRED (negative-space / neologism / regret / transfer / fleet-ekg /
// prompt-ablation / red-queen + change-ledger / deferral-interest / calibration /
// graduation + iq-battery-gen [the hybrid eval engine, D-013]). Their seeds fire
// `system:blueprint-run {blueprintId}`; the lib logic lives on as each op's impl (the
// shared `run<Loop>` orchestration); the no-retired-style guard (P-132) blocks
// re-wiring. Scout's WORKSPACE-SINGLETON `system:scout-cycle` registration stays
// retired this way — the blueprint is what runs it — but the PER-POT arming path
// (provision-learning-loop.ts) needed the action re-registered; see
// register-scout-action.ts (imported above, near p2p-perf-actions) and EI-18741240128927188.
// queen-autonomy-policy-2026-06-13 B-16: the auto-revert tripwire + graduation
// sweep (`system:autonomy-trust-scan`). Self-gates on MUG_AUTONOMY_ARMED (P-092);
// the seed routine ships INACTIVE (go-live activates it).
import './autonomy-trust-scan-action';
// work-item-dependency-edges-2026-08-02 P-004: `system:readiness-drift-monitor` — runs
// reconcileReadiness on a cadence and repairs drift between the trigger-maintained
// work_item_blocked sidecar and its oracle. The detector had existed since
// work-item-deps-and-readiness-2026-06-22 P-005 with NO production caller (its only
// caller in the tree was its own integration test), so sidecar drift — including the
// direction that hands out blocked work — was going unobserved.
import './readiness-drift-monitor-action';
import './cargo-test-action';
// WI-36794: daily Linux GUI-only nightly release cut. The action returns after
// launching the long build through managedSpawn, so the durable routine step stays
// short while the child remains tracked and resource-capped.
import './nightly-release-cut-action';
// p2p-git-live-activation-2026-07-09 P-205 (G-9): `system:pot-git-gc` — the
// ephemeral (tier:'ephemeral') per-hive-home cadence bounding a hive-git bare
// store's namespace-ref growth. Self-gates on `hiveGit.mode` (a no-op for
// legacy hives); armed by upsertHiveGitGcRoutine at the mode-flip-off-legacy
// call site (hive-git-gc-routine.ts) — no bespoke reconcile sweep needed.
import './hive-git-gc-action';
// context-injection-retrieval-reach-and-visibility-2026-08-03 P-018 (D-064):
// `system:corpus-term-df` — the DURABLE (tier:'durable', cron '7 */6 * * *')
// cadence that rebuilds the corpus document-frequency table `corpusQueryText`
// selects query terms with. Slow on purpose: DF only feeds a RANKING among ~100
// candidates, and that ordering does not turn over on the timescale the corpus
// grows.
//
// ⚠ It was tier:'ephemeral' at a 6h interval_sec until WI-1406487, and that was
// STRUCTURALLY UNFIREABLE: the ephemeral executor arms an in-process
// managedSetInterval that restarts from zero on every bg-host restart, and the
// host's longest measured uptime (336 min) is SHORTER than the 360-min period,
// so the timer never once reached its own deadline — active:true, an "armed" log
// line every boot, no error anywhere, and no fire for 35.7h. Any ephemeral
// cadence whose period approaches host uptime has the same defect. The durable
// tier is immune because `next_fire_at` is a Postgres column that survives the
// restart. Do not move this back.
// Additive by construction — until the table is first populated the lookup
// returns null and the leg keeps its original length ordering, so there is
// nothing to stage dark.
import './corpus-term-df-action';
// sql-escape-tool-routing-2026-08-12 P-008: `system:sql-read-census` — the nightly
// (tier:'durable', 04:17 host-local = 08:17 UTC here; the cron is evaluated in the host
// timezone, verified from the seeded row's next_fire_at) deterministic census of raw
// `dev:pg_query` reads against
// the tool-routing pair registry. No LLM and no daily agent turn: measured volume swings
// 10 -> 3,474 calls/day, so an agent would confirm "nothing changed" on most days at full
// turn cost. Wakes an agent ONLY on a threshold crossing — an uncovered cluster past N
// distinct agents, a pair verdict drifting off `equivalent`, or (the one that matters) a
// cluster whose traffic did NOT fall after its routing row shipped. DURABLE because the
// row it writes each night is the pre-ship baseline a later night's no-fall check reads,
// and `tool_invocations` is pruned to 14 days so that history cannot be recomputed.
import './sql-read-census-action';
// agent-launch-context-cost-2026-09-18 P-009(c) / D-016: `system:launch-cost-ceiling` —
// the standing watch on agent launch cost. DURABLE because it is one measurement per
// period for the whole install: an ephemeral row is armed per host, so a multi-host
// install would re-scan every transcript and alarm once per host. No LLM and no daily
// agent turn — it scans transcripts and compares medians, and wakes an agent ONLY on a
// leg crossing (a >=20% regression against the trailing baseline, or a median at/over the
// 250,000-token fleet-member compaction limit, where a session breaches its 90% steer
// point at birth).
//
// THIS IS THE DETECTOR THAT DID NOT EXIST. `scripts/measure-launch-cost.ts` was committed
// and correct and already exited 1 against a --target, and NOTHING RAN IT; launch cost
// drifted 107,841 -> 305,926 median tokens over five weeks and the only thing that ever
// fired was a human noticing agents felt slow. A measurement nobody runs is not a
// detector, which is why the import belongs here and not in a runbook.
import './launch-cost-ceiling-action';
// work-queue-admission-and-bulk-dedup P-003/P-004/P-011: one durable
// 30-minute duplication-only promoter, an independently scheduled
// deterministic fail-open/liveness guard, and the hourly one-call root-cause
// burst detector. None of these actions spawns an agent.
import './work-item-admission-promoter-action';
import './work-item-admission-bulk-dedup-action';
import './work-item-admission-delta-sweep-action';
import './completion-claim-recheck-action';
import './dead-citation-sweep-action';
// WI-1741477: the caller for the durable-escalation orphan detector built in
// EI-19339499404613652. Landed together with its TARGET_ROLE_SPEND entry, its seed script,
// and its BESPOKE_ACTIVE_SEEDS row — the detector's own defect is "an instrument that exists
// and never fires", so a half-wired registration here would reproduce it verbatim.
import './durable-escalation-orphan-sweep-action';
// autonomous-inbox-resolution-2026-08-31 P-004: bounded cross-harness
// retirement of stale legacy payload.needsHuman attention markers. The action
// fails closed for every typed owner/capability gate and mutates payload only.
import './legacy-needs-human-reconcile-action';
// silent-intake-central-resolution-2026-09-01 P-009 (audit R6): bounded
// cross-harness auto-close of episode-scoped operational rows (gate-restore
// tickets) once the green-checkpoint gate's CURRENT recorded verdict is a
// fresh, unambiguous green — the WI-38439/WI-39939/WI-40150 dead-episode
// class. Closes via the same setIssueState(skipCompletionGate) helper
// legacy-needs-human-reconcile-action.ts uses; never infers greenness.
import './episode-scoped-operational-reconcile-action';
// autonomous-inbox-resolution-2026-08-31 P-009: durable routinesTick backstop
// for the existing supervised Inbox bulk-resolver launch path.
import './inbox-bulk-resolve-action';
import './work-item-admission-daily-digest-action';
// silent-intake-central-resolution-2026-09-01 P-007: `system:resolver-whole-corpus` — the
// infrequent, quality-first whole-corpus resolver pass (same-defect merges + same-cause
// clusters). Single non-checkpointed step (D-002: quality over cost, one context; unlike
// bulk-dedup this never ratchets multi-stage convergence). Seeded by
// seed-resolver-whole-corpus-routine.ts (durable, off-peak :52).
import './resolver-whole-corpus-action';
import './work-item-durable-park-audit-action';
// critical-process-supervisor-2026-07-04 P-002 (EI-7021 design): `system:supervision-reconcile`
// — the failed-unit reconciler, a bespoke ephemeral (tier:'ephemeral', 60s) operator-HOME cadence
// (same reasoning as hive-git-gc-action's deviation from the generic per-install triggers.schedule
// path — see supervision-reconcile-action.ts). Restarts a down systemd-user SUPERVISED_PROCESSES
// entry when FLAGS.SUPERVISOR_AUTO_RESTART (default ON) && entry.autoRestart, with uniform
// flap-damping; report-only otherwise. Seeded ACTIVE by seed-supervision-reconcile-routine.ts.
import './supervision-reconcile-action';
// get-feedback-relevance-consults-2026-08-16 P-005 (D-005): `system:consult-expiry-sweep`
// — flips past-due open consult_state rows to 'expired' (bounded, partial-index scan) and
// emits the latched consult:reply:<conv> park key for hard-blocked rows so a parked
// requester whose responder never answered is woken instead of sleeping to their await
// timeout. A bespoke ephemeral (tier:'ephemeral', 300s) operator-HOME cadence (one sweep
// serves every workspace's rows). Seeded ACTIVE by seed-consult-expiry-routine.ts.
import './consult-expiry-action';
// frozen-candidate-compliance-enforcement-2026-08-30 P-008: `system:frozen-candidate-drift-sweep`
// — the ATTESTATION leg. Reports commits that touched the FROZEN candidate's failing paths
// while landing above it, which is the exact signature of a fix the gate cannot see. Every
// other item in that plan prevents the failure; this is the only one that says whether
// prevention worked, so the plan succeeded when this stops filing. Silent when nothing is
// frozen and when git cannot be read — it never reports a zero it did not measure.
import './frozen-candidate-drift-sweep-action';
// gate-verdict-liveness-and-repair-reliability-2026-08-31 P-012: `system:sync-batch-delta-check`
// — per-git-sync-batch verification of staging (every 5 min, bounded): affected-tests +
// workspace typecheck over the commits since a durable cursor, single-file re-confirmation
// before anything is filed, and ONE condition-keyed work-item per confirmed red naming the
// newest batch whose radius reaches it + a 60-min fix-or-revert SLA. Keeps staging near-green
// so a frozen candidate opens with ~0-3 reds instead of 42 legs / 226 files (plan D-001).
// Skips under host load and while a checkpoint suite runs; observer only — no revert, no gate
// fire, no spawn. Seeded ACTIVE (seed-sync-batch-delta-check-routine.ts).
import './sync-batch-delta-check-action';
// gate-verdict-liveness-and-repair-reliability-2026-08-31 P-016: `system:gate-fire-drill`
// — the weekly fire drill: on a GREEN idle unheld gate, launch a fresh recording checkpoint
// run, kill it seconds later, and assert the P-003 detection chain saw it (P-001 fire anchor
// counted, no verdict row leaked, evaluateVerdictRateAlarm fires over the real ledger window,
// gate_health untouched). A failed drill pages `gate-drill-detector:<harness>` — a detector
// regression, the exact blindness behind the 74.2h verdict blackout (plan D-001 loss class 2).
// Skips (recorded) on red gate / in-flight run / placed hold / load. Seeded ACTIVE
// (seed-gate-fire-drill-routine.ts).
import './gate-fire-drill-action';
// acceptance-grading-stall-sweep-2026-08-26 P-002/P-004: `system:acceptance-grading-sweep`
// — puts a clock on the one leg of plan completion that had none. A plan ships only after an
// INDEPENDENT grader emits a scorecard, and that grader is recruited lazily by the ship
// attempt's own refusal, so recovery is PULL-triggered: a dead grader heals on the next ship
// attempt, but a dead CREATOR means no attempt is ever made again and the plan sits at
// acceptance_ungraded forever with no timer and no owner. The sweep re-runs the idempotent
// resolveAcceptanceGrader for such plans and, past a longer threshold, mints exactly one
// condition-keyed work-item so the stall gets a single owner. It cannot grade, score, record a
// verdict or alter a refusal code — those capabilities are absent from its dependency
// interface. A bespoke ephemeral (tier:'ephemeral', 600s) operator-HOME cadence (one sweep
// serves every workspace's plans). Seeded ACTIVE by seed-acceptance-grading-sweep-routine.ts.
import './acceptance-grading-sweep-action';
// WI-10000846: the signal-accumulator recount and dead-target reaper used to run
// serially inside routinesTick, consuming ~68% of a working scheduler pass. They
// now retain their own durable cadences and heavy-work shedding, so dispatch no
// longer waits for either maintenance scan.
import './heavy-maintenance-sweep-actions';
// autonomous-inbox-resolution-2026-08-31 P-002: `system:bulk-run-watchdog` — the clock the bulk-run
// lifecycle never had. Every recovery path was pull-triggered (an owner pressing Restart), so a
// resolver that died mid-run left the run in `running` with its remaining items on `pending`
// indefinitely. Explicitly FAILS a stale executing run and marks its undecided items — recoverable,
// since restartRun accepts phase:'failed' and never touches decided outcomes — and reconciles run
// counters that disagree with their own rows (measured: bulk-7d35ee41 claims 5 auto + 19 recommended
// against ZERO finding rows). A bespoke ephemeral (tier:'ephemeral', 300s) operator-HOME cadence,
// same deviation reasoning as acceptance-grading-sweep-action. Seeded by
// seed-bulk-run-watchdog-routine.ts.
import './bulk-run-watchdog-action';
// deterministic-coverage-census-2026-08-17 P-002: `system:coverage-census` — projects the
// testable-surface census (harness_shared.testing_surfaces) from the same code registries that
// serve production traffic, then upserts/retires the diff. A bespoke ephemeral
// (tier:'ephemeral', 15min) operator-HOME cadence, same deviation reasoning as
// supervision-reconcile-action. Registered BEFORE its providers exist (they land in P-003) so
// the seeded routine has a real handler rather than silently skipping every fire
// (EI-18741229858124453); with no providers it is a correct no-op, because retirement is scoped
// to kinds a provider successfully enumerated. Seeded by seed-coverage-census-routine.ts.
import './coverage-census-action';
// WI-37700 (follow-on to WI-37696): `system:worker-breaker-watch` — announces a tripped
// persistent-worker crash-breaker on the embed SIDECAR (`workers.{embedder,reranker}` on
// its /healthz), a bespoke ephemeral (tier:'ephemeral', 5min) operator-HOME cadence (same
// deviation reasoning as supervision-reconcile-action). WI-37696 made those latches
// readable but nothing polled them, so a permanent silent fallback to main-thread work
// was still never ANNOUNCED. REPORT-ONLY: one broadcast per false→true edge, no restart
// and no readiness gating (a fallen-back worker is degraded, not down).
// ⚠ Watches TWO of the three breakers on purpose. The third (`cpuWorker`) is per-CLUSTER-
// WORKER state that /api/health/deep can only SAMPLE 1-of-N, so it announces itself from
// inside each worker instead — see cpu-task-worker.ts's configureCpuWorkerBreakerNotifier
// and worker-breaker-watch.ts's header for why the mechanism differs per leg.
// Seeded ACTIVE by seed-worker-breaker-watch-routine.ts.
import './worker-breaker-watch-action';
// task-manager-no-escape-2026-07-27 P-011: `system:task-reconcile` — the task
// manager's kernel-vs-ledger reconcile + metrics sample, a bespoke ephemeral
// (tier:'ephemeral', 30s) operator-HOME cadence (same deviation reasoning as
// supervision-reconcile-action). Walks our cgroup slice, refreshes live rows,
// closes strands, and FLAGS unaccounted processes — REPORT-ONLY, no kill and no
// freeze path exists (plan D-010). Seeded ACTIVE by seed-task-reconcile-routine.ts.
import './task-reconcile-action';
// EI-14693: `system:plan-item-orphan-reconcile` — the periodic data-heal for the
// transition-gap in the plan-item → work-item reconciler. The reaction rule
// (plan-items/reconcile-rule.ts) only fires on a plan item's done TRANSITION, so a
// work-item that lands non-terminal AFTER its plan item is already terminal (reset /
// complete-without-state / late create) is never re-healed. This 15-min sweep
// terminalizes that residue (fail-closed, idempotent, skips in-flight), extended to
// cover `dropped` plan items too. Seeded ACTIVE (seed-plan-item-orphan-reconcile-routine.ts)
// — pure data reconciliation, no owner-authority surface (mirrors gc-plan-runs).
import './plan-item-orphan-reconcile-action';
// P-020 of design-to-code-coverage-seam-2026-09-02: `system:acceptance-drain-sweep`
// — the EXIT for the acceptance gate, and the direct complement of the plan-drain
// sweep registered just below. That one pushes plans INTO `awaiting-acceptance`
// when their items drain; nothing pulled them out, and the ship refusal was
// visible only to whoever explicitly attempted a ship. Measured: 187 plans held,
// 86.1% never once audited, oldest 2026-06-04 (D-032). This 6-hour tick files ONE
// claimable work item per held plan, naming the gate's real first blocker and
// quoting its own repair text — the queue-not-wall pairing spec-triad already has.
// Bounded (cap per tick), idempotent (condition-keyed), never throws, never ships
// a plan itself. Seeded ACTIVE (seed-acceptance-drain-sweep-routine.ts).
import './acceptance-drain-sweep-action';
// P-005 of deterministic-plan-state-derivation-2026-08-31: `system:plan-drain-sweep`
// — the same rule-for-immediacy + sweep-for-backstop pairing one level UP, on the
// PLAN's own lifecycle status. P-004's `plan-drain:terminality-changed` reaction
// reconciles a plan whose last item goes terminal from now on; the 205 plans that
// drained BEFORE it shipped have no future event to fire on, so this 30-min tick
// re-examines them. Bounded (cap per tick), idempotent, symmetric; never touches
// `draft`, terminal statuses, archived plans or scheduled-plan instances, and never
// advances a plan to `shipped`. Seeded ACTIVE (seed-plan-drain-sweep-routine.ts).
import './plan-drain-sweep-action';
// EI-18713141708830049: `system:plan-item-reflect-orphan-reconcile` — the MIRROR of
// the sweep above, for the reflect direction (work_item terminal → plan item still
// `todo`). That direction had a reaction rule (plan-items/reflect-rules.ts) and NO
// periodic backstop, so any missed event left a permanent phantom-todo that agents
// re-investigate and nearly re-implement (30 measured 2026-08-13). Strict predicate:
// flips only when EVERY linked work-item is terminal, at least one is done-like, and
// none carries independent in-flight progress. Fail-closed, idempotent; the flip goes
// through the real plans:set-status tool. Seeded ACTIVE — same class as its twin.
import './plan-item-reflect-orphan-reconcile-action';
// WI-5144 (follow-up from WI-4964 / rubric-system-and-auto-loop-release-profile-
// 2026-07-15 P-011): `system:autoloop-release-readiness-monitor` — hourly cadence for
// evaluateAutoloopReleaseProfile() (apps/operator/lib/release/release-profile.ts,
// previously only ever run ad-hoc). Shells out to the standalone
// run-autoloop-release-profile.ts CLI (operator-core must not import the apps/operator
// tier); records the verdict as a workspace fact every tick, emits
// `release-pass:autoloop` only on go:true. Seeded INACTIVE
// (seed-autoloop-release-readiness-routine.ts --active to arm).
import './autoloop-release-readiness-action';
// WI-5977 (explicit-presence-as-convention-2026-07-26): `system:gate-canary-sweep` — the
// previously-missing scheduled counterpart of the on-demand gates:canary-check tool.
// Seeded INACTIVE (seed-gate-canary-sweep-routine.ts --harness=<slug> --active to arm).
import '../../gates/gate-canary-sweep-action';
// WI-6454: `system:gitnexus-reindex` — the refresh owner for the gitnexus code graph
// that `gitnexus.context`/`gitnexus.query` answer from. The graph was built by hand once
// and nothing re-indexed it, so it decayed from the minute it was written — the sole
// condition pinning the `code-search.definition-lookup` substitution pair at `observe`.
// `analyze` is a FULL re-index (234s even against a fresh index), so the hourly (:35)
// fire is only a cheap CHECK: registry + git + loadavg decide, and the expensive spawn
// happens only when the graph is genuinely behind and the box is not oversubscribed.
// Seeded ACTIVE (seed-gitnexus-reindex-routine.ts --inactive to seed off) — it writes
// only the gitignored .gitnexus/ index and self-gates to the operator-home installSlug.
import './gitnexus-reindex-action';
// EI-20475585438015488 (cause 3): `system:project-history-refresh` — the refresh owner
// for a hive's committed Project History artifact. The artifact is generated from PG
// (plans + work-items) but SERVED by a hive whose public repo must build and run with
// no operator and no database, so it can be refreshed neither at build time nor at
// request time — which left it with no owner at all: SideStage's snapshot was
// hand-generated once and had drifted ~2 days (and carried 17 acceptance-* template
// plans) by the time the History tab was found presenting it as the full archive.
// Generic over harness: repo root, output, prefix, ids and export name are all
// trigger_config, so a second History-shipping hive seeds a row and needs no code.
// Seeded ACTIVE (seed-project-history-refresh-routine.ts --inactive to seed off) — it
// is precondition-gated (refuses rather than writing when the pinned CLI or `ptool`
// cannot be resolved) and writes only the artifact path an operator supplied.
import './project-history-refresh-action';
// unshipped-plans-live-reconciliation-audit-2026-08-20 P-005 — registered on the
// canonical system-action seam but intentionally has NO seeded cadence. The
// purpose-built plans:audit-unshipped tool fires the same implementation on demand.
import './unshipped-plans-audit-action';
// scheduling-and-liveness-source-of-truth-2026-08-31 P-005: `system:oddsmith-paper-cycle`,
// `system:oddsmith-error-triage-ingest`, `system:oddsmith-error-triage-autofix` — the
// durable DBOS replacements for three Unix crontab entries that ran outside the routines
// pause/status/liveness machinery entirely. Each self-gates to the oddsmith harness
// (installSlug check) and throws on a genuine failure instead of the hand-rolled
// cron-alarm.sh streak-file alarm the crontab wrappers used — the routines engine's own
// last_error/last_error_at bookkeeping (routines-workflow.ts) now covers it. Seeded by
// seed-oddsmith-cron-routines.ts.
import './oddsmith-paper-cycle-action';
import './oddsmith-error-triage-ingest-action';
import './oddsmith-error-triage-autofix-action';
// EI-21921833535413808: `system:account-capacity-reprobe` — a walled account whose upstream
// window actually reset (or was never really full — `usageWalled` is a THRESHOLD CHECK on a
// projection, not an observed refusal) had NOTHING to re-ask upstream: a walled account is
// routed no live traffic, so its projection never self-corrects, and only a human/agent
// thinking to run `accounts:probe-capacity` by hand recovered it (measured: +50% of the usable
// Claude pool from one manual call). Fires the tool's own `runCapacityProbe` core,
// `walledOnly: true, apply: true`, per provider — cheap by construction (only accounts already
// flagged full are probed; a genuinely-walled account is just re-confirmed). A bespoke
// ephemeral (tier:'ephemeral', 300s) operator-HOME cadence, same deviation reasoning as
// supervision-reconcile-action. Seeded ACTIVE by seed-account-capacity-reprobe-routine.ts.
import './account-capacity-reprobe-action';
// WI-2143803: `system:hosted-lifecycle-reconcile` — `reconcileHostedLifecycleJobs` implements the
// whole workspace-host recovery state machine (stuck / orphaned / exhausted + intervention notice)
// and had ZERO production callers, so none of it ever ran: kill the controller mid-operation and the
// workspace_host_operations row is stranded in `status='running'` forever (measured on the P-046 rig
// — it survives a full controller restart, because the row is a ledger row, not an in-flight DBOS
// workflow, so DBOS recovery does not cover it either). Scheduling it was only half the fix: the
// sweep used to INNER JOIN customer_workspaces while every BYOC operation has
// customer_workspace_id NULL, so it would have run, passed, and matched nothing. The joins are OUTER
// now. A bespoke ephemeral (tier:'ephemeral', 120s — under the sweep's own 5min stuck threshold)
// cadence, same deviation reasoning as supervision-reconcile-action. Seeded ACTIVE by
// seed-hosted-lifecycle-reconcile-routine.ts.
import './hosted-lifecycle-reconcile-action';
