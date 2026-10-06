/**
 * Subprocess usage-sample persistence (rate-limit-layer-v2 D-002, capture point 2;
 * backend-aware + run-attributed per cross-backend-cost-capture D-005).
 *
 * One row per finished governed subprocess run into `harness_shared.agent_usage_samples`
 * (migration 161 + 170): the token counts + $cost parsed from the run's JSONL terminal
 * events (`extractRunUsage` — claude `result`, codex `turn.completed`, omp `message_end`).
 * The subprocess path exposes NO provider rate-limit headers (the subscription CLI hides
 * them), so the `rl_*` columns stay NULL here — the in-process stateless-call capture point
 * (operator-core `agent-usage-telemetry.ts`) fills those where they exist.
 *
 * Cost honesty (D-005): provider-reported cost wins (`cost_source='provider'` — claude
 * `total_cost_usd`, omp `usage.cost.total`); a tokens-only run (codex) is priced from
 * `@papercusp/model-pricing` list prices (`cost_source='estimated'`); an unpriceable run
 * persists NULL cost — never a fabricated zero. `harness_slug`/`run_id`/`role` make the
 * samples table the per-harness spend source (PG-canonical runs write no files, so the
 * FS-mirror `agent_runs_consolidated` cannot serve spend — see plan D-004).
 *
 * Best-effort: telemetry must never fail a run.
 *
 * Provider + self-pacing come from this package's canonical `harnessProfile` adapter
 * contract. A cross-package conformance test pins those facts to
 * `@papercusp/papercusp-shared/agent`'s governor profile without inverting the package
 * dependency. Model-family bucketing remains a tiny pure helper at this boundary.
 */
import { PRICE_TABLE_VERSION, USAGE_LEDGER_PRICING, costFromTokens } from '@papercusp/model-pricing';
import type { OrchestratorPg } from './invoke';
import type { RunUsage } from './cost-cap';
import { harnessProfile } from './harness-profile';
import { AGENT_BACKENDS, type AgentBackend } from './types';

export interface UsageSamplePgContext {
  pg: OrchestratorPg;
  workspaceId: string;
}

function profileForBackend(backend: string) {
  return (AGENT_BACKENDS as readonly string[]).includes(backend)
    ? harnessProfile(backend as AgentBackend)
    : null;
}

/** Backend → provider, derived from the runtime adapter profile. */
export function providerForBackend(backend: string): string {
  return profileForBackend(backend)?.provider ?? 'unknown';
}

/** Model string → bucket class; the adapter decides whether the backend is self-pacing. */
export function modelClassForRun(backend: string, model: string): string {
  if (profileForBackend(backend)?.selfPacing) return 'self';
  const m = model.toLowerCase();
  if (/opus/.test(m)) return 'opus';
  if (/sonnet/.test(m)) return 'sonnet';
  if (/haiku/.test(m)) return 'haiku';
  return 'default';
}

export interface UsageSampleRun {
  /** Runtime backend label; unknown values remain safely attributed to `unknown`. */
  backend: string;
  /** The model the spawn requested (resolvedModel). `usage.model` is for pricing/display; inspect
   *  `usage.modelProvenance` before treating it as an actual execution model. */
  model: string;
  usage: RunUsage;
  harnessSlug?: string;
  runId?: string;
  role?: string;
  /** Native session id (claude `--session-id`/`--resume`). Lets a bee's
   *  successive warm-inject/resume samples be grouped by the session they
   *  share, so the carry-cost (cache_read growth across tasks) is queryable
   *  (bee-context-efficiency P-001). NULL for omp/codex (no forced native id). */
  sessionId?: string;
  /** Per-tool attribution (B-TOK-2, migration 330): the tool/feature that drove the
   *  call, when a clean source supplies it. NULL on the subprocess agent-run path
   *  (a full session has no single tool). */
  toolName?: string;
  /** Per-turn TRIGGER (B-TOK-4, migration 335): WHY this turn ran —
   *  'coord-wake' | 'cron' | 'autoloop' | 'user' — threaded from the spawn via
   *  `PAPERCUSP_TURN_TRIGGER`. Lets coordination-driven spend ("tokens consumed by
   *  coord-triggered turns") be summed directly. NULL where a path can't supply it. */
  turnTrigger?: string;
  /** Provider account that served the run, threaded from PAPERCUSP_ACCOUNT_ID by
   *  account-routed spawns. NULL for unpinned/pre-migration runs. */
  accountId?: string;
}

