/**
 * Post-compaction staleness detection
 * (compaction-continuity-hardening-2026-07-07 P-004, implements WI-2537).
 *
 * A compaction summary is a snapshot taken at time T (the transcript's
 * `compact_boundary` entry). Anything that changed AFTER T is guaranteed-stale
 * in the summary — the successor will act on it as fact unless told otherwise.
 * This module (a) recovers T from the caller's own transcript and (b) queries
 * the coordination stores for the concrete post-T changes worth a warning:
 *
 *   1. the caller's OWN plan-item claims that have LAPSED (the classic trap:
 *      the summary says "I hold P-00X", the lease expired during/after the
 *      compaction and a peer may take it);
 *   2. claims acquired by PEERS after T on the plans the caller is working
 *      (their lane changed under them);
 *   3. fleet peers whose presence APPEARED after T (fleet counts in the
 *      summary are stale);
 *   4. the caller's held work-items UPDATED after T (a peer commented,
 *      re-stated, or resolved one — including into a terminal state).
 *
 * Every leg is best-effort and bounded; the assembly is pure given the seam
 * outputs, mirroring carry-brief.ts. Consumed by buildCompactionRecovery
 * (compaction-recovery.ts) — orient's afterCompaction recovery block.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
// EI-20261012762389206 moved this formatter to message-age.ts so the coord
// age-marker and these staleness warnings cannot drift apart. Aliased to `ago`
// to keep the call sites (and their asserted strings) byte-identical.
import { formatAgo as ago } from './message-age';

export const STALENESS_MAX_WARNINGS = 8;

/** Tail window scanned for the last compact_boundary — the boundary sits near
 *  EOF at the first post-compaction orient, and one boundary line is ~5KB. */
const TAIL_BYTES = 512 * 1024;

// ── Summary timestamp (T) ─────────────────────────────────────────────────────

/**
 * The timestamp of the LAST compact_boundary entry in a claude-transcript
 * jsonl text, or null. Matches on the marker substring rather than a full
 * schema — the boundary has appeared both as a `type:system` entry and nested
 * inside a `type:attachment` wrapper; the top-level `timestamp` is stable.
 */
export function parseLastCompactBoundaryTs(text: string): number | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('"subtype":"compact_boundary"')) continue;
    try {
      const entry = JSON.parse(line) as { timestamp?: string };
      const ms = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
      if (Number.isFinite(ms)) return ms;
    } catch {
      /* a partial line at the tail-window edge — keep scanning up */
    }
  }
  return null;
}

/** Read the transcript's tail and return the last compact-boundary timestamp. */
export async function readLastCompactBoundaryTs(filePath: string): Promise<number | null> {
  const { open } = await import('node:fs/promises');
  const fh = await open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return parseLastCompactBoundaryTs(buf.toString('utf8'));
  } finally {
    await fh.close();
  }
}

// ── Warnings assembly ─────────────────────────────────────────────────────────

export interface OwnClaimRow {
  planSlug: string;
  itemId: string;
  /** Lease expiry in ms — the claim has LAPSED when this is in the past. */
  expiresTsMs: number;
}

export interface PeerClaimRow {
  planSlug: string;
  itemId: string;
  owner: string;
  acquiredTsMs: number;
}

export interface FleetPeerRow {
  ownerId: string;
  label: string | null;
  startedAtMs: number;
}

export interface HeldChangedRow {
  id: string;
  state: string;
  updatedAtMs: number;
}

export interface BuildStalenessWarningsOpts {
  /** The summary timestamp T (ms) — from readLastCompactBoundaryTs. */
  summaryAtMs: number;
  now?: number;
  sql?: Sql;
  // Test seams — each defaults to the real PG reader.
  listOwnClaimsFn?: (ownerId: string, workspaceId: string) => Promise<OwnClaimRow[]>;
  listPeerClaimsSinceFn?: (
    ownerId: string,
    workspaceId: string,
    sinceMs: number,
    planSlugs: string[],
  ) => Promise<PeerClaimRow[]>;
  listFleetPeersSinceFn?: (ownerId: string, sinceMs: number) => Promise<FleetPeerRow[]>;
  listHeldChangedSinceFn?: (
    ownerId: string,
    workspaceId: string,
    sinceMs: number,
  ) => Promise<HeldChangedRow[]>;
}

/**
 * The concrete post-summary changes, worded as warnings, ordered
 * most-actionable first (own lapsed claims > held-item changes > peer claims >
 * fleet arrivals) and capped at {@link STALENESS_MAX_WARNINGS}. Every leg is
 * independently best-effort — a throwing reader just contributes nothing.
 */
