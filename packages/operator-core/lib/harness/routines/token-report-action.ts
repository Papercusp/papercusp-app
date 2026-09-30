/**
 * `system:token-weekly-report` — the SQL-only week-over-week token/spend report
 * (token-usage-reduction-audit-2026-06-09 P-003; the re-measure gate for every
 * reduction item in that plan).
 *
 * Aggregates `harness_shared.agent_usage_samples` for the trailing window vs the
 * window before it (per source, per model class, top roles) and broadcasts one
 * coord notification. Zero LLM calls — pure SQL + string assembly.
 *
 * Config (routine `trigger_config`, optional):
 *   - `window_days` — report window (default 7).
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { sendMessage } from '../../agent-tools/coordination/messages';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { PRESENCE_INLINE_GLANCE_TOKEN_BUDGET } from '../../agent-tools/coordination/presence-cost';
import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { evaluateCarryStartup, type CarryStartupObservation } from '../../launch-cost/launch-cost-metrics';

/** Coord identity for the report broadcast (mirrors git-sync / service-health). */
const TOKEN_REPORT_IDENTITY: AgentIdentity = {
  ownerId: 'system:token-report',
  ownerLabel: 'token-report',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

export interface AggRow {
  dim: string;
  calls: string;
  in_t: string | null;
  out_t: string | null;
  cr_t: string | null;
  cw_t: string | null;
  usd: number | null;
  incomplete_tokens: string;
  unpriced: string;
  estimated_usd: number | null;
  reported_usd: number | null;
  comparable_read: string | null;
  comparable_input: string | null;
  comparable_samples: string;
  request_observations: string;
  request_hits: string;
  unrecoverable_samples: string;
}

const mtok = (v: string | null): number => Number(v ?? 0) / 1e6;
const fmtM = (v: number): string => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
const fmtUsd = (v: number | null): string => v === null ? 'unknown' : `$${v.toFixed(2)}`;
const rate = (a: number, b: number): string => b > 0 ? `${(100 * a / b).toFixed(2)}%` : 'unknown';

export function renderDim(label: string, cur: AggRow[], prev: Map<string, AggRow>): string {
  const lines = [`**By ${label}** (window vs prior):`];
  for (const r of cur.slice(0, 12)) {
    const p = prev.get(r.dim);
    const curTok = mtok(r.in_t) + mtok(r.out_t) + mtok(r.cr_t) + mtok(r.cw_t);
    const prevTok = p ? mtok(p.in_t) + mtok(p.out_t) + mtok(p.cr_t) + mtok(p.cw_t) : 0;
    const complete = Number(r.incomplete_tokens) === 0;
    const delta = complete && p && Number(p.incomplete_tokens) === 0 && prevTok > 0
      ? ` (${curTok >= prevTok ? '+' : ''}${(((curTok - prevTok) / prevTok) * 100).toFixed(0)}%)` : '';
    lines.push(
      `- ${r.dim}: ${complete ? '' : '≥'}${fmtM(curTok)} MTok${delta} — ` +
        `${r.cr_t === null ? 'unknown' : fmtM(mtok(r.cr_t)) + 'M known'} cache-read + ` +
        `${r.cw_t === null ? 'unknown' : fmtM(mtok(r.cw_t)) + 'M known'} cache-write, ` +
        `${r.out_t === null ? 'unknown' : fmtM(mtok(r.out_t)) + 'M known'} out; ` +
        `${fmtUsd(r.estimated_usd)} list-price estimate + ${fmtUsd(r.reported_usd)} provider-reported, ` +
        `${r.unpriced}/${r.calls} unpriced samples; ${r.unrecoverable_samples}/${r.calls} source-unavailable. ` +
        `Token reuse ${rate(Number(r.comparable_read), Number(r.comparable_input))} ` +
        `(${r.comparable_samples}/${r.calls} comparable samples); ` +
        `requests with any cache read ${rate(Number(r.request_hits), Number(r.request_observations))} ` +
        `(${r.request_observations} request-grain observations; ${r.calls} ledger samples).`,
    );
  }
  if (cur.length > 12) lines.push(`- (${cur.length - 12} smaller groups omitted here; included in totals)`);
  if (cur.length === 0) lines.push('- (no samples)');
  return lines.join('\n');
}

/**
 * The presence/coord READ surface the P-016 guardrail watches (presence-v2 D-009
 * — "presence-v2 adds payload to a system token-usage-reduction just shrank; it
 * only wins if hive-scope + read-once+delta hold — guardrail in the weekly
 * report"). coord:presence is the roster read itself; coord:inbox is the
 * [coord+N] delta channel presence rides (token-usage-reduction's #4 payload);
 * fleet:assignments is the folded work-detail projection (P-006/P-007).
 */
const PRESENCE_READ_TOOLS: string[] = ['coord:presence', 'coord:inbox', 'fleet:assignments'];

interface VolRow {
  tool: string;
  calls: string;
  bytes: string | null;
  avg_bytes: string | null;
}

const fmtBytes = (b: number): string =>
  b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${(b / 1e3).toFixed(1)} KB` : `${Math.round(b)} B`;

const wowPct = (cur: number, prev: number): string =>
  prev > 0 ? ` (${cur >= prev ? '+' : ''}${(((cur - prev) / prev) * 100).toFixed(0)}%)` : '';

/**
 * Render the presence/coord read-volume guardrail block (presence-v2-2026-06-14
 * P-016): per tool, calls + total payload bytes + avg/call, each with a
 * week-over-week delta. Makes a richer presence's token cost NON-silent — a
 * regression in the call-count (#1) or tool-result-size (#2) levers shows as a
 * WoW jump. The result-size signal is `tool_invocations.output_size` (the
 * serialized result length the generic dispatch records for every tool). Pure
 * (rows in → string out) so it is unit-testable without a DB.
 */
export function renderPresenceVolume(cur: VolRow[], prev: VolRow[]): string {
  const prevByTool = new Map(prev.map((r) => [r.tool, r]));
  const lines = [
    `**Presence/coord read-volume** (guardrail — presence-v2-2026-06-14 P-016; watches the levers a ` +
      `richer presence could regress: #1 call-count, #2 tool-result size). A hive-scoped read should be ` +
      `a <~${PRESENCE_INLINE_GLANCE_TOKEN_BUDGET}-token inline glance; workspace/admin reads are larger ` +
      `by design, so a WoW jump — not the absolute size — is the regression signal.`,
  ];
  let any = false;
  for (const tool of PRESENCE_READ_TOOLS) {
    const c = cur.find((r) => r.tool === tool);
    const p = prevByTool.get(tool);
    const calls = Number(c?.calls ?? 0);
    const bytes = Number(c?.bytes ?? 0);
    const avg = Number(c?.avg_bytes ?? 0);
    if (calls > 0) any = true;
    lines.push(
      `- ${tool}: ${calls} calls${wowPct(calls, Number(p?.calls ?? 0))} — ` +
        `${fmtBytes(bytes)} payload${wowPct(bytes, Number(p?.bytes ?? 0))}, avg ${fmtBytes(avg)}/call`,
    );
  }
  if (!any) lines.push('- (no presence/coord reads recorded this window)');
  return lines.join('\n');
}

