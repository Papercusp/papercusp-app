/**
 * Per-key cooldown marks (PG, migration 032).
 *
 * Replaces module-scoped `Map<string, number>` patterns where the value
 * is "the last time something happened". The TTL/cooldown logic stays
 * in the caller; this module only stores the timestamp.
 *
 * Namespace keys yourself: `'el-mint:' + agentId`, `'voice-test:' + workspace`, …
 *
 * Not in zero_harness publication — internal cooldown ledger.
 */

import { getOrgPg, generated } from '@papercusp/db-org';
import { eq, sql } from 'drizzle-orm';

const t = generated.cooldownMarksInHarnessShared;

/**
 * Read the most-recent mark for `key`, or null if none. Caller subtracts
 * from `Date.now()` to compute "ms since last mark".
 */
export async function readCooldownMark(key: string): Promise<number | null> {
  const { db } = getOrgPg();
  const rows = await db
    .select({ marked_at_ms: t.markedAtMs })
    .from(t)
    .where(eq(t.key, key))
    .limit(1);
  return rows.length > 0 ? Number(rows[0].marked_at_ms) : null;
}

/** Stamp `key` with the current time. */
export async function writeCooldownMark(key: string, markedAtMs: number = Date.now()): Promise<void> {
  const { db } = getOrgPg();
  await db
    .insert(t)
    .values({ key, markedAtMs: markedAtMs, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: t.key,
      set: {
        markedAtMs: sql`EXCLUDED.marked_at_ms`,
        updatedAt: sql`EXCLUDED.updated_at`,
      },
    });
}
