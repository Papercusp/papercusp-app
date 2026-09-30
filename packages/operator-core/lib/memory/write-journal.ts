/**
 * Memory write-ahead journal (memory-write-journal-auto-recovery-2026-07-11).
 *
 * Closes GAP-1 (remember.ts): memory writes are embed-synchronous, so an
 * embedder outage (sidecar down, quota, timeout under load) used to LOSE the
 * content — the tool returned `{ok:false}` and the fact survived only in the
 * calling agent's session transcript. Live repro 2026-07-10: a
 * memory:remember timed out at 300s while the P-015 harrier re-embed drain
 * saturated the sidecar, and the fact vanished until transcript forensics
 * dug it back out.
 *
 * Shape (plan D-001/D-002):
 *   1. `journalPendingWrite` — a plain relational INSERT (NO embedder
 *      dependency, by construction) BEFORE the embed+store attempt.
 *   2. On store success, `markJournalCommitted` closes the row.
 *   3. On store failure the row stays `pending` and the caller returns
 *      `{ok:false, journaled:true, will_retry:true, journal_id}` — the agent
 *      knows the fact is parked, not lost, and must NOT re-fire.
 *   4. `drainMemoryWriteJournal` rides the 5-min embed-backfill tick
 *      (embed-backfill.ts `runEmbedBackfillOnce`): oldest-first replay through
 *      the normal backend write, with a near-dup guard (an agent that
 *      successfully re-fired the same fact must not produce a duplicate),
 *      bounded attempts, and `recovered_from` provenance (P-007).
 *
 * Every function here is DEFENSIVE: journaling is a safety net under the
 * write path and must never break it — failures log once and degrade to
 * today's behavior (write proceeds unjournaled).
 */

import { getOrgPg } from '@papercusp/db-org';
import { lexicalSimilarity } from '@papercusp/memory';
import { getMemoryBackend } from './backend';
import { detectPossibleSecrets } from './secret-detect';

const T = 'harness_shared.memory_write_journal';

/** Attempts before a row is parked as failed_permanent (surfaced in the
 *  Memory settings UI — never silently dropped). At the 5-min tick with
 *  linear backoff this spans multi-day outages. */
const MAX_ATTEMPTS = (() => {
  const v = Number(process.env.PAPERCUSP_MEMORY_JOURNAL_MAX_ATTEMPTS);
  return Number.isFinite(v) && v > 0 ? v : 30;
})();
/** Rows replayed per drain pass — bounds embedder pressure right after an
 *  outage ends (the drain competes with live traffic for the embedder). */
const DRAIN_BATCH = (() => {
  const v = Number(process.env.PAPERCUSP_MEMORY_JOURNAL_DRAIN_BATCH);
  return Number.isFinite(v) && v > 0 ? v : 25;
})();
/** Near-dup guard threshold for the drain replay (P-004). Deliberately high
 *  (dedup-on-write's hard band): only an unmistakable duplicate suppresses a
 *  recovery — a borderline match must err toward recovering the fact.
 *
 *  EI-10544: this is compared against `lexicalSimilarity` (trigram-Jaccard,
 *  a METRIC on 0..1), NOT against the backend's `score`. A backend score is
 *  ORDINAL on the live hybrid config — RRF rank-fusion, where the top hit is
 *  1/(60+1) ≈ 0.0164 whether it is a byte-identical duplicate or merely the
 *  best of a bad lot (ceiling 2/61 ≈ 0.033 for rank-1 on both legs). No
 *  constant threshold on an ordinal score can mean "similar enough": 0.9 was
 *  unreachable (this guard never once fired — 0 of 42 live journal rows), and
 *  re-tuning it down to the RRF band would instead fire on EVERY write. The
 *  quantity had to change, not the number. */
const DRAIN_DEDUP_THRESHOLD = 0.9;

export interface JournalWriteArgs {
  scope: string;
  kind?: string;
  content: string;
  metadata?: Record<string, unknown>;
  verbatim?: boolean;
  /** Preserve the MemoryBackend opt-in federation bit across recovery. */
  shareable?: boolean;
  /** 'live-write' (tool write path) | 'transcript-miner' (P-008 backfill). */
  source?: string;
}

let _warnedOnce = false;
function warnOnce(err: unknown): void {
  if (_warnedOnce) return;
  _warnedOnce = true;
  console.warn('[memory-journal] degraded (journaling skipped):', (err as Error)?.message ?? err);
}

/**
 * Write-ahead INSERT. Returns the journal row id, or null when journaling is
 * unavailable (pre-migration DB, PG hiccup) — callers proceed with the write
 * either way; null just means the pre-journal (lossy) behavior.
 */
