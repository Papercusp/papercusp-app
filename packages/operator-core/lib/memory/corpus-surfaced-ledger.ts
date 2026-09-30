/**
 * Corpus-handle surfaced ledger — the dedup half of the P-008 second retrieval
 * leg (context-injection-audit-2026-07-28 / D-037, migration 712).
 *
 * The exact sibling of ./session-epoch-ledger, and deliberately so: it keys on
 * (session_id, epoch, ref) with the same meaning, shares the same compaction
 * `epoch` (so one bump re-primes memories AND pointers together), and records
 * the same `port` label. What it cannot share is the TABLE — that ledger's key
 * is `memory_id uuid` and every reader filters through a UUID guard, while a
 * corpus handle is `WI-6512` or `<source_kind>:<session_id>`. See migration 712.
 *
 * Why dedup is load-bearing rather than hygiene here: the corpus leg re-runs on
 * every injection moment against a query that barely changes turn-to-turn, so
 * without it the SAME three pointers ride every single turn until the query
 * text moves. That is exactly the turn-over-turn waste D-006 was written to
 * stop — and a repeated pointer is worse than a repeated fact, because the
 * agent has already decided not to resolve it.
 *
 * Posture mirrors the sibling: best-effort, never throws. A missing relation
 * (migration 712 not applied on this box yet) latches a process-wide no-op, so
 * the leg degrades to NO dedup rather than losing the pointers entirely.
 */

import type { SqlTag } from './bump-last-surfaced';

let relationMissing = false;

function noteMissingRelation(err: unknown): void {
  const msg = (err as Error)?.message ?? '';
  if (/relation .* does not exist/.test(msg) || msg.includes('corpus_session_surfaced')) {
    relationMissing = true;
  }
}

/** Opportunistic GC horizon for ledger rows (days) — matches the mem0 sibling. */
const SURFACED_GC_DAYS = 14;

/** Test seam: clear the latched no-op. */
export function _resetCorpusLedgerLatchForTests(): void {
  relationMissing = false;
}

/**
 * Which of `refs` this (session, epoch) has ALREADY been shown. Best-effort: a
 * failure returns the empty set, i.e. no suppression — a broken ledger must
 * cost a duplicate pointer, never a lost one.
 */
export async function alreadySurfacedRefs(
  sql: SqlTag,
  sessionId: string,
  epoch: number,
  refs: readonly string[],
): Promise<Set<string>> {
  const empty = new Set<string>();
  if (!sessionId || relationMissing || refs.length === 0) return empty;
  const wanted = refs.filter((r) => typeof r === 'string' && r.length > 0);
  if (wanted.length === 0) return empty;
  try {
    const rows = (await sql<{ ref: string }[]>`
      SELECT ref FROM harness_shared.corpus_session_surfaced
       WHERE session_id = ${sessionId}
         AND epoch = ${epoch}
         AND ref = ANY(${wanted as string[]}::text[])
    `) as unknown as { ref: string }[];
    return new Set(rows.map((r) => r.ref));
  } catch (err) {
    noteMissingRelation(err);
    return empty;
  }
}

/**
 * Record that `refs` were surfaced to (session, epoch) by `port`. Idempotent —
 * a re-stamp of the same ref keeps the ORIGINAL surfaced_at, so the ledger
 * answers "when was this first shown", not "when did we last try".
 */
export async function stampSurfacedRefs(
  sql: SqlTag,
  sessionId: string,
  epoch: number,
  refs: readonly string[],
  port: string,
): Promise<boolean> {
  if (!sessionId || relationMissing) return false;
  const wanted = [...new Set(refs.filter((r) => typeof r === 'string' && r.length > 0))];
  if (wanted.length === 0) return true;
  try {
    await sql`
      INSERT INTO harness_shared.corpus_session_surfaced (session_id, epoch, ref, port)
      SELECT ${sessionId}, ${epoch}, r, ${port}
        FROM unnest(${wanted as string[]}::text[]) AS r
      ON CONFLICT (session_id, epoch, ref) DO NOTHING
    `;
    // Opportunistic GC on the same connection — cheap, indexed, and it keeps a
    // long-lived box from accumulating dead epochs. Its failure must NOT undo
    // the stamp above, so it carries its own swallow.
    try {
      await sql`
        DELETE FROM harness_shared.corpus_session_surfaced
         WHERE surfaced_at < now() - (${String(SURFACED_GC_DAYS)} || ' days')::interval
      `;
    } catch {
      /* GC is opportunistic — never load-bearing */
    }
    return true;
  } catch (err) {
    noteMissingRelation(err);
    return false;
  }
}
