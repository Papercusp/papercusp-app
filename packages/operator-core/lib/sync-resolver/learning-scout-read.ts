/**
 * learning-scout-read.ts — the read behind the Learning tab's "Scout" sub-view
 * (learning-system-audit-improvements-2026-06-09 P-042).
 *
 * Three halves over the scout control-plane tables, all workspace-scoped:
 *
 *  1. **Routed ideas by rail** — `harness_shared.scout_routed_ideas` (migration
 *     194, written by recordRoutedIdea): how many ideas Scout has actually
 *     dispatched into each rail (plan draft / gym experiment / work item).
 *     Today the ledger is empty — the UI renders a graceful "Scout has not
 *     routed ideas yet" — and the count-by-rail is the first signal it isn't.
 *
 *  2. **Last tick** — `harness_shared.scout_ticks` (P-034 tick observability,
 *     migration 208, mirroring watchdog_ticks: tick_at / status ran|gated|error /
 *     gate / detail jsonb). The migration may not be applied yet on a given
 *     substrate, so the read is best-effort: undefined-table (42P01) silently
 *     omits the tick half, any other error warns + omits, and
 *     {@link normalizeScoutTick} maps the row into one stable shape for the UI.
 *
 *  3. **Lens weights** — `harness_shared.scout_lens_weights` (scout-idea-grading
 *     C-1c): the persisted per-lens sampling weights the grades steer, surfaced
 *     so the tab can show the steering (P-007). Best-effort like the tick half.
 *
 * The per-item rows also carry the grade columns (migration 234) as
 * humanGrade / humanFeedback / gradedBy — null = ungraded (C-1c).
 *
 * Pure SQL over an injected `Sql` (mirrors iq-battery/benchmark-read) so the
 * resolver test can stub the seam. Lives next to the resolver (not lib/scout/)
 * because it is the Learning tab's read, not part of the scout engine.
 */
import { term } from '@papercusp/lexicon';
import type { Sql } from 'postgres';
import { isUndefinedTable } from './degraded-snapshot';
import { PLATFORM_POT_SLUG } from '../pot-membership';
import {
  ISSUE_ABANDONED_STATUSES,
  ISSUE_SHIPPED_STATUSES,
  ISSUE_TERMINAL_STATUSES,
} from '../work-item-blocking';

export interface ScoutRailCount {
  /** The routing rail: 'plan' | 'gym' | 'wi' (open set — render what arrives). */
  rail: string;
  count: number;
}

export interface ScoutTickSummary {
  /** ISO timestamp of the tick, when derivable. */
  at: string | null;
  /** The tick's outcome (migration 208 `status`: ran | gated | error). */
  outcome: string | null;
  /** The named self-gate for gated ticks (min-interval | no-trigger | circuit), or the error/reason detail. */
  detail: string | null;
}

/**
 * One tick's economics for the Ideas-view strip (learning-tab-alignment-2026-07-13
 * P-002): stop reason, spend, the generated→routed funnel, and the per-cycle lens
 * mix. The 17-day WI-4482 single-lens collapse and the budget-exhausted+0-routed
 * starvation both lived exactly in these columns, invisibly — this shape makes the
 * tick ledger's economics a first-class UI read (same rows quality-metrics and
 * blender:success-metrics judge from, D-001: no parallel derivation).
 */
export interface ScoutTickEconomics {
  /** ISO timestamp of the tick. */
  at: string | null;
  /** ran | gated | error (migration 208 `status`). */
  status: string | null;
  /**
   * Why the tick ended: a ran cycle's `detail.stop` ('completed' |
   * 'budget-exhausted' | …), a gated tick's gate name ('min-interval' |
   * 'no-trigger' | 'circuit'), or a short error summary for error ticks.
   */
  stop: string | null;
  /** Ideas the ideators produced (0 for gated ticks). */
  generated: number;
  /** Routed-ledger provenance rows persisted (the funnel's right side). */
  routed: number;
  /** Ideas the critics pruned — scored − survivors. */
  deduped: number;
  /** LLM spend of the cycle (USD), when recorded. */
  spendUsd: number | null;
  /** The cycle id (`detail.cycleId`) — joins this tick to its routed-ledger rows. */
  cycleId: string | null;
  /** Lens → routed-count for THIS tick's cycle (joined by cycle_id; empty when none routed). */
  lenses: Record<string, number>;
  /**
   * Digest grounding-lane composition of THIS cycle's corpus (`detail.groundingLanes`,
   * e.g. { corpus: 17, "plan-health": 5, "rubric-rating": 1 }) — what the cycle was
   * actually FED (learning-tab-visibility P-006). Empty for gated ticks / pre-field rows.
   */
  groundingLanes: Record<string, number>;
}

/** One routed idea, as the Scout view lists it (the ledger row, UI-shaped). */
export interface ScoutRoutedItem {
  ideaId: string;
  /** Creative lens that produced the idea (analogical | reframing | …). */
  lens: string;
  /** The rail it routed into: 'plan' | 'gym' | 'improvement' | 'instance' (open set). */
  rail: string;
  /** Change-feed ref of the created artifact: "plan:<slug>" | "wi:EI-…" | "gym:…". */
  routedRef: string;
  title: string | null;
  /** ISO timestamp of routing. */
  routedAt: string | null;
  /** Cached outcome from the change-feed join (won/lost/pending), when classified. */
  outcome: string | null;
  /** Grader's 1–5 verdict (scout-idea-grading C-1c); null = ungraded. */
  humanGrade: number | null;
  /** Grader's free-text critique, when given. */
  humanFeedback: string | null;
  /** Who graded — 'owner' | 'Queen' (open set — render what arrives). */
  gradedBy: string | null;
  /** Who filed it — 'scout' | 'su-ideate' (open set; migration 552). */
  origin: string | null;
  /** The Scout cycle that produced it — joins the idea to its tick (P-002 strip). */
  cycleId: string | null;
  /**
   * Grounding evidence: the corpus MetaPattern refs the idea targeted (typed —
   * "wi:EI-…" | "fact:workspace:…" | "rubric:<slug>#<criterion>@…" |
   * "watchdog:…" | "plan:<slug>#P-NNN" | …). Empty when none recorded
   * (su-ideate filings often ground informally). The pipeline trace's first
   * stage (learning-tab-alignment P-004).
   */
  addressesPatternRefs: string[];
  /**
   * The ledger row's own harness_slug (WI-5412): lets a gym-rail deep-link
   * carry the idea's hive (`?lhive=`) instead of dropping the reader on the
   * default hive's empty data. Nullable — the scout write path does not stamp
   * it consistently (EI-10520), so consumers must treat absence as "unknown",
   * never "workspace".
   */
  harnessSlug: string | null;
}

