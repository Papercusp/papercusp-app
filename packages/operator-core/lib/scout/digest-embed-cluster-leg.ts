/**
 * digest-embed-cluster-leg — the P-018(b) flag-gated embedding-cluster EXPERIMENT
 * for the corpus-digest friction clustering (su-ideate-learning-substrate-2026-07-10).
 *
 * The incumbent friction clusterer is `findLikelyDuplicates` (../harness/improvements/
 * digest): PURE, deterministic, network-free — it groups friction captures by their
 * lexical `dedupSignature` (exact) then a token-set Jaccard ≥ 0.8 near-dup pass. Its
 * blind spot is the SAME class the P-017 novelty leg fixes: two captures describing
 * one friction in different words share few tokens, so the lexical pass never
 * collides them and the corpus digest under-counts a recurring meta-pattern.
 *
 * This leg is the FRONTIER EXPERIMENT (D-013 discipline): cluster the same friction
 * titles by EMBEDDING cosine instead of lexical Jaccard, and compare — cluster
 * coherence + the downstream idea grades/outcomes the clusters feed. It is a
 * drop-in for `findLikelyDuplicates` at the corpus-digest seam: same input
 * (`ImprovementCandidate[]`), same output shape (`DupCluster[]` = `{signature, ids}`),
 * so recurringFriction + rubricGaps consume it unchanged.
 *
 * CONTROL + DEFAULT stays LEXICAL. The experiment is OPT-IN
 * (PAPERCUSP_SU_DIGEST_EMBED_CLUSTER=on) and origin-tagged where it fires, so a
 * comparison is falsifiable and the incumbent wins ties until the evidence flips.
 *
 * FAIL-OPEN is the prime directive (mirrors the P-017 leg): the flag off (the
 * default), any embedder error/timeout, a disabled embedder, a dims mismatch
 * (harrier@1024 ≠ the vector(384) space the ledger is embedded under), a pathological
 * backlog, or nothing to cluster — ALL return null, and the caller falls back to the
 * lexical `findLikelyDuplicates`. VITEST-inert unless deps are injected (the real
 * resolver lazy-loads an ONNX model — the WI-3792 load-scar class). Embeddings are
 * deterministic per model+mode and the greedy clustering is order-deterministic, so
 * the digest stays regenerable.
 *
 * WI-4183/EI-9694 (2026-07-11): the leg used to `.embed()` every candidate title
 * fresh, per digest run — the first real execution (EI-9693) measured 69s for 600
 * titles, which forfeits BUDGET_MS at any real corpus size, so flag-on could never
 * actually produce a verdict outside a toy run. Friction candidates ARE
 * `engineer_issues`/`work_items` rows, and they already carry migration-551
 * embeddings maintained by the backfill sweep (embed-backfill.ts) — so this leg now
 * REUSES those stored vectors, JOIN-WISE, with no new storage and no embed cost (the
 * exact D-016 convention semantic-novelty-leg.ts / P-017 established: query
 * `harness_shared.work_items` by `feature_id`, filtered to the CURRENT resolved
 * embedding mode). A candidate whose vector hasn't backfilled yet (or is stored under
 * a different mode) is simply excluded from clustering — fail-open PER ROW, not a
 * whole-leg forfeit. EI-9693 also raised the default cosine threshold 0.85 → 0.92
 * (title-only cosine at 0.85 false-merged template-shaped titles, e.g. two distinct
 * "Test failing repeatedly: <path>" watchdog rows unified because the shared
 * boilerplate sentence shape dominates the vector far more than the differing path).
 * The complementary "strip boilerplate before embedding" / "require weak-lexical AND
 * cosine" refinements EI-9693 also floats are NOT done here: the former is
 * incompatible with reusing stored (whole-title) vectors without paying the re-embed
 * cost back, and the latter needs re-validation against the real corpus (a quick
 * token-overlap analysis on the EI-9693 false-merge examples shows shared path
 * prefixes like `packages/operator-core/lib/` already give ~0.4 lexical Jaccard, so a
 * naive "weak lexical AND cosine" gate would likely still merge them) — left as
 * follow-up idea filing rather than shipped on an unvalidated guess.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { EmbedderProfileSpec } from '@papercusp/memory';

import { dedupSignature, type DupCluster } from '../harness/improvements/digest';
import type { ImprovementCandidate } from '../harness/improvements/policy';
import { parseVectorText } from '../search/embed-space-self-check';

// The prose column width contract — ONE source, not a restated `384` (D-005 §5).
import {
  fitsProseColumns,
  proseProfilePredicateSql,
  resolveProseProfileSelection,
  type ProseProfileSelection,
} from '../search/prose-vector-dims';
/** Whole-leg budget (resolve the current embedding mode + one stored-vector PG join
 *  + the O(n²) cosine pass — no embed() calls since WI-4183/EI-9694 reused stored
 *  vectors). A slow join or a wedged embedder-preference read simply forfeits THIS
 *  digest's experiment and falls back to lexical. */
