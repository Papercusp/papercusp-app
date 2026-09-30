/**
 * Loop-wake recipe splice (compaction-continuity-hardening-2026-07-07 P-005c).
 *
 * Recipes exist but are only surfaced at orient — never at the moment of need.
 * A SHORT-form loop wake (P-001b) is exactly that moment: the agent is about to
 * execute its checkpoint's next action, and a recipe that already does it saves
 * the hand-rolled loop. This module finds the ONE recipe worth naming and
 * renders the one-liner the short wake form splices in.
 *
 * The match uses the RAW pgvector cosine (1 − distance) against
 * `harness_shared.code_recipes.embedding` — an ABSOLUTE 0..1 score a floor can
 * gate on. Deliberately NOT searchSimilarRecipes: its blended similarity is
 * normalized against the result set's own max, so a text-only query's top hit
 * is pinned at exactly 0.5 regardless of how unrelated it is — useless as a
 * floor. No embedder (quota exhausted / local model missing) ⇒ no splice;
 * the whole path is fail-soft and time-bounded (the fire path must not stall).
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { withIterativeScan, type PgHandle } from '@papercusp/search';
import { deriveRecipeAuthority } from '../../recipe-authority';
import {
  proseProfilePredicateSql,
  resolveProseProfileSelection,
  type ProseProfileSelection,
} from '../../search/prose-vector-dims';

/** Absolute cosine floor a hit must clear to be worth a wake line — below it
 *  the "match" is topical noise that trains agents to ignore the splice. */
export const LOOP_WAKE_RECIPE_SIM_FLOOR = 0.6;
/** The fire path budget for the whole lookup (embed + query). */
export const LOOP_WAKE_RECIPE_TIMEOUT_MS = 2500;
/** Query text cap — embedders truncate long inputs anyway; the checkpoint's
 *  next-action head carries the signal. */
const QUERY_CAP = 400;
const TITLE_CAP = 90;

export interface WakeRecipeHit {
  id: string;
  title: string;
  runCount: number;
  /** Raw cosine similarity (1 − pgvector distance), 0..1. */
  sim: number;
}

/**
 * The recipe-search query for this wake: the checkpoint's `## Next action`
 * section (the thing the agent is about to do), else the checkpoint head,
 * else the kickoff's first non-empty line.
 */
export function extractWakeRecipeQuery(
  checkpoint: string | null | undefined,
  kickoff: string,
): string {
  const note = (checkpoint ?? '').trim();
  if (note) {
    const m = /##\s*Next action\s*\n+([\s\S]*?)(?=\n##\s|$)/i.exec(note);
    const next = m?.[1]?.trim();
    if (next) return next.slice(0, QUERY_CAP);
    return note.slice(0, QUERY_CAP);
  }
  const firstLine = kickoff.split('\n').find((l) => l.trim().length > 0) ?? kickoff;
  return firstLine.trim().slice(0, QUERY_CAP);
}

/** The one-liner the short wake form splices (id + runCount, per the P-005 spec). */
export function renderWakeRecipeLine(hit: WakeRecipeHit): string {
  const title = hit.title.length > TITLE_CAP ? `${hit.title.slice(0, TITLE_CAP)}…` : hit.title;
  return (
    `Recipe on point (cosine ${hit.sim.toFixed(2)}): recipes:run { id: '${hit.id}' } — ` +
    `"${title}" (run ${hit.runCount}×). Reuse it over hand-rolling the same steps ` +
    '(recipes:get to inspect first).'
  );
}

export interface FindTopRecipeDeps {
  sql?: Sql;
  /** Test seam; `null` = no compatible embedder, undefined = resolve the real one. */
  queryEmbedder?: {
    embed: (text: string) => Promise<number[]>;
    profile: ProseProfileSelection;
  } | null;
  timeoutMs?: number;
}

/** How many cosine-ranked candidates to consider before giving up — lets the
 *  authority-unresolved or entity-bound skip fall through to the next-best hit
 *  instead of surfacing a recipe that recipes:run cannot safely execute here. */
const CANDIDATE_LIMIT = 5;

