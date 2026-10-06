/**
 * Re-price stored usage estimates under the running price table (WI-10004517;
 * agent-economy-flywheel-2026-08-30 D-018).
 *
 * `agent_usage_samples.cost_usd` with `cost_source='estimated'` is a list-price computation from
 * `@papercusp/model-pricing`. Before this, it was computed once at write time and never revisited:
 * a month of rows mixed every price regime the table passed through (it changed at least 9 times
 * in September 2026), and a row whose model was unpriced when written stayed NULL after the model
 * gained a price (3,343 rows in September). Every one of the ~85 readers of the column inherited
 * both errors.
 *
 * The fix keeps ONE formula (`costFromTokens`) and re-derives stored estimates with it:
 * - every row that does not carry provider-reported cost is stamped with the
 *   `PRICE_TABLE_VERSION` it was derived under (migration 1280);
 * - `repriceUsageSamples` re-derives every such row whose stamp differs from the running table
 *   and stamps it. Provider-reported cost is an observation and is never touched.
 *
 * The re-derivation reconstructs each writer's `TokenUsage` from the stored columns, so it has to
 * agree with the writer. The interactive transcript ingester (99.5% of estimated cost) prices
 * through `priceStoredUsageSample` itself, so it agrees by construction. The two run-aggregate
 * writers (orchestrator `usage-sample-pg.ts`, operator-core `agent-usage-telemetry.ts`) live in
 * packages that cannot import this module; their shape is `{input, output, cacheRead,
 * cacheCreation}` with absent counters treated as zero, and the unit test pins the reconstruction
 * to exactly that call.
 */
import type { Sql } from 'postgres';
import {
  PRICE_TABLE_VERSION, USAGE_LEDGER_PRICING, costFromTokens, type CostEstimate, type CostOptions, type TokenUsage,
} from '@papercusp/model-pricing';

/** `costFromTokens`'s shape; tests inject a changed table through it. */
export type UsagePricer = (model: string, usage: TokenUsage, options?: CostOptions) => CostEstimate;

/** Writers whose usage shape `storedSampleTokenUsage` reconstructs. Any other source is left alone. */
export const REPRICEABLE_USAGE_SOURCES = ['interactive', 'jsonl', 'headers'] as const;
export type RepriceableUsageSource = (typeof REPRICEABLE_USAGE_SOURCES)[number];

type Count = string | number | bigint | null | undefined;

/** The stored columns a usage estimate is derived from (bigints may arrive as strings). */
export interface StoredUsageSample {
  source: string;
  provider: string | null;
  model: string | null;
  input_tokens: Count;
  output_tokens: Count;
  cache_read_tokens: Count;
  cache_creation_tokens: Count;
  cache_creation_5m_tokens: Count;
  cache_creation_1h_tokens: Count;
  /** `usage_provenance->>'grain'`: `request` rows are one request, so they carry a request size. */
  grain: string | null;
}

export interface StoredUsagePrice {
  costUsd: number | null;
  costSource: 'estimated' | null;
  /**
   * `'lower'` when the row cannot establish a price tier and the cost is that tier's floor:
   * cache writes with no TTL split (5-minute rate, D-019), or an aggregate of a model with a
   * long-context tier (standard-context rate, D-020). Persisted as `usage_provenance.costBound`.
   * Measured 2026-10-01: sampled rows of both kinds written before the tier rule existed
   * (opus-4-7/4-8, sonnet-4-6 writes; 312 gpt-6-astra aggregates) had been stored at exactly
   * this floor, so re-deriving it keeps that history instead of nulling it.
   */
  costBound: 'lower' | null;
}

const count = (v: Count): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The `TokenUsage` the row's writer priced, rebuilt from the stored columns. `null` means the
 * stored row cannot be priced at all (no model, an unknown source, or an interactive row whose
 * uncached input was never decomposed).
 */