/** Query and render share the same coverage contract; exported for real-PG tests. */
export async function readTokenReportAggregation(
  sql: Sql, workspaceId: string, dim: 'source' | 'model_class' | 'role', from: number, to: number,
): Promise<AggRow[]> {
  return sql<AggRow[]>`
    WITH observations AS (
      SELECT *, CASE
        WHEN jsonb_typeof(usage_provenance->'inputTotalTokens') = 'number'
          THEN (usage_provenance->>'inputTotalTokens')::numeric
        WHEN input_tokens IS NOT NULL AND cache_read_tokens IS NOT NULL AND cache_creation_tokens IS NOT NULL
          THEN input_tokens + cache_read_tokens + cache_creation_tokens
        ELSE NULL END AS total_input
      FROM harness_shared.agent_usage_samples
      WHERE workspace_id = ${workspaceId} AND ts >= ${from} AND ts < ${to}
    )
    SELECT COALESCE(${sql(dim)}, '(none)') || CASE WHEN event_ts IS NULL
             THEN ' [ingestion-time; request time unavailable]' ELSE ' [request-time]' END AS dim,
           COUNT(*) AS calls,
           SUM(input_tokens) AS in_t, SUM(output_tokens) AS out_t,
           SUM(cache_read_tokens) AS cr_t, SUM(cache_creation_tokens) AS cw_t,
           SUM(cost_usd) AS usd,
           COUNT(*) FILTER (WHERE input_tokens IS NULL OR output_tokens IS NULL OR
             cache_read_tokens IS NULL OR cache_creation_tokens IS NULL) AS incomplete_tokens,
           COUNT(*) FILTER (WHERE cost_usd IS NULL) AS unpriced,
           SUM(cost_usd) FILTER (WHERE cost_source = 'estimated') AS estimated_usd,
           SUM(cost_usd) FILTER (WHERE cost_source = 'provider') AS reported_usd,
           SUM(cache_read_tokens) FILTER (WHERE total_input IS NOT NULL AND cache_read_tokens IS NOT NULL) AS comparable_read,
           SUM(total_input) FILTER (WHERE total_input IS NOT NULL AND cache_read_tokens IS NOT NULL) AS comparable_input,
           COUNT(*) FILTER (WHERE total_input IS NOT NULL AND cache_read_tokens IS NOT NULL) AS comparable_samples,
           COUNT(*) FILTER (WHERE usage_provenance->>'grain' = 'request' AND cache_read_tokens IS NOT NULL) AS request_observations,
           COUNT(*) FILTER (WHERE usage_provenance->>'grain' = 'request' AND cache_read_tokens > 0) AS request_hits,
           COUNT(*) FILTER (WHERE usage_provenance->'historicalAvailability'->>'status' = 'source-unavailable') AS unrecoverable_samples
      FROM observations
     GROUP BY 1 ORDER BY SUM(COALESCE(cache_read_tokens,0)+COALESCE(cache_creation_tokens,0)+COALESCE(input_tokens,0)) DESC
  `;
}

