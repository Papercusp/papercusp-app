/**
 * learning-loop-health.ts — pure health classifier for the self-learning loop
 * routines (relight-self-learning-edges-2026-06-14 P-030).
 *
 * The recurring self-learning failure class is a loop that was BUILT but is
 * silently DARK — seeded inactive behind a default-OFF flag and never armed
 * (calibration's maturation sweep, scout's lens weights, the autonomy scan), or
 * an always-on loop that wedged and stopped firing (the gym D-007 / implement-
 * lane class). Nothing surfaced it, so it rotted unseen. This classifier turns
 * the routine state of the workspace-singleton learning loops into a per-loop
 * verdict so a "dark loop" is VISIBLE on a health read.
 *
 * Pure — the PG glue (read routines, call this) lives in the
 * `improvements:learning_loops` tool. The loop list is passed in and the
 * always-on set is defined here so the core is import-cheap + exhaustively
 * unit-testable (no DB, no Date.now()).
 */

import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';

/** The reserved host slug the workspace-singleton cadence rows live under. */
export const SINGLETON_HOST_SLUG = '@singleton';

/**
 * The 3 ALWAYS-ON learning loops (they declare `singletonActive: true`, so a
 * fresh workspace seeds them live). Dark here is a PROBLEM, not by-design. Source
 * of truth: LEARNING_SINGLETONS in seed-learning-singletons.ts (the always-on tail).
 */
export const ALWAYS_ON_LEARNING_LOOPS = new Set<string>(['change-ledger', 'scout', 'iq-battery']);

/** An active loop that has not fired within this many days is "stale" (a wedge). */
export const DEFAULT_LOOP_STALE_AFTER_DAYS = 3;

const DAY_MS = 86_400_000;
const DEFAULT_ACTIVITY_LAG_GRACE_MS = 5 * 60_000;

/** A routine row, narrowed to what the classifier reads. */
export interface LearningRoutineRow {
  installSlug: string;
  name: string;
  active: boolean;
  /** ISO timestamp of the last fire, or null if it never fired. */
  lastFiredAt: string | null;
  /** ISO timestamp of the NEXT scheduled fire, or null if unknown — distinguishes a
   *  just-activated loop awaiting its first fire (`pending`) from a stuck one (`stale`). */
  nextFireAt?: string | null;
  /**
   * WI-7069's sibling gap (EI-19370236916382521): `metadata.pause.reviewBy` on the routine
   * row (set via `routines:set { active:false, reviewBy }`) — the DARK_FLAGS_REVIEW_BY
   * analog for a deliberately-paused always-on loop. An ISO timestamp still in the future
   * means a human RE-AFFIRMED the pause (not merely left it inactive), so the sweep should
   * stop re-escalating it until the window lapses. Absent/past ⇒ unacknowledged, same as
   * before this field existed.
   */
  pauseReviewBy?: string | null;
}

/** A learning loop's identity: its blueprint id + the legacy `papercup`-slug routine name. */
export interface LearningLoopSpec {
  blueprintId: string;
  legacyRoutine: string;
}

export type LearningLoopStatus =
  | 'firing' // active + fired within the stale window
  | 'pending' // active + never fired but its first fire is still ahead (just armed)
  | 'stale' // active but has not fired in > the stale window (a wedge — investigate)
  | 'dark-by-design' // a frontier loop, inactive (expected until the owner arms it)
  | 'should-be-on-but-dark' // an ALWAYS-ON loop that is inactive (a real gap)
  | 'absent'; // no routine row seeded for this loop at all

