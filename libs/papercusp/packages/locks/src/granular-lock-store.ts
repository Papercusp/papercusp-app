/**
 * Multi-granularity intention-lock store (Gray 1976) — persistence + all-or-
 * nothing acquire. Plan: locks-correctness-hardening-2026-06-04 (D-005).
 *
 * Layers the pure matrix/protocol (`intention-locks.ts`) onto the papercusp_su
 * side-database. Like su-lock-store, these helpers take a `tx: Sql` and run
 * inside the caller's inWorkspaceTxn (the per-workspace advisory lock makes the
 * conflict-check → insert atomic, which is what structurally breaks hold-and-
 * wait: a request grabs its whole lock-set or nothing, never a partial hold).
 */

import type { Sql } from 'postgres';
import {
  lockSetFor,
  findConflicts,
  normalizeNode,
  type GranularMode,
  type HeldNodeLock,
  type NodeLock,
  type GranularConflict,
} from '@papercusp/locks-core';

export interface GranularHolder extends HeldNodeLock {
  owner_label: string | null;
  lock_id: string;
  intent: string;
  acquired_ts: Date;
  expires_ts: Date;
}

export interface GranularAcquireParams {
  coordinationDomain: string;
  /** Repo-relative node path; '' = the harness/tree root. */
  path: string;
  mode: GranularMode;
  owner: string;
  ownerLabel: string | null;
  intent: string;
  ttlSec: number;
}

export type GranularAcquireResult =
  | { ok: true; lock_id: string; locks: NodeLock[]; expires_ts: Date }
  | { ok: false; reason: 'conflict'; conflicts: GranularConflict[] };

/** Delete this workspace's expired granular-lock rows. */
export async function sweepGranularExpired(tx: Sql, coordinationDomain: string): Promise<void> {
  await tx`
    DELETE FROM agent_granular_locks
     WHERE coordination_domain = ${coordinationDomain}
       AND expires_ts <= clock_timestamp()
  `;
}

/** Live granular holders on a set of nodes (any owner). */
async function readNodeHolders(
  tx: Sql,
  coordinationDomain: string,
  nodes: string[],
): Promise<GranularHolder[]> {
  if (nodes.length === 0) return [];
  return tx<GranularHolder[]>`
    SELECT node, mode, owner, owner_label, lock_id::text AS lock_id, intent, acquired_ts, expires_ts
      FROM agent_granular_locks
     WHERE coordination_domain = ${coordinationDomain}
       AND node = ANY(${nodes}::text[])
       AND expires_ts > clock_timestamp()
  `;
}

/**
 * Acquire the multi-granularity lock-set for `path` in `mode`: the leaf node in
 * `mode` + the matching intention mode on every ancestor (incl. the harness
 * root). Conflict-checked through the IS/IX/S/SIX/X matrix against live locks by
 * OTHER owners; granted all-or-nothing. Same-owner refreshes / escalations are
 * upserted (an owner may hold several modes per node).
 */
export async function tryAcquireGranular(
  tx: Sql,
  params: GranularAcquireParams,
): Promise<GranularAcquireResult> {
  const { coordinationDomain: cd, mode, owner, ownerLabel, intent, ttlSec } = params;
  const path = normalizeNode(params.path);
  await tx`SET LOCAL statement_timeout = '500ms'`;
  await sweepGranularExpired(tx, cd);

  const want = lockSetFor(path, mode);
  const nodes = want.map((l) => l.node);
  const held = await readNodeHolders(tx, cd, nodes);
  const conflicts = findConflicts(held, want, owner);
  if (conflicts.length > 0) {
    return { ok: false, reason: 'conflict', conflicts };
  }

  const lockId = crypto.randomUUID();
  const ttlText = `${ttlSec} seconds`;
  // Insert/refresh every node in the set under ONE lock_id so release-by-id
  // frees the whole set. ON CONFLICT refreshes the same owner's same-mode row.
  const nodeArr = want.map((l) => l.node);
  const modeArr = want.map((l) => l.mode);
  const rows = await tx<Array<{ expires_ts: Date }>>`
    INSERT INTO agent_granular_locks
      (coordination_domain, node, mode, owner, owner_label, lock_id, intent, expires_ts)
    SELECT ${cd}, n.node, n.mode, ${owner}, ${ownerLabel}, ${lockId}::uuid, ${intent},
           clock_timestamp() + ${ttlText}::interval
      FROM unnest(${nodeArr}::text[], ${modeArr}::text[]) AS n(node, mode)
    ON CONFLICT (coordination_domain, node, owner, mode) DO UPDATE
      SET owner_label = EXCLUDED.owner_label,
          lock_id     = EXCLUDED.lock_id,
          intent      = EXCLUDED.intent,
          acquired_ts = clock_timestamp(),
          expires_ts  = EXCLUDED.expires_ts
    RETURNING expires_ts
  `;
  return { ok: true, lock_id: lockId, locks: want, expires_ts: rows[0].expires_ts };
}

/** Release a whole granular lock-set by id (owner-checked). Returns rows freed. */
export async function releaseGranular(
  tx: Sql,
  coordinationDomain: string,
  owner: string,
  lockId: string,
): Promise<{ released: number }> {
  await tx`SET LOCAL statement_timeout = '5s'`;
  const rows = await tx<Array<{ node: string }>>`
    DELETE FROM agent_granular_locks
     WHERE coordination_domain = ${coordinationDomain}
       AND lock_id = ${lockId}::uuid
       AND owner = ${owner}
    RETURNING node
  `;
  return { released: rows.length };
}

/** Release every granular lock an owner holds (session-end cleanup). */
export async function releaseAllGranularForOwner(
  tx: Sql,
  coordinationDomain: string,
  owner: string,
): Promise<{ released: number }> {
  await tx`SET LOCAL statement_timeout = '5s'`;
  const rows = await tx<Array<{ node: string }>>`
    DELETE FROM agent_granular_locks
     WHERE coordination_domain = ${coordinationDomain} AND owner = ${owner}
    RETURNING node
  `;
  return { released: rows.length };
}

/** Read the live granular holders for a workspace (optionally one node). */
export async function readGranularHolders(
  sql: Sql,
  coordinationDomain: string,
  node?: string,
): Promise<GranularHolder[]> {
  if (node !== undefined) {
    return sql<GranularHolder[]>`
      SELECT node, mode, owner, owner_label, lock_id::text AS lock_id, intent, acquired_ts, expires_ts
        FROM agent_granular_locks
       WHERE coordination_domain = ${coordinationDomain}
         AND node = ${normalizeNode(node)}
         AND expires_ts > clock_timestamp()
       ORDER BY acquired_ts ASC
    `;
  }
  return sql<GranularHolder[]>`
    SELECT node, mode, owner, owner_label, lock_id::text AS lock_id, intent, acquired_ts, expires_ts
      FROM agent_granular_locks
     WHERE coordination_domain = ${coordinationDomain}
       AND expires_ts > clock_timestamp()
     ORDER BY node ASC, acquired_ts ASC
  `;
}
