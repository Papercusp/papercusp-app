/**
 * signal-accumulator.ts — the VOLUME-BASED Scout firing substrate
 * (blender-self-learning-2026-07-12 P-001 / WI-4317).
 *
 * THE PROBLEM: the Scout cadence gate fires on a TIME heartbeat (cadence.ts
 * maxIntervalSec 3600) regardless of whether any NEW signal accumulated since
 * the last cycle. On a quiet pot that burns budget re-digesting a stale corpus
 * — the ideators re-see the same standing patterns, re-pitch the same ideas,
 * and the dedup critic declines them (the stale-repetition → dedup-decline
 * churn behind a large chunk of the routed-vs-ledger gap). On a BUSY pot the
 * hourly clock is equally wrong in the other direction: signal piles up for an
 * hour before anyone synthesizes it. The owner's ruling (2026-07-12): firing
 * should be DATA-VOLUME based — "sometimes agents are very active so there is
 * a lot of new data … sometimes they are not active so there isn't new data".
 *
 * THE MECHANISM (deterministic, zero-token): its own durable two-minute routine RECOUNTS
 * per-lane "new signal since the last SUCCESSFUL Scout cycle" from the source
 * tables and caches the counts in harness_shared.scout_signal_accumulator
 * (migration 582) — one row per (workspace, install, lane). The watermark is
 * DERIVED from scout_ticks (status='ran'; the same EI-1600 clock the cadence
 * floor uses), never incremented, so the cache is self-healing and safe to
 * truncate (scout_lens_weights' cache-of-a-derivation contract). The cadence
 * gate (P-002 / WI-4318) consumes the counts as a weighted score; a score of 0
 * NEVER fires. The delta-first digest rendering (P-003 / WI-4319) reads the
 * same watermark for its "NEW since your last cycle" leg.
 *
 * LANES + per-lane precision (the counts are a firing SIGNAL, not accounting —
 * each lane uses the best deterministic proxy the schema affords):
 *   - scorecard-rating-changes  EXACT: new rubric-graded observation criteria
 *     whose rating DIFFERS from that criterion's most recent prior grade (a
 *     re-grade at the same rating is NOT new signal; a first-ever grade is).
 *   - observations   EXACT: observation FILINGS since the watermark — the
 *     GREATER of (a) new engineer_issues rows carrying an observation and
 *     (b) work_item_occurrences appended against such a row. See the
 *     "counting filings, not rows" note on readLaneCounts for why the row
 *     count alone stopped being safe once captures could fold.
 *   - captures       EXACT: new engineer_issues rows NOT carrying one (bug /
 *     feature / improvement filings).
 *   - completions    PROXY: work_items in a terminal-success status whose
 *     updated_ts moved past the watermark (a post-completion touch re-counts —
 *     stable across sweeps, never drifts).
 *   - reverts        PROXY: work_items whose claim was RELEASED back past the
 *     watermark (last_released_at — bounced work is the revert-shaped signal
 *     the schema records; true state-regressions have no event trail).
 *   - deferrals      PROXY: work_items in blocked / deprecated / needs-human
 *     whose updated_ts moved past the watermark.
 *
 * Same fail-soft watchdog-family shape as ungraded-filings-watchdog.ts: pure
 * deciders split from the PG sweep, env-tunable knobs with kill switches,
 * never throws into the routines tick. DEFAULT-SAFE: the sweep only writes a
 * cache table nothing consumes until the P-002 gate ships.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { listBlenderMaintenanceScopes, listBlenderMaintenanceWorkspaceIds } from '../pot/started';
import { readLastRanTickAtMs } from './tick-ledger';

// ── lanes ─────────────────────────────────────────────────────────────────────

export const SIGNAL_LANES = [
  'scorecard-rating-changes',
  'observations',
  'captures',
  'reverts',
  'deferrals',
  'completions',
] as const;
export type SignalLane = (typeof SIGNAL_LANES)[number];

/** The P-002 gate's default weighted-score coefficients (approved design:
 *  3× scorecard-changes, 2× observations, 1× captures, 3× reverts,
 *  1× deferrals, 0.5× completions). Kept HERE, next to the lanes they weight,
 *  so the cadence gate and its tests share one source of truth. Tunable
 *  per-routine via the cadence payload (WI-4318). */
