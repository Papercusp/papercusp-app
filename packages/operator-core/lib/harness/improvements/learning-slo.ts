/**
 * learning-slo.ts — audit-as-sensors (self-learning-frontier-2026-06-12
 * P-047 / FB-21).
 *
 * The 2026-06-12 manual learning-system audit found its problems by reading
 * the same KPIs the Learning tab displays — triage routing, queue flow,
 * governor budgets, memory recall health. This module makes those findings
 * PERMANENT watchdog collectors: five learning-system SLOs swept on the
 * existing `system:improvement-watchdog` cadence, each breach filing through
 * the shared capture core into the very queue it measures (kinds per FB-18's
 * fidelity rules — a clear-correct-state breach is kind=bug and rides the
 * auto lane; a judgment-shaped one is kind=change and lands at the gate).
 *
 *   - **triage-entropy**            — the decision distribution over recently
 *     triaged items has collapsed (normalized Shannon entropy under the SLO):
 *     the EI-364 degeneracy class, where 100/100 ideas routed to one lane and
 *     the triage layer added zero information. kind=bug (EI-364's fix was a
 *     code fix: classifier scope wiring).
 *   - **capture-consume-imbalance** — captures are entering the improvements
 *     queue faster than ANYTHING leaves it: the audited drain pathology D-001
 *     exists to avoid pouring new capture into. kind=change (the fix is a
 *     capacity/policy decision).
 *   - **mttsh-regression**          — mean-time-to-self-heal measured by
 *     FB-20's red-queen drills has regressed vs its own baseline. Ships
 *     DORMANT-TOLERANT: FB-20 may not have landed/armed — an absent store is
 *     a per-tick note, never an error. kind=change (diagnosis-shaped).
 *   - **governor-starvation**       — an ENABLED, BUDGETED lifetime loop has
 *     spent down to the floor, so the D-004 preflight refuses every unattended
 *     run: the loop silently stopped learning. Deliberately ignores unbudgeted
 *     loops — those are the dark-shipped frontier loops awaiting their P-001
 *     budget, already on the governor's watch list. kind=change (budgets are
 *     the owner's dial).
 *   - **memory-zero-hit**           — the recall zero-hit rate (B-10's
 *     memory_recall_stats telemetry, mig 240) spiked vs its trailing baseline:
 *     the EI-366 index-degradation class. kind=bug (clear correct state — the
 *     baseline rate; regression-testable against the stats table).
 *
 * SLO thresholds are EXPORTED TUNABLES (`LEARNING_SLO_DEFAULTS`), overridable
 * per-tick from the watchdog routine's payload_template (PAYLOAD_TUNABLE_KEYS
 * in watchdog.ts) — threshold tuning never needs a deploy.
 *
 * Armed (EI-18886519654229938 — corrected 2026-08-02; this comment previously
 * said "default OFF, KNOWN_DARK_FLAGS", which was never true in the code: the
 * flag was never added to DARK_FLAGS, so it has always derived live default-ON
 * via FLAG_DEFAULTS). All five collectors ride ONE flag,
 * `papercusp-learning-slo-sensors`, default ON. They are SQL-only (zero LLM
 * spend) and ride the watchdog's own routine (no routine of their own, no
 * governor registration). The self-learning-frontier-2026-06-12 P-001 arming
 * gate closed 2026-06-13 (D-010) with wave 1 — the zero-spend, SQL-only
 * audit-as-sensors collectors this file implements — explicitly named as
 * safe-to-arm-with-no-spend-risk; that arming simply landed as "never added
 * to DARK_FLAGS" instead of an explicit flip, and zero `learning-slo:*`
 * findings have ever fired (verified live 2026-08-02), so the sensors have
 * been running quietly and safely all along. The flag itself remains a normal
 * operator kill-switch — flip it OFF via /admin/features to silence every
 * collector; each then reports a 'dark' note in the tick record and emits
 * nothing, per `darkOrNull` below.
 *
 * All signals are LIVE-STATE (no `latestAt`): a breach that still holds after
 * its filed item was resolved is a genuine regression, so the post-resolve
 * re-file is always legitimate (watchdog-audit P-005 semantics).
 *
 * Pure row→signal mappers are exported for unit tests; IO wrappers take an
 * injectable deps seam (the watchdog collector pattern).
 */

import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import {
  checkLoopVerdict,
  LEARNING_GOVERNOR_BUDGET_FLOOR_USD,
  type LearningLoopRegistration,
} from '../../learning-governor/core';
import { listLearningLoops } from '../../learning-governor/store';
import type { CollectorResult, WatchdogSignal } from './watchdog';
// P-036: the legacy score-scale band constants. Imported rather than restated
// so this collector's SQL and `classifyLegacyScoreScale` can never drift apart.
// P-013 additionally consumes the per-pool / per-surface aggregates themselves,
// rather than re-deriving them here — see recallPoolSignalsFromHealth.
import {
  RRF_SCORE_CEILING,
  COSINE_ADMISSION_FLOOR,
  readRecallHealthByPool,
  readRecallHealthBySurface,
  readRecallScaleContradictions,
  type RecallPoolHealth,
  type RecallSurfaceHealth,
  type RecallScaleContradiction,
} from '../../memory/recall-stats';

// ── SLO thresholds (exported tunables — FB-21's "SLO thresholds as exported
//    tunables" requirement; every key is also payload-tunable on the watchdog
//    routine, see PAYLOAD_TUNABLE_KEYS) ───────────────────────────────────────

