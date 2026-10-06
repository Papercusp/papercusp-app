/**
 * Work-item admission census + shard planner.
 *
 * This is the deterministic P-001 runtime for
 * `work-queue-admission-and-bulk-dedup-2026-08-24`.  It extends the existing
 * work-item admission substrate instead of inventing a parallel queue:
 *
 * - the corpus is every non-terminal, non-observation work item in one
 *   workspace/harness;
 * - cosine edges >= 0.85 are recomputed into migration 944's `dedup_edges`;
 * - >= 0.90 edges form hard components, while cross-shard edges become capped
 *   read-only ghost context (D-006);
 * - the census counts only >= 0.90 pairs with NO adjudication (D-001);
 * - corpus-wide LEXICAL identity (exact persisted titleKey, exact normalized
 *   title, shared condition_key) forms in-memory hard edges regardless of
 *   embedding state, so the dedup pipeline never goes blind when embeddings
 *   lag or land with divergent summaries (WI-2140406);
 * - every run writes the owner-inspectable `admission_runs` ledger and an exact
 *   member-coverage assertion before any later model call can consume a shard.
 *
 * `buildAdmissionShardPlan` is pure and deliberately exported.  The live runner
 * and the real-PG guard exercise the same planner, so deterministic packing and
 * coverage are not claims inferred from a query shape.
 */
import { createHash, randomUUID } from 'node:crypto';
import { clusterPairs, type OverlapPair } from '@papercusp/overlap-clusters';
import { getOrgPg } from '@papercusp/db-org';
import { acquireWithContentionRetry } from './agent-tools/locks/contention-retry';
import { admissionIdentity } from './harness/improvements/digest';
import { ALL_TERMINAL_STATUSES } from './work-item-blocking';
import type { AdmissionRunOutcome } from './work-items-admission-promoter';
import type { OrgSql } from './work-items';
import {
  proseProfilePredicateSql,
  resolveAcceptedProseProfileSelection,
  resolveCurrentProseProfileSelection,
  resolveProseProfileIdSelection,
  type ProseProfileSelection,
} from './search/prose-vector-dims';

export const ADMISSION_EDGE_FLOOR = 0.85;
export const ADMISSION_COMPONENT_FLOOR = 0.9;
export const DEFAULT_SHARD_TARGET_TOKENS = 300_000;
export const DEFAULT_SHARD_CEILING_TOKENS = 1_000_000;
export const DEFAULT_GHOST_FRACTION = 0.15;
export const DEFAULT_EDGE_SCAN_CHUNKS = 16;
export const TEXT_CONTEXT_TRGM_FLOOR = 0.45;
export const TEXT_CONTEXT_NEIGHBOURS = 20;
/**
 * Bound the missing-embedding side of the text-context similarity scan.
 *
 * The corpus CTE is reused for each batch, but the lateral scorer only needs
 * this many anchors at a time. Keeping the batch finite prevents a large
 * text-only tail from producing one giant result/parse allocation while still
 * evaluating every missing row deterministically.
 */
export const TEXT_CONTEXT_BATCH_SIZE = 128;

/** Partition text-only anchors into deterministic, bounded query batches. */
export function partitionTextContextIds(ids: readonly string[], batchSize = TEXT_CONTEXT_BATCH_SIZE): string[][] {
  const size = Number.isFinite(batchSize) ? Math.max(1, Math.floor(batchSize)) : TEXT_CONTEXT_BATCH_SIZE;
  const batches: string[][] = [];
  for (let offset = 0; offset < ids.length; offset += size) {
    batches.push([...ids.slice(offset, offset + size)]);
  }
  return batches;
}

export type AdmissionOriginClass = 'machine-emitter' | 'ideation' | 'agent-filed';

export interface AdmissionCensusItem {
  id: string;
  title: string;
  summary: string;
  estimatedTokens: number;
  originClass: AdmissionOriginClass;
  hasEmbedding: boolean;
  embeddingMode: string | null;
  /** Effective exact profile id; null means the physical vector cannot be
   * compared safely and the census must fail closed. */
  embeddingProfile: string | null;
  /** Persisted file-time identity (`payload.admissionIdentity.titleKey`), when present. */
  titleKey: string | null;
  /** Machine-emitter recurring-condition identity. */
  conditionKey: string | null;
}

export interface AdmissionCensusEdge {
  a: string;
  b: string;
  similarity: number;
  trgm?: number | null;
  source: 'cosine' | 'text' | 'lexical';
  /** Exact text identity is a hard component edge even without an embedding. */
  hard?: boolean;
}

export interface AdmissionShard {
  shardId: number;
  members: string[];
  ghosts: string[];
  memberTokens: number;
  ghostTokens: number;
}

export interface AdmissionMergeProjection {
  byPairClass: Record<string, number>;
  componentCollapseUpperBound: Record<string, number>;
  outsideMachineEmitterPairs: number;
  recommendedBulkScope: 'full-corpus' | 'machine-emitter-targeted';
  basis: string;
}

export interface AdmissionShardPlan {
  shards: AdmissionShard[];
  corpusSize: number;
  memberRows: number;
  ghostRows: number;
  ghostCandidatesDropped: number;
  splitOversizedComponents: number;
  fingerprint: string;
  projection: AdmissionMergeProjection;
}

export interface AdmissionShardConfig {
  targetTokens?: number;
  ceilingTokens?: number;
  ghostFraction?: number;
  fullCorpusPairThreshold?: number;
}

interface MutableShard {
  shardId: number;
  members: Set<string>;
  ghosts: Set<string>;
  memberTokens: number;
  ghostTokens: number;
}

function canonicalEdge(edge: AdmissionCensusEdge): AdmissionCensusEdge {
  return edge.a < edge.b ? edge : { ...edge, a: edge.b, b: edge.a };
}

function stableEdges(edges: readonly AdmissionCensusEdge[]): AdmissionCensusEdge[] {
  const byPair = new Map<string, AdmissionCensusEdge>();
  for (const raw of edges) {
    if (!raw.a || !raw.b || raw.a === raw.b || !Number.isFinite(raw.similarity)) continue;
    const edge = canonicalEdge(raw);
    const key = `${edge.a}\0${edge.b}`;
    const prior = byPair.get(key);
    if (!prior || edge.similarity > prior.similarity || (edge.hard === true && prior.hard !== true)) {
      byPair.set(key, edge);
    }
  }
  return [...byPair.values()].sort((a, b) => a.a.localeCompare(b.a) || a.b.localeCompare(b.b));
}

/**
 * Identity groups larger than this emit a connectivity star (first member to
 * each other member) instead of a full pairwise clique. Components and shard
 * cohesion are unchanged — clustering only needs connectivity — while a
 * pathological identity group (a recurring detector condition with hundreds of
 * open rows) stays O(n) edges instead of O(n²).
 */
export const LEXICAL_PAIR_GROUP_CAP = 200;

/** Minimal identity shape, shared with the bulk pair generator. */
export interface LexicalIdentityItem {
  id: string;
  title: string;
  titleKey?: string | null;
  conditionKey?: string | null;
}

/**
 * Corpus-wide LEXICAL hard edges — exact persisted titleKey, exact normalized
 * title (via {@link admissionIdentity}), or shared machine-emitter
 * condition_key — computed in memory over EVERY corpus item regardless of
 * embedding state. No table is touched; `dedup_edges` stays cosine-only.
 *
 * WI-2140406 (EI-22068819110487948): with cosine as the only corpus-wide
 * candidate generator the pipeline goes blind exactly when filing volume
 * spikes (embeddings lag), and the text leg anchors only on missing-embedding
 * rows — so an identical-title pair that was embedded but landed cos < 0.85
 * (divergent summaries) had NO edge from any leg. Measured 2026-09-01: 1,826
 * open identical-title pairs, zero edges. Identity is a first-class edge
 * source here, not a fallback.
 */
export function lexicalHardEdges(items: readonly LexicalIdentityItem[]): AdmissionCensusEdge[] {
  const buckets = new Map<string, string[]>();
  const add = (bucket: 'key' | 'title' | 'cond', key: string | null | undefined, id: string): void => {
    const trimmed = key?.trim();
    // `admissionIdentity('')` degenerates to the bare 'title:' prefix; a blank
    // identity must never glue unrelated items together.
    if (!trimmed || trimmed === 'title:') return;
    const bucketKey = `${bucket}\0${trimmed}`;
    buckets.set(bucketKey, [...(buckets.get(bucketKey) ?? []), id]);
  };
  for (const item of items) {
    add('key', item.titleKey, item.id);
    if (item.title.trim()) add('title', admissionIdentity(item.title).titleKey, item.id);
    add('cond', item.conditionKey, item.id);
  }

  const lexical = (a: string, b: string): AdmissionCensusEdge => ({
    a,
    b,
    similarity: 1,
    trgm: null,
    source: 'lexical',
    hard: true,
  });
  const edges: AdmissionCensusEdge[] = [];
  for (const ids of buckets.values()) {
    const unique = [...new Set(ids)].sort();
    if (unique.length < 2) continue;
    if (unique.length > LEXICAL_PAIR_GROUP_CAP) {
      for (let i = 1; i < unique.length; i += 1) edges.push(lexical(unique[0]!, unique[i]!));
    } else {
      for (let i = 0; i < unique.length; i += 1) {
        for (let j = i + 1; j < unique.length; j += 1) edges.push(lexical(unique[i]!, unique[j]!));
      }
    }
  }
  return stableEdges(edges);
}