export const DEFAULT_LANE_WEIGHTS: Readonly<Record<SignalLane, number>> = {
  'scorecard-rating-changes': 3,
  observations: 2,
  captures: 1,
  reverts: 3,
  deferrals: 1,
  completions: 0.5,
};

// ── tunables (env-overridable, watchdog-family idiom) ─────────────────────────

/** Bounded lookback floor for a scope whose Scout NEVER ran (watermark would
 *  otherwise be epoch and the recount would scan whole tables). Default 7d;
 *  env PAPERCUSP_SIGNAL_ACCUM_LOOKBACK_SEC; `<=0` DISABLES the whole sweep
 *  (kill switch). */
export function signalAccumulatorLookbackSec(): number {
  const n = Number(process.env.PAPERCUSP_SIGNAL_ACCUM_LOOKBACK_SEC ?? 604_800);
  return Number.isFinite(n) ? n : 604_800;
}

/** In-process backstop throttle between full recount sweeps. The durable routine
 *  fires every two minutes by default; this guard also protects on-demand calls
 *  and replayed fires from recounting more frequently. Default 120s; env
 *  PAPERCUSP_SIGNAL_ACCUM_SWEEP_SEC. */
export function signalAccumulatorSweepSec(): number {
  const n = Number(process.env.PAPERCUSP_SIGNAL_ACCUM_SWEEP_SEC ?? 120);
  return Number.isFinite(n) && n >= 0 ? n : 120;
}

// ── pure deciders (unit-tested with no DB) ────────────────────────────────────

/**
 * PURE: the recount baseline for a scope. The watermark is the last successful
 * Scout cycle, FLOORED by the bounded lookback (a never-ran scope counts the
 * recent window, not all history; an ancient last-run doesn't scan months).
 */
export function effectiveWatermarkMs(lastRanAtMs: number | null, nowMs: number, lookbackSec: number): number {
  const floor = nowMs - Math.max(0, lookbackSec) * 1_000;
  if (lastRanAtMs == null || !Number.isFinite(lastRanAtMs)) return floor;
  return Math.max(lastRanAtMs, floor);
}

/**
 * PURE: the weighted new-signal score the P-002 cadence gate consumes. Missing
 * lanes count 0; unknown lanes are ignored; a negative count is clamped to 0
 * (a corrupt cache row must not produce a negative score that masks real
 * signal in other lanes).
 */
export function weightedSignalScore(
  counts: Partial<Record<string, number>>,
  weights: Readonly<Record<SignalLane, number>> = DEFAULT_LANE_WEIGHTS,
): number {
  let score = 0;
  for (const lane of SIGNAL_LANES) {
    const c = counts[lane];
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) score += c * weights[lane];
  }
  return score;
}

/** PURE: should the sweep run this tick? (in-process throttle) */
export function shouldSweepNow(lastSweepAtMs: number | null, nowMs: number, sweepSec: number): boolean {
  if (lastSweepAtMs == null) return true;
  return nowMs - lastSweepAtMs >= sweepSec * 1_000;
}

// ── the PG recount ────────────────────────────────────────────────────────────

export interface LaneCount {
  lane: SignalLane;
  newCount: number;
  /** Newest signal timestamp seen in the lane (null when the lane is empty). */
  highWaterAt: Date | null;
}

interface CountRow {
  c: number | string | null;
  hw: Date | string | null;
}

function toLaneCount(lane: SignalLane, rows: readonly CountRow[]): LaneCount {
  const r = rows[0];
  const c = r ? Number(r.c ?? 0) : 0;
  const hwRaw = r?.hw ?? null;
  const hw = hwRaw == null ? null : hwRaw instanceof Date ? hwRaw : new Date(hwRaw);
  return {
    lane,
    newCount: Number.isFinite(c) && c > 0 ? Math.trunc(c) : 0,
    highWaterAt: hw && Number.isFinite(hw.getTime()) ? hw : null,
  };
}