export const LEARNING_SLO_DEFAULTS = {
  /** triage-entropy: trailing window of triaged items sampled (days). */
  triageEntropyWindowDays: 7,
  /** triage-entropy: minimum triaged items in the window before the SLO applies. */
  triageEntropyMinSample: 20,
  /** triage-entropy SLO: normalized decision entropy BELOW this = degenerate routing. */
  triageEntropyMinNormalized: 0.15,
  /** capture-vs-consume: trailing flow window (days). */
  flowWindowDays: 7,
  /** capture-vs-consume: minimum captures in the window before the SLO applies. */
  flowMinInflow: 10,
  /** capture-vs-consume SLO: inflow/outflow at or past this ratio = imbalance. */
  flowMaxRatio: 3,
  /** mttsh: recent measurement window (days). */
  mttshRecentDays: 7,
  /** mttsh: baseline window preceding the recent window (days). */
  mttshBaselineDays: 28,
  /** mttsh: minimum healed drills in EACH window before the SLO applies. */
  mttshMinSamples: 5,
  /** mttsh SLO: recent median at or past baseline median × this = regression. */
  mttshMaxRegressionFactor: 1.5,
  /** governor-starvation: the remaining-budget floor a lifetime loop refuses under (D-004). */
  governorStarvationFloorUsd: LEARNING_GOVERNOR_BUDGET_FLOOR_USD,
  /** memory zero-hit: recent recall window (hours). */
  memoryZeroHitRecentHours: 24,
  /** memory zero-hit: baseline window preceding the recent window (days). */
  memoryZeroHitBaselineDays: 7,
  /** memory zero-hit: minimum recalls in the recent window before the SLO applies. */
  memoryZeroHitMinRecalls: 20,
  /** memory zero-hit SLO: recent zero-hit rate must reach this absolute rate… */
  memoryZeroHitMaxRate: 0.4,
  /** …AND baseline rate × this factor (when a baseline of ≥ minRecalls exists). */
  memoryZeroHitSpikeFactor: 2,
  /**
   * EI-7774: …AND (when both windows carry a usable non-zero-hit top-score
   * median) the recent P50 has ALSO dropped to at most baseline × this
   * factor. A zero-hit rate spike with a STABLE-or-better top-score on the
   * recalls that DID hit is a healthy burst of cold-pool/novel queries, not
   * the EI-366 index-degradation signature (which collapses the top-score
   * distribution too). 0.85 = the recent median must fall to ≤85% of
   * baseline to still count as a genuine regression.
   */
  memoryZeroHitTopScoreDropFactor: 0.85,
  /** recall-pool: trailing window (days) for the per-pool aggregate. */
  recallPoolWindowDays: 7,
  /**
   * recall-pool: minimum recalls a (surface, pool, scale) slice must have
   * PARTICIPATED in before either pool SLO applies. Matches
   * memoryZeroHitMinRecalls deliberately — a pool slice is a strict subset of a
   * surface's recalls, so a laxer bar here would make the finer-grained detector
   * the JUMPIER one, which is backwards.
   */
  recallPoolMinRecalls: 20,
  /**
   * recall-pool SLO (gate-2): a pool contributing NOTHING on at least this share
   * of the recalls it took part in. A pool keyed on a scope nothing writes to
   * sits at exactly 1.0; 0.85 also catches the near-total case (a scope that is
   * populated but effectively never matches) without firing on a merely quiet
   * pool. Measured healthy pools on this box sit at 0.0–0.25.
   *
   * ⚠ This is the bar for a pool with a LARGE corpus only. It is scaled up for
   * a small corpus by `effectiveZeroHitGate` — see the two constants below and
   * that function's contract for why a flat bar cannot work.
   */
  recallPoolMaxZeroHitRate: 0.85,
  /**
   * recall-pool (gate-2, EI-20878926803436140): at or below this many active
   * memories, a pool is judged by `recallPoolSmallCorpusMaxZeroHitRate`
   * instead of the flat `recallPoolMaxZeroHitRate`.
   *
   * WHY A CORPUS TERM EXISTS AT ALL: the zero-hit rate confounds two
   * independent things — whether the pool is REACHABLE, and how SPECIFIC the
   * asking surface's query is. Measured 2026-08-19 with the corpus and scope
   * held constant (`hive:papercusp`, 58 active memories, 0% empty-scope):
   *   initialize n=19,125 → 0.000 · turn-start n=13,948 → 0.529
   *   claim      n= 1,674 → 0.843 · mid-turn   n=207,390 → 0.874
   * One corpus, one scope, 0.000→0.874 purely by surface. Both extremes are
   * large samples, so this is structural rather than noise — and it puts the
   * flat 0.85 gate INSIDE the normal band for a small corpus. That false alarm
   * held EI-19920080383279759 at CRITICAL for 11 days and was mis-triaged
   * twice across ≥3 sessions before the confound was measured.
   */
  recallPoolSmallCorpus: 100,
  /** recall-pool (gate-2): at or above this many active memories the flat
   *  `recallPoolMaxZeroHitRate` applies unchanged — a corpus this large cannot
   *  explain a near-total blackout by sparsity. Between the two bounds the bar
   *  interpolates linearly, so there is no cliff for a pool sitting near it. */
  recallPoolLargeCorpus: 500,
  /**
   * recall-pool (gate-2): the bar for a SMALL corpus. Deliberately close to
   * 1.0 rather than disabling the gate for small pools, because the pathology
   * gate-2 targets (a pool keyed on a scope nothing writes to) sits at exactly
   * 1.0 REGARDLESS of corpus size — so a small pool that genuinely breaks is
   * still caught. Validated against 32 real slices spanning both windows:
   * `injection/harness` (27 active, 0.995 zero-hit) still fires, while
   * `mid-turn/hive` (58 active, 0.858) — the 11-day false alarm — no longer
   * does. Do NOT raise this to 1.0: a pool answering on 1% of calls is broken.
   */
  recallPoolSmallCorpusMaxZeroHitRate: 0.97,
  /**
   * recall-pool SLO (gate-4): a pool returning EXACTLY its own recorded budget on
   * at least this share of its recalls — the block is being sized by the limit
   * rather than by relevance. Compared against the budget STORED ON THE ROW, so
   * the test stays correct across constant retunes (P-026).
   */
  recallPoolMaxSaturationRate: 0.8,
  /**
   * recall-pool SLO (gate-3, D-035): a pool ASKED under an EMPTY scope list on at
   * least this share of its recalls.
   *
   * Deliberately far below the 0.85 zero-hit gate, and that asymmetry is the
   * point: an empty scope is a CALLER defect, not a corpus outcome, so there is
   * no "healthy" rate to leave headroom for — a correctly-wired pool measures
   * 0.0. The offenders that motivated it sit at 68.8% (turn-start/harness) and
   * 45.3% (mid-turn/harness), both UNDER the zero-hit gate and therefore
   * invisible to gate-2 for the entire window they were broken. 0.25 keeps a
   * genuinely mixed-mode surface (some calls legitimately unscoped) from firing
   * while catching every case of this class observed on this box.
   */
  recallPoolMaxEmptyScopeRate: 0.25,
  /**
   * recall-pool SLO (gate-3, WI-6932): the RECENT sub-window (hours) checked
   * alongside the `recallPoolWindowDays` trailing rate before gate-3 fires.
   *
   * WHY: a flat 7d trailing RATE cannot express "this was broken, and no
   * longer is" — a sharp step-function fix (D-035 landed 2026-08-02 02:00Z,
   * empty-scope rate 0.495 → 0.000 in one hour, held at 0.000 for 4h straight
   * across 4,434 recalls) still reads as a 0.27–0.37 breach for the full 7
   * days it takes the pre-fix rows to age out of the window — a false
   * critical against already-shipped work, refiled every tick until then.
   * Mirrors `memoryZeroHitRecentHours`'s established recent-vs-baseline
   * pattern (same 24h default) rather than inventing a second convention.
   */
  recallPoolEmptyScopeRecentHours: 24,
} as const;

/** Per-tick overrides for the SLO tunables (CollectOptions extends this). */
export interface LearningSloOptions {
  triageEntropyWindowDays?: number;
  triageEntropyMinSample?: number;
  triageEntropyMinNormalized?: number;
  flowWindowDays?: number;
  flowMinInflow?: number;
  flowMaxRatio?: number;
  mttshRecentDays?: number;
  mttshBaselineDays?: number;
  mttshMinSamples?: number;
  mttshMaxRegressionFactor?: number;
  governorStarvationFloorUsd?: number;
  memoryZeroHitRecentHours?: number;
  memoryZeroHitBaselineDays?: number;
  memoryZeroHitMinRecalls?: number;
  memoryZeroHitMaxRate?: number;
  memoryZeroHitSpikeFactor?: number;
  memoryZeroHitTopScoreDropFactor?: number;
  recallPoolWindowDays?: number;
  recallPoolMinRecalls?: number;
  recallPoolMaxZeroHitRate?: number;
  recallPoolSmallCorpus?: number;
  recallPoolLargeCorpus?: number;
  recallPoolSmallCorpusMaxZeroHitRate?: number;
  recallPoolMaxSaturationRate?: number;
  recallPoolMaxEmptyScopeRate?: number;
  recallPoolEmptyScopeRecentHours?: number;
}

/** Injectable IO seam (unit tests run without PG / flags). */
export interface LearningSloDeps {
  /** Armed check — default reads FLAGS.LEARNING_SLO_SENSORS (default ON; a normal operator kill-switch, not a D-001 dark gate — see the module doc). */
  isArmed: () => Promise<boolean>;
  sql: () => Sql;
}

const defaultDeps: LearningSloDeps = {
  isArmed: () => getFlag(FLAGS.LEARNING_SLO_SENSORS, 'learning-slo-sensors'),
  sql: () => getOrgPg().sql as unknown as Sql,
};

/** The dark-tick result every collector returns while the flag is OFF (the normal
 *  off-state of any kill-switch flag — see the module doc for why this is no longer
 *  a D-001 arming gate). */
export const LEARNING_SLO_DARK_NOTE =
  'dark: papercusp-learning-slo-sensors OFF (operator kill-switch — flip via /admin/features to re-arm; the P-001 arming gate closed 2026-06-13, self-learning-frontier-2026-06-12 D-010)';

async function darkOrNull(deps: LearningSloDeps): Promise<CollectorResult | null> {
  let armed = false;
  try {
    armed = await deps.isArmed();
  } catch {
    armed = false; // a broken flag read keeps the sensors dark — never fail toward filing
  }
  return armed ? null : { signals: [], note: LEARNING_SLO_DARK_NOTE };
}

// ── triage-entropy ────────────────────────────────────────────────────────────

/** The triage decision space (triage.ts TriageDecision) — the entropy denominator. */
export const TRIAGE_DECISION_CLASSES = 4; // place | gate | gym | reject

/**
 * Pure: normalized Shannon entropy of a decision histogram in [0,1] —
 * 0 = every item routed to one lane (the EI-364 shape), 1 = uniform over the
 * full decision space. Normalized by log2(TRIAGE_DECISION_CLASSES) so the
 * value is comparable as the SLO regardless of which lanes appear.
 */
export function normalizedTriageEntropy(counts: Record<string, number>): { n: number; entropy: number } {
  let n = 0;
  for (const c of Object.values(counts)) n += Math.max(0, c);
  if (n === 0) return { n: 0, entropy: 0 };
  let h = 0;
  for (const c of Object.values(counts)) {
    if (c <= 0) continue;
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return { n, entropy: h / Math.log2(TRIAGE_DECISION_CLASSES) };
}

/**
 * Pure: triaged-item decision rows → at most ONE degeneracy signal. Fires when
 * the window holds ≥ minSample triaged items AND their normalized decision
 * entropy is under the SLO — i.e. the triage layer is adding ~zero routing
 * information (EI-364: 100/100 ideas → gate). kind=bug per FB-18's fidelity
 * rules: the correct state is clear (a distribution that discriminates), the
 * cause is code-level (classifier/scope wiring), and the fix is
 * regression-testable — EI-364's was.
 */
export function triageEntropySignalsFromRows(
  rows: { decision: string }[],
  opts: LearningSloOptions = {},
): WatchdogSignal[] {
  const minSample = opts.triageEntropyMinSample ?? LEARNING_SLO_DEFAULTS.triageEntropyMinSample;
  const slo = opts.triageEntropyMinNormalized ?? LEARNING_SLO_DEFAULTS.triageEntropyMinNormalized;
  const windowDays = opts.triageEntropyWindowDays ?? LEARNING_SLO_DEFAULTS.triageEntropyWindowDays;
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.decision] = (counts[r.decision] ?? 0) + 1;
  const { n, entropy } = normalizedTriageEntropy(counts);
  if (n < minSample || entropy >= slo) return [];
  const breakdown = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([d, c]) => `${d}: ${c}`)
    .join(', ');
  return [{
    source: 'triage-entropy',
    key: 'triage-decision-distribution',
    title: 'Triage decision distribution is degenerate (entropy SLO breach)',
    body:
      `Watchdog signal (triage-entropy): across the ${n} item(s) triaged in the last ${windowDays}d the ` +
      `decision distribution is ${breakdown} — normalized entropy ${entropy.toFixed(3)}, under the ${slo} SLO. ` +
      `The triage layer is adding ~zero routing information (the EI-364 degeneracy class: a misrouting ` +
      `classifier or a structurally uninformative taxonomy), so every capture lands in one lane regardless ` +
      `of its shape.`,
    severity: 'major',
    kind: 'bug',
    findingClass: 'learning-slo:triage-degeneracy',
    paths: ['packages/operator-core/lib/harness/improvements/triage.ts'],
  }];
}

