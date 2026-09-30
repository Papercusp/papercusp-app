/**
 * learning-analyze-read.ts — the read behind the Learning tab's Analyze stage
 * (learning-tab-visibility-2026-07-18 P-009 / D-001).
 *
 * Per fired cycle, the pipeline's INTERMEDIATE artifacts (migration 623,
 * written best-effort at the tick seam by scout/stage-artifacts.ts):
 *
 *   1. **Ideation roster** — per-slot ideator outcomes (EI-13119) + the raw
 *      per-ideator ideas, each with the creative lens it rode.
 *   2. **Critique verdicts** — every scored idea's keep/moonshot/reject bucket,
 *      novelty/feasibility scores, and the critics' notes.
 *   3. **Fusions** — the debate/recombine proposals with their sourceIdeaIds
 *      chains, joined to the routed-ledger rows so a fusion traces into the
 *      artifact it became (the same rows the Ideas view lists).
 *
 * Joined to `scout_ticks` by cycle id for the cycle's economics (status, stop,
 * spend, funnel counts). Best-effort + 42P01-tolerant like the scout-read tick
 * half: a substrate without migration 623 renders the explain-empty state,
 * never a 500. Pure SQL over an injected `Sql` (mirrors learning-scout-read)
 * so the resolver test can stub the seam.
 */
import type { Sql } from 'postgres';
import type { Idea, Proposal, ScoredIdea } from '../scout/types';
import { isUndefinedTable, normalizeTickEconomics, type ScoutTickEconomics } from './learning-scout-read';
import { createReadDeadline, isReadBudgetExceeded } from './read-deadline';

/**
 * Whole-read deadline for both Analyze reads (WI-39823) — 6s, the budget the
 * bounded sibling learning.* reads carry, measured against :3170 latency
 * (p90 599ms) and sized to fire under the sync layer's ~10s resolver timeout.
 */
const ANALYZE_READ_BUDGET_MS = 6_000;

/** Options shared by {@link readAnalyzeSnapshot} and {@link readAnalyzeCycle}. */
export interface AnalyzeReadOpts {
  /** Whole-read deadline override in ms (default {@link ANALYZE_READ_BUDGET_MS}). */
  budgetMs?: number;
}

/**
 * Re-raise a lapsed budget instead of letting an existing `catch` swallow it.
 *
 * Both reads below degrade a FAILED artifacts read to a confident empty value
 * (`{ cycles: [] }` / `null`) so a substrate without migration 623 renders the
 * explain-empty state rather than a 500. That is right for a missing table and
 * WRONG for a timeout: `readAnalyzeCycle`'s `null` is rendered by the consumer as
 * "Loading cycle artifacts…", so swallowing a lapsed deadline there would convert
 * a bounded failure straight back into the permanent spinner this bound exists to
 * end (the WI-6395 shape, re-entering through the inner catch). Letting it
 * propagate reaches the resolver's own `degraded(…)` wrapper, which says the read
 * failed. Non-budget errors keep their existing handling exactly.
 */
function rethrowIfBudgetLapsed(err: unknown): void {
  if (isReadBudgetExceeded(err)) throw err;
}

/** One ideator roster slot's outcome (ScoutCycleLike.ideators, EI-13119). */
export interface AnalyzeIdeatorSlot {
  lens: string;
  ok: boolean;
  /** Raw model outputs before the grounding/shape filter. */
  raw: number;
  /** Ideas that survived the filter. */
  produced: number;
  error?: string;
}

/** One routed-ledger row of the cycle, keyed by the IN-CYCLE idea/proposal id
 *  (the `${cycleId}:` ledger prefix stripped) — the fusion → artifact trace. */
export interface AnalyzeRoutedRef {
  ideaId: string;
  rail: string;
  routedRef: string;
  title: string | null;
}

/** One fired cycle's full stage artifacts + joined tick economics. */
export interface AnalyzeCycle {
  cycleId: string;
  /** ISO timestamp the artifacts row landed (≈ cycle completion). */
  at: string | null;
  /** Divergent generation: per-ideator raw ideas incl. lens (render what arrives). */
  ideas: Idea[];
  /** Adversarial critique verdicts (keep/moonshot/reject + notes). */
  scored: ScoredIdea[];
  /** Debate/recombine fusions (sourceIdeaIds chains). */
  proposals: Proposal[];
  /** Per-slot ideator outcomes. */
  ideatorSlots: AnalyzeIdeatorSlot[];
  /** The cycle's scout_ticks economics (null when the tick row is missing). */
  tick: ScoutTickEconomics | null;
  /** The cycle's routed-ledger rows — what the fusions became. */
  routed: AnalyzeRoutedRef[];
}

/** The COLLAPSED cycle-disclosure summary the Analyze list needs — enough for
 *  the funnel label (counts + verdicts + spend) WITHOUT the heavy per-cycle
 *  artifact arrays. The full ideas/scored/proposals for ONE cycle are fetched
 *  on demand via `learning.analyzeCycle` when its disclosure is expanded
 *  (precompute-sync-reads-phase2 P-007): closed cycles stay unmounted in the
 *  UI, so shipping all 8 full pipelines up-front (~348KB, only 1 ever rendered)
 *  was pure waste. */
