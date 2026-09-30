/**
 * Fingerprint-coverage detector — WI-7469, plan
 * semantic-search-fingerprint-coverage-2026-08-03 items P-008 / P-027 / P-006.
 *
 * THE DEFECT THIS EXISTS FOR: a semantic search running on 0.9% of its index is
 * byte-for-byte indistinguishable, from the outside, from a healthy one. It returns
 * results, it returns them fast, and they are plausible — they are simply drawn from a
 * near-empty vector space. Nothing in this system measured that, so the corpus starved
 * for weeks in silence and surfaced only as a human noticing their own recent work was
 * unfindable. The missing DETECTOR is the root defect; the empty index is its symptom.
 *
 * Three signals, off one sample per surface per tick:
 *
 *   1. ELIGIBLE-row coverage (P-027).       Is the corpus indexed?
 *   2. 24h-new-row coverage (P-008).        Is it STAYING indexed?      <- the recurrence catcher
 *   3. Drain rate vs write rate (P-006).    Is the sweep winning?
 *
 * WHY ELIGIBLE ROWS, NOT ALL ROWS (P-027 — this is the subtle one). Every surface's
 * eligibility is defined by its own `bodySql`, and two of them deliberately return ''
 * for some rows: `session_turns` skips turns under 80 chars, which is 18.4% of that
 * table — excluded BY DESIGN, unembeddable by construction. A "coverage < 95%" alarm
 * measured against the raw row count is therefore not merely inaccurate for that
 * surface, it is UNSATISFIABLE: it would sit red from the first tick to the heat death
 * of the process, be muted within a week, and be worth nothing on the day it finally
 * had something real to say. An alarm that cannot ever be green is worse than no alarm,
 * because it consumes the attention a real one would need.
 *
 * The eligibility and staleness predicates are IMPORTED from the sweep
 * (`eligiblePredicateSql` / `stalePredicateSql`), never restated here. A restated copy
 * is the same bug arriving later: someone edits a `bodySql`, the sweep's idea of its
 * own work changes, and the detector goes on measuring the old one while reporting
 * confident numbers.
 *
 * WHY "STALE" AND NOT "IS NULL". Coverage means "the sweep has nothing left to do",
 * which is `eligible AND NOT stale` — and staleness is about the vector's SPACE, not
 * merely its presence (WI-3616). Measured as `embedCol IS NOT NULL` this detector would
 * report ~100% coverage the instant the embedder mode changed under it, while every
 * stored vector belonged to a foreign space and every query ranked against noise. It
 * would be blindest during precisely the incident it exists to catch.
 *
 * SCOPE OF THE COUNTS: table-wide, matching the sweep, which is not workspace-scoped.
 * The `workspace_id` on a persisted sample identifies the OBSERVER, so one series does
 * not interleave with another host's — it does not scope the measurement.
 *
 * Read-only and best-effort: like the sibling periodic monitors it never throws, so it
 * cannot affect the system it watches.
 */
import { generated, getOrgPg } from '@papercusp/db-org';
import { desc, inArray } from 'drizzle-orm';
import { notifySyncInvalidate } from '../sync-sse';
import { activeWorkspaceId } from '../workspace-registry';
import {
  TARGETS,
  eligiblePredicateSql,
  modeColOf,
  recipeColOf,
  activeRecipeVersion,
  recentPredicateSql,
  resolveBackfillEmbedder,
  settledPredicateSql,
  stalePredicateSql,
  type BackfillTarget,
  type ResolvedMode,
} from './embed-backfill';

const TOAST_RING_BUFFER = 2000;

/** How far back the REPORTED "new rows" figure looks. Context, not the alarm input. */
export const RECENT_WINDOW_HOURS = 24;

/**
 * The window the recurrence alarm actually judges — and the distinction between this and
 * RECENT_WINDOW_HOURS is a correction, not a refinement.
 *
 * The first cut alarmed on the 24h aggregate. Measured live 2026-08-03T08:45Z, that
 * window spanned three unrelated populations at once — 13 hours of healthy 100% writes,
 * an 85.7% drain front, and a 5.7-10.9% starved band — averaged them to 67.5%, and
 * announced "new writes are NOT being indexed" while new writes were in fact at 100%.
 * The number was arithmetically correct and described nothing real.
 *
 * A short SETTLED window cannot make that mistake: it sits clear of a receding backlog
 * and asks only about rows the sweep has had time to service. See `settledPredicateSql`
 * for the measured hourly distribution and the one case where this still misreads.
 */
