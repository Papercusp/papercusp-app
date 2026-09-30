/**
 * loadHarnessTokens — Insights → Tokens subtab data source (B-TOK-UI).
 *
 * Plan: token-tracking-plan-and-briefs-2026-06-20 (B-TOK-1). The SIBLING of
 * load-spend.ts: where SpendCard shows ONE headline total, the Tokens dashboard
 * breaks the same cache-inclusive spend DOWN by model, role, and time so the owner
 * can see WHERE the burn is (the 24h audit: opus = 90% of spend, cache-read = 82%
 * of all tokens — invisible until B-TOK-2 fixed the input+output-only ~5× undercount).
 *
 * Reads `harness_shared.agent_usage_samples` (rate-limit-layer-v2 mig 161 + the
 * cross-backend / cache_creation / attribution columns from mig 170/210/330),
 * workspace + harness scoped. CACHE-INCLUSIVE everywhere: every token sum is
 * input + output + cache_read + cache_creation (the same expression load-spend.ts
 * uses), so the dashboard never reproduces the undercount it exists to expose.
 *
 * Per-account attribution is available for rows stamped with
 * agent_usage_samples.account_id; pre-migration/unpinned rows remain grouped as
 * unattributed and hidden from the by-account chart.
 *
 * Pure logic — injectable runQuery (mirrors the per-card loaders). Defensive: a
 * missing table/column (pre-migration substrate) yields the empty snapshot so the
 * subtab renders its empty state rather than 500-ing.
 */

import type {
  TokensDashboardSnapshot,
  TokenGroupRow,
  TokenTimeBucket,
} from './card-types';

export interface LoadHarnessTokensOpts {
  /** Request workspace (per-window-workspace-context). Explicit predicate so the
   *  sums never fold in another workspace through the admin handle. */
  workspace_id: string;
  harness_slug: string;
  windowMs?: number;
  /** Cap rows per grouped breakdown (model/role). Default 20. */
  groupLimit?: number;
  runQuery: <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;
}