export interface AnalyzeCycleSummary {
  cycleId: string;
  at: string | null;
  ideasCount: number;
  proposalsCount: number;
  routedCount: number;
  /** Just the verdict strings per scored idea — enough for the keep/moonshot
   *  funnel label; the full scored objects (scores + critics' notes) ride the
   *  on-demand single-cycle read. */
  verdicts: string[];
  tick: ScoutTickEconomics | null;
}

export interface AnalyzeSnapshot {
  cycles: AnalyzeCycleSummary[];
  generatedAt: string;
}

/** Newest cycles returned per read — a handful of full pipelines is plenty for
 *  the view; the table itself is pruned to keep-30 (stage-artifacts.ts). */
const ANALYZE_CYCLE_LIMIT = 8;

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function rowAt(r: Record<string, unknown>): string | null {
  return r.created_at instanceof Date
    ? r.created_at.toISOString()
    : r.created_at
      ? String(r.created_at)
      : null;
}

/** Tick-economics for one or more cycles (best-effort — scout_ticks may
 *  lag/miss on a substrate). Returns a cycleId→economics map. */
async function tickEconomicsByCycle(
  sql: Sql,
  workspaceId: string,
  cycleIds: string[],
): Promise<Map<string, ScoutTickEconomics>> {
  const byCycle = new Map<string, ScoutTickEconomics>();
  if (cycleIds.length === 0) return byCycle;
  try {
    const tickRows = (await sql`
      SELECT * FROM harness_shared.scout_ticks
       WHERE workspace_id = ${workspaceId}
         AND detail->>'cycleId' IN ${sql(cycleIds)}
    `) as Array<Record<string, unknown>>;
    for (const row of tickRows) {
      const econ = normalizeTickEconomics(row);
      if (econ.cycleId) byCycle.set(econ.cycleId, econ);
    }
  } catch (err) {
    if (!isUndefinedTable(err)) {
      console.warn('[learning.analyze] tick join failed:', err instanceof Error ? err.message : err);
    }
  }
  return byCycle;
}

/** Routed-ledger rows per cycle (best-effort): what each cycle's fusions
 *  became. The ledger's idea_id carries a `${cycleId}:` prefix
 *  (scorecard-blender-pipeline P-003) — strip it so rows key by the in-cycle
 *  Proposal.id. Returns a cycleId→refs map. */
async function routedRefsByCycle(
  sql: Sql,
  workspaceId: string,
  cycleIds: string[],
): Promise<Map<string, AnalyzeRoutedRef[]>> {
  const byCycle = new Map<string, AnalyzeRoutedRef[]>();
  if (cycleIds.length === 0) return byCycle;
  try {
    const routedRows = (await sql`
      SELECT cycle_id, idea_id, rail, routed_ref, title
        FROM harness_shared.scout_routed_ideas
       WHERE workspace_id = ${workspaceId}
         AND cycle_id IN ${sql(cycleIds)}
    `) as Array<Record<string, unknown>>;
    for (const row of routedRows) {
      const cid = typeof row.cycle_id === 'string' ? row.cycle_id : '';
      if (!cid) continue;
      const rawId = String(row.idea_id ?? '');
      const bucket = byCycle.get(cid) ?? [];
      bucket.push({
        ideaId: rawId.startsWith(`${cid}:`) ? rawId.slice(cid.length + 1) : rawId,
        rail: String(row.rail ?? ''),
        routedRef: String(row.routed_ref ?? ''),
        title: typeof row.title === 'string' && row.title ? row.title : null,
      });
      byCycle.set(cid, bucket);
    }
  } catch (err) {
    if (!isUndefinedTable(err)) {
      console.warn('[learning.analyze] routed join failed:', err instanceof Error ? err.message : err);
    }
  }
  return byCycle;
}