export const SETTLED_WINDOW_HOURS = 3;
/** Rows younger than this are legitimately unembedded — the sweep runs on a 5-min tick. */
export const SETTLED_GRACE_MINUTES = 15;

/**
 * Floors. Both are deliberately asymmetric, and the asymmetry is the design:
 *
 *  - TOTAL is a slow, backlog-shaped number. It moves over hours and is legitimately
 *    low during a drain, so its floor is loose AND it is suppressed while converging.
 *  - RECENT is a fast, steady-state number. If the write path and the sweep are both
 *    healthy it sits at 100%, so anything below 99% is a real regression, immediately.
 *    This is the signal that catches recurrence, and it is never suppressed.
 */
export const TOTAL_COVERAGE_FLOOR = 0.95;
export const RECENT_COVERAGE_FLOOR = 0.99;

/**
 * Below this many eligible rows written in the window, recent coverage is noise: 2 of 3
 * rows is 67% and means nothing. A quiet surface must not be able to alarm on a rounding
 * artifact.
 */
export const MIN_RECENT_SAMPLE = 20;

/**
 * P-006 tuning. A backlog that grows for ONE interval is a write burst — normal, and
 * alarming on it would train everyone to ignore this. A backlog that grows across three
 * consecutive samples is the sweep losing, which is the invariant violation.
 */
export const BACKLOG_GROWTH_SAMPLES = 3;
/** …and only once the backlog is big enough to matter (a 0 -> 5 blip on a tiny table is not news). */
export const MIN_BACKLOG_FOR_ALARM = 500;

/**
 * EI-19478208736094798 tuning — the STUCK-backlog leg.
 *
 * Same shape as BACKLOG_GROWTH_SAMPLES and for the same reason: the sweep applies a
 * per-target fairness cap and rotates target ORDER, so ONE interval in which a surface
 * cleared nothing is ordinary starvation, not a wedge. Three consecutive intervals is
 * longer than a full rotation, so it can only mean the sweep is not moving this surface
 * at all.
 */
export const BACKLOG_STUCK_SAMPLES = 3;
/**
 * …and only once the residue is big enough to matter. Deliberately far below
 * MIN_BACKLOG_FOR_ALARM (500): that floor guards a GROWING backlog, where the count is
 * on its way up anyway, whereas this leg's whole subject is a residue that is PERMANENT
 * and therefore never grows into a bigger floor. The measured incident stranded 3,441
 * rows, but a frozen predicate that admits a narrower band strands proportionally fewer,
 * and 50 stranded-forever rows is still a real hole in the index.
 */
export const MIN_BACKLOG_FOR_STUCK_ALARM = 50;

/** How many samples back the drain/growth analysis reads. */
export const HISTORY_DEPTH = BACKLOG_GROWTH_SAMPLES + 1;

/** Sample retention. 10 surfaces × 48 samples/day ≈ 15k rows/month; 30 days is bounded and cheap. */
export const SAMPLE_RETENTION_DAYS = 30;

/** '<schema>.<table>.<embedCol>' — a surface is a (table, embedding column) pair. */
export function surfaceKey(target: BackfillTarget): string {
  return `${target.table}.${target.embedCol}`;
}

export interface SurfaceCoverage {
  surface: string;
  table: string;
  embedCol: string;
  /** Every row, including ones that can never be embedded. Reported, never alarmed on. */
  totalRows: number;
  /** Rows the sweep would select: `length(bodySql) > 0`. */
  eligibleRows: number;
  /** Eligible AND not stale — i.e. embedded IN THE ACTIVE SPACE. */
  embeddedRows: number;
  /** Excluded by design (P-028 revisits whether the exclusions themselves are right). */
  ineligibleRows: number;
  /** Eligible rows the sweep still owes work on. */
  backlog: number;
  /** embeddedRows / eligibleRows; 1 when there is nothing to embed. */
  eligibleCoverage: number;
  recentWindowHours: number;
  /** null (not 0) when the surface carries no write-time column — absent, not empty. */
  recentEligible: number | null;
  recentEmbedded: number | null;
  /** REPORTED context over the 24h window. Deliberately NOT the alarm input. */
  recentCoverage: number | null;
  /** The alarm input: rows old enough to have been swept, young enough to be about the write path. */
  settledEligible: number | null;
  settledEmbedded: number | null;
  settledCoverage: number | null;
}

