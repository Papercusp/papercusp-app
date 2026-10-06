/**
 * Agent usage telemetry (rate-limit-layer-v2 D-002) — one row per governed agent call into
 * `harness_shared.agent_usage_samples` (migration 161), and the aggregation the fleet read-model
 * surfaces. Extends cross-backend-cost-capture (which captured $ only) with token counts + the
 * `anthropic-ratelimit-*` snapshot.
 *
 * Captured at the TWO points usage is observable (D-002):
 *   1. the in-process anthropic-direct path (`recordUsageHeaders`) — real anthropic-ratelimit-* headers;
 *   2. the subprocess `{"type":"result", …usage}` JSONL event (`recordUsageTokens`) — token
 *      counts + $cost, visible even when the CLI hides the rate-limit headers.
 *
 * Honest limitation: a true "usage%" only exists when a provider exposes a ceiling (header-bearing
 * / API-key paths). The summary returns `usagePct: null` for subscription buckets rather than a
 * fabricated number — the surface shows throughput + $spend there instead.
 */
import { PRICE_TABLE_VERSION, USAGE_LEDGER_PRICING, costFromTokens } from '@papercusp/model-pricing';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';

export interface UsageSample {
  bucketKey: string;
  provider: string;
  modelClass: string;
  /** 'headers' (in-process anthropic-direct) | 'jsonl' (subprocess result) | 'interactive'
      (local Claude Code transcript ingest — token-usage-reduction-audit P-001). */
  source: 'headers' | 'jsonl' | 'interactive';
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  /** Prompt-cache WRITE tokens (1.25× input price) — migration 210. */
  cacheCreationTokens?: number;
  costUsd?: number;
  /** Per-run model id (migration 170) — enables estimated pricing + attribution. */
  model?: string;
  /** 'provider' (reported by the backend) vs 'estimated' (tokens × list price). Derived when omitted. */
  costSource?: 'provider' | 'estimated';
  /** Run attribution (migration 170) — set on the subprocess path; on header samples,
   *  filled from the caller's `usageAttribution` (the EI-7625 stateless seam) when passed. */
  harnessSlug?: string;
  runId?: string;
  role?: string;
  /** Per-call attribution (B-TOK-2, migration 279 + 330): the native session id and
   *  the tool/feature that made it. NULL where a path can't supply them (on the
   *  in-process header path, only what `usageAttribution` carried).
   *  NOTE: migration 330 also added a `planId` field here + a `plan_id` column —
   *  removed by migration 775 (EI-19969257626696510): 0 of 33,084 rows ever had it
   *  set (only 3 of 9 spawn call sites ever threaded a plan slug into the spawn at
   *  all) and nothing anywhere read it; the real goal->spend attribution keys off
   *  harness_slug, unaffected. */
  sessionId?: string;
  toolName?: string;
  /** Per-turn TRIGGER (B-TOK-4, migration 335): 'coord-wake' | 'cron' | 'autoloop' |
   *  'user'. NULL on the in-process header path (no turn-trigger context there). */
  turnTrigger?: string;
  /** Provider account that served the call, when the caller/gateway can identify it.
   *  NULL for routes without account pinning or pre-migration samples. */
  accountId?: string;
  rlRequestsLimit?: number;
  rlRequestsRemaining?: number;
  rlTokensLimit?: number;
  rlTokensRemaining?: number;
  rlResetAt?: number;
}

export interface UsageBucketSummary {
  key: string;
  provider: string;
  modelClass: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  spendUsd: number;
  /** (1 - remaining/limit) × 100 from the most-recent header sample; null when no ceiling known. */
  usagePct: number | null;
  rlResetAt: number | null;
}

export interface UsageSummary {
  windowMs: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  spendUsd: number;
  buckets: UsageBucketSummary[];
}

const TABLE = 'harness_shared.agent_usage_samples';

