/**
 * Session-epoch surfaced-memory ledger.
 *
 * Plan: memory-delivery-unification-2026-07-12 (P-002, decisions D-002/D-006).
 *
 * The chat pre-turn path dedups re-injection with a 2-minute wall-clock
 * watermark (`last_surfaced_at`) — right for a chat transcript the model
 * re-reads every turn, wrong for a WARM session (psu/su MCP, fleet member):
 * there an injected fact stays in context until COMPACTION, so mid-epoch
 * re-injection is pure token waste, while a compaction should make
 * everything eligible to re-prime at once.
 *
 * This ledger keys dedup on (session_id, epoch, memory_id):
 *   - `epoch` = the session's compaction generation (0 = never compacted);
 *     the post-compaction hook / cold wake bumps it (`bumpSessionEpoch`)
 *     and the whole memory pool becomes injectable again — automatically.
 *   - The ledger is PORT-AGNOSTIC (D-006): initialize, turn-start, compact
 *     re-prime, wake-briefs, and the claim/create injection ports stamp and
 *     read the SAME rows, so orient-then-claim never double-injects.
 *   - `port` records WHICH injection moment surfaced each row — the P-005
 *     per-port telemetry read.
 *
 * Posture mirrors bump-last-surfaced.ts: best-effort, never-throws; a
 * missing relation (migration 581 not applied yet) caches as a process-wide
 * no-op so the injection path degrades to no-dedup rather than failing.
 */

import type { SqlTag } from './bump-last-surfaced';

let relationMissing = false;

function noteMissingRelation(err: unknown): void {
  const msg = (err as Error)?.message ?? '';
  if (/relation .* does not exist/.test(msg) || msg.includes('memory_session_')) {
    relationMissing = true;
  }
}

/** memory_session_surfaced.memory_id is `uuid NOT NULL`, so non-conforming ids
 *  are filtered BEFORE insert (they'd re-inject every port, never error).
 *  VERIFIED structurally safe (orient-recall-quality-2026-07-12 P-005): every
 *  memory-bearing table — memory_canonical.id, all memory_vec_*.memory_id —
 *  is uuid-typed, so a real memory id can never fail this shape. If a NON-uuid
 *  memory source is ever added, widen the column + this filter together. */
const UUID_SHAPE = /^[0-9a-f-]{20,}$/i;

/** Opportunistic GC horizon for ledger rows (days). */
const SURFACED_GC_DAYS = 14;

/**
 * The session's current compaction generation. 0 for a session that never
 * compacted (or was never seen). Best-effort: errors return 0.
 */
export async function currentSessionEpoch(sql: SqlTag, sessionId: string): Promise<number> {
  if (!sessionId || relationMissing) return 0;
  try {
    const rows = (await sql<{ epoch: number }[]>`
      SELECT epoch FROM harness_shared.memory_session_epochs
      WHERE session_id = ${sessionId}
    `) as unknown as { epoch: number }[];
    return rows.length > 0 ? Number(rows[0].epoch) || 0 : 0;
  } catch (err) {
    noteMissingRelation(err);
    return 0;
  }
}

/**
 * Bump the session's epoch (the compaction boundary). Returns the NEW epoch,
 * or null on failure. Also garbage-collects via a coarse age sweep (rows older
 * than SURFACED_GC_DAYS), piggybacked here because epoch bumps are infrequent
 * (once per compaction), so no new scheduler surface is needed.
 *
 * Superseded-epoch rows are deliberately KEPT until the age sweep (rubric-
 * system-improvements-2026-07-12 P-005): they are inert for dedup (reads
 * always filter on the CURRENT epoch) but they are the forensic record the
 * memory-recall-health replication drills query — an immediate delete here
 * erased a drill subject's pre-compaction claim stamps mid-grade on
 * 2026-07-12 (recall drill 2), forcing the delivery leg to be graded from
 * secondary evidence.
 */
export async function bumpSessionEpoch(sql: SqlTag, sessionId: string): Promise<number | null> {
  if (!sessionId || relationMissing) return null;
  try {
    const rows = (await sql<{ epoch: number }[]>`
      INSERT INTO harness_shared.memory_session_epochs (session_id, epoch, bumped_at)
      VALUES (${sessionId}, 1, now())
      ON CONFLICT (session_id)
      DO UPDATE SET epoch = harness_shared.memory_session_epochs.epoch + 1, bumped_at = now()
      RETURNING epoch
    `) as unknown as { epoch: number }[];
    const epoch = rows.length > 0 ? Number(rows[0].epoch) : null;
    // Coarse age sweep — the ONLY ledger GC (superseded epochs stay readable
    // for forensics until they age out; see the function doc).
    await sql`
      DELETE FROM harness_shared.memory_session_surfaced
      WHERE surfaced_at < now() - make_interval(days => ${SURFACED_GC_DAYS})
    `;
    return epoch;
  } catch (err) {
    noteMissingRelation(err);
    return null;
  }
}

/**
 * The subset of `memoryIds` already surfaced to this (session, epoch) —
 * the warm-session dedup read. Best-effort: errors return the EMPTY set so
 * the caller degrades to no-dedup rather than dropping the injection.
 */
export async function alreadySurfacedIds(
  sql: SqlTag,
  sessionId: string,
  epoch: number,
  memoryIds: readonly string[],
): Promise<Set<string>> {
  const empty = new Set<string>();
  if (!sessionId || relationMissing || memoryIds.length === 0) return empty;
  const ids = memoryIds.filter((id) => typeof id === 'string' && UUID_SHAPE.test(id));
  if (ids.length === 0) return empty;
  try {
    const rows = (await sql<{ id: string }[]>`
      SELECT memory_id::text AS id
      FROM harness_shared.memory_session_surfaced
      WHERE session_id = ${sessionId}
        AND epoch = ${epoch}
        AND memory_id = ANY(${ids}::uuid[])
    `) as unknown as { id: string }[];
    return new Set(rows.map((r) => r.id));
  } catch (err) {
    noteMissingRelation(err);
    return empty;
  }
}

/**
 * Stamp memories as surfaced to this (session, epoch) via `port`.
 * Fire-and-forget from the injection path (mirrors bumpLastSurfacedSql).
 */
export async function stampSurfaced(
  sql: SqlTag,
  sessionId: string,
  epoch: number,
  memoryIds: readonly string[],
  port: string,
): Promise<boolean> {
  if (!sessionId || relationMissing) return false;
  const ids = memoryIds.filter((id) => typeof id === 'string' && UUID_SHAPE.test(id));
  if (ids.length === 0) return true;
  try {
    await sql`
      INSERT INTO harness_shared.memory_session_surfaced (session_id, epoch, memory_id, port)
      SELECT ${sessionId}, ${epoch}, unnest(${ids}::uuid[]), ${port}
      ON CONFLICT (session_id, epoch, memory_id) DO NOTHING
    `;
    return true;
  } catch (err) {
    noteMissingRelation(err);
    return false;
  }
}

/** Test hook: reset the relation-missing cache. */
export function _resetSessionEpochLedgerForTests(): void {
  relationMissing = false;
}