export function storedSampleTokenUsage(row: StoredUsageSample): TokenUsage | null {
  if (!row.model) return null;
  const input = count(row.input_tokens);
  const output = count(row.output_tokens);
  const cacheRead = count(row.cache_read_tokens);
  const cacheCreation = count(row.cache_creation_tokens);
  if (row.source === 'jsonl' || row.source === 'headers') {
    // usage-sample-pg.ts / agent-usage-telemetry.ts: costFromTokens(model, usage,
    // USAGE_LEDGER_PRICING) over the four counters, an absent counter priced as zero. A run
    // aggregate has no request size, so a long-context model prices at its standard-tier floor.
    return {
      inputTokens: input ?? undefined,
      outputTokens: output ?? undefined,
      cacheReadTokens: cacheRead ?? undefined,
      cacheCreationTokens: cacheCreation ?? undefined,
    };
  }
  if (row.source !== 'interactive') return null;
  // ingest-claude-transcripts.ts encodes its flags as NULL columns: NULL input = the uncached
  // input was never decomposed; NULL cache writes = the source did not report them; a NULL
  // write tier on an Anthropic row with writes = the TTL split is unknown.
  if (input === null) return null;
  const usage: TokenUsage = { inputTokens: input, outputTokens: output ?? 0, cacheReadTokens: cacheRead ?? 0 };
  if (cacheCreation === null) usage.cacheCreationUnreported = true;
  else usage.cacheCreationTokens = cacheCreation;
  const fiveMinute = count(row.cache_creation_5m_tokens);
  const oneHour = count(row.cache_creation_1h_tokens);
  if (fiveMinute !== null && oneHour !== null) {
    usage.cacheCreation5mTokens = fiveMinute;
    usage.cacheCreation1hTokens = oneHour;
  } else if (row.provider === 'anthropic' && (cacheCreation ?? 0) > 0) {
    usage.cacheCreationTierUnknown = true;
  }
  if (row.grain === 'request') usage.requestInputTokens = input + (cacheRead ?? 0) + (cacheCreation ?? 0);
  return usage;
}

/** Price one stored row under the running table (or an injected one, for tests). */
export function priceStoredUsageSample(row: StoredUsageSample, price: UsagePricer = costFromTokens): StoredUsagePrice {
  const usage = storedSampleTokenUsage(row);
  if (!usage || !row.model) return { costUsd: null, costSource: null, costBound: null };
  // A ledger row floors an unknown tier (an aggregate's long-context tier, an unsplit cache
  // write) and records the bound, rather than erasing measured cost (D-019, D-020).
  const est = price(row.model, usage, USAGE_LEDGER_PRICING);
  if (!est.priced) return { costUsd: null, costSource: null, costBound: null };
  return { costUsd: est.usd, costSource: 'estimated', costBound: est.bound ?? null };
}

export interface RepriceUsageOptions {
  /** Restrict to one workspace (default: every workspace). */
  workspaceId?: string;
  /** Rows per UPDATE (default 5000). */
  batchSize?: number;
  /** Batches per call, so one routine tick stays bounded (default 40 = 200k rows). */
  maxBatches?: number;
  /** Version to stamp; defaults to the running table. Tests inject a table through `price`. */
  version?: string;
  price?: UsagePricer;
}

export interface RepriceUsageResult {
  version: string;
  /** Rows re-derived and stamped. */
  stamped: number;
  /** Of those, rows whose cost or cost_source actually changed. */
  changed: number;
  /** NULL cost before, priced now. */
  newlyPriced: number;
  /** Priced before, unpriced now (the model left the table, or the row cannot be decomposed). */
  newlyUnpriced: number;
  /** Rows a concurrent writer updated between read and write; retried on the next call. */
  skippedConcurrent: number;
  /** True when the stale set was exhausted inside this call's batch budget. */
  complete: boolean;
  /** Changed-row count per model, for the routine log. */
  changedByModel: Record<string, number>;
}

interface StaleRow extends StoredUsageSample {
  id: string;
  row_xmin: string;
  cost_usd: number | null;
  cost_source: string | null;
  cost_bound: string | null;
}

/**
 * Re-derive every non-provider usage row whose `price_table_version` differs from `version`,
 * in id order, and stamp it. Idempotent: a second call with the same table finds nothing.
 * Optimistic per row (`xmin`): a row the ingester rewrote mid-batch is skipped, not clobbered.
 */
