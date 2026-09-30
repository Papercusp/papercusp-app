/**
 * carry-respawn-marker.ts — tell the SessionEnd/Stop lease-release fast path
 * (session-death-claim-release-2026-07-11 P-002) that an ending owner's
 * process is about to come back as the SAME logical agent, not die.
 *
 * ROOT CAUSE (EI-18676518990229124, evidenced live 2026-07-25): a carry-respawn
 * (`session:request-compaction` — deterministic-context-carry P-018/P-022)
 * KILLS the CLI child and relaunches it in the same pane under the SAME
 * `ownerId` seconds later. The killed child still fires the ordinary
 * SessionEnd/Stop lifecycle hook (`lifecycle-report.sh` → `activity:report`),
 * and `report.ts`'s P-002 branch treats EVERY SessionEnd as "this owner's
 * session just ended" / "this owner is confirmed dead" (its own doc comment,
 * work-item-lease-release.ts) — so it force-releases every work-item lease and
 * coordination claim the owner holds, UNCONDITIONALLY, via
 * `releaseAllWorkItemLeasesForOwner`. For a real death that is exactly right
 * (the P-001 backstop otherwise waits ~hourly). For a carry-respawn it is
 * wrong: the SAME owner resumes within ~1-2s (confirmed live: "■ session
 * ended" at 22:37:46.909, "▶ session started" at 22:37:48.321, same
 * `owner_id`) holding claims that just evaporated out from under it with no
 * notification — the exact 4x-in-45-minutes symptom the filer reported.
 *
 * Fix: `session:request-compaction` (the ONE place that both knows a
 * same-owner respawn is coming AND triggers the kill) marks the owner
 * "respawn expected" the instant its `injectIntoHost` call succeeds — BEFORE
 * the old process's SessionEnd hook can fire. `report.ts`'s P-002 branch
 * consumes (checks-and-clears) the marker first; when present, it skips the
 * force-release entirely (the successor keeps holding exactly what it held)
 * instead of stripping and silently orphaning the claim.
 *
 * WHY THIS IS PG-BACKED AND NOT A MODULE-SCOPED Map (WI-6756 follow-on,
 * evidenced live 2026-08-02): this module previously kept the mark in an
 * in-memory `Map`, explicitly justified because request-compaction's
 * `injectIntoHost` and the subsequent SessionEnd `activity:report` "both
 * execute in-process on the SAME operator". That premise is FALSE on a
 * clustered operator. `hono-host.ts`'s P3-2 cluster mode forks N request-only
 * WORKERS that share :3070 via cluster round-robin, so the two calls routinely
 * land on DIFFERENT workers: the mark is written to worker A's heap and worker
 * B — which handles the SessionEnd — sees nothing and releases everything.
 * Measured on this box: the release operator (pid 2250178) had 16 worker
 * children, and su-e02f5c3d lost all three of its claims
 * (WI-5135, WI-6756, WI-3965) to a self-compaction at 02:07:20Z whose
 * SessionEnd landed on a sibling worker. The failure is a round-robin race, so
 * it presents as "works sometimes" — which is why the in-memory version
 * survived review and its own passing unit tests.
 *
 * This is the SAME correction {@link ./session-reset-continuation} already made
 * for the OTHER trigger in this bug class (a cold loop wake, where the writer
 * is papercup-bg-host and the reader papercup-dev-api — a cross-SERVICE split
 * rather than a cross-worker one). That leg could read the wake pipeline's
 * existing `event_wake_deliveries` ledger; a carry-respawn inject writes no
 * such row, so this leg gets its own deliberately tiny table
 * (migration 716, `harness_shared.session_respawn_expected`).
 *
 * Fail-safe by construction, unchanged from the in-memory version:
 *  - the marker is single-use (consumed on read) and short-TTL, so a respawn
 *    that never actually completes (the injected socket write succeeded but the
 *    host never relaunched) still gets its claims freed — just via the P-001
 *    scheduled backstop instead of the P-002 fast path, which is the ORIGINAL
 *    (pre-P-002) coverage for that case, not a new gap;
 *  - every PG failure is swallowed toward TODAY'S behavior: a failed mark or a
 *    failed consume both mean "not a continuation" → the ordinary release runs.
 *    This guard can never strand a claim by failing.
 *
 * Consumption is `DELETE … RETURNING`, so check-and-clear stays atomic ACROSS
 * workers: exactly one reader can observe a given mark, and a genuine death
 * shortly after a completed respawn is never suppressed by a leftover row.
 */