/** One interval's worth of the P-006 invariant, derived from two consecutive samples. */
export interface DrainObservation {
  surface: string;
  intervalSec: number;
  backlogPrev: number;
  backlogCur: number;
  /** > 0 means the backlog GREW over the interval: writes outran drains. */
  backlogDelta: number;
  /** Rows the sweep actually cleared in the interval. */
  drainedRows: number;
  /** Eligible rows written in the interval. */
  writtenEligible: number;
  drainPerMin: number;
  writePerMin: number;
  /** The invariant itself: drain >= write. */
  holds: boolean;
}

export type CoverageBreachKind =
  | 'total-coverage'
  | 'recent-coverage'
  | 'backlog-growing'
  | 'backlog-stuck';

export interface CoverageBreach {
  surface: string;
  kind: CoverageBreachKind;
  observed: number;
  floor: number;
  detail: string;
}

/**
 * One persisted observation. Shape mirrors harness_shared.embed_coverage_samples.
 *
 * ⚠ The table's `recent_*` columns hold the 24h REPORTED figures, not the settled-window
 * alarm input — migration 746's own comment calls them "the recurrence signal", which was
 * true when it was written and stopped being true an hour later when live measurement
 * showed the 24h aggregate cannot serve as one. The migration is already APPLIED, so its
 * bytes must NOT be edited (that is `content_drift` — the edit never executes and no
 * restart runs it; db:check_drift flags it). The correction lives here instead.
 *
 * Only `eligibleRows`/`embeddedRows` feed the P-006 rate analysis, and those are
 * unambiguous; the settled figures are evaluated instantaneously and need no history.
 */
export interface CoverageSample {
  surface: string;
  observedAt: Date;
  totalRows: number;
  eligibleRows: number;
  embeddedRows: number;
  recentEligible: number | null;
  recentEmbedded: number | null;
}

// ---------------------------------------------------------------------------
// SQL construction (pure — unit-testable without a database)
// ---------------------------------------------------------------------------

export interface CoverageQuery {
  sql: string;
  /** Concrete scalars, not `unknown[]` — postgres.js's Bind signature rejects the latter. */
  params: Array<string | number>;
  /** False when the target has no write-time column, so the recent columns are absent. */
  hasRecent: boolean;
}

/**
 * Build the single counting query for one surface.
 *
 * Placeholders are allocated ON DEMAND rather than at fixed positions. That is not
 * fussiness: Postgres derives a statement's parameter COUNT from the highest `$n` it
 * REFERENCES and rejects a Bind supplying one the statement never uses ("could not
 * determine data type of parameter $n"). A surface with no mode column doesn't reference
 * the mode, and one with no write-time column doesn't reference the window — so a fixed
 * `[mode, hours]` array would fail on exactly those surfaces and nowhere else, i.e. it
 * would pass every test written against the common case. The sweep hit this same trap
 * (see `updateKeyOffset` in embed-backfill.ts) and its comment says the same thing:
 * never bind a parameter you do not use.
 */
export function buildCoverageQuery(
  target: BackfillTarget,
  spaceAware: boolean,
  mode: ResolvedMode,
  windowHours: number = RECENT_WINDOW_HOURS,
  recipeColPresent = false,
): CoverageQuery {
  const params: Array<string | number> = [];
  const bind = (v: string | number): string => {
    params.push(v);
    return `$${params.length}`;
  };

  const eligible = eligiblePredicateSql(target);
  // P-026: coverage must BIND THE SAME recipe version the sweep enforces, not merely
  // reuse the same predicate builder. Sharing the SQL is not enough when the bound VALUE
  // can differ — and this surface fails in the direction that misattributes blame: bind
  // nothing here while the sweep enforces recipe 2 and every re-embedded row still counts
  // as stale, so coverage reads 0% for a sweep that is working perfectly.
  const recipeVersion = activeRecipeVersion(target, recipeColPresent);
  const stale = stalePredicateSql(
    target,
    spaceAware,
    spaceAware ? bind(mode) : 'NULL',
    recipeVersion === null ? null : bind(recipeVersion),
  );
  const recent = target.recencyCol ? recentPredicateSql(target, bind(windowHours)) : null;
  const settled = target.recencyCol
    ? settledPredicateSql(target, bind(SETTLED_GRACE_MINUTES), bind(SETTLED_WINDOW_HOURS))
    : null;

  const cols = [
    `count(*)::bigint AS total_rows`,
    `count(*) FILTER (WHERE ${eligible})::bigint AS eligible_rows`,
    `count(*) FILTER (WHERE ${eligible} AND NOT (${stale}))::bigint AS embedded_rows`,
  ];
  if (recent && settled) {
    cols.push(
      `count(*) FILTER (WHERE ${eligible} AND ${recent})::bigint AS recent_eligible`,
      `count(*) FILTER (WHERE ${eligible} AND ${recent} AND NOT (${stale}))::bigint AS recent_embedded`,
      `count(*) FILTER (WHERE ${eligible} AND ${settled})::bigint AS settled_eligible`,
      `count(*) FILTER (WHERE ${eligible} AND ${settled} AND NOT (${stale}))::bigint AS settled_embedded`,
    );
  }

  return {
    sql: `SELECT ${cols.join(', ')} FROM ${target.table}`,
    params,
    hasRecent: recent !== null,
  };
}