function toScoutRoutedItem(r: Record<string, unknown>): ScoutRoutedItem {
  return {
    ideaId: String(r.idea_id ?? ''),
    lens: String(r.lens ?? ''),
    rail: String(r.rail ?? ''),
    routedRef: String(r.routed_ref ?? ''),
    title: typeof r.title === 'string' && r.title ? r.title : null,
    routedAt: toIso(typeof r.routed_at === 'string' ? Number(r.routed_at) : r.routed_at),
    outcome: typeof r.outcome === 'string' && r.outcome ? r.outcome : null,
    humanGrade: r.human_grade == null ? null : Number(r.human_grade),
    humanFeedback: typeof r.human_feedback === 'string' && r.human_feedback ? r.human_feedback : null,
    gradedBy: typeof r.graded_by === 'string' && r.graded_by ? r.graded_by : null,
    origin: typeof r.origin === 'string' && r.origin ? r.origin : null,
    cycleId: typeof r.cycle_id === 'string' && r.cycle_id ? r.cycle_id : null,
    addressesPatternRefs: Array.isArray(r.addresses_pattern_refs)
      ? (r.addresses_pattern_refs as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 0)
      : [],
    harnessSlug: typeof r.harness_slug === 'string' && r.harness_slug ? r.harness_slug : null,
  };
}

/**
 * One fired drift marker for the Ideas view's health badge (learning-tab-alignment
 * P-003). Each marker instruments a named criterion of the blender-release-readiness
 * rubric — the rubric's driftMarkers ARE the health spec; this is their evaluator,
 * not a parallel heuristic. (`rubricCriterion` is the criterion key the marker
 * instruments; once the rubric carries machine-readable instrumentKeys the binding
 * becomes data — today it is pinned here + unit-tested.)
 */
export interface IdeasDriftMarker {
  key: 'single-lens-collapse' | 'budget-exhausted-streak' | 'grading-starvation';
  severity: 'warn' | 'bad';
  /** blender-release-readiness criterion key this marker instruments. */
  rubricCriterion: string;
  /** One-line human summary with the observed numbers. */
  summary: string;
}

/** The Ideas view's health verdict: worst fired marker wins; no data = neutral. */
export interface IdeasHealth {
  status: 'good' | 'warn' | 'bad' | 'neutral';
  markers: IdeasDriftMarker[];
}

/** One pending-signal lane of the cadence card (P-001, learning-tab-visibility
 *  2026-07-18): the accumulator's cached "new since the last successful cycle"
 *  count plus the weight the gate multiplies it by. */
export interface ScoutCadenceLane {
  lane: string;
  count: number;
  weight: number;
}

/**
 * The live firing state (P-001): what the volume-mode cadence gate will see on
 * its next tick. Derived from the SAME reader + score function the gate itself
 * uses (signal-accumulator's readAccumulatorCounts + weightedSignalScore, and
 * the gate's own SCOUT_CADENCE_DEFAULTS) — never a UI-side re-derivation.
 */
export interface ScoutCadenceState {
  /** Every signal lane with its pending count (0 included) + gate weight. */
  lanes: ScoutCadenceLane[];
  /** The weighted new-signal score the gate consumes. */
  score: number;
  /** score >= threshold fires 'signal-volume'; score <= 0 withholds. */
  threshold: number;
  /** Burst-coalescing floor between volume fires (seconds). */
  minVolumeIntervalSec: number;
  /** Heartbeat ceiling — a cycle fires at least this often regardless (seconds). */
  maxIntervalSec: number;
  /** ISO of the accumulator baseline (the last successful cycle), when known. */
  watermarkAt: string | null;
}

/**
 * One broad-scope routed idea joined to the draft plan it became (P-005,
 * learning-tab-visibility 2026-07-18) — makes the Queen↔Scout revision loop
 * watchable: `planVersion` > 1 means the draft has been revised since Scout
 * wrote it (the typed-revision loop turning).
 */
export interface ScoutDraftIteration {
  ideaId: string;
  planSlug: string;
  title: string | null;
  routedAt: string | null;
  /** The draft plan's current lifecycle status (draft | ready | active | …), null when the plan row is gone. */
  planStatus: string | null;
  planVersion: number | null;
  planUpdatedAt: string | null;
  /** version > 1 — at least one revision landed after the initial draft. */
  revised: boolean;
}

/** One digest entry, UI-shaped (learning-tab-visibility P-008). */
export interface ScoutDigestEntry {
  /** flattenDigest lane (recurring-friction | rubric-rating | niche-map | …). */
  lane: string;
  summary: string;
  /** Drill-back ref ("wi:EI-…", "plan:slug", "rubric:…"). */
  ref: string;
  weight: number | null;
}

/**
 * The persisted digest a fired cycle actually READ (P-008, owner ask
 * 2026-07-18: "show the delta and full corpus used for the tick") — the
 * SELECTED scout_digest_snapshots row (default: newest), flattened with the
 * SAME flattenDigest the ideator prompt renderer uses, split into the delta
 * leg (refs not in previousCycleRefs — the "NEW since your last cycle" the
 * prompt leads with) and the standing corpus.
 *
 * WI-5417 turned this from "the newest cycle only" into a browseable history:
 * {@link ScoutSnapshot.digestHistory} carries a COMPACT summary of the newest
 * ~10 cycles, and this full-entries shape now ships for whichever ONE of them
 * the caller selected (or the newest, absent a selection) — never for all 10
 * at once, to keep the wire payload out of the query-health `payload` warning
 * band (new-view-data-fetching-defect-class).
 */
export interface ScoutDigestSnapshot {
  cycleId: string | null;
  at: string | null;
  watermarkAt: string | null;
  totalEntries: number;
  laneCounts: Record<string, number>;
  /** Entries NEW since the previous cycle (capped, highest-weight first). */
  newEntries: ScoutDigestEntry[];
  /** Standing (non-new) entries (capped, highest-weight first). */
  standingEntries: ScoutDigestEntry[];
  /** True when caps trimmed either list. */
  truncated: boolean;
}