export interface CarryHealthRow {
  cohort: string;
  observations: CarryStartupObservation[];
}

/** Extend the existing report over the request ledger. No transcript crawl or second schedule.
 * Window cuts and pre-instrumentation sources stay visible as unknown source groups.
 */
export async function readCarryHealth(sql: Sql, workspaceId: string, from: number, to: number): Promise<CarryHealthRow[]> {
  return sql<CarryHealthRow[]>`
    SELECT provider || ':' || COALESCE(model, '(unknown)') || ':' || source AS cohort,
      COALESCE(jsonb_agg(jsonb_build_object(
        'requestOrdinal', usage_provenance->'requestOrdinal',
        'inputTotalTokens', usage_provenance->'inputTotalTokens',
        'cacheReadTokens', CASE WHEN usage_provenance->>'cacheReadSource' = 'reported' THEN cache_read_tokens END,
        'cacheWriteTokens', cache_creation_tokens,
        'contextGeneration', usage_provenance->'contextGeneration',
        'predecessorSessionId', usage_provenance->'predecessorSessionId'
      )) FILTER (WHERE usage_provenance->>'requestOrdinal' IN ('1', '2', '3')), '[]'::jsonb) AS observations
    FROM harness_shared.agent_usage_samples
    WHERE workspace_id = ${workspaceId} AND ts >= ${from} AND ts < ${to}
      AND usage_provenance->>'adapter' ~ '^codex(-iso-[0-9]+)?$'
      AND usage_provenance->>'grain' = 'request'
    GROUP BY 1, session_id, usage_provenance->>'sourceFile', usage_provenance->>'fileGeneration'
    ORDER BY 1
  `;
}

export function renderCarryHealth(rows: CarryHealthRow[]): string {
  if (!rows.length) return '**Codex carry startup health:** unknown — no request observations.';
  const cohorts = new Map<string, { sources: number; unknown: number; cold: number; compacted: number }>();
  for (const row of rows) {
    const result = evaluateCarryStartup(row.observations);
    const count = cohorts.get(row.cohort) ?? { sources: 0, unknown: 0, cold: 0, compacted: 0 };
    count.sources++;
    count.unknown += Number(result.unknown.length > 0);
    count.cold += Number(result.signals.includes('cold-inherited-startup'));
    count.compacted += Number(result.signals.includes('oversized-startup-immediately-compacted'));
    cohorts.set(row.cohort, count);
  }
  return ['**Codex carry startup health** (provisional: first two requests ≥600k input, ≤10% read reuse; immediate compaction = request 3):',
    ...[...cohorts].map(([key, count]) => `- ${key}: ${count.sources} source groups; ` +
      `${count.unknown} incomplete; ${count.cold} cold inherited startup; ${count.compacted} oversized startup immediately compacted.`),
    'Unknown write counts are not zero. These structural signals do not establish a remote cache-miss cause or matched-task savings.',
  ].join('\n');
}

