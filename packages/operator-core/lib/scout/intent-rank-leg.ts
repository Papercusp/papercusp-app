/**
 * intent-rank-leg — P-019 intent-ranked priming for blender:ideation-feedback
 * (su-ideate-learning-substrate-2026-07-10).
 *
 * When an IDEATE pass declares a one-line `intent`, its grounding read (the C-4
 * grader-feedback block + the P-003 outcomes[]) should surface the past proposals
 * most RELEVANT to that focus first, not merely the newest. This leg is the IMPURE
 * half — a sibling of the P-017 semantic-novelty leg, copying the D-016 conventions
 * "every new leg copies": embed the intent text in the doc↔doc backfill space and
 * resolve each routed artifact's stored vector JOIN-WISE with NO new storage —
 * 'plan:<slug>' from migration-553 harness_plans, 'wi:<id>' from migration-551
 * work_items, cosine IN PG — returning a per-routedRef cosine map the pure
 * `rankByIntent` orders entries by. 'gym:<id>' and any other ref shape have no
 * stored vector and rank LAST (newest-first among themselves).
 *
 * FAIL-OPEN is the prime directive (D-016): the kill switch, any embedder
 * error/timeout, a disabled embedder, a dims mismatch (harrier@1024 ≠ vector(384)),
 * a missing migration, the budget expiring, or nothing resolved ALL return null —
 * and the caller keeps its newest-first order. Kill switch
 * PAPERCUSP_SU_INTENT_RANK=off. VITEST-inert unless deps are injected (the real
 * resolver lazy-loads an ONNX model — the WI-3792 load-scar class). Embeddings are
 * deterministic per model+mode, so an intent-ranked read stays regenerable.
 *
 * The migration-551/553 cosine join is intentionally the SAME shape as
 * semantic-novelty-leg's — D-016 has each leg COPY the conventions rather than share
 * a seam; keep the two in sync if the embedding schema moves.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { EmbedderProfileSpec } from '@papercusp/memory';

// The prose column width contract — ONE source, not a restated `384` (D-005 §5).
import {
  fitsProseColumns,
  proseProfilePredicateSql,
  resolveProseProfileSelection,
  type ProseProfileSelection,
} from '../search/prose-vector-dims';
/** Whole-leg budget (embed + both join queries). A warm sidecar answers in ~10ms; a
 *  cold in-process model load (~2.8s) simply forfeits THIS read's intent ranking and
 *  falls back to newest-first. */
const BUDGET_MS = 2500;

/** Per-routedRef cosine similarity [0,1] in the active embedding space. */
export type IntentSimByRef = Map<string, number>;

/** Injectable seams (tests + any future non-backfill space) — mirrors SemanticNoveltyDeps. */
export interface IntentRankDeps {
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
  /** plan_slug → cosine similarity for the slugs that HAVE a vector in `mode`'s space. */
  queryPlanSims: (vec: number[], mode: string, slugs: string[], selection: ProseProfileSelection) => Promise<Map<string, number>>;
  /** feature_id → cosine similarity for the ids that HAVE a vector in `mode`'s space. */
  queryWorkItemSims: (vec: number[], mode: string, ids: string[], selection: ProseProfileSelection) => Promise<Map<string, number>>;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
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

async function queryPlanSimsReal(vec: number[], mode: string, slugs: string[], selection: ProseProfileSelection): Promise<Map<string, number>> {
  if (slugs.length === 0) return new Map();
  const { sql } = getOrgPg();
  const vecLit = `[${vec.join(',')}]`;
  const rows = await sql<Array<{ plan_slug: string; similarity: number }>>`
    SELECT plan_slug, 1 - (embedding <=> ${vecLit}::vector) AS similarity
      FROM harness_shared.harness_plans
     WHERE plan_slug = ANY(${slugs})
       AND embedding IS NOT NULL
       AND ${proseProfilePredicateSql(sql, selection, 'embedding_profile', 'embedding_mode')}`;
  return new Map(rows.map((r) => [r.plan_slug, Number(r.similarity)]));
}

async function queryWorkItemSimsReal(vec: number[], mode: string, ids: string[], selection: ProseProfileSelection): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const { sql } = getOrgPg();
  const vecLit = `[${vec.join(',')}]`;
  // migration 374 unified issues + features into harness_shared.work_items; migration
  // 551's embedding columns live on that base. feature_id is the stable id the routed
  // ledger's 'wi:<id>' refs point at.
  const rows = await sql<Array<{ id: string; similarity: number }>>`
    SELECT feature_id AS id, 1 - (embedding <=> ${vecLit}::vector) AS similarity
      FROM harness_shared.work_items
     WHERE feature_id = ANY(${ids})
       AND embedding IS NOT NULL
       AND ${proseProfilePredicateSql(sql, selection, 'embedding_profile', 'embedding_mode')}`;
  return new Map(rows.map((r) => [r.id, Number(r.similarity)]));
}

const realDeps: IntentRankDeps = {
  // The DOCUMENT-side resolver the backfill sweep stores the ledger under — the one
  // seam that guarantees the intent text and the stored vectors share space + prompt.
  resolveEmbedder: async () => (await import('../search/embed-backfill')).resolveBackfillEmbedder(),
  queryPlanSims: queryPlanSimsReal,
  queryWorkItemSims: queryWorkItemSimsReal,
};

