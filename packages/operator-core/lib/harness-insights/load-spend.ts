/**
 * loadHarnessSpend — Insights SpendCard data source (Tier D).
 *
 * Plan: cross-backend-cost-capture-2026-06-01 (P-006). Reads REAL spend from
 * `harness_shared.agent_usage_samples` (rate-limit-layer-v2 migration 161 +
 * cross-backend attribution migration 170): per-run rows written at the two
 * capture points (subprocess JSONL terminal events for claude/codex/omp;
 * stateless-call headers in-process), workspace + harness scoped.
 *
 * Replaces the original phantom `tool_invocations.cost_microcents` query (the
 * column never existed → the card always rendered $0 behind a "proxy-witness"
 * deferral banner). The per-viewer line is GONE (D-003 #2): agent runs are
 * orchestrator-spawned, not attributable to a person — the harness total is
 * the meaningful number.
 *
 * Cost honesty (D-005): `estimatedUsdThisWeek` is the portion priced from
 * tokens × list price (`cost_source='estimated'` — codex reports no cost);
 * the remainder is provider-reported. The card labels the split.
 *
 * Pure logic — injectable runQuery. Defensive: a missing table/column
 * (pre-migration substrate) yields zeros so the card renders the empty state
 * rather than 500-ing.
 */

import type { SpendCardProps } from './card-types';

export interface LoadHarnessSpendOpts {
  /**
   * Request workspace (per-window-workspace-context P-041). `agent_usage_samples`
   * is read through the admin handle, so the predicate must be explicit —
   * without it spend sums fold in every other workspace.
   */
  workspace_id: string;
  harness_slug: string;
  windowMs?: number;
  runQuery: <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;
}

interface SpendRow {
  runs: string | number | null;
  total_usd: string | number | null;
  estimated_usd: string | number | null;
  tokens: string | number | null;
}

const num = (v: string | number | null | undefined): number => {
  if (v == null) return 0;
  const n = typeof v === 'string' ? Number.parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
};

export async function loadHarnessSpend(
  opts: LoadHarnessSpendOpts,
): Promise<SpendCardProps> {
  const { workspace_id, harness_slug, runQuery } = opts;
  const windowMs = opts.windowMs ?? 7 * 24 * 60 * 60 * 1000;
  const windowStart = Date.now() - windowMs;

  try {
    const rows = await runQuery<SpendRow>(
      `SELECT COUNT(*)                                                        AS runs,
              COALESCE(SUM(cost_usd), 0)                                      AS total_usd,
              COALESCE(SUM(cost_usd) FILTER (WHERE cost_source = 'estimated'), 0) AS estimated_usd,
              -- ALL four token types (B-TOK-2 / token-tracking D-003): the prior
              -- input+output-only sum under-counted ~5x — cache-read is ~82% of all
              -- tokens (giant contexts re-read every turn), so omitting cache made the
              -- Spend card's token total wildly low. cache_* columns exist (mig 161/210).
              COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)
                           + COALESCE(cache_read_tokens, 0) + COALESCE(cache_creation_tokens, 0)), 0) AS tokens
         FROM harness_shared.agent_usage_samples
        WHERE workspace_id = $1
          AND harness_slug = $2
          AND ts >= $3`,
      [workspace_id, harness_slug, windowStart],
    );
    const r = rows[0];
    return {
      harnessTotalUsdThisWeek: num(r?.total_usd),
      estimatedUsdThisWeek: num(r?.estimated_usd),
      tokensThisWeek: num(r?.tokens),
      runsThisWeek: num(r?.runs),
    };
  } catch {
    // Pre-migration substrate (no harness_slug/cost_source columns yet) or
    // missing table — render the empty state.
    return {
      harnessTotalUsdThisWeek: 0,
      estimatedUsdThisWeek: 0,
      tokensThisWeek: 0,
      runsThisWeek: 0,
    };
  }
}