export async function buildStalenessWarnings(
  ownerId: string,
  workspaceId: string,
  opts: BuildStalenessWarningsOpts,
): Promise<string[]> {
  const now = opts.now ?? Date.now();
  const since = opts.summaryAtMs;
  const warnings: string[] = [];

  let ownClaims: OwnClaimRow[] = [];
  try {
    const listOwn = opts.listOwnClaimsFn ?? defaultListOwnClaims(opts.sql);
    ownClaims = await listOwn(ownerId, workspaceId);
    for (const c of ownClaims) {
      if (c.expiresTsMs < now) {
        warnings.push(
          `your claim on ${c.planSlug}#${c.itemId} LAPSED ${ago(c.expiresTsMs, now)} — re-claim (plans:set-status wip, or orient planItems) before resuming; a peer may hold it now`,
        );
      }
    }
  } catch {
    /* leg contributes nothing */
  }

  try {
    const listHeld = opts.listHeldChangedSinceFn ?? defaultListHeldChangedSince(opts.sql);
    for (const h of await listHeldChangedSince(listHeld, ownerId, workspaceId, since)) {
      warnings.push(
        `your work-item ${h.id} CHANGED after the summary was written (${ago(h.updatedAtMs, now)}; state now: ${h.state}) — re-read it via work_items:get before acting on the summary's version`,
      );
    }
  } catch {
    /* leg contributes nothing */
  }

  try {
    const planSlugs = [...new Set(ownClaims.map((c) => c.planSlug))];
    if (planSlugs.length) {
      const listPeer = opts.listPeerClaimsSinceFn ?? defaultListPeerClaimsSince(opts.sql);
      for (const p of await listPeer(ownerId, workspaceId, since, planSlugs)) {
        warnings.push(
          `${p.planSlug}#${p.itemId} was claimed by ${p.owner} AFTER your summary (${ago(p.acquiredTsMs, now)}) — the summary predates this claim`,
        );
      }
    }
  } catch {
    /* leg contributes nothing */
  }

  try {
    const listPeers = opts.listFleetPeersSinceFn ?? defaultListFleetPeersSince(opts.sql);
    for (const f of await listPeers(ownerId, since)) {
      warnings.push(
        `fleet peer ${f.label || f.ownerId} APPEARED after your summary (${ago(f.startedAtMs, now)}) — any member/liveness counts in the summary are stale`,
      );
    }
  } catch {
    /* leg contributes nothing */
  }

  return warnings.slice(0, STALENESS_MAX_WARNINGS);
}

async function listHeldChangedSince(
  fn: NonNullable<BuildStalenessWarningsOpts['listHeldChangedSinceFn']>,
  ownerId: string,
  workspaceId: string,
  since: number,
): Promise<HeldChangedRow[]> {
  return (await fn(ownerId, workspaceId, since)).filter((h) => h.updatedAtMs > since);
}

// ── Default PG readers ────────────────────────────────────────────────────────

function defaultListOwnClaims(sqlOpt?: Sql) {
  return async (ownerId: string, workspaceId: string): Promise<OwnClaimRow[]> => {
    const sql = sqlOpt ?? getOrgPg().sql;
    const rows = await sql<Array<{ plan_slug: string; item_id: string; expires_ts: Date }>>`
      SELECT plan_slug, item_id, expires_ts
        FROM harness_shared.plan_item_claims
       WHERE owner = ${ownerId} AND workspace_id = ${workspaceId}
       LIMIT ${STALENESS_MAX_WARNINGS}
    `;
    return rows.map((r) => ({
      planSlug: r.plan_slug,
      itemId: r.item_id,
      expiresTsMs: new Date(r.expires_ts).getTime(),
    }));
  };
}

function defaultListPeerClaimsSince(sqlOpt?: Sql) {
  return async (
    ownerId: string,
    workspaceId: string,
    sinceMs: number,
    planSlugs: string[],
  ): Promise<PeerClaimRow[]> => {
    const sql = sqlOpt ?? getOrgPg().sql;
    const rows = await sql<
      Array<{ plan_slug: string; item_id: string; owner: string; acquired_ts: Date }>
    >`
      SELECT plan_slug, item_id, owner, acquired_ts
        FROM harness_shared.plan_item_claims
       WHERE workspace_id = ${workspaceId}
         AND plan_slug = ANY(${planSlugs})
         AND owner <> ${ownerId}
         AND acquired_ts > ${new Date(sinceMs)}
       ORDER BY acquired_ts DESC
       LIMIT ${STALENESS_MAX_WARNINGS}
    `;
    return rows.map((r) => ({
      planSlug: r.plan_slug,
      itemId: r.item_id,
      owner: r.owner,
      acquiredTsMs: new Date(r.acquired_ts).getTime(),
    }));
  };
}

function defaultListFleetPeersSince(sqlOpt?: Sql) {
  return async (ownerId: string, sinceMs: number): Promise<FleetPeerRow[]> => {
    const sql = sqlOpt ?? getOrgPg().sql;
    const mine = await sql<Array<{ fleet_slug: string | null }>>`
      SELECT fleet_slug FROM harness_shared.coord_presence
       WHERE owner_id = ${ownerId}
       ORDER BY heartbeat_at DESC
       LIMIT 1
    `;
    const fleet = mine[0]?.fleet_slug;
    if (!fleet) return [];
    const rows = await sql<Array<{ owner_id: string; owner_label: string | null; started_at: Date }>>`
      SELECT owner_id, owner_label, started_at
        FROM harness_shared.coord_presence
       WHERE fleet_slug = ${fleet}
         AND owner_id <> ${ownerId}
         AND started_at > ${new Date(sinceMs)}
       ORDER BY started_at DESC
       LIMIT ${STALENESS_MAX_WARNINGS}
    `;
    return rows.map((r) => ({
      ownerId: r.owner_id,
      label: r.owner_label,
      startedAtMs: new Date(r.started_at).getTime(),
    }));
  };
}

function defaultListHeldChangedSince(sqlOpt?: Sql) {
  return async (
    ownerId: string,
    workspaceId: string,
    sinceMs: number,
  ): Promise<HeldChangedRow[]> => {
    const sql = sqlOpt ?? getOrgPg().sql;
    const rows = await sql<Array<{ issue_id: string; state: string; updated_at: Date }>>`
      SELECT issue_id, state, updated_at
        FROM harness_shared.engineer_issues
       WHERE assignee = ${ownerId}
         AND (workspace_id = ${workspaceId} OR workspace_id = 'default')
         AND updated_at > ${new Date(sinceMs)}
       ORDER BY updated_at DESC
       LIMIT ${STALENESS_MAX_WARNINGS}
    `;
    return rows.map((r) => ({
      id: r.issue_id,
      state: r.state,
      updatedAtMs: new Date(r.updated_at).getTime(),
    }));
  };
}
