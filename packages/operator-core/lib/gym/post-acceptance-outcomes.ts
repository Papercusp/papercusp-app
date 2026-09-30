/**
 * post-acceptance-outcomes.ts — gym champion post-acceptance outcome tracking
 * (self-improvement-consume-edges-2026-06-12 P-030 / brief B-09).
 *
 * Closes the gym's "did it actually help" gap. The gym's accept gate judges a
 * candidate on SANDBOX evidence (judge scores over the train/dev-anchor pools);
 * nothing ever measured whether an accepted prompt change helped the harness's
 * REAL runs. This module records, per accepted proposal (the durable champion
 * event — production acceptance is always human-gated via decideProposal,
 * D-020):
 *
 *   1. an acceptance-time BASELINE — the candidate's gym-eval numbers off the
 *      proposal row, plus live-run outcomes (harness_shared.spawned_agents
 *      terminal counts for the accepted role) over a window BEFORE acceptance;
 *   2. a POST-ACCEPTANCE window of the same length, finalized by the gym tick
 *      once it elapses: post counts → success-rate delta → verdict;
 *   3. a proposer PRIMING block of recent verdicts (mirrors
 *      lib/scout/ideator-feedback-priming.ts: pure formatter + defensive
 *      gatherer, capped, empty ⇒ '' so the prompt stays byte-identical).
 *
 * Storage is harness_shared.gym_champion_outcomes (migration 243) in the LIVE
 * operator DB — the gym execution PG is an ephemeral per-cycle testcontainer
 * (D-018/D-020), so anything that must survive a cycle lives in the control
 * plane. SQL is injected (postgres-js `Sql`), mirroring control-plane.ts.
 *
 * Verdict semantics: success-rate delta over terminal spawned_agents runs
 * (done ⇒ succeeded, failed ⇒ failed; running/cancelled/reaped indeterminate ⇒
 * excluded). Either window under MIN_RUNS_FOR_VERDICT ⇒ 'insufficient-data'
 * (a 'judge'-role acceptance has no spawned runs and lands here by design);
 * |delta| within NEUTRAL_SUCCESS_RATE_BAND ⇒ 'neutral'.
 */
import type { Sql } from 'postgres';

// ---------------------------------------------------------------------------
// Tunables (exported so the owner can retune without code archaeology)
// ---------------------------------------------------------------------------

/** Length of BOTH windows: live-run baseline before acceptance, comparison after. */
export const POST_ACCEPTANCE_WINDOW_MS = 72 * 3_600_000;
/** Fewer terminal runs than this on either side ⇒ 'insufficient-data'. */
export const MIN_RUNS_FOR_VERDICT = 5;
/** |success-rate delta| within this band ⇒ 'neutral' (judge noise, not signal). */
export const NEUTRAL_SUCCESS_RATE_BAND = 0.05;

/** Priming block heading, byte-exact (the proposer prompt pins on it). */
export const CHAMPION_OUTCOMES_HEADING = '## Recent champion outcomes (live post-acceptance measurement)';
/** At most this many champion entries in the priming window (newest-first). */
export const MAX_OUTCOME_ENTRIES = 8;
/** The whole block (heading + entries) stays under this. */
export const MAX_OUTCOME_BLOCK_CHARS = 1_200;
/** Per-entry truncation (8×140 + heading < 1,200). */
export const MAX_OUTCOME_ENTRY_CHARS = 140;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Terminal live-run counts over one window (spawned_agents: done / failed). */
export interface LiveRunStats {
  runs: number;
  succeeded: number;
  failed: number;
}

export type OutcomeVerdictKind = 'improved' | 'regressed' | 'neutral' | 'insufficient-data';

export interface OutcomeVerdict {
  /** post success rate − baseline success rate; null when either side has zero runs. */
  successRateDelta: number | null;
  verdict: OutcomeVerdictKind;
}

/** The slice of an accepted proposal this module records (structural subset of GymProposalRow). */
export interface AcceptedProposalView {
  id: string;
  workspaceId: string;
  harnessSlug: string;
  role: string;
  variantId: string | null;
  cycle: number;
  devAnchorDelta: number | null;
  costDelta: number | null;
  probeStatus: string | null;
}

