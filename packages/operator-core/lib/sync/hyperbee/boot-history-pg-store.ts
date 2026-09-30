/**
 * boot-history-pg-store — durable PG mirror for boot-history.ts's sparse
 * forensic event kinds (EI-18655247267756605).
 *
 * boot-history.ts holds two in-memory rings that clear on process restart —
 * unavailable for exactly the restart-class federation bugs they exist to
 * diagnose (cold-restart re-peer, join-path, epoch rebind), because the
 * restart IS the event that destroys them. WI-5781 already mirrors the same
 * sparse admission/join/peer/boot-fail kinds to stdout so they land in banked
 * serve logs (the cheap half of the fix — see STDOUT_MIRROR_KINDS in
 * boot-history.ts); this module is the durable half (storage-policy default:
 * Postgres), writing to harness_shared.boot_history_events (migration 660) so
 * the same trail survives a restart and is directly queryable across
 * restarts, not just grep-able out of whichever serve log happened to be
 * banked.
 *
 * Fire-and-forget from boot-history.ts's perspective: every insert here is
 * best-effort and the caller wraps it in try/catch — a PG hiccup (or, before
 * migration 660 has applied on a given host, a missing table) must never
 * break a live boot/announce/merge path. Kept as a SEPARATE module (rather
 * than inlined into boot-history.ts) so boot-history.ts's core stays free of
 * any static DB import — it is documented "pure logic" and is imported from
 * places that should not need to pull in @papercusp/db-org just to record an
 * in-memory event.
 */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { BootHistoryEntry, BootHistoryKind } from './boot-history';

/** Per-(workspace, harness) row cap (oldest evicted past it). Env-tunable. */
export const DEFAULT_BOOT_HISTORY_PG_CAP =
  Number(process.env.PAPERCUSP_BOOT_HISTORY_PG_CAP) || 2000;

/** EI-18736339540215666: is THIS process a vitest run? The existing, already-used-
 *  elsewhere convention (rubrics.ts, work-items.ts) for "are we under test" — reused
 *  here rather than inventing a second one. Exported so a caller with a more specific
 *  notion of "test" (e.g. an integration-test harness that doesn't set VITEST itself)
 *  can override the stamped origin explicitly via `entry.origin`. */
export function isVitestOrigin(): boolean {
  return Boolean(process.env.VITEST);
}

/** Insert one durable boot-history row + evict this scope's oldest rows past the cap. */
export async function insertBootHistoryEventPg(
  entry: BootHistoryEntry,
  sqlIn?: postgres.Sql,
): Promise<void> {
  const sql = sqlIn ?? getOrgPg().sql;
  const createdTs = Date.now();
  // EI-18736339540215666: stamp provenance so a federation-health aggregate can exclude
  // test-fixture writes by default (see migration 695). `entry.origin` lets a caller
  // override explicitly (e.g. a test that wants to assert against a 'real' row, or a
  // non-vitest integration harness); absent that, fall back to the VITEST env detection.
  const origin = entry.origin ?? (isVitestOrigin() ? 'test' : 'real');
  await sql`
    INSERT INTO harness_shared.boot_history_events
      (workspace_id, harness_slug, kind, message, ts, created_ts, origin)
    VALUES
      (${entry.workspaceId}, ${entry.harnessSlug}, ${entry.kind}, ${entry.message ?? null},
       ${entry.ts}, ${createdTs}, ${origin})
  `;
  // Bound: evict this scope's oldest rows past the cap (mirrors
  // harness_shared.coord_quarantine's per-author eviction, migration 436) —
  // these kinds are sparse by construction (STDOUT_MIRROR_KINDS excludes the
  // high-frequency epoch trace and peer_connected), but a long-lived harness
  // should still never grow this table unbounded.
  await sql`
    DELETE FROM harness_shared.boot_history_events
    WHERE workspace_id = ${entry.workspaceId}
      AND harness_slug = ${entry.harnessSlug}
      AND id IN (
        SELECT id FROM harness_shared.boot_history_events
        WHERE workspace_id = ${entry.workspaceId}
          AND harness_slug = ${entry.harnessSlug}
        ORDER BY created_ts DESC, id DESC
        OFFSET ${DEFAULT_BOOT_HISTORY_PG_CAP}
      )
  `;
}

export interface ListBootHistoryPgOpts {
  workspaceId?: string;
  harnessSlug?: string;
  kinds?: readonly string[];
  limit?: number;
  /** EI-18736339540215666: include vitest-fixture rows (origin='test') alongside real
   *  ones. Default false — a federation-health read/aggregate must not silently count
   *  test-fixture join/announce churn as real activity. Pass true only when you are
   *  deliberately debugging the tests themselves. */
  includeTestOrigin?: boolean;
}

/**
 * Cross-restart boot-history read — the durable counterpart to
 * boot-history.ts's in-memory `listBootHistory()`. Use this (instead of, or
 * merged with, `listBootHistory()`) when diagnosing a restart-class failure,
 * since the in-memory rings cleared at the very restart under investigation.
 */
export async function listBootHistoryEventsPg(
  opts: ListBootHistoryPgOpts = {},
  sqlIn?: postgres.Sql,
): Promise<BootHistoryEntry[]> {
  const sql = sqlIn ?? getOrgPg().sql;
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const rows = await sql<
    Array<{
      workspace_id: string;
      harness_slug: string;
      kind: string;
      message: string | null;
      ts: string | number;
    }>
  >`
    SELECT workspace_id, harness_slug, kind, message, ts
    FROM harness_shared.boot_history_events
    WHERE 1=1
      ${opts.includeTestOrigin ? sql`` : sql`AND origin = 'real'`}
      ${opts.workspaceId ? sql`AND workspace_id = ${opts.workspaceId}` : sql``}
      ${opts.harnessSlug ? sql`AND harness_slug = ${opts.harnessSlug}` : sql``}
      ${opts.kinds && opts.kinds.length > 0 ? sql`AND kind = ANY(${[...opts.kinds]})` : sql``}
    ORDER BY ts DESC, id DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    workspaceId: r.workspace_id,
    harnessSlug: r.harness_slug,
    kind: r.kind as BootHistoryKind,
    message: r.message ?? undefined,
    ts: Number(r.ts),
  }));
}
