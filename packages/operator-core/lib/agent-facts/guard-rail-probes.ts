/**
 * Guard-rail probes from standing facts (expensive-verification-loops-2026-09-29 P-004).
 *
 * A fact whose recheck contract carries `exec` (migration 1240) is a lesson with a machine
 * check. This reads the live ones whose scope shares a tag with a harness and shapes them as
 * `GuardRailProbe`s for libs/generic/verification-harness, whose preflight runs them before any
 * expensive phase. The shell entry point is scripts/guard-rail-probes.mts (VH_GUARD_RAIL_SOURCE).
 *
 * D-003: only LOCAL-origin facts (`source_hive IS NULL`) are ever returned. A federated fact is
 * another hive's text; executing it here would turn federation into remote code execution.
 * Federation egress also strips `exec` (feature-issue-op-keys.ts) so it never lands remotely.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import type { GuardRailProbe } from '@papercusp/verification-harness';
import { activeWorkspaceId } from '../workspace-registry';
import { parseFactRecheck, type FactScope } from './store';

/** A preflight runs every returned probe; more than this is a curation problem, not a list. */
export const GUARD_RAIL_PROBE_LIMIT = 100;

interface ExecFactRow {
  scope: FactScope;
  scope_ref: string | null;
  key: string;
  body: string;
  recheck: unknown;
}

/** The probe id: the fact key, qualified by scope when it is not workspace-wide. PURE. */
export function guardRailProbeKey(row: Pick<ExecFactRow, 'scope' | 'scope_ref' | 'key'>): string {
  return row.scope === 'workspace' ? row.key : `${row.key}@${row.scope}:${row.scope_ref}`;
}

/** Row → probe; null when the stored recheck no longer parses (never guess at a command). PURE. */
export function factRowToGuardRailProbe(row: ExecFactRow): GuardRailProbe | null {
  const exec = parseFactRecheck(row.recheck)?.exec;
  if (!exec) return null;
  return {
    key: guardRailProbeKey(row),
    command: exec.command,
    expect: {
      exitCode: exec.expectExitCode,
      ...(exec.stdoutIncludes !== undefined ? { stdoutIncludes: exec.stdoutIncludes } : {}),
    },
    scope: exec.scope,
    lesson: row.body,
  };
}

/** Live local-origin exec-bearing facts whose scope overlaps `tags`, key order. */
export async function loadGuardRailProbes(
  opts: { tags: readonly string[]; workspaceId?: string },
  inject?: Sql,
): Promise<GuardRailProbe[]> {
  if (opts.tags.length === 0) return [];
  const sql = inject ?? getOrgPg().sql;
  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  const rows = await sql<ExecFactRow[]>`
    SELECT scope, scope_ref, key, body, recheck
      FROM harness_shared.agent_facts
     WHERE workspace_id = ${workspaceId}
       AND recheck ? 'exec'
       AND source_hive IS NULL
       AND retracted_at IS NULL
       AND superseded_at IS NULL
       AND expires_at > now()
       AND (recheck -> 'exec' -> 'scope') ?| ${[...opts.tags] as string[]}::text[]
     ORDER BY key, scope, scope_ref
     LIMIT ${GUARD_RAIL_PROBE_LIMIT}`;
  return rows.map(factRowToGuardRailProbe).filter((p): p is GuardRailProbe => p !== null);
}
