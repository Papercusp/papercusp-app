/**
 * `system:resolver-whole-corpus` — the routine-engine registration for the
 * P-007 whole-corpus resolver pass (silent-intake-central-resolution-2026-09-01).
 *
 * An infrequent, quality-first pass: read the FULL open corpus in one context
 * (whole-corpus-pass.ts), rule same-defect merges + same-cause clusters, and
 * apply the verdict through the real work-item store (whole-corpus-apply.ts).
 * D-002: quality over cost, one context — this is a single non-checkpointed
 * step (unlike the bulk-dedup ratchet, there is no multi-stage convergence to
 * resume) — a fresh `runId` is minted per fire.
 *
 * Ledger: reuses `harness_shared.admission_runs` (run_kind='resolver-whole-corpus',
 * migration 1091) exactly as census/daily-digest do, so the existing
 * `/admin` admission-runs views pick this run up for free.
 */
import { randomUUID } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { gatewayLlmEnv } from '../../inference-gateway/spawn-env';
import { optionalModelSpec } from '../../learning/model-policy';
import type { ScoutLlmCall } from '../../scout/types';
import { ALL_TERMINAL_STATUSES } from '../../work-item-blocking';
import {
  ADMISSION_EDGE_FLOOR,
  lexicalHardEdges,
  type AdmissionCensusEdge,
  type AdmissionCensusItem,
  readCorpus,
} from '../../work-items-admission-census';
import {
  commentWorkItem,
  getWorkItem,
  linkWorkItem,
  mergeWorkItemPayload,
  resolveWorkItemRef,
  setWorkItemState,
  type OrgSql,
} from '../../work-items';
import { createOneWorkItem } from '../../agent-tools/work_items/_create-core';
import { applyWholeCorpusVerdict, type ApplyWholeCorpusDeps } from '../../resolver/whole-corpus-apply';
import {
  planWholeCorpusShards,
  runWholeCorpusPass,
  wholeCorpusCandidateFromCensusItem,
} from '../../resolver/whole-corpus-pass';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export const RESOLVER_WHOLE_CORPUS_NAME = 'resolver-whole-corpus';
export const RESOLVER_WHOLE_CORPUS_ACTOR = 'system:resolver-whole-corpus';
const RESOLVER_WHOLE_CORPUS_SCHEMA_VERSION = 'resolver-whole-corpus-v1';

// ── Edge sourcing ────────────────────────────────────────────────────────────

interface DedupEdgeDbRow {
  a: string;
  b: string;
  cos: number;
  trgm: number | null;
}

/**
 * Mirrors `readCosineEdges` in work-items-admission-census.ts, simplified: no
 * adjudication tracking is needed here (the resolver pass never persists a
 * held/rejected verdict of its own — it merges or clusters directly).
 */
export async function readDedupEdges(
  sql: OrgSql,
  scope: { workspaceId: string; harnessSlug: string },
  ids: readonly string[],
): Promise<AdmissionCensusEdge[]> {
  if (ids.length === 0) return [];
  const rows = await sql<DedupEdgeDbRow[]>`
    SELECT a, b, cos, trgm
      FROM harness_shared.dedup_edges
     WHERE workspace_id = ${scope.workspaceId}
       AND harness_slug = ${scope.harnessSlug}
       AND cos >= ${ADMISSION_EDGE_FLOOR}
       AND a = ANY(${ids as string[]}::text[])
       AND b = ANY(${ids as string[]}::text[])`;
  return rows.map((row) => ({
    a: row.a,
    b: row.b,
    similarity: Number(row.cos),
    trgm: row.trgm == null ? null : Number(row.trgm),
    source: 'cosine' as const,
  }));
}

// ── Live apply deps (real work-item store) ─────────────────────────────────

interface ClusterParentRow {
  feature_id: string;
}