/**
 * The single best active recipe for `query`, or null when nothing clears the
 * floor / no embedder / any failure / the time budget expires. ≤1-tool recipes
 * are excluded (the established low-value gate, recipes-reuse-activation P-004).
 *
 * WI-4946: a recipe embedding an opaque/unprovable call (raw SQL via
 * dev:pg_query, a shell via capability:bash/capability:script, a nested
 * code:run) can NEVER be authorized via recipes:run — see recipe-authority.ts's
 * `unresolved` flag, a PERMANENT property of the script regardless of context
 * match. recipes:search / code-recipes-search.ts already filter these out of
 * every recommendation; this splice queried raw cosine distance directly and
 * skipped that filter, so it could — and did — recommend an unresolved recipe
 * straight into a guaranteed `authority_unresolved` dead end (the agent's only
 * recourse was re-authoring the same script via code:run). Fetch a small
 * top-N and walk past any unresolved candidate to the next-best one instead of
 * returning the raw #1 hit unconditionally.
 */
export async function findTopRecipeForWake(
  query: string,
  deps: FindTopRecipeDeps = {},
): Promise<WakeRecipeHit | null> {
  const q = query.trim().slice(0, QUERY_CAP);
  if (!q) return null;
  const timeoutMs = deps.timeoutMs ?? LOOP_WAKE_RECIPE_TIMEOUT_MS;

  const lookup = async (): Promise<WakeRecipeHit | null> => {
    let queryEmbedder = deps.queryEmbedder;
    if (queryEmbedder === undefined) {
      const resolved = await (await import('../../agent-tools/search/embedder'))
        .buildQueryEmbedderResolved()
        .catch(() => null);
      const profile = resolved
        ? resolveProseProfileSelection(resolved.mode, resolved.profile)
        : null;
      queryEmbedder = resolved && profile ? { embed: resolved.embed, profile } : null;
    }
    if (!queryEmbedder) return null;
    const vec = await queryEmbedder.embed(q);
    if (!Array.isArray(vec) || vec.length === 0) return null;
    const qVec = `[${vec.join(',')}]`;
    const profile = queryEmbedder.profile;
    // Iterative HNSW scan (WI-10004138): the active + multi-tool filter keeps a
    // small share of the table, so the capped scan came back short. Measured
    // 2026-09-30: 36 of 50 rows over 10 queries without it, 50 with it.
    const rows = (await withIterativeScan((deps.sql ?? getOrgPg().sql) as unknown as PgHandle, (handle) => {
      const sql = handle as unknown as Sql;
      return sql`
      SELECT id, title, script, run_count, 1 - (embedding <=> ${qVec}::vector) AS sim
        FROM harness_shared.code_recipes
       WHERE status = 'active'
         AND embedding IS NOT NULL
         AND ${proseProfilePredicateSql(sql, profile, 'embedding_profile', 'embedding_mode')}
         AND COALESCE(array_length(tools_used, 1), 0) >= 2
    ORDER BY embedding <=> ${qVec}::vector
       LIMIT ${CANDIDATE_LIMIT}
    `;
    })) as unknown as Array<{
      id: string;
      title: string;
      script: string | null;
      run_count: number | string;
      sim: number | string;
    }>;

    for (const row of rows) {
      const sim = Number(row.sim);
      // ORDER BY cosine distance ⇒ sim is non-increasing across rows — once one
      // row misses the floor, every later row misses it too.
      if (!Number.isFinite(sim) || sim < LOOP_WAKE_RECIPE_SIM_FLOOR) break;
      let unsafeForWake = false;
      try {
        const authority = await deriveRecipeAuthority(row.script ?? '');
        // A loop wake carries checkpoint prose, not the authoritative live
        // fleet/plan/item/resource context required to prove a bound recipe is
        // reusable for THIS unit. Recommending it by raw cosine alone can point
        // at a script that claims or completes a different work item. Fail
        // closed and leave bound recommendations to recipes:search, which does
        // receive and validate live entity context.
        unsafeForWake = authority.unresolved || authority.bound;
      } catch {
        unsafeForWake = true; // fail closed: an unparsable script isn't recommendable either
      }
      if (unsafeForWake) continue;
      const runCount = typeof row.run_count === 'number' ? row.run_count : parseInt(row.run_count, 10) || 0;
      return { id: row.id, title: row.title, runCount, sim };
    }
    return null;
  };

  try {
    return await Promise.race([
      lookup(),
      new Promise<null>((resolve) => {
        const t = setTimeout(resolve, timeoutMs, null);
        t.unref?.();
      }),
    ]);
  } catch {
    return null;
  }
}