// ---------------------------------------------------------------------------
// Analysis (pure)
// ---------------------------------------------------------------------------

function ratio(numerator: number, denominator: number): number {
  // An empty denominator is FULLY covered, not 0% covered. A surface with nothing to
  // embed has no deficit, and returning 0 here would alarm on every empty table forever.
  return denominator === 0 ? 1 : numerator / denominator;
}

/** Turn one raw row of counts into a SurfaceCoverage. Pure. */
export function toSurfaceCoverage(
  target: BackfillTarget,
  counts: {
    totalRows: number;
    eligibleRows: number;
    embeddedRows: number;
    recentEligible: number | null;
    recentEmbedded: number | null;
    settledEligible?: number | null;
    settledEmbedded?: number | null;
  },
  windowHours: number = RECENT_WINDOW_HOURS,
): SurfaceCoverage {
  const { totalRows, eligibleRows, embeddedRows, recentEligible, recentEmbedded } = counts;
  const settledEligible = counts.settledEligible ?? null;
  const settledEmbedded = counts.settledEmbedded ?? null;
  return {
    surface: surfaceKey(target),
    table: target.table,
    embedCol: target.embedCol,
    totalRows,
    eligibleRows,
    embeddedRows,
    ineligibleRows: totalRows - eligibleRows,
    backlog: eligibleRows - embeddedRows,
    eligibleCoverage: ratio(embeddedRows, eligibleRows),
    recentWindowHours: windowHours,
    recentEligible,
    recentEmbedded,
    recentCoverage:
      recentEligible === null || recentEmbedded === null ? null : ratio(recentEmbedded, recentEligible),
    settledEligible,
    settledEmbedded,
    settledCoverage:
      settledEligible === null || settledEmbedded === null ? null : ratio(settledEmbedded, settledEligible),
  };
}

/**
 * The P-006 invariant, measured across the two most recent samples of a surface.
 *
 * The decomposition is exact and needs no instrumentation on the sweep itself:
 *
 *     backlog(t) - backlog(t-1) = (eligible rows written) - (rows drained)
 *
 * Returns null when there is no prior sample, or when the interval is non-positive
 * (clock skew / a duplicate sample) — an unmeasurable rate must read as ABSENT, never
 * as zero, or "no data" becomes indistinguishable from "the sweep did nothing".
 */
export function computeDrain(samples: CoverageSample[]): DrainObservation | null {
  if (samples.length < 2) return null;
  const [cur, prev] = samples; // newest-first
  if (!cur || !prev) return null;
  const intervalMs = cur.observedAt.getTime() - prev.observedAt.getTime();
  if (intervalMs <= 0) return null;
  const intervalMin = intervalMs / 60_000;

  const backlogPrev = prev.eligibleRows - prev.embeddedRows;
  const backlogCur = cur.eligibleRows - cur.embeddedRows;
  const drainedRows = cur.embeddedRows - prev.embeddedRows;
  const writtenEligible = cur.eligibleRows - prev.eligibleRows;

  return {
    surface: cur.surface,
    intervalSec: Math.round(intervalMs / 1000),
    backlogPrev,
    backlogCur,
    backlogDelta: backlogCur - backlogPrev,
    drainedRows,
    writtenEligible,
    drainPerMin: drainedRows / intervalMin,
    writePerMin: writtenEligible / intervalMin,
    holds: backlogCur <= backlogPrev,
  };
}

/**
 * How many consecutive most-recent intervals the surface cleared ZERO rows while a
 * backlog existed — the STUCK signature (EI-19478208736094798).
 *
 * Counts `drainedRows === 0`, NOT `backlogDelta === 0`. The two differ exactly where it
 * matters: a surface that embedded 100 rows while 100 new eligible rows arrived has
 * delta 0 and is perfectly healthy churn, whereas drained 0 means the sweep put nothing
 * into the index at all. Only the second is "work existed and the worker produced
 * nothing", which is the same unambiguous question the parts-writer guard asks.
 */
