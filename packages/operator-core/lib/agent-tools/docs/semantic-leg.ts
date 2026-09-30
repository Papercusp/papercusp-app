/**
 * semantic-leg — the docs:search embedding leg, as `@papercusp/search`
 * SearchSource parts (P-016 of semantic-search-fingerprint-coverage-2026-08-03;
 * originally P-009 of shared-embedding-sidecar-and-enrichment-2026-07-10).
 *
 * Ranks the query vector against migration-552 doc_sections (text synced by
 * search/doc-embed-sync.ts, vectors filled by the embed-backfill sweep) in the
 * ACTIVE embedding space only (`embedding_mode = <active>` — cosine across
 * spaces is noise), and dedupes to the best section per page so the leg ranks
 * PAGES, which is the unit docs:search returns.
 *
 * ⚠ FAIL-OPEN, BUT NEVER FAIL-SILENT (plan decision D-023). This module used
 * to return `null` for every degraded path — no embedder, dims mismatch, any
 * throw — and docs:search quietly went lexical-only. Under the engine that
 * shape is actively harmful: `embedder: null` makes the engine report
 * `status:'not-run'`, which `summariseLegs` deliberately does NOT flag as
 * degraded (an intentionally lexical-only search is healthy), so a DEAD
 * embedder would be indistinguishable from `semantic:false`. The search still
 * degrades to lexical-only — that part was always right — but it now SAYS SO:
 * `resolveDocsEmbedder` hands back an embedder that REJECTS with the reason,
 * which the engine records as `legs.semantic.blocked`.
 */

import { getOrgPg } from '@papercusp/db-org';
import type { Embedder, Listing, SearchSourceParams } from '@papercusp/search';

// The prose column width contract — ONE source, not a restated `384` (D-005 §5).
import { fitsProseColumns, resolveProseProfileIdSelection } from '../../search/prose-vector-dims';
import { sectionAnchorBase, withIterativeScan } from '@papercusp/search';

/** Over-fetch factor: several sections of one page can crowd the top-k; fetch
 *  extra rows so page-level dedupe still fills `limit` distinct pages. */
const OVERFETCH = 3;

export interface DocSemanticHit {
  slug: string;
  url: string;
  title: string;
  /** Best-matching section's anchor ('' = page preamble). Always a NAVIGABLE
   *  heading anchor: a match on a continuation chunk (stored as `<anchor>~N`)
   *  reports the heading it belongs to, never the storage-only chunk id. */
  anchor: string;
  /** Cosine similarity (1 − pgvector `<=>` distance) in the active space. */
  similarity: number;
  excerpt: string;
}

/** Injectable seams (tests + any future non-552 store). */
export interface DocSemanticDeps {
  resolveEmbedder: () => Promise<{ mode: string; dims: number; embed: (t: string) => Promise<number[]> } | null>;
  querySections: (
    vec: number[],
    mode: string,
    sourceKey: string,
    limit: number,
    identity?: SearchSourceParams['embeddingProfile'],
  ) => Promise<DocSemanticHit[]>;
}

async function querySectionsReal(
  vec: number[],
  mode: string,
  sourceKey: string,
  limit: number,
  identity?: SearchSourceParams['embeddingProfile'],
): Promise<DocSemanticHit[]> {
  const selection = identity
    ? resolveProseProfileIdSelection(identity.profileId, identity.legacyMode)
    : null;
  if (!selection) return [];
  const { sql } = getOrgPg();
  const vecLit = `[${vec.join(',')}]`;
  // ITERATIVE SCAN (WI-37603's fix, which this leg missed). doc_sections holds
  // every docs surface in one table, so this query is a FILTERED nearest-
  // neighbour read. When the planner picks the HNSW index (the profile OR-branch
  // below lowers the estimated selectivity enough that it does, e.g. at the
  // engine's limit*OVERFETCH = 72), a non-iterative scan stops after
  // hnsw.ef_search (40) whole-table candidates and filters AFTERWARDS, so a
  // small surface next to a big one gets 0-1 rows back. Measured 2026-09-30 on
  // harness:papercusp (1,425 of ~18.7K rows): LIMIT 72 returned 1 row off vs 72
  // with relaxed_order, and 6 of 10 long harness docs lost their section.
  const rows = await withIterativeScan(sql, (sql) => sql<
    Array<{ slug: string; anchor: string; title: string; url: string; excerpt: string; similarity: number }>
  >`
    SELECT slug, anchor, title, url, left(content, 240) AS excerpt,
           1 - (embedding <=> ${vecLit}::vector) AS similarity
      FROM harness_shared.doc_sections
     WHERE source_key = ${sourceKey}
       AND embedding IS NOT NULL
       AND (embedding_profile = ${selection.profileId}
            OR (${selection.legacyMode !== null}
                AND embedding_profile IS NULL
                AND embedding_mode = ${selection.legacyMode ?? mode}))
     ORDER BY embedding <=> ${vecLit}::vector
     LIMIT ${limit}`);
  return rows.map((r) => ({
    ...r,
    // A continuation chunk is a STORAGE row; the caller gets the heading it
    // came from, so a tail match cites a link target that actually resolves.
    anchor: sectionAnchorBase(r.anchor),
    similarity: Number(r.similarity),
  }));
}