const n = (v: number | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Persist one usage sample (best-effort — telemetry must never break the agent path). */
export async function recordUsageSample(sample: UsageSample): Promise<void> {
  try {
    const { sql } = getOrgPg();
    const ws = activeWorkspaceId();
    // Cost honesty (cross-backend-cost-capture D-005): provider-reported cost wins;
    // a tokens-only sample with a known model is priced at list price and LABELED
    // estimated; an unpriceable sample persists NULL cost — never a fabricated zero.
    let costUsd = n(sample.costUsd);
    let costSource: string | null = sample.costSource ?? (costUsd !== null ? 'provider' : null);
    // The usage shape here — the four counters, absent ones priced as zero — must stay in step
    // with `storedSampleTokenUsage` ('headers'): the repricer re-derives this row from its stored
    // columns whenever the price table changes (WI-10004517 / D-018).
    // An aggregate of a long-context model prices at its standard-tier floor and records the
    // bound (D-020), exactly as the repricer would re-derive it.
    let costBound: 'lower' | null = null;
    if (costUsd === null && sample.model) {
      const est = costFromTokens(sample.model, {
        inputTokens: sample.inputTokens, outputTokens: sample.outputTokens,
        cacheReadTokens: sample.cacheReadTokens, cacheCreationTokens: sample.cacheCreationTokens,
      }, USAGE_LEDGER_PRICING);
      if (est.priced) {
        costUsd = est.usd;
        costSource = 'estimated';
        costBound = est.bound ?? null;
      }
    }
    // Stamp the table version on every row that does not carry provider cost; the repricer
    // treats any other stamp as stale. Provider cost is an observation and carries none.
    const priceTableVersion = costSource === 'provider' ? null : PRICE_TABLE_VERSION;
    await sql`
      INSERT INTO ${sql(TABLE)}
        (workspace_id, ts, bucket_key, provider, model_class, source,
         input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd,
         model, cost_source, harness_slug, run_id, role,
         rl_requests_limit, rl_requests_remaining, rl_tokens_limit, rl_tokens_remaining, rl_reset_at,
         session_id, goal_id, tool_name, turn_trigger, account_id, price_table_version, usage_provenance)
      VALUES (
        ${ws}, ${Date.now()}, ${sample.bucketKey}, ${sample.provider}, ${sample.modelClass}, ${sample.source},
        ${n(sample.inputTokens)}, ${n(sample.outputTokens)}, ${n(sample.cacheReadTokens)}, ${n(sample.cacheCreationTokens)}, ${costUsd},
        ${sample.model ?? null}, ${costSource}, ${sample.harnessSlug ?? null}, ${sample.runId ?? null}, ${sample.role ?? null},
        ${n(sample.rlRequestsLimit)}, ${n(sample.rlRequestsRemaining)}, ${n(sample.rlTokensLimit)}, ${n(sample.rlTokensRemaining)}, ${n(sample.rlResetAt)},
        ${sample.sessionId ?? null},
        (SELECT harness_shared.goal_id_for_usage_session(${ws}, ${sample.sessionId ?? null})),
        ${sample.toolName ?? null}, ${sample.turnTrigger ?? null}, ${sample.accountId ?? null}, ${priceTableVersion},
        ${costBound ? JSON.stringify({ costBound }) : null}::jsonb
      )
    `;
  } catch {
    /* telemetry is best-effort; never throw into the agent path */
  }
}

/** Capture from an in-process response's headers (the anthropic-direct path). Parses anthropic-ratelimit-*
    + any usage tokens the caller passes. No-op if nothing useful is present. */
export async function recordUsageHeaders(
  bucketKey: string,
  provider: string,
  modelClass: string,
  headers: Record<string, string | undefined>,
  /** Token counts + any caller attribution (role/runId/sessionId/toolName — the
   *  stateless `usageAttribution` seam) — spread verbatim onto the sample. */
  tokens?: Partial<
    Pick<
      UsageSample,
      | 'inputTokens'
      | 'outputTokens'
      | 'cacheReadTokens'
      | 'cacheCreationTokens'
      | 'costUsd'
      | 'accountId'
      | 'model'
      | 'harnessSlug'
      | 'runId'
      | 'role'
      | 'sessionId'
      | 'toolName'
      | 'turnTrigger'
    >
  >,
): Promise<void> {
  const h: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  const num = (v: string | undefined): number | undefined => {
    if (v === undefined) return undefined;
    const x = Number(v);
    return Number.isFinite(x) ? x : undefined;
  };
  const resetRaw = h['anthropic-ratelimit-tokens-reset'] ?? h['anthropic-ratelimit-requests-reset'];
  const resetAt = resetRaw ? Date.parse(resetRaw) : undefined;
  const sample: UsageSample = {
    bucketKey,
    provider,
    modelClass,
    source: 'headers',
    rlRequestsLimit: num(h['anthropic-ratelimit-requests-limit']),
    rlRequestsRemaining: num(h['anthropic-ratelimit-requests-remaining']),
    rlTokensLimit: num(h['anthropic-ratelimit-tokens-limit'] ?? h['anthropic-ratelimit-input-tokens-limit']),
    rlTokensRemaining: num(h['anthropic-ratelimit-tokens-remaining'] ?? h['anthropic-ratelimit-input-tokens-remaining']),
    rlResetAt: resetAt !== undefined && Number.isFinite(resetAt) ? resetAt : undefined,
    ...tokens,
  };
  // Skip a wholly-empty sample (no headers AND no tokens) to avoid noise.
  if (
    sample.rlRequestsLimit === undefined &&
    sample.rlTokensLimit === undefined &&
    sample.inputTokens === undefined &&
    sample.outputTokens === undefined &&
    sample.costUsd === undefined
  ) {
    return;
  }
  await recordUsageSample(sample);
}

/** Capture token usage from a subprocess result event (the JSONL `{"type":"result", …usage}`). */
export async function recordUsageTokens(
  bucketKey: string,
  provider: string,
  modelClass: string,
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    costUsd?: number;
  },
): Promise<void> {
  if (
    usage.inputTokens === undefined &&
    usage.outputTokens === undefined &&
    usage.costUsd === undefined
  ) {
    return;
  }
  await recordUsageSample({ bucketKey, provider, modelClass, source: 'jsonl', ...usage });
}