/**
 * triage-entropy: decision distribution over items triaged in the window
 * (payload.ideaLifecycle.triageDecision).
 * Organic-only per D-002 — drill/replay rows must not shape the distribution.
 *
 * ⚠ THE WINDOW KEY IS THE TRIAGE TIME, NOT `updated_at`. This query used to filter on
 * `updated_at > now() - 7d`, which dates nothing on this table: a background sweep
 * touches every row, so the "last 7 days" window admitted the WHOLE historical corpus
 * and its healthy old mixture drowned the live signal. Measured 2026-08-02 against the
 * live DB, the `updated_at` form returned `place 1493 / gate 418 / reject 79 / gym 10`
 * — normalized entropy 0.50, comfortably above the 0.15 SLO, i.e. "routing looks
 * healthy" — while the classifier had in fact emitted `place` and ONLY `place` for
 * ~429 consecutive decisions across 13 days (EI-19370922358009801). The detector was
 * built for exactly that collapse and could not see it.
 *
 * `triagedAt` is stamped immutably at triage (lifecycle.ts); rows predating that field
 * COALESCE to `stateUpdatedAt`. Both are ISO-8601 UTC strings written by
 * `new Date().toISOString()`, so they are compared LEXICOGRAPHICALLY against a
 * formatted bound — a cast would throw the whole collector on one malformed row, and a
 * detector that dies silently is the failure mode this fix exists to remove.
 *
 * The `LIMIT` is ordered NEWEST-FIRST. An unordered `LIMIT 2000` samples an arbitrary
 * 2000 rows of the match set, so even a correct window could have handed the SLO a
 * sample that was not the recent behaviour it is meant to judge.
 */
export async function collectTriageEntropySignals(
  sql: Sql,
  workspaceId: string,
  opts: LearningSloOptions = {},
): Promise<WatchdogSignal[]> {
  const windowDays = opts.triageEntropyWindowDays ?? LEARNING_SLO_DEFAULTS.triageEntropyWindowDays;
  const rows = await sql<{ decision: string }[]>`
    SELECT payload->'ideaLifecycle'->>'triageDecision' AS decision
      FROM harness_shared.engineer_issues
     WHERE workspace_id = ${workspaceId}
       AND COALESCE(signal_origin, 'organic') = 'organic'
       AND payload->'ideaLifecycle'->>'triageDecision' IS NOT NULL
       AND COALESCE(
             payload->'ideaLifecycle'->>'triagedAt',
             payload->'ideaLifecycle'->>'stateUpdatedAt'
           ) > to_char((now() - make_interval(days => ${windowDays})) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS')
     ORDER BY COALESCE(
                payload->'ideaLifecycle'->>'triagedAt',
                payload->'ideaLifecycle'->>'stateUpdatedAt'
              ) DESC
     LIMIT 2000`;
  return triageEntropySignalsFromRows(rows, opts);
}

// ── capture-vs-consume flow imbalance ────────────────────────────────────────

export interface FlowAggregate {
  /** Items captured (created) in the window. */
  inflow: number;
  /** Items that LEFT the open state in the window (resolved/closed; updated_at proxy). */
  outflow: number;
  /** Currently-open backlog (all time). */
  backlog: number;
}

/**
 * Pure: flow aggregate → at most ONE imbalance signal. Fires when the window's
 * inflow clears the volume bar AND inflow/outflow reaches the SLO ratio — the
 * audited "pouring capture into a drain under repair" pathology D-001 names.
 * kind=change per FB-18: the fix is a judgment call (raise consume capacity,
 * pause a capture source, tune the caps), not a clear correct state.
 */
export function flowSignalsFromAggregate(agg: FlowAggregate, opts: LearningSloOptions = {}): WatchdogSignal[] {
  const windowDays = opts.flowWindowDays ?? LEARNING_SLO_DEFAULTS.flowWindowDays;
  const minInflow = opts.flowMinInflow ?? LEARNING_SLO_DEFAULTS.flowMinInflow;
  const maxRatio = opts.flowMaxRatio ?? LEARNING_SLO_DEFAULTS.flowMaxRatio;
  if (agg.inflow < minInflow) return [];
  const ratio = agg.inflow / Math.max(1, agg.outflow);
  if (ratio < maxRatio) return [];
  return [{
    source: 'capture-consume-imbalance',
    key: 'improvements-flow',
    title: 'Improvements queue inflow is outrunning consumption',
    body:
      `Watchdog signal (capture-consume-imbalance): ${agg.inflow} improvement(s) captured vs ${agg.outflow} ` +
      `consumed (resolved/closed) in the last ${windowDays}d — ratio ${ratio.toFixed(1)}, at or past the ` +
      `${maxRatio}× SLO; the open backlog stands at ${agg.backlog}. This is the audited drain pathology the ` +
      `frontier program's D-001 arming gate exists to avoid: capture sources are outrunning the consume edge, ` +
      `so the queue accumulates instead of converting into fixes.`,
    severity: 'major',
    kind: 'change',
    findingClass: 'learning-slo:flow-imbalance',
  }];
}

/** capture-vs-consume: one aggregate pass over engineer_issues (organic-only, D-002). */
export async function collectFlowSignals(
  sql: Sql,
  workspaceId: string,
  opts: LearningSloOptions = {},
): Promise<WatchdogSignal[]> {
  const windowDays = opts.flowWindowDays ?? LEARNING_SLO_DEFAULTS.flowWindowDays;
  const rows = await sql<{ inflow: number; outflow: number; backlog: number }[]>`
    SELECT
      count(*) FILTER (WHERE created_at > now() - make_interval(days => ${windowDays}))::int AS inflow,
      count(*) FILTER (WHERE state <> 'open' AND updated_at > now() - make_interval(days => ${windowDays}))::int AS outflow,
      count(*) FILTER (WHERE state = 'open')::int AS backlog
      FROM harness_shared.engineer_issues
     WHERE workspace_id = ${workspaceId}
       AND COALESCE(signal_origin, 'organic') = 'organic'`;
  const r = rows[0];
  if (!r) return [];
  return flowSignalsFromAggregate(
    { inflow: Number(r.inflow), outflow: Number(r.outflow), backlog: Number(r.backlog) },
    opts,
  );
}

// ── MTTSH regression (the FB-20 read seam — dormant-tolerant) ────────────────

/** Heal-duration samples split into the two comparison windows (ms). */
export interface MttshWindows {
  recentMs: number[];
  baselineMs: number[];
}

/** Pure: median of a non-empty array. */
export function medianOf(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Pure: linear-interpolated quantile of a SORTED array (0 ≤ q ≤ 1). */
function quantileOfSorted(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0];
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Pure: drop values beyond the classic Tukey IQR fence (Q3 + 1.5×IQR) — the
 * standard robust-stats outlier exclusion, applied identically to whichever
 * window it's given (never hand-tuned per call). EI-8387: a handful of
 * red-queen drills landing during a REAL, independently-confirmed infra
 * incident (a shared PG/gateway hiccup that also slows the collector's own
 * query) produce multi-MINUTE detect times alongside a normal population of
 * sub-2s..90s drills — a raw median is not actually robust to this shape
 * (rank-13-of-26 still landed inside a genuinely-elevated tier), so it read
 * "the loop got slower" when the loop's own code was unchanged (verified: the
 * collector queries this drill class exercises ran in ~30ms against the live
 * DB at investigation time) and the true (non-incident) typical-case median
 * was WELL UNDER the SLO's own baseline. Trimming keeps the SLO measuring the
 * self-heal LOOP's code speed, not incidental external outages it is not
 * trying to detect (those have their own service-health/gateway watchdogs).
 * Never returns empty — an all-outlier input degrades to the untrimmed set.
 */
export function trimStatisticalOutliers(values: number[]): number[] {
  if (values.length < 4) return values; // too few for a meaningful IQR fence
  const s = [...values].sort((a, b) => a - b);
  const q1 = quantileOfSorted(s, 0.25);
  const q3 = quantileOfSorted(s, 0.75);
  const fence = q3 + 1.5 * (q3 - q1);
  const kept = s.filter((v) => v <= fence);
  return kept.length > 0 ? kept : s;
}

/**
 * Pure: windowed MTTSH samples → at most ONE regression signal. Fires when
 * BOTH windows hold ≥ minSamples healed drills AND the recent median has
 * regressed past baseline × factor. kind=change per FB-18: a slower heal
 * pipeline needs diagnosis (which stage regressed, why) — judgment-shaped.
 * EI-8387: each window's outliers are trimmed (Tukey IQR fence) BEFORE the
 * median, so a handful of incident-correlated extreme drills can't, by
 * themselves, manufacture a "regression" the loop's own code has nothing to
 * do with — see trimStatisticalOutliers.
 */