export function consecutiveBacklogStuck(samples: CoverageSample[]): number {
  let n = 0;
  for (let i = 0; i + 1 < samples.length; i += 1) {
    const newer = samples[i]!;
    const older = samples[i + 1]!;
    const backlogNewer = newer.eligibleRows - newer.embeddedRows;
    const drained = newer.embeddedRows - older.embeddedRows;
    if (backlogNewer > 0 && drained === 0) n += 1;
    else break;
  }
  return n;
}

/** How many consecutive most-recent intervals the backlog GREW across. */
export function consecutiveBacklogGrowth(samples: CoverageSample[]): number {
  let n = 0;
  for (let i = 0; i + 1 < samples.length; i += 1) {
    const newer = samples[i]!;
    const older = samples[i + 1]!;
    const backlogNewer = newer.eligibleRows - newer.embeddedRows;
    const backlogOlder = older.eligibleRows - older.embeddedRows;
    if (backlogNewer > backlogOlder) n += 1;
    else break;
  }
  return n;
}

export interface BreachInput {
  coverage: SurfaceCoverage;
  /** Newest-first history INCLUDING the current sample. */
  history: CoverageSample[];
}

/**
 * Pure breach detection.
 *
 * The total-coverage rule is the one worth reading twice. It fires only when coverage is
 * low AND the backlog is NOT shrinking. Without that second clause the alarm would be
 * red for the entire multi-hour backfill this plan exists to run — a known, expected,
 * actively-converging state — and would be muted long before it meant anything. That is
 * the identical failure P-027 identifies for the ineligible-row denominator, reached by a
 * different route, so it gets the same treatment.
 *
 * With ONE sample and no history, convergence is unknowable, and the honest response to
 * an unknowable precondition is to withhold the alarm rather than guess. The recent-row
 * signal below has no such dependency and covers the gap.
 */
export function detectCoverageBreaches(inputs: BreachInput[]): CoverageBreach[] {
  const breaches: CoverageBreach[] = [];

  for (const { coverage: c, history } of inputs) {
    // 1. Recurrence catcher. Independent of history, never suppressed.
    //
    // Judged on the SETTLED window, not the 24h figure. The 24h aggregate spans a
    // receding backlog and reports a number that describes neither population — it read
    // 67.5% on live data while the write path was at 100%, and said so out loud.
    if (
      c.settledCoverage !== null &&
      c.settledEligible !== null &&
      c.settledEligible >= MIN_RECENT_SAMPLE &&
      c.settledCoverage < RECENT_COVERAGE_FLOOR
    ) {
      breaches.push({
        surface: c.surface,
        kind: 'recent-coverage',
        observed: c.settledCoverage,
        floor: RECENT_COVERAGE_FLOOR,
        detail:
          `${c.settledEmbedded}/${c.settledEligible} rows written between ` +
          `${SETTLED_GRACE_MINUTES}min and ${SETTLED_WINDOW_HOURS}h ago are embedded — ` +
          `new writes are NOT being indexed` +
          (c.recentCoverage === null
            ? ''
            : ` (24h context: ${(c.recentCoverage * 100).toFixed(1)}%, which also reflects ` +
              `any historical backlog still draining)`),
      });
    }

    const drain = computeDrain(history);

    // 2. Corpus coverage, suppressed while genuinely converging.
    if (c.eligibleCoverage < TOTAL_COVERAGE_FLOOR) {
      const converging = drain !== null && drain.backlogDelta < 0;
      const judgeable = drain !== null;
      if (judgeable && !converging) {
        breaches.push({
          surface: c.surface,
          kind: 'total-coverage',
          observed: c.eligibleCoverage,
          floor: TOTAL_COVERAGE_FLOOR,
          detail:
            `${c.embeddedRows}/${c.eligibleRows} eligible rows embedded and the backlog is ` +
            `not shrinking (${c.backlog} rows outstanding)`,
        });
      }
    }

    // 4. EI-19478208736094798: the backlog that is STUCK rather than growing.
    //
    // WHY THIS LEG EXISTS — the other three are each structurally blind to it, so the
    // measured incident passed all of them. A 16h-lived refill driver imported
    // embed-backfill ONCE at boot; the P-028 predicate widening landed in that file
    // mid-run; the process kept sweeping under its module-cached OLD bodySql, correctly
    // found nothing left under THAT definition, and logged "DONE". 3,441 rows newly
    // eligible under current code were stranded — and:
    //   • leg 1 judges the SETTLED 15min-3h window, and those rows were OLD (bg-host,
    //     running fresh code, embedded new writes correctly the whole time);
    //   • leg 2 needs coverage < 95% and it measured 99.043% (3,441 / 359,665 eligible);
    //   • leg 3 needs STRICT growth and a frozen backlog has delta 0.
    // Raising leg 2's floor past 99.04% is NOT the fix: it would fire on ordinary
    // ingestion lag and after every planned re-embed, i.e. the alert fatigue D-006
    // exists to prevent. The discriminator a ratio cannot supply is whether the residue
    // is MOVING — 99% draining and 99% stranded-forever are the same number.
    //
    // Cannot false-alarm on a legitimate multi-hour backfill: that state drains rows
    // every interval, so `drainedRows` is non-zero and this never arms.
    const stuck = consecutiveBacklogStuck(history);
    if (stuck >= BACKLOG_STUCK_SAMPLES && c.backlog >= MIN_BACKLOG_FOR_STUCK_ALARM) {
      breaches.push({
        surface: c.surface,
        kind: 'backlog-stuck',
        observed: c.backlog,
        floor: MIN_BACKLOG_FOR_STUCK_ALARM,
        detail:
          `${c.backlog} eligible rows have gone unembedded across ${stuck} consecutive ` +
          `intervals with ZERO rows cleared — the backlog is not growing and not draining, ` +
          `it is STRANDED, so no coverage-ratio floor will ever catch it. Most likely a ` +
          `long-lived process running a module-cached copy of embed-backfill older than the ` +
          `tree: it sweeps to exhaustion under its OWN frozen bodySql and reports "DONE" ` +
          `truthfully, while rows newly eligible under current code are invisible to it. ` +
          `A DEPLOY DOES NOT FIX THAT — check the age of any refill driver and of ` +
          `papercup-bg-host against the commit time of embed-backfill.ts, and restart the ` +
          `stale one.`,
      });
    }

    // 3. P-006: the invariant, violated across consecutive intervals.
    const growth = consecutiveBacklogGrowth(history);
    if (growth >= BACKLOG_GROWTH_SAMPLES && c.backlog >= MIN_BACKLOG_FOR_ALARM) {
      breaches.push({
        surface: c.surface,
        kind: 'backlog-growing',
        observed: c.backlog,
        floor: MIN_BACKLOG_FOR_ALARM,
        detail:
          `backlog grew across ${growth} consecutive samples (now ${c.backlog} rows` +
          (drain
            ? `; drain ${drain.drainPerMin.toFixed(1)}/min vs write ${drain.writePerMin.toFixed(1)}/min`
            : '') +
          `) — the sweep is not keeping up with writes`,
      });
    }
  }

  return breaches;
}

