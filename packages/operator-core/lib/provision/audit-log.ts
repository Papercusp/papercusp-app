/**
 * Provision audit log — PG-backed (migration 026).
 *
 * Append-only log of every provision event for `(workspace, harness, plugin)`.
 * Each audit entry is one row in `harness_shared.provision_audit_log`,
 * indexed for the common "all events for (harness, plugin) ordered by
 * ts" query.
 *
 * Was previously per-(harness, plugin) audit.log files with a 10MB
 * size cap and oldest-25%-truncation logic. PG can absorb the volume
 * without truncation; if a future retention policy is needed it lives
 * as a scheduled DELETE rather than in-band file rewriting.
 *
 * Spec: /docs/snapshots/build-scripts#audit-log.
 */

import { getOrgPg, generated } from '@papercusp/db-org';
import { and, desc, eq, gt } from 'drizzle-orm';
import { activeWorkspaceId } from '../workspace-registry';
import { publish as publishAudit } from '../provision-audit-bus';

const t = generated.provisionAuditLogInHarnessShared;

export type AuditKind =
  | 'consent-granted'
  | 'consent-rejected'
  | 'setup-started'
  | 'setup-succeeded'
  | 'setup-failed'
  | 'teardown-started'
  | 'teardown-succeeded'
  | 'teardown-failed'
  | 'verify-started'
  | 'verify-succeeded'
  | 'verify-failed'
  | 'resource-recorded'
  | 'script-output'
  | 'log-truncated'
  | 'sandbox-bypass'
  | 'state-set';

export interface AuditEntry {
  ts: string;
  kind: AuditKind;
  /** Optional run-id linking related entries. */
  runId?: string;
  /** Per-event payload — kept small. */
  data?: Record<string, unknown>;
}

/**
 * Append a single audit entry. Drops the prior `capMb` argument — PG
 * doesn't need the truncation logic. Existing callers that pass it are
 * silently ignored (no break).
 */
export async function appendAudit(
  harness: string,
  plugin: string,
  entry: Omit<AuditEntry, 'ts'> & { ts?: string },
  _capMb?: number, // ignored — kept for source compatibility
): Promise<void> {
  const { db } = getOrgPg();
  const ws = activeWorkspaceId();
  const ts = entry.ts ?? new Date().toISOString();
  await db.insert(t).values({
    workspaceId: ws,
    harnessSlug: harness,
    pluginSlug: plugin,
    ts: new Date(ts) as any,
    kind: entry.kind,
    runId: entry.runId ?? null,
    data: entry.data ?? null,
  });
  // Fan out to in-process subscribers (provision/stream SSE) so the UI
  // updates sub-millisecond after the row commits — no file polling.
  publishAudit(`${harness}:${plugin}`, { ts, ...entry });
}

/**
 * Read audit entries for (harness, plugin), ascending by time. `limit`
 * keeps the MOST RECENT entries (the tail) — callers show the latest
 * slice of the log, never its first page.
 */
export async function readAudit(
  harness: string,
  plugin: string,
  opts: { limit?: number; sinceTs?: string } = {},
): Promise<AuditEntry[]> {
  const { db } = getOrgPg();
  const ws = activeWorkspaceId();
  const limit = opts.limit ?? 1_000;
  const since = opts.sinceTs ?? null;

  const baseWhere = and(
    eq(t.workspaceId, ws),
    eq(t.harnessSlug, harness),
    eq(t.pluginSlug, plugin),
  );
  const where = since ? and(baseWhere, gt(t.ts, new Date(since) as any)) : baseWhere;
  // Fetch newest-first so `limit` clamps to the tail, then flip back to
  // ascending for callers (ascending + LIMIT would return the OLDEST rows).
  const rows = (await db
    .select({ ts: t.ts, kind: t.kind, runId: t.runId, data: t.data })
    .from(t)
    .where(where)
    .orderBy(desc(t.ts), desc(t.id))
    .limit(limit)) as unknown as Array<{ ts: Date; kind: AuditKind; runId: string | null; data: Record<string, unknown> | null }>;
  rows.reverse();

  return rows.map((r) => ({
    ts: r.ts.toISOString(),
    kind: r.kind,
    ...(r.runId ? { runId: r.runId } : {}),
    ...(r.data ? { data: r.data } : {}),
  }));
}

/**
 * High-throughput stream-append for in-process script-output capture.
 * Each `write()` is a separate `script-output` audit row. Inserts happen
 * one per call; PG's prepared-statement cache + connection-pooled
 * postgres-js client makes this fast enough for typical script verbosity.
 * Caller is still responsible for `open()` (no-op) + `close()` (no-op)
 * for source-compat with the prior streaming implementation.
 */
export class AuditStream {
  constructor(
    private harness: string,
    private plugin: string,
    private runId: string,
  ) {}
  async open(): Promise<void> {
    /* no-op: PG client is shared and managed elsewhere */
  }
  async write(line: string): Promise<void> {
    await appendAudit(this.harness, this.plugin, {
      kind: 'script-output',
      runId: this.runId,
      data: { line: line.replace(/\n$/, '') },
    });
  }
  async close(): Promise<void> {
    /* no-op */
  }
}