const num = (v: string | number | null | undefined): number => {
  if (v == null) return 0;
  const n = typeof v === 'string' ? Number.parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** The cache-inclusive token sum — the ONE expression every query reuses. */
const TOKENS_EXPR = `COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)
                     + COALESCE(cache_read_tokens, 0) + COALESCE(cache_creation_tokens, 0)`;

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Deterministic UTC 'MMM D' label (no locale dependence in the loader). */
function dayLabel(startMs: number): string {
  const d = new Date(startMs);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

interface TotalsRow {
  runs: string | number | null;
  total_usd: string | number | null;
  estimated_usd: string | number | null;
  tokens: string | number | null;
  input_tokens: string | number | null;
  output_tokens: string | number | null;
  cache_read_tokens: string | number | null;
  cache_creation_tokens: string | number | null;
}
interface GroupRow {
  key: string | null;
  tokens: string | number | null;
  cost_usd: string | number | null;
  runs: string | number | null;
}
interface DayRow {
  day_start: string | number | null;
  tokens: string | number | null;
  cost_usd: string | number | null;
}

function emptySnapshot(windowMs: number, accountAttributionAvailable = true): TokensDashboardSnapshot {
  return {
    windowMs,
    totals: {
      tokens: 0,
      costUsd: 0,
      estimatedUsd: 0,
      runs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    byModel: [],
    byRole: [],
    byAccount: [],
    byDay: [],
    accountAttributionAvailable,
  };
}

export async function loadHarnessTokens(
  opts: LoadHarnessTokensOpts,
): Promise<TokensDashboardSnapshot> {
  const { workspace_id, harness_slug, runQuery } = opts;
  const windowMs = opts.windowMs ?? 7 * DAY_MS;
  const groupLimit = Math.max(1, Math.min(100, opts.groupLimit ?? 20));
  const windowStart = Date.now() - windowMs;
  const scope = [workspace_id, harness_slug, windowStart];

  try {
    const [totalsRows, modelRows, roleRows, accountRows, dayRows] = await Promise.all([
      runQuery<TotalsRow>(
        `SELECT COUNT(*)                                                          AS runs,
                COALESCE(SUM(cost_usd), 0)                                        AS total_usd,
                COALESCE(SUM(cost_usd) FILTER (WHERE cost_source = 'estimated'), 0) AS estimated_usd,
                COALESCE(SUM(${TOKENS_EXPR}), 0)                                  AS tokens,
                COALESCE(SUM(COALESCE(input_tokens, 0)), 0)                       AS input_tokens,
                COALESCE(SUM(COALESCE(output_tokens, 0)), 0)                      AS output_tokens,
                COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0)                  AS cache_read_tokens,
                COALESCE(SUM(COALESCE(cache_creation_tokens, 0)), 0)             AS cache_creation_tokens
           FROM harness_shared.agent_usage_samples
          WHERE workspace_id = $1 AND harness_slug = $2 AND ts >= $3`,
        scope,
      ),
      runQuery<GroupRow>(
        `SELECT COALESCE(NULLIF(model, ''), model_class, 'unknown') AS key,
                COALESCE(SUM(${TOKENS_EXPR}), 0)                     AS tokens,
                COALESCE(SUM(cost_usd), 0)                           AS cost_usd,
                COUNT(*)                                             AS runs
           FROM harness_shared.agent_usage_samples
          WHERE workspace_id = $1 AND harness_slug = $2 AND ts >= $3
          GROUP BY 1
          ORDER BY tokens DESC
          LIMIT ${groupLimit}`,
        scope,
      ),
      runQuery<GroupRow>(
        `SELECT COALESCE(NULLIF(role, ''), 'unattributed') AS key,
                COALESCE(SUM(${TOKENS_EXPR}), 0)            AS tokens,
                COALESCE(SUM(cost_usd), 0)                  AS cost_usd,
                COUNT(*)                                    AS runs
           FROM harness_shared.agent_usage_samples
          WHERE workspace_id = $1 AND harness_slug = $2 AND ts >= $3
          GROUP BY 1
          ORDER BY tokens DESC
          LIMIT ${groupLimit}`,
        scope,
      ),
      runQuery<GroupRow>(
        `SELECT account_id AS key,
                COALESCE(SUM(${TOKENS_EXPR}), 0) AS tokens,
                COALESCE(SUM(cost_usd), 0)       AS cost_usd,
                COUNT(*)                         AS runs
           FROM harness_shared.agent_usage_samples
          WHERE workspace_id = $1 AND harness_slug = $2 AND ts >= $3
            AND account_id IS NOT NULL
          GROUP BY 1
          ORDER BY tokens DESC
          LIMIT ${groupLimit}`,
        scope,
      ),
      runQuery<DayRow>(
        // ts is epoch ms; floor to the UTC day boundary so each bucket is one day.
        `SELECT (FLOOR(ts / ${DAY_MS}) * ${DAY_MS})::bigint AS day_start,
                COALESCE(SUM(${TOKENS_EXPR}), 0)            AS tokens,
                COALESCE(SUM(cost_usd), 0)                  AS cost_usd
           FROM harness_shared.agent_usage_samples
          WHERE workspace_id = $1 AND harness_slug = $2 AND ts >= $3
          GROUP BY 1
          ORDER BY day_start ASC`,
        scope,
      ),
    ]);

    const t = totalsRows[0];
    const toGroup = (r: GroupRow): TokenGroupRow => ({
      key: r.key ?? 'unknown',
      tokens: num(r.tokens),
      costUsd: num(r.cost_usd),
      runs: num(r.runs),
    });
    const toDay = (r: DayRow): TokenTimeBucket => {
      const startMs = num(r.day_start);
      return { startMs, label: dayLabel(startMs), tokens: num(r.tokens), costUsd: num(r.cost_usd) };
    };

    return {
      windowMs,
      totals: {
        tokens: num(t?.tokens),
        costUsd: num(t?.total_usd),
        estimatedUsd: num(t?.estimated_usd),
        runs: num(t?.runs),
        inputTokens: num(t?.input_tokens),
        outputTokens: num(t?.output_tokens),
        cacheReadTokens: num(t?.cache_read_tokens),
        cacheCreationTokens: num(t?.cache_creation_tokens),
      },
      byModel: modelRows.map(toGroup),
      byRole: roleRows.map(toGroup),
      byAccount: accountRows.map(toGroup),
      byDay: dayRows.map(toDay),
      accountAttributionAvailable: true,
    };
  } catch {
    // Pre-migration substrate (missing column/table) — render the empty state.
    return emptySnapshot(windowMs, false);
  }
}