/**
 * One entry in the browseable digest-history strip (WI-5417): a COMPACT
 * per-cycle summary — counts only, never the entry lists themselves (those
 * only ship for the SELECTED cycle via {@link ScoutSnapshot.digest}). Newest
 * first; `newCount`/`standingCount` are that cycle's OWN delta split (each
 * snapshot carries its own `previousCycleRefs`, stamped at write time — never
 * re-derived against a sibling row).
 */
export interface ScoutDigestHistoryEntry {
  cycleId: string | null;
  at: string | null;
  totalEntries: number;
  newCount: number;
  standingCount: number;
}

/** Improve-stage funnel (WI-5412 item 3): ideas → filed → claimed → done over
 *  the improvement rail — grades teach the generator; this is what the routed
 *  work actually did. */
export interface ScoutImproveFunnel {
  /** Every routed idea (all rails) — the funnel mouth. */
  routed: number;
  /** Improvement-rail rows (wi: refs filed as work). */
  filed: number;
  /** Filed items an agent is working RIGHT NOW: non-terminal AND assigned.
   *  Admits `wip` — under the unified enum that IS the in-flight state, and the
   *  pre-flip `state='open' AND assignee IS NOT NULL` could not see it. */
  claimed: number;
  /** Filed items that LANDED (ISSUE_SHIPPED_STATUSES: done|resolved).
   *  Deliberately excludes the abandoned terminals — see `dropped`. */
  done: number;
  /** Filed items abandoned (ISSUE_ABANDONED_STATUSES: dropped|closed).
   *  Reported separately and never folded into `done`: an idea the loop gave up
   *  on is not one it delivered, and summing them overstates the loop's output
   *  (EI-18792873324746237). */
  dropped: number;
}

export interface ScoutSnapshot {
  totalRouted: number;
  railCounts: ScoutRailCount[];
  /** Newest routed ideas (ledger rows, newest-first) — the per-item view across ALL rails. */
  recent: ScoutRoutedItem[];
  /** Newest scout tick, or null when none recorded (or the table doesn't exist yet). */
  lastTick: ScoutTickSummary | null;
  /**
   * Tick-economics strip (learning-tab-alignment P-002): the newest scout ticks,
   * newest-first, with stop reason / spend / generated→routed funnel / lens mix.
   * Empty when the ledger is missing or empty — best-effort like `lastTick`.
   */
  ticks: ScoutTickEconomics[];
  /**
   * Ideas-view health verdict (learning-tab-alignment P-003): the
   * blender-release-readiness rubric's driftMarkers, evaluated over this same
   * snapshot's rows ({@link evaluateIdeasDriftMarkers}).
   */
  health: IdeasHealth;
  /**
   * Current persisted per-lens sampling weights (`scout_lens_weights`, written
   * by refreshScoutOutcomes) — the steering the grades feed (C-1c / P-007).
   * null when none recorded yet (or the read degrades).
   */
  lensWeights: Record<string, number> | null;
  /**
   * Pipeline-trace enrichment (P-004): titles for the OPAQUE grounding refs in
   * `recent[].addressesPatternRefs` — today the `wi:EI-…` class, resolved
   * against engineer_issues (fact:/rubric:/watchdog:/plan: refs are already
   * human-readable slugs). Keyed by the FULL ref ("wi:EI-10795" → title).
   * Best-effort: an unresolvable ref simply has no entry.
   */
  groundingTitles: Record<string, string>;
  /** Improve-stage funnel (WI-5412 item 3) — null when the ledger read degrades. */
  improveFunnel: ScoutImproveFunnel | null;
  /**
   * Live firing state (learning-tab-visibility P-001): the accumulator's
   * per-lane pending counts + the weighted score vs the gate's threshold.
   * null when the accumulator table is missing or the read degrades.
   */
  cadence: ScoutCadenceState | null;
  /**
   * Drafts in iteration (learning-tab-visibility P-005): the newest rail='plan'
   * routed ideas joined to their draft plans — the Queen↔Scout revision loop,
   * watchable. Empty when none routed or the read degrades.
   */
  drafts: ScoutDraftIteration[];
  /**
   * The SELECTED cycle's persisted digest (P-008, browseable per WI-5417):
   * delta + standing corpus for whichever cycle the caller asked for (default
   * newest). null when no snapshot exists yet or the read degrades.
   */
  digest: ScoutDigestSnapshot | null;
  /**
   * Browseable digest history (WI-5417): a compact summary of the newest
   * ~{@link DIGEST_HISTORY_LIMIT} cycles, newest first — the UI pages/selects
   * among these (nuqs `?sdig=<cycleId>`) rather than only ever seeing the
   * newest. Empty when no snapshots exist yet or the read degrades.
   */
  digestHistory: ScoutDigestHistoryEntry[];
}

// `isUndefinedTable` lives in ./degraded-snapshot — see the note in
// learning-hive-throughput-read.ts. One rule, one definition.
export { isUndefinedTable };

function toIso(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string' && v) {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  return null;
}

function firstString(row: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

/**
 * Map one scout_ticks row into the stable UI shape. Pinned to the migration-208
 * columns (`tick_at` / `status` / `gate` / `detail` jsonb) with mild tolerance
 * for alternate spellings so a schema tweak degrades to nulls, never a crash.
 */
export function normalizeScoutTick(row: Record<string, unknown> | null | undefined): ScoutTickSummary | null {
  if (!row) return null;
  const detailObj =
    row.detail && typeof row.detail === 'object' && !Array.isArray(row.detail)
      ? (row.detail as Record<string, unknown>)
      : null;
  return {
    at: toIso(row.tick_at ?? row.ticked_at ?? row.created_at ?? row.at),
    outcome: firstString(row, ['status', 'gate_outcome', 'outcome', 'decision']),
    detail:
      firstString(row, ['gate', 'gate_reason', 'reason', 'note']) ??
      (detailObj ? firstString(detailObj, ['reason', 'error', 'stop']) : null),
  };
}

const toCount = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
};

/**
 * Map one scout_ticks row into the economics-strip shape (P-002). `stop` prefers
 * the ran cycle's `detail.stop`, then a gated tick's gate name, then a bounded
 * error summary — mirroring how the tick recorder writes each status. Lens
 * counts are joined separately (by cycleId) and start empty here.
 */
