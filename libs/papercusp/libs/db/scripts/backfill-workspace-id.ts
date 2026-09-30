#!/usr/bin/env node
/**
 * backfill-workspace-id.ts — Phase A migration script.
 *
 * Walks the on-disk workspace registry, derives each harness's workspace,
 * and backfills `workspace_id` on every harness_shared.* table.
 *
 * Properties (per spec/workspace-scoping):
 *   - Idempotent: rerunning produces no further writes.
 *   - Dry-runnable: --dry-run prints intended changes, does not write.
 *   - Loud-fail on indeterminate rows: rows whose workspace cannot be
 *     determined are reported by primary key with a reason; no
 *     default-tagging.
 *
 * Usage:
 *   tsx libs/db/scripts/backfill-workspace-id.ts --dry-run
 *   tsx libs/db/scripts/backfill-workspace-id.ts --apply
 *
 * Run order vs SQL migrations:
 *   1. Apply 009-workspace-scoping.sql (additive columns + new tables).
 *   2. Run this script with --dry-run; review output.
 *   3. Run this script with --apply.
 *   4. Apply 011-operator-decisions-view.sql, 012-trigger-workspace-id.sql.
 *   5. Apply 010-workspace-scoping-rls.sql (RLS + CHECK constraints).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';

interface RegistryEntry {
  id: string;
  name: string;
  createdAt: number;
  companyId?: string | null;
}
interface Registry {
  current?: string;
  workspaces: RegistryEntry[];
}

interface HarnessLocation {
  slug: string;
  workspaceId: string;
  path: string;
}

interface BackfillResult {
  table: string;
  rowsTagged: number;
  rowsAlreadyTagged: number;
  rowsIndeterminate: Array<{ pk: string; reason: string }>;
}

const DRY_RUN = process.argv.includes('--dry-run');
const APPLY = process.argv.includes('--apply');

if (!DRY_RUN && !APPLY) {
  console.error('Usage: backfill-workspace-id.ts --dry-run | --apply');
  process.exit(1);
}
if (DRY_RUN && APPLY) {
  console.error('Pass exactly one of --dry-run or --apply');
  process.exit(1);
}

function adminUrl(): string {
  return process.env.HARNESS_ADMIN_DATABASE_URL
    ?? 'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';
}

/**
 * Resolve the workspaces root (`~/.papercusp-workspaces`), honoring
 * `PAPERCUSP_WORKSPACES_ROOT` before falling back to `homedir()`.
 *
 * Spawned CLI children can run with `HOME` remapped to a per-workspace dir
 * (P-051); a bare `homedir()` there resolves to a NESTED registry that
 * disagrees with the real one (agent-insights/workspaces-root-vs-remapped-home).
 * Mirrors `workspacesRoot()` in `@papercusp/operator-core`'s
 * `workspace-registry.ts` (kept local — this script has no dependency on
 * operator-core).
 */
function workspacesRootDir(): string {
  const env = process.env.PAPERCUSP_WORKSPACES_ROOT;
  if (env && env.trim()) return env;
  return join(homedir(), '.papercusp-workspaces');
}

function discoverHarnessLocations(): {
  registry: Registry;
  harnesses: HarnessLocation[];
} {
  const wsRoot = workspacesRootDir();
  const registryPath = join(wsRoot, 'registry.json');
  if (!existsSync(registryPath)) {
    throw new Error(`registry.json missing at ${registryPath}`);
  }
  const registry: Registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  const harnesses: HarnessLocation[] = [];

  for (const ws of registry.workspaces) {
    const harnessesDir = join(wsRoot, ws.id, '.papercusp', 'harnesses');
    if (!existsSync(harnessesDir)) continue;
    for (const slug of readdirSync(harnessesDir)) {
      const harnessPath = join(harnessesDir, slug);
      try {
        if (!statSync(harnessPath).isDirectory()) continue;
      } catch {
        continue;
      }
      harnesses.push({ slug, workspaceId: ws.id, path: harnessPath });
    }
  }

  return { registry, harnesses };
}

/**
 * For each table, the strategy that determines a row's workspace_id.
 * `via` cases query a sibling table; the script handles them inline.
 */