import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';

/** How long a "respawn expected" mark survives before it is treated as stale
 *  and ignored (the respawn either already happened — consumed — or failed,
 *  in which case P-001's backstop sweep is the correct recovery path). */
export const RESPAWN_EXPECTED_TTL_MS = 60_000;

/**
 * Mark `ownerId` as about to be carry-respawned (its imminent SessionEnd is
 * a scheduled continuation, not a death). Call this ONLY once the respawn is
 * actually queued (e.g. after a successful `injectIntoHost`) — marking
 * speculatively would suppress a real death's fast-path release.
 *
 * Never throws: a mark that fails to persist degrades to today's behavior
 * (the successor's claims are released and recovered by the P-001 backstop),
 * which is strictly better than failing the compaction the caller asked for.
 */
export async function markRespawnExpected(
  ownerId: string,
  ttlMs = RESPAWN_EXPECTED_TTL_MS,
  opts: { sql?: Sql } = {},
): Promise<void> {
  if (!ownerId?.trim()) return;
  const ttlSec = Math.max(0, Math.round(Math.max(0, ttlMs) / 1000));
  try {
    const sql = opts.sql ?? getOrgPg().sql;
    await sql`
      WITH marked AS (
        INSERT INTO harness_shared.session_respawn_expected (owner_id, expires_at, reason)
        VALUES (${ownerId}, now() + make_interval(secs => ${ttlSec}), 'carry-respawn')
        ON CONFLICT (owner_id) DO UPDATE
          SET expires_at = EXCLUDED.expires_at,
              created_at = now()
        RETURNING owner_id
      )
      UPDATE harness_shared.coord_presence AS presence
         SET host = '',
             pid = NULL,
             tty = NULL,
             context_tokens = NULL,
             context_estimated_at = NULL
        FROM marked
       WHERE presence.owner_id = marked.owner_id`;
  } catch (e) {
    console.warn(
      `[carry-respawn-marker] could not mark respawn-expected for ${ownerId} — its SessionEnd will be read as a death and its claims freed by the P-001 backstop: ${
        e instanceof Error ? e.message : e
      }`,
    );
  }
}

/**
 * Check-and-clear: true iff `ownerId` was marked AND the mark hasn't expired.
 * Single-use — a second SessionEnd for the same owner (e.g. a genuine death
 * shortly after a completed respawn) is never suppressed by a stale mark.
 *
 * Never throws: on a PG failure this reports `false`, i.e. "treat it as a real
 * session end", which is exactly the pre-guard behavior.
 */
export async function consumeRespawnExpected(
  ownerId: string,
  opts: { sql?: Sql; nowMs?: number } = {},
): Promise<boolean> {
  if (!ownerId?.trim()) return false;
  try {
    const sql = opts.sql ?? getOrgPg().sql;
    // DELETE … RETURNING: atomic across workers, so the mark is consumed by
    // exactly one reader. Expiry is judged on the returned row rather than
    // filtered in the WHERE clause, so an EXPIRED mark is still cleaned up here
    // instead of lingering until a sweep.
    const rows = await sql<Array<{ expires_at: Date }>>`
      DELETE FROM harness_shared.session_respawn_expected
       WHERE owner_id = ${ownerId}
      RETURNING expires_at`;
    const row = rows[0];
    if (!row) return false;
    const expiresAt = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
    return expiresAt.getTime() >= (opts.nowMs ?? Date.now());
  } catch (e) {
    console.warn(
      `[carry-respawn-marker] respawn-expected check for ${ownerId} failed, treating as a real session end: ${
        e instanceof Error ? e.message : e
      }`,
    );
    return false;
  }
}

/** Test-only: drop every mark (isolate suites that share this table). */
export async function __resetRespawnExpectedMarkers(opts: { sql?: Sql } = {}): Promise<void> {
  try {
    const sql = opts.sql ?? getOrgPg().sql;
    await sql`DELETE FROM harness_shared.session_respawn_expected`;
  } catch {
    // best-effort test helper
  }
}