/** Toast body for a set of breaches. Pure. */
export function formatCoverageToast(breaches: CoverageBreach[]): {
  level: string;
  message: string;
  description: string;
} {
  const lines = breaches
    .map((b) => {
      // Both backlog legs report a ROW COUNT; the coverage legs report a ratio. Getting
      // this wrong renders a 3,441-row breach as "344100.0%".
      const obs =
        b.kind === 'backlog-growing' || b.kind === 'backlog-stuck'
          ? `${b.observed} rows`
          : `${(b.observed * 100).toFixed(1)}%`;
      return `• [${b.kind}] ${b.surface}: ${obs} — ${b.detail}`;
    })
    .join('\n');
  return {
    level: 'warning',
    message: `Embedding coverage alarm — ${breaches.length} surface signal(s) breached`,
    description:
      `Semantic search silently degrades to a near-empty vector index when these go unwatched ` +
      `(a search over 1% of its corpus looks exactly like a healthy one):\n${lines}\n\n` +
      `Coverage is measured over ELIGIBLE rows only — rows a surface's bodySql excludes by design ` +
      `are never counted against it. Inspect with the embed-backfill admin route; kill-switch ` +
      `PAPERCUSP_EMBED_COVERAGE_ALARM=0.`,
  };
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

export interface CoverageDeps {
  /** Injectable for tests — defaults to the live per-surface count queries. */
  measure?: () => Promise<SurfaceCoverage[]>;
  /** Injectable for tests — newest-first history per surface, EXCLUDING the current sample. */
  loadHistory?: (surfaces: string[]) => Promise<Map<string, CoverageSample[]>>;
  /** Injectable for tests — persist this tick's samples. */
  persist?: (samples: CoverageSample[]) => Promise<void>;
  /** Injectable for tests — defaults to a toast_log row + sync invalidate. */
  emitToast?: (t: { level: string; message: string; description: string }) => Promise<void>;
}

async function probeSurface(
  sql: ReturnType<typeof getOrgPg>['sql'],
  target: BackfillTarget,
): Promise<{ present: boolean; spaceAware: boolean; recipeColPresent: boolean }> {
  const rows = await sql.unsafe<Array<{ column_name: string }>>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = split_part($1, '.', 1)
        AND table_name   = split_part($1, '.', 2)
        AND column_name IN ($2, $3, $4)`,
    [target.table, target.embedCol, modeColOf(target), recipeColOf(target)],
  );
  const cols = new Set(rows.map((r) => r.column_name));
  return {
    present: cols.has(target.embedCol),
    spaceAware: cols.has(modeColOf(target)),
    recipeColPresent: cols.has(recipeColOf(target)),
  };
}

/** Measure every surface against the live database. */
export async function measureCoverage(windowHours: number = RECENT_WINDOW_HOURS): Promise<SurfaceCoverage[]> {
  const resolved = await resolveBackfillEmbedder();
  const mode: ResolvedMode = resolved.mode;
  const { sql } = getOrgPg();
  const out: SurfaceCoverage[] = [];

  for (const target of TARGETS) {
    try {
      const { present, spaceAware, recipeColPresent } = await probeSurface(sql, target);
      // A surface whose embedding column does not exist yet (migration not run against
      // THIS database) is not at 0% coverage — it is unmeasurable. Omit it rather than
      // report a 0 that would alarm on a schema state, not a data state.
      if (!present) continue;

      const q = buildCoverageQuery(target, spaceAware, mode, windowHours, recipeColPresent);
      const rows = await sql.unsafe<Array<Record<string, string | null>>>(q.sql, q.params);
      const r = rows[0];
      if (!r) continue;
      const num = (v: string | null | undefined): number => Number(v ?? 0);
      out.push(
        toSurfaceCoverage(
          target,
          {
            totalRows: num(r.total_rows),
            eligibleRows: num(r.eligible_rows),
            embeddedRows: num(r.embedded_rows),
            recentEligible: q.hasRecent ? num(r.recent_eligible) : null,
            recentEmbedded: q.hasRecent ? num(r.recent_embedded) : null,
            settledEligible: q.hasRecent ? num(r.settled_eligible) : null,
            settledEmbedded: q.hasRecent ? num(r.settled_embedded) : null,
          },
          windowHours,
        ),
      );
    } catch (err) {
      // Per-surface isolation, mirroring the sweep: one broken surface must not blind
      // the detector to the other nine.
      console.warn(
        `[embed-coverage] skipped ${surfaceKey(target)} (non-fatal): ${(err as Error)?.message ?? String(err)}`,
      );
    }
  }
  return out;
}

async function defaultLoadHistory(surfaces: string[]): Promise<Map<string, CoverageSample[]>> {
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const rows = await sql.unsafe<
    Array<{
      surface: string;
      observed_at: Date;
      total_rows: string;
      eligible_rows: string;
      embedded_rows: string;
      recent_eligible: string | null;
      recent_embedded: string | null;
    }>
  >(
    `SELECT surface, observed_at, total_rows, eligible_rows, embedded_rows,
            recent_eligible, recent_embedded
       FROM (
         SELECT *, row_number() OVER (PARTITION BY surface ORDER BY observed_at DESC) AS rn
           FROM harness_shared.embed_coverage_samples
          WHERE workspace_id = $1 AND surface = ANY($2)
       ) s
      WHERE rn <= $3
      ORDER BY surface, observed_at DESC`,
    [ws, surfaces, HISTORY_DEPTH],
  );
  const bySurface = new Map<string, CoverageSample[]>();
  for (const r of rows) {
    const list = bySurface.get(r.surface) ?? [];
    list.push({
      surface: r.surface,
      observedAt: new Date(r.observed_at),
      totalRows: Number(r.total_rows),
      eligibleRows: Number(r.eligible_rows),
      embeddedRows: Number(r.embedded_rows),
      recentEligible: r.recent_eligible === null ? null : Number(r.recent_eligible),
      recentEmbedded: r.recent_embedded === null ? null : Number(r.recent_embedded),
    });
    bySurface.set(r.surface, list);
  }
  return bySurface;
}

async function defaultPersist(samples: CoverageSample[]): Promise<void> {
  if (samples.length === 0) return;
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  for (const s of samples) {
    await sql.unsafe(
      `INSERT INTO harness_shared.embed_coverage_samples
         (workspace_id, observed_at, surface, total_rows, eligible_rows, embedded_rows,
          recent_eligible, recent_embedded, recent_window_hours)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        ws,
        s.observedAt.toISOString(),
        s.surface,
        s.totalRows,
        s.eligibleRows,
        s.embeddedRows,
        s.recentEligible,
        s.recentEmbedded,
        RECENT_WINDOW_HOURS,
      ],
    );
  }
  await sql.unsafe(
    `DELETE FROM harness_shared.embed_coverage_samples
      WHERE workspace_id = $1 AND observed_at < now() - make_interval(days => $2::int)`,
    [ws, SAMPLE_RETENTION_DAYS],
  );
}

