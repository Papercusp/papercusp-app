/**
 * Git-export capture (plan harness-state-storage-unification-2026-06-01, P-003b).
 *
 * A DEDICATED outbox + capture trigger for `sync:'git'` tables, intentionally
 * separate from the Model-B `substrate_outbox` + its drainer (D-004): adding
 * git tables to that shared outbox would feed them to the peer-log drainer
 * (which appends everything to the Hyperbee log). A separate `git_export_outbox`
 * keeps the new path fully additive — it touches none of the Model-B substrate.
 *
 * Mirrors `capture_substrate_outbox` (ensure-schema-dogfood.ts): AFTER row
 * trigger, echo-loop guard on `origin`, key extracted via the trigger arg.
 */
import type postgres from 'postgres';
import { GIT_TABLES } from '../table-registry';

/**
 * File-key columns per git table — the real PK MINUS `workspace_id`/`harness_slug`
 * (those are implied by which harness's `.papercusp/state/` the file lives in).
 * Verified against the live `harness_shared` PKs (2026-06-01). Composite keys
 * are composed into one leaf with `__`. Unknown tables default to `['id']`.
 */
export const GIT_KEY_COLS: Record<string, string[]> = {
  harness_decisions: ['line_hash'],
  // harness_summaries removed — fs-watcher-retirement step 2 (migration 280).
  harness_escalations: ['phase'],
  harness_design_artifacts: ['id'],
  harness_text_artifacts: ['rel_path'],
  harness_chunk_plans: ['feature_id', 'chunk_id'],
  harness_feature_notes: ['feature_id'],
  harness_feature_debug_notes: ['feature_id'],
  feature_audit_consolidated: ['id'],
  harness_tests: ['phase', 'test_id'],
  // harness_phases removed — fs-watcher-retirement step 5 (migration 285).
  harness_promotions: ['promotion_id'],
  harness_checkpoints: ['name'],
  harness_snapshots: ['snapshot_id'],
  harness_skills: ['name'],
  // `goals` + `project_spec_revisions` removed with their GIT_DOCS entries (EI-10521):
  // neither is harness-scoped, so neither can git-export. Key cols here for a table the
  // registry doesn't git-sync are dead weight that reads as intent.
  harness_proposals_shared: ['phase', 'proposal_id'],
  snapshot_features: ['snapshot_id', 'feature_id'],
};

export function gitKeyCols(table: string): string[] {
  return GIT_KEY_COLS[table] ?? ['id'];
}