export function normalizeTickEconomics(row: Record<string, unknown>): ScoutTickEconomics {
  const detailObj =
    row.detail && typeof row.detail === 'object' && !Array.isArray(row.detail)
      ? (row.detail as Record<string, unknown>)
      : null;
  const status = firstString(row, ['status']);
  const errText = detailObj ? firstString(detailObj, ['error', 'reason']) : null;
  const stop =
    (detailObj ? firstString(detailObj, ['stop']) : null) ??
    firstString(row, ['gate']) ??
    (status === 'error' && errText ? errText.slice(0, 120) : null);
  const spend = row.budget_used_usd == null ? null : Number(row.budget_used_usd);
  const cycleId = detailObj ? firstString(detailObj, ['cycleId']) : null;
  // P-006: the digest grounding-lane composition this cycle was fed, when the
  // tick recorder captured it. Tolerant: anything but a {lane: number} object
  // reads as empty.
  const groundingLanes: Record<string, number> = {};
  const rawLanes = detailObj?.groundingLanes;
  if (rawLanes && typeof rawLanes === 'object' && !Array.isArray(rawLanes)) {
    for (const [lane, v] of Object.entries(rawLanes as Record<string, unknown>)) {
      const n = typeof v === 'string' ? Number(v) : v;
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) groundingLanes[lane] = n;
    }
  }
  return {
    at: toIso(row.tick_at ?? row.ticked_at ?? row.created_at ?? row.at),
    status,
    stop,
    generated: toCount(row.ideas_generated),
    routed: toCount(row.ideas_routed),
    deduped: toCount(row.ideas_deduped),
    spendUsd: spend != null && Number.isFinite(spend) ? spend : null,
    cycleId,
    lenses: {},
    groundingLanes,
  };
}

/** One lens must hold at least this share of the sample to count as a collapse
    (the rubric's driftMarker: "One lens >=90% of newest-20"). */
const SINGLE_LENS_DOMINANCE = 0.9;
/** Don't judge lens collapse on a tiny sample (a fresh install with 2 rows is not a collapse). */
const LENS_SAMPLE_MIN = 5;
/** Grading starvation needs this many ungraded filings before it fires. */
const GRADING_STARVATION_MIN = 10;

/**
 * Evaluate the Ideas view's health markers (learning-tab-alignment P-003). The
 * blender-release-readiness rubric's driftMarkers ARE the health spec — each
 * marker here implements one of them over the SAME rows the snapshot already
 * carries (D-001: no parallel heuristic):
 *
 *   - single-lens-collapse    ← multi-lens-routing: "One lens >=90% of newest-20"
 *     (over `scoutLensSample`, the newest origin='scout' routed rows — the
 *     rubric's own replication drill).
 *   - budget-exhausted-streak ← multi-lens-routing: "consecutive budget-exhausted
 *     +0-routed ticks" (over the P-002 economics ticks, ran ticks only — the
 *     WI-4482 knock-on where the knobs can't fund the roster).
 *   - grading-starvation      ← grading-loop-closure: "graded fraction flat at 0
 *     while filings accumulate" (over the newest routed rows' grade columns).
 *
 * Pure — unit-testable with no PG. Worst fired marker wins the status; no data
 * at all reads neutral, data with no fired marker reads good.
 */
export function evaluateIdeasDriftMarkers(input: {
  ticks: ScoutTickEconomics[];
  recent: ScoutRoutedItem[];
  scoutLensSample: string[];
}): IdeasHealth {
  const markers: IdeasDriftMarker[] = [];

  // single-lens-collapse — newest-N origin='scout' rows, never lifetime (stale
  // multi-lens rows from a prior month must not mask a live collapse).
  const sample = input.scoutLensSample.filter((l) => typeof l === 'string' && l.length > 0);
  if (sample.length >= LENS_SAMPLE_MIN) {
    const counts = new Map<string, number>();
    for (const l of sample) counts.set(l, (counts.get(l) ?? 0) + 1);
    const [topLens, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topCount / sample.length >= SINGLE_LENS_DOMINANCE) {
      markers.push({
        key: 'single-lens-collapse',
        severity: topCount === sample.length ? 'bad' : 'warn',
        rubricCriterion: 'multi-lens-routing',
        summary: `${topCount} of the newest ${sample.length} ${term('scout', { lower: true })}-routed ideas are '${topLens}' — the per-lens learning subsystem has a dimension that never varies (the 17-day WI-4482 shape).`,
      });
    }
  }

  // budget-exhausted-streak — leading consecutive ran-ticks that spent the
  // budget and routed nothing (newest-first; gated ticks don't break a streak,
  // they just don't run).
  let streak = 0;
  for (const tk of input.ticks) {
    if (tk.status !== 'ran') continue;
    if (tk.stop === 'budget-exhausted' && tk.routed === 0) streak += 1;
    else break;
  }
  if (streak >= 2) {
    markers.push({
      key: 'budget-exhausted-streak',
      severity: streak >= 4 ? 'bad' : 'warn',
      rubricCriterion: 'multi-lens-routing',
      summary: `${streak} consecutive cycles exhausted their budget with 0 ideas routed — spend with no yield; the knobs are likely sized for a smaller roster.`,
    });
  }

  // grading-starvation — the grading surface this view IS: filings accumulate,
  // nothing graded.
  const total = input.recent.length;
  const graded = input.recent.filter((r) => r.humanGrade != null).length;
  if (total >= GRADING_STARVATION_MIN && graded === 0) {
    markers.push({
      key: 'grading-starvation',
      severity: 'warn',
      rubricCriterion: 'grading-loop-closure',
      summary: `0 of the newest ${total} routed ideas are graded — the grade→learn half of the loop is starving.`,
    });
  }

  const status: IdeasHealth['status'] = markers.some((m) => m.severity === 'bad')
    ? 'bad'
    : markers.length > 0
      ? 'warn'
      : input.ticks.length === 0 && input.recent.length === 0
        ? 'neutral'
        : 'good';
  return { status, markers };
}

/** Rows read for the browseable digest-history strip (WI-5417) — days of
 *  history at the ~hourly-to-30min cadence, while keeping the per-request PG
 *  read + flatten cost bounded (SNAPSHOT_KEEP in digest-snapshots.ts prunes
 *  the table itself to 30). */
