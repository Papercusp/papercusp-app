/**
 * semantic-novelty-leg — the P-017 hybrid embedding leg for corpusNovelty
 * (su-ideate-learning-substrate-2026-07-10, D-016).
 *
 * `corpusNovelty` (critique-core) is a PURE, deterministic, network-free matcher
 * (lexical token-set Jaccard). The 2026-07-10 dupe-storm class — a re-worded
 * re-encounter the lexical matcher misses because no tokens overlap — needs a
 * semantic-neighbour signal. This leg is the IMPURE half: it embeds the query text
 * (doc↔doc space, the SAME `resolveBackfillEmbedder` the ledger is stored under —
 * the sibling choice P-008's work-item dupe guard and plans/semantic-dedup made),
 * resolves each corpus prior's stored vector JOIN-WISE with NO new storage —
 * plan priors ('plan:<slug>') from the migration-553 harness_plans vectors,
 * idea/improvement priors ('wi:<id>' routedRefs) from the migration-551 work_items
 * vectors — and computes cosine IN PG. It returns a per-ref cosine map the pure
 * core blends as `max(lexical, cosine)`. Decision priors ('<slug>#<id>') and any
 * other ref shape have no stored vector and stay lexical-only.
 *
 * FAIL-OPEN is the prime directive (D-016): any embedder error/timeout, a disabled
 * embedder, a dims mismatch (harrier@1024 ≠ the vector(384) columns), a missing
 * migration, or the budget expiring all return null — the caller falls back to
 * pure lexical. Kill switch: PAPERCUSP_SU_SEMANTIC_NOVELTY=off. VITEST-inert unless
 * deps are injected (the real resolver lazy-loads an ONNX model — the WI-3792
 * load-scar class).
 */
import { getOrgPg } from '@papercusp/db-org';
import type { EmbedderProfileSpec } from '@papercusp/memory';
import { withIterativeScan } from '@papercusp/search';

import { corpusNovelty, type CorpusEntry, type CorpusNovelty, type CorpusNoveltyOptions } from './critique-core';

// The prose column width contract — ONE source, not a restated `384` (D-005 §5).
import {
  fitsProseColumns,
  proseProfilePredicateSql,
  resolveProseProfileSelection,
  type ProseProfileSelection,
} from '../search/prose-vector-dims';
/** Whole-leg budget (embed + corpus joins). A warm sidecar answers in ~10ms;
 *  a cold in-process model load (~2.8s) simply forfeits THIS pass's semantic leg. */
const BUDGET_MS = 2500;

/**
 * Query-time implementation priors. This is deliberately a semantic top-K over
 * the WHOLE evidence-backed terminal corpus, never a newest-N window: a shipped
 * mechanism does not become novel merely because it is old. The cap bounds the
 * lexical comparison and prompt payload after retrieval without imposing an
 * age-based coverage cliff.
 */
export const IMPLEMENTATION_CORPUS_TOP_K = 64;
const IMPLEMENTATION_CORPUS_TEXT_MAX = 2_000;

/** Per-corpus-ref cosine similarity [0,1] in the active embedding space. */
export type SemanticSimByRef = Map<string, number>;

export interface ImplementationCorpusCandidate {
  entry: CorpusEntry;
  similarity: number;
}