export async function repriceUsageSamples(sql: Sql, opts: RepriceUsageOptions = {}): Promise<RepriceUsageResult> {
  const version = opts.version ?? PRICE_TABLE_VERSION;
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? 5000));
  const maxBatches = Math.max(1, Math.floor(opts.maxBatches ?? 40));
  const sources = [...REPRICEABLE_USAGE_SOURCES];
  const result: RepriceUsageResult = {
    version, stamped: 0, changed: 0, newlyPriced: 0, newlyUnpriced: 0, skippedConcurrent: 0,
    complete: false, changedByModel: {},
  };
  let cursor = '0';
  for (let batch = 0; batch < maxBatches; batch++) {
    // (IS NULL OR < v OR > v) rather than IS DISTINCT FROM: it lets the partial index from
    // migration 1280 answer an empty stale set without reading the table.
    // Every column is qualified with `u.` on purpose. The output alias `id` is TEXT, and an
    // unqualified `ORDER BY id` binds to the output alias, not the bigint column. That sorted
    // the keyset lexicographically ('10000' < '6775') while the cursor compared numerically,
    // so each batch jumped the cursor past whole id ranges and the call reported `complete`
    // with ~73% of the stale rows untouched (WI-10004517 backfill, 2026-10-01).
    const rows = await sql<StaleRow[]>`
      SELECT u.id::text AS id, u.xmin::text AS row_xmin, u.source, u.provider, u.model,
             u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_creation_tokens,
             u.cache_creation_5m_tokens, u.cache_creation_1h_tokens,
             u.usage_provenance->>'grain' AS grain, u.cost_usd, u.cost_source,
             u.usage_provenance->>'costBound' AS cost_bound
        FROM harness_shared.agent_usage_samples u
       WHERE u.cost_source IS DISTINCT FROM 'provider'
         AND (u.price_table_version IS NULL OR u.price_table_version < ${version} OR u.price_table_version > ${version})
         -- A list, not sql.array(): it needs no array-type OID, so it does not depend on the
         -- client having run seedBuiltinArrayTypes (canonical clients do; a bare one-off
         -- postgres(url) client does not, and refused the ANY form on its first query).
         AND u.source IN ${sql([...sources])}
         AND u.id > ${cursor}::bigint
         ${opts.workspaceId ? sql`AND u.workspace_id = ${opts.workspaceId}` : sql``}
       ORDER BY u.id
       LIMIT ${batchSize}`;
    if (rows.length === 0) {
      result.complete = true;
      break;
    }
    cursor = rows[rows.length - 1]!.id;
    const updates = rows.map((row) => {
      const next = priceStoredUsageSample(row, opts.price);
      const before = row.cost_usd === null ? null : Number(row.cost_usd);
      const changed = next.costSource !== row.cost_source ||
        next.costBound !== (row.cost_bound ?? null) ||
        (next.costUsd === null) !== (before === null) ||
        (next.costUsd !== null && before !== null && Math.abs(next.costUsd - before) > 1e-12);
      return { row, next, before, changed };
    });
    // usage_provenance is rewritten only when the bound changes, so a jsonl/headers row whose
    // provenance is NULL stays NULL.
    const written = await sql<Array<{ id: string }>>`
      UPDATE harness_shared.agent_usage_samples s
         SET cost_usd = v.cost_usd, cost_source = v.cost_source, price_table_version = ${version},
             usage_provenance = CASE
               WHEN v.cost_bound IS NOT DISTINCT FROM (s.usage_provenance->>'costBound') THEN s.usage_provenance
               ELSE COALESCE(s.usage_provenance, '{}'::jsonb) || jsonb_build_object('costBound', v.cost_bound)
             END
        FROM jsonb_to_recordset(${JSON.stringify(updates.map(({ row, next }) => ({
          id: row.id, row_xmin: row.row_xmin, cost_usd: next.costUsd, cost_source: next.costSource,
          cost_bound: next.costBound,
        })))}::jsonb) AS v(id bigint, row_xmin text, cost_usd double precision, cost_source text, cost_bound text)
       WHERE s.id = v.id AND s.xmin::text = v.row_xmin
       RETURNING s.id::text AS id`;
    const writtenIds = new Set(written.map((w) => w.id));
    for (const { row, next, before, changed } of updates) {
      if (!writtenIds.has(row.id)) {
        result.skippedConcurrent += 1;
        continue;
      }
      result.stamped += 1;
      if (!changed) continue;
      result.changed += 1;
      if (before === null && next.costUsd !== null) result.newlyPriced += 1;
      if (before !== null && next.costUsd === null) result.newlyUnpriced += 1;
      const model = row.model ?? '(none)';
      result.changedByModel[model] = (result.changedByModel[model] ?? 0) + 1;
    }
    if (rows.length < batchSize) {
      result.complete = true;
      break;
    }
  }
  return result;
}