/** Wire {@link ApplyWholeCorpusDeps} to the real `work-items.ts` store. */
export function liveApplyDeps(workspaceId: string, harnessSlug: string): ApplyWholeCorpusDeps {
  return {
    getWorkItem: async (id) => {
      const wi = await getWorkItem(id, harnessSlug);
      if (!wi) return null;
      const payload = wi.payload && typeof wi.payload === 'object' && !Array.isArray(wi.payload)
        ? wi.payload as Record<string, unknown>
        : null;
      return { id: wi.id, state: wi.state, payload };
    },
    resolveWorkItemRef: (id) => resolveWorkItemRef(id, harnessSlug),
    linkWorkItem: async (id, dst, rel) => {
      const result = await linkWorkItem(id, dst, rel, { harness: harnessSlug, by: RESOLVER_WHOLE_CORPUS_ACTOR });
      return 'error' in result ? { ok: false, error: result.error } : { ok: true };
    },
    setState: async (id, state, opts) => {
      try {
        const wi = await setWorkItemState(id, state, {
          harness: harnessSlug,
          by: RESOLVER_WHOLE_CORPUS_ACTOR,
          completionRef: opts.completionRef,
        });
        return wi ? { ok: true } : { ok: false, error: `work-item '${id}' not found` };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    comment: async (id, body) => {
      await commentWorkItem(id, body, RESOLVER_WHOLE_CORPUS_ACTOR, { harness: harnessSlug });
    },
    findExistingClusterParentByKey: async (clusterKey) => {
      const { sql } = getOrgPg();
      const rows = await sql<ClusterParentRow[]>`
        SELECT feature_id
          FROM harness_shared.work_items
         WHERE workspace_id = ${workspaceId}
           AND harness_slug = ${harnessSlug}
           AND payload->'resolverCluster' IS NOT NULL
           AND payload#>>'{resolverCluster,clusterKey}' = ${clusterKey}
           AND NOT (status = ANY(${[...ALL_TERMINAL_STATUSES] as string[]}::text[]))
         LIMIT 1`;
      return rows[0]?.feature_id ?? null;
    },
    createClusterParent: async (input) => {
      const result = await createOneWorkItem(
        {
          kind: 'feature',
          title: input.title,
          summary: input.summary,
          harness: harnessSlug,
          workspace: workspaceId,
          // Nested under a durable marker key so the idempotency lookup above
          // (and P-008's later consumer) can find it without a schema change.
          payload: { resolverCluster: input.payload as unknown as Record<string, unknown> },
          force: true, // system-created infra marker — skip the ordinary dedup gates.
        },
        { ownerId: RESOLVER_WHOLE_CORPUS_ACTOR, workspaceId, harnessSlug },
      );
      if (result.ok) return { ok: true, id: result.workItem.id };
      return { ok: false, error: result.message ?? result.error };
    },
    mergePayload: async (id, patch) => {
      try {
        const updated = await mergeWorkItemPayload(id, patch, { harness: harnessSlug });
        return updated ? { ok: true } : { ok: false, error: `work-item '${id}' not found` };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

// ── Pass runner ──────────────────────────────────────────────────────────────

export interface RunResolverWholeCorpusPassOptions {
  workspaceId: string;
  harnessSlug: string;
  runId?: string;
  llmCall: ScoutLlmCall;
  model?: string;
  targetTokens?: number;
  sql?: OrgSql;
  now?: () => number;
  /** Override the real store wiring — unit tests only. */
  applyDeps?: ApplyWholeCorpusDeps;
}

export interface RunResolverWholeCorpusPassResult {
  runId: string;
  corpusSize: number;
  shardCount: number;
  merges: number;
  clusters: number;
  droppedUnknownRefs: number;
  errors: string[];
}

export async function runResolverWholeCorpusPass(
  opts: RunResolverWholeCorpusPassOptions,
): Promise<RunResolverWholeCorpusPassResult> {
  const sql = opts.sql ?? getOrgPg().sql;
  const now = opts.now ?? Date.now;
  const startedMs = now();
  const startedAt = new Date(startedMs).toISOString();
  const runId = opts.runId ?? `${RESOLVER_WHOLE_CORPUS_NAME}-${startedMs}-${randomUUID().slice(0, 8)}`;

  await sql`
    INSERT INTO harness_shared.admission_runs
      (id, workspace_id, harness_slug, run_kind, started_at, detail)
    VALUES (${runId}, ${opts.workspaceId}, ${opts.harnessSlug}, ${RESOLVER_WHOLE_CORPUS_NAME}, ${startedAt}::timestamptz,
            ${JSON.stringify({ schemaVersion: RESOLVER_WHOLE_CORPUS_SCHEMA_VERSION, status: 'running' })}::text::jsonb)
    ON CONFLICT (id) DO UPDATE SET
      workspace_id = EXCLUDED.workspace_id,
      harness_slug = EXCLUDED.harness_slug,
      run_kind = EXCLUDED.run_kind,
      started_at = EXCLUDED.started_at,
      finished_at = NULL,
      detail = EXCLUDED.detail`;

  try {
    const census = await readCorpus(sql, { workspaceId: opts.workspaceId, harnessSlug: opts.harnessSlug });
    const ids = census.map((item) => item.id);
    const dedupEdges = await readDedupEdges(sql, opts, ids);
    const lexical = lexicalHardEdges(census);
    const allEdges: AdmissionCensusEdge[] = [...dedupEdges, ...lexical];
    const plan = planWholeCorpusShards(census, allEdges, opts.targetTokens ? { targetTokens: opts.targetTokens } : {});

    const itemsById = new Map(census.map((item) => [item.id, item]));
    const deps = opts.applyDeps ?? liveApplyDeps(opts.workspaceId, opts.harnessSlug);
    const toCandidates = (memberIds: readonly string[]) =>
      memberIds
        .map((id) => itemsById.get(id))
        .filter((item): item is AdmissionCensusItem => Boolean(item))
        .map(wholeCorpusCandidateFromCensusItem);

    let merges = 0;
    let clusters = 0;
    let droppedUnknownRefs = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let costUsd = 0;
    let modelId: string | null = null;
    const errors: string[] = [];

    for (const shard of plan.shards) {
      const items = toCandidates(shard.members);
      if (items.length === 0) continue;
      const ghostItems = toCandidates(shard.ghosts);
      const passResult = await runWholeCorpusPass({
        items,
        ghostItems,
        llmCall: opts.llmCall,
        config: opts.model ? { model: opts.model } : undefined,
      });
      tokensIn += passResult.usage.inputTokens;
      tokensOut += passResult.usage.outputTokens;
      costUsd += passResult.usage.costUsd;
      modelId = passResult.usage.model;
      if (passResult.verdict === 'malformed') {
        errors.push(`shard ${shard.shardId}: ${passResult.error}`);
        continue;
      }
      droppedUnknownRefs += passResult.outcome.droppedUnknownRefs;
      const applied = await applyWholeCorpusVerdict(passResult.outcome.verdict, deps);
      merges += applied.merged.length;
      clusters += applied.clustersCreated.length;
      errors.push(...applied.errors);
    }

    const result: RunResolverWholeCorpusPassResult = {
      runId,
      corpusSize: census.length,
      shardCount: plan.shards.length,
      merges,
      clusters,
      droppedUnknownRefs,
      errors,
    };

    await sql`
      UPDATE harness_shared.admission_runs
         SET finished_at = clock_timestamp(), batch_size = ${census.length}, merged = ${merges},
             model_id = ${modelId}, tokens_in = ${tokensIn}, tokens_out = ${tokensOut},
             latency_ms = ${Math.max(0, now() - startedMs)},
             detail = ${JSON.stringify({
               schemaVersion: RESOLVER_WHOLE_CORPUS_SCHEMA_VERSION,
               status: 'complete',
               corpusSize: census.length,
               shards: plan.shards.length,
               merges,
               clusters,
               droppedUnknownRefs,
               usage: { costUsd, tokensIn, tokensOut, model: modelId },
               errors,
             })}::text::jsonb
       WHERE id = ${runId}`;

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql`
      UPDATE harness_shared.admission_runs
         SET finished_at = clock_timestamp(), latency_ms = ${Math.max(0, now() - startedMs)},
             detail = COALESCE(detail, '{}'::jsonb) ||
                      ${JSON.stringify({ schemaVersion: RESOLVER_WHOLE_CORPUS_SCHEMA_VERSION, status: 'failed', error: message })}::text::jsonb
       WHERE id = ${runId}`.catch(() => undefined);
    throw error;
  }
}

// ── Routine-engine registration ─────────────────────────────────────────────

export interface ResolverWholeCorpusActionDeps {
  run: (ctx: SystemActionCtx) => Promise<RunResolverWholeCorpusPassResult>;
  log: (message: string) => void;
}

async function productionRun(ctx: SystemActionCtx): Promise<RunResolverWholeCorpusPassResult> {
  if (process.env.VITEST) throw new Error('production resolver whole-corpus action must not run from a unit test');
  const payload = ctx.payloadTemplate ?? {};
  if (await getFlag(FLAGS.INFERENCE_GATEWAY, 'system')) {
    for (const [key, value] of Object.entries(gatewayLlmEnv(true))) {
      if (!process.env[key]) process.env[key] = value;
    }
  }
  const { llmCall } = await import('../../llm-testing/llm-client');
  return runResolverWholeCorpusPass({
    workspaceId: ctx.workspaceId,
    harnessSlug: ctx.installSlug,
    model: optionalModelSpec(payload.model, 'resolver whole corpus'),
    targetTokens: typeof payload.targetTokens === 'number' ? payload.targetTokens : undefined,
    llmCall: (input) => llmCall({ ...input, priority: 'scout', harnessSlug: ctx.installSlug }),
  });
}

export function makeResolverWholeCorpusAction(overrides: Partial<ResolverWholeCorpusActionDeps> = {}) {
  const deps: ResolverWholeCorpusActionDeps = {
    run: productionRun,
    log: (message) => console.log(`[${RESOLVER_WHOLE_CORPUS_NAME}] ${message}`),
    ...overrides,
  };
  return async (ctx: SystemActionCtx): Promise<void> => {
    const result = await deps.run(ctx);
    deps.log(
      `${ctx.installSlug}: run=${result.runId} corpus=${result.corpusSize} shards=${result.shardCount} ` +
        `merges=${result.merges} clusters=${result.clusters} errors=${result.errors.length}`,
    );
  };
}

// Scheduling defaults to 'standing' (see SystemActionOptions.scheduling): a
// `seed-resolver-whole-corpus-routine.ts` row is expected to exist, mirroring
// work-item-admission-daily-digest-action.ts (also a single-shot, non-ownSteps
// admission pass with its own seed). Unlike bulk-dedup this pass never
// ratchets multi-stage convergence, so ownSteps is correctly omitted (default
// false) — one call is the whole run.
registerSystemAction(RESOLVER_WHOLE_CORPUS_NAME, makeResolverWholeCorpusAction());