interface Row {
  bucket_key: string;
  provider: string;
  model_class: string;
  calls: string;
  input_tokens: string | null;
  output_tokens: string | null;
  cache_read_tokens: string | null;
  cache_creation_tokens: string | null;
  cost_usd: number | null;
  rl_tokens_limit: string | null;
  rl_tokens_remaining: string | null;
  rl_reset_at: string | null;
}

/** Aggregate the recent samples (last `windowMs`) into the fleet read-model usage summary. */
export async function summarizeUsage(windowMs = 60 * 60 * 1000): Promise<UsageSummary> {
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const since = Date.now() - windowMs;
  // Per-bucket aggregate + the most-recent header sample (for usage% / reset) via DISTINCT ON.
  const rows = await sql<Row[]>`
    WITH agg AS (
      SELECT bucket_key, provider, model_class,
             COUNT(*) AS calls,
             SUM(COALESCE(input_tokens, 0)) AS input_tokens,
             SUM(COALESCE(output_tokens, 0)) AS output_tokens,
             SUM(COALESCE(cache_read_tokens, 0)) AS cache_read_tokens,
             SUM(COALESCE(cache_creation_tokens, 0)) AS cache_creation_tokens,
             SUM(COALESCE(cost_usd, 0)) AS cost_usd
        FROM ${sql(TABLE)}
       WHERE workspace_id = ${ws} AND ts >= ${since}
       GROUP BY bucket_key, provider, model_class
    ),
    latest AS (
      SELECT DISTINCT ON (bucket_key) bucket_key, rl_tokens_limit, rl_tokens_remaining, rl_reset_at
        FROM ${sql(TABLE)}
       WHERE workspace_id = ${ws} AND ts >= ${since} AND rl_tokens_limit IS NOT NULL
       ORDER BY bucket_key, ts DESC
    )
    SELECT agg.*, latest.rl_tokens_limit, latest.rl_tokens_remaining, latest.rl_reset_at
      FROM agg LEFT JOIN latest USING (bucket_key)
     ORDER BY agg.bucket_key
  `;

  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let spendUsd = 0;
  const buckets: UsageBucketSummary[] = rows.map((r) => {
    const c = Number(r.calls);
    const it = Number(r.input_tokens ?? 0);
    const ot = Number(r.output_tokens ?? 0);
    const crt = Number(r.cache_read_tokens ?? 0);
    const cct = Number(r.cache_creation_tokens ?? 0);
    const cost = Number(r.cost_usd ?? 0);
    calls += c;
    inputTokens += it;
    outputTokens += ot;
    cacheReadTokens += crt;
    cacheCreationTokens += cct;
    spendUsd += cost;
    const limit = r.rl_tokens_limit !== null ? Number(r.rl_tokens_limit) : null;
    const remaining = r.rl_tokens_remaining !== null ? Number(r.rl_tokens_remaining) : null;
    const usagePct =
      limit !== null && limit > 0 && remaining !== null ? Math.max(0, Math.min(100, (1 - remaining / limit) * 100)) : null;
    return {
      key: r.bucket_key,
      provider: r.provider,
      modelClass: r.model_class,
      calls: c,
      inputTokens: it,
      outputTokens: ot,
      cacheReadTokens: crt,
      cacheCreationTokens: cct,
      spendUsd: cost,
      usagePct,
      rlResetAt: r.rl_reset_at !== null ? Number(r.rl_reset_at) : null,
    };
  });

  return { windowMs, calls, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, spendUsd, buckets };
}