export async function journalPendingWrite(args: JournalWriteArgs): Promise<string | null> {
  try {
    const { sql } = getOrgPg();
    // jsonb bound as `${JSON.stringify(x)}::text::jsonb` — NOT sql.json(), which
    // throws under postgres-js v3.4 on this stack's prepare:false (pgbouncer)
    // pools ("The \"string\" argument must be of type string..."), which made
    // journaling silently skip on every production write (WI-4021 incident).
    const rows = await sql<{ id: string }[]>`
      INSERT INTO harness_shared.memory_write_journal
        (scope, kind, content, metadata, verbatim, shareable, source)
      VALUES (${args.scope}, ${args.kind ?? null}, ${args.content},
              ${args.metadata ? JSON.stringify(args.metadata) : null}::text::jsonb,
              ${args.verbatim ?? true}, ${args.shareable ?? null},
              ${args.source ?? 'live-write'})
      RETURNING id`;
    return rows[0]?.id ?? null;
  } catch (err) {
    warnOnce(err);
    return null;
  }
}

/** Close a journal row after the store write landed. Fire-and-forget safe. */
export async function markJournalCommitted(id: string, memoryId?: string | null): Promise<void> {
  try {
    const { sql } = getOrgPg();
    await sql`
      UPDATE harness_shared.memory_write_journal
         SET status = 'committed', committed_at = now(),
             committed_memory_id = ${memoryId ?? null}
       WHERE id = ${id} AND status = 'pending'`;
  } catch (err) {
    warnOnce(err);
  }
}

export interface PurgeJournalForMemoryArgs {
  id: string;
  /** Hard privacy deletion removes retained history too; soft removal keeps
   * committed history but cancels every replay that could make the row current
   * again. */
  mode: 'hard' | 'soft';
  /** The pre-delete canonical value. This closes the timeout-before-id-known
   * hole: a remember may have landed in the store while its journal row stayed
   * pending without committed_memory_id. */
  snapshot?: { scope: string; text: string };
}

type JournalSql = ReturnType<typeof getOrgPg>['sql'];

/**
 * Remove write-ahead rows that can retain or replay a forgotten memory.
 *
 * This is intentionally STRICT, unlike the journal's best-effort write path:
 * a privacy delete must not report success while a pending replay can restore
 * the fact, or while the journal still retains the supposedly deleted content.
 * Callers run this before changing the canonical row, so a failure preserves a
 * retryable source of truth instead of producing a half-delete.
 *
 * `deps.sql` is the real-Postgres test seam; production always uses getOrgPg().
 */
export async function purgeJournalForMemory(
  args: PurgeJournalForMemoryArgs,
  deps: { sql?: JournalSql } = {},
): Promise<number> {
  const sql = deps.sql ?? getOrgPg().sql;
  const hard = args.mode === 'hard';
  const hasSnapshot = Boolean(args.snapshot?.scope && args.snapshot.text);
  const rows = await sql<{ id: string }[]>`
    DELETE FROM harness_shared.memory_write_journal
     WHERE (
       ${hard}
       AND (
         committed_memory_id::text = ${args.id}
         OR metadata->>'__journal_update_of' = ${args.id}
         OR metadata->>'__journal_supersede_of' = ${args.id}
         OR (
           ${hasSnapshot}
           AND scope = ${args.snapshot?.scope ?? ''}
           AND content = ${args.snapshot?.text ?? ''}
         )
       )
     )
     OR (
       ${!hard}
       AND status <> 'committed'
       AND (
         metadata->>'__journal_update_of' = ${args.id}
         OR metadata->>'__journal_supersede_of' = ${args.id}
         OR (
           ${hasSnapshot}
           AND scope = ${args.snapshot?.scope ?? ''}
           AND content = ${args.snapshot?.text ?? ''}
         )
       )
     )
    RETURNING id`;
  return rows.length;
}

/** Live pending count — the Memory settings page "N memories pending
 *  embedding" badge (P-006a). */