/**
 * PURE: combine two independent measurements of the SAME lane by taking the
 * stronger signal — the greater count, and the later high-water mark.
 *
 * This is a RATCHET, and that is the point. A lane whose basis is being
 * migrated has two legs that can each fail in a different way: the row leg
 * under-counts once filings can fold, and the filings leg reads zero if its
 * ledger is not being written. Taking the max means the migrated lane can
 * never report LESS signal than the basis it replaced, whatever happens to
 * either leg — so the change cannot silence the Scout by any route, which is
 * the exact failure it exists to prevent.
 *
 * The high-water mark is taken independently of the count: whichever leg saw
 * signal latest is the one that should advance the watermark, even if the
 * other leg counted more.
 */
export function strongerLaneCount(a: LaneCount, b: LaneCount): LaneCount {
  const aHw = a.highWaterAt?.getTime() ?? -Infinity;
  const bHw = b.highWaterAt?.getTime() ?? -Infinity;
  return {
    lane: a.lane,
    newCount: Math.max(a.newCount, b.newCount),
    highWaterAt: bHw > aHw ? b.highWaterAt : a.highWaterAt,
  };
}

/** Bound on how many graded-observation rows one rating-changes recount
 *  expands (volumes are ~100s/week — a runaway guard, not a working limit). */
const RATING_CHANGE_SCAN_CAP = 500;

/** How far BEFORE the watermark the rating-changes pass reads for prior-grade
 *  context (the lag() baseline). A prior older than this is unseen, so the
 *  first in-window grade counts as a change — fine for a firing signal. */
const RATING_PRIOR_CONTEXT_MS = 30 * 86_400_000;

/**
 * Recount every lane for one workspace. All lanes are WORKSPACE-WIDE on
 * purpose: the Scout is a singleton brain per workspace (K1), its digest
 * corpus spans the workspace's hives, and every narrower key in this area has
 * already drifted (scout_ticks' install_slug moved papercusp-workspace →
 * @singleton; work items live under per-hive slugs the pot registry does not
 * name) — a slug-keyed count silently goes stale on the next drift, a
 * workspace-keyed one cannot. `updated_ts` on work_items is an EPOCH-MS
 * bigint; engineer_issues timestamps are timestamptz.
 *
 * COUNTING FILINGS, NOT ROWS (learning-loop-identity-and-consumption-2026-08-08
 * D-043, leader-ratified — the mandatory co-change to P-013's capture-seam
 * fold):
 *
 * The observations lane used to count NEW ROWS. That was a faithful proxy for
 * "how much did agents file" only while every filing minted a row. P-013 breaks
 * that: an agent filing whose identity matches an open observation now FOLDS
 * onto it — repeatCount bumped, reporter recorded, evidence appended, no new
 * row. The filing is not refused (D-003's no-rejection half is unweakened) and
 * the agent is not silenced. But a row-based count cannot see it, so the lane
 * would have read a large drop in signal that never happened, the weighted
 * score would fall, and the Scout would fire LESS — silencing agents through
 * the back door, by measurement rather than by policy. That is precisely the
 * outcome D-042 forbids, arrived at without anyone deciding it.
 *
 * So the lane counts FILINGS, off the occurrence ledger
 * (issue-occurrence-ledger.ts) that capture already writes one row to per
 * capture call — including `reportKind:'coalesced'`, with its reporter. No new
 * table, no new write path: the ledger was already recording exactly the event
 * this lane wants to count.
 *
 * Measured before the switch (7d to 2026-08-22T20:31Z, this workspace, both
 * legs under the SAME `payload ? 'observation'` predicate): 12,953 observation
 * rows minted vs 13,607 observation filings in the ledger. The ledger basis is
 * already the larger of the two, by 654 filings that decompose as coalesced
 * 300 + promoted 203 + duplicate 152 — filings that landed on an ALREADY
 * EXISTING row and so were invisible to the row count even before P-013. The
 * lane was under-reporting before P-013; P-013 merely widens the gap.
 *
 * CORRECTION (2026-08-22, measured): an earlier revision of this note quoted
 * "897 coalesced filings per 7d". That is the CROSS-LANE coalesced count (916
 * at re-measurement); the observations lane's own coalesced count is 300. The
 * conclusion is unchanged — the ledger basis was already the larger — but the
 * gap is coalesced + promoted + duplicate, not coalesced alone. Quote the
 * lane-scoped number for a lane-scoped claim.
 *
 * ⚠ FOR ANY BEFORE/AFTER COMPARISON (P-016): work_item_occurrences' first row
 * in this workspace is 2026-08-13T19:12Z. The filings leg reads 0 before that
 * — not because agents filed nothing, but because the ledger did not exist.
 * A window straddling that date measures the ledger's birth, not agent
 * behaviour, and would read as a spectacular (false) increase in filings.
 */