const BUDGET_MS = 4000;
/** Cosine ≥ this ⇒ two friction titles cluster. The embedding analog of the lexical
 *  NEAR_DUP_JACCARD (0.8); cosine neighbours run higher in absolute terms, so the
 *  default sits above. Raised from the original 0.85 per EI-9693's first-run
 *  evidence: 0.85 false-merged template-shaped titles that differ only by file path
 *  (the shared boilerplate sentence dominates the vector). Override per-experiment
 *  via PAPERCUSP_SU_DIGEST_EMBED_CLUSTER_THRESHOLD. */
const DEFAULT_COSINE_THRESHOLD = 0.92;
/** Above this friction count the experiment forfeits (fail-open to lexical) rather
 *  than embed a pathological backlog — mirrors findLikelyDuplicates' NEAR_DUP bound. */
const MAX_EMBED_CANDIDATES = 600;

/** Injectable seam (tests + any future non-backfill embedding space). */
export interface DigestEmbedClusterDeps {
  resolveEmbedder: () => Promise<
    | {
        mode: string;
        dims: number;
        profile?: Pick<EmbedderProfileSpec, 'profileId' | 'targetDims' | 'distanceMetric'>;
        embed: (t: string) => Promise<number[]>;
      }
    | { mode: 'disabled'; reason?: string }
    | null
  >;
  /** feature_id → stored vector for the ids that HAVE one in `mode`'s embedding
   *  space (migration-551 `harness_shared.work_items.embedding`) — the D-016
   *  join-wise convention (semantic-novelty-leg.ts). No embed() call, no new
   *  storage: an id absent from the returned map has no usable stored vector
   *  (not yet backfilled, or backfilled under a different mode) and is excluded
   *  from clustering rather than embedded fresh. */
  queryStoredVectors: (mode: string, ids: string[], selection: ProseProfileSelection) => Promise<Map<string, number[]>>;
}

/** The experiment is OPT-IN — lexical clustering is the control AND the default. */
export function digestEmbedClusterEnabled(): boolean {
  return process.env.PAPERCUSP_SU_DIGEST_EMBED_CLUSTER === 'on';
}

/** Experiment threshold, env-overridable for tuning; clamped to (0,1], default 0.92. */
export function digestEmbedClusterThreshold(): number {
  const raw = Number(process.env.PAPERCUSP_SU_DIGEST_EMBED_CLUSTER_THRESHOLD);
  if (!Number.isFinite(raw) || raw <= 0 || raw > 1) return DEFAULT_COSINE_THRESHOLD;
  return raw;
}

/** Resolve-null on timeout, never reject — the budget IS the fail-open (P-017 leg). */
function withBudget<T>(ms: number, p: Promise<T | null>): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    (t as unknown as { unref?: () => void }).unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      },
    );
  });
}

/** Cosine similarity of two equal-width vectors. Returns 0 for a zero-norm vector. */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * PURE greedy cosine clustering — the drop-in analog of `findLikelyDuplicates`' near-dup
 * pass, cosine ≥ threshold instead of Jaccard ≥ 0.8. Deterministic given the input order
 * and vectors (parallel arrays, same length). Each emitted cluster has >1 member and
 * carries the exemplar's lexical `dedupSignature` — so downstream consumers
 * (buildRecurringFriction / buildRubricGaps, which key off `cluster.signature` and its
 * `friction:<signature>` ref) are unchanged whichever clusterer produced it.
 */