export interface ChampionOutcomeRow {
  proposalId: string;
  workspaceId: string;
  harnessSlug: string;
  role: string;
  variantId: string | null;
  cycle: number;
  acceptedAt: number;
  baselineDevAnchorDelta: number | null;
  baselineCostDelta: number | null;
  baselineProbeStatus: string | null;
  baseline: LiveRunStats;
  postWindowEndsAt: number;
  post: LiveRunStats | null;
  successRateDelta: number | null;
  verdict: 'pending' | OutcomeVerdictKind;
  evaluatedAt: number | null;
}

export interface VerdictOptions {
  minRuns?: number;
  neutralBand?: number;
}

// ---------------------------------------------------------------------------
// Pure core (hermetic — unit-tested without PG)
// ---------------------------------------------------------------------------

/** Success rate over terminal runs; null when the window saw none. */
export function successRate(s: LiveRunStats): number | null {
  return s.runs > 0 ? s.succeeded / s.runs : null;
}

/**
 * Compare a post-acceptance window against the baseline. The delta is reported
 * whenever both sides have ≥1 run (informative even when thin); the verdict
 * only leaves 'insufficient-data' when both sides meet `minRuns`.
 */
export function computeOutcomeVerdict(
  baseline: LiveRunStats,
  post: LiveRunStats,
  opts: VerdictOptions = {},
): OutcomeVerdict {
  const minRuns = Math.max(1, opts.minRuns ?? MIN_RUNS_FOR_VERDICT);
  const band = Math.max(0, opts.neutralBand ?? NEUTRAL_SUCCESS_RATE_BAND);
  const base = successRate(baseline);
  const after = successRate(post);
  const successRateDelta = base !== null && after !== null ? after - base : null;
  if (baseline.runs < minRuns || post.runs < minRuns || successRateDelta === null) {
    return { successRateDelta, verdict: 'insufficient-data' };
  }
  if (Math.abs(successRateDelta) <= band) return { successRateDelta, verdict: 'neutral' };
  return { successRateDelta, verdict: successRateDelta > 0 ? 'improved' : 'regressed' };
}

const signed = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;