export function mttshSignalsFromWindows(w: MttshWindows, opts: LearningSloOptions = {}): WatchdogSignal[] {
  const minSamples = opts.mttshMinSamples ?? LEARNING_SLO_DEFAULTS.mttshMinSamples;
  const factor = opts.mttshMaxRegressionFactor ?? LEARNING_SLO_DEFAULTS.mttshMaxRegressionFactor;
  const recentDays = opts.mttshRecentDays ?? LEARNING_SLO_DEFAULTS.mttshRecentDays;
  if (w.recentMs.length < minSamples || w.baselineMs.length < minSamples) return [];
  const recent = medianOf(trimStatisticalOutliers(w.recentMs));
  const baseline = medianOf(trimStatisticalOutliers(w.baselineMs));
  if (baseline <= 0 || recent < baseline * factor) return [];
  const fmt = (ms: number): string => `${Math.round(ms / 1000)}s`;
  return [{
    source: 'mttsh-regression',
    key: 'mttsh',
    title: 'MTTSH regressed: the loop is healing planted frictions slower',
    body:
      `Watchdog signal (mttsh-regression): median time-to-self-heal over the last ${recentDays}d of ` +
      `red-queen drills is ${fmt(recent)} (${w.recentMs.length} drill(s)) vs a ${fmt(baseline)} baseline ` +
      `(${w.baselineMs.length} drill(s)) — ${(recent / baseline).toFixed(2)}×, at or past the ${factor}× SLO. ` +
      `Some stage of detect→triage→fix slowed down; the drill rows carry the per-stage timings for diagnosis.`,
    severity: 'major',
    kind: 'change',
    findingClass: 'learning-slo:mttsh-regression',
  }];
}

/**
 * THE FB-20 SEAM — the one function that knows red-queen's storage shape.
 * Reads heal-duration measurements from FB-20's drill store, split into the
 * recent/baseline windows. DORMANT-TOLERANT by contract:
 *   - store not landed (to_regclass null)  → `{ dormant: '…' }`, never an error;
 *   - store landed with a different shape  → `{ dormant: '…' }` carrying the
 *     error, visible in every tick record until this SELECT is updated;
 *   - no measured drills yet               → empty windows (the pure fn stays quiet).
 * Coordinated with FB-20 (su-19d66): table harness_shared.red_queen_drills
 * (migration 255), `mttsh_total_ms` (non-null = measured heal) + `resolved_at`,
 * aliased below to keep the window split generic. If red-queen's shape moves,
 * update ONLY this function.
 */
export async function readMttshSamples(
  sql: Sql,
  opts: LearningSloOptions = {},
): Promise<MttshWindows | { dormant: string }> {
  const recentDays = opts.mttshRecentDays ?? LEARNING_SLO_DEFAULTS.mttshRecentDays;
  const baselineDays = opts.mttshBaselineDays ?? LEARNING_SLO_DEFAULTS.mttshBaselineDays;
  const reg = await sql<{ t: string | null }[]>`SELECT to_regclass('harness_shared.red_queen_drills') AS t`;
  if (!reg[0]?.t) return { dormant: 'dormant: red-queen drill store not landed yet (FB-20 / frontier P-031)' };
  try {
    const rows = await sql<{ mttsh_ms: number | string; completed_at: string | Date }[]>`
      SELECT mttsh_total_ms AS mttsh_ms, resolved_at AS completed_at
        FROM harness_shared.red_queen_drills
       WHERE mttsh_total_ms IS NOT NULL
         AND resolved_at IS NOT NULL
         AND resolved_at > now() - make_interval(days => ${recentDays + baselineDays})
       ORDER BY resolved_at DESC
       LIMIT 2000`;
    const cutoffMs = Date.now() - recentDays * 86_400_000;
    const out: MttshWindows = { recentMs: [], baselineMs: [] };
    for (const r of rows) {
      const ms = Number(r.mttsh_ms);
      if (!Number.isFinite(ms) || ms < 0) continue;
      const at = r.completed_at instanceof Date ? r.completed_at.getTime() : Date.parse(String(r.completed_at));
      (Number.isFinite(at) && at >= cutoffMs ? out.recentMs : out.baselineMs).push(ms);
    }
    return out;
  } catch (e) {
    return {
      dormant:
        `dormant: red-queen drill store has an unexpected shape — update readMttshSamples (the FB-21↔FB-20 ` +
        `seam): ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ── governor budget starvation ───────────────────────────────────────────────

/**
 * Pure: governor registry rows → one signal per STARVED loop. Starved =
 * enabled, carrying an explicit lifetime budget, and spent down to (or past)
 * the floor — the D-004 preflight refuses every unattended run, so the loop
 * has silently stopped learning. Unbudgeted loops are deliberately EXCLUDED:
 * those are the dark-shipped frontier loops awaiting their P-001 budget
 * (already the governor summary's watch list, not a breach). kind=change per
 * FB-18: budgets are the owner's dial, never auto-raised.
 */
export function governorStarvationSignals(
  loops: readonly LearningLoopRegistration[],
  opts: LearningSloOptions = {},
  /**
   * Pots switched off at the master gate (learning-pot-scope-gate-2026-08-30
   * D-001). Their loops are EXCLUDED: a starvation signal asks the owner to
   * raise a budget, and asking that for a pot they deliberately switched off is
   * a false alarm — the loop has not "silently stopped learning", it was
   * stopped on purpose. Omitted ⇒ nothing excluded, the pre-gate behaviour.
   */
  disabledPots: ReadonlySet<string> = new Set(),
): WatchdogSignal[] {
  const floor = opts.governorStarvationFloorUsd ?? LEARNING_SLO_DEFAULTS.governorStarvationFloorUsd;
  const out: WatchdogSignal[] = [];
  for (const loop of loops) {
    if (!loop.enabled || loop.budgetUsd === null) continue;
    if (loop.potSlug && disabledPots.has(loop.potSlug)) continue;
    const verdict = checkLoopVerdict(loop, floor);
    if (verdict.reason !== 'exhausted') continue;
    out.push({
      source: 'governor-starvation',
      key: `starved:${loop.loopId}`,
      title: `Learning loop ${loop.loopId} is budget-starved`,
      body:
        `Watchdog signal (governor-starvation): loop "${loop.loopId}" (${loop.displayName}) is enabled with a ` +
        `lifetime budget of $${loop.budgetUsd.toFixed(2)} but has spent $${loop.spentUsd.toFixed(2)} — ` +
        `remaining $${(verdict.remainingUsd ?? 0).toFixed(2)} is at or under the $${floor.toFixed(2)} floor, so ` +
        `the learning governor refuses every unattended run (D-004). The loop has silently stopped learning; ` +
        `raising (or deliberately retiring) the budget is an owner act.`,
      severity: 'major',
      kind: 'change',
      findingClass: 'learning-slo:governor-starvation',
    });
  }
  return out;
}

/** governor-starvation: the registry read + the pure verdict pass. */
export async function collectGovernorStarvationSignals(
  sql: Sql,
  workspaceId: string,
  opts: LearningSloOptions = {},
): Promise<WatchdogSignal[]> {
  const loops = await listLearningLoops(sql, { workspaceId });
  const { disabledPotSlugs } = await import('../../learning/pot-gate/store');
  const disabled = new Set(await disabledPotSlugs(sql, { workspaceId }));
  return governorStarvationSignals(loops, opts, disabled);
}

// ── memory recall zero-hit spike ─────────────────────────────────────────────

export interface RecallRateAggregate {
  recentRecalls: number;
  recentZero: number;
  baselineRecalls: number;
  baselineZero: number;
  /**
   * EI-7774: median top_score over the recent window's NON-zero-hit recalls
   * (null/undefined when unavailable — a caller on an older query shape, or a
   * window with no non-zero recalls to take a median of). Optional and
   * backward-compatible: omitting both P50 fields falls back to the pre-
   * EI-7774 rate-only behavior below.
   */
  recentTopScoreP50?: number | null;
  /** Median top_score over the baseline window's non-zero-hit recalls. */
  baselineTopScoreP50?: number | null;
  /**
   * P-036: the score SCALE both P50s above were computed on. The two must come
   * from the SAME scale or the comparison is meaningless — see the collector.
   * Null/undefined when no scale had usable data in both windows.
   */
  topScoreScale?: string | null;
}

/**
 * Pure: recall-rate aggregate → at most ONE spike signal. Fires when the
 * recent window holds ≥ minRecalls AND its zero-hit rate reaches the absolute
 * SLO rate AND (when a baseline of ≥ minRecalls exists) the rate has spiked
 * to ≥ baseline × factor — "no relevant memory" stays a healthy zero; a rate
 * jump against the system's own history is the EI-366 index-degradation
 * class. kind=bug per FB-18: the correct state is the baseline rate and the
 * stats table makes it regression-testable.
 *
 * EI-7774: a rate spike ALONE cannot distinguish that degradation class from
 * a healthy burst of cold-pool/novel queries (which also zero-hit at a higher
 * rate, but whose recalls that DID hit score normally). So when BOTH windows
 * carry a usable top-score P50 (from recalls that hit), also require the
 * recent P50 to have dropped to ≤ baseline × memoryZeroHitTopScoreDropFactor
 * — the actual EI-366 signature — before firing. Missing/null P50 data (an
 * older caller, or a window with zero non-zero-hit recalls to median) falls
 * back to the original rate-only gate unchanged.
 */
export function memoryZeroHitSignalsFromAggregate(
  agg: RecallRateAggregate,
  opts: LearningSloOptions = {},
): WatchdogSignal[] {
  const minRecalls = opts.memoryZeroHitMinRecalls ?? LEARNING_SLO_DEFAULTS.memoryZeroHitMinRecalls;
  const maxRate = opts.memoryZeroHitMaxRate ?? LEARNING_SLO_DEFAULTS.memoryZeroHitMaxRate;
  const factor = opts.memoryZeroHitSpikeFactor ?? LEARNING_SLO_DEFAULTS.memoryZeroHitSpikeFactor;
  const scoreDropFactor = opts.memoryZeroHitTopScoreDropFactor ?? LEARNING_SLO_DEFAULTS.memoryZeroHitTopScoreDropFactor;
  const recentHours = opts.memoryZeroHitRecentHours ?? LEARNING_SLO_DEFAULTS.memoryZeroHitRecentHours;
  const baselineDays = opts.memoryZeroHitBaselineDays ?? LEARNING_SLO_DEFAULTS.memoryZeroHitBaselineDays;
  if (agg.recentRecalls < minRecalls) return [];
  const rate = agg.recentZero / agg.recentRecalls;
  if (rate < maxRate) return [];
  const hasBaseline = agg.baselineRecalls >= minRecalls;
  const baseRate = hasBaseline ? agg.baselineZero / agg.baselineRecalls : null;
  if (baseRate !== null && rate < baseRate * factor) return [];
  // EI-7774: both P50s present AND the recent one has NOT materially
  // dropped ⇒ the recalls that hit still score normally — a healthy zero
  // burst, not index degradation. Stay quiet.
  const recentP50 = agg.recentTopScoreP50;
  const baseP50 = agg.baselineTopScoreP50;
  const hasScoreData = recentP50 != null && baseP50 != null && baseP50 > 0;
  const scoreCollapsed = hasScoreData ? recentP50! <= baseP50! * scoreDropFactor : null;
  if (hasScoreData && !scoreCollapsed) return [];
  const pct = (x: number): string => `${Math.round(x * 100)}%`;
  return [{
    source: 'memory-zero-hit',
    key: 'recall-zero-hit-rate',
    title: 'Memory recall zero-hit rate spiked',
    body:
      `Watchdog signal (memory-zero-hit): ${pct(rate)} of the ${agg.recentRecalls} memory recalls in the last ` +
      `${recentHours}h returned NOTHING` +
      (baseRate !== null
        ? ` — vs a ${pct(baseRate)} baseline over the prior ${baselineDays}d (${agg.baselineRecalls} recalls), ` +
          `a ${(rate / Math.max(baseRate, 0.001)).toFixed(1)}× spike`
        : ` (no usable baseline window — the absolute ${pct(maxRate)} SLO fired)`) +
      (hasScoreData
        ? ` — AND the non-zero recalls' top-score P50 also collapsed: ${recentP50!.toFixed(3)} vs a ` +
          `${baseP50!.toFixed(3)} baseline (${(recentP50! / Math.max(baseP50!, 0.001)).toFixed(2)}×)` +
          (agg.topScoreScale ? ` [${agg.topScoreScale} scale]` : '')
        : '') +
      `. A spike against the system's own history means index degradation, not "no relevant memory" ` +
      `(the EI-366 class B-10's memory_recall_stats telemetry exists to catch).`,
    severity: 'major',
    kind: 'bug',
    findingClass: 'learning-slo:recall-degradation',
    paths: ['packages/operator-core/lib/memory/recall-stats.ts'],
  }];
}

