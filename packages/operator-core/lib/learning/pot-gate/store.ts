/**
 * Learning pot scope STORE — SQL over migration 1039
 * (harness_shared.learning_pot_scope), plan learning-pot-scope-gate-2026-08-30
 * P-001 / D-001.
 *
 * Helpers take an injected `Sql` (the live operator admin pool), control-plane
 * style, so the routine-action glue, the agent tool, and the tests share one
 * core — the same split learning-governor/store.ts uses. Decisions live in the
 * dependency-free ./core.ts; this file is only the queries.
 *
 * Read shapes, all of them:
 *   - potLearningEnabled   one pot, one preflight  (P-002 / P-003 / P-004)
 *   - listPotLearningScope every stored row        (the picker)
 *   - potScopeResolver     a batch predicate       (P-003 pool filter, P-005 UI)
 *
 * Write shape, exactly one: setPotLearningScope, which takes an ARRAY of pots.
 * The picker's bulk footer must be ONE statement rather than N racing upserts,
 * and a single write is also one audit event instead of a burst.
 */
import type { Sql, TransactionSql } from 'postgres';
import { potScopeEnabled, potScopeLookup, type PotLearningScope } from './core';

type Row = Record<string, unknown>;

/** Postgres `undefined_table` — the relation is not there (migration 1039 unapplied). */
const UNDEFINED_TABLE = '42P01';

let warnedMissingRelation = false;

function isMissingRelation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === UNDEFINED_TABLE;
}

/**
 * FAIL OPEN on a missing relation, and ONLY on a missing relation.
 *
 * Deliberately narrow: a substrate that has not applied migration 1039 yet (a
 * fresh embedded-pg, a release mid-rollout) must not have every learning lane
 * refuse — the gate's whole posture is that an unreadable pot row is not an
 * outage. Every OTHER error still throws, because a connection fault or a
 * permission error is a real problem the caller needs to see rather than a
 * silently-enabled pot.
 */
async function failOpenOnMissingRelation<T>(
  sql: Sql,
  run: (sql: Sql) => Promise<T>,
  fallback: T,
  what: string,
): Promise<T> {
  try {
    // A caught query error still aborts a PostgreSQL transaction. Roll back
    // the read's savepoint BEFORE applying the missing-relation fallback, so
    // the caller can continue its reservation or other transactional work.
    const transaction = sql as Sql & Partial<Pick<TransactionSql, 'savepoint'>>;
    return typeof transaction.savepoint === 'function'
      ? await transaction.savepoint(tx => run(tx as unknown as Sql)) as T
      : await run(sql);
  } catch (err) {
    if (!isMissingRelation(err)) throw err;
    if (!warnedMissingRelation) {
      warnedMissingRelation = true;
      console.warn(
        `[learning-pot-scope] harness_shared.learning_pot_scope is missing — ${what} is answering fail-OPEN ` +
          '(every pot enabled) until migration 1039 is applied.',
      );
    }
    return fallback;
  }
}