type Strategy =
  | { kind: 'slugColumn'; col: string; pk: string[] }
  | { kind: 'audit_log' }
  | { kind: 'pending_events' }
  | { kind: 'via_projects'; localCol: string; pk: string[] };

const TABLES: Record<string, Strategy> = {
  projects: { kind: 'slugColumn', col: 'slug', pk: ['id'] },
  audit_log: { kind: 'audit_log' },
  harness_features_consolidated: { kind: 'slugColumn', col: 'harness_slug', pk: ['harness_slug', 'feature_id'] },
  plugin_enables: { kind: 'slugColumn', col: 'harness_slug', pk: ['harness_slug', 'plugin_slug'] },
  plugin_configs: { kind: 'slugColumn', col: 'harness_slug', pk: ['harness_slug', 'plugin_slug'] },
  goals: { kind: 'via_projects', localCol: 'project_id', pk: ['id'] },
  pending_events: { kind: 'pending_events' },
  routines: { kind: 'via_projects', localCol: 'project_id', pk: ['id'] },
  project_spec_revisions: { kind: 'via_projects', localCol: 'project_id', pk: ['id'] },
  token_index: { kind: 'slugColumn', col: 'slug', pk: ['token'] },
};

/**
 * Build a parameterized UPDATE for a row identified by a composite PK.
 */
async function tagRow(
  sql: postgres.Sql,
  table: string,
  pkCols: string[],
  pkVals: unknown[],
  workspaceId: string,
): Promise<void> {
  if (!APPLY) return;
  const where = pkCols.map((c, i) => `${c} = $${i + 2}`).join(' AND ');
  // `pkVals` is `unknown[]` because that is what the driver hands back for an
  // untyped row (`Record<string, unknown>`), but these values were SELECTed out
  // of this same database one statement earlier, so they are valid bind
  // parameters by construction. Narrow at this one boundary rather than
  // threading a postgres-specific parameter type through every caller.
  await sql.unsafe(
    `UPDATE harness_shared.${table} SET workspace_id = $1 WHERE ${where}`,
    [workspaceId, ...pkVals] as postgres.ParameterOrJSON<never>[],
  );
}

async function backfillSlugColumn(
  sql: postgres.Sql,
  table: string,
  col: string,
  pk: string[],
  slugToWorkspace: Map<string, string>,
): Promise<BackfillResult> {
  const result: BackfillResult = {
    table,
    rowsTagged: 0,
    rowsAlreadyTagged: 0,
    rowsIndeterminate: [],
  };
  const tagged = await sql.unsafe<[{ count: bigint }]>(
    `SELECT COUNT(*)::bigint AS count FROM harness_shared.${table} WHERE workspace_id <> ''`,
  );
  result.rowsAlreadyTagged = Number(tagged[0]?.count ?? 0);

  const rows = await sql.unsafe<Array<Record<string, unknown>>>(
    `SELECT ${pk.join(', ')}, ${col} AS _slug FROM harness_shared.${table} WHERE workspace_id = ''`,
  );
  for (const row of rows) {
    const slug = row._slug as string;
    const ws = slugToWorkspace.get(slug);
    if (!ws) {
      result.rowsIndeterminate.push({
        pk: pk.map((c) => `${c}=${row[c]}`).join(','),
        reason: `slug ${JSON.stringify(slug)} not found in any workspace's harnesses dir`,
      });
      continue;
    }
    await tagRow(sql, table, pk, pk.map((c) => row[c]), ws);
    result.rowsTagged++;
  }
  return result;
}

