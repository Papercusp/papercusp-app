/**
 * User-facing surfacing for the memory write-ahead journal
 * (memory-write-journal-auto-recovery-2026-07-11 P-006).
 *
 * Three surfaces, all driven from here:
 *  - the live "N memories pending embedding" badge on the Memory settings
 *    page (the `userMemory.journalStatus` sync resolver reads
 *    `journalStatusSnapshot`);
 *  - the post-drain "Memory recovered: N facts from HH:MM–HH:MM are now
 *    searchable" banner (same resolver — `lastRecovery`);
 *  - the live-refresh push: the drain fires `notifySyncInvalidate` so an
 *    open settings page updates without a manual reload (same mechanism the
 *    memory:* verbs already use, memory-settings-page-refresh P-007/P-008).
 */

import { getOrgPg } from '@papercusp/db-org';
import type { DrainResult } from './write-journal';

export interface JournalStatusSnapshot {
  /** Rows parked and awaiting replay — the badge count. */
  pending: number;
  /** Rows whose retries are exhausted — surfaced, never silently dropped. */
  failedPermanent: number;
  /**
   * Drain recoveries in the last 24h (attempts>=1 ⇒ recovered by the drain,
   * not closed by the live write path; dedup closures excluded — the banner
   * reports facts that genuinely arrived late).
   */
  lastRecovery: { count: number; from: string; to: string; lastAt: string } | null;
}

export async function journalStatusSnapshot(): Promise<JournalStatusSnapshot> {
  const { sql } = getOrgPg();
  const [counts] = await sql<{ pending: string; failed: string }[]>`
    SELECT count(*) FILTER (WHERE status = 'pending')::text          AS pending,
           count(*) FILTER (WHERE status = 'failed_permanent')::text AS failed
      FROM harness_shared.memory_write_journal`;
  const [rec] = await sql<{ n: string; f: string | null; t: string | null; at: string | null }[]>`
    SELECT count(*)::text AS n, min(requested_at)::text AS f,
           max(requested_at)::text AS t, max(committed_at)::text AS at
      FROM harness_shared.memory_write_journal
     WHERE status = 'committed'
       AND attempts >= 1
       AND (last_error IS NULL OR last_error NOT LIKE 'deduped%')
       AND committed_at > now() - interval '24 hours'`;
  return {
    pending: Number(counts?.pending ?? 0),
    failedPermanent: Number(counts?.failed ?? 0),
    lastRecovery:
      rec && Number(rec.n) > 0 && rec.f && rec.t && rec.at
        ? { count: Number(rec.n), from: rec.f, to: rec.t, lastAt: rec.at }
        : null,
  };
}

/**
 * Post-drain push (called from the embed-backfill tick when the drain
 * recovered/closed anything): refresh both the memory row set and the
 * journal status so an open Memory page shows the recovered facts and the
 * banner immediately. Best-effort — surfacing must never fail the drain.
 */
export async function notifyJournalRecovery(r: DrainResult): Promise<void> {
  try {
    const { notifySyncInvalidate } = await import('../sync-sse');
    const { invalidateUserMemoryViews } = await import('./invalidate-user-memory-views');
    // Both are deliberately FIRE-AND-FORGET (surfacing must not block the drain), which is
    // exactly why each needs its OWN `.catch`: a detached promise's rejection never reaches
    // the enclosing try/catch below — it surfaces as an unhandled rejection instead, which
    // fails the whole test lane while every assertion in this file still passes.
    void invalidateUserMemoryViews().catch(() => { /* best-effort */ });
    // Kept a SYNCHRONOUS call (the caller's contract, and what the tests assert has happened
    // by the time this resolves) — only the rejection handling is added. `?.` because a
    // stubbed/uninitialised bus can hand back a non-promise; a SYNC throw stays absorbed by
    // the try/catch below, which is the pre-existing, tested behaviour.
    void notifySyncInvalidate('userMemory.journalStatus')?.catch(() => { /* best-effort */ });
    if (r.recovered > 0 && r.recoveredWindow) {
      console.log(
        `[memory-journal] Memory recovered: ${r.recovered} fact(s) from ` +
          `${r.recoveredWindow.from} – ${r.recoveredWindow.to} are now searchable`,
      );
    }
  } catch {
    // best-effort
  }
}
