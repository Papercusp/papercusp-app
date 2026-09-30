/**
 * runtime-vintage.ts — the CURRENT build identity every runtime self-reports at
 * boot (fleet-reliability-verification-2026-07-10 P-008; mig 542
 * `harness_shared.runtime_vintage`).
 *
 * Problem this answers: "is the fix actually RUNNING there?" was asked ~5x by
 * manual ssh + log-tailing during the 2026-07-09/10 night-shift outage (a Mac
 * desktop bundle predating a landed fix; a tower bundle mid half-rename break;
 * a watchdog silently auto-deploying an instrumented build). One row per
 * (workspace, unit, host) — an upserted CURRENT-vintage ledger, not a full
 * history — refreshed every time that runtime boots. `deploys:vintage` (agent
 * tool) reads this table and diffs `treeSha` against `origin/staging` HEAD to
 * report commit-lag per unit.
 *
 * Store shape mirrors read-cursors.ts / watermarks.ts: a module-level default
 * Pg store with configure/reset seams so tests inject the in-memory variant
 * and never touch the live row.
 */

import { hostname } from 'node:os';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';
import { coerceJson } from './pg-jsonb';

/** The tagged org-PG client, optionally supplied by a caller's read transaction. */
export type RuntimeVintageSql = ReturnType<typeof getOrgPg>['sql'];

export interface RuntimeVintageReport {
  /** Free-form reporting-process label — e.g. 'bg-host', 'staging-api',
   *  'dev-api', 'desktop-sidecar', 'watchdog', 'gateway'. Not an enum: new
   *  runtime kinds must never block on a migration to be recorded. */
  unit: string;
  /** Defaults to os.hostname() when omitted. */
  host?: string;
  treeSha?: string | null;
  /** ISO timestamp; defaults to now() when omitted. */
  buildTime?: string | null;
  bundleVersion?: string | null;
  pid?: number | null;
  /** Best-effort extra context (platform, arch, envOperatorId, …) — additive,
   *  never load-bearing for the commit-lag computation. */
  extra?: Record<string, unknown>;
  workspaceId?: string;
}

export interface RuntimeVintageRow {
  workspaceId: string;
  unit: string;
  host: string;
  treeSha: string | null;
  buildTime: string | null;
  bundleVersion: string | null;
  pid: number | null;
  extra: Record<string, unknown>;
  reportedAt: string;
}

export interface RuntimeVintageStore {
  report(input: RuntimeVintageReport): Promise<void>;
  list(workspaceId?: string, client?: RuntimeVintageSql): Promise<RuntimeVintageRow[]>;
}

class PgRuntimeVintageStore implements RuntimeVintageStore {
  async report(input: RuntimeVintageReport): Promise<void> {
    const { sql } = getOrgPg();
    const ws = input.workspaceId ?? activeWorkspaceId();
    const host = input.host?.trim() || defaultHost();
    // `${JSON.stringify(x)}::jsonb`, NOT sql.json() — sql.json() THROWS on the
    // getOrgPg client ("Buffer.byteLength received Object"; see pg-jsonb.ts /
    // dock-layouts.ts's matching comment / agent-insights
    // postgres-js-jsonb-binding). sql.json() is only correct on the OTHER
    // (db()) postgres-js pool, which this store does not use.
    const extraJson = JSON.stringify(input.extra ?? {});
    await sql`
      INSERT INTO harness_shared.runtime_vintage
             (workspace_id, unit, host, tree_sha, build_time, bundle_version, pid, extra, reported_at)
      VALUES (${ws}, ${input.unit}, ${host}, ${input.treeSha ?? null},
              ${input.buildTime ?? new Date().toISOString()}, ${input.bundleVersion ?? null},
              ${input.pid ?? null}, ${extraJson}::text::jsonb, now())
      ON CONFLICT (workspace_id, unit, host) DO UPDATE SET
        tree_sha = EXCLUDED.tree_sha,
        build_time = EXCLUDED.build_time,
        bundle_version = EXCLUDED.bundle_version,
        pid = EXCLUDED.pid,
        extra = EXCLUDED.extra,
        reported_at = now()
    `;
  }