/**
 * memory-zero-hit: one aggregate pass over memory_recall_stats (B-10 /
 * consume-edges P-031, mig 240). The table has no workspace column — this
 * collector is inherently BOX-GLOBAL (the red-test P-013 stance): acceptable
 * on a one-box install; the cross-host tick lock + key dedup bound it to one
 * filed item regardless.
 */
export async function collectMemoryZeroHitSignals(sql: Sql, opts: LearningSloOptions = {}): Promise<WatchdogSignal[]> {
  const recentHours = opts.memoryZeroHitRecentHours ?? LEARNING_SLO_DEFAULTS.memoryZeroHitRecentHours;
  const baselineDays = opts.memoryZeroHitBaselineDays ?? LEARNING_SLO_DEFAULTS.memoryZeroHitBaselineDays;
  // EI-7774: also median the NON-zero-hit top_score in each window (NULL on
  // zero hits, so the FILTER + percentile_cont naturally excludes them) —
  // the signature that distinguishes a healthy cold-query zero burst from
  // real EI-366 index degradation (see memoryZeroHitSignalsFromAggregate).
  //
  // ⚠ P-036: the two medians MUST be taken on the SAME score scale, so they are
  // computed PER SCALE and paired below. A single blended median across the
  // window compares nothing: rrf tops out at 0.033 while cosine starts at 0.50,
  // so if the workload mix shifts between the windows — more push-path recalls
  // in the recent one, say — the median "collapses" by ~25x with retrieval
  // completely unchanged. That would satisfy the score-collapse condition this
  // guard exists to REQUIRE, converting an EI-7774 false-alarm SUPPRESSOR into
  // a false-alarm ENABLER, and firing exactly the spurious critical D-001 had
  // to retract. Rows whose scale cannot be established are excluded outright.
  const rows = await sql<
    {
      recent_recalls: number;
      recent_zero: number;
      base_recalls: number;
      base_zero: number;
      per_scale: Array<{ scale: string; recent_n: number; recent_p50: number | null; base_n: number; base_p50: number | null }>;
    }[]
  >`
    WITH scoped AS (
      SELECT hit_count,
             top_score,
             (created_at > now() - make_interval(hours => ${recentHours})) AS is_recent,
             CASE
               WHEN score_scale IS NOT NULL THEN score_scale
               WHEN top_score IS NULL THEN 'unknown'
               WHEN top_score <= ${RRF_SCORE_CEILING} THEN 'rrf'
               WHEN top_score >= ${COSINE_ADMISSION_FLOOR} THEN 'cosine'
               ELSE 'unknown'
             END AS scale
        FROM harness_shared.memory_recall_stats
       WHERE created_at > now() - make_interval(hours => ${recentHours}) - make_interval(days => ${baselineDays})
    )
    SELECT
      count(*) FILTER (WHERE is_recent)::int                        AS recent_recalls,
      count(*) FILTER (WHERE is_recent AND hit_count = 0)::int      AS recent_zero,
      count(*) FILTER (WHERE NOT is_recent)::int                    AS base_recalls,
      count(*) FILTER (WHERE NOT is_recent AND hit_count = 0)::int  AS base_zero,
      (SELECT coalesce(jsonb_agg(x), '[]'::jsonb) FROM (
         SELECT scale,
                count(*) FILTER (WHERE is_recent AND top_score IS NOT NULL)::int AS recent_n,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY top_score)
                  FILTER (WHERE is_recent AND top_score IS NOT NULL)             AS recent_p50,
                count(*) FILTER (WHERE NOT is_recent AND top_score IS NOT NULL)::int AS base_n,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY top_score)
                  FILTER (WHERE NOT is_recent AND top_score IS NOT NULL)         AS base_p50
           FROM scoped
          WHERE scale <> 'unknown'
          GROUP BY scale
       ) x)                                                         AS per_scale
    FROM scoped`;
  const r = rows[0];
  if (!r) return [];
  // Pair on the scale best represented in the RECENT window that also has
  // baseline data. A scale present in only one window yields no comparison at
  // all (rather than a cross-scale one), which correctly falls back to the
  // pre-EI-7774 rate-only gate.
  const paired = (Array.isArray(r.per_scale) ? r.per_scale : [])
    .filter(
      (s) =>
        // 'unknown' is INDETERMINATE, not a scale — pairing it would be the
        // mixing bug wearing a label. The SQL already excludes it; this second
        // guard means a future query edit cannot quietly reintroduce it.
        String(s.scale) !== 'unknown' &&
        Number(s.recent_n) > 0 &&
        Number(s.base_n) > 0 &&
        s.recent_p50 != null &&
        s.base_p50 != null,
    )
    .sort((a, b) => Number(b.recent_n) - Number(a.recent_n))[0];
  return memoryZeroHitSignalsFromAggregate(
    {
      recentRecalls: Number(r.recent_recalls),
      recentZero: Number(r.recent_zero),
      baselineRecalls: Number(r.base_recalls),
      baselineZero: Number(r.base_zero),
      recentTopScoreP50: paired ? Number(paired.recent_p50) : null,
      baselineTopScoreP50: paired ? Number(paired.base_p50) : null,
      topScoreScale: paired ? String(paired.scale) : null,
    },
    opts,
  );
}

// ── the five collector entry points (defaultPapercuspCollectors wiring) ──────

/** triage-entropy collector (flag-gated; D-001 dark note while OFF). */
export async function triageEntropyCollector(
  workspaceId: string,
  opts: LearningSloOptions = {},
  deps: LearningSloDeps = defaultDeps,
): Promise<CollectorResult> {
  const dark = await darkOrNull(deps);
  if (dark) return dark;
  return { signals: await collectTriageEntropySignals(deps.sql(), workspaceId, opts) };
}

/** capture-vs-consume flow collector (flag-gated). */
export async function captureConsumeFlowCollector(
  workspaceId: string,
  opts: LearningSloOptions = {},
  deps: LearningSloDeps = defaultDeps,
): Promise<CollectorResult> {
  const dark = await darkOrNull(deps);
  if (dark) return dark;
  return { signals: await collectFlowSignals(deps.sql(), workspaceId, opts) };
}