const DIGEST_HISTORY_LIMIT = 10;

/** Routed-ideas-by-rail + last tick for one workspace. `selectedCycleId`
 *  (WI-5417) picks which of the newest {@link DIGEST_HISTORY_LIMIT} digest
 *  snapshots ships full entries for — omitted/not-found falls back to the
 *  newest. */
/**
 * THE pot-lens predicate for `harness_shared.scout_routed_ideas` — one rule, one
 * definition, every leg.
 *
 * scout_routed_ideas has `harness_slug` but NO pot column: a row's pot is its
 * harness's registry pot (the write-side resolveLearningPotSlug model, P-005).
 * Rows with NULL harness_slug home to the PLATFORM pot, mirroring step 3 of that
 * resolution; under any other pot lens they are excluded (D-002 — never misfile
 * unattributable rows into a pot).
 *
 * ⚠ EVERY query over scout_routed_ideas must alias the table `sri` and take its
 * predicate from HERE. The alias is not cosmetic — the fragment names a qualified
 * column, so an un-aliased query cannot use it.
 *
 * This used to be a comment asking callers to reuse an inline fragment, and the
 * comment did not work: it was violated twice. First by the improve funnel, which
 * wrote the rule out a second time and scoped its FIRST stage and not its later
 * ones, rendering a funnel that GREW under a pot lens (observed live: 156 ideas →
 * 605 approved, EI-18799358267821549). Then by readScoutDraftIterations below,
 * which aliased the same table `r` and so could not have reused the fragment even
 * if its author had wanted to (WI-6385). Exported and parameterised so reuse is
 * the path of least resistance rather than an instruction.
 */
export function routedIdeasPotFilter(
  sql: Sql,
  { hive, memberSlugs }: { hive: string | null; memberSlugs: string[] | null },
) {
  if (!memberSlugs?.length) return sql``;
  return hive === PLATFORM_POT_SLUG
    ? sql`AND (sri.harness_slug IN ${sql(memberSlugs)} OR sri.harness_slug IS NULL)`
    : sql`AND sri.harness_slug IN ${sql(memberSlugs)}`;
}

/** Complete routed-idea corpus for an internal bounded Improve projection. */
export async function readLearningImproveRoutedRows({
  sql,
  workspaceId,
  hive = null,
  hiveMemberSlugs = null,
}: {
  sql: Sql;
  workspaceId: string;
  hive?: string | null;
  hiveMemberSlugs?: string[] | null;
}): Promise<ScoutRoutedItem[]> {
  const lens = typeof hive === 'string' && hive.trim() ? hive.trim() : null;
  const memberSlugs = lens ? (hiveMemberSlugs?.length ? hiveMemberSlugs : [lens]) : null;
  const potFilter = routedIdeasPotFilter(sql, { hive: lens, memberSlugs });
  const rows = (await sql`
    SELECT idea_id, lens, rail, routed_ref, title, routed_at, outcome,
           human_grade, human_feedback, graded_by, origin, cycle_id,
           addresses_pattern_refs, harness_slug
      FROM harness_shared.scout_routed_ideas sri
     WHERE sri.workspace_id = ${workspaceId}
       ${potFilter}
     ORDER BY routed_at DESC
  `) as Array<Record<string, unknown>>;
  return rows.map(toScoutRoutedItem);
}

/**
 * Drafts-in-iteration: rail='plan' routed-ledger rows joined to the draft
 * plans they became (version > 1 = the grade/feedback → typed-revision loop
 * has turned). Workspace-scoped join (harness_plans is multi-tenant — never a
 * bare-slug read); the newest plan row per slug wins. Best-effort: returns []
 * on error. Serves BOTH the full scout snapshot and the thin
 * `learning.scoutDrafts` resolver (the Improvements view's read).
 *
 * WI-6385: takes the pot lens like every other leg over this table. It previously
 * aliased scout_routed_ideas `r` and passed no pot at all, so under a selected pot
 * the Improvements view showed two scoped legs beside this workspace-wide one and
 * nothing on screen said which was which.
 */
export async function readScoutDraftIterations({
  workspaceId,
  sql,
  hive = null,
  hiveMemberSlugs = null,
}: {
  workspaceId: string;
  sql: Sql;
  /** Pot lens; null/'' ⇒ the workspace-wide rollup. */
  hive?: string | null;
  /** The pot's member harness slugs (resolved by the caller via the registry);
   *  falls back to the pot home slug alone. */
  hiveMemberSlugs?: string[] | null;
}): Promise<ScoutDraftIteration[]> {
  try {
    const lens = typeof hive === 'string' && hive.trim() ? hive.trim() : null;
    const memberSlugs = lens ? (hiveMemberSlugs?.length ? hiveMemberSlugs : [lens]) : null;
    const potFilter = routedIdeasPotFilter(sql, { hive: lens, memberSlugs });
    const draftRows = (await sql`
      SELECT DISTINCT ON (sri.idea_id)
             sri.idea_id, sri.title, sri.routed_at,
             substring(sri.routed_ref from 'plan:(.*)') AS plan_slug,
             p.status AS plan_status, p.version AS plan_version, p.updated_at AS plan_updated_at
        FROM harness_shared.scout_routed_ideas sri
        LEFT JOIN harness_shared.harness_plans p
          ON p.workspace_id = sri.workspace_id
         AND p.plan_slug = substring(sri.routed_ref from 'plan:(.*)')
       WHERE sri.workspace_id = ${workspaceId}
         AND sri.rail = 'plan'
         AND sri.routed_ref LIKE 'plan:%'
         ${potFilter}
       ORDER BY sri.idea_id, p.updated_at DESC NULLS LAST
    `) as Array<Record<string, unknown>>;
    return draftRows
      .map((r) => {
        const planVersion = r.plan_version == null ? null : Number(r.plan_version);
        return {
          ideaId: String(r.idea_id ?? ''),
          planSlug: String(r.plan_slug ?? ''),
          title: typeof r.title === 'string' && r.title ? r.title : null,
          routedAt: toIso(typeof r.routed_at === 'string' ? Number(r.routed_at) : r.routed_at),
          planStatus: typeof r.plan_status === 'string' && r.plan_status ? r.plan_status : null,
          planVersion: planVersion != null && Number.isFinite(planVersion) ? planVersion : null,
          planUpdatedAt: toIso(r.plan_updated_at),
          revised: planVersion != null && Number.isFinite(planVersion) && planVersion > 1,
        };
      })
      .filter((d) => d.planSlug)
      .sort((a, b) => (b.routedAt ?? '').localeCompare(a.routedAt ?? ''))
      .slice(0, 12);
  } catch (err) {
    if (!isUndefinedTable(err)) {
      console.warn('[learning.scout] drafts read failed:', err instanceof Error ? err.message : err);
    }
    return [];
  }
}