export interface LearningLoopHealth {
  blueprintId: string;
  alwaysOn: boolean;
  /** The matched @singleton routine row (the canonical home), if present. */
  singletonRow: LearningRoutineRow | null;
  /** The legacy papercup-slug row, if still present. */
  legacyRow: LearningRoutineRow | null;
  /** BOTH a @singleton and a legacy row exist — the migration double-state (D-023). */
  collision: boolean;
  active: boolean;
  lastFiredAt: string | null;
  daysSinceFire: number | null;
  /** Optional domain-level activity ledger timestamp (for loops with a better ledger than routines). */
  activityLastAt: string | null;
  daysSinceActivity: number | null;
  activitySource: string | null;
  status: LearningLoopStatus;
  /**
   * Was this loop SUPPOSED to have a routine row? (EI-10625.) `absent` is the one
   * status that means "registration never happened" — a dark-by-design frontier loop
   * still HAS a row (inactive); no row at all means the materializer never ran for it.
   * That is a defect for every loop that is expected to exist, and it is NOT excused by
   * the loop being frontier/dark: darkness is a row's `active` flag, not its absence.
   *
   * The one legitimate absence: a Class-C platform-improvement loop on a deployment with
   * `PLATFORM_IMPROVEMENT_LOOPS` OFF is deliberately never materialized (P-070). Callers
   * inject that gate via `opts.expectedMaterialized`; the default is "expected".
   */
  expectedMaterialized: boolean;
  /**
   * EI-19370236916382521: status is `should-be-on-but-dark` AND the pause carries a
   * `pauseReviewBy` still in the future — a human explicitly RE-AFFIRMED the pause rather
   * than leaving it silently indefinite. Never true for any other status. Callers that
   * escalate on `should-be-on-but-dark` (the health-sweep watchdog) should skip a row with
   * `pauseAcknowledged: true` — that is the whole point of re-affirming: it stops the daily
   * re-escalation without forcing a resume.
   */
  pauseAcknowledged: boolean;
}

/** The workspace-singleton cadence routine name a blueprint materializes. */
export function singletonRoutineName(blueprintId: string): string {
  return `bp-singleton-${blueprintId}-0`;
}

/**
 * Classify each learning loop's routine health. A loop's routine may live at the
 * canonical `@singleton/bp-singleton-<id>-0` row OR (pre-migration) the legacy
 * `papercup/<legacyRoutine>` row; the @singleton row wins when both exist, and
 * BOTH existing is flagged as a `collision` (the exact double-state the migration
 * collision guards prevent).
 */