/** MTTSH-regression collector (flag-gated; dormant-tolerant — see readMttshSamples). */
export async function mttshRegressionCollector(
  opts: LearningSloOptions = {},
  deps: LearningSloDeps = defaultDeps,
): Promise<CollectorResult> {
  const dark = await darkOrNull(deps);
  if (dark) return dark;
  const samples = await readMttshSamples(deps.sql(), opts);
  if ('dormant' in samples) return { signals: [], note: samples.dormant };
  return { signals: mttshSignalsFromWindows(samples, opts) };
}

/** governor-starvation collector (flag-gated). */
export async function governorStarvationCollector(
  workspaceId: string,
  opts: LearningSloOptions = {},
  deps: LearningSloDeps = defaultDeps,
): Promise<CollectorResult> {
  const dark = await darkOrNull(deps);
  if (dark) return dark;
  return { signals: await collectGovernorStarvationSignals(deps.sql(), workspaceId, opts) };
}

/** memory zero-hit collector (flag-gated; box-global — see collectMemoryZeroHitSignals). */
export async function memoryZeroHitCollector(
  opts: LearningSloOptions = {},
  deps: LearningSloDeps = defaultDeps,
): Promise<CollectorResult> {
  const dark = await darkOrNull(deps);
  if (dark) return dark;
  return { signals: await collectMemoryZeroHitSignals(deps.sql(), opts) };
}

// ── memory recall PER-POOL degradation ───────────────────────────────────────
// context-injection-audit-2026-07-28 P-013 (D-023 / D-024).
//
// WHY THIS EXISTS ALONGSIDE memory-zero-hit, rather than replacing it: that
// collector is BOX-GLOBAL and BLENDED — one aggregate over the whole table. The
// push path concatenates three independently-budgeted pools (user / harness /
// hive) before the row is recorded, so a pool contributing NOTHING on every
// single call is arithmetically invisible there as long as its siblings fill the
// block. Measured live while writing this (7d): the `claim` surface reported a
// 0.0% zero-hit rate while its `user` pool returned nothing on 18 of 18 recalls.
// The blended detector cannot fire on that and never will.
//
// `readRecallHealthByPool` already computes exactly these two rates and has
// carried the two detectors in its own doc comments since P-026 — with no
// non-test caller. This is the read side being wired to the alarm side; it adds
// no new alert system, no new flag, and no new SQL.
//
// ⚠ WHAT THIS DOES **NOT** MEASURE, and why (D-023). P-013 originally specified
// "% below the configured floor". That is unbuildable from recorded data, not
// merely unbuilt: the 0.45 cosine floor is an ADMISSION predicate applied inside
// backend.search() BEFORE fusion, and hybrid-fusion.ts then returns `{ ...e,
// score }` with the fused RRF value — destroying the component cosine. So a
// recorded push `top_score` carries no cosine information at all: comparing it
// to 0.45 yields 100% "below floor" forever (RRF ≤ 2/61), which is precisely the
// unit error D-001 had to retract. Both rates below are COUNTS, not scores, so
// they are immune to that class by construction.
//
// ⚠ SCALE IS DELIBERATELY NOT FILTERED HERE, and that is not an oversight. Rows
// are grouped per scale upstream, and a row whose scale is indeterminate is
// tagged 'unknown'. Excluding 'unknown' is correct for a SCORE comparison and
// actively wrong for these RATE comparisons: a legacy zero-hit row has
// top_score IS NULL, which classifies as 'unknown' — so a scale filter would
// delete exactly the starved-pool rows this detector exists to find. Rates are
// scale-free; only scores are not.

/** Longest offender list rendered into a signal body. */
const RECALL_POOL_BODY_SAMPLES = 8;

function ratePct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** `surface/pool [scale]` — the slice identity, stable for a body line. */
function poolLabel(p: RecallPoolHealth): string {
  return `${p.surface}/${p.pool} [${p.scoreScale}]`;
}

/**
 * Gate-2's zero-hit bar for ONE pool, scaled by how big that pool's corpus is
 * (EI-20878926803436140). Pure and exported so the controls below can pin the
 * curve directly rather than inferring it from a signal's presence.
 *
 * THE CONFOUND: `zeroHitRate` measures "how often did this pool contribute
 * nothing", which mixes two independent causes — the pool is UNREACHABLE (the
 * defect), or the asking surface's query is SPECIFIC and the corpus is small
 * (perfectly healthy). Holding corpus and scope constant, one 58-memory scope
 * measured 0.000 zero-hit on `initialize` and 0.874 on `mid-turn`. A flat bar
 * cannot separate those, and at 0.85 it lands inside the healthy band for
 * every small pool on this box.
 *
 * THE FIX: make the bar a function of corpus size, because corpus size is
 * exactly what decides whether sparsity is a sufficient explanation. Below
 * ~100 active memories a near-total miss rate is ordinary, so only a blackout
 * (≥0.97) is evidence; above ~500 sparsity can no longer explain it and the
 * flat 0.85 stands. Linear in between, so no pool sits on a cliff edge.
 *
 * ⛔ DO NOT replace this with the tempting alternative — "suppress when the
 * same SCOPE reads healthy on some OTHER surface". It looks equivalent and it
 * is not: it would have silenced the documented 2026-08-01 true positive
 * (`initialize/harness`, 54/54 zero-hit against a real 1,975-memory scope)
 * because `mid-turn/harness` was answering normally on that very scope at that
 * very time. Cross-surface reachability proves the KEY is live; it says
 * nothing about whether THIS surface's pool is wired up. See the
 * `emptyScopeRate` docstring in recall-stats.ts for that incident's record.
 *
 * A `null`/unknown corpus returns the flat bar unchanged, so a caller that
 * predates the column behaves exactly as it did before.
 */
export function effectiveZeroHitGate(
  corpusActive: number | null | undefined,
  opts: LearningSloOptions = {},
): number {
  const maxZero = opts.recallPoolMaxZeroHitRate ?? LEARNING_SLO_DEFAULTS.recallPoolMaxZeroHitRate;
  const smallCorpus = opts.recallPoolSmallCorpus ?? LEARNING_SLO_DEFAULTS.recallPoolSmallCorpus;
  const largeCorpus = opts.recallPoolLargeCorpus ?? LEARNING_SLO_DEFAULTS.recallPoolLargeCorpus;
  const smallMax =
    opts.recallPoolSmallCorpusMaxZeroHitRate ?? LEARNING_SLO_DEFAULTS.recallPoolSmallCorpusMaxZeroHitRate;
  // Unknown corpus ⇒ pre-column behavior, never a silently-relaxed gate.
  if (corpusActive == null || !Number.isFinite(corpusActive)) return maxZero;
  // Degenerate/inverted tuning must fail toward the STRICTER flat bar: a
  // misconfigured knob should over-report, never blind the detector.
  if (!(smallMax > maxZero) || !(largeCorpus > smallCorpus)) return maxZero;
  if (corpusActive >= largeCorpus) return maxZero;
  if (corpusActive <= smallCorpus) return smallMax;
  const t = (corpusActive - smallCorpus) / (largeCorpus - smallCorpus);
  return smallMax - t * (smallMax - maxZero);
}

/**
 * Pure: the per-pool aggregate (+ the per-surface aggregate, used ONLY to
 * annotate the contrast) → at most one starvation signal and one saturation
 * signal.
 *
 * `surfaces` is annotation, never a gate: it supplies each offending pool's
 * BLENDED surface zero-hit rate so the finding carries its own proof that the
 * surface-level number could not have caught this. A caller with no surface data
 * still gets correct signals, just without the contrast clause.
 *
 * `recentPools` (WI-6932) is the SAME per-pool shape computed over a much
 * shorter, RECENT window (`recallPoolEmptyScopeRecentHours`, default 24h)
 * instead of the full `recallPoolWindowDays` trailing week — the gate-3
 * (empty-scope) recency check. Optional and backward-compatible: omitting it
 * (or passing `[]`) falls all the way back to the pre-WI-6932 flat-window
 * gate-3 behavior, so every existing caller/test is unaffected.
 */
