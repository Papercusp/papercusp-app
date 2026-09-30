/**
 * semantic-leg — the plans:search embedding leg, as `@papercusp/search`
 * SearchSource parts (P-016 / D-025 of
 * semantic-search-fingerprint-coverage-2026-08-03).
 *
 * Ranks the query vector against the migration-553 `harness_plans` embedding
 * columns (vectors filled by the embed-backfill sweep from
 * `title + left(content, 2000)`) in the ACTIVE space only
 * (`embedding_mode = <active>` — cosine across spaces is noise).
 *
 * ─── WHY THIS FILE EXISTS SEPARATELY FROM semantic-dedup.ts ────────────────
 * It used to live there as `semanticPlanHits`, beside `confirmSimilarPlans`.
 * D-025 splits them, because they are different KINDS of thing and the
 * adjacency invited a real confusion:
 *
 *   - THIS leg is a RANKED SEARCH in the query→doc pairing. It ranks the whole
 *     corpus and hands a list to fusion, where the P-017 floor applies.
 *   - `confirmSimilarPlans` is a THRESHOLD CLASSIFIER in the doc↔doc pairing.
 *     It scores a FIXED candidate list and partitions it at 0.6.
 *
 * gemma is a dual-encoder, so those two numbers live in different pairings and
 * neither licenses the other. Keeping the modules apart makes that structural
 * rather than a comment someone has to notice.
 *
 * ⚠ FAIL-OPEN, BUT NEVER FAIL-SILENT (D-023). `semanticPlanHits` returned a
 * bare `null` on every degraded path — no embedder, declared-dims mismatch,
 * embed-width mismatch, any throw — and plans:search quietly went lexical-only.
 * Under the engine that shape is actively harmful: `embedder: null` makes the
 * engine report `status:'not-run'`, which `summariseLegs` deliberately does NOT
 * flag as degraded (an intentionally lexical-only search is healthy), so a DEAD
 * embedder would be indistinguishable from `semantic:false`. The search still
 * degrades to lexical-only — that part was always right — but it now SAYS SO.
 */

import { withWorkspace } from '@papercusp/db-org';
import type { Embedder, Listing, SearchSourceParams } from '@papercusp/search';

import { resolvePlanScope, type PlanSourceOpts } from './source';
// The prose column width contract — ONE source, not a restated `384` (D-005 §5).
import { fitsProseColumns, resolveProseProfileIdSelection } from '../../search/prose-vector-dims';

export interface PlanSemanticHit {
  slug: string;
  harness: string;
  title: string | null;
  status: string | null;
  archived: boolean;
  /** Cosine similarity (1 − pgvector `<=>` distance) in the active space. */
  similarity: number;
}

/** Injectable seams (tests + any future non-553 store). */
export interface PlanSearchDeps {
  resolveEmbedder: () => Promise<{ mode: string; dims: number; embed: (t: string) => Promise<number[]> } | null>;
  queryTopPlans: (
    vec: number[],
    mode: string,
    opts: PlanSourceOpts & { includeArchived?: boolean; limit: number },
    identity?: SearchSourceParams['embeddingProfile'],
  ) => Promise<PlanSemanticHit[]>;
}

export async function queryTopPlansReal(
  vec: number[],
  mode: string,
  opts: PlanSourceOpts & { includeArchived?: boolean; limit: number },
  identity?: SearchSourceParams['embeddingProfile'],
): Promise<PlanSemanticHit[]> {
  const selection = identity
    ? resolveProseProfileIdSelection(identity.profileId, identity.legacyMode)
    : null;
  if (!selection) return [];
  const { workspaceId, harnessSlug } = await resolvePlanScope(opts);
  const vecLit = `[${vec.join(',')}]`;
  const rows = await withWorkspace(workspaceId, async (tx) => {
    const archivedFilter = opts.includeArchived ? tx`` : tx`AND archived = false`;
    return tx<Array<{ plan_slug: string; harness_slug: string; title: string | null; status: string | null; archived: boolean; similarity: number }>>`
      SELECT plan_slug, harness_slug, title, status, archived,
             1 - (embedding <=> ${vecLit}::vector) AS similarity
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
         AND embedding IS NOT NULL
         AND (embedding_profile = ${selection.profileId}
              OR (${selection.legacyMode !== null}
                  AND embedding_profile IS NULL
                  AND embedding_mode = ${selection.legacyMode ?? mode}))
         AND template_slug IS NULL
         ${archivedFilter}
       ORDER BY embedding <=> ${vecLit}::vector
       LIMIT ${opts.limit}`;
  });
  return rows.map((r) => ({
    slug: r.plan_slug,
    harness: r.harness_slug,
    title: r.title,
    status: r.status,
    archived: r.archived,
    similarity: Number(r.similarity),
  }));
}

export const realPlanSearchDeps: PlanSearchDeps = {
  // SEARCH pairing: a query ranks against stored documents, so the QUERY-side
  // resolver (gemma query prompt) — its vectors are trained to match the
  // backfill sweep's document-prompt vectors.
  resolveEmbedder: async () => (await import('../search/embedder')).buildQueryEmbedderResolved(),
  queryTopPlans: queryTopPlansReal,
};

