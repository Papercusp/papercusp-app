/**
 * Git-export boot orchestration (plan harness-state-storage-unification-2026-06-01, P-003b).
 *
 * LIVE-VERIFIED on the host boot (2026-06-02). Every LEAF (ensureGitExportOutbox
 * / detachStaleGitCaptureTriggers / attachAllGitCaptureTriggers / hydrateGitTable
 * / startGitExportDrain) is unit/integration-tested against a testcontainer PG,
 * and this orchestration ran end-to-end on the dev host (15 harnesses). The live
 * boot caught a real bug — an fs-mirror (`harness_branch_actions`) misclassified
 * sync:'git' drained in a hot loop; fixed by removing it from GIT_TABLES + the
 * detach-stale reconciliation here. See the plan's Now + D-004.
 *
 * Boots git-export across the workspaces' harnesses:
 *   1. once per DB: ensure the git_export_outbox + reconcile capture triggers on
 *      the sync:'git' tables (attach current set, drop stale) + introspect their
 *      full PKs (hydrate ON CONFLICT);
 *   2. per harness: hydrate each git table from `.papercusp/state/` (clone-and-go),
 *      then start its autonomous drain loop (PG→file on local writes).
 */
import type postgres from 'postgres';
import { GIT_TABLES } from '../table-registry';
import { bareTable } from './serialize';
import {
  ensureGitExportOutbox,
  attachAllGitCaptureTriggers,
  detachStaleGitCaptureTriggers,
} from './ensure-git-outbox';
import { hydrateGitTable } from './hydrate';
import { startGitExportDrain, type GitExportDrainHandle } from './drainer';
import { makeDebouncedGitCommitter } from './git-committer';
import { gcOrphanOutboxRows } from './gc';

export interface GitExportGlobals {
  /** git tables whose capture trigger attached successfully on this install. */
  attached: string[];
  /** tables whose stale capture trigger was dropped (no longer in GIT_TABLES). */
  detached: string[];
  /** full PK columns per table — the hydrate ON CONFLICT target. */
  pkByTable: Map<string, string[]>;
}

export interface HarnessRef {
  workspaceId: string;
  harnessSlug: string;
  /** on-disk harness root (where `.papercusp/state/` lives) — registry ProjectEntry.path. */
  harnessRoot: string;
}

/** Introspect the full PK columns for each harness_shared git table. */
export async function loadGitTablePks(sql: postgres.Sql): Promise<Map<string, string[]>> {
  const bare = GIT_TABLES.map(bareTable);
  const rows = await sql<{ tbl: string; pk_cols: string }[]>`
    SELECT t.relname AS tbl,
           string_agg(a.attname, ',' ORDER BY array_position(c.conkey, a.attnum)) AS pk_cols
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
     WHERE c.contype = 'p' AND n.nspname = 'harness_shared' AND t.relname::text = ANY (${bare})
     GROUP BY t.relname`;
  const m = new Map<string, string[]>();
  for (const r of rows) m.set(r.tbl, r.pk_cols.split(','));
  return m;
}

/** Once per DB: ensure the outbox + reconcile capture triggers + load PKs. */
export async function attachGitExportGlobals(sql: postgres.Sql): Promise<GitExportGlobals> {
  await ensureGitExportOutbox(sql);
  // Drop triggers for tables removed from GIT_TABLES BEFORE attaching the
  // current set, so a reclassified table (e.g. an fs-mirror) stops churning.
  const { detached } = await detachStaleGitCaptureTriggers(sql);
  const { attached } = await attachAllGitCaptureTriggers(sql);
  const pkByTable = await loadGitTablePks(sql);
  return { attached, detached, pkByTable };
}

export interface BootGitExportHarnessOpts extends HarnessRef {
  sql: postgres.Sql;
  globals: GitExportGlobals;
  onChanged?: (paths: string[]) => void | Promise<void>;
}

/** Per harness: hydrate each git table from files, then start the drain loop. */
export async function bootGitExportForHarness(opts: BootGitExportHarnessOpts): Promise<GitExportDrainHandle> {
  const { sql, workspaceId, harnessSlug, harnessRoot, globals, onChanged } = opts;
  for (const table of globals.attached) {
    const conflictCols = globals.pkByTable.get(table);
    if (!conflictCols || conflictCols.length === 0) continue;
    await hydrateGitTable({ sql, harnessRoot, table, conflictCols, workspaceId, harnessSlug });
  }
  return startGitExportDrain({ sql, workspaceId, harnessSlug, harnessRoot, onChanged });
}

export interface BootGitExportResult {
  globals: GitExportGlobals;
  handles: GitExportDrainHandle[];
  harnesses: number;
  /** P-008: orphan outbox rows GC'd (from ephemeral / non-registry harnesses). */
  gcDeleted: number;
}

/**
 * Boot git-export for a resolved set of harnesses. The caller (host-bootstrap)
 * supplies the harness list (workspace + slug + on-disk root) so this module
 * stays decoupled from workspace resolution. LIVE-VERIFIED (D-005).
 */
export async function bootGitExportForHarnesses(
  sql: postgres.Sql,
  harnesses: HarnessRef[],
): Promise<BootGitExportResult> {
  const globals = await attachGitExportGlobals(sql);
  const handles: GitExportDrainHandle[] = [];
  for (const h of harnesses) {
    try {
      handles.push(
        await bootGitExportForHarness({
          sql,
          ...h,
          globals,
          onChanged: makeDebouncedGitCommitter(h.harnessRoot),
        }),
      );
    } catch (e) {
       
      console.error(
        `[git-export] boot failed for ${h.workspaceId}::${h.harnessSlug}:`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  // P-008: GC outbox rows orphaned by ephemeral / non-registry harnesses (which
  // never get a drain loop). Non-fatal; guarded to no-op on an empty harness list.
  let gcDeleted = 0;
  try {
    const gc = await gcOrphanOutboxRows(
      sql,
      harnesses.map((h) => ({ workspaceId: h.workspaceId, harnessSlug: h.harnessSlug })),
    );
    gcDeleted = gc.deleted;
    if (gc.deleted > 0) {
       
      console.log(`[git-export] GC'd ${gc.deleted} orphan outbox row(s) from ${gc.orphans.length} non-registry harness(es)`);
    }
  } catch (e) {
     
    console.warn('[git-export] orphan GC failed (non-fatal):', e instanceof Error ? e.message : String(e));
  }
  return { globals, handles, harnesses: harnesses.length, gcDeleted };
}