export function recallPoolSignalsFromHealth(
  pools: readonly RecallPoolHealth[],
  surfaces: readonly RecallSurfaceHealth[] = [],
  opts: LearningSloOptions = {},
  recentPools: readonly RecallPoolHealth[] = [],
): WatchdogSignal[] {
  const minRecalls = opts.recallPoolMinRecalls ?? LEARNING_SLO_DEFAULTS.recallPoolMinRecalls;
  const maxZero = opts.recallPoolMaxZeroHitRate ?? LEARNING_SLO_DEFAULTS.recallPoolMaxZeroHitRate;
  const maxSat = opts.recallPoolMaxSaturationRate ?? LEARNING_SLO_DEFAULTS.recallPoolMaxSaturationRate;
  const maxEmptyScope = opts.recallPoolMaxEmptyScopeRate ?? LEARNING_SLO_DEFAULTS.recallPoolMaxEmptyScopeRate;
  const windowDays = opts.recallPoolWindowDays ?? LEARNING_SLO_DEFAULTS.recallPoolWindowDays;
  const recentHours =
    opts.recallPoolEmptyScopeRecentHours ?? LEARNING_SLO_DEFAULTS.recallPoolEmptyScopeRecentHours;

  // Underpowered slices are not evidence. No scale filter — see the module note.
  const eligible = pools.filter((p) => p.recalls >= minRecalls);
  if (eligible.length === 0) return [];

  const surfaceZeroRate = new Map<string, number>();
  for (const s of surfaces) {
    // A surface appears once; if a caller passes duplicates, the busiest wins.
    const prior = surfaceZeroRate.get(s.surface);
    if (prior === undefined) surfaceZeroRate.set(s.surface, s.zeroHitRate7d);
  }

  const signals: WatchdogSignal[] = [];

  // gate-2: the bar is PER POOL, scaled by corpus size — see
  // effectiveZeroHitGate. A flat `maxZero` here fired on healthy small pools
  // asked specific questions, which is how a false alarm held a CRITICAL item
  // for 11 days (EI-20878926803436140).
  const starved = eligible
    .filter((p) => p.zeroHitRate >= effectiveZeroHitGate(p.corpusActive, opts))
    .sort((a, b) => b.zeroHitRate - a.zeroHitRate || b.recalls - a.recalls);
  if (starved.length > 0) {
    const lines = starved.slice(0, RECALL_POOL_BODY_SAMPLES).map((p) => {
      const blended = surfaceZeroRate.get(p.surface);
      const contrast =
        blended === undefined
          ? ''
          : ` — while the BLENDED ${p.surface} surface reads ${ratePct(blended)} zero-hit`;
      const scopes = p.scopes.length > 0 ? ` scopes=[${p.scopes.slice(0, 4).join(', ')}]` : '';
      // D-035: name the REMEDY, not just the symptom. A starved pool that was
      // also asked under an empty scope was never queried at all (fix the
      // caller); one starved at 0% empty-scope was asked correctly and still
      // returned nothing (fix the scope key or the corpus). Reporting the
      // zero-hit rate alone leaves the reader to guess between two opposite
      // fixes — which is exactly how this class stayed open across three ships.
      const asked =
        p.emptyScopeRate >= 0.5
          ? ` ⚠ but ${ratePct(p.emptyScopeRate)} of those recalls asked it under an EMPTY scope — ` +
            `it was largely never queried; fix the CALLER, not the corpus.`
          : p.emptyScope === 0
            ? ` (asked under a real scope every time — this is a genuine miss, not an unscoped call.)`
            : ` (${ratePct(p.emptyScopeRate)} of these asked under an empty scope.)`;
      // Report the corpus AND the bar it earned: without them a reader cannot
      // tell a starved pool from a small one, which is the exact mistake this
      // gate made for 11 days.
      const corpus =
        p.corpusActive == null
          ? ' corpus=unknown'
          : ` corpus=${Math.round(p.corpusActive)} active (bar ${ratePct(effectiveZeroHitGate(p.corpusActive, opts))})`;
      return `  • ${poolLabel(p)}: returned nothing on ${p.zeroHit}/${p.recalls} recalls ` +
        `(${ratePct(p.zeroHitRate)})${contrast}.${corpus}.${scopes}${asked}`;
    });
    signals.push({
      source: 'memory-recall-pool',
      key: 'recall-pool-starved',
      title: 'Memory recall: an injection pool returns nothing on nearly every call',
      body:
        `Watchdog signal (memory-recall-pool, gate-2): over the last ${windowDays}d, ` +
        `${starved.length} injection pool(s) with at least ${minRecalls} recalls returned NOTHING on ` +
        `more of the recalls they took part in than their own corpus size can explain ` +
        `(bar: ${ratePct(maxZero)} for a large corpus, rising toward ` +
        `${ratePct(opts.recallPoolSmallCorpusMaxZeroHitRate ?? LEARNING_SLO_DEFAULTS.recallPoolSmallCorpusMaxZeroHitRate)} ` +
        `for a small one — a sparse pool asked a specific question misses often and is FINE):\n` +
        lines.join('\n') +
        (starved.length > RECALL_POOL_BODY_SAMPLES
          ? `\n  … and ${starved.length - RECALL_POOL_BODY_SAMPLES} more.`
          : '') +
        `\n\nA pool at or near 1.0 is the unmigrated-scope signature: it is being queried under a ` +
        `scope key nothing writes to, so it contributes nothing to the injected block while its ` +
        `sibling pools fill the space. This is invisible to the blended memory-zero-hit SLO by ` +
        `construction — that detector aggregates the whole table, and a surface whose other pools ` +
        `answer normally reports a healthy zero-hit rate throughout. Check the scope keys above ` +
        `against what the writers actually key on before assuming the pool is merely empty.`,
      severity: 'major',
      kind: 'bug',
      findingClass: 'learning-slo:recall-degradation',
      paths: ['packages/operator-core/lib/memory/recall-stats.ts', 'packages/operator-core/lib/memory/injection.ts'],
    });
  }

  // gate-3 (D-035): asked under NO scope. Reported SEPARATELY from starvation
  // even where both fire on the same pool — they are different defects with
  // opposite remedies, and collapsing them is what made this class survive
  // three ships. Crucially it also fires where gate-2 CANNOT: a pool asked
  // unscoped 69% of the time has a 69% zero-hit rate, comfortably under the
  // 0.85 starvation gate, so nothing in this file could see it before.
  //
  // WI-6932: a flat `windowDays` trailing RATE cannot express "this WAS
  // broken and no longer is" — a pool fixed by a sharp step-function change
  // keeps breaching the gate for the full window while the pre-fix rows age
  // out (measured: D-035 landed 02:00Z, empty-scope 0.495→0.000 in 1h and
  // held at 0.000 for 4h across 4,434 recalls, yet the 7d rate stayed
  // 0.27–0.37 — a false critical against already-shipped work, refiled every
  // tick for ~a week). So before trusting the flat-window candidate list,
  // check `recentPools` (the SAME shape over `recallPoolEmptyScopeRecentHours`,
  // default 24h): a pool with enough RECENT recalls to trust its own rate
  // (>= minRecalls) is judged on that recent rate instead — clean recent data
  // suppresses the finding as likely-already-fixed; still-dirty recent data
  // still fires, now WITH the trend visible in the body. A pool with too few
  // recent recalls to trust (quiet pool, or no recentPools passed at all —
  // the pre-WI-6932 pure-function callers) falls back to the flat-window
  // verdict unchanged.
  const recentByKey = new Map<string, RecallPoolHealth>();
  for (const r of recentPools) {
    recentByKey.set(`${r.surface} ${r.pool} ${r.scoreScale}`, r);
  }
  const emptyScopeCandidates = eligible.filter((p) => p.emptyScopeRate >= maxEmptyScope);
  let suppressedAsFixed = 0;
  const unscoped = emptyScopeCandidates
    .filter((p) => {
      const recent = recentByKey.get(`${p.surface} ${p.pool} ${p.scoreScale}`);
      if (!recent || recent.recalls < minRecalls) return true; // no trustworthy recent signal — old behavior
      if (recent.emptyScopeRate < maxEmptyScope) {
        suppressedAsFixed += 1;
        return false; // clean over the recent window — likely already fixed
      }
      return true; // still breaching recently too — genuinely still broken
    })
    .sort((a, b) => b.emptyScopeRate - a.emptyScopeRate || b.recalls - a.recalls);
  if (unscoped.length > 0) {
    const lines = unscoped.slice(0, RECALL_POOL_BODY_SAMPLES).map((p) => {
      const poolGate = effectiveZeroHitGate(p.corpusActive, opts);
      const alsoStarved = p.zeroHitRate >= poolGate ? '' : ` — and its ${ratePct(p.zeroHitRate)} zero-hit rate is ` +
        `UNDER the ${ratePct(poolGate)} starvation gate it earned for its corpus, so gate-2 cannot see this`;
      const recent = recentByKey.get(`${p.surface} ${p.pool} ${p.scoreScale}`);
      const trend = recent && recent.recalls >= minRecalls
        ? ` (still ${ratePct(recent.emptyScopeRate)} over the last ${recentHours}h — not a stale-window artifact)`
        : '';
      return `  • ${poolLabel(p)}: asked under an EMPTY scope on ${p.emptyScope}/${p.recalls} recalls ` +
        `(${ratePct(p.emptyScopeRate)})${trend}${alsoStarved}.`;
    });
    signals.push({
      source: 'memory-recall-pool',
      key: 'recall-pool-empty-scope',
      title: 'Memory recall: an injection pool is being queried with no scope at all',
      body:
        `Watchdog signal (memory-recall-pool, gate-3): over the last ${windowDays}d, ` +
        `${unscoped.length} injection pool(s) with at least ${minRecalls} recalls were asked under an ` +
        `EMPTY scope list on at least ${ratePct(maxEmptyScope)} of the recalls they took part in:\n` +
        lines.join('\n') +
        (suppressedAsFixed > 0
          ? `\n\n(${suppressedAsFixed} other pool(s) also breached the ${windowDays}d rate but were suppressed ` +
            `here — their last ${recentHours}h reads clean, below ${ratePct(maxEmptyScope)}: likely already fixed, ` +
            `still aging out of the trailing window. WI-6932.)`
          : '') +
        (unscoped.length > RECALL_POOL_BODY_SAMPLES
          ? `\n  … and ${unscoped.length - RECALL_POOL_BODY_SAMPLES} more.`
          : '') +
        `\n\nAn empty scope means the pool was never actually QUERIED — the caller reached the recall ` +
        `without resolving the scope it should have asked under, so the pool contributes nothing and ` +
        `its siblings silently fill the budget. This is a CALLER defect, and it is invisible to every ` +
        `hit-count aggregate: "returned nothing because it was asked for nothing" and "was asked ` +
        `correctly and genuinely held nothing" are the same number in hit_count, with opposite fixes. ` +
        `Trace the surface's scope resolution before touching the corpus or the scope keys.`,
      severity: 'major',
      kind: 'bug',
      findingClass: 'learning-slo:recall-degradation',
      paths: ['packages/operator-core/lib/memory/injection.ts', 'packages/operator-core/lib/memory/recall-stats.ts'],
    });
  }

  const saturated = eligible
    .filter((p) => p.saturationRate >= maxSat)
    .sort((a, b) => b.saturationRate - a.saturationRate || b.recalls - a.recalls);
  if (saturated.length > 0) {
    const lines = saturated.slice(0, RECALL_POOL_BODY_SAMPLES).map(
      (p) =>
        `  • ${poolLabel(p)}: filled its budget on ${p.saturated}/${p.recalls} recalls ` +
        `(${ratePct(p.saturationRate)}), median ${p.hitsP50 ?? 'n/a'} hits.`,
    );
    signals.push({
      source: 'memory-recall-pool',
      key: 'recall-pool-saturated',
      title: 'Memory recall: an injection pool fills its budget on nearly every call',
      body:
        `Watchdog signal (memory-recall-pool, gate-4): over the last ${windowDays}d, ` +
        `${saturated.length} injection pool(s) with at least ${minRecalls} recalls returned EXACTLY ` +
        `their own recorded budget on at least ${ratePct(maxSat)} of their recalls:\n` +
        lines.join('\n') +
        (saturated.length > RECALL_POOL_BODY_SAMPLES
          ? `\n  … and ${saturated.length - RECALL_POOL_BODY_SAMPLES} more.`
          : '') +
        `\n\nA pool that almost always returns exactly its limit is not answering "what is relevant", ` +
        `it is answering "what is the limit" — the block is sized by K rather than by relevance. ` +
        `The comparison is against the budget recorded ON EACH ROW, so it stays honest across ` +
        `budget retunes. Note this is a BUDGET/admission finding, not a score finding: it says ` +
        `nothing about how relevant the returned entries were (D-023 — a push-path top_score is a ` +
        `post-fusion RRF rank and cannot express relevance).`,
      severity: 'major',
      kind: 'bug',
      findingClass: 'learning-slo:recall-degradation',
      paths: ['packages/operator-core/lib/memory/recall-stats.ts', 'packages/operator-core/lib/memory/injection.ts'],
    });
  }

  return signals;
}