export async function pendingJournalCount(): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM harness_shared.memory_write_journal WHERE status = 'pending'`;
  return Number(rows[0]?.n ?? 0);
}

export interface DrainResult {
  scanned: number;
  recovered: number;
  deduped: number;
  retriesExhausted: number;
  stillPending: number;
  /** Oldest/newest requested_at among the rows recovered THIS pass — the
   *  "Memory recovered: N facts from HH:MM–HH:MM" banner window (P-006b). */
  recoveredWindow: { from: string; to: string } | null;
}

interface JournalRow {
  id: string;
  requested_at: string;
  scope: string;
  kind: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  verbatim: boolean;
  shareable: boolean | null;
  attempts: number;
}

/**
 * Replay pending journal rows through the normal backend write. Rides the
 * 5-min embed-backfill tick (plan D-002 — the outage classes overlap: both
 * drains want the embedder back). Linear backoff: a row with N failed
 * attempts is retried only after N*5 minutes since the last attempt.
 *
 * Concurrency safety does NOT rest on the `FOR UPDATE SKIP LOCKED` below: this
 * SELECT runs in postgres-js autocommit (there is no enclosing `sql.begin()`),
 * so those row locks release the instant the SELECT returns — BEFORE the
 * per-row backend.remember/update writes run. What actually prevents a
 * double-drain is (1) DBOS single-flight scheduling: `embedBackfill`'s workflow
 * id is deterministic per 5-min slot, so only ONE process runs a given tick
 * clusterwide even across multiple operator hosts (periodic-workflows.ts); and
 * (2) the `WHERE ... status='pending'` guard on every commit UPDATE — a second
 * drainer that somehow raced in commits 0 rows — backed by the near-dup guard
 * as a last catch. Keep it this way: do NOT "fix" SKIP LOCKED by wrapping the
 * whole pass in a single `sql.begin()` to hold the locks across the loop — that
 * pins one pgbouncer-pooled connection open across up to DRAIN_BATCH slow
 * embedder round-trips (connection exhaustion, this `prepare:false` pool's weak
 * spot). SKIP LOCKED stays only as cheap belt-and-suspenders for the rare
 * overlapping-tick case DBOS already makes near-impossible.
 */
export async function drainMemoryWriteJournal(): Promise<DrainResult> {
  const res: DrainResult = {
    scanned: 0, recovered: 0, deduped: 0, retriesExhausted: 0, stillPending: 0,
    recoveredWindow: null,
  };
  const { sql } = getOrgPg();
  const backend = getMemoryBackend();

  // Cheap early-out: don't touch the backend (client build, embedder spin-up)
  // when there is nothing to drain — the common case for every healthy tick.
  const rows = await sql<JournalRow[]>`
    SELECT id, requested_at, scope, kind, content, metadata, verbatim, shareable, attempts
      FROM harness_shared.memory_write_journal
     WHERE status = 'pending'
       AND (last_attempt_at IS NULL
            OR last_attempt_at < now() - (attempts * interval '5 minutes'))
     ORDER BY requested_at
     LIMIT ${DRAIN_BATCH}
     FOR UPDATE SKIP LOCKED`;
  if (rows.length === 0) return res;
  res.scanned = rows.length;

  const avail = await backend.available().catch(() => ({ ok: false as const, reason: 'probe_failed' }));
  if (!avail.ok) {
    // Embedder/store still down — leave rows untouched (attempts only count
    // actual replay failures, not ticks spent waiting out the outage).
    res.stillPending = rows.length;
    return res;
  }

  const recoveredTs: string[] = [];
  for (const row of rows) {
    try {
      const updateOf = typeof row.metadata?.__journal_update_of === 'string'
        ? (row.metadata.__journal_update_of as string)
        : null;
      const supersedeOf = typeof row.metadata?.__journal_supersede_of === 'string'
        ? (row.metadata.__journal_supersede_of as string)
        : null;
      const updatePatch = row.metadata?.__journal_update_patch && typeof row.metadata.__journal_update_patch === 'object'
        ? row.metadata.__journal_update_patch as { text?: string; metadata?: Record<string, unknown> }
        : null;
      const {
        __journal_update_of: _journalUpdateOf,
        __journal_supersede_of: _journalSupersedeOf,
        __journal_update_patch: _journalUpdatePatch,
        ...storedMetadata
      } = row.metadata ?? {};

      // EI-10371 stage 1: re-detect at replay time — update-replays don't carry
      // journal metadata into the store, and rows journaled before stamping
      // existed would otherwise land unflagged.
      const secrets = detectPossibleSecrets(row.content);

      if (updateOf) {
        // A journaled memory:update text edit — replay as an update, not an add.
        // The flag re-stamps BOTH ways, matching a live edit's semantics
        // (editing a secret out must clear it).
        await backend.update(updateOf, updatePatch ?? {
          text: row.content,
          metadata: { possible_secret: secrets.matched, possible_secret_classes: secrets.classes },
        });
        if (supersedeOf) {
          const invalidateEntry = backend.invalidateEntry?.bind(backend);
          if (!invalidateEntry) throw new Error('journal update supersede requires validity-window support');
          const closed = await invalidateEntry(supersedeOf, { supersededBy: updateOf });
          if (!closed) {
            const after = await backend.get(supersedeOf);
            const validity = after?.metadata?.validity as { superseded_by?: unknown } | undefined;
            if (validity?.superseded_by !== updateOf) {
              await invalidateEntry(updateOf);
              throw new Error('journal update supersession lost immutable-winner race; replacement closed');
            }
          }
        }
        await sql`
          UPDATE harness_shared.memory_write_journal
             SET status = 'committed', committed_at = now(), committed_memory_id = ${updateOf},
                 attempts = ${row.attempts + 1}, last_attempt_at = now()
           WHERE id = ${row.id} AND status = 'pending'`;
        res.recovered += 1;
        recoveredTs.push(row.requested_at);
        continue;
      }

      // P-004 double-write guard: the agent may have successfully re-fired the
      // same fact after the outage — an unmistakable near-dup means the content
      // is already in the store, so close the row pointing at it.
      const neighbors = await backend.search(row.content, { scope: row.scope, limit: 3 })
        .catch(() => []);
      // The backend RETRIEVES the candidates (its score orders them); the
      // duplicate JUDGEMENT is made on the text itself — see
      // DRAIN_DEDUP_THRESHOLD on why a fused score cannot make it (EI-10544).
      // A neighbour with no text cannot be JUDGED a duplicate, so it isn't one:
      // this whole guard is a suppression, and an unjudgeable case must err
      // toward RECOVERING the fact (the drain's entire purpose), never toward
      // silently dropping it.
      const dup = neighbors.find(
        (n) =>
          n.id !== supersedeOf &&
          typeof n.text === 'string' &&
          lexicalSimilarity(row.content, n.text) >= DRAIN_DEDUP_THRESHOLD,
      );
      if (dup) {
        // P-005: the content may already have landed before the live call's
        // validity-close failed. Finish that close before committing the
        // journal row, using the existing row as the replacement id.
        if (supersedeOf) {
          const invalidateEntry = backend.invalidateEntry?.bind(backend);
          if (!invalidateEntry) {
            throw new Error('journal supersede requires validity-window support');
          }
          await invalidateEntry(supersedeOf, { supersededBy: dup.id });
        }
        await sql`
          UPDATE harness_shared.memory_write_journal
             SET status = 'committed', committed_at = now(), committed_memory_id = ${dup.id},
                 attempts = ${row.attempts + 1}, last_attempt_at = now(),
                 last_error = 'deduped_on_drain (content already in store)'
           WHERE id = ${row.id} AND status = 'pending'`;
        res.deduped += 1;
        continue;
      }

      const { ids } = await backend.remember(row.content, {
        scope: row.scope,
        ...(row.kind ? { kind: row.kind } : {}),
        metadata: {
          ...storedMetadata,
          ...(secrets.matched
            ? { possible_secret: true, possible_secret_classes: secrets.classes }
            : {}),
          // P-007 provenance: the fact arrived late via the journal drain, not
          // a live write — memory:list/search surface this to agents/UI.
          recovered_from: 'journal',
          recovered_journal_id: row.id,
        },
        verbatim: row.verbatim,
        ...(typeof row.shareable === 'boolean' ? { shareable: row.shareable } : {}),
      });
      if (supersedeOf) {
        const replacingId = ids[0];
        if (!replacingId) {
          throw new Error('journal supersede write returned no replacement id');
        }
        const invalidateEntry = backend.invalidateEntry?.bind(backend);
        if (!invalidateEntry) {
          throw new Error('journal supersede requires validity-window support');
        }
        await invalidateEntry(supersedeOf, { supersededBy: replacingId });
      }
      await sql`
        UPDATE harness_shared.memory_write_journal
           SET status = 'committed', committed_at = now(), committed_memory_id = ${ids[0] ?? null},
               attempts = ${row.attempts + 1}, last_attempt_at = now()
         WHERE id = ${row.id} AND status = 'pending'`;
      res.recovered += 1;
      recoveredTs.push(row.requested_at);
    } catch (err) {
      const attempts = row.attempts + 1;
      const exhausted = attempts >= MAX_ATTEMPTS;
      await sql`
        UPDATE harness_shared.memory_write_journal
           SET attempts = ${attempts}, last_attempt_at = now(),
               last_error = ${String((err as Error)?.message ?? err).slice(0, 500)},
               status = ${exhausted ? 'failed_permanent' : 'pending'}
         WHERE id = ${row.id} AND status = 'pending'`.catch(warnOnce);
      if (exhausted) res.retriesExhausted += 1;
      else res.stillPending += 1;
    }
  }

  if (recoveredTs.length > 0) {
    const sorted = [...recoveredTs].sort();
    res.recoveredWindow = { from: sorted[0], to: sorted[sorted.length - 1] };
  }
  return res;
}