/** Ensure the dedicated git-export outbox table + capture function (idempotent). */
export async function ensureGitExportOutbox(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.git_export_outbox (
      id           BIGSERIAL PRIMARY KEY,
      workspace_id TEXT   NOT NULL,
      harness_slug TEXT   NOT NULL,
      table_name   TEXT   NOT NULL,
      op           TEXT   NOT NULL CHECK (op IN ('put','del')),
      key          TEXT   NOT NULL,
      row          JSONB,
      ts           BIGINT NOT NULL,
      exported_at  BIGINT
    );
    CREATE INDEX IF NOT EXISTS git_export_outbox_drain_idx
      ON harness_shared.git_export_outbox (workspace_id, harness_slug, exported_at, id);
  `);
  await sql.unsafe(`
    CREATE OR REPLACE FUNCTION harness_shared.capture_git_export_outbox()
    RETURNS TRIGGER AS $body$
    DECLARE
      v_op TEXT; v_rec RECORD; v_row JSONB; v_key TEXT; v_ws TEXT; v_slug TEXT;
      i INT;
    BEGIN
      -- no-op guard (re-upsert amplification): an UPDATE that changes nothing
      -- must not enqueue an export. Without this a heartbeat re-upsert of an
      -- unchanged row would churn a file forever (see harness-state federation
      -- lesson / the harness_branch_actions P-003b incident).
      IF (TG_OP = 'UPDATE' AND to_jsonb(OLD) IS NOT DISTINCT FROM to_jsonb(NEW)) THEN
        RETURN NEW;
      END IF;
      IF (TG_OP = 'DELETE') THEN v_op := 'del'; v_rec := OLD;
      ELSE v_op := 'put'; v_rec := NEW; END IF;
      v_row := to_jsonb(v_rec);
      -- echo-loop guard: skip remote-origin writes (hydrate/projection writes).
      IF COALESCE(v_row ->> 'origin', 'local') <> 'local' THEN RETURN v_rec; END IF;
      -- compose the file key from the variadic key columns (PK minus
      -- workspace_id/harness_slug), joined with '__' for composite keys.
      v_key := '';
      FOR i IN 0 .. TG_NARGS - 1 LOOP
        v_key := v_key || (CASE WHEN i > 0 THEN '__' ELSE '' END) || COALESCE(v_row ->> TG_ARGV[i], '');
      END LOOP;
      v_ws   := COALESCE(v_row ->> 'workspace_id', '');
      v_slug := v_row ->> 'harness_slug';
      -- Unroutable → export NOTHING, but never break the caller's write (EI-10521).
      -- git_export_outbox.harness_slug is NOT NULL, so a table with no harness_slug
      -- column (or a NULL one) used to raise here and ABORT the INSERT/UPDATE that
      -- fired the trigger: goals + project_spec_revisions were git-registered without
      -- a harness scope and every write to them failed ("null value in column
      -- harness_slug"), exactly as the llm_test_* tables did before them. A missed
      -- export is a bug; a core write path that always throws is an outage. Mirrors
      -- capture_work_items_outbox, which already refuses to enqueue an unroutable op.
      -- The registry is still the fix (an unroutable git table is a misclassification
      -- — see GIT_DOCS / git-export-slug-coverage); this is the seatbelt.
      IF v_slug IS NULL OR v_slug = '' THEN RETURN v_rec; END IF;
      INSERT INTO harness_shared.git_export_outbox
        (workspace_id, harness_slug, table_name, op, key, row, ts)
      VALUES (v_ws, v_slug, TG_TABLE_NAME, v_op, v_key, v_row,
              (extract(epoch from now())*1000)::bigint);
      PERFORM pg_notify('git_export_outbox', v_ws || '::' || v_slug);
      RETURN v_rec;
    END;
    $body$ LANGUAGE plpgsql;
  `);
}

/** Attach the git-export capture trigger to one table (idempotent). */
export async function attachGitCaptureTrigger(
  sql: postgres.Sql,
  table: string,
  keyCols: string[] = gitKeyCols(table),
): Promise<void> {
  const args = keyCols.map((c) => `'${c.replace(/'/g, "''")}'`).join(', ');
  await sql.unsafe(
    `CREATE OR REPLACE TRIGGER capture_git_export_outbox_trg ` +
      `AFTER INSERT OR UPDATE OR DELETE ON harness_shared.${table} ` +
      `FOR EACH ROW EXECUTE FUNCTION harness_shared.capture_git_export_outbox(${args})`,
  );
}

/**
 * Attach the capture trigger to every harness_shared `sync:'git'` table.
 * Tables that don't exist on this install (or aren't in harness_shared, e.g.
 * the papercusp_shared document tables) are skipped, not fatal.
 */
export async function attachAllGitCaptureTriggers(
  sql: postgres.Sql,
): Promise<{ attached: string[]; skipped: string[] }> {
  const attached: string[] = [];
  const skipped: string[] = [];
  for (const t of GIT_TABLES) {
    try {
      await attachGitCaptureTrigger(sql, t);
      attached.push(t);
    } catch {
      skipped.push(t); // not present / not in harness_shared on this install
    }
  }
  return { attached, skipped };
}

/**
 * Reconcile: DROP the capture trigger from any `harness_shared` table that
 * carries it but is NO LONGER in `GIT_TABLES`. Makes the registry the single
 * authority for which tables git-export — when a table is removed from
 * GIT_DOCS (e.g. an fs-mirror reclassified to sync:none), its live trigger is
 * cleaned up on the next boot instead of churning indefinitely. Idempotent.
 */
export async function detachStaleGitCaptureTriggers(
  sql: postgres.Sql,
): Promise<{ detached: string[] }> {
  const want = new Set(GIT_TABLES.map((t) => (t.includes('.') ? t.slice(t.indexOf('.') + 1) : t)));
  const rows = await sql<{ tbl: string }[]>`
    SELECT c.relname AS tbl
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'harness_shared'
       AND t.tgname = 'capture_git_export_outbox_trg'
       AND NOT t.tgisinternal`;
  const detached: string[] = [];
  for (const { tbl } of rows) {
    if (want.has(tbl)) continue;
    await sql.unsafe(
      `DROP TRIGGER IF EXISTS capture_git_export_outbox_trg ON harness_shared.${tbl}`,
    );
    detached.push(tbl);
  }
  return { detached };
}