export function clusterByCosine(
  candidates: ReadonlyArray<{ id: string; title: string }>,
  vectors: ReadonlyArray<number[]>,
  threshold: number,
): DupCluster[] {
  const clusters: DupCluster[] = [];
  const claimed = new Set<number>();
  for (let i = 0; i < candidates.length; i++) {
    if (claimed.has(i)) continue;
    const group = [i];
    for (let j = i + 1; j < candidates.length; j++) {
      if (claimed.has(j)) continue;
      if (cosine(vectors[i], vectors[j]) >= threshold) {
        group.push(j);
        claimed.add(j);
      }
    }
    if (group.length > 1) {
      claimed.add(i);
      clusters.push({
        signature: dedupSignature(candidates[i].title),
        ids: group.map((k) => candidates[k].id),
      });
    }
  }
  return clusters;
}

async function queryStoredVectorsReal(mode: string, ids: string[], selection: ProseProfileSelection): Promise<Map<string, number[]>> {
  if (ids.length === 0) return new Map();
  const { sql } = getOrgPg();
  // migration 374 unified issues + features into harness_shared.work_items;
  // migration 551's embedding columns live on that base — the same table/columns
  // semantic-novelty-leg's queryWorkItemSimsReal joins against for 'wi:<id>' refs.
  const rows = await sql<Array<{ id: string; embedding: string }>>`
    SELECT feature_id AS id, embedding::text AS embedding
      FROM harness_shared.work_items
     WHERE feature_id = ANY(${ids})
       AND embedding IS NOT NULL
       AND ${proseProfilePredicateSql(sql, selection, 'embedding_profile', 'embedding_mode')}`;
  return new Map(rows.map((r) => [r.id, parseVectorText(r.embedding)]));
}

/** The DOCUMENT-side resolver the backfill sweep stores the ledger under — the one
 *  seam that guarantees the friction titles and any stored vectors share space+prompt. */
const realDeps: DigestEmbedClusterDeps = {
  resolveEmbedder: async () => (await import('../search/embed-backfill')).resolveBackfillEmbedder(),
  queryStoredVectors: queryStoredVectorsReal,
};

async function embedAndCluster(
  candidates: readonly ImprovementCandidate[],
  deps: DigestEmbedClusterDeps,
): Promise<DupCluster[] | null> {
  if (candidates.length < 2 || candidates.length > MAX_EMBED_CANDIDATES) return null;
  const resolved = await deps.resolveEmbedder();
  if (!resolved || resolved.mode === 'disabled' || !('embed' in resolved)) return null;
  if (!fitsProseColumns(resolved.dims)) return null; // dims-ineligible for the prose columns (harrier@1024, local@384) — no verdict possible
  const selection = resolved.profile
    ? resolveProseProfileSelection(resolved.mode, resolved.profile)
    : null;
  if (!selection) return null;
  const vectorById = await deps.queryStoredVectors(
    resolved.mode,
    candidates.map((c) => c.id),
    selection,
  );
  // Fail-open PER ROW: a candidate whose stored vector hasn't backfilled yet (or is
  // stored under a different mode) is excluded from clustering, not embedded fresh —
  // that's the whole point of reusing the ledger instead of paying embed cost again.
  const usable: Array<{ id: string; title: string; vector: number[] }> = [];
  for (const c of candidates) {
    const v = vectorById.get(c.id);
    if (v && fitsProseColumns(v.length)) usable.push({ id: c.id, title: c.title, vector: v });
  }
  if (usable.length < 2) return null;
  return clusterByCosine(
    usable.map((u) => ({ id: u.id, title: u.title })),
    usable.map((u) => u.vector),
    digestEmbedClusterThreshold(),
  );
}

/**
 * Cluster friction candidates by EMBEDDING cosine — the flag-gated experiment. Returns
 * null for "no verdict, use the lexical control" (flag off / disabled / unavailable /
 * dims-mismatch / timeout / errored / too few / pathological backlog); the caller MUST
 * treat null as "fall back to findLikelyDuplicates". Never throws.
 */
export async function clusterFrictionByEmbedding(
  candidates: readonly ImprovementCandidate[],
  deps?: DigestEmbedClusterDeps,
): Promise<DupCluster[] | null> {
  if (!digestEmbedClusterEnabled()) return null; // control/default = lexical
  // Inert under vitest unless a test injects deps: the real resolver lazy-loads an
  // ONNX model, which unrelated tool tests must never pay.
  if (process.env.VITEST && !deps) return null;
  try {
    return await withBudget(BUDGET_MS, embedAndCluster(candidates, deps ?? realDeps));
  } catch {
    return null;
  }
}
