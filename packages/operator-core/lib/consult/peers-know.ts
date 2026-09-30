/**
 * peers-know — the read-only archive-awareness lookup behind coord:orient's
 * `peersKnow` fold (consult-revival-and-honest-min-2026-08-18 P-006).
 *
 * When an agent DECLARES an intent that a CLOSED consult already settled, the
 * orient payload surfaces the settled answer's one-liner + provenance + a
 * consult:get_feedback pointer — closing the "I didn't know a peer had already
 * answered this" gap at the moment it is cheapest (the agent has not started
 * the work yet).
 *
 * READ-ONLY twin of get-feedback-core's archive-first serve (its P-006): the
 * SAME corpus (state='closed_answered' rows carrying a query_embedding), the
 * SAME embedder space (the router's query embedder wrote those vectors — a
 * caller must pass an embedder from that resolution stack, never its own), and
 * the SAME precision-biased floor (DEFAULT_ARCHIVE_FLOOR) — but it never
 * opens, inserts, or wakes anything. A no-match costs zero payload; any
 * infrastructure failure (embedder unavailable, pgvector/column missing, dims
 * mismatch) degrades to null per the consult layer's per-source degrade
 * contract. Archive-served rows are excluded exactly as in the serve leg, so
 * this never surfaces a copy-of-a-copy.
 */
import type { Sql } from 'postgres';
import { chunkAwareVectorLegSql, withIterativeScan, type PgHandle } from '@papercusp/search';
import { DEFAULT_ARCHIVE_FLOOR } from './get-feedback-core';
import {
  proseProfilePredicateSql,
  type ProseProfileSelection,
} from '../search/prose-vector-dims';
import { CONSULT_QUESTIONS_CHUNK_SURFACE } from '../search/chunks/registry';

/** Cap on the surfaced one-liner — the fold is a hint, not the thread. */
export const PEERS_KNOW_ANSWER_CAP = 280;

/** Intents shorter than this are too generic to match meaningfully (a bare
 * "monitor" / "triage" would cosine-match half the archive at noise level). */
export const PEERS_KNOW_MIN_INTENT_CHARS = 16;

export interface PeersKnowHit {
  /** The settled answer's one-liner (outcome.answer, capped). */
  answer: string;
  /** Source consult conversation id — conversations:get { id } reads the thread. */
  ref: string;
  /** Who answered it (null when the row predates responder attribution). */
  responder: string | null;
  /** ISO close timestamp (staleness signal for the reader). */
  closedAt: string | null;
  /** Cosine similarity of the declared intent to the settled question. */
  sim: number;
}

/** Extract the settled-answer one-liner from a closed_answered outcome jsonb.
 * Exported for tests. Returns null on any shape surprise — the fold is
 * precision-biased: no hit beats a garbled hit. */
export function extractSettledAnswer(outcome: unknown, cap: number = PEERS_KNOW_ANSWER_CAP): string | null {
  if (!outcome || typeof outcome !== 'object') return null;
  const answer = (outcome as { answer?: unknown }).answer;
  if (typeof answer !== 'string') return null;
  const oneLine = answer.replace(/\s+/g, ' ').trim();
  if (!oneLine) return null;
  return oneLine.length > cap ? `${oneLine.slice(0, cap - 1)}…` : oneLine;
}

interface PeersKnowRow {
  conversation_id: string;
  responder_id: string | null;
  outcome: unknown;
  closed_at: string | Date | null;
  sim: number | string;
}

/**
 * Look up whether a CLOSED consult already settled a question semantically
 * matching `intent`. Returns the best above-floor hit, or null (no match, or
 * any degrade). Never throws.
 */
export async function peersKnowLookup(
  sql: Sql,
  query: {
    embed: (text: string) => Promise<number[]>;
    profile: ProseProfileSelection;
  } | null,
  params: { workspaceId: string; intent: string; floor?: number },
): Promise<PeersKnowHit | null> {
  const intent = params.intent.trim();
  if (!query || intent.length < PEERS_KNOW_MIN_INTENT_CHARS) return null;
  const floor = params.floor ?? DEFAULT_ARCHIVE_FLOOR;
  try {
    const vec = await query.embed(intent).catch(() => null);
    if (!vec || vec.length === 0) return null;
    const qVec = JSON.stringify(vec);
    // Same corpus + exclusions as the archive-first serve (get-feedback-core):
    // closed_answered only; archive-served copies excluded; the SELECT doubles
    // as the capability probe (pgvector absent / column not migrated / dims
    // mismatch throws → degrade to null).
    //
    // Retrieve mode (generic-rag-chunking P-012, D-027): each settled question is
    // ranked by the nearer of its own vector (first 2,000 characters) and its window
    // chunks (less the D-016 chunk margin), so an intent matching only the tail of a
    // long question still surfaces it. `sim` is 1 - that distance, so the archive
    // floor applies to a chunk match after its margin.
    const profile = query.profile;
    const rows = (await withIterativeScan(sql as unknown as PgHandle, (handle) => {
      const s = handle as unknown as Sql;
      return s`
        WITH best AS (${chunkAwareVectorLegSql(handle, {
          surface: CONSULT_QUESTIONS_CHUNK_SURFACE,
          // Not 'c': the builder reserves that alias for the chunk table and throws,
          // which the catch below would turn into a silent null on every lookup.
          parentAlias: 'cs',
          qVec,
          limit: 1,
          mode: 'retrieve',
          parentFilter: s`cs.workspace_id = ${params.workspaceId}
                          AND cs.state = 'closed_answered'
                          AND (cs.outcome->>'source' IS DISTINCT FROM 'archive')`,
          // The embedding-space rule stays with the caller; a missing column fails closed.
          spaceFilter: (cols) =>
            cols.profileColumn && cols.modeColumn
              ? proseProfilePredicateSql(s, profile, cols.profileColumn, cols.modeColumn)
              : s`FALSE`,
        })})
        SELECT c.conversation_id, c.responder_id, c.outcome, c.closed_at, 1 - b.distance AS sim
          FROM best b
          JOIN harness_shared.consult_state c
            ON c.workspace_id = b.workspace_id AND c.conversation_id = b.conversation_id
      ORDER BY b.distance, c.conversation_id
         LIMIT 1
      `;
    })) as unknown as PeersKnowRow[];
    const top = rows[0];
    if (!top || Number(top.sim) < floor) return null;
    const answer = extractSettledAnswer(top.outcome);
    if (!answer) return null;
    return {
      answer,
      ref: top.conversation_id,
      responder: top.responder_id ?? null,
      closedAt: top.closed_at ? new Date(top.closed_at as string).toISOString() : null,
      sim: Number(top.sim),
    };
  } catch (err) {
    // A database capability miss (pgvector absent, column not migrated, dims
    // mismatch) carries a SQLSTATE `code` and is the expected degrade. Anything
    // else is a bug in this query, and must not read as "no settled answer":
    // a reserved builder alias once nulled every lookup this way.
    if (typeof (err as { code?: unknown } | null)?.code !== 'string') {
      console.warn(`[peers-know] lookup failed with a non-database error: ${(err as Error)?.message ?? String(err)}`);
    }
    return null;
  }
}