function overlapPairs(edges: readonly AdmissionCensusEdge[], ids: ReadonlySet<string>, floor: number): OverlapPair[] {
  return edges
    .filter((edge) => ids.has(edge.a) && ids.has(edge.b) && (edge.hard === true || edge.similarity >= floor))
    .map((edge) => ({
      a: edge.a,
      b: edge.b,
      groupA: edge.a,
      groupB: edge.b,
      similarity: edge.similarity,
    }));
}

function componentsFor(ids: readonly string[], edges: readonly AdmissionCensusEdge[], floor: number): string[][] {
  const idSet = new Set(ids);
  const clustered = clusterPairs(overlapPairs(edges, idSet, floor)).map((cluster) => [...cluster.ids].sort());
  const seen = new Set(clustered.flat());
  for (const id of [...ids].sort()) if (!seen.has(id)) clustered.push([id]);
  return clustered.sort((a, b) => a[0]!.localeCompare(b[0]!));
}

function sumTokens(ids: readonly string[], items: ReadonlyMap<string, AdmissionCensusItem>): number {
  return ids.reduce((sum, id) => sum + items.get(id)!.estimatedTokens, 0);
}

function splitOversized(
  component: readonly string[],
  edges: readonly AdmissionCensusEdge[],
  items: ReadonlyMap<string, AdmissionCensusItem>,
  targetTokens: number,
): { parts: string[][]; split: boolean } {
  if (sumTokens(component, items) <= targetTokens) return { parts: [[...component].sort()], split: false };

  // D-006's escape hatch: raise the hard threshold inside only the giant
  // component.  Severed edges remain available to the ghost pass below.
  for (const floor of [0.92, 0.94, 0.96, 0.98, 1]) {
    const parts = componentsFor(
      component,
      edges.filter((edge) => edge.hard !== true),
      floor,
    );
    if (parts.length > 1 && parts.every((part) => sumTokens(part, items) <= targetTokens)) {
      return { parts, split: true };
    }
  }

  // Exact-identity or identical-vector groups can remain connected at 1.0.  A
  // deterministic token-bounded split is the final escape hatch; every severed
  // edge still competes for ghost context, and the report records the split.
  const sorted = [...component].sort(
    (a, b) => items.get(b)!.estimatedTokens - items.get(a)!.estimatedTokens || a.localeCompare(b),
  );
  const parts: string[][] = [];
  const loads: number[] = [];
  for (const id of sorted) {
    const tokens = items.get(id)!.estimatedTokens;
    let slot = loads.findIndex((load) => load + tokens <= targetTokens);
    if (slot < 0) {
      slot = parts.length;
      parts.push([]);
      loads.push(0);
    }
    parts[slot]!.push(id);
    loads[slot] = loads[slot]! + tokens;
  }
  return { parts: parts.map((part) => part.sort()), split: true };
}

function projectionFor(
  items: ReadonlyMap<string, AdmissionCensusItem>,
  unadjudicated: readonly AdmissionCensusEdge[],
  fullCorpusPairThreshold: number,
): AdmissionMergeProjection {
  const byPairClass: Record<string, number> = {};
  let outsideMachineEmitterPairs = 0;
  for (const edge of unadjudicated) {
    const ca = items.get(edge.a)?.originClass ?? 'agent-filed';
    const cb = items.get(edge.b)?.originClass ?? 'agent-filed';
    const key = [ca, cb].sort().join(' × ');
    byPairClass[key] = (byPairClass[key] ?? 0) + 1;
    if (ca !== 'machine-emitter' || cb !== 'machine-emitter') outsideMachineEmitterPairs += 1;
  }

  const componentCollapseUpperBound: Record<string, number> = {};
  const ids = new Set([...unadjudicated.flatMap((edge) => [edge.a, edge.b])]);
  for (const component of componentsFor([...ids], unadjudicated, ADMISSION_COMPONENT_FLOOR).filter(
    (c) => c.length > 1,
  )) {
    const classes = [...new Set(component.map((id) => items.get(id)?.originClass ?? 'agent-filed'))].sort();
    const key = classes.length === 1 ? classes[0]! : `mixed:${classes.join('+')}`;
    componentCollapseUpperBound[key] = (componentCollapseUpperBound[key] ?? 0) + component.length - 1;
  }

  return {
    byPairClass,
    componentCollapseUpperBound,
    outsideMachineEmitterPairs,
    recommendedBulkScope:
      outsideMachineEmitterPairs > fullCorpusPairThreshold ? 'full-corpus' : 'machine-emitter-targeted',
    basis:
      'Unadjudicated >=0.90 pair counts plus connected-component collapse upper bounds; no model verdict is assumed. D-002 uses >150 outside-machine pairs as the working full-corpus threshold.',
  };
}

export function buildAdmissionShardPlan(
  rawItems: readonly AdmissionCensusItem[],
  rawEdges: readonly AdmissionCensusEdge[],
  unadjudicatedEdges: readonly AdmissionCensusEdge[] = rawEdges,
  config: AdmissionShardConfig = {},
): AdmissionShardPlan {
  const targetTokens = Math.max(1, Math.floor(config.targetTokens ?? DEFAULT_SHARD_TARGET_TOKENS));
  const ceilingTokens = Math.max(targetTokens, Math.floor(config.ceilingTokens ?? DEFAULT_SHARD_CEILING_TOKENS));
  const ghostFraction = config.ghostFraction ?? DEFAULT_GHOST_FRACTION;
  if (!(ghostFraction >= 0 && ghostFraction <= 1)) throw new Error('ghostFraction must be in [0,1]');

  const items = new Map<string, AdmissionCensusItem>();
  for (const item of rawItems) {
    if (!item.id) throw new Error('census item id is blank');
    if (items.has(item.id)) throw new Error(`duplicate census item id: ${item.id}`);
    if (!Number.isFinite(item.estimatedTokens) || item.estimatedTokens < 1) {
      throw new Error(`invalid token estimate for ${item.id}`);
    }
    if (item.estimatedTokens > ceilingTokens) {
      throw new Error(`item ${item.id} exceeds the ${ceilingTokens}-token shard ceiling`);
    }
    items.set(item.id, item);
  }

  const edges = stableEdges(rawEdges).filter((edge) => items.has(edge.a) && items.has(edge.b));
  const hardEdges = edges.filter((edge) => edge.hard === true || edge.similarity >= ADMISSION_COMPONENT_FLOOR);
  const baseComponents = componentsFor([...items.keys()], hardEdges, ADMISSION_COMPONENT_FLOOR);
  const components: string[][] = [];
  let splitOversizedComponents = 0;
  for (const component of baseComponents) {
    const split = splitOversized(component, hardEdges, items, targetTokens);
    components.push(...split.parts);
    if (split.split) splitOversizedComponents += 1;
  }
  components.sort((a, b) => sumTokens(b, items) - sumTokens(a, items) || a[0]!.localeCompare(b[0]!));

  const adjacency = new Map<string, Array<{ other: string; similarity: number }>>();
  for (const edge of edges) {
    adjacency.set(edge.a, [...(adjacency.get(edge.a) ?? []), { other: edge.b, similarity: edge.similarity }]);
    adjacency.set(edge.b, [...(adjacency.get(edge.b) ?? []), { other: edge.a, similarity: edge.similarity }]);
  }

  const shards: MutableShard[] = [];
  const home = new Map<string, number>();
  for (const component of components) {
    const tokens = sumTokens(component, items);
    const scores = new Map<number, number>();
    for (const id of component) {
      for (const edge of adjacency.get(id) ?? []) {
        const shardId = home.get(edge.other);
        if (shardId !== undefined) scores.set(shardId, (scores.get(shardId) ?? 0) + edge.similarity);
      }
    }
    const candidates = shards
      .filter((shard) => shard.memberTokens + tokens <= targetTokens)
      .sort(
        (a, b) =>
          (scores.get(b.shardId) ?? 0) - (scores.get(a.shardId) ?? 0) ||
          a.memberTokens - b.memberTokens ||
          a.shardId - b.shardId,
      );
    const shard =
      candidates[0] ??
      (() => {
        const next: MutableShard = {
          shardId: shards.length,
          members: new Set<string>(),
          ghosts: new Set<string>(),
          memberTokens: 0,
          ghostTokens: 0,
        };
        shards.push(next);
        return next;
      })();
    for (const id of component) {
      shard.members.add(id);
      shard.memberTokens += items.get(id)!.estimatedTokens;
      home.set(id, shard.shardId);
    }
  }

  const ghostCandidates = new Map<number, Map<string, { similarity: number; tokens: number }>>();
  for (const edge of edges) {
    const homeA = home.get(edge.a)!;
    const homeB = home.get(edge.b)!;
    if (homeA === homeB) continue;
    const itemA = items.get(edge.a)!;
    const itemB = items.get(edge.b)!;
    const ghostId =
      itemA.estimatedTokens < itemB.estimatedTokens ||
      (itemA.estimatedTokens === itemB.estimatedTokens && edge.a.localeCompare(edge.b) < 0)
        ? edge.a
        : edge.b;
    const destination = ghostId === edge.a ? homeB : homeA;
    const byItem = ghostCandidates.get(destination) ?? new Map<string, { similarity: number; tokens: number }>();
    const prior = byItem.get(ghostId);
    if (!prior || edge.similarity > prior.similarity) {
      byItem.set(ghostId, { similarity: edge.similarity, tokens: items.get(ghostId)!.estimatedTokens });
    }
    ghostCandidates.set(destination, byItem);
  }

  const ghostBudget = Math.floor(targetTokens * ghostFraction);
  let ghostCandidatesDropped = 0;
  for (const shard of shards) {
    const candidates = [...(ghostCandidates.get(shard.shardId)?.entries() ?? [])].sort(
      (a, b) => b[1].similarity - a[1].similarity || a[1].tokens - b[1].tokens || a[0].localeCompare(b[0]),
    );
    for (const [id, candidate] of candidates) {
      if (shard.members.has(id) || shard.ghosts.has(id)) continue;
      if (shard.ghostTokens + candidate.tokens > ghostBudget) {
        ghostCandidatesDropped += 1;
        continue;
      }
      shard.ghosts.add(id);
      shard.ghostTokens += candidate.tokens;
    }
  }

  const memberIds = shards.flatMap((shard) => [...shard.members]);
  if (memberIds.length !== rawItems.length || new Set(memberIds).size !== rawItems.length) {
    throw new Error(
      `member coverage mismatch: rows=${memberIds.length}, unique=${new Set(memberIds).size}, corpus=${rawItems.length}`,
    );
  }

  const output = shards.map((shard) => ({
    shardId: shard.shardId,
    members: [...shard.members].sort(),
    ghosts: [...shard.ghosts].sort(),
    memberTokens: shard.memberTokens,
    ghostTokens: shard.ghostTokens,
  }));
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(output.map((shard) => ({ id: shard.shardId, m: shard.members, g: shard.ghosts }))))
    .digest('hex');

  return {
    shards: output,
    corpusSize: rawItems.length,
    memberRows: memberIds.length,
    ghostRows: output.reduce((sum, shard) => sum + shard.ghosts.length, 0),
    ghostCandidatesDropped,
    splitOversizedComponents,
    fingerprint,
    projection: projectionFor(
      items,
      stableEdges(unadjudicatedEdges).filter((edge) => items.has(edge.a) && items.has(edge.b)),
      config.fullCorpusPairThreshold ?? 150,
    ),
  };
}