async function backfillViaProjects(
  sql: postgres.Sql,
  table: string,
  localCol: string,
  pk: string[],
  slugToWorkspace: Map<string, string>,
): Promise<BackfillResult> {
  const result: BackfillResult = {
    table,
    rowsTagged: 0,
    rowsAlreadyTagged: 0,
    rowsIndeterminate: [],
  };
  const tagged = await sql.unsafe<[{ count: bigint }]>(
    `SELECT COUNT(*)::bigint AS count FROM harness_shared.${table} WHERE workspace_id <> ''`,
  );
  result.rowsAlreadyTagged = Number(tagged[0]?.count ?? 0);

  const rows = await sql.unsafe<Array<Record<string, unknown>>>(
    `SELECT ${pk.join(', ')}, ${localCol} AS _local FROM harness_shared.${table} WHERE workspace_id = ''`,
  );
  for (const row of rows) {
    const local = row._local as string | null;
    if (!local) {
      result.rowsIndeterminate.push({
        pk: pk.map((c) => `${c}=${row[c]}`).join(','),
        reason: `${localCol} is null`,
      });
      continue;
    }
    const remote = await sql.unsafe<Array<{ slug: string; workspace_id: string }>>(
      `SELECT slug, workspace_id FROM harness_shared.projects WHERE id = $1 LIMIT 1`,
      [local],
    );
    if (!remote.length) {
      result.rowsIndeterminate.push({
        pk: pk.map((c) => `${c}=${row[c]}`).join(','),
        reason: `${localCol}=${local} not in projects`,
      });
      continue;
    }
    const ws = remote[0].workspace_id || slugToWorkspace.get(remote[0].slug);
    if (!ws) {
      result.rowsIndeterminate.push({
        pk: pk.map((c) => `${c}=${row[c]}`).join(','),
        reason: `via projects: workspace_id empty and slug ${remote[0].slug} not in registry`,
      });
      continue;
    }
    await tagRow(sql, table, pk, pk.map((c) => row[c]), ws);
    result.rowsTagged++;
  }
  return result;
}

async function backfillAuditLog(
  sql: postgres.Sql,
  slugToWorkspace: Map<string, string>,
): Promise<BackfillResult> {
  const result: BackfillResult = {
    table: 'audit_log',
    rowsTagged: 0,
    rowsAlreadyTagged: 0,
    rowsIndeterminate: [],
  };
  const tagged = await sql.unsafe<[{ count: bigint }]>(
    `SELECT COUNT(*)::bigint AS count FROM harness_shared.audit_log WHERE workspace_id <> ''`,
  );
  result.rowsAlreadyTagged = Number(tagged[0]?.count ?? 0);

  const rows = await sql<
    Array<{ id: string; subject: string; details: Record<string, unknown> | null }>
  >`SELECT id, subject, details FROM harness_shared.audit_log WHERE workspace_id = ''`;
  for (const row of rows) {
    let ws: string | undefined = slugToWorkspace.get(row.subject);
    if (!ws && row.details && typeof row.details === 'object') {
      const d = row.details as Record<string, unknown>;
      ws = slugToWorkspace.get(d.harness_slug as string)
        ?? slugToWorkspace.get(d.slug as string)
        ?? slugToWorkspace.get(d.harnessSlug as string);
    }
    if (!ws) {
      result.rowsIndeterminate.push({
        pk: `id=${row.id}`,
        reason: `audit row's subject (${row.subject}) and details have no recognizable harness slug`,
      });
      continue;
    }
    await tagRow(sql, 'audit_log', ['id'], [row.id], ws);
    result.rowsTagged++;
  }
  return result;
}

async function backfillPendingEvents(
  sql: postgres.Sql,
  slugToWorkspace: Map<string, string>,
): Promise<BackfillResult> {
  const result: BackfillResult = {
    table: 'pending_events',
    rowsTagged: 0,
    rowsAlreadyTagged: 0,
    rowsIndeterminate: [],
  };
  const tagged = await sql.unsafe<[{ count: bigint }]>(
    `SELECT COUNT(*)::bigint AS count FROM harness_shared.pending_events WHERE workspace_id <> ''`,
  );
  result.rowsAlreadyTagged = Number(tagged[0]?.count ?? 0);

  const rows = await sql<
    Array<{ id: string; payload: Record<string, unknown> | null }>
  >`SELECT id, payload FROM harness_shared.pending_events WHERE workspace_id = ''`;
  for (const row of rows) {
    const p = row.payload ?? {};
    const slug =
      (p.harness_slug as string | undefined)
      ?? (p.slug as string | undefined)
      ?? (p.harnessSlug as string | undefined);
    const ws = slug ? slugToWorkspace.get(slug) : undefined;
    if (!ws) {
      result.rowsIndeterminate.push({
        pk: `id=${row.id}`,
        reason: `pending_events payload has no recognizable harness slug`,
      });
      continue;
    }
    await tagRow(sql, 'pending_events', ['id'], [row.id], ws);
    result.rowsTagged++;
  }
  return result;
}