export async function readLaneCounts(sql: Sql, workspaceId: string, watermark: Date): Promise<LaneCount[]> {
  const wmMs = watermark.getTime();
  const wmIso = watermark.toISOString();

  const [observations, observationFilings, captures, ratingChanges, completions, reverts, deferrals] =
    await Promise.all([
      sql<CountRow[]>`
      SELECT count(*)::int AS c, max(created_at) AS hw
        FROM harness_shared.engineer_issues
       WHERE workspace_id = ${workspaceId}
         AND created_at > ${wmIso}
         AND payload ? 'observation'`,
      // The FILINGS leg (see the note above readLaneCounts). One row per capture
      // call that landed, including the ones that folded onto an existing row and
      // therefore minted nothing. Classified by the SAME `payload ? 'observation'`
      // predicate as the row leg, read off the canonical row the filing landed on,
      // so the lane's MEANING is unchanged and only its COUNTING BASIS moves.
      sql<CountRow[]>`
      SELECT count(*)::int AS c, max(o.occurred_at) AS hw
        FROM harness_shared.work_item_occurrences o
        JOIN harness_shared.work_items wi
          ON wi.feature_id = o.canonical_work_item_id
         AND wi.workspace_id = o.workspace_id
       WHERE o.workspace_id = ${workspaceId}
         AND o.occurred_at > ${wmIso}
         AND wi.payload ? 'observation'`,
      sql<CountRow[]>`
      SELECT count(*)::int AS c, max(created_at) AS hw
        FROM harness_shared.engineer_issues
       WHERE workspace_id = ${workspaceId}
         AND created_at > ${wmIso}
         AND NOT payload ? 'observation'`,
      // A criterion counts when its rating DIFFERS from that criterion's most
      // recent PRIOR grade for the same rubric (IS DISTINCT FROM: a first-ever
      // grade has no prior row → NULL → distinct → counts as new signal). ONE
      // pass with lag() over a bounded prior-context window — a correlated
      // per-criterion probe re-scanned the table per row and ran minutes on the
      // live corpus (perf anti-pattern A-family: no N+1 probes in a sweep). A
      // prior grade OLDER than the context window is unseen, so the first
      // in-window grade counts as a change — acceptable for a firing signal.
      sql<CountRow[]>`
      WITH graded AS (
        SELECT created_at,
               payload->'observation'->>'rubricRef' AS rubric_ref,
               payload->'observation'->'ratings'    AS ratings
          FROM harness_shared.engineer_issues
         WHERE workspace_id = ${workspaceId}
             AND created_at > ${new Date(wmMs - RATING_PRIOR_CONTEXT_MS).toISOString()}
           AND payload->'observation' ? 'ratings'
         ORDER BY created_at DESC
         LIMIT ${RATING_CHANGE_SCAN_CAP}
      ), expanded AS (
        SELECT g.created_at, g.rubric_ref, e.key AS criterion, e.value->>'rating' AS rating
          FROM graded g, jsonb_each(g.ratings) e
      ), with_prior AS (
        SELECT created_at, rating,
               lag(rating) OVER (PARTITION BY rubric_ref, criterion ORDER BY created_at) AS prior
          FROM expanded
      )
      SELECT count(*)::int AS c, max(created_at) AS hw
        FROM with_prior
       WHERE created_at > ${wmIso}
         AND rating IS DISTINCT FROM prior`,
      sql<CountRow[]>`
      SELECT count(*)::int AS c, max(to_timestamp(updated_ts / 1000.0)) AS hw
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         AND status IN ('resolved', 'closed', 'passed')
         AND updated_ts > ${wmMs}`,
      sql<CountRow[]>`
      SELECT count(*)::int AS c, max(last_released_at) AS hw
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         AND last_released_at > ${wmIso}`,
      sql<CountRow[]>`
      SELECT count(*)::int AS c, max(to_timestamp(updated_ts / 1000.0)) AS hw
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         AND status IN ('blocked', 'deprecated', 'needs-human')
         AND updated_ts > ${wmMs}`,
    ]);

  return [
    toLaneCount('scorecard-rating-changes', ratingChanges),
    strongerLaneCount(toLaneCount('observations', observations), toLaneCount('observations', observationFilings)),
    toLaneCount('captures', captures),
    toLaneCount('reverts', reverts),
    toLaneCount('deferrals', deferrals),
    toLaneCount('completions', completions),
  ];
}