export interface ImplementationCorpusRow {
  id: string;
  title: string | null;
  completion_evidence: unknown;
  similarity: number | string;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Convert one settled ledger row into the corpus vocabulary Scout already
 * understands. The comparable body is evidence of what landed, not the task's
 * original aspiration; rows without a descriptive completion narrative are
 * excluded even when some other verification field exists.
 */
export function implementationCorpusCandidateFromRow(
  row: ImplementationCorpusRow,
): ImplementationCorpusCandidate | null {
  const evidence =
    row.completion_evidence && typeof row.completion_evidence === 'object' && !Array.isArray(row.completion_evidence)
      ? (row.completion_evidence as Record<string, unknown>)
      : null;
  if (!evidence || !row.id.trim()) return null;
  const summary = nonEmpty(evidence.summary);
  const whatLanded = Array.isArray(evidence.whatLanded)
    ? evidence.whatLanded.map(nonEmpty).filter((value): value is string => value !== null)
    : [];
  if (!summary && whatLanded.length === 0) return null;
  const parts = [nonEmpty(row.title), summary, ...whatLanded].filter((value): value is string => value !== null);
  const text = [...new Set(parts)].join('\n').slice(0, IMPLEMENTATION_CORPUS_TEXT_MAX);
  const similarity = Number(row.similarity);
  if (!text || !Number.isFinite(similarity)) return null;
  return {
    entry: { ref: `wi:${row.id.trim()}`, kind: 'implementation', text, state: 'shipped' },
    similarity: clamp01(round2(similarity)),
  };
}

/** Merge query-time implementation priors by ref so a routed idea that later
 * shipped occupies one corpus slot and gains its completion narrative/state. */
export function mergeImplementationCorpus(
  corpus: readonly CorpusEntry[],
  candidates: readonly ImplementationCorpusCandidate[],
): CorpusEntry[] {
  const out = [...corpus];
  const indexByRef = new Map(out.map((entry, index) => [entry.ref, index]));
  for (const candidate of candidates) {
    const index = indexByRef.get(candidate.entry.ref);
    if (index === undefined) {
      indexByRef.set(candidate.entry.ref, out.length);
      out.push(candidate.entry);
      continue;
    }
    const prior = out[index];
    const text = [...new Set([prior.text, candidate.entry.text].filter(Boolean))]
      .join('\n')
      .slice(0, IMPLEMENTATION_CORPUS_TEXT_MAX);
    out[index] = { ...candidate.entry, text };
  }
  return out;
}

/** Injectable seams (tests + any future non-backfill space). */
export interface SemanticNoveltyDeps {
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
  /** Query-time semantic neighbours from the full settled implementation corpus.
   * Optional so isolated callers/tests retain the pre-WI-6773 behavior. */
  queryImplementationCorpus?: (vec: number[], mode: string, selection: ProseProfileSelection) => Promise<ImplementationCorpusCandidate[]>;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Resolve-null on timeout, never reject — the budget IS the fail-open. */
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
  // Workspace-global on purpose — the novelty corpus is workspace-global (D-003),
  // so the vector join mirrors readNoveltyCorpus's own unscoped plan read.
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

/**
 * Bounded semantic retrieval over realized work. Selection is by distance over
 * the full eligible corpus—not closed/updated recency—so old shipped mechanisms
 * remain discoverable. Completion authority is the inclusion gate and the
 * structured close narrative is the comparable text.
 */
export async function queryImplementationCorpusReal(
  vec: number[],
  mode: string,
  selection: ProseProfileSelection,
): Promise<ImplementationCorpusCandidate[]> {
  const { sql } = getOrgPg();
  const vecLit = `[${vec.join(',')}]`;
  const rows = await withIterativeScan(
    sql,
    (scanSql) => scanSql<ImplementationCorpusRow[]>`
    SELECT feature_id AS id,
           title,
           payload -> '_completionEvidence' AS completion_evidence,
           1 - (embedding <=> ${vecLit}::vector) AS similarity
      FROM harness_shared.work_items
     WHERE harness_shared.work_item_status_is_terminal(status)
       AND authority IN ('committed', 'validated')
       AND lane IS DISTINCT FROM 'observation'
       AND embedding IS NOT NULL
       AND ${proseProfilePredicateSql(scanSql, selection, 'embedding_profile', 'embedding_mode')}
       AND jsonb_typeof(payload -> '_completionEvidence') = 'object'
       AND (
         NULLIF(BTRIM(payload -> '_completionEvidence' ->> 'summary'), '') IS NOT NULL
         OR CASE
              WHEN jsonb_typeof(payload -> '_completionEvidence' -> 'whatLanded') = 'array'
                THEN jsonb_array_length(payload -> '_completionEvidence' -> 'whatLanded') > 0
              ELSE false
            END
       )
  ORDER BY embedding <=> ${vecLit}::vector
     LIMIT ${IMPLEMENTATION_CORPUS_TOP_K}`,
  );
  return rows
    .map(implementationCorpusCandidateFromRow)
    .filter((candidate): candidate is ImplementationCorpusCandidate => candidate !== null);
}

const realDeps: SemanticNoveltyDeps = {
  // The DOCUMENT-side resolver the backfill sweep stores with — the one seam that
  // guarantees the query text and the stored ledger share space AND prompt.
  resolveEmbedder: async () => (await import('../search/embed-backfill')).resolveBackfillEmbedder(),
  queryPlanSims: queryPlanSimsReal,
  queryWorkItemSims: queryWorkItemSimsReal,
  queryImplementationCorpus: queryImplementationCorpusReal,
};

/**
 * Split corpus refs by their stored-vector source (readNoveltyCorpus ref conventions):
 * 'plan:<slug>' → migration-553 harness_plans; 'wi:<id>' → migration-551 work_items.
 * Decisions ('<slug>#<id>') and any other ref have no stored vector → lexical-only.
 * Returns each key's original ref list so the resolved sim is keyed back by ref.
 */
function partitionRefs(corpus: readonly CorpusEntry[]): {
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
  for (const e of corpus) {
    if (e.ref.startsWith('plan:')) add(planSlugToRefs, e.ref.slice('plan:'.length), e.ref);
    else if (e.ref.startsWith('wi:')) add(wiIdToRefs, e.ref.slice('wi:'.length), e.ref);
  }
  return { planSlugToRefs, wiIdToRefs };
}

interface SemanticNoveltyContext {
  corpus: CorpusEntry[];
  sims: SemanticSimByRef;
  implementationCandidates: ImplementationCorpusCandidate[];
}

async function resolveContext(
  text: string,
  corpus: readonly CorpusEntry[],
  deps: SemanticNoveltyDeps,
): Promise<SemanticNoveltyContext | null> {
  const { planSlugToRefs, wiIdToRefs } = partitionRefs(corpus);
  if (planSlugToRefs.size === 0 && wiIdToRefs.size === 0 && !deps.queryImplementationCorpus) return null;
  const resolved = await deps.resolveEmbedder();
  if (!resolved || resolved.mode === 'disabled' || !('embed' in resolved)) return null;
  if (!fitsProseColumns(resolved.dims)) return null; // dims-ineligible for the prose columns (harrier@1024, local@384) — no verdict possible
  const selection = resolved.profile
    ? resolveProseProfileSelection(resolved.mode, resolved.profile)
    : null;
  if (!selection) return null;
  const vec = await resolved.embed(text.slice(0, 2000));
  if (!fitsProseColumns(vec.length)) return null;
  const [planSims, wiSims, implementationCandidates] = await Promise.all([
    deps.queryPlanSims(vec, resolved.mode, [...planSlugToRefs.keys()], selection),
    deps.queryWorkItemSims(vec, resolved.mode, [...wiIdToRefs.keys()], selection),
    deps.queryImplementationCorpus?.(vec, resolved.mode, selection).catch(() => []) ?? [],
  ]);
  const out: SemanticSimByRef = new Map();
  for (const [slug, refs] of planSlugToRefs) {
    const s = planSims.get(slug);
    if (typeof s === 'number') for (const ref of refs) out.set(ref, clamp01(round2(s)));
  }
  for (const [id, refs] of wiIdToRefs) {
    const s = wiSims.get(id);
    if (typeof s === 'number') for (const ref of refs) out.set(ref, clamp01(round2(s)));
  }
  for (const candidate of implementationCandidates) {
    out.set(candidate.entry.ref, candidate.similarity);
  }
  const evaluatedCorpus = mergeImplementationCorpus(corpus, implementationCandidates);
  return out.size > 0 ? { corpus: evaluatedCorpus, sims: out, implementationCandidates } : null;
}

/** One guarded entry to the impure leg. Both public callers must pass through
 * this seam so the kill switch, Vitest isolation, budget, and fail-open behavior
 * cannot drift when the resolved context grows new corpus sources. */
async function resolveContextFailOpen(
  text: string,
  corpus: readonly CorpusEntry[],
  deps?: SemanticNoveltyDeps,
): Promise<SemanticNoveltyContext | null> {
  if (process.env.PAPERCUSP_SU_SEMANTIC_NOVELTY === 'off') return null;
  // Inert under vitest unless a test injects deps: the real resolver lazy-loads an
  // ONNX model, which unrelated tool tests must never pay.
  if (process.env.VITEST && !deps) return null;
  try {
    return await withBudget(BUDGET_MS, resolveContext(text, corpus, deps ?? realDeps));
  } catch {
    return null;
  }
}

/**
 * Resolve per-corpus-ref cosine similarities for `text` in the active embedding
 * space, JOIN-WISE against stored plan/work-item vectors. Returns null for "no
 * verdict" (disabled / unavailable / dims-mismatch / timeout / errored / nothing
 * resolved) — the caller MUST treat null as "pure lexical".
 */
export async function resolveSemanticNoveltySims(
  text: string,
  corpus: readonly CorpusEntry[],
  deps?: SemanticNoveltyDeps,
): Promise<SemanticSimByRef | null> {
  const context = await resolveContextFailOpen(text, corpus, deps);
  if (!context) return null;
  // Preserve this function's original contract: it resolves similarities only
  // for refs the caller supplied. Query-time implementation rows are exposed by
  // corpusNoveltyHybrid's richer result, not leaked through this legacy map.
  const inputRefs = new Set(corpus.map((entry) => entry.ref));
  const sims = new Map([...context.sims].filter(([ref]) => inputRefs.has(ref)));
  return sims.size > 0 ? sims : null;
}

export interface CorpusNoveltyHybridResult extends CorpusNovelty {
  /** The exact corpus scored, including bounded query-time implementation priors. */
  evaluatedCorpus: readonly CorpusEntry[];
  /** Nearest realized-work rows for the LLM skeptic to inspect. These are
   * retrieval candidates, not deterministic duplicate verdicts. */
  implementationCandidates: readonly ImplementationCorpusCandidate[];
}

/**
 * `corpusNovelty` with the P-017 hybrid embedding leg resolved and blended in — the
 * thin async wrapper BOTH novelty callers share (the P-008 su pre-check and the
 * Scout novelty critic), so the impure vector resolution lives in exactly one place
 * and the core stays pure. Resolves the semantic sims FAIL-OPEN, then runs the pure
 * `corpusNovelty`; absent a verdict it is exactly the lexical-only core. An
 * `opts.semanticSimByRef` already present (a test, or a caller holding sims) is
 * used as-is and the leg is skipped.
 */
export async function corpusNoveltyHybrid(
  text: string,
  corpus: readonly CorpusEntry[],
  opts: CorpusNoveltyOptions = {},
  deps?: SemanticNoveltyDeps,
): Promise<CorpusNoveltyHybridResult> {
  const context = opts.semanticSimByRef ? null : await resolveContextFailOpen(text, corpus, deps);
  const evaluatedCorpus = context?.corpus ?? corpus;
  const semanticSimByRef = opts.semanticSimByRef ?? context?.sims ?? undefined;
  return {
    ...corpusNovelty(text, evaluatedCorpus, { ...opts, semanticSimByRef }),
    evaluatedCorpus,
    implementationCandidates: context?.implementationCandidates ?? [],
  };
}