/**
 * An embedder that rejects with `why` — D-023's vocabulary for "the semantic
 * leg was WANTED and cannot run". The engine turns the rejection into
 * `legs.semantic.blocked = 'query embed failed: <why>'`, which `summariseLegs`
 * flags as degraded. Passing `null` instead would report `not-run`, which is
 * NOT flagged, and is the silent degradation this plan exists to remove.
 */
const unavailable = (why: string): Embedder => async (): Promise<number[]> => {
  throw new Error(why);
};

export interface ResolvedPlansEmbedder {
  /** Never null: either the real embedder or one that rejects with the reason. */
  embedder: Embedder;
  /** The active embedding space, or null when the leg cannot run — a null mode
   *  is what makes the caller omit the source's `embedding()` method, so the
   *  engine never issues a vector query it has no space for. */
  embeddingMode: string | null;
}

/**
 * Resolve the query-side embedder for the plans semantic leg, applying D-023.
 *
 * Call this ONLY when the semantic leg is wanted — when it is not, the caller
 * passes `embedder: null` to the engine, which is the one case `not-run`
 * correctly describes.
 */
export async function resolvePlansEmbedder(deps?: PlanSearchDeps): Promise<ResolvedPlansEmbedder> {
  // WI-3792 load-scar class: the real resolver lazy-loads an ONNX model, so it
  // must never be reached from a unit test that merely forgot to inject deps.
  // Reported as BLOCKED rather than not-run — the leg WAS wanted here, and a
  // test asserting "semantic ran" should fail loudly instead of reading a
  // suppressed embedder as a healthy lexical-only search.
  if (process.env.VITEST && !deps) {
    return {
      embedder: unavailable('vitest: real embedder resolution suppressed (inject PlanSearchDeps to exercise this leg)'),
      embeddingMode: null,
    };
  }
  const d = deps ?? realPlanSearchDeps;
  try {
    const resolved = await d.resolveEmbedder();
    if (!resolved) {
      return { embedder: unavailable('no query embedder resolved (unavailable or disabled)'), embeddingMode: null };
    }
    if (!fitsProseColumns(resolved.dims)) {
      // The embedding columns have a fixed width; a query vector in another
      // space (harrier@1024) cannot rank against them — say so rather than
      // letting pgvector raise a dimension error mid-search.
      return {
        embedder: unavailable(`query embedder dims ${resolved.dims} do not fit the prose embedding columns`),
        embeddingMode: null,
      };
    }
    // 🚨 PASS `resolved.embed` THROUGH UNWRAPPED — never a closure around it (D-024).
    //
    // The P-017 floor is resolved from the embedder INSTANCE: `embedder.ts`
    // stamps each embedder it builds into a `WeakMap<Embedder, mode>` and
    // `embedderModeOf` is a lookup on that exact function object. Any wrapper —
    // however thin — is a DIFFERENT object, so the lookup MISSES, the policy
    // reads "unknown space", and the surface silently inherits NO FLOOR while
    // every leg still appears to run.
    //
    // This costs the width check the old `semanticPlanHits` did on the embed
    // OUTPUT (`dims` is only what the embedder DECLARES). That is the right
    // trade and it is not a silent loss: a wrong-width vector now fails INSIDE
    // `queryTopPlans`, which the engine records in `legs.semantic.failures` and
    // reports as degraded — strictly louder than the old `return null`, which
    // degraded to lexical-only and said nothing at all.
    //
    // `plans-search-embedder-identity.test.ts` fails if this is ever re-wrapped.
    return { embedder: resolved.embed, embeddingMode: resolved.mode };
  } catch (err) {
    return { embedder: unavailable(`query embedder resolution threw: ${(err as Error).message}`), embeddingMode: null };
  }
}

/**
 * Build the `SearchSource.embedding` ranker for plans:search.
 *
 * `sink` receives every hit so the caller can hydrate title/similarity onto the
 * engine's domain-free `SearchHit` after fusion (the engine carries neither).
 *
 * Throws are NOT swallowed here — the engine catches a source failure, records
 * it in `legs.semantic.failures`, and degrades. Swallowing it locally would
 * make a broken harness_plans read look like a leg that simply found nothing.
 */
export function planEmbeddingRanker(
  sourceKey: string,
  embeddingMode: string,
  opts: PlanSourceOpts & { includeArchived?: boolean },
  sink: (hit: PlanSemanticHit) => void,
  deps?: PlanSearchDeps,
): (p: SearchSourceParams & { qVec: string }) => Promise<Listing> {
  const queryTopPlans = (deps ?? realPlanSearchDeps).queryTopPlans;
  return async ({ limit, qVec, embeddingProfile }): Promise<Listing> => {
    // The engine hands over the qVec it already embedded; parse it back to the
    // number[] this store's query helper takes. (One embed per search, shared
    // across every source — which is exactly why the engine owns it.)
    const vec = qVec.slice(1, -1).split(',').map(Number);
    const rows = await queryTopPlans(vec, embeddingMode, { ...opts, limit }, embeddingProfile);
    return rows.map((h) => {
      sink(h);
      return {
        key: h.slug,
        score: h.similarity,
        row: {
          source: sourceKey,
          source_id: h.slug,
          excerpt: h.title ?? h.slug,
          highlight: h.title ?? h.slug,
          score: h.similarity,
          rankers: ['embeddings'],
        },
      };
    });
  };
}