export function computeLearningLoopHealth(
  loops: readonly LearningLoopSpec[],
  routines: readonly LearningRoutineRow[],
  opts: {
    nowMs: number;
    staleAfterDays?: number;
    singletonHostSlug?: string;
    alwaysOn?: ReadonlySet<string>;
    /**
     * Per-blueprint domain activity. Use this only when a loop has a first-class
     * activity ledger that proves its body actually ran. Example: Scout has
     * scout_ticks; routine.last_fired_at can move when DBOS claimed the cron row
     * but the held dedup prevented the Scout body from recording a tick.
     */
    activityByBlueprintId?: Record<string, { lastActivityAt: string | null; source: string }>;
    /**
     * If routine.last_fired_at is newer than domain activity by more than this,
     * the scheduler claimed a fire that the loop body did not prove. Default 5m.
     */
    activityLagGraceMs?: number;
    /** Operator-home harness slug the legacy (per-home) learning row lives under. Defaults to
     *  the resolved operator home harness slug. */
    homeSlug?: string;
    /**
     * Is a routine row EXPECTED for this loop? (EI-10625.) Default: every declared
     * singleton is expected to be materialized. Inject the P-070 deployment gate here
     * — `(id) => platformLoopsOn || !isPlatformImprovementLoop(id)` — so a Class-C loop
     * that is deliberately not materialized on a platform-mode-OFF release reads as
     * absent-by-design instead of raising a false alarm. Kept as an injected predicate
     * rather than an import so this module stays pure.
     */
    expectedMaterialized?: (blueprintId: string) => boolean;
  },
): LearningLoopHealth[] {
  const staleMs = (opts.staleAfterDays ?? DEFAULT_LOOP_STALE_AFTER_DAYS) * DAY_MS;
  const singletonHost = opts.singletonHostSlug ?? SINGLETON_HOST_SLUG;
  const alwaysOnSet = opts.alwaysOn ?? ALWAYS_ON_LEARNING_LOOPS;
  const legacyHost = opts.homeSlug ?? operatorHomeHarnessSlug();
  return loops.map((loop) => {
    const sName = singletonRoutineName(loop.blueprintId);
    const singletonRow = routines.find((r) => r.installSlug === singletonHost && r.name === sName) ?? null;
    const legacyRow = routines.find((r) => r.installSlug === legacyHost && r.name === loop.legacyRoutine) ?? null;
    const row = singletonRow ?? legacyRow;
    const alwaysOn = alwaysOnSet.has(loop.blueprintId);
    const active = row?.active ?? false;
    const lastFiredAt = row?.lastFiredAt ?? null;
    const firedMs = lastFiredAt ? Date.parse(lastFiredAt) : NaN;
    const nextMs = row?.nextFireAt ? Date.parse(row.nextFireAt) : NaN;
    const daysSinceFire = Number.isNaN(firedMs) ? null : Math.floor((opts.nowMs - firedMs) / DAY_MS);
    const activity = opts.activityByBlueprintId?.[loop.blueprintId] ?? null;
    const activityLastAt = activity?.lastActivityAt ?? null;
    const activityMs = activityLastAt ? Date.parse(activityLastAt) : NaN;
    const daysSinceActivity = Number.isNaN(activityMs) ? null : Math.floor((opts.nowMs - activityMs) / DAY_MS);

    let status: LearningLoopStatus;
    if (!row) status = 'absent';
    else if (!active) status = alwaysOn ? 'should-be-on-but-dark' : 'dark-by-design';
    else if (Number.isNaN(firedMs)) {
      // Active but NEVER fired: `pending` if its first fire is still ahead (just
      // activated — e.g. prompt-ablation right after the frontier arming), `stale`
      // if that first fire is already overdue or unknown (a genuinely stuck fire path).
      status = !Number.isNaN(nextMs) && nextMs > opts.nowMs ? 'pending' : 'stale';
    } else if (!Number.isNaN(nextMs) && nextMs > opts.nowMs) {
      // A scheduled routine is healthy until its NEXT promised fire. Long-cadence
      // loops (for example the monthly IQ battery) legitimately exceed the generic
      // stale window between runs; last-fire age alone falsely pages them for most
      // of every month. If the engine wedges, next_fire_at remains in the past and
      // the stale-age fallback below still turns the loop red.
      status = 'firing';
    } else if (opts.nowMs - firedMs > staleMs) status = 'stale';
    else status = 'firing';

    if (active && activity) {
      if (Number.isNaN(activityMs) || opts.nowMs - activityMs > staleMs) status = 'stale';
      else if (!Number.isNaN(firedMs) && firedMs - activityMs > (opts.activityLagGraceMs ?? DEFAULT_ACTIVITY_LAG_GRACE_MS)) {
        status = 'stale';
      }
    }

    // EI-19370236916382521: only meaningful for `should-be-on-but-dark` — a re-affirmed
    // pause whose review window is still ahead. Computed from the winning row (singleton
    // preferred, same as `active`/`lastFiredAt` above) so a legacy-row reviewBy is honored
    // too until the migration retires it.
    const reviewByIso = status === 'should-be-on-but-dark' ? (row?.pauseReviewBy ?? null) : null;
    const reviewByMs = reviewByIso ? Date.parse(reviewByIso) : NaN;
    const pauseAcknowledged = !Number.isNaN(reviewByMs) && reviewByMs > opts.nowMs;

    return {
      blueprintId: loop.blueprintId,
      alwaysOn,
      singletonRow,
      legacyRow,
      collision: singletonRow !== null && legacyRow !== null,
      active,
      lastFiredAt,
      daysSinceFire,
      activityLastAt,
      daysSinceActivity,
      activitySource: activity?.source ?? null,
      pauseAcknowledged,
      status,
      expectedMaterialized: opts.expectedMaterialized?.(loop.blueprintId) ?? true,
    };
  });
}

/**
 * Classify a ROUTINE-LESS "activity-only" learning lane (su-ideate-learning-substrate
 * P-013). Some learning loops have no cadence routine at all — su-ideation is
 * judgment-in-the-loop (D-001: no su daemon), so its liveness is proven ONLY by domain
 * activity (its pass-ledger ticks + the ungraded-filings backstop-watchdog fires), never a
 * routine row. This folds one activity timestamp into the same {@link LearningLoopHealth}
 * shape so the lane sits beside the routine-backed loops on a health read:
 *   - never any activity → 'dark-by-design' (built, not yet turning — there is no routine
 *     to be "absent", and the lane is judgment-driven, so silence is not yet a wedge);
 *   - last activity within the stale window → 'firing';
 *   - last activity older than the stale window → 'stale' (it WAS turning and went quiet —
 *     the "a dead loop shows" signal {@link summarizeLearningLoopHealth} flags).
 */
