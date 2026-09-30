/**
 * mug-wake-efficiency — the per-wake cache/token metric for the Mug
 * (queen-brief-cache-assembly-2026-06-13 B-06 P-010, feeding P-003 + P-011).
 *
 * Each Mug wake is one governed subprocess run, so `harness_shared.agent_usage_samples`
 * already carries the per-wake token + cache breakdown (recordUsageSamplePg writes
 * input/output/cache_read/cache_creation/cost per run, tagged role='mug'). This
 * reader projects those rows into the cache-efficiency view the plan asks for:
 * per-wake cache-read ratio + the "caching is real" signal (cachedWakes > 0 — P-003's
 * non-zero `cache_read_input_tokens` assertion, now queryable rather than eyeballed).
 *
 * Pure aggregation over an injectable row source (`deps.fetchSamples`) so it
 * unit-tests with no DB; the default reads PG via getOrgPg.
 *
 * BOTH wins are now captured: the cache-ratio measures Win-1 (the frozen-prefix
 * cache); `avgTurns` (claude `num_turns` per wake, migration 272's `turn_count`)
 * measures Win-2 (round-trip elimination — the precomputed brief should pull it
 * down). The pot-eval efficiency class scores both via mugEkgFromEfficiency →
 * RunBehavior (B-06 / P-011); see pot-eval/efficiency-metrics.ts + scoring.ts.
 */
import type postgres from 'postgres';
import { getOrgPg } from '@papercusp/db-org';

/** One Mug wake's token + cache sample (one agent_usage_samples row). */
export interface MugWakeSample {
  runId: string | null;
  tsMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;
  /** Assistant turns in the wake (claude num_turns) — the round-trip metric. null when not captured. */
  turns: number | null;
}

export interface MugWakeEfficiency {
  /** Wakes (runs) considered. */
  wakes: number;
  /** Wakes with non-zero cache_read — the "the cache is actually being read" signal (P-003). */
  cachedWakes: number;
  totalInputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  /**
   * Share of PROMPT tokens served from cache across the window:
   * cache_read / (cache_read + cache_creation + uncached input). 0 when no prompt
   * tokens were seen. Higher = the frozen prefix is paying off (Win-1).
   */
  cacheHitRatio: number;
  /** Mean assistant turns per wake across wakes that reported a turn count (Win-2:
   *  the precomputed brief should pull this DOWN over time). null when none reported. */
  avgTurns: number | null;
  /** Sum of assistant turns across wakes that reported a turn count (avgTurns numerator). */
  totalTurns: number;
  /** Wakes that reported a turn count (avgTurns denominator; ≤ wakes). */
  turnsReportedWakes: number;
  /** The per-wake samples, newest-first. */
  samples: MugWakeSample[];
}

/** The zeroed aggregate — the fallback when the read fails (e.g. a not-yet-applied migration), so a
 *  consumer (the gated `pot:mug_efficiency` read surface or pot-eval benchmark) renders a no-wakes state,
 *  never a 500. Identical to what {@link mugWakeEfficiency} returns over an empty window. */
export const EMPTY_MUG_WAKE_EFFICIENCY: MugWakeEfficiency = {
  wakes: 0,
  cachedWakes: 0,
  totalInputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheCreationTokens: 0,
  totalOutputTokens: 0,
  totalCostUsd: 0,
  cacheHitRatio: 0,
  avgTurns: null,
  totalTurns: 0,
  turnsReportedWakes: 0,
  samples: [],
};

/** One raw `agent_usage_samples` row (PG numerics may arrive as strings — coerced by {@link num}). */
export interface MugWakeSampleRow {
  run_id: string | null;
  ts: number | string;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  cache_read_tokens: number | string | null;
  cache_creation_tokens: number | string | null;
  cost_usd: number | string | null;
  turn_count: number | string | null;
}

export interface MugWakeEfficiencyDeps {
  /** Fetch the raw Mug usage rows (newest-first, capped). Injected for tests. */
  fetchSamples: (input: { workspaceId: string; harnessSlug?: string; limit: number }) => Promise<MugWakeSampleRow[]>;
}

function num(v: number | string | null | undefined): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/**
 * The canonical Mug-wake usage SELECT over an explicit `sql` client — the single source of the
 * column list so both the default PG deps AND the pot-eval live capture (which runs over the same
 * throwaway-pot `sql`, scoped by `harnessSlug = potHome`) read identical rows. Exported so
 * `live-ops.readMugEkg` reuses it instead of re-deriving the query (B-06 / P-011).
 */
export function mugWakeSampleRows(
  sql: postgres.Sql,
  input: { workspaceId: string; harnessSlug?: string; limit: number },
): Promise<MugWakeSampleRow[]> {
  return sql<MugWakeSampleRow[]>`
    SELECT run_id, ts, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, turn_count
      FROM harness_shared.agent_usage_samples
     WHERE workspace_id = ${input.workspaceId}
       AND role = 'mug'
       ${input.harnessSlug ? sql`AND harness_slug = ${input.harnessSlug}` : sql``}
     ORDER BY ts DESC
     LIMIT ${input.limit}`;
}

function defaultDeps(): MugWakeEfficiencyDeps {
  return {
    fetchSamples: async (input) => mugWakeSampleRows(getOrgPg().sql, input),
  };
}

/**
 * Aggregate the Mug's recent per-wake cache/token efficiency. `harnessSlug`
 * scopes to one pot home (omit for all of the workspace's Mug wakes).
 */
export async function mugWakeEfficiency(
  workspaceId: string,
  opts: { harnessSlug?: string; limit?: number; deps?: Partial<MugWakeEfficiencyDeps> } = {},
): Promise<MugWakeEfficiency> {
  const deps = { ...defaultDeps(), ...opts.deps };
  const rows = await deps.fetchSamples({ workspaceId, harnessSlug: opts.harnessSlug, limit: opts.limit ?? 50 });

  const samples: MugWakeSample[] = rows.map((r) => ({
    runId: r.run_id,
    tsMs: num(r.ts),
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
    cacheReadTokens: num(r.cache_read_tokens),
    cacheCreationTokens: num(r.cache_creation_tokens),
    costUsd: r.cost_usd == null ? null : num(r.cost_usd),
    turns: r.turn_count == null ? null : num(r.turn_count),
  }));

  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let cachedWakes = 0;
  let totalTurns = 0;
  let turnsReportedWakes = 0;
  for (const s of samples) {
    totalInputTokens += s.inputTokens;
    totalCacheReadTokens += s.cacheReadTokens;
    totalCacheCreationTokens += s.cacheCreationTokens;
    totalOutputTokens += s.outputTokens;
    totalCostUsd += s.costUsd ?? 0;
    if (s.cacheReadTokens > 0) cachedWakes += 1;
    if (s.turns != null) {
      totalTurns += s.turns;
      turnsReportedWakes += 1;
    }
  }
  const promptTokens = totalCacheReadTokens + totalCacheCreationTokens + totalInputTokens;
  const cacheHitRatio = promptTokens > 0 ? totalCacheReadTokens / promptTokens : 0;
  const avgTurns = turnsReportedWakes > 0 ? totalTurns / turnsReportedWakes : null;

  return {
    wakes: samples.length,
    cachedWakes,
    totalInputTokens,
    totalCacheReadTokens,
    totalCacheCreationTokens,
    totalOutputTokens,
    totalCostUsd,
    cacheHitRatio,
    avgTurns,
    totalTurns,
    turnsReportedWakes,
    samples,
  };
}