/**
 * recall-pool: two aggregate passes over memory_recall_stats — the per-pool
 * breakdown (the detector) and the per-surface roll-up (the contrast clause).
 * Both are existing readers; nothing new is queried.
 *
 * BOX-GLOBAL, like its memory-zero-hit sibling: the table interleaves every
 * workspace on the host, so findings are operator-scoped (the default) rather
 * than harness-scoped, and the cross-host tick lock + key dedup bound this to
 * one filed item per class regardless.
 *
 * Rows written before migration 703 carry `pools IS NULL` and are excluded
 * upstream, so this reports honestly-smaller counts until the window rolls past
 * that deploy — which is why `recallPoolMinRecalls` gates on the slice's own
 * recall count rather than on wall-clock coverage.
 */
export async function collectRecallPoolSignals(
  sql: Sql,
  opts: LearningSloOptions = {},
): Promise<WatchdogSignal[]> {
  const days = opts.recallPoolWindowDays ?? LEARNING_SLO_DEFAULTS.recallPoolWindowDays;
  const recentHours =
    opts.recallPoolEmptyScopeRecentHours ?? LEARNING_SLO_DEFAULTS.recallPoolEmptyScopeRecentHours;
  const pools = await readRecallHealthByPool(sql, { days });
  if (pools.length === 0) return [];
  // Annotation only — a failure here must not suppress a real starvation
  // finding, so the contrast clause degrades to absent rather than throwing.
  let surfaces: RecallSurfaceHealth[] = [];
  try {
    surfaces = await readRecallHealthBySurface(sql);
  } catch {
    surfaces = [];
  }
  // WI-6932: the gate-3 recency check. Read-only annotation input to the pure
  // gate below, same posture as `surfaces` above — a failure here must not
  // suppress OR falsely-clear a real finding, so it degrades to `[]` (which
  // recallPoolSignalsFromHealth treats as "no recent signal available" and
  // falls back to the pre-WI-6932 flat-window verdict) rather than throwing.
  let recentPools: RecallPoolHealth[] = [];
  try {
    recentPools = await readRecallHealthByPool(sql, { hours: recentHours });
  } catch {
    recentPools = [];
  }
  return recallPoolSignalsFromHealth(pools, surfaces, opts, recentPools);
}

export async function recallPoolCollector(
  opts: LearningSloOptions = {},
  deps: LearningSloDeps = defaultDeps,
): Promise<CollectorResult> {
  const dark = await darkOrNull(deps);
  if (dark) return dark;
  return { signals: await collectRecallPoolSignals(deps.sql(), opts) };
}

// ── memory recall SCORE-SCALE integrity ──────────────────────────────────────
// context-injection-audit-2026-07-28 P-037 (F-G), gate-5.
//
// The score-side alarm P-037 asks for, in the only form that is sound. Its
// design rationale — and why the two tempting alternatives (an absolute
// threshold; an "unlabelled rate") are the D-001 error and a measured
// false-positive respectively — lives on `readRecallScaleContradictions`.
//
// This is the F-F discriminator being ENFORCED rather than merely recorded.
// Every scale-aware reader in this file and in recall-stats.ts trusts
// `score_scale` to mean what it says; nothing has ever checked that it does.

/** Pure: contradiction rows → at most one signal. */
export function recallScaleSignalsFromContradictions(
  contradictions: readonly RecallScaleContradiction[],
  opts: LearningSloOptions = {},
): WatchdogSignal[] {
  const windowDays = opts.recallPoolWindowDays ?? LEARNING_SLO_DEFAULTS.recallPoolWindowDays;
  // No rate threshold and no minimum sample, deliberately: unlike the rate SLOs
  // above, a single contradicting row is not noise that needs a floor to
  // suppress — it is arithmetically impossible for the scale it claims, so it
  // is either a writer bug or a constant retune nobody propagated. Both need a
  // human. The reader already returns only surfaces with at least one.
  if (contradictions.length === 0) return [];
  const lines = contradictions.slice(0, RECALL_POOL_BODY_SAMPLES).map((c) => {
    const bound =
      c.declaredScale === 'rrf'
        ? `above the rrf ceiling ${RRF_SCORE_CEILING.toFixed(6)}`
        : `below the cosine admission floor ${COSINE_ADMISSION_FLOOR}`;
    const range =
      c.minOffending === null || c.maxOffending === null
        ? ''
        : ` (offending values ${c.minOffending.toFixed(6)}…${c.maxOffending.toFixed(6)})`;
    return `  • ${c.surface} declared '${c.declaredScale}': ${c.contradicting}/${c.rows} rows ` +
      `(${ratePct(c.contradictionRate)}) sit ${bound}${range}.`;
  });
  return [{
    source: 'memory-recall-scale',
    key: 'recall-scale-contradiction',
    title: 'Memory recall: a score_scale label contradicts the score it labels',
    body:
      `Watchdog signal (memory-recall-scale, gate-5): over the last ${windowDays}d, rows were recorded ` +
      `whose declared score_scale is arithmetically impossible for their own top_score:\n` +
      lines.join('\n') +
      (contradictions.length > RECALL_POOL_BODY_SAMPLES
        ? `\n  … and ${contradictions.length - RECALL_POOL_BODY_SAMPLES} more.`
        : '') +
      `\n\nrrf is bounded above by (1+lexWeight)/(k+1) and cosine is floored below on admission, so ` +
      `neither range is reachable by the scale claiming it. This is not a retrieval-quality finding — ` +
      `it says the DISCRIMINATOR is wrong, which is worse: every scale-aware reader (the zero-hit ` +
      `score-collapse guard, the per-pool medians, the health card) silently pools mismatched scales ` +
      `and reproduces the exact unit error D-001 had to retract. Check the backend's declared ` +
      `scoreScale against the leg that actually produced the hits, and whether DEFAULT_RRF_K or ` +
      `lexWeight was retuned without updating RRF_SCORE_CEILING.`,
    severity: 'major',
    kind: 'bug',
    findingClass: 'learning-slo:recall-degradation',
    paths: [
      'packages/operator-core/lib/memory/recall-stats.ts',
      'libs/generic/memory/src/hybrid-fusion.ts',
    ],
  }];
}

/** recall-scale: one aggregate pass. Box-global, like its siblings. */
export async function collectRecallScaleSignals(
  sql: Sql,
  opts: LearningSloOptions = {},
): Promise<WatchdogSignal[]> {
  const days = opts.recallPoolWindowDays ?? LEARNING_SLO_DEFAULTS.recallPoolWindowDays;
  return recallScaleSignalsFromContradictions(await readRecallScaleContradictions(sql, { days }), opts);
}

export async function recallScaleCollector(
  opts: LearningSloOptions = {},
  deps: LearningSloDeps = defaultDeps,
): Promise<CollectorResult> {
  const dark = await darkOrNull(deps);
  if (dark) return dark;
  return { signals: await collectRecallScaleSignals(deps.sql(), opts) };
}