export interface OutcomePrimingOptions {
  maxEntries?: number;
  maxBlockChars?: number;
  maxEntryChars?: number;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** One priming line per finalized champion (pending rows carry no signal and are skipped). */
export function formatChampionOutcomeEntry(r: ChampionOutcomeRow): string {
  const head = `- [${r.role} · ${r.verdict}]`;
  const anchor = r.baselineDevAnchorDelta !== null ? `; accept-time dev-anchor Δ ${signed(r.baselineDevAnchorDelta)}` : '';
  if (r.verdict === 'insufficient-data' || r.successRateDelta === null || !r.post) {
    const postRuns = r.post?.runs ?? 0;
    return `${head} cycle ${r.cycle}: ${r.baseline.runs} baseline / ${postRuns} post live runs — too thin to judge${anchor}`;
  }
  const base = successRate(r.baseline);
  const after = successRate(r.post);
  const rates = base !== null && after !== null ? `${base.toFixed(2)}→${after.toFixed(2)}` : '?';
  return (
    `${head} cycle ${r.cycle}: live success ${rates} (Δ ${signed(r.successRateDelta)}, ` +
    `${r.baseline.runs}→${r.post.runs} runs)${anchor}`
  );
}

/**
 * Format finalized champion outcomes into proposer priming lines (pure).
 * Newest-first by acceptedAt, windowed, per-entry + whole-block capped — the
 * scout C-4 shape. Zero finalized rows ⇒ [] (the proposer prompt stays
 * byte-identical, same contract as candidateDirections).
 */
export function formatChampionOutcomeEntries(
  rows: readonly ChampionOutcomeRow[],
  opts: OutcomePrimingOptions = {},
): string[] {
  const maxEntries = Math.max(0, opts.maxEntries ?? MAX_OUTCOME_ENTRIES);
  const maxBlockChars = Math.max(0, opts.maxBlockChars ?? MAX_OUTCOME_BLOCK_CHARS);
  const maxEntryChars = Math.max(1, opts.maxEntryChars ?? MAX_OUTCOME_ENTRY_CHARS);

  const entries = rows
    .filter((r) => r.verdict !== 'pending')
    .sort((a, b) => b.acceptedAt - a.acceptedAt)
    .slice(0, maxEntries)
    .map((r) => truncate(formatChampionOutcomeEntry(r), maxEntryChars));

  // Defensive total cap (a no-op at the default knobs): drop oldest until it fits.
  while (entries.length > 0 && [CHAMPION_OUTCOMES_HEADING, ...entries].join('\n').length > maxBlockChars) {
    entries.pop();
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Row mapper (postgres-js returns bigint as string — control-plane.ts style)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function mapOutcome(r: Row): ChampionOutcomeRow {
  const postRuns = numOrNull(r.post_runs);
  return {
    proposalId: String(r.proposal_id),
    workspaceId: String(r.workspace_id),
    harnessSlug: String(r.harness_slug),
    role: String(r.role),
    variantId: strOrNull(r.variant_id),
    cycle: Number(r.cycle),
    acceptedAt: Number(r.accepted_at),
    baselineDevAnchorDelta: numOrNull(r.baseline_dev_anchor_delta),
    baselineCostDelta: numOrNull(r.baseline_cost_delta),
    baselineProbeStatus: strOrNull(r.baseline_probe_status),
    baseline: {
      runs: Number(r.baseline_runs ?? 0),
      succeeded: Number(r.baseline_succeeded ?? 0),
      failed: Number(r.baseline_failed ?? 0),
    },
    postWindowEndsAt: Number(r.post_window_ends_at),
    post:
      postRuns === null
        ? null
        : { runs: postRuns, succeeded: Number(r.post_succeeded ?? 0), failed: Number(r.post_failed ?? 0) },
    successRateDelta: numOrNull(r.success_rate_delta),
    verdict: String(r.verdict) as ChampionOutcomeRow['verdict'],
    evaluatedAt: numOrNull(r.evaluated_at),
  };
}

// ---------------------------------------------------------------------------
// SQL (injected client; tables: gym_champion_outcomes + spawned_agents reads)
// ---------------------------------------------------------------------------

/**
 * Terminal live-run counts for (workspace, harness, role) over [fromMs, toMs).
 * done ⇒ succeeded, failed ⇒ failed; running/cancelled/reaped are indeterminate
 * (cancelled is a human act, reaped is lost-track cleanup) and excluded.
 */
export async function readLiveRunStats(
  sql: Sql,
  q: { workspaceId: string; harnessSlug: string; role: string; fromMs: number; toMs: number },
): Promise<LiveRunStats> {
  const rows = (await sql`
    SELECT
      count(*) FILTER (WHERE status = 'done')   AS succeeded,
      count(*) FILTER (WHERE status = 'failed') AS failed
    FROM harness_shared.spawned_agents
    WHERE workspace_id = ${q.workspaceId} AND harness_slug = ${q.harnessSlug}
      AND child_role = ${q.role}
      AND status IN ('done', 'failed')
      AND started_at >= to_timestamp(${q.fromMs} / 1000.0)
      AND started_at <  to_timestamp(${q.toMs} / 1000.0)`) as Row[];
  const succeeded = Number(rows[0]?.succeeded ?? 0);
  const failed = Number(rows[0]?.failed ?? 0);
  return { runs: succeeded + failed, succeeded, failed };
}

/**
 * Record the champion baseline at the acceptance moment. Called from
 * decideProposal's accept transaction (control-plane.ts) so an accepted
 * champion WITHOUT a baseline row cannot exist — the untracked-dispatch
 * failure mode this plan exists to kill. Idempotent per proposal
 * (ON CONFLICT DO NOTHING; re-deciding is blocked upstream anyway).
 */
export async function recordChampionAcceptance(
  sql: Sql,
  q: { proposal: AcceptedProposalView; acceptedAt: number; windowMs?: number },
): Promise<void> {
  const windowMs = q.windowMs ?? POST_ACCEPTANCE_WINDOW_MS;
  const p = q.proposal;
  const baseline = await readLiveRunStats(sql, {
    workspaceId: p.workspaceId,
    harnessSlug: p.harnessSlug,
    role: p.role,
    fromMs: q.acceptedAt - windowMs,
    toMs: q.acceptedAt,
  });
  await sql`
    INSERT INTO harness_shared.gym_champion_outcomes
      (proposal_id, workspace_id, harness_slug, role, variant_id, cycle, accepted_at,
       baseline_dev_anchor_delta, baseline_cost_delta, baseline_probe_status,
       baseline_runs, baseline_succeeded, baseline_failed, post_window_ends_at)
    VALUES (${p.id}, ${p.workspaceId}, ${p.harnessSlug}, ${p.role}, ${p.variantId}, ${p.cycle}, ${q.acceptedAt},
       ${p.devAnchorDelta}, ${p.costDelta}, ${p.probeStatus},
       ${baseline.runs}, ${baseline.succeeded}, ${baseline.failed}, ${q.acceptedAt + windowMs})
    ON CONFLICT (proposal_id) DO NOTHING`;
}

/** Pending rows whose post window has elapsed (the finalizer's work list). */
export async function listDueChampionOutcomes(
  sql: Sql,
  q: { now: number; workspaceId?: string; limit?: number },
): Promise<ChampionOutcomeRow[]> {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const rows = (await sql`
    SELECT * FROM harness_shared.gym_champion_outcomes
     WHERE verdict = 'pending' AND post_window_ends_at <= ${q.now}
       ${q.workspaceId ? sql`AND workspace_id = ${q.workspaceId}` : sql``}
     ORDER BY post_window_ends_at ASC
     LIMIT ${limit}`) as Row[];
  return rows.map(mapOutcome);
}

/**
 * Finalize every due pending row: read the post-acceptance window's live-run
 * stats, compute delta + verdict, write back. Returns the finalized count.
 * Designed for the gym tick (cheap SQL, no LLM); per-row failures are isolated
 * so one bad row never wedges the sweep.
 */
export async function finalizePendingChampionOutcomes(
  sql: Sql,
  q: { workspaceId?: string; now?: number; verdictOpts?: VerdictOptions; log?: (msg: string) => void } = {},
): Promise<number> {
  const now = q.now ?? Date.now();
  const log = q.log ?? (() => {});
  const due = await listDueChampionOutcomes(sql, { now, workspaceId: q.workspaceId });
  let finalized = 0;
  for (const row of due) {
    try {
      const post = await readLiveRunStats(sql, {
        workspaceId: row.workspaceId,
        harnessSlug: row.harnessSlug,
        role: row.role,
        fromMs: row.acceptedAt,
        toMs: row.postWindowEndsAt,
      });
      const v = computeOutcomeVerdict(row.baseline, post, q.verdictOpts);
      await sql`
        UPDATE harness_shared.gym_champion_outcomes
           SET post_runs = ${post.runs}, post_succeeded = ${post.succeeded}, post_failed = ${post.failed},
               success_rate_delta = ${v.successRateDelta}, verdict = ${v.verdict}, evaluated_at = ${now}
         WHERE proposal_id = ${row.proposalId} AND verdict = 'pending'`;
      finalized++;
      log(`champion ${row.proposalId} (${row.harnessSlug}/${row.role}) finalized: ${v.verdict}`);
    } catch (err) {
      log(`champion ${row.proposalId} finalize failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return finalized;
}

/** Recent rows for (workspace, harness), newest-first — the priming read. */
export async function readRecentChampionOutcomes(
  sql: Sql,
  q: { workspaceId: string; harnessSlug: string; limit?: number },
): Promise<ChampionOutcomeRow[]> {
  const limit = Math.min(Math.max(q.limit ?? MAX_OUTCOME_ENTRIES, 1), 50);
  const rows = (await sql`
    SELECT * FROM harness_shared.gym_champion_outcomes
     WHERE workspace_id = ${q.workspaceId} AND harness_slug = ${q.harnessSlug}
     ORDER BY accepted_at DESC
     LIMIT ${limit}`) as Row[];
  return rows.map(mapOutcome);
}

/**
 * Production gatherer for the proposer's priming lines. Defensive like the
 * cycle's other readers (scout pattern): any read failure yields [] — a PG
 * hiccup never kills a gym cycle, and zero finalized champions add nothing.
 */
export async function gatherChampionOutcomeEntries(
  sql: Sql,
  q: { workspaceId: string; harnessSlug: string } & OutcomePrimingOptions,
): Promise<string[]> {
  try {
    const rows = await readRecentChampionOutcomes(sql, {
      workspaceId: q.workspaceId,
      harnessSlug: q.harnessSlug,
      limit: Math.max(MAX_OUTCOME_ENTRIES * 2, q.maxEntries ?? 0),
    });
    return formatChampionOutcomeEntries(rows, q);
  } catch (err) {
     
    console.warn(
      '[gym/post-acceptance-outcomes] outcome read failed — no champion priming this cycle:',
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}