async function defaultEmitToast(t: { level: string; message: string; description: string }): Promise<void> {
  const tl = generated.toastLogInHarnessShared;
  const { db } = getOrgPg();
  await db.insert(tl).values({
    level: t.level,
    message: t.message,
    description: t.description,
    harnessSlug: null,
    createdAt: Date.now(),
    actionLabel: null,
    actionHref: null,
  });
  // Bound the ring buffer (mirrors storage-growth-alarm / agent-governor-observer).
  void (async () => {
    const stale = await db.select({ id: tl.id }).from(tl).orderBy(desc(tl.createdAt)).offset(TOAST_RING_BUFFER);
    if (stale.length > 0) await db.delete(tl).where(inArray(tl.id, stale.map((r) => r.id)));
  })().catch(() => {});
  void notifySyncInvalidate('toastLog.recent', undefined).catch(() => {});
}

/**
 * The same toast path, shared with the P-004 injection-reach alarm
 * (`../memory/injection-coverage`) so the two alarms cannot drift into two different
 * notification mechanisms for the same measurement pass. Pure re-export of the default
 * emitter — this module's behaviour is unchanged.
 */
export const emitCoverageToast = defaultEmitToast;

export interface CoverageAlarmResult {
  surfaces: SurfaceCoverage[];
  drains: DrainObservation[];
  breaches: CoverageBreach[];
}

