/**
 * `lib/replay` — the replay harness (self-learning-frontier-2026-06-12 P-020 /
 * FB-06): re-run an agent from a historical transcript point (or a synthetic
 * context) under a modified prompt/policy and score the divergence, on the ONE
 * eval-battery engine (`@papercusp/eval-battery`, reconciliation D-001).
 *
 * The single substrate for the Stage-D consumers — keep this API generic:
 *   - regret mining (P-021/FB-07): historical cases at detected divergence
 *     turns; variants = candidate rule changes (`systemOverlay`);
 *   - transfer harness (P-022/FB-08): with-lesson vs without-lesson variants
 *     on the source task's case;
 *   - shadow ablation (P-023/FB-09): `systemReplace` variants with one rule
 *     removed, vs the baseline.
 *
 * Layers:
 *   types.ts      — vocabulary + ports (runner / transcript source / store)
 *   transcript.ts — jsonl → turns parser (claude/omp/codex), cut + render
 *   divergence.ts — deterministic divergence signals (pure)
 *   battery.ts    — the eval-battery subject + runReplayBattery
 *   store.ts      — PG cell store (harness_shared.replay_runs, migration 247)
 *   governed.ts   — flag + learning-governor gate (D-001 double-dark,
 *                   D-004 budget refusal) + spend ledgering (origin=replay)
 *
 * DARK SHIP (D-001): flag `papercusp-replay-harness` defaults OFF and the
 * `frontier:replay-harness` loop ships unregistered/unbudgeted — both flip at
 * the P-001 arming gate (`registerReplayLoop` is the arming act).
 */
export * from './types';
export * from './transcript';
export * from './divergence';
export * from './battery';
export * from './store';
export * from './governed';