interface CorpusDbRow {
  id: string;
  title: string;
  summary: string;
  has_embedding: boolean;
  embedding_mode: string | null;
  embedding_profile: string | null;
  condition_key: string | null;
  title_key: string | null;
  idea_origin: string | null;
}

interface EdgeDbRow {
  a: string;
  b: string;
  cos: number;
  trgm: number | null;
  adjudicated?: boolean;
}

interface TextEdgeDbRow {
  missing_id: string;
  other_id: string;
  trgm: number;
  exact_key: boolean;
}

export interface AdmissionCensusRunOptions extends AdmissionShardConfig {
  workspaceId: string;
  harnessSlug: string;
  chunkCount?: number;
  runId?: string;
  sql?: OrgSql;
  now?: () => number;
  /** Caller already owns a transaction (bulk-stage ratchet); avoid opening a nested one. */
  withinTransaction?: boolean;
  /**
   * WI-10004951: waits (ms) before retrying a census statement that PG refused with
   * 55P03 lock_not_available. Default ADMISSION_CENSUS_LOCK_RETRY_BACKOFFS_MS; `[]`
   * restores the old fail-on-first-refusal behaviour. Ignored when `withinTransaction`:
   * a refused statement has already aborted the caller's transaction, so only the
   * caller can retry.
   */
  lockRetryBackoffsMs?: readonly number[];
  /** Injectable sleep for the lock-retry ladder (tests). */
  sleep?: (ms: number) => Promise<void>;
}

export interface AdmissionCensusRunResult extends AdmissionShardPlan {
  runId: string;
  embeddingMode: string | null;
  embeddedItems: number;
  missingEmbeddingItems: number;
  cosineEdges: number;
  hardEdges: number;
  textContextEdges: number;
  /** In-memory identity edges (exact titleKey / title / condition_key), corpus-wide. */
  lexicalEdges: number;
  /** Lexical edges with no adjudication — the projection's lexical companion count. */
  lexicalUnadjudicated: number;
  censusBefore: number;
  censusAfter: number;
  chunkCoverage: number[];
  latencyMs: number;
}

function classifyOrigin(row: CorpusDbRow): AdmissionOriginClass {
  if (row.condition_key) return 'machine-emitter';
  if (row.idea_origin) return 'ideation';
  return 'agent-filed';
}

function corpusWhere(sql: OrgSql, opts: Pick<AdmissionCensusRunOptions, 'workspaceId' | 'harnessSlug'>, alias: string) {
  const terminal = [...ALL_TERMINAL_STATUSES];
  const a = sql.unsafe(alias);
  return sql`${a}.workspace_id = ${opts.workspaceId}
    AND ${a}.harness_slug = ${opts.harnessSlug}
    AND ${a}.lane IS DISTINCT FROM 'observation'
    AND (${a}.status IS NULL OR NOT (${a}.status = ANY(${terminal}::text[])))`;
}

/**
 * The corpus definition ("every open lane bug") — every non-terminal,
 * non-observation work item in one workspace/harness. Exported for the P-007
 * whole-corpus resolver pass, which reuses this exact definition rather than
 * re-deriving its own `corpusWhere` (reuse-first mandate).
 */
export async function readCorpus(sql: OrgSql, opts: AdmissionCensusRunOptions): Promise<AdmissionCensusItem[]> {
  const rows = await sql<CorpusDbRow[]>`
    SELECT wi.feature_id AS id,
           COALESCE(wi.title, '') AS title,
           COALESCE(wi.summary, '') AS summary,
           (wi.embedding IS NOT NULL) AS has_embedding,
           wi.embedding_mode,
           wi.embedding_profile,
           wi.condition_key,
           wi.payload #>> '{admissionIdentity,titleKey}' AS title_key,
           idea.origin AS idea_origin
      FROM harness_shared.work_items wi
      LEFT JOIN LATERAL (
        SELECT sri.origin
          FROM harness_shared.scout_routed_ideas sri
         WHERE sri.workspace_id = wi.workspace_id
           AND sri.harness_slug = wi.harness_slug
           AND sri.routed_ref = wi.feature_id
         ORDER BY sri.routed_at DESC
         LIMIT 1
      ) idea ON TRUE
     WHERE ${corpusWhere(sql, opts, 'wi')}
     ORDER BY wi.feature_id`;
  return rows.map((row) => {
    const selection = row.has_embedding
      ? row.embedding_profile
        ? resolveProseProfileIdSelection(row.embedding_profile, row.embedding_mode)
        : resolveCurrentProseProfileSelection(row.embedding_mode ?? '')
      : null;
    return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    estimatedTokens: Math.max(1, Math.ceil((row.title.length + row.summary.length) / 4)),
    originClass: classifyOrigin(row),
    hasEmbedding: row.has_embedding,
    embeddingMode: row.embedding_mode,
    embeddingProfile: selection?.profileId ?? null,
    titleKey: row.title_key,
    conditionKey: row.condition_key,
    };
  });
}

