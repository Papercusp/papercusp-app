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

export interface HarnessPipelineSpend {
  /** Priced subtotal; a lower bound when complete is false. */
  knownUsd: number;
  providerUsd: number;
  estimatedUsd: number;
  complete: boolean;
  measured: boolean;
  /** This census covers retained output/usage rows, not unrecorded invocations. */
  coverageBasis: 'retained-run-output-and-usage-samples';
  missingRunIds: string[];
  samples: Array<{ runId: string | null; sampleId: string; costUsd: number | null;
    costSource: string | null; provenance: unknown }>;
}

/** Native pipeline accounting uses the attributed usage ledger, never the FS mirror.
 * Keep the UI's empty-state projection separate from this evidence-bearing read. */
export async function loadHarnessPipelineSpend(
  opts: Pick<LoadHarnessSpendOpts, 'workspace_id' | 'harness_slug' | 'runQuery'>,
): Promise<HarnessPipelineSpend> {
  const rows = await opts.runQuery<{ run_id: string | null; archived: boolean;
    sample_id: string | number | null; cost_usd: string | number | null;
    cost_source: string | null; usage_provenance: unknown }>(
    `WITH runs AS (
       SELECT run_id FROM harness_shared.harness_run_output
        WHERE workspace_id = $1 AND harness_slug = $2
     ), samples AS (
       SELECT id, run_id, cost_usd, cost_source, usage_provenance
         FROM harness_shared.agent_usage_samples
        WHERE workspace_id = $1 AND harness_slug = $2 AND source = 'jsonl'
     )
     SELECT COALESCE(r.run_id, s.run_id) AS run_id, r.run_id IS NOT NULL AS archived,
            s.id AS sample_id, s.cost_usd, s.cost_source, s.usage_provenance
       FROM runs r FULL JOIN samples s ON s.run_id = r.run_id
      ORDER BY COALESCE(r.run_id, s.run_id), s.id`,
    [opts.workspace_id, opts.harness_slug],
  );
  const out: HarnessPipelineSpend = { knownUsd: 0, providerUsd: 0, estimatedUsd: 0,
    complete: rows.length > 0, measured: rows.length > 0,
    coverageBasis: 'retained-run-output-and-usage-samples', missingRunIds: [], samples: [] };
  const missing = new Set<string>();
  for (const row of rows) {
    const cost = row.cost_usd == null ? null : Number(row.cost_usd);
    const priced = cost !== null && Number.isFinite(cost) && cost >= 0
      && (row.cost_source === 'provider' || row.cost_source === 'estimated');
    if (!row.archived || row.sample_id == null || !priced) {
      out.complete = false;
      if (row.run_id) missing.add(row.run_id);
    }
    if (row.sample_id != null) {
      out.samples.push({ runId: row.run_id, sampleId: String(row.sample_id),
        costUsd: priced ? cost : null, costSource: row.cost_source,
        provenance: row.usage_provenance });
      if (priced) {
        out.knownUsd += cost!;
        if (row.cost_source === 'provider') out.providerUsd += cost!;
        else out.estimatedUsd += cost!;
      }
    }
    if (!priced || row.cost_source !== 'provider') out.measured = false;
  }
  out.measured = out.measured && out.complete;
  out.missingRunIds = [...missing];
  return out;
}

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