/** Upsert one scope's recounted rows (idempotent — the recount IS the state). */
export async function upsertAccumulatorRows(
  sql: Sql,
  workspaceId: string,
  installSlug: string,
  watermarkAt: Date,
  counts: readonly LaneCount[],
): Promise<void> {
  for (const c of counts) {
    await sql`
      INSERT INTO harness_shared.scout_signal_accumulator
        (workspace_id, install_slug, lane, new_count, high_water_at, watermark_at, updated_at)
      VALUES (${workspaceId}, ${installSlug}, ${c.lane}, ${c.newCount},
              ${c.highWaterAt ? c.highWaterAt.toISOString() : null}, ${watermarkAt.toISOString()}, now())
      ON CONFLICT (workspace_id, install_slug, lane) DO UPDATE
        SET new_count     = EXCLUDED.new_count,
            high_water_at = EXCLUDED.high_water_at,
            watermark_at  = EXCLUDED.watermark_at,
            updated_at    = now()`;
  }
}

/** The cadence-gate read (WI-4318): the workspace's cached lane counts.
 *  Counts are WORKSPACE-WIDE (see readLaneCounts), so every pot row for the
 *  workspace carries the same recount — the freshest row per lane wins
 *  (summing across pot rows would double-count a multi-pot workspace). */
export async function readAccumulatorCounts(opts: {
  workspaceId: string;
  /** Injectable sql seam (the learning.scout resolver routes a workspace-scoped
   *  tx through here; tests stub it) — defaults to the org pool. */
  sql?: Sql;
}): Promise<{ counts: Partial<Record<SignalLane, number>>; watermarkAt: Date | null }> {
  const sql = opts.sql ?? getOrgPg().sql;
  const rows = await sql<
    Array<{ lane: string; new_count: number; watermark_at: Date | string | null; updated_at: Date | string }>
  >`
    SELECT lane, new_count, watermark_at, updated_at
      FROM harness_shared.scout_signal_accumulator
     WHERE workspace_id = ${opts.workspaceId}
     ORDER BY updated_at DESC`;
  const counts: Partial<Record<SignalLane, number>> = {};
  let watermarkAt: Date | null = null;
  for (const r of rows) {
    const lane = r.lane as SignalLane;
    if (!SIGNAL_LANES.includes(lane)) continue;
    if (counts[lane] !== undefined) continue; // freshest row per lane wins
    counts[lane] = Math.max(0, Number(r.new_count) || 0);
    const wm =
      r.watermark_at == null ? null : r.watermark_at instanceof Date ? r.watermark_at : new Date(r.watermark_at);
    if (wm && Number.isFinite(wm.getTime()) && (watermarkAt == null || wm > watermarkAt)) watermarkAt = wm;
  }
  return { counts, watermarkAt };
}

// ── the sweep ─────────────────────────────────────────────────────────────────

export interface SignalAccumulatorSweepResult {
  workspaceId: string;
  installSlug: string;
  outcome: 'swept' | 'skipped' | 'error';
  /** Coverage of the registry-backed Blender population evaluated by this tick. */
  evaluatedWorkspaceCount: number;
  evaluatedScopeCount: number;
  eligibleBacklogCount: number;
  /** Weighted score of the freshly recounted lanes (diagnostics). */
  score: number;
  reason: string;
}

let lastSweepAtMs: number | null = null;

/** Test seam: reset the in-process throttle. */
export function __resetSweepThrottleForTests(): void {
  lastSweepAtMs = null;
}

/**
 * The accumulator recount sweep. For each registered Blender Hive scope: derive the watermark
 * (last successful Scout cycle, lookback-floored), recount every lane, upsert
 * the cache rows. Never throws — a sweep that crashes its host routine tick
 * guards nothing. Kill switch: PAPERCUSP_SIGNAL_ACCUM_LOOKBACK_SEC <= 0.
 */