export interface UsageHealthRow {
  cohort: string;
  samples: string;
  timed_requests: string;
  unknown_model: string;
  unknown_writes: string;
  unknown_tiers: string;
  tier_mismatches: string;
  model_provenance_mismatches: string;
  newest_event: string | null;
}

/** Same ledger and schedule as the token report; aggregate counters only, no prompt payloads. */
export async function readUsageHealth(sql: Sql, workspaceId: string, from: number, to: number): Promise<UsageHealthRow[]> {
  return sql<UsageHealthRow[]>`
    SELECT provider || ':' || COALESCE(model, '(unknown)') || ':' || source AS cohort,
      COUNT(*) AS samples,
      COUNT(*) FILTER (WHERE usage_provenance->>'grain' = 'request' AND event_ts IS NOT NULL) AS timed_requests,
      COUNT(*) FILTER (WHERE model IS NULL OR model = 'unknown-openai') AS unknown_model,
      COUNT(*) FILTER (WHERE cache_creation_tokens IS NULL) AS unknown_writes,
      COUNT(*) FILTER (WHERE provider = 'anthropic' AND cache_creation_tokens > 0 AND
        (cache_creation_5m_tokens IS NULL OR cache_creation_1h_tokens IS NULL)) AS unknown_tiers,
      COUNT(*) FILTER (WHERE provider = 'anthropic' AND cache_creation_tokens IS NOT NULL AND
        cache_creation_5m_tokens IS NOT NULL AND cache_creation_1h_tokens IS NOT NULL AND
        (cache_creation_5m_tokens < 0 OR cache_creation_1h_tokens < 0 OR
         cache_creation_5m_tokens + cache_creation_1h_tokens <> cache_creation_tokens)) AS tier_mismatches,
      COUNT(*) FILTER (WHERE usage_provenance->>'modelSource' = 'transcript' AND
        (model IS NULL OR model = 'unknown-openai')) AS model_provenance_mismatches,
      MAX(event_ts) AS newest_event
    FROM harness_shared.agent_usage_samples
    WHERE workspace_id = ${workspaceId} AND ts >= ${from} AND ts < ${to}
    GROUP BY 1 ORDER BY 1
  `;
}

export function evaluateUsageHealth(row: UsageHealthRow, now: number) {
  const unknown: string[] = [];
  const signals: string[] = [];
  const count = Number(row.samples);
  const coverage = count > 0 ? Number(row.timed_requests) / count : null;
  if (count < 20) unknown.push('insufficient-volume');
  if (coverage === null || coverage < 0.8) unknown.push('incomplete-request-time-coverage');
  const newest = row.newest_event === null ? null : Number(row.newest_event);
  if (newest === null || !Number.isFinite(newest) || newest > now || now - newest > 2 * 86_400_000) unknown.push('stale-or-unknown-telemetry');
  if (Number(row.unknown_model) > 0) unknown.push('unknown-model');
  if (Number(row.unknown_writes) > 0) unknown.push('unknown-cache-write-counts');
  if (Number(row.unknown_tiers) > 0) unknown.push('unknown-write-tiers');
  // Deterministic accounting contradictions are actionable even in a small cohort.
  if (Number(row.tier_mismatches) > 0) signals.push('write-tier-reconciliation-failed');
  if (Number(row.model_provenance_mismatches) > 0) signals.push('parser-model-provenance-inconsistent');
  return { state: signals.length ? 'regression' : unknown.length ? 'unknown' : 'ok', coverage, unknown, signals };
}

export function renderUsageHealth(rows: UsageHealthRow[], now: number): string {
  if (!rows.length) return '**Usage accounting health:** unknown — no observations.';
  return ['**Usage accounting health** (per provider/model/source; no aggregate hit-rate alarm):',
    ...rows.map(row => {
      const result = evaluateUsageHealth(row, now);
      return `- ${row.cohort}: ${result.state}; ${row.timed_requests}/${row.samples} timed requests; ` +
        `tier mismatches ${row.tier_mismatches}, parser/model mismatches ${row.model_provenance_mismatches}` +
        (result.unknown.length ? `; ${result.unknown.join(', ')}` : '');
    }),
  ].join('\n');
}