async function backfillConsolidatedFromPerHarness(
  sql: postgres.Sql,
  slugToWorkspace: Map<string, string>,
): Promise<void> {
  if (!APPLY) return;
  for (const [slug, ws] of slugToWorkspace.entries()) {
    await sql.unsafe(
      `UPDATE harness_shared.harness_features_consolidated
          SET workspace_id = $1
        WHERE harness_slug = $2 AND workspace_id = ''`,
      [ws, slug],
    );
  }
}

async function main() {
  console.log(`mode: ${DRY_RUN ? 'DRY-RUN (no writes)' : 'APPLY'}`);

  const { registry, harnesses } = discoverHarnessLocations();
  console.log(`registry: ${registry.workspaces.length} workspace(s), ${harnesses.length} harness(es)`);

  const slugToWorkspace = new Map<string, string>();
  for (const h of harnesses) {
    if (slugToWorkspace.has(h.slug)) {
      console.warn(
        `WARN: harness slug ${h.slug} appears in multiple workspaces ` +
        `(${slugToWorkspace.get(h.slug)}, ${h.workspaceId}); ` +
        `using the first occurrence. This is unexpected and should be investigated.`,
      );
      continue;
    }
    slugToWorkspace.set(h.slug, h.workspaceId);
  }

  const sql = postgres(adminUrl(), { onnotice: () => {} });
  const allResults: BackfillResult[] = [];
  let totalIndeterminate = 0;

  try {
    for (const [table, strat] of Object.entries(TABLES)) {
      let r: BackfillResult;
      switch (strat.kind) {
        case 'slugColumn':
          r = await backfillSlugColumn(sql, table, strat.col, strat.pk, slugToWorkspace);
          break;
        case 'audit_log':
          r = await backfillAuditLog(sql, slugToWorkspace);
          break;
        case 'pending_events':
          r = await backfillPendingEvents(sql, slugToWorkspace);
          break;
        case 'via_projects':
          r = await backfillViaProjects(sql, table, strat.localCol, strat.pk, slugToWorkspace);
          break;
      }
      allResults.push(r);
      totalIndeterminate += r.rowsIndeterminate.length;
    }
    await backfillConsolidatedFromPerHarness(sql, slugToWorkspace);
  } finally {
    await sql.end({ timeout: 5 });
  }

  console.log('\n=== Summary ===');
  for (const r of allResults) {
    console.log(
      `  ${r.table.padEnd(40)} ` +
      `tagged: ${String(r.rowsTagged).padStart(6)}  ` +
      `already: ${String(r.rowsAlreadyTagged).padStart(6)}  ` +
      `indeterminate: ${String(r.rowsIndeterminate.length).padStart(6)}`,
    );
  }

  if (totalIndeterminate > 0) {
    console.error('\n=== Indeterminate rows (loud-fail) ===');
    for (const r of allResults) {
      if (!r.rowsIndeterminate.length) continue;
      console.error(`\n${r.table}:`);
      for (const ind of r.rowsIndeterminate) {
        console.error(`  ${ind.pk}  —  ${ind.reason}`);
      }
    }
    console.error(
      `\n${totalIndeterminate} row(s) could not be tagged. ` +
      `Resolve manually before re-running. ` +
      `DO NOT apply 010-workspace-scoping-rls.sql until indeterminate count is 0.`,
    );
    process.exit(2);
  }

  if (DRY_RUN) {
    console.log('\nDry-run complete. Re-run with --apply to write changes.');
  } else {
    console.log('\nApply complete. Verify with:');
    console.log(`  psql -c "SELECT COUNT(*) FROM harness_shared.projects WHERE workspace_id = ''"`);
    console.log(`Then apply 010-workspace-scoping-rls.sql.`);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