export async function readScoutSnapshot(
  sql: Sql,
  workspaceId: string,
  opts: {
    selectedCycleId?: string | null;
    /** Pot lens (pot-scope-all-learnings P-005): scopes the routed-ideas legs to
     *  the pot's member harnesses and the tick leg to `pot_slug`. The digest /
     *  cadence / lens-weight legs stay workspace-global — they are loop
     *  machinery state with no per-pot identity. */
    hive?: string | null;
    /** The pot's member harness slugs, resolved by the caller via the registry
     *  (the learning.improvements hiveMemberHarnessScopes pattern). Falls back
     *  to just the pot home slug when omitted. */
    hiveMemberSlugs?: string[] | null;
  } = {},
): Promise<ScoutSnapshot> {
  const hive = typeof opts.hive === 'string' && opts.hive.trim() ? opts.hive.trim() : null;
  const memberSlugs = hive ? (opts.hiveMemberSlugs?.length ? opts.hiveMemberSlugs : [hive]) : null;
  const routedPotFilter = routedIdeasPotFilter(sql, { hive, memberSlugs });
  const rails = (await sql`
    SELECT rail, count(*)::int AS count
      FROM harness_shared.scout_routed_ideas sri
     WHERE sri.workspace_id = ${workspaceId}
       ${routedPotFilter}
     GROUP BY rail
     ORDER BY count DESC, rail ASC
  `) as Array<Record<string, unknown>>;
  const railCounts: ScoutRailCount[] = rails.map((r) => ({
    rail: String(r.rail ?? ''),
    count: Number(r.count ?? 0),
  }));
  const totalRouted = railCounts.reduce((sum, r) => sum + r.count, 0);

  // The per-item half: newest ledger rows so the tab can show WHICH ideas
  // routed where (owner ask 2026-06-11), not just counts. routed_at is
  // epoch-ms (bigint) in migration 194.
  const items = (await sql`
    SELECT idea_id, lens, rail, routed_ref, title, routed_at, outcome,
           human_grade, human_feedback, graded_by, origin, cycle_id,
           addresses_pattern_refs, harness_slug
      FROM harness_shared.scout_routed_ideas sri
     WHERE sri.workspace_id = ${workspaceId}
       ${routedPotFilter}
     ORDER BY routed_at DESC
     LIMIT 50
  `) as Array<Record<string, unknown>>;
  const recent: ScoutRoutedItem[] = items.map(toScoutRoutedItem);

  // P-004 pipeline trace: resolve the opaque grounding refs (the wi:EI-… class)
  // to titles so the trace's first stage reads as evidence, not ids. One bounded
  // IN-query over the refs actually present in `recent`; best-effort — a failed
  // read leaves the map empty and the UI falls back to the raw ref.
  let groundingTitles: Record<string, string> = {};
  try {
    const wiIds = [
      ...new Set(
        recent
          .flatMap((it) => it.addressesPatternRefs)
          .filter((ref) => ref.startsWith('wi:'))
          .map((ref) => ref.slice('wi:'.length))
          .filter(Boolean),
      ),
    ];
    if (wiIds.length > 0) {
      const titleRows = (await sql`
        SELECT issue_id, title /* grounding-titles */
          FROM harness_shared.engineer_issues
         WHERE workspace_id = ${workspaceId}
           AND issue_id IN ${sql(wiIds)}
      `) as Array<Record<string, unknown>>;
      for (const r of titleRows) {
        const id = typeof r.issue_id === 'string' ? r.issue_id : '';
        const title = typeof r.title === 'string' && r.title ? r.title : null;
        if (id && title) groundingTitles[`wi:${id}`] = title;
      }
    }
  } catch (err) {
    if (!isUndefinedTable(err)) {
      console.warn('[learning.scout] grounding-title read failed:', err instanceof Error ? err.message : err);
    }
    groundingTitles = {};
  }

  // scout_ticks lands with P-034 (a peer owns the migration); until then — and
  // under any column-shape drift — omit the tick half rather than failing the
  // routed-ideas half. P-002 widens this leg from LIMIT 1 to the newest 12 rows
  // (the tick-economics strip); `lastTick` stays derived from row 0 so existing
  // consumers keep their shape.
  let lastTick: ScoutTickSummary | null = null;
  let ticks: ScoutTickEconomics[] = [];
  try {
    const tickRows = (await sql`
      SELECT * FROM harness_shared.scout_ticks
       WHERE workspace_id = ${workspaceId}
         AND origin = 'scout'
         ${hive ? sql`AND pot_slug = ${hive}` : sql``}
       ORDER BY tick_at DESC
       LIMIT 12
    `) as Array<Record<string, unknown>>;
    lastTick = normalizeScoutTick(tickRows[0]);
    ticks = tickRows.map(normalizeTickEconomics);
    // Lens chips: join each ran tick's cycle to its routed-ledger rows. Same
    // ledger the funnel's `routed` count claims to summarize — so a mismatch is
    // VISIBLE here (the WI-4476 reconcile class), not papered over.
    const cycleIds = [...new Set(ticks.map((t) => t.cycleId).filter((c): c is string => !!c))];
    if (cycleIds.length > 0) {
      const lensRows = (await sql`
        SELECT cycle_id, lens, count(*)::int AS count
          FROM harness_shared.scout_routed_ideas
         WHERE workspace_id = ${workspaceId}
           AND cycle_id IN ${sql(cycleIds)}
         GROUP BY cycle_id, lens
      `) as Array<Record<string, unknown>>;
      const byCycle = new Map<string, Record<string, number>>();
      for (const r of lensRows) {
        const cid = typeof r.cycle_id === 'string' ? r.cycle_id : '';
        const lens = typeof r.lens === 'string' && r.lens ? r.lens : 'unknown';
        if (!cid) continue;
        const bucket = byCycle.get(cid) ?? {};
        bucket[lens] = (bucket[lens] ?? 0) + Number(r.count ?? 0);
        byCycle.set(cid, bucket);
      }
      ticks = ticks.map((t) => (t.cycleId && byCycle.has(t.cycleId) ? { ...t, lenses: byCycle.get(t.cycleId)! } : t));
    }
  } catch (err) {
    if (!isUndefinedTable(err)) {
      console.warn('[learning.scout] tick read failed:', err instanceof Error ? err.message : err);
    }
  }

  // P-003: the newest-N origin='scout' lens sample — the multi-lens-routing
  // criterion's own replication drill (newest-N, never lifetime). The sample
  // size is shared with the MCP instrument (success-metrics'
  // LENS_DIVERSITY_SAMPLE) via the same deferred-import pattern as the
  // lens-weight leg, so the UI badge and blender:success-metrics can never
  // drift on how much "recent" is.
  let scoutLensSample: string[] = [];
  try {
    const { LENS_DIVERSITY_SAMPLE } = await import('../scout/success-metrics');
    const lensSampleRows = (await sql`
      SELECT lens /* newest-lens-sample */
        FROM harness_shared.scout_routed_ideas
       WHERE workspace_id = ${workspaceId}
         AND origin = 'scout'
       ORDER BY routed_at DESC
       LIMIT ${LENS_DIVERSITY_SAMPLE}
    `) as Array<Record<string, unknown>>;
    scoutLensSample = lensSampleRows.map((r) => String(r.lens ?? '')).filter(Boolean);
  } catch (err) {
    if (!isUndefinedTable(err)) {
      console.warn('[learning.scout] lens-sample read failed:', err instanceof Error ? err.message : err);
    }
  }

  // Lens-weight half (C-1c): reuse routed-ledger's reader over THIS injected,
  // workspace-routed sql (it filters to known lenses). Best-effort like the
  // tick half — a missing table / failed read degrades to null, never a 500.
  let lensWeights: Record<string, number> | null = null;
  try {
    const { readScoutLensWeights } = await import('../scout/routed-ledger');
    const weights = await readScoutLensWeights({ workspaceId, sql });
    lensWeights = Object.keys(weights).length > 0 ? (weights as Record<string, number>) : null;
  } catch (err) {
    if (!isUndefinedTable(err)) {
      console.warn('[learning.scout] lens-weight read failed:', err instanceof Error ? err.message : err);
    }
  }

  // Cadence leg (learning-tab-visibility P-001): the live firing state — the
  // SAME accumulator reader + score function the volume gate consumes, plus the
  // gate's own defaults, so the card can never drift from what the gate judges.
  // Best-effort like the tick half: a missing table degrades to null.
  let cadence: ScoutCadenceState | null = null;
  try {
    const { readAccumulatorCounts, weightedSignalScore, DEFAULT_LANE_WEIGHTS, SIGNAL_LANES } = await import(
      '../scout/signal-accumulator'
    );
    const { SCOUT_CADENCE_DEFAULTS } = await import('../scout/cadence');
    const { counts, watermarkAt } = await readAccumulatorCounts({ workspaceId, sql });
    cadence = {
      lanes: SIGNAL_LANES.map((lane) => ({
        lane,
        count: counts[lane] ?? 0,
        weight: DEFAULT_LANE_WEIGHTS[lane],
      })),
      score: weightedSignalScore(counts),
      threshold: SCOUT_CADENCE_DEFAULTS.signalScoreThreshold,
      minVolumeIntervalSec: SCOUT_CADENCE_DEFAULTS.minVolumeIntervalSec,
      maxIntervalSec: SCOUT_CADENCE_DEFAULTS.maxIntervalSec,
      watermarkAt: watermarkAt ? watermarkAt.toISOString() : null,
    };
  } catch (err) {
    if (!isUndefinedTable(err)) {
      console.warn('[learning.scout] cadence read failed:', err instanceof Error ? err.message : err);
    }
  }

  // Drafts-in-iteration leg (learning-tab-visibility P-005): the newest
  // rail='plan' ledger rows joined to the draft plans they became, so the
  // Queen↔Scout revision loop is watchable (version > 1 = revised). Shared
  // with the thin `learning.scoutDrafts` resolver (the Improvements view's
  // read — owner ask 2026-07-19 moved the Drafts-in-iteration section there).
  // WI-6385: takes THIS snapshot's lens. It previously did not, so the drafts
  // leg of a pot-scoped snapshot was workspace-wide beside its scoped siblings.
  const drafts = await readScoutDraftIterations({
    workspaceId,
    sql,
    hive,
    hiveMemberSlugs: memberSlugs,
  });

  // Digest leg (learning-tab-visibility P-008, browseable history WI-5417):
  // the newest DIGEST_HISTORY_LIMIT persisted per-cycle digests, each
  // flattened with the SAME flattenDigest the ideator prompt uses and split
  // delta-vs-standing on its OWN previousCycleRefs (stamped at write time —
  // never re-derived against a sibling row's refs). Every row contributes a
  // COMPACT summary to `digestHistory`; only the SELECTED cycle (or the
  // newest, absent a match) gets its full entry lists flattened into `digest`
  // — shipping all N in full would blow the query-health payload budget for
  // no reader benefit (new-view-data-fetching-defect-class). Best-effort.
  let digest: ScoutDigestSnapshot | null = null;
  let digestHistory: ScoutDigestHistoryEntry[] = [];
  try {
    const snapRows = (await sql`
      SELECT cycle_id, watermark_at, digest, created_at
        FROM harness_shared.scout_digest_snapshots
       WHERE workspace_id = ${workspaceId}
       ORDER BY created_at DESC
       LIMIT ${DIGEST_HISTORY_LIMIT}
    `) as Array<Record<string, unknown>>;
    const { flattenDigest } = await import('../scout/lenses');
    type ParsedSnapshotRow = {
      row: Record<string, unknown>;
      flat: ReturnType<typeof flattenDigest>;
      prevRefs: Set<string>;
    };

    const parsed: ParsedSnapshotRow[] = [];
    for (const row of snapRows) {
      if (!row.digest || typeof row.digest !== 'object') continue;
      const raw = row.digest as Record<string, unknown>;
      const flat = flattenDigest(raw as never) ?? [];
      const prevRefs = new Set(
        Array.isArray(raw.previousCycleRefs)
          ? (raw.previousCycleRefs as unknown[]).filter((r): r is string => typeof r === 'string')
          : [],
      );
      parsed.push({ row, flat, prevRefs });
    }

    // Legacy-row heal (owner-reported 2026-07-19): rows written before the
    // cycle-deps stamp-before-persist fix carry NO previousCycleRefs, so their
    // delta split reads structurally empty. For those rows ONLY, derive the
    // baseline from the next-older sibling's flattened refs (rows are newest-
    // first). A row's own stamped baseline always wins when present — the
    // sibling derivation is a display heal for pre-fix history, and the last
    // (oldest-fetched) row keeps the no-baseline ⇒ all-standing rule.
    for (let i = 0; i < parsed.length; i += 1) {
      const entry = parsed[i];
      const older = parsed[i + 1];
      if (entry.prevRefs.size === 0 && older) {
        entry.prevRefs = new Set(older.flat.map((p) => p.ref));
      }
    }

    digestHistory = parsed.map(({ row, flat, prevRefs }) => {
      // No previousCycleRefs (first-ever snapshot) ⇒ nothing is provably
      // "new"; the whole corpus reads as standing, same rule `digest` uses.
      const newCount = prevRefs.size > 0 ? flat.filter((p) => !prevRefs.has(p.ref)).length : 0;
      return {
        cycleId: typeof row.cycle_id === 'string' && row.cycle_id ? row.cycle_id : null,
        at: toIso(row.created_at),
        totalEntries: flat.length,
        newCount,
        standingCount: flat.length - newCount,
      };
    });

    const selectedIdx = opts.selectedCycleId
      ? parsed.findIndex(({ row }) => row.cycle_id === opts.selectedCycleId)
      : -1;
    const chosen = parsed[selectedIdx >= 0 ? selectedIdx : 0];
    if (chosen) {
      const { row, flat, prevRefs } = chosen;
      const toEntry = (p: { category?: string; summary: string; ref: string; weight?: number }): ScoutDigestEntry => ({
        lane: p.category ?? 'unknown',
        summary: typeof p.summary === 'string' ? p.summary.slice(0, 240) : '',
        ref: p.ref,
        weight: typeof p.weight === 'number' && Number.isFinite(p.weight) ? p.weight : null,
      });
      const byWeight = (a: ScoutDigestEntry, b: ScoutDigestEntry): number => (b.weight ?? 0) - (a.weight ?? 0);
      // Owner ask 2026-07-19 ("DONT CAP IT"): the digest is the persisted corpus
      // a cycle was actually prompted with — the UI shows it WHOLE. No count cap
      // on either leg; `truncated` stays false so no "capped for display" note.
      const newEntries = prevRefs.size > 0 ? flat.filter((p) => !prevRefs.has(p.ref)).map(toEntry).sort(byWeight) : [];
      const standingEntries = flat
        .filter((p) => prevRefs.size === 0 || prevRefs.has(p.ref))
        .map(toEntry)
        .sort(byWeight);
      const laneCounts: Record<string, number> = {};
      for (const p of flat) {
        const lane = p.category ?? 'unknown';
        laneCounts[lane] = (laneCounts[lane] ?? 0) + 1;
      }
      digest = {
        cycleId: typeof row.cycle_id === 'string' && row.cycle_id ? row.cycle_id : null,
        at: toIso(row.created_at),
        watermarkAt: toIso(row.watermark_at),
        totalEntries: flat.length,
        laneCounts,
        newEntries,
        standingEntries,
        truncated: false,
      };
    }
  } catch (err) {
    if (!isUndefinedTable(err)) {
      console.warn('[learning.scout] digest read failed:', err instanceof Error ? err.message : err);
    }
  }

  const health = evaluateIdeasDriftMarkers({ ticks, recent, scoutLensSample });
  // Improve-funnel leg (WI-5412 item 3): ideas → filed → claimed → done over
  // the improvement rail — the routed wi: refs joined to their live issue
  // state. Best-effort like every other leg.
  let improveFunnel: ScoutImproveFunnel | null = null;
  try {
    // The state predicates bind the SHARED constants rather than repeating the
    // members inline. EI-18792873324746237: this query used to filter the
    // pre-unify spellings only (`state IN ('resolved','closed')`), so after the
    // work-item-status-full-unify writer-flip it matched zero live rows and the
    // tab reported "0 shipped" against 137 that had actually shipped. A stale
    // literal list is invisible to tsc and reads as a plausible zero, so the
    // list must live in exactly one place.
    const shipped = [...ISSUE_SHIPPED_STATUSES];
    const abandoned = [...ISSUE_ABANDONED_STATUSES];
    const terminal = [...ISSUE_TERMINAL_STATUSES];
    const funnelRows = (await sql`
      SELECT count(*)::int AS filed,
             count(*) FILTER (
               WHERE ei.state IS NOT NULL
                 AND NOT (ei.state = ANY(${terminal}::text[]))
                 AND ei.assignee IS NOT NULL
             )::int AS claimed,
             count(*) FILTER (WHERE ei.state = ANY(${shipped}::text[]))::int AS done,
             count(*) FILTER (WHERE ei.state = ANY(${abandoned}::text[]))::int AS dropped
        FROM harness_shared.scout_routed_ideas sri
        LEFT JOIN harness_shared.engineer_issues ei
          ON ei.workspace_id = ${workspaceId}
         AND ei.issue_id = substring(sri.routed_ref FROM 4)
       WHERE sri.workspace_id = ${workspaceId}
         AND sri.rail = 'improvement'
         AND sri.routed_ref LIKE 'wi:%'
         ${routedPotFilter}
    `) as Array<Record<string, unknown>>;
    const row = funnelRows[0];
    if (row) {
      improveFunnel = {
        routed: totalRouted,
        filed: Number(row.filed ?? 0),
        claimed: Number(row.claimed ?? 0),
        done: Number(row.done ?? 0),
        dropped: Number(row.dropped ?? 0),
      };
    }
  } catch (err) {
    if (!isUndefinedTable(err)) {
      console.warn('[learning.scout] improve-funnel read failed:', err instanceof Error ? err.message : err);
    }
  }

  return {
    totalRouted,
    railCounts,
    recent,
    lastTick,
    ticks,
    health,
    lensWeights,
    groundingTitles,
    cadence,
    drafts,
    digest,
    digestHistory,
    improveFunnel,
  };
}