function mapRow(r: Row): PotLearningScope {
  return {
    workspaceId: String(r.workspace_id),
    potSlug: String(r.pot_slug),
    enabled: r.enabled === true || r.enabled === 't',
    setBy: r.set_by === null || r.set_by === undefined ? null : String(r.set_by),
    setAt: new Date(r.set_at as string | Date).getTime(),
    // Migration 1271 columns. A row read from a DB that has not applied 1271 yet
    // (fail-open window, or an older fixture) simply lacks them: read as "no
    // recorded provenance" rather than crashing the preflight.
    pauseReason:
      r.pause_reason === null || r.pause_reason === undefined ? null : String(r.pause_reason),
    ownerDirected: r.owner_directed === true || r.owner_directed === 't',
    reviewBy:
      r.review_by === null || r.review_by === undefined
        ? null
        : new Date(r.review_by as string | Date).getTime(),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** One stored row, or null when the pot has never been flipped (⇒ enabled). */
export async function getPotLearningScope(
  sql: Sql,
  q: { workspaceId: string; potSlug: string },
): Promise<PotLearningScope | null> {
  return failOpenOnMissingRelation(
    sql,
    async sql => {
      const rows = (await sql`
        SELECT * FROM harness_shared.learning_pot_scope
         WHERE workspace_id = ${q.workspaceId} AND pot_slug = ${q.potSlug}`) as Row[];
      return rows.length > 0 ? mapRow(rows[0]) : null;
    },
    null,
    'getPotLearningScope',
  );
}

/**
 * THE preflight predicate — may learning run for this pot at all?
 * Absent row = TRUE (plan R-5). Callers AND this with their own arming.
 */
export async function potLearningEnabled(
  sql: Sql,
  q: { workspaceId: string; potSlug: string },
): Promise<boolean> {
  return potScopeEnabled(await getPotLearningScope(sql, q));
}

/** Every stored row in the workspace, newest flip first — the picker's read. */
export async function listPotLearningScope(
  sql: Sql,
  q: { workspaceId: string },
): Promise<PotLearningScope[]> {
  return failOpenOnMissingRelation(
    sql,
    async sql => {
      const rows = (await sql`
        SELECT * FROM harness_shared.learning_pot_scope
         WHERE workspace_id = ${q.workspaceId}
         ORDER BY set_at DESC, pot_slug ASC`) as Row[];
      return rows.map(mapRow);
    },
    [],
    'listPotLearningScope',
  );
}

/**
 * The pots that are switched OFF. Hits the partial index the migration ships,
 * and is the cheap read for the rail's count — the enabled set is answered by
 * absence, so there is nothing else to materialize.
 */
export async function disabledPotSlugs(sql: Sql, q: { workspaceId: string }): Promise<string[]> {
  return failOpenOnMissingRelation(
    sql,
    async sql => {
      const rows = (await sql`
        SELECT pot_slug FROM harness_shared.learning_pot_scope
         WHERE workspace_id = ${q.workspaceId} AND enabled = false
         ORDER BY pot_slug ASC`) as Row[];
      return rows.map((r) => String(r.pot_slug));
    },
    [],
    'disabledPotSlugs',
  );
}

/**
 * One query, then a synchronous predicate for any number of pots — for a caller
 * that resolves a whole pool in a tick (P-003's round-robin filter) or renders
 * a list (P-005). Unknown slugs resolve to enabled, same as everywhere else.
 */
export async function potScopeResolver(
  sql: Sql,
  q: { workspaceId: string },
): Promise<(potSlug: string) => boolean> {
  return potScopeLookup(await listPotLearningScope(sql, q));
}

// ---------------------------------------------------------------------------
// Write — exactly one, and it is batched
// ---------------------------------------------------------------------------

export interface SetPotLearningScopeInput {
  workspaceId: string;
  /** One or many pots. The picker's bulk footer passes the whole selection. */
  potSlugs: readonly string[];
  enabled: boolean;
  /** ownerId or human identity, stamped as the audit trail. Bare identity — never a provenance suffix. */
  setBy: string | null;
  /**
   * Structured deliberate-pause provenance (migration 1271, WI-10002099). Only
   * meaningful for `enabled:false`; ignored (and cleared) when enabling, so a
   * re-enabled pot can never keep a stale "owner directive" stamp.
   */
  pauseReason?: string | null;
  /** The pause is the OWNER's standing decision. Requires `pauseReason` — refused otherwise. */
  ownerDirected?: boolean;
  /** When the pause should be re-examined. Date or epoch ms; null/undefined = never. */
  reviewBy?: Date | number | null;
}

/** Normalised pause provenance for one write. Throws on a claim the DB would refuse anyway. */
export function normalizePauseProvenance(q: {
  enabled: boolean;
  pauseReason?: string | null;
  ownerDirected?: boolean;
  reviewBy?: Date | number | null;
}): { pauseReason: string | null; ownerDirected: boolean; reviewBy: Date | null } {
  // Enabling clears the record: it describes a pause, and there is no pause now.
  if (q.enabled) return { pauseReason: null, ownerDirected: false, reviewBy: null };
  const reason = typeof q.pauseReason === 'string' ? q.pauseReason.trim() : '';
  const ownerDirected = q.ownerDirected === true;
  if (ownerDirected && reason.length === 0) {
    throw new Error(
      'ownerDirected:true requires a non-empty pauseReason — cite the owner directive (id/date) or work-item, ' +
        'so the claim is inspectable instead of a bare assertion of authority.',
    );
  }
  let reviewBy: Date | null = null;
  if (q.reviewBy !== null && q.reviewBy !== undefined) {
    reviewBy = q.reviewBy instanceof Date ? q.reviewBy : new Date(q.reviewBy);
    if (Number.isNaN(reviewBy.getTime())) throw new Error('reviewBy is not a valid date');
  }
  return { pauseReason: reason.length > 0 ? reason : null, ownerDirected, reviewBy };
}

/**
 * Flip the gate for one or many pots in ONE statement.
 *
 * Writes a row in both directions rather than deleting on enable: `set_by` /
 * `set_at` are the audit trail of who turned a pot back ON, which a delete
 * would erase. An `enabled:true` row and an absent row mean the same thing to
 * every reader, so keeping it costs nothing but the audit record.
 *
 * NEVER touches a lane's own row (gym_autoloop_config, learning_governor_loops,
 * routines.active) — that is the whole point of D-001: the restore is lossless
 * because each lane's arming was never disturbed.
 */
export async function setPotLearningScope(
  sql: Sql,
  q: SetPotLearningScopeInput,
): Promise<PotLearningScope[]> {
  const slugs = [...new Set(q.potSlugs.filter((s) => typeof s === 'string' && s.length > 0))];
  if (slugs.length === 0) return [];
  const pause = normalizePauseProvenance(q);
  const rows = (await sql`
    INSERT INTO harness_shared.learning_pot_scope
      (workspace_id, pot_slug, enabled, set_by, set_at, pause_reason, owner_directed, review_by)
    SELECT ${q.workspaceId}, s, ${q.enabled}, ${q.setBy ?? null}, now(),
           ${pause.pauseReason}, ${pause.ownerDirected}, ${pause.reviewBy}
      FROM unnest(${slugs as string[]}::text[]) AS s
    ON CONFLICT (workspace_id, pot_slug) DO UPDATE
       SET enabled        = EXCLUDED.enabled,
           set_by         = EXCLUDED.set_by,
           set_at         = EXCLUDED.set_at,
           pause_reason   = EXCLUDED.pause_reason,
           owner_directed = EXCLUDED.owner_directed,
           review_by      = EXCLUDED.review_by
    RETURNING *`) as Row[];
  return rows.map(mapRow);
}

/**
 * Remove gate rows entirely — the EXACT inverse of `setPotLearningScope` for a
 * pot that had no row before, which is what a one-call revert of the audited
 * write needs (rewriting `enabled:true` would leave a row the pot never had,
 * and with it a `set_by` stamp naming an actor who did not set it). Reading is
 * unaffected either way: absent and `enabled:true` are the same answer.
 */
export async function clearPotLearningScope(
  sql: Sql,
  q: { workspaceId: string; potSlugs: readonly string[] },
): Promise<{ deleted: number }> {
  const slugs = [...new Set(q.potSlugs.filter((s) => typeof s === 'string' && s.length > 0))];
  if (slugs.length === 0) return { deleted: 0 };
  const rows = (await sql`
    DELETE FROM harness_shared.learning_pot_scope
     WHERE workspace_id = ${q.workspaceId}
       AND pot_slug = ANY(${slugs as string[]}::text[])
    RETURNING pot_slug`) as Row[];
  return { deleted: rows.length };
}