async function readUnadjudicatedCensus(
  sql: OrgSql,
  opts: AdmissionCensusRunOptions,
  corpusIds: readonly string[],
): Promise<number> {
  const rows = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n
      FROM harness_shared.dedup_edges e
      LEFT JOIN harness_shared.dedup_adjudications d
        ON d.workspace_id = e.workspace_id
       AND d.harness_slug = e.harness_slug
       AND d.a = e.a AND d.b = e.b
     WHERE e.workspace_id = ${opts.workspaceId}
       AND e.harness_slug = ${opts.harnessSlug}
       AND e.cos >= ${ADMISSION_COMPONENT_FLOOR}
       AND d.a IS NULL
       AND e.a = ANY(${corpusIds}::text[])
       AND e.b = ANY(${corpusIds}::text[])`;
  return Number(rows[0]?.n ?? 0);
}

/** What a later bulk stage reads from a finished census: its id (the shard-map key), size and count. */
export type AdmissionCensusRef = Pick<AdmissionCensusRunResult, 'runId' | 'censusAfter' | 'corpusSize'>;

/**
 * WI-10006553: rehydrate a COMPLETE census row instead of re-running it.
 * `runWorkItemAdmissionCensus` never resumes a complete row (see
 * `parseAdmissionCensusResume`); it upserts the row back to 'running' and
 * recomputes the whole census. A recovered bulk pass used to do exactly that
 * for every completed stage's result census: ~16 minutes per bg-host restart,
 * and meanwhile the daily digest, which accepts only a complete source census,
 * could not read it. Returns null for anything not provably complete, so the
 * caller falls back to running the census (an unfinished row still resumes, D-008).
 */
export async function readCompletedAdmissionCensus(
  sql: OrgSql,
  scope: { workspaceId: string; harnessSlug: string },
  runId: string,
): Promise<AdmissionCensusRef | null> {
  const rows = await sql<{ census_after: number | string | null; corpus_size: string | null }[]>`
    SELECT census_after, detail->'snapshot'->>'corpusSize' AS corpus_size
      FROM harness_shared.admission_runs
     WHERE id = ${runId}
       AND workspace_id = ${scope.workspaceId}
       AND harness_slug = ${scope.harnessSlug}
       AND run_kind = 'census'
       AND detail->>'status' = 'complete'
       AND finished_at IS NOT NULL
     LIMIT 1`;
  const row = rows[0];
  if (!row || row.census_after == null || row.corpus_size == null) return null;
  const censusAfter = Number(row.census_after);
  const corpusSize = Number(row.corpus_size);
  if (!Number.isInteger(censusAfter) || censusAfter < 0) return null;
  if (!Number.isInteger(corpusSize) || corpusSize < 0) return null;
  return { runId, censusAfter, corpusSize };
}

/**
 * WI-10006336: the unadjudicated census over ONE population — the members
 * pinned by `pinnedRunId` that are still members of `currentRunId` — so a
 * bulk stage's post-stage ratchet compares the same population it started
 * from. The corpus is "every open item" and is re-read live, so a census taken
 * after a ~50-minute stage also counts items FILED during that stage; one
 * machine emitter adding 39 near-duplicates to a dense cluster added ~9.5K
 * unadjudicated edges and failed a stage that had created none (10-05 stage,
 * 56,606 -> 65,264). A pinned member that leaves the corpus (merged away,
 * closed) only removes edges, which is the decrease the ratchet expects; an
 * edge that genuinely appears between two pinned members still counts, so
 * the guard stays strict for everything the stage could have caused.
 */
export async function readPinnedUnadjudicatedCensus(
  sql: OrgSql,
  opts: Pick<AdmissionCensusRunOptions, 'workspaceId' | 'harnessSlug'>,
  runs: { pinnedRunId: string; currentRunId: string },
): Promise<number> {
  const rows = await sql<Array<{ n: number }>>`
    WITH pinned AS MATERIALIZED (
      SELECT p.item_id
        FROM harness_shared.dedup_shard_map p
        JOIN harness_shared.dedup_shard_map c
          ON c.workspace_id = p.workspace_id
         AND c.harness_slug = p.harness_slug
         AND c.run_id = ${runs.currentRunId}
         AND c.role = 'member'
         AND c.item_id = p.item_id
       WHERE p.workspace_id = ${opts.workspaceId}
         AND p.harness_slug = ${opts.harnessSlug}
         AND p.run_id = ${runs.pinnedRunId}
         AND p.role = 'member'
    )
    SELECT count(*)::int AS n
      FROM harness_shared.dedup_edges e
      LEFT JOIN harness_shared.dedup_adjudications d
        ON d.workspace_id = e.workspace_id
       AND d.harness_slug = e.harness_slug
       AND d.a = e.a AND d.b = e.b
     WHERE e.workspace_id = ${opts.workspaceId}
       AND e.harness_slug = ${opts.harnessSlug}
       AND e.cos >= ${ADMISSION_COMPONENT_FLOOR}
       AND d.a IS NULL
       AND e.a IN (SELECT item_id FROM pinned)
       AND e.b IN (SELECT item_id FROM pinned)`;
  return Number(rows[0]?.n ?? 0);
}

/**
 * Canonical `a\0b` keys of every adjudicated pair inside the corpus, so
 * in-memory lexical edges honour the same "no adjudication" census rule the
 * cosine leg gets from its `dedup_adjudications` anti-join. Exported for the
 * bulk pair generator, which applies the identical exclusion to the lexical
 * pairs it materializes over the pinned member set.
 */
export async function readAdjudicatedPairKeys(
  sql: OrgSql,
  opts: Pick<AdmissionCensusRunOptions, 'workspaceId' | 'harnessSlug'>,
  corpusIds: readonly string[],
): Promise<Set<string>> {
  const rows = await sql<Array<{ a: string; b: string }>>`
    SELECT d.a, d.b
      FROM harness_shared.dedup_adjudications d
     WHERE d.workspace_id = ${opts.workspaceId}
       AND d.harness_slug = ${opts.harnessSlug}
       AND d.a = ANY(${corpusIds}::text[])
       AND d.b = ANY(${corpusIds}::text[])`;
  const keys = new Set<string>();
  for (const row of rows) keys.add(row.a < row.b ? `${row.a}\0${row.b}` : `${row.b}\0${row.a}`);
  return keys;
}

/**
 * WI-1194246 — the admission census's DECLARED bound.
 *
 * Measured 2026-08-30 from `pg_stat_statements` (harness_admin, 9d+ window):
 * the two `WITH corpus AS MATERIALIZED` families in this file reach **367.4s**
 * max / 27.5s mean over 690 calls, and 208.3s max / 42.8s mean. Both ran on a
 * bare `getOrgPg().sql` pool checkout (`runWorkItemAdmissionCensus` line ~777)
 * with no transaction wrapper, so — exactly like `reconcileReadiness` before
 * its own fix — nothing bounded them at all.
 *
 * That is what makes them WI-1194246's blockers: you cannot pick a safe
 * role-level `statement_timeout` default while a legitimate 367s pairwise
 * cosine scan is indistinguishable from a runaway one. Every other long path
 * on this box already declares itself (migrations via MIGRATION_TRANSACTION_PREFIX,
 * pg_dump via PGOPTIONS, the backup↔migration rendezvous via `SET statement_timeout = 0`,
 * the readiness detector via READINESS_RECONCILE_STATEMENT_TIMEOUT_MS).
 * These two simply never said anything.
 *
 * 900s, NOT the 600s the readiness detector uses, and the difference is
 * deliberate: 600s is ~4x that detector's 154.8s worst case, whereas this
 * query's worst case is already 367.4s AND grows with corpus size (it is a
 * pairwise scan over the work-item corpus, which only gets bigger). 600s would
 * be ~1.6x today and would start failing honest runs as the corpus grows.
 * Note also that 367.4s is a FLOOR, not a ceiling: `pg_stat_statements`
 * evicts low-call rows, and `max_exec_time` carries no timestamp, so the true
 * worst case may be higher and may predate any recent change.
 *
 * NOT 0 (unbounded): `getOrgPg`'s shared handle is max:2, so a genuinely
 * runaway scan would pin half the admin pool indefinitely.
 */
export const ADMISSION_CENSUS_STATEMENT_TIMEOUT_MS = 900_000;

/**
 * WI-10004951: waits (ms) before retrying a census statement refused with PG 55P03
 * lock_not_available. About 110s in total.
 *
 * Measured 2026-10-01: migration 1308 took ACCESS EXCLUSIVE on work_items and
 * rewrote it. The role's lock_timeout is 15s, so census-0 of a bulk-dedup fire was
 * cancelled at 16:59:40Z, and one ~30s window ended a pass meant to run 24h. A
 * lock refusal is transient by construction: the holder commits and the statement
 * can run. Only 55P03 is retried. 57014 (statement_timeout) is NOT retried,
 * because the census sets a deliberately long statement_timeout above and
 * retrying it would multiply an already-slow statement.
 */
export const ADMISSION_CENSUS_LOCK_RETRY_BACKOFFS_MS = [5_000, 15_000, 30_000, 60_000] as const;

/** True only for PG 55P03 lock_not_available, raw (`code`) or wrapped (`pgCode`). */
export function isLockNotAvailable(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const o = e as { code?: unknown; pgCode?: unknown };
  return o.code === '55P03' || o.pgCode === '55P03';
}

/**
 * Run one census scan under {@link ADMISSION_CENSUS_STATEMENT_TIMEOUT_MS}.
 *
 * WI-1194246 declared that bound by wrapping each scan in `sql.begin` purely to
 * carry `SET LOCAL`. That is right on a bare pool checkout and WRONG on a handle
 * the caller already has open in a transaction: a postgres.js transaction handle
 * exposes `savepoint`, not `begin`, so the nested call throws
 * `TypeError: sql.begin is not a function`. It did exactly that to every
 * bulk-dedup stage — `runWorkItemAdmissionBulkDedup` is the one
 * `withinTransaction: true` caller and runs its post-merge census on the stage's
 * own `tx` (work-items-admission-bulk-dedup.ts, the `runCensus` inside
 * `sql.begin`), so the whole scheduled bulk-dedup path threw before this branch
 * existed.
 *
 * `SET LOCAL` is already transaction-scoped, so inside a caller's transaction we
 * simply declare the bound on THEIR handle and it reverts at their COMMIT — the
 * same shape `persistCensusPlan` below has always used for its own
 * `withinTransaction` branch. The bound then covers the remainder of that
 * caller's transaction rather than this statement alone; for the only caller
 * that is the bulk-dedup stage, whose other statements are short and which is
 * itself the long-running work this bound exists to permit.
 */
export async function withCensusStatementTimeout<T>(
  sql: OrgSql,
  opts: AdmissionCensusRunOptions,
  body: (tx: OrgSql) => Promise<T>,
): Promise<T> {
  const declare = `SET LOCAL statement_timeout = ${ADMISSION_CENSUS_STATEMENT_TIMEOUT_MS}`;
  if (opts.withinTransaction) {
    await sql.unsafe(declare);
    return body(sql);
  }
  return (await sql.begin(async (tx) => {
    await tx.unsafe(declare);
    return body(tx as unknown as OrgSql);
  })) as T;
}

/**
 * WI-10004965: a census interrupted part-way (a bg-host restart kills the routine
 * fire; DBOS recovery re-runs the census with the SAME runId) resumes from the
 * edge-scan chunks it already finished instead of starting over.
 *
 * Measured 2026-10-01: a full census took 17m03s, while bg-host restarted every
 * ~10-13 min (agents loading fixes plus su-loopback auto-activate). census-0 of one
 * bulk-dedup fire restarted from chunk 0 at 17:14, 17:26, 17:37 and 17:47, so the
 * pass never left census.
 *
 * What is pinned, and why: the edge scan partitions anchors by POSITION in the
 * embedded-id list. If that list were re-read live on resume, one newly filed item
 * would shift every later position and the finished chunks would no longer cover the
 * anchors they claim to. So the first attempt pins the list on its run row, and
 * every resume scans the remaining chunks over the same list. Items filed after
 * the pin are covered by one delta scan (new ids x the live corpus). Everything
 * after the edge scan (plan, counts, shard map) uses the live corpus, as before.
 *
 * The pin lives in `admission_runs.detail.resume` only while the run is unfinished;
 * the completion write replaces `detail` and drops it.
 */
export const ADMISSION_CENSUS_RESUME_SCHEMA = 'work-item-admission-census-resume-v1';
/** A pin older than this is discarded; a routine fire's own timeout is 24h. */
export const ADMISSION_CENSUS_RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface AdmissionCensusChunkCheckpoint {
  /** Pinned positions assigned to this chunk. */
  positions: number;
  /** Of those, rows that still had an embedding at scan time. */
  present: number;
  /** Of those, rows the scan actually anchored (embedding AND profile match). */
  anchors: number;
  edges: number;
  hard: number;
}

export interface AdmissionCensusResumePin {
  schemaVersion: typeof ADMISSION_CENSUS_RESUME_SCHEMA;
  chunkCount: number;
  edgeFloor: number;
  componentFloor: number;
  profileId: string | null;
  pinnedEmbeddedIds: string[];
  pinnedFingerprint: string;
  censusBefore: number;
  attempts: number;
  chunks: Record<string, AdmissionCensusChunkCheckpoint>;
}

function pinFingerprint(ids: readonly string[]): string {
  return createHash('sha256').update(ids.join('\u0001')).digest('hex');
}

function isChunkCheckpoint(value: unknown): value is AdmissionCensusChunkCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return ['positions', 'present', 'anchors', 'edges', 'hard'].every(
    (key) => Number.isInteger(v[key]) && (v[key] as number) >= 0,
  );
}

/**
 * Decide whether an existing run row can be resumed. Pure: every refusal returns
 * null, which means "start fresh", never an error. Only an UNFINISHED ('running')
 * or 'failed' attempt with an intact pin for the same chunking and floors resumes;
 * a 'complete' row (e.g. a stage's result census being re-read) never does.
 */
export function parseAdmissionCensusResume(
  row: { started_at: string | Date; detail: unknown } | undefined,
  expected: { chunkCount: number; nowMs: number },
): { startedAt: string; pin: AdmissionCensusResumePin } | null {
  if (!row || !row.detail || typeof row.detail !== 'object') return null;
  const detail = row.detail as { status?: unknown; resume?: unknown };
  if (detail.status !== 'running' && detail.status !== 'failed') return null;
  const pin = detail.resume as Partial<AdmissionCensusResumePin> | undefined;
  if (!pin || pin.schemaVersion !== ADMISSION_CENSUS_RESUME_SCHEMA) return null;
  if (pin.chunkCount !== expected.chunkCount) return null;
  if (pin.edgeFloor !== ADMISSION_EDGE_FLOOR || pin.componentFloor !== ADMISSION_COMPONENT_FLOOR) return null;
  if (!Array.isArray(pin.pinnedEmbeddedIds) || !pin.pinnedEmbeddedIds.every((id) => typeof id === 'string')) return null;
  if (pin.pinnedFingerprint !== pinFingerprint(pin.pinnedEmbeddedIds)) return null;
  if (!Number.isInteger(pin.censusBefore) || !Number.isInteger(pin.attempts)) return null;
  if (!pin.chunks || typeof pin.chunks !== 'object') return null;
  const startedMs = new Date(row.started_at).getTime();
  if (!Number.isFinite(startedMs) || expected.nowMs - startedMs > ADMISSION_CENSUS_RESUME_MAX_AGE_MS) return null;
  const chunks: Record<string, AdmissionCensusChunkCheckpoint> = {};
  for (const [key, value] of Object.entries(pin.chunks)) {
    const index = Number(key);
    if (Number.isInteger(index) && index >= 0 && index < expected.chunkCount && isChunkCheckpoint(value)) {
      chunks[String(index)] = value;
    }
  }
  return {
    startedAt: new Date(startedMs).toISOString(),
    pin: { ...(pin as AdmissionCensusResumePin), profileId: pin.profileId ?? null, chunks },
  };
}

async function scanEdgeChunk(
  sql: OrgSql,
  opts: AdmissionCensusRunOptions,
  runId: string,
  mode: string,
  selection: ProseProfileSelection,
  embeddedIds: readonly string[],
  chunkIndex: number,
  chunkCount: number,
): Promise<AdmissionCensusChunkCheckpoint> {
  // WI-1194246: runs under the census's declared statement_timeout. It MUST be
  // SET LOCAL, never a session-level `SET`: this can run on a SHARED pool
  // checkout, so a session-level set would leak the bound onto whatever ran
  // next on the same connection — silently un-capping an unrelated caller.
  // SET LOCAL reverts at COMMIT. The body is a single statement, so the
  // wrapper does not change atomicity.
  //
  // WI-10004965: an anchor's chunk is its POSITION in `embeddedIds` (the pinned
  // list), not a row_number over whichever rows currently qualify. A pinned item
  // that lost its embedding between attempts would otherwise shift every later
  // row into a different chunk, and a resumed census would skip anchors that no
  // finished chunk ever scanned.
  const rows = await withCensusStatementTimeout(sql, opts, (tx) =>
    tx<Array<{ positions: number; present: number; anchors: number; edges: number; hard: number }>>`
    WITH pinned AS MATERIALIZED (
      SELECT p.id, p.rn
        FROM unnest(${embeddedIds}::text[]) WITH ORDINALITY AS p(id, rn)
    ), slot AS MATERIALIZED (
      SELECT id FROM pinned
       WHERE mod((rn - 1)::int, ${chunkCount}) = ${chunkIndex}
    ), corpus AS MATERIALIZED (
      SELECT wi.feature_id AS id,
             COALESCE(wi.title, '') AS title,
             wi.embedding,
             p.rn
        FROM pinned p
        JOIN harness_shared.work_items wi
          ON wi.workspace_id = ${opts.workspaceId}
         AND wi.harness_slug = ${opts.harnessSlug}
         AND wi.feature_id = p.id
       WHERE wi.embedding IS NOT NULL
         AND ${proseProfilePredicateSql(tx, selection, 'wi.embedding_profile', 'wi.embedding_mode')}
    ), anchors AS MATERIALIZED (
      SELECT * FROM corpus
       WHERE mod((rn - 1)::int, ${chunkCount}) = ${chunkIndex}
    ), pairs AS MATERIALIZED (
      SELECT a.id AS a,
             b.id AS b,
             (1 - (a.embedding <=> b.embedding))::real AS cos,
             similarity(a.title, b.title)::real AS trgm
        FROM anchors a
        JOIN corpus b ON a.id < b.id
    ), written AS (
      INSERT INTO harness_shared.dedup_edges
        (workspace_id, harness_slug, a, b, cos, trgm, run_id, computed_at)
      SELECT ${opts.workspaceId}, ${opts.harnessSlug}, a, b, cos, trgm, ${runId}, clock_timestamp()
        FROM pairs
       WHERE cos >= ${ADMISSION_EDGE_FLOOR}
      ON CONFLICT (workspace_id, harness_slug, a, b) DO UPDATE SET
        cos = EXCLUDED.cos,
        trgm = EXCLUDED.trgm,
        run_id = EXCLUDED.run_id,
        computed_at = EXCLUDED.computed_at
      RETURNING cos
    )
    SELECT (SELECT count(*)::int FROM slot) AS positions,
           (SELECT count(*)::int
              FROM slot s
              JOIN harness_shared.work_items wi
                ON wi.workspace_id = ${opts.workspaceId}
               AND wi.harness_slug = ${opts.harnessSlug}
               AND wi.feature_id = s.id
             WHERE wi.embedding IS NOT NULL) AS present,
           (SELECT count(*)::int FROM anchors) AS anchors,
           count(*)::int AS edges,
           count(*) FILTER (WHERE cos >= ${ADMISSION_COMPONENT_FLOOR})::int AS hard
      FROM written`);
  return {
    positions: Number(rows[0]?.positions ?? 0),
    present: Number(rows[0]?.present ?? 0),
    anchors: Number(rows[0]?.anchors ?? 0),
    edges: Number(rows[0]?.edges ?? 0),
    hard: Number(rows[0]?.hard ?? 0),
  };
}

/**
 * WI-10004965: on a resumed census, scan the embedded items filed AFTER the pin
 * against the whole live embedded corpus, so the resumed census covers every pair
 * a fresh one would. Pairs between two new items are written once (a < b); every
 * edge is stored canonically (a < b), matching scanEdgeChunk.
 */
async function scanDeltaEdges(
  sql: OrgSql,
  opts: AdmissionCensusRunOptions,
  runId: string,
  selection: ProseProfileSelection,
  deltaIds: readonly string[],
  liveEmbeddedIds: readonly string[],
): Promise<{ anchors: number; edges: number; hard: number }> {
  const rows = await withCensusStatementTimeout(sql, opts, (tx) =>
    tx<Array<{ anchors: number; edges: number; hard: number }>>`
    WITH corpus AS MATERIALIZED (
      SELECT wi.feature_id AS id,
             COALESCE(wi.title, '') AS title,
             wi.embedding,
             (wi.feature_id = ANY(${deltaIds}::text[])) AS is_delta
        FROM harness_shared.work_items wi
       WHERE wi.workspace_id = ${opts.workspaceId}
         AND wi.harness_slug = ${opts.harnessSlug}
         AND wi.feature_id = ANY(${liveEmbeddedIds}::text[])
         AND wi.embedding IS NOT NULL
         AND ${proseProfilePredicateSql(tx, selection, 'wi.embedding_profile', 'wi.embedding_mode')}
    ), anchors AS MATERIALIZED (
      SELECT * FROM corpus WHERE is_delta
    ), pairs AS MATERIALIZED (
      SELECT LEAST(a.id, b.id) AS a,
             GREATEST(a.id, b.id) AS b,
             (1 - (a.embedding <=> b.embedding))::real AS cos,
             similarity(a.title, b.title)::real AS trgm
        FROM anchors a
        JOIN corpus b ON a.id <> b.id AND (NOT b.is_delta OR a.id < b.id)
    ), written AS (
      INSERT INTO harness_shared.dedup_edges
        (workspace_id, harness_slug, a, b, cos, trgm, run_id, computed_at)
      SELECT ${opts.workspaceId}, ${opts.harnessSlug}, a, b, cos, trgm, ${runId}, clock_timestamp()
        FROM pairs
       WHERE cos >= ${ADMISSION_EDGE_FLOOR}
      ON CONFLICT (workspace_id, harness_slug, a, b) DO UPDATE SET
        cos = EXCLUDED.cos,
        trgm = EXCLUDED.trgm,
        run_id = EXCLUDED.run_id,
        computed_at = EXCLUDED.computed_at
      RETURNING cos
    )
    SELECT (SELECT count(*)::int FROM anchors) AS anchors,
           count(*)::int AS edges,
           count(*) FILTER (WHERE cos >= ${ADMISSION_COMPONENT_FLOOR})::int AS hard
      FROM written`);
  return {
    anchors: Number(rows[0]?.anchors ?? 0),
    edges: Number(rows[0]?.edges ?? 0),
    hard: Number(rows[0]?.hard ?? 0),
  };
}

async function removeStaleEdges(
  sql: OrgSql,
  opts: AdmissionCensusRunOptions,
  runId: string,
  startedAt: string,
  embeddedIds: readonly string[],
): Promise<void> {
  await sql`
    DELETE FROM harness_shared.dedup_edges e
     WHERE e.workspace_id = ${opts.workspaceId}
       AND e.harness_slug = ${opts.harnessSlug}
       AND e.run_id <> ${runId}
       AND e.computed_at < ${startedAt}::timestamptz
       AND e.a = ANY(${embeddedIds}::text[])
       AND e.b = ANY(${embeddedIds}::text[])`;
}

async function readCosineEdges(
  sql: OrgSql,
  opts: AdmissionCensusRunOptions,
  embeddedIds: readonly string[],
): Promise<{ all: AdmissionCensusEdge[]; unadjudicated: AdmissionCensusEdge[]; hard: number; total: number }> {
  const hardRows = await sql<EdgeDbRow[]>`
    SELECT e.a, e.b, e.cos, e.trgm, (d.a IS NOT NULL) AS adjudicated
      FROM harness_shared.dedup_edges e
      LEFT JOIN harness_shared.dedup_adjudications d
        ON d.workspace_id = e.workspace_id AND d.harness_slug = e.harness_slug
       AND d.a = e.a AND d.b = e.b
     WHERE e.workspace_id = ${opts.workspaceId}
       AND e.harness_slug = ${opts.harnessSlug}
       AND e.cos >= ${ADMISSION_COMPONENT_FLOOR}
       AND e.a = ANY(${embeddedIds}::text[])
       AND e.b = ANY(${embeddedIds}::text[])
     ORDER BY e.a, e.b`;

  // Ghost context is capped, so reading every one of a dense million-edge soft
  // band would waste memory.  Keep each endpoint's top 20; hard edges are always
  // unioned back in above and therefore never disappear from the planner.
  const softRows = await sql<EdgeDbRow[]>`
    WITH scoped AS MATERIALIZED (
      SELECT e.a, e.b, e.cos, e.trgm
        FROM harness_shared.dedup_edges e
       WHERE e.workspace_id = ${opts.workspaceId}
         AND e.harness_slug = ${opts.harnessSlug}
         AND e.cos >= ${ADMISSION_EDGE_FLOOR}
         AND e.cos < ${ADMISSION_COMPONENT_FLOOR}
         AND e.a = ANY(${embeddedIds}::text[])
         AND e.b = ANY(${embeddedIds}::text[])
    ), ranked AS (
      SELECT a, b, cos, trgm,
             row_number() OVER (PARTITION BY a ORDER BY cos DESC, b) AS rn
        FROM scoped
      UNION ALL
      SELECT a, b, cos, trgm,
             row_number() OVER (PARTITION BY b ORDER BY cos DESC, a) AS rn
        FROM scoped
    )
    SELECT a, b, max(cos)::real AS cos, max(trgm)::real AS trgm
      FROM ranked
     WHERE rn <= ${TEXT_CONTEXT_NEIGHBOURS}
     GROUP BY a, b
     ORDER BY a, b`;
  const countRows = await sql<Array<{ total: number }>>`
    SELECT count(*)::int AS total
      FROM harness_shared.dedup_edges e
     WHERE e.workspace_id = ${opts.workspaceId}
       AND e.harness_slug = ${opts.harnessSlug}
       AND e.cos >= ${ADMISSION_EDGE_FLOOR}
       AND e.a = ANY(${embeddedIds}::text[])
       AND e.b = ANY(${embeddedIds}::text[])`;

  const all = stableEdges([
    ...hardRows.map((row) => ({
      a: row.a,
      b: row.b,
      similarity: Number(row.cos),
      trgm: row.trgm == null ? null : Number(row.trgm),
      source: 'cosine' as const,
    })),
    ...softRows.map((row) => ({
      a: row.a,
      b: row.b,
      similarity: Number(row.cos),
      trgm: row.trgm == null ? null : Number(row.trgm),
      source: 'cosine' as const,
    })),
  ]);
  const unadjudicated = hardRows
    .filter((row) => row.adjudicated !== true)
    .map((row) => ({
      a: row.a,
      b: row.b,
      similarity: Number(row.cos),
      trgm: row.trgm == null ? null : Number(row.trgm),
      source: 'cosine' as const,
    }));
  return { all, unadjudicated, hard: hardRows.length, total: Number(countRows[0]?.total ?? 0) };
}

async function readTextContextEdges(
  sql: OrgSql,
  opts: AdmissionCensusRunOptions,
  corpusIds: readonly string[],
  missingEmbeddingIds: readonly string[],
): Promise<AdmissionCensusEdge[]> {
  const textEdges: AdmissionCensusEdge[] = [];
  for (const missingChunk of partitionTextContextIds(missingEmbeddingIds)) {
    // WI-1194246: runs under the census's declared statement_timeout — see
    // ADMISSION_CENSUS_STATEMENT_TIMEOUT_MS above. SET LOCAL reverts at COMMIT,
    // so it cannot leak the bound onto the next caller of this connection.
    const rows = await withCensusStatementTimeout(sql, opts, (tx) =>
      tx<TextEdgeDbRow[]>`
    WITH corpus AS MATERIALIZED (
      SELECT wi.feature_id AS id,
             COALESCE(wi.title, '') AS title,
             wi.payload #>> '{admissionIdentity,titleKey}' AS title_key
        FROM harness_shared.work_items wi
       WHERE wi.workspace_id = ${opts.workspaceId}
         AND wi.harness_slug = ${opts.harnessSlug}
         AND wi.feature_id = ANY(${corpusIds}::text[])
    ), missing AS MATERIALIZED (
      SELECT id, title, title_key
        FROM corpus
       WHERE id = ANY(${missingChunk}::text[])
    )
    SELECT m.id AS missing_id,
           neighbour.id AS other_id,
           neighbour.trgm,
           neighbour.exact_key
      FROM missing m
      JOIN LATERAL (
        SELECT c.id,
               similarity(m.title, c.title)::real AS trgm,
               COALESCE(m.title_key IS NOT NULL AND m.title_key = c.title_key, false) AS exact_key
          FROM corpus c
          WHERE c.id <> m.id
            AND (
              (m.title_key IS NOT NULL AND m.title_key = c.title_key)
              OR similarity(m.title, c.title) >= ${TEXT_CONTEXT_TRGM_FLOOR}
            )
         ORDER BY COALESCE(m.title_key IS NOT NULL AND m.title_key = c.title_key, false) DESC,
                  similarity(m.title, c.title) DESC,
                  c.id
         LIMIT ${TEXT_CONTEXT_NEIGHBOURS}
      ) neighbour ON neighbour.exact_key OR neighbour.trgm >= ${TEXT_CONTEXT_TRGM_FLOOR}
     ORDER BY m.id, neighbour.exact_key DESC, neighbour.trgm DESC, neighbour.id`);
    textEdges.push(
      ...rows.map((row) => ({
        a: row.missing_id,
        b: row.other_id,
        similarity: row.exact_key ? 1 : Number(row.trgm),
        trgm: Number(row.trgm),
        source: 'text' as const,
        hard: row.exact_key,
      })),
    );
  }
  return stableEdges(textEdges);
}

async function persistShardMap(
  sql: OrgSql,
  opts: AdmissionCensusRunOptions,
  runId: string,
  plan: AdmissionShardPlan,
): Promise<void> {
  const rows = plan.shards.flatMap((shard) => [
    ...shard.members.map((itemId) => ({
      run_id: runId,
      workspace_id: opts.workspaceId,
      harness_slug: opts.harnessSlug,
      shard_id: shard.shardId,
      item_id: itemId,
      role: 'member',
    })),
    ...shard.ghosts.map((itemId) => ({
      run_id: runId,
      workspace_id: opts.workspaceId,
      harness_slug: opts.harnessSlug,
      shard_id: shard.shardId,
      item_id: itemId,
      role: 'ghost',
    })),
  ]);

  const persist = async (tx: OrgSql): Promise<void> => {
    await tx`DELETE FROM harness_shared.dedup_shard_map WHERE run_id = ${runId}`;
    for (let offset = 0; offset < rows.length; offset += 1_000) {
      const batch = rows.slice(offset, offset + 1_000);
      if (batch.length === 0) continue;
      await tx`
        INSERT INTO harness_shared.dedup_shard_map
          ${tx(batch, 'run_id', 'workspace_id', 'harness_slug', 'shard_id', 'item_id', 'role')}`;
    }
    const coverage = await tx<Array<{ members: number; unique_members: number }>>`
      SELECT count(*) FILTER (WHERE role = 'member')::int AS members,
             count(DISTINCT item_id) FILTER (WHERE role = 'member')::int AS unique_members
        FROM harness_shared.dedup_shard_map
       WHERE run_id = ${runId}`;
    const members = Number(coverage[0]?.members ?? 0);
    const unique = Number(coverage[0]?.unique_members ?? 0);
    if (members !== plan.corpusSize || unique !== plan.corpusSize) {
      throw new Error(
        `persisted member coverage mismatch: rows=${members}, unique=${unique}, corpus=${plan.corpusSize}`,
      );
    }
  };
  if (opts.withinTransaction) {
    await persist(sql);
  } else {
    await sql.begin(async (tx) => persist(tx as unknown as OrgSql));
  }
}

export async function runWorkItemAdmissionCensus(opts: AdmissionCensusRunOptions): Promise<AdmissionCensusRunResult> {
  const sql = opts.sql ?? getOrgPg().sql;
  const now = opts.now ?? Date.now;
  const startedMs = now();
  const runId = opts.runId ?? `admission-census-${startedMs}-${randomUUID().slice(0, 8)}`;
  const chunkCount = Math.max(1, Math.floor(opts.chunkCount ?? DEFAULT_EDGE_SCAN_CHUNKS));
  const config = {
    edgeFloor: ADMISSION_EDGE_FLOOR,
    componentFloor: ADMISSION_COMPONENT_FLOOR,
    targetTokens: opts.targetTokens ?? DEFAULT_SHARD_TARGET_TOKENS,
    ceilingTokens: opts.ceilingTokens ?? DEFAULT_SHARD_CEILING_TOKENS,
    ghostFraction: opts.ghostFraction ?? DEFAULT_GHOST_FRACTION,
    chunkCount,
  };
  // WI-10004951: every statement below is retried on its own when PG refuses it with
  // 55P03. That is safe because each one is an autocommit statement or its own
  // `sql.begin`, so a refused attempt has committed nothing. The retry wraps each
  // unit, not the whole census: one late lock refusal must not throw away the
  // completed edge-scan chunks. Inside a caller's transaction a refusal has already
  // aborted that transaction, so it is surfaced unchanged for the caller to retry.
  const lockRetry = <T>(run: () => Promise<T>): Promise<T> =>
    opts.withinTransaction
      ? run()
      : acquireWithContentionRetry(run, {
          backoffsMs: opts.lockRetryBackoffsMs ?? ADMISSION_CENSUS_LOCK_RETRY_BACKOFFS_MS,
          isRetryable: isLockNotAvailable,
          ...(opts.sleep ? { sleep: opts.sleep } : {}),
        });

  // WI-10004965: an interrupted earlier attempt of this runId leaves its pin and
  // finished chunks on the run row. Inside a caller's transaction an interruption
  // rolls the row back too, so only an autocommit census can be resumed.
  const resumable = !opts.withinTransaction;
  const prior =
    resumable && opts.runId
      ? parseAdmissionCensusResume(
          (
            await lockRetry(() => sql<Array<{ started_at: Date; detail: unknown }>>`
              SELECT started_at, detail
                FROM harness_shared.admission_runs
               WHERE id = ${runId}
                 AND workspace_id = ${opts.workspaceId}
                 AND harness_slug = ${opts.harnessSlug}`)
          )[0],
          { chunkCount, nowMs: startedMs },
        )
      : null;
  // A resumed attempt keeps the FIRST attempt's start: removeStaleEdges must not
  // treat edges written by other runs during the earlier attempts as stale, and
  // the bulk-dedup in-flight window is measured from it.
  let startedAt = prior?.startedAt ?? new Date(startedMs).toISOString();

  await lockRetry(() => sql`
    INSERT INTO harness_shared.admission_runs
      (id, workspace_id, harness_slug, run_kind, started_at, detail)
    VALUES (${runId}, ${opts.workspaceId}, ${opts.harnessSlug}, 'census', ${startedAt}::timestamptz,
            ${JSON.stringify({
              schemaVersion: 'work-item-admission-census-v1',
              status: 'running',
              config,
              outcome: {
                unit: 'snapshots',
                attempted: 1,
                successful: null,
                rolledBack: null,
                unchanged: null,
                uniqueRowsChanged: 0,
                failureReason: null,
                blockedReason: null,
              } satisfies AdmissionRunOutcome,
              ...(prior ? { resume: prior.pin } : {}),
            })}::text::jsonb)
    ON CONFLICT (id) DO UPDATE SET
      workspace_id = EXCLUDED.workspace_id,
      harness_slug = EXCLUDED.harness_slug,
      run_kind = EXCLUDED.run_kind,
      started_at = EXCLUDED.started_at,
      finished_at = NULL,
      detail = EXCLUDED.detail`);

  try {
    const corpus = await lockRetry(() => readCorpus(sql, opts));
    const embedded = corpus.filter((item) => item.hasEmbedding);
    const corpusIds = corpus.map((item) => item.id);
    const embeddedIds = embedded.map((item) => item.id);
    const missingEmbeddingIds = corpus.filter((item) => !item.hasEmbedding).map((item) => item.id);
    const profiles = [
      ...new Set(embedded.map((item) => item.embeddingProfile).filter((profile): profile is string => Boolean(profile))),
    ];
    if (embedded.some((item) => !item.embeddingProfile)) {
      throw new Error('embedded work-item rows exist without a compatible embedding_profile');
    }
    if (profiles.length > 1) {
      throw new Error(`mixed embedding profiles in census corpus: ${profiles.sort().join(', ')}`);
    }
    const profileId = profiles[0] ?? null;
    const selection = profileId ? resolveAcceptedProseProfileSelection(profileId) : null;
    if (profileId && !selection) {
      throw new Error(`census resolved an unaccepted embedding profile: ${profileId}`);
    }
    const mode = selection?.legacyMode ?? embedded[0]?.embeddingMode ?? null;
    const snapshotFingerprint = createHash('sha256')
      .update(
        corpus.map((item) => `${item.id}\u0000${item.hasEmbedding ? item.embeddingProfile : 'text-only'}`).join('\u0001'),
      )
      .digest('hex');

    // WI-10004965: reuse the earlier attempt's pin only for the same embedding
    // profile; a profile change invalidates every finished chunk, so start over.
    let resumeDiscarded: string | null = null;
    let pin: AdmissionCensusResumePin | null = null;
    if (prior && prior.pin.profileId === profileId) {
      pin = { ...prior.pin, attempts: prior.pin.attempts + 1 };
    } else if (prior) {
      resumeDiscarded = `embedding profile changed: ${prior.pin.profileId ?? 'none'} -> ${profileId ?? 'none'}`;
      startedAt = new Date(startedMs).toISOString();
    }
    // censusBefore is the count BEFORE this census refreshed any edge, so a resumed
    // attempt reports the first attempt's reading, not one taken mid-refresh.
    const censusBefore = pin ? pin.censusBefore : await lockRetry(() => readUnadjudicatedCensus(sql, opts, corpusIds));
    if (!pin) {
      pin = {
        schemaVersion: ADMISSION_CENSUS_RESUME_SCHEMA,
        chunkCount,
        edgeFloor: ADMISSION_EDGE_FLOOR,
        componentFloor: ADMISSION_COMPONENT_FLOOR,
        profileId,
        pinnedEmbeddedIds: embeddedIds,
        pinnedFingerprint: pinFingerprint(embeddedIds),
        censusBefore,
        attempts: 1,
        chunks: {},
      };
    }
    const activePin = pin;
    const pinnedIds = activePin.pinnedEmbeddedIds;
    await lockRetry(() => sql`
      UPDATE harness_shared.admission_runs
         SET batch_size = ${corpus.length},
             started_at = ${startedAt}::timestamptz,
             detail = detail || ${JSON.stringify({
               snapshot: {
                 fingerprint: snapshotFingerprint,
                 corpusSize: corpus.length,
                 embeddedItems: embeddedIds.length,
                 missingEmbeddingItems: missingEmbeddingIds.length,
               },
               ...(resumable ? { resume: activePin } : {}),
             })}::text::jsonb
       WHERE id = ${runId}`);

    const chunkResults: AdmissionCensusChunkCheckpoint[] = [];
    let resumedChunks = 0;
    let deltaAnchors = 0;
    let anchorsMissingEmbedding = 0;
    let scannedEdgeWrites = 0;
    let scannedHardEdges = 0;
    if (mode && selection) {
      for (let i = 0; i < chunkCount; i += 1) {
        const saved = activePin.chunks[String(i)];
        if (saved) {
          chunkResults.push(saved);
          resumedChunks += 1;
          continue;
        }
        const result = await lockRetry(() =>
          scanEdgeChunk(sql, opts, runId, mode, selection, pinnedIds, i, chunkCount),
        );
        chunkResults.push(result);
        if (resumable) {
          // Checkpoint AFTER the chunk's edges committed. A kill between the two
          // statements re-scans this one chunk; its upserts are idempotent.
          await lockRetry(() => sql`
            UPDATE harness_shared.admission_runs
               SET detail = jsonb_set(detail, ${['resume', 'chunks', String(i)]}::text[],
                                      ${JSON.stringify(result)}::text::jsonb, true)
             WHERE id = ${runId}`);
        }
      }
      const total = (key: keyof AdmissionCensusChunkCheckpoint) => chunkResults.reduce((sum, r) => sum + r[key], 0);
      scannedEdgeWrites = total('edges');
      scannedHardEdges = total('hard');
      if (total('positions') !== pinnedIds.length) {
        throw new Error(`edge-scan coverage mismatch: positions=${total('positions')}, pinned=${pinnedIds.length}`);
      }
      // Every pinned row that still carries an embedding must have been anchored.
      // A gap here means the profile predicate silently excluded embedded rows.
      if (total('anchors') !== total('present')) {
        throw new Error(`edge-scan coverage mismatch: chunks=${total('anchors')}, embedded=${total('present')}`);
      }
      // A pinned item that lost its embedding after the pin is not an error.
      anchorsMissingEmbedding = total('positions') - total('present');
      const pinnedSet = new Set(pinnedIds);
      const deltaIds = embeddedIds.filter((id) => !pinnedSet.has(id));
      if (deltaIds.length > 0) {
        const delta = await lockRetry(() => scanDeltaEdges(sql, opts, runId, selection, deltaIds, embeddedIds));
        deltaAnchors = delta.anchors;
        scannedEdgeWrites += delta.edges;
        scannedHardEdges += delta.hard;
      }
      await lockRetry(() => removeStaleEdges(sql, opts, runId, startedAt, embeddedIds));
    }
    const chunkCoverage = chunkResults.map((r) => r.anchors);

    const lexical = lexicalHardEdges(corpus);
    const [cosine, textContext, adjudicatedPairs] = await Promise.all([
      lockRetry(() => readCosineEdges(sql, opts, embeddedIds)),
      lockRetry(() => readTextContextEdges(sql, opts, corpusIds, missingEmbeddingIds)),
      lexical.length > 0
        ? lockRetry(() => readAdjudicatedPairKeys(sql, opts, corpusIds))
        : Promise.resolve(new Set<string>()),
    ]);
    // stableEdges canonicalizes a < b, so the pair key matches the adjudication keys.
    const lexicalUnadjudicated = lexical.filter((edge) => !adjudicatedPairs.has(`${edge.a}\0${edge.b}`));
    const plan = buildAdmissionShardPlan(
      corpus,
      [...cosine.all, ...textContext, ...lexical],
      [...cosine.unadjudicated, ...lexicalUnadjudicated],
      opts,
    );
    await lockRetry(() => persistShardMap(sql, opts, runId, plan));
    const censusAfter = await lockRetry(() => readUnadjudicatedCensus(sql, opts, corpusIds));
    const latencyMs = Math.max(0, now() - startedMs);
    const detail = {
      schemaVersion: 'work-item-admission-census-v1',
      status: 'complete',
      config,
      snapshot: {
        fingerprint: snapshotFingerprint,
        corpusSize: corpus.length,
        embeddedItems: embeddedIds.length,
        missingEmbeddingItems: missingEmbeddingIds.length,
      },
      corpus: {
        size: corpus.length,
        embedded: embedded.length,
        missingEmbedding: corpus.length - embedded.length,
        embeddingMode: mode,
        originClasses: Object.fromEntries(
          (['machine-emitter', 'ideation', 'agent-filed'] as const).map((originClass) => [
            originClass,
            corpus.filter((item) => item.originClass === originClass).length,
          ]),
        ),
      },
      edges: {
        cosine: cosine.total,
        hard: cosine.hard,
        scanWrites: scannedEdgeWrites,
        scanHardWrites: scannedHardEdges,
        textContext: textContext.length,
        lexicalHard: lexical.length,
        lexicalUnadjudicated: lexicalUnadjudicated.length,
        chunkCoverage,
      },
      shards: {
        count: plan.shards.length,
        memberRows: plan.memberRows,
        ghostRows: plan.ghostRows,
        ghostCandidatesDropped: plan.ghostCandidatesDropped,
        splitOversizedComponents: plan.splitOversizedComponents,
        fingerprint: plan.fingerprint,
        maxMemberTokens: Math.max(0, ...plan.shards.map((shard) => shard.memberTokens)),
        maxGhostTokens: Math.max(0, ...plan.shards.map((shard) => shard.ghostTokens)),
      },
      projection: plan.projection,
      // WI-10004965: how this census was assembled across attempts. The pinned id
      // list itself is dropped here (this write replaces `detail`).
      resume: {
        attempts: activePin.attempts,
        resumedChunks,
        pinnedEmbeddedItems: pinnedIds.length,
        deltaAnchors,
        anchorsMissingEmbedding,
        discarded: resumeDiscarded,
      },
      coverageAssertion: {
        expected: corpus.length,
        memberRows: plan.memberRows,
        uniqueMembers: plan.memberRows,
        ok: plan.memberRows === corpus.length,
      },
      outcome: {
        unit: 'snapshots',
        attempted: 1,
        successful: 1,
        rolledBack: 0,
        unchanged: 0,
        uniqueRowsChanged: 0,
        failureReason: null,
        blockedReason: null,
      } satisfies AdmissionRunOutcome,
    };
    await lockRetry(() => sql`
      UPDATE harness_shared.admission_runs
         SET finished_at = clock_timestamp(),
             batch_size = ${corpus.length},
             promoted = 0,
             merged = 0,
             held = 0,
             auto_promoted_unreviewed = 0,
             census_before = ${censusBefore},
             census_after = ${censusAfter},
             model_id = NULL,
             tokens_in = 0,
             tokens_out = 0,
             latency_ms = ${latencyMs},
             detail = ${JSON.stringify(detail)}::text::jsonb
       WHERE id = ${runId}`);

    return {
      ...plan,
      runId,
      embeddingMode: mode,
      embeddedItems: embedded.length,
      missingEmbeddingItems: corpus.length - embedded.length,
      cosineEdges: cosine.total,
      hardEdges: cosine.hard,
      textContextEdges: textContext.length,
      lexicalEdges: lexical.length,
      lexicalUnadjudicated: lexicalUnadjudicated.length,
      censusBefore,
      censusAfter,
      chunkCoverage,
      latencyMs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql`
      UPDATE harness_shared.admission_runs
         SET finished_at = clock_timestamp(),
             latency_ms = ${Math.max(0, now() - startedMs)},
             detail = COALESCE(detail, '{}'::jsonb) ||
                      ${JSON.stringify({
                        status: 'failed',
                        error: message,
                        outcome: {
                          unit: 'snapshots',
                          attempted: 1,
                          successful: 0,
                          rolledBack: 0,
                          unchanged: 0,
                          uniqueRowsChanged: 0,
                          failureReason: message,
                          blockedReason: null,
                        } satisfies AdmissionRunOutcome,
                      })}::text::jsonb
       WHERE id = ${runId}`.catch(() => undefined);
    throw error;
  }
}
