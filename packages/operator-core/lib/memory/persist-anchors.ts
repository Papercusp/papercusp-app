/**
 * Persist memory anchors to harness_shared.memory_anchors.
 *
 * Plan: papercusp-su-memory-2026-05-25 (Phase 4 P-015 — follow-up).
 *
 * P-015 originally shipped only the metadata.anchors[] write into
 * mem0's payload (apps/operator/lib/agent-tools/memory/remember.ts).
 * The dedicated `harness_shared.memory_anchors` table (migration 085)
 * was committed as substrate but no write path populated it — leaving
 * the Layer 1 audit (P-019), the settings-UI status badges (P-022),
 * and the Audit-all button (P-023) functionally dormant. This module
 * closes that gap.
 *
 * Called from remember.ts after mem0's client.add() succeeds. The
 * mem0 result contains a results[] array; each entry with event=ADD
 * is a freshly-inserted memory_canonical row. For each ADD row, we
 * INSERT one memory_anchors row per anchor extracted by P-014.
 *
 * Best-effort:
 *   - column-missing / table-missing → cached as no-op for rest of
 *     process lifetime (migration 085 not yet applied)
 *   - transient PG errors → swallowed, never block the write path
 *   - mem0-side schema drift → unknown event kinds ignored
 *
 * The write itself is `ON CONFLICT DO NOTHING` (the PK is composite
 * memory_id+kind+value) so idempotent retries are safe and rapid
 * re-writes via the same memory_id don't error.
 */

import type { Anchor } from './anchors';

// `values` is `any[]` (not `unknown[]`) so the real postgres-js `Sql`
// handle from `getOrgPg().sql` is assignable here — its tagged-template
// parameters are a constrained `ParameterOrFragment[]`, which a
// `unknown[]` contravariantly rejects. Callers only ever pass `${...}`
// interpolations, so the looseness is confined to this seam type.
export type SqlTag = <T = unknown>(
  template: TemplateStringsArray,
  ...values: any[]
) => Promise<T>;

let tableMissing = false;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Persist anchors for one memory_id. Caller passes the
 * postgres-js sql template tag from `getOrgPg().sql`.
 *
 * Returns true when the INSERT ran (or there was nothing to do);
 * false on first-time table-missing detection.
 */
export async function persistAnchorsSql(
  sql: SqlTag,
  memoryId: string,
  anchors: Anchor[],
): Promise<boolean> {
  if (anchors.length === 0) return true;
  if (tableMissing) return false;
  if (!UUID_RE.test(memoryId)) return true; // bad id — nothing to persist

  // Build parallel arrays for the unnest INSERT — one row per anchor.
  const kinds = anchors.map((a) => a.kind);
  const values = anchors.map((a) => a.value);

  try {
    await sql`
      INSERT INTO harness_shared.memory_anchors (memory_id, kind, value)
      SELECT ${memoryId}::uuid, k, v
      FROM unnest(${kinds}::text[], ${values}::text[]) AS t(k, v)
      ON CONFLICT (memory_id, kind, value) DO NOTHING
    `;
    return true;
  } catch (err) {
    const msg = (err as Error)?.message ?? '';
    if (
      /relation .* does not exist/.test(msg) ||
      msg.includes('memory_anchors')
    ) {
      tableMissing = true;
    }
    return false;
  }
}

// NOTE: extractAddedIds (mem0 add-result parsing) moved behind the
// Mem0Backend in @papercusp/memory (generalize-memory-backend-swappable
// D-002) — `MemoryBackend.remember` now returns the added ids directly.

/** Test hook: reset the table-missing cache. */
export function _resetForTests(): void {
  tableMissing = false;
}