/** INSERT one usage sample. Caller passes the parsed `RunUsage`; no-ops on an empty one. */
export async function recordUsageSamplePg(
  ctx: UsageSamplePgContext,
  run: UsageSampleRun,
): Promise<void> {
  const { usage } = run;
  if (usage.inputTokens === undefined && usage.outputTokens === undefined && usage.costUsd === undefined) return;
  const provider = providerForBackend(run.backend);
  const model = usage.model ?? run.model;
  const modelClass = modelClassForRun(run.backend, model);
  const usageProvenance = {
    modelSource: usage.modelProvenance ?? 'request',
    requestedModel: usage.requestedModel ?? run.model,
    actualModels: usage.observedModels ?? [],
    backend: run.backend,
    // 'lower' when the estimate is a tier floor (D-020): a run aggregate has no request size, so a
    // long-context model prices at its standard tier. Written as null otherwise, never omitted.
    costBound: null as 'lower' | null,
  };
  const n = (v: number | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  // Provider-reported cost wins; else estimate from list prices; else NULL (never a fake 0).
  let costUsd: number | null = n(usage.costUsd);
  let costSource: string | null = costUsd !== null ? 'provider' : null;
  // Keep this call's usage shape — the four counters, absent ones priced as zero — in step with
  // operator-core `storedSampleTokenUsage` ('jsonl'): the repricer re-derives this row from its
  // stored columns whenever the price table changes (WI-10004517 / D-018).
  if (costUsd === null && model) {
    const est = costFromTokens(model, {
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens, cacheCreationTokens: usage.cacheCreationTokens,
    }, USAGE_LEDGER_PRICING);
    if (est.priced) {
      costUsd = est.usd;
      costSource = 'estimated';
      usageProvenance.costBound = est.bound ?? null;
    }
  }
  // Every row not carrying provider cost was derived under this table version; the repricer
  // treats any other stamp as stale. Provider cost is an observation, so it carries none.
  const priceTableVersion = costSource === 'provider' ? null : PRICE_TABLE_VERSION;

  await ctx.pg`
    INSERT INTO harness_shared.agent_usage_samples
      (workspace_id, ts, bucket_key, provider, model_class, source,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd,
       model, cost_source, price_table_version, harness_slug, run_id, role, turn_count, usage_provenance,
       session_id, goal_id, tool_name, turn_trigger, account_id)
    VALUES (
      ${ctx.workspaceId}, ${Date.now()}, ${`${provider}:${modelClass}`}, ${provider}, ${modelClass}, ${'jsonl'},
      ${n(usage.inputTokens)}, ${n(usage.outputTokens)}, ${n(usage.cacheReadTokens)}, ${n(usage.cacheCreationTokens)}, ${costUsd},
      ${model || null}, ${costSource}, ${priceTableVersion}, ${run.harnessSlug ?? null}, ${run.runId ?? null}, ${run.role ?? null}, ${n(usage.turns)},
      ${JSON.stringify(usageProvenance)}::jsonb,
      ${run.sessionId ?? null},
      (SELECT harness_shared.goal_id_for_usage_session(${ctx.workspaceId}, ${run.sessionId ?? null})),
      ${run.toolName ?? null}, ${run.turnTrigger ?? null}, ${run.accountId ?? null}
    )
  `;
}