export async function readAnalyzeSnapshot(
  sql: Sql,
  workspaceId: string,
  opts: AnalyzeReadOpts = {},
): Promise<AnalyzeSnapshot> {
  const generatedAt = new Date().toISOString();
  const withinBudget = createReadDeadline(opts.budgetMs ?? ANALYZE_READ_BUDGET_MS);

  let rows: Array<Record<string, unknown>> = [];
  try {
    // P-007: read the artifact columns to COUNT + extract verdicts server-side,
    // but do NOT ship the full ideas/scored/proposals arrays — the collapsed
    // disclosure label only needs counts + verdicts + spend. (Kept in the SELECT
    // because the count/verdict derivation needs them; they never leave here.)
    rows = (await withinBudget(
      sql`
      SELECT cycle_id, created_at, ideas, scored, proposals
        FROM harness_shared.scout_cycle_stage_artifacts
       WHERE workspace_id = ${workspaceId}
       ORDER BY created_at DESC
       LIMIT ${ANALYZE_CYCLE_LIMIT}
    `,
      'analyze artifacts',
    )) as Array<Record<string, unknown>>;
  } catch (err) {
    rethrowIfBudgetLapsed(err);
    // Migration 623 not applied on this substrate ⇒ the explain-empty state.
    if (!isUndefinedTable(err)) {
      console.warn('[learning.analyze] artifacts read failed:', err instanceof Error ? err.message : err);
    }
    return { cycles: [], generatedAt };
  }

  const summaries: AnalyzeCycleSummary[] = rows.map((r) => ({
    cycleId: String(r.cycle_id ?? ''),
    at: rowAt(r),
    ideasCount: asArray<Idea>(r.ideas).length,
    proposalsCount: asArray<Proposal>(r.proposals).length,
    routedCount: 0,
    verdicts: asArray<ScoredIdea>(r.scored).map((s) => String(s?.verdict ?? '')),
    tick: null,
  }));
  const cycleIds = summaries.map((c) => c.cycleId).filter((c) => c.length > 0);
  if (cycleIds.length === 0) return { cycles: summaries, generatedAt };

  // Both legs are ENRICHMENT over rows already in hand, so a lapsed one is a true
  // partial: the cycles still render, just without economics / routed counts. Each
  // already tolerates a THROW internally (warn + empty map) — the bound is what
  // extends that to a HANG, which `Promise.all` would otherwise let run past the
  // resolver timeout and take the whole, already-successful read down with it.
  const [tickByCycle, routedByCycle] = await Promise.all([
    withinBudget(tickEconomicsByCycle(sql, workspaceId, cycleIds), 'analyze tick-economics').catch(
      () => new Map<string, ScoutTickEconomics>(),
    ),
    withinBudget(routedRefsByCycle(sql, workspaceId, cycleIds), 'analyze routed-refs').catch(
      () => new Map<string, AnalyzeRoutedRef[]>(),
    ),
  ]);
  for (const c of summaries) {
    c.tick = tickByCycle.get(c.cycleId) ?? null;
    c.routedCount = routedByCycle.get(c.cycleId)?.length ?? 0;
  }

  return { cycles: summaries, generatedAt };
}

/** ON-DEMAND single-cycle read (P-007) — the FULL stage artifacts (ideas,
 *  scored, proposals, ideator slots) + tick economics + routed refs for ONE
 *  cycle, fetched when its Analyze disclosure is expanded. Returns null when the
 *  cycle is absent / the artifacts table is missing (the panel keeps the label). */
export async function readAnalyzeCycle(
  sql: Sql,
  workspaceId: string,
  cycleId: string,
  opts: AnalyzeReadOpts = {},
): Promise<AnalyzeCycle | null> {
  const withinBudget = createReadDeadline(opts.budgetMs ?? ANALYZE_READ_BUDGET_MS);
  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = (await withinBudget(
      sql`
      SELECT cycle_id, created_at, ideas, scored, proposals, ideator_slots
        FROM harness_shared.scout_cycle_stage_artifacts
       WHERE workspace_id = ${workspaceId}
         AND cycle_id = ${cycleId}
       LIMIT 1
    `,
      'analyze-cycle artifacts',
    )) as Array<Record<string, unknown>>;
  } catch (err) {
    // A lapsed budget must NOT become `null` here: the consumer renders `!cycle`
    // as "Loading cycle artifacts…", so returning null on a timeout is the
    // permanent spinner in its purest form. Propagate to the resolver's degraded().
    rethrowIfBudgetLapsed(err);
    if (!isUndefinedTable(err)) {
      console.warn('[learning.analyzeCycle] artifacts read failed:', err instanceof Error ? err.message : err);
    }
    return null;
  }
  const r = rows[0];
  if (!r) return null;

  const cycle: AnalyzeCycle = {
    cycleId: String(r.cycle_id ?? ''),
    at: rowAt(r),
    ideas: asArray<Idea>(r.ideas),
    scored: asArray<ScoredIdea>(r.scored),
    proposals: asArray<Proposal>(r.proposals),
    ideatorSlots: asArray<AnalyzeIdeatorSlot>(r.ideator_slots),
    tick: null,
    routed: [],
  };
  if (!cycle.cycleId) return cycle;

  // Enrichment over a cycle already in hand — a lapsed leg costs the economics or
  // the routed refs, never the artifacts the disclosure was expanded to show.
  const [tickByCycle, routedByCycle] = await Promise.all([
    withinBudget(tickEconomicsByCycle(sql, workspaceId, [cycle.cycleId]), 'analyze-cycle tick-economics').catch(
      () => new Map<string, ScoutTickEconomics>(),
    ),
    withinBudget(routedRefsByCycle(sql, workspaceId, [cycle.cycleId]), 'analyze-cycle routed-refs').catch(
      () => new Map<string, AnalyzeRoutedRef[]>(),
    ),
  ]);
  cycle.tick = tickByCycle.get(cycle.cycleId) ?? null;
  cycle.routed = routedByCycle.get(cycle.cycleId) ?? [];
  return cycle;
}