/**
 * One read-only pass: measure every surface, persist the sample, evaluate the three
 * signals, toast on a breach. Never throws.
 */
export async function runEmbedCoverageAlarmOnce(deps: CoverageDeps = {}): Promise<CoverageAlarmResult> {
  const measure = deps.measure ?? (() => measureCoverage());
  const loadHistory = deps.loadHistory ?? defaultLoadHistory;
  const persist = deps.persist ?? defaultPersist;
  const emitToast = deps.emitToast ?? defaultEmitToast;

  let surfaces: SurfaceCoverage[] = [];
  try {
    surfaces = await measure();
  } catch (err) {
    console.warn(`[embed-coverage] measurement skipped (non-fatal): ${(err as Error)?.message ?? String(err)}`);
    return { surfaces: [], drains: [], breaches: [] };
  }
  if (surfaces.length === 0) return { surfaces: [], drains: [], breaches: [] };

  const observedAt = new Date();
  const current: CoverageSample[] = surfaces.map((c) => ({
    surface: c.surface,
    observedAt,
    totalRows: c.totalRows,
    eligibleRows: c.eligibleRows,
    embeddedRows: c.embeddedRows,
    recentEligible: c.recentEligible,
    recentEmbedded: c.recentEmbedded,
  }));

  let prior = new Map<string, CoverageSample[]>();
  try {
    prior = await loadHistory(surfaces.map((s) => s.surface));
  } catch (err) {
    // History is an ENHANCEMENT to the analysis, not a precondition for it: without it
    // the recent-row signal still works and the two history-dependent rules correctly
    // withhold rather than guess.
    console.warn(`[embed-coverage] history read failed (non-fatal): ${(err as Error)?.message ?? String(err)}`);
  }

  const inputs: BreachInput[] = surfaces.map((coverage) => {
    const cur = current.find((s) => s.surface === coverage.surface)!;
    return { coverage, history: [cur, ...(prior.get(coverage.surface) ?? [])] };
  });

  const drains = inputs
    .map((i) => computeDrain(i.history))
    .filter((d): d is DrainObservation => d !== null);
  const breaches = detectCoverageBreaches(inputs);

  try {
    await persist(current);
  } catch (err) {
    console.warn(`[embed-coverage] sample persist failed (non-fatal): ${(err as Error)?.message ?? String(err)}`);
  }

  if (breaches.length > 0) {
    try {
      await emitToast(formatCoverageToast(breaches));
    } catch (err) {
      console.warn(`[embed-coverage] toast emit failed (non-fatal): ${(err as Error)?.message ?? String(err)}`);
    }
  }

  return { surfaces, drains, breaches };
}
