/**
 * Git-export derived-column policy (EI-19900345996596896).
 *
 * A `vector` column is DERIVED, regenerable, and MODEL-VERSIONED: its width is a
 * property of whichever embedding model was live when the row was written, not of
 * the document the git file represents. Committing one coupled the repo to a model
 * version — and the moment `PROSE_VECTOR_DIMS` moved 384 → 768, every previously
 * committed file became un-hydratable, because pgvector rejects the INSERT with
 * `expected 768 dimensions, not 384`.
 *
 * That was not hypothetical. All 25 committed `harness_escalations` files on this
 * box carried a 384-dim `body_embedding` against a `vector(768)` column, and on
 * every bg-host boot the resulting throw aborted the WHOLE table hydrate for 17/17
 * hives. Each hive then never reached `startGitExportDrain`, leaving 1,166 outbox
 * rows undrained (oldest 2026-06-29) — one stale derived value cost every hive its
 * git-export loop.
 *
 * So vector columns are excluded from git export in BOTH directions:
 *   - the drainer never writes one into a file, and
 *   - hydrate ignores one if a legacy file still carries it.
 *
 * The pair is what removes the need for a data migration: existing files keep their
 * stale vectors harmlessly, and `embed-backfill` regenerates the real ones in PG.
 *
 * ⚠ Membership is anchored to the column's LIVE PG TYPE, never to its NAME. A
 * `%_embedding` name match is exactly the form-blind shape this repo has been burned
 * by three times (CLAUDE.md § shared-lib singletons): it would miss a differently
 * named vector column, and would wrongly strip a `text` column that merely ends in
 * `_embedding`. `udt_name` is the property that actually defines membership.
 */
import type postgres from 'postgres';

/**
 * PG type names (`information_schema.columns.udt_name`) that are derived and must
 * never be git-synced. Keep this the ONLY place the policy is spelled out — both
 * directions read it, so they cannot drift apart.
 */
export const DERIVED_UDT_NAMES: ReadonlySet<string> = new Set(['vector']);

/** True when a column of this PG type is derived state that must not be git-synced. */
export function isDerivedColumnType(udtName: string | null | undefined): boolean {
  return udtName != null && DERIVED_UDT_NAMES.has(udtName);
}

/**
 * The derived (non-git-syncable) columns of one `harness_shared` table, by live
 * schema. Returns an empty set for an unknown table — callers treat that as
 * "nothing to strip", never as an error.
 *
 * No caching on purpose: `hydrate` already reads the schema once per table, and the
 * drainer memoises per drain pass, so a process-lifetime cache would buy nothing and
 * would go stale across a migration that widens or drops a vector column.
 */
export async function loadDerivedColumns(sql: postgres.Sql, table: string): Promise<Set<string>> {
  const rows = await sql<{ column_name: string; udt_name: string }[]>`
    SELECT column_name, udt_name FROM information_schema.columns
     WHERE table_schema = 'harness_shared' AND table_name = ${table}
  `;
  return derivedColumnsFrom(rows);
}

/** Pick the derived columns out of an already-fetched schema read (saves a round-trip). */
export function derivedColumnsFrom(
  cols: readonly { column_name: string; udt_name?: string | null }[],
): Set<string> {
  const out = new Set<string>();
  for (const c of cols) {
    if (isDerivedColumnType(c.udt_name)) out.add(c.column_name);
  }
  return out;
}

/**
 * A shallow copy of `row` without its derived columns. Returns the SAME object when
 * there is nothing to strip, so the common path allocates nothing.
 */
export function stripDerivedCols(
  row: Record<string, unknown>,
  derived: ReadonlySet<string>,
): Record<string, unknown> {
  if (derived.size === 0) return row;
  let hit = false;
  for (const k of Object.keys(row)) {
    if (derived.has(k)) {
      hit = true;
      break;
    }
  }
  if (!hit) return row;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!derived.has(k)) out[k] = v;
  }
  return out;
}
