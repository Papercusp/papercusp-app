/**
 * dedup-edges — persist the create-time dedup prescreen's similarity edges into
 * `harness_shared.dedup_edges` (migration 944), the durable census/promoter substrate
 * for work-queue-admission-and-bulk-dedup-2026-08-24.
 *
 * WHY this exists (plan P-002, item d): a SUCCESSFUL create used to hand its
 * `similarOpen` candidates back to the caller as advisory prose. That is the wrong
 * home for them under born-pending admission: the row was created anyway, the CALLER
 * is not the thing that adjudicates duplication any more (the P-003 promoter is), and
 * an advisory list in a tool result is read by nobody and survives nothing. The
 * candidates are the promoter's evidence, so they go where the promoter reads —
 * `dedup_edges` — and `similarOpen` stays on the REFUSAL returns, where it is
 * load-bearing (it names the item the caller should work instead).
 *
 * ⚠ COSINE ONLY, deliberately. `dedup_edges.cos` carries ONE metric: cosine
 * similarity in the migration-548 embedding space. The census (P-001) counts
 * unadjudicated pairs at cos>=0.90 and unions components at cos>=0.80, so writing a
 * lexical Jaccard / pg_trgm score into that column would not be a lossy approximation
 * — it would silently corrupt the corpus metric the whole plan is measured by. The
 * lexical legs (`source: 'lexical-recent' | 'lexical-fulltext'`) are therefore SKIPPED
 * here. Nothing is lost by that: they already ride into the occurrence ledger as
 * evidence (`workItemOccurrenceEvidence.similarOpen`), and their whole reason for
 * existing is to cover the window BEFORE the async embed-backfill has indexed a fresh
 * row (EI-9940) — once it has, the census recomputes the same pair as a real cosine
 * edge.
 */
import { getOrgPg } from '@papercusp/db-org';

/** The table's documented floor: "similarity edges >=0.85". */
export const DEDUP_EDGE_FLOOR = 0.85;

/**
 * `run_id` for an edge written by the create-time prescreen rather than by a census
 * run. The column is documented as "admission_runs.id of the census run that wrote
 * it" and carries no FK, so a stable sentinel keeps the provenance readable: an edge
 * that has never been touched by a census says so.
 */
export const PRESCREEN_RUN_ID = 'create-prescreen';

/** The subset of `SemanticDupeCandidate` this writer needs (structurally compatible). */
export interface DedupEdgeCandidate {
  id: string;
  harness: string | null;
  similarity: number;
  source?: 'lexical-recent' | 'lexical-fulltext' | 'measurement-overlap';
  titleSimilarity?: number;
}

interface EdgeRow {
  workspace_id: string;
  harness_slug: string;
  a: string;
  b: string;
  cos: number;
  trgm: number | null;
  run_id: string;
}

/**
 * Build the rows a candidate set contributes. Exported for the guard test: the
 * filtering rules (cosine-only, floor, same-harness, a<b) are the whole contract, and
 * they are worth asserting without a live Postgres.
 */
export function buildDedupEdgeRows(input: {
  itemId: string;
  /** The created row's harness. Nullable on purpose: `args.harness` is optional and
   *  a create can resolve its harness only from the written row / session context —
   *  an edge with no harness has no honest row in a harness-scoped table, so it is
   *  skipped rather than guessed. */
  harness: string | null | undefined;
  workspaceId: string | null | undefined;
  candidates: readonly DedupEdgeCandidate[] | undefined;
  runId?: string;
}): EdgeRow[] {
  const { itemId, harness, workspaceId, candidates } = input;
  if (!workspaceId || !harness || !itemId || !candidates?.length) return [];
  const runId = input.runId ?? PRESCREEN_RUN_ID;
  const seen = new Set<string>();
  const rows: EdgeRow[] = [];
  for (const candidate of candidates) {
    // Lexical legs carry a different metric — see the file header.
    if (candidate.source) continue;
    if (!candidate.id || candidate.id === itemId) continue;
    if (!Number.isFinite(candidate.similarity)) continue;
    if (candidate.similarity < DEDUP_EDGE_FLOOR || candidate.similarity > 1) continue;
    // The table is harness-scoped (PK carries harness_slug), so a cross-harness pair
    // has no honest row here. A candidate with no harness is treated as same-harness:
    // that is what the prescreen query already scoped it to.
    if (candidate.harness && candidate.harness !== harness) continue;
    const [a, b] = itemId < candidate.id ? [itemId, candidate.id] : [candidate.id, itemId];
    const key = `${a}\x00${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      workspace_id: workspaceId,
      harness_slug: harness,
      a,
      b,
      cos: candidate.similarity,
      trgm:
        typeof candidate.titleSimilarity === 'number' && Number.isFinite(candidate.titleSimilarity)
          ? candidate.titleSimilarity
          : null,
      run_id: runId,
    });
  }
  return rows;
}

/**
 * Best-effort + NON-FATAL, exactly like the other post-create decorations in
 * `_create-core`: the item already exists, and failing a creation because a census
 * edge could not be recorded would be the worse outcome. Returns how many rows were
 * written so the caller can report it rather than swallow it.
 */
export async function persistDedupEdges(input: {
  itemId: string;
  /** The created row's harness. Nullable on purpose: `args.harness` is optional and
   *  a create can resolve its harness only from the written row / session context —
   *  an edge with no harness has no honest row in a harness-scoped table, so it is
   *  skipped rather than guessed. */
  harness: string | null | undefined;
  workspaceId: string | null | undefined;
  candidates: readonly DedupEdgeCandidate[] | undefined;
  runId?: string;
}): Promise<number> {
  const rows = buildDedupEdgeRows(input);
  if (rows.length === 0) return 0;
  const { sql } = getOrgPg();
  // A prescreen edge is computed in the same embedding space as a census edge and is
  // fresher by construction, so it wins the conflict — including `run_id`, which
  // documents who wrote the CURRENT value.
  await sql`
    INSERT INTO harness_shared.dedup_edges ${sql(
      rows,
      'workspace_id',
      'harness_slug',
      'a',
      'b',
      'cos',
      'trgm',
      'run_id',
    )}
    ON CONFLICT (workspace_id, harness_slug, a, b) DO UPDATE
       SET cos = EXCLUDED.cos,
           trgm = EXCLUDED.trgm,
           run_id = EXCLUDED.run_id,
           computed_at = now()
  `;
  return rows.length;
}