  async list(workspaceId?: string, client?: RuntimeVintageSql): Promise<RuntimeVintageRow[]> {
    const sql = client ?? getOrgPg().sql;
    const ws = workspaceId ?? activeWorkspaceId();
    const rows = await sql<Array<{
      workspace_id: string;
      unit: string;
      host: string;
      tree_sha: string | null;
      build_time: string | null;
      bundle_version: string | null;
      pid: number | null;
      extra: Record<string, unknown>;
      reported_at: string;
    }>>`
      SELECT workspace_id, unit, host, tree_sha, build_time, bundle_version, pid, extra, reported_at
        FROM harness_shared.runtime_vintage
       WHERE workspace_id = ${ws}
       ORDER BY unit, host
    `;
    return rows.map((r) => ({
      workspaceId: r.workspace_id,
      unit: r.unit,
      host: r.host,
      treeSha: r.tree_sha,
      buildTime: r.build_time,
      bundleVersion: r.bundle_version,
      pid: r.pid,
      // Defensive decode (pg-jsonb.ts): a jsonb column reads back as an
      // object under the prod getOrgPg client but as a raw JSON STRING under
      // some other pool configs (e.g. testcontainers) — coerceJson handles
      // both so this never silently ships a stringified blob as `extra`.
      extra: coerceJson<Record<string, unknown>>(r.extra) ?? {},
      reportedAt: r.reported_at,
    }));
  }
}

/** In-memory variant for tests (mirrors InMemoryReadCursorStore's contract). */
export class InMemoryRuntimeVintageStore implements RuntimeVintageStore {
  rows = new Map<string, RuntimeVintageRow>();
  private key(ws: string, unit: string, host: string): string {
    return `${ws}\0${unit}\0${host}`;
  }
  async report(input: RuntimeVintageReport): Promise<void> {
    const ws = input.workspaceId ?? activeWorkspaceId();
    const host = input.host?.trim() || defaultHost();
    this.rows.set(this.key(ws, input.unit, host), {
      workspaceId: ws,
      unit: input.unit,
      host,
      treeSha: input.treeSha ?? null,
      buildTime: input.buildTime ?? new Date().toISOString(),
      bundleVersion: input.bundleVersion ?? null,
      pid: input.pid ?? null,
      extra: input.extra ?? {},
      reportedAt: new Date().toISOString(),
    });
  }
  async list(workspaceId?: string): Promise<RuntimeVintageRow[]> {
    const ws = workspaceId ?? activeWorkspaceId();
    return Array.from(this.rows.values())
      .filter((r) => r.workspaceId === ws)
      .sort((a, b) => (a.unit === b.unit ? a.host.localeCompare(b.host) : a.unit.localeCompare(b.unit)));
  }
}

function defaultHost(): string {
  try {
    return hostname();
  } catch {
    return 'unknown-host';
  }
}

let store: RuntimeVintageStore = new PgRuntimeVintageStore();

/** Swap the backing store (tests inject InMemoryRuntimeVintageStore). */
export function configureRuntimeVintageStore(next: RuntimeVintageStore): void {
  store = next;
}

/** Restore the default Pg store (afterEach in tests). */
export function resetRuntimeVintageStore(): void {
  store = new PgRuntimeVintageStore();
}

/** Upsert this runtime's current build identity. */
export async function reportRuntimeVintage(input: RuntimeVintageReport): Promise<void> {
  return store.report(input);
}

/** List every reported runtime's current vintage for a workspace. */
export async function listRuntimeVintage(
  workspaceId?: string,
  client?: RuntimeVintageSql,
): Promise<RuntimeVintageRow[]> {
  return store.list(workspaceId, client);
}

/**
 * Fire-and-forget boot-time self-report, built from build-info.ts's
 * getBuildInfo() (the same sha/version resolver /api/health already exposes).
 * Never throws, never blocks boot — a failed report just means this runtime's
 * row stays stale until its next successful boot, not a crashed process.
 */
export function reportRuntimeVintageOnBoot(unit: string, extra?: Record<string, unknown>): void {
  void (async () => {
    try {
      const { getBuildInfo } = await import('./build-info');
      const info = getBuildInfo();
      await reportRuntimeVintage({
        unit,
        treeSha: info.sha,
        bundleVersion: info.version,
        buildTime: new Date().toISOString(),
        pid: process.pid,
        extra,
      });
    } catch (e) {
      console.warn(
        `[runtime-vintage] self-report failed for unit=${unit} (non-fatal):`,
        (e as Error)?.message ?? e,
      );
    }
  })();
}