registerSystemAction('token-weekly-report', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const windowDays = Number.isFinite(Number(cfg.window_days)) && Number(cfg.window_days) > 0 ? Number(cfg.window_days) : 7;
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const { sql } = getOrgPg();
  const agg = (dim: 'source' | 'model_class' | 'role', from: number, to: number) =>
    readTokenReportAggregation(sql, ctx.workspaceId, dim, from, to);

  // P-016 presence/coord read-volume: calls + result-size from tool_invocations
  // (output_size = the serialized result length the dispatch records per call,
  // dispatch-stack.ts `r.outputSize ?? JSON.stringify(r.content).length`).
  const presenceVol = async (from: number, to: number): Promise<VolRow[]> => sql<VolRow[]>`
    SELECT tool_name AS tool, COUNT(*) AS calls,
           SUM(output_size) AS bytes, ROUND(AVG(output_size)) AS avg_bytes
      FROM harness_shared.tool_invocations
     WHERE workspace_id = ${ctx.workspaceId}
       AND invoked_at >= to_timestamp(${from}::double precision / 1000.0)
       AND invoked_at <  to_timestamp(${to}::double precision / 1000.0)
       AND tool_name = ANY(${PRESENCE_READ_TOOLS})
     GROUP BY 1
  `;

  const [curSrc, prevSrc, curModel, prevModel, curRole, prevRole, curVol, prevVol, usageHealth, carryHealth] = await Promise.all([
    agg('source', now - windowMs, now),
    agg('source', now - 2 * windowMs, now - windowMs),
    agg('model_class', now - windowMs, now),
    agg('model_class', now - 2 * windowMs, now - windowMs),
    agg('role', now - windowMs, now),
    agg('role', now - 2 * windowMs, now - windowMs),
    presenceVol(now - windowMs, now),
    presenceVol(now - 2 * windowMs, now - windowMs),
    readUsageHealth(sql, ctx.workspaceId, now - windowMs, now),
    readCarryHealth(sql, ctx.workspaceId, now - windowMs, now),
  ]);

  const tot = (rows: AggRow[]): { tok: number; usd: number } => ({
    tok: rows.reduce((a, r) => a + mtok(r.in_t) + mtok(r.out_t) + mtok(r.cr_t) + mtok(r.cw_t), 0),
    usd: rows.reduce((a, r) => a + (r.usd ?? 0), 0),
  });
  const cur = tot(curSrc);
  const prev = tot(prevSrc);
  const complete = [...curSrc, ...prevSrc].every(r => Number(r.incomplete_tokens) === 0);
  const wow = complete && prev.tok > 0 ? `${cur.tok >= prev.tok ? '+' : ''}${(((cur.tok - prev.tok) / prev.tok) * 100).toFixed(0)}%` : 'not comparable';

  const summary =
    `Token report (${windowDays}d): ${complete ? '' : '≥'}${fmtM(cur.tok)} MTok known (${wow} WoW), ${fmtUsd(cur.usd)} known attributed cost (not invoices). ` +
    `Top source: ${curSrc[0]?.dim ?? 'n/a'}.`;
  const byKey = (rows: AggRow[]): Map<string, AggRow> => new Map(rows.map((r) => [r.dim, r]));
  const body = [
    `Window: last ${windowDays}d vs the ${windowDays}d before. $ are attributed cost (provider-reported or list-price estimate; interactive sessions are subscription-billed — their $ quantifies rate-limit headroom, not invoices).`,
    renderDim('source', curSrc, byKey(prevSrc)),
    renderDim('model class', curModel, byKey(prevModel)),
    renderDim('role', curRole, byKey(prevRole)),
    renderPresenceVolume(curVol, prevVol),
    renderUsageHealth(usageHealth, now),
    renderCarryHealth(carryHealth),
    `Acceptance tracking (token-usage-reduction-audit-2026-06-09 P-013): target ≥40% weekly cache-read+write reduction vs the 2026-06-09 baseline (235 MTok read + 170 MTok write interactive; ~122 MTok fleet).`,
  ].join('\n\n');

  await sendMessage(TOKEN_REPORT_IDENTITY, { to: ['*'], summary, body }).catch(() => {});
  console.log(`[token-report] ${summary}`);
});