export const realDocSemanticDeps: DocSemanticDeps = {
  // QUERY-side resolver (gemma query prompt) — its vectors are trained to
  // match the document-prompt vectors the backfill sweep stores.
  resolveEmbedder: async () => {
    const { buildQueryEmbedderResolved, interactiveEmbedAcquireBudgetMs } = await import('../search/embedder');
    return buildQueryEmbedderResolved({ acquireBudgetMs: interactiveEmbedAcquireBudgetMs() });
  },
  querySections: querySectionsReal,
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

export interface ResolvedDocsEmbedder {
  /** Never null: either the real embedder or one that rejects with the reason. */
  embedder: Embedder;
  /** The active embedding space, or null when the leg cannot run — a null mode
   *  is what makes the caller omit the source's `embedding()` method, so the
   *  engine never issues a vector query it has no space for. */
  embeddingMode: string | null;
}

/**
 * Resolve the query-side embedder for the docs semantic leg, applying D-023.
 *
 * Call this ONLY when the semantic leg is wanted — when it is not, the caller
 * passes `embedder: null` to the engine, which is the one case `not-run`
 * correctly describes.
 */
export async function resolveDocsEmbedder(deps?: DocSemanticDeps): Promise<ResolvedDocsEmbedder> {
  // WI-3792 load-scar class: the real resolver lazy-loads an ONNX model, so it
  // must never be reached from a unit test that merely forgot to inject deps.
  // Reported as BLOCKED rather than not-run — the leg WAS wanted here, and a
  // test asserting "semantic ran" should fail loudly instead of reading a
  // suppressed embedder as a healthy lexical-only search.
  if (process.env.VITEST && !deps) {
    return { embedder: unavailable('vitest: real embedder resolution suppressed (inject DocSemanticDeps to exercise this leg)'), embeddingMode: null };
  }
  const d = deps ?? realDocSemanticDeps;
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
    // 🚨 PASS `resolved.embed` THROUGH UNWRAPPED — never a closure around it.
    //
    // The P-017 floor is resolved from the embedder INSTANCE: `embedder.ts`
    // stamps each embedder it builds into a `WeakMap<Embedder, mode>` and
    // `embedderModeOf` is a lookup on that exact function object. Any wrapper —
    // however thin — is a DIFFERENT object, so the lookup MISSES, the policy
    // reads "unknown space", and the surface silently inherits NO FLOOR while
    // every leg still appears to run. That is the exact hand-propagation
    // failure P-016 exists to delete, re-created by a helpful-looking guard.
    //
    // This cost the width check the old code did on the embed OUTPUT (`dims`
    // is only what the embedder DECLARES). That is the right trade and it is
    // not a silent loss: a wrong-width vector now fails INSIDE the source's
    // embedding query, which the engine records in `legs.semantic.failures`
    // and reports as degraded — strictly louder than the old `return null`,
    // which degraded to lexical-only and said nothing at all.
    //
    // `docs-search-embedder-identity.test.ts` fails if this is ever re-wrapped.
    return { embedder: resolved.embed, embeddingMode: resolved.mode };
  } catch (err) {
    return { embedder: unavailable(`query embedder resolution threw: ${(err as Error).message}`), embeddingMode: null };
  }
}

/**
 * Build the `SearchSource.embedding` ranker for one docs surface.
 *
 * `sourceKey` is the resolved adapter's name; `sink` receives every page-level
 * hit so the caller can hydrate `anchor`/`url`/`title` onto the engine's
 * domain-free `SearchHit` after fusion (the engine carries none of them).
 *
 * Throws are NOT swallowed here — the engine catches a source failure, records
 * it in `legs.semantic.failures`, and degrades. Swallowing it locally would
 * make a broken doc_sections read look like a leg that simply found nothing.
 */
export function docSectionsRanker(
  sourceKey: string,
  embeddingMode: string,
  sink: (hit: DocSemanticHit) => void,
  deps?: DocSemanticDeps,
): (p: SearchSourceParams & { qVec: string }) => Promise<Listing> {
  const querySections = (deps ?? realDocSemanticDeps).querySections;
  return async ({ query: _query, limit, qVec, embeddingProfile }): Promise<Listing> => {
    // The engine hands over the qVec it already embedded; parse it back to the
    // number[] this store's query helper takes. (One embed per search, shared
    // across every source — which is exactly why the engine owns it.)
    const vec = qVec.slice(1, -1).split(',').map(Number);
    const rows = await querySections(vec, embeddingMode, sourceKey, limit * OVERFETCH, embeddingProfile);
    // Rows arrive distance-ordered; keep each page's best section.
    const bySlug = new Map<string, DocSemanticHit>();
    for (const r of rows) if (!bySlug.has(r.slug)) bySlug.set(r.slug, r);
    return [...bySlug.values()].slice(0, limit).map((h) => {
      sink(h);
      return {
        key: h.slug,
        score: h.similarity,
        row: {
          source: sourceKey,
          source_id: h.slug,
          excerpt: h.excerpt,
          highlight: h.title,
          score: h.similarity,
          rankers: ['embeddings'],
        },
      };
    });
  };
}