export async function scoutSignalAccumulatorSweep(
  opts: { now?: number } = {},
): Promise<SignalAccumulatorSweepResult[]> {
  const results: SignalAccumulatorSweepResult[] = [];
  const lookbackSec = signalAccumulatorLookbackSec();
  if (lookbackSec <= 0) return results; // kill switch
  const now = opts.now ?? Date.now();
  if (!shouldSweepNow(lastSweepAtMs, now, signalAccumulatorSweepSec())) return results;
  lastSweepAtMs = now;
  try {
    const scopes = await listBlenderMaintenanceScopes();
    if (scopes.length === 0) {
      // A registry outage/empty registry must not turn retained signal into a
      // silent success. Probe the same workspace population without requiring a
      // Hive row, and emit a durable error-shaped result only when work exists.
      const workspaceIds =
        typeof listBlenderMaintenanceWorkspaceIds === 'function' ? listBlenderMaintenanceWorkspaceIds() : [];
      if (workspaceIds.length === 0) return results;
      const { sql } = getOrgPg();
      let eligibleBacklogCount = 0;
      let score = 0;
      for (const workspaceId of workspaceIds) {
        const lastRanAtMs = await readLastRanTickAtMs({ installSlugs: [], workspaceId }).catch(() => null);
        const watermark = new Date(effectiveWatermarkMs(lastRanAtMs, now, lookbackSec));
        const counts = await readLaneCounts(sql, workspaceId, watermark);
        eligibleBacklogCount += counts.reduce((total, count) => total + count.newCount, 0);
        score += weightedSignalScore(Object.fromEntries(counts.map((c) => [c.lane, c.newCount])));
      }
      if (eligibleBacklogCount > 0) {
        const reason =
          `${eligibleBacklogCount} eligible signal(s) found in ${workspaceIds.length} workspace(s), ` +
          'but no registered Blender scopes were evaluated';
        console.warn(`[signal-accumulator] ALERT: ${reason}`);
        return [
          {
            workspaceId: '*',
            installSlug: '*',
            outcome: 'error',
            evaluatedWorkspaceCount: 0,
            evaluatedScopeCount: 0,
            eligibleBacklogCount,
            score,
            reason,
          },
        ];
      }
      return results;
    }
    const { sql } = getOrgPg();
    const evaluatedWorkspaceCount = new Set(scopes.map(({ workspaceId }) => workspaceId)).size;
    const evaluatedScopeCount = scopes.length;
    for (const { workspaceId, installSlug } of scopes) {
      try {
        // WORKSPACE-WIDE last-ran (installSlugs: [] = no slug filter): the tick
        // WRITE key has already drifted across slugs (papercusp-workspace →
        // @singleton), and the Scout is one brain per workspace — the newest
        // successful cycle for the workspace IS the watermark, whatever slug
        // recorded it. origin defaults to 'scout' (su-ideate rows excluded).
        const lastRanAtMs = await readLastRanTickAtMs({ installSlugs: [], workspaceId }).catch(() => null);
        const watermark = new Date(effectiveWatermarkMs(lastRanAtMs, now, lookbackSec));
        const counts = await readLaneCounts(sql, workspaceId, watermark);
        await upsertAccumulatorRows(sql, workspaceId, installSlug, watermark, counts);
        const score = weightedSignalScore(Object.fromEntries(counts.map((c) => [c.lane, c.newCount])));
        const eligibleBacklogCount = counts.reduce((total, count) => total + count.newCount, 0);
        results.push({
          workspaceId,
          installSlug,
          outcome: 'swept',
          evaluatedWorkspaceCount,
          evaluatedScopeCount,
          eligibleBacklogCount,
          score,
          reason: counts.map((c) => `${c.lane}=${c.newCount}`).join(' '),
        });
      } catch (e) {
        results.push({
          workspaceId,
          installSlug,
          outcome: 'error',
          evaluatedWorkspaceCount,
          evaluatedScopeCount,
          eligibleBacklogCount: 0,
          score: 0,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    console.warn(`[signal-accumulator] sweep failed: ${e instanceof Error ? e.message : e}`);
  }
  return results;
}