/**
 * Split routed refs by their stored-vector source (routed-ledger ref conventions):
 * 'plan:<slug>' → migration-553 harness_plans; 'wi:<id>' → migration-551 work_items.
 * 'gym:<id>' and any other ref have no stored vector → left out (they rank last).
 * Returns each key's original ref list so the resolved sim keys back by ref.
 */
function partitionRoutedRefs(refs: readonly string[]): {
  planSlugToRefs: Map<string, string[]>;
  wiIdToRefs: Map<string, string[]>;
} {
  const planSlugToRefs = new Map<string, string[]>();
  const wiIdToRefs = new Map<string, string[]>();
  const add = (m: Map<string, string[]>, key: string, ref: string): void => {
    const cur = m.get(key);
    if (cur) cur.push(ref);
    else m.set(key, [ref]);
  };
  for (const ref of refs) {
    if (ref.startsWith('plan:')) add(planSlugToRefs, ref.slice('plan:'.length), ref);
    else if (ref.startsWith('wi:')) add(wiIdToRefs, ref.slice('wi:'.length), ref);
  }
  return { planSlugToRefs, wiIdToRefs };
}

/**
 * PURE stable ranking: order `items` by DESCENDING cosine(intent, the item's routed
 * artifact vector). An item whose ref has a resolved sim ranks ABOVE every item without
 * one; equal-sim ties AND the whole unranked tail preserve the INPUT order — so passing
 * a newest-first array yields "most-relevant first, newest-first within equal relevance
 * and among the unrankable". Deterministic; never mutates `items`.
 */
export function rankByIntent<T>(
  items: readonly T[],
  refOf: (item: T) => string | undefined,
  simByRef: IntentSimByRef,
): T[] {
  return items
    .map((item, i) => {
      const ref = refOf(item);
      const sim = ref != null ? simByRef.get(ref) : undefined;
      return { item, i, sim: typeof sim === 'number' ? sim : null };
    })
    .sort((a, b) => {
      if (a.sim !== b.sim) {
        if (a.sim === null) return 1; // a has no vector → sinks below b
        if (b.sim === null) return -1; // b has no vector → sinks below a
        return b.sim - a.sim; // higher cosine first
      }
      return a.i - b.i; // stable: preserve input (newest-first) order
    })
    .map((d) => d.item);
}

async function resolveSims(
  intent: string,
  refs: readonly string[],
  deps: IntentRankDeps,
): Promise<IntentSimByRef | null> {
  const { planSlugToRefs, wiIdToRefs } = partitionRoutedRefs(refs);
  if (planSlugToRefs.size === 0 && wiIdToRefs.size === 0) return null;
  const resolved = await deps.resolveEmbedder();
  if (!resolved || resolved.mode === 'disabled' || !('embed' in resolved)) return null;
  if (!fitsProseColumns(resolved.dims)) return null; // dims-ineligible for the prose columns (harrier@1024, local@384) — no verdict possible
  const selection = resolved.profile
    ? resolveProseProfileSelection(resolved.mode, resolved.profile)
    : null;
  if (!selection) return null;
  const vec = await resolved.embed(intent.slice(0, 2000));
  if (!fitsProseColumns(vec.length)) return null;
  const [planSims, wiSims] = await Promise.all([
    deps.queryPlanSims(vec, resolved.mode, [...planSlugToRefs.keys()], selection),
    deps.queryWorkItemSims(vec, resolved.mode, [...wiIdToRefs.keys()], selection),
  ]);
  const out: IntentSimByRef = new Map();
  for (const [slug, rs] of planSlugToRefs) {
    const s = planSims.get(slug);
    if (typeof s === 'number') for (const ref of rs) out.set(ref, clamp01(round2(s)));
  }
  for (const [id, rs] of wiIdToRefs) {
    const s = wiSims.get(id);
    if (typeof s === 'number') for (const ref of rs) out.set(ref, clamp01(round2(s)));
  }
  return out.size > 0 ? out : null;
}

/**
 * Resolve per-routedRef cosine similarities for `intent`, JOIN-WISE against stored
 * plan/work-item vectors. Returns null for "no verdict — keep newest-first" (empty
 * intent / kill switch / disabled / dims-mismatch / timeout / errored / nothing
 * resolved); the caller MUST treat null as "leave the newest-first order". Never throws.
 */
export async function resolveIntentSims(
  intent: string,
  refs: readonly string[],
  deps?: IntentRankDeps,
): Promise<IntentSimByRef | null> {
  if (!intent.trim()) return null;
  if (process.env.PAPERCUSP_SU_INTENT_RANK === 'off') return null;
  // Inert under vitest unless a test injects deps: the real resolver lazy-loads an
  // ONNX model, which unrelated tool tests must never pay.
  if (process.env.VITEST && !deps) return null;
  try {
    return await withBudget(BUDGET_MS, resolveSims(intent, refs, deps ?? realDeps));
  } catch {
    return null;
  }
}