export function computeActivityLaneHealth(
  lane: { blueprintId: string; lastActivityAt: string | null; source: string },
  opts: { nowMs: number; staleAfterDays?: number },
): LearningLoopHealth {
  const staleMs = (opts.staleAfterDays ?? DEFAULT_LOOP_STALE_AFTER_DAYS) * DAY_MS;
  const activityMs = lane.lastActivityAt ? Date.parse(lane.lastActivityAt) : NaN;
  const daysSinceActivity = Number.isNaN(activityMs)
    ? null
    : Math.floor((opts.nowMs - activityMs) / DAY_MS);
  let status: LearningLoopStatus;
  if (Number.isNaN(activityMs)) status = 'dark-by-design';
  else if (opts.nowMs - activityMs > staleMs) status = 'stale';
  else status = 'firing';
  return {
    blueprintId: lane.blueprintId,
    alwaysOn: false,
    singletonRow: null,
    legacyRow: null,
    collision: false,
    active: status === 'firing' || status === 'stale',
    lastFiredAt: null,
    daysSinceFire: null,
    activityLastAt: lane.lastActivityAt,
    daysSinceActivity,
    activitySource: lane.source,
    status,
    // A routine-less lane never carries a routine `pause` at all — reviewBy is
    // therefore never applicable, so this lane can never read as acknowledged.
    pauseAcknowledged: false,
    // A routine-less lane has no cadence row BY DESIGN (D-001: no su daemon), so it can
    // never be "never materialized" — it never classifies as `absent` either way.
    expectedMaterialized: false,
  };
}

/** A rollup for the tool summary + the "needs attention" partition. */
export interface LearningLoopHealthSummary {
  total: number;
  firing: number;
  pending: number;
  stale: number;
  darkByDesign: number;
  shouldBeOnButDark: number;
  absent: number;
  /**
   * Loops that were EXPECTED to have a routine row and have none (EI-10625) — i.e. the
   * materializer never ran for them. Distinct from `absent`, which also counts the one
   * benign case (a Class-C loop on a platform-mode-OFF release). This count is a
   * REGISTRATION FAILURE count: it should always be zero.
   */
  neverMaterialized: number;
  collisions: number;
  /**
   * Loops that warrant a look: always-on-but-dark, stale, a collision, or NEVER
   * MATERIALIZED (an expected loop with no routine row at all).
   */
  needsAttention: string[];
}

export function summarizeLearningLoopHealth(rows: readonly LearningLoopHealth[]): LearningLoopHealthSummary {
  // EI-10625 — A LOOP THAT DOES NOT EXIST IS NOT LESS URGENT THAN A LOOP THAT IS LATE.
  //
  // This filter used to admit an absent loop only `&& r.alwaysOn`, which silently excused
  // the never-materialized case for 13 of the 15 loops. That is how the memory recall
  // canary (EI-10047) sat DEAD ON ARRIVAL for its entire life: this very function
  // classified it `absent` correctly, every single time it was called — and then dropped
  // it from the only field anyone reads. The classification was never the problem; the
  // ACTION taken on it was. Absence is the most severe state a loop can be in, not the
  // most excusable: `dark-by-design` still HAS a row, so `absent` never means "dark", it
  // means the registration never happened. Gate it on EXPECTATION, never on always-on.
  const neverMaterialized = rows.filter((r) => r.status === 'absent' && r.expectedMaterialized);
  const needsAttention = rows
    .filter(
      (r) =>
        // EI-19370236916382521: a `should-be-on-but-dark` loop whose pause was explicitly
        // RE-AFFIRMED (pauseAcknowledged) is a resolved alarm, not an outstanding one — it
        // stays visible on the health read (status is unchanged) but drops out of the set
        // that pages/escalates, which is the whole point of re-affirming over resuming.
        (r.status === 'should-be-on-but-dark' && !r.pauseAcknowledged) ||
        r.status === 'stale' ||
        (r.status === 'absent' && r.expectedMaterialized) ||
        r.collision,
    )
    .map((r) => r.blueprintId);
  return {
    total: rows.length,
    firing: rows.filter((r) => r.status === 'firing').length,
    pending: rows.filter((r) => r.status === 'pending').length,
    stale: rows.filter((r) => r.status === 'stale').length,
    darkByDesign: rows.filter((r) => r.status === 'dark-by-design').length,
    shouldBeOnButDark: rows.filter((r) => r.status === 'should-be-on-but-dark').length,
    absent: rows.filter((r) => r.status === 'absent').length,
    neverMaterialized: neverMaterialized.length,
    collisions: rows.filter((r) => r.collision).length,
    needsAttention,
  };
}
