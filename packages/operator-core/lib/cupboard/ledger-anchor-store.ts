/**
 * Postgres persistence for hourly ledger anchoring
 * (agent-economy-flywheel-2026-08-30 P-041, D-024; schema: migration 1289).
 *
 *   - pgLedgerAnchorStore: the anchor log's leaves and the published anchors.
 *     Both tables are append-only by trigger, and leaves must be contiguous
 *     from 0 (also enforced by trigger), so a lost append race surfaces as
 *     `conflict` and never as a gap.
 *   - pgAnchorLinkFeed: every ledger_chain_links row (P-040) of a workspace,
 *     the leaves the log must eventually hold.
 *   - anchorWorkspaces: the workspaces that have chain links to anchor.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import type { AnchorLeaf, AnchorLinkFeed, LedgerAnchorStore, StoredAnchor, StoredAnchorLeaf } from './ledger-anchor';

/** The log id published with every anchor of a workspace's log. */
export function ledgerAnchorLogId(workspaceId: string): string {
  return `papercusp:${workspaceId}`;
}

function toSafeInt(value: unknown, what: string): number {
  const n = typeof value === 'bigint' ? Number(value) : typeof value === 'string' ? Number(value) : (value as number);
  if (!Number.isSafeInteger(n)) throw new Error(`ledger anchor: ${what} = ${String(value)} is not a safe integer`);
  return n;
}

/** Unique violation, or the contiguity trigger refusing a stale next index: both mean another writer won. */
const isLostRace = (error: unknown): boolean => {
  const code = (error as { code?: string }).code;
  return code === '23505' || code === '23514';
};

interface LeafRow {
  leaf_index: string | number;
  stream_id: string;
  seq: string | number;
  entry_hash: string;
  leaf_hash: string;
}

interface AnchorRow {
  anchor_seq: string | number;
  log_id: string;
  log_root: string;
  tree_size: string | number;
  window_start: string | number;
  window_end: string | number;
  consistency_from: string | number;
  consistency_proof: unknown;
  backend: string;
  chain_id: number | null;
  anchor_ref: string;
  tx_hash: string | null;
  attester: string | null;
}

/** `harness_shared.ledger_anchor_leaves` + `harness_shared.ledger_anchors` (migration 1289). */
export function pgLedgerAnchorStore(sql?: Sql): LedgerAnchorStore {
  const db = (): Sql => sql ?? getOrgPg().sql;
  return {
    async leaves(workspaceId) {
      const rows = (await db().unsafe(
        `SELECT leaf_index, stream_id, seq, entry_hash, leaf_hash
           FROM harness_shared.ledger_anchor_leaves
          WHERE workspace_id = $1
          ORDER BY leaf_index ASC`,
        [workspaceId],
      )) as unknown as LeafRow[];
      return rows.map((row, i) => {
        const leafIndex = toSafeInt(row.leaf_index, 'leaf_index');
        if (leafIndex !== i) throw new Error(`ledger anchor: leaf log for ${workspaceId} has a gap at ${i}`);
        return {
          leafIndex,
          streamId: row.stream_id,
          seq: toSafeInt(row.seq, 'seq'),
          entryHash: row.entry_hash,
          leafHash: row.leaf_hash,
        };
      });
    },
    async appendLeaves(workspaceId, leaves: readonly StoredAnchorLeaf[]) {
      if (leaves.length === 0) return 'ok';
      const params: unknown[] = [];
      const tuples = leaves.map((leaf) => {
        const base = params.length;
        params.push(workspaceId, leaf.leafIndex, leaf.streamId, leaf.seq, leaf.entryHash, leaf.leafHash);
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
      });
      try {
        // One statement: the whole batch commits or none of it does.
        await db().unsafe(
          `INSERT INTO harness_shared.ledger_anchor_leaves
             (workspace_id, leaf_index, stream_id, seq, entry_hash, leaf_hash)
           VALUES ${tuples.join(', ')}`,
          params as never[],
        );
        return 'ok';
      } catch (error) {
        if (isLostRace(error)) return 'conflict';
        throw error;
      }
    },
    async anchors(workspaceId) {
      const rows = (await db().unsafe(
        `SELECT anchor_seq, log_id, log_root, tree_size, window_start, window_end, consistency_from,
                consistency_proof, backend, chain_id, anchor_ref, tx_hash, attester
           FROM harness_shared.ledger_anchors
          WHERE workspace_id = $1
          ORDER BY anchor_seq ASC`,
        [workspaceId],
      )) as unknown as AnchorRow[];
      return rows.map(
        (row): StoredAnchor => ({
          anchorSeq: toSafeInt(row.anchor_seq, 'anchor_seq'),
          logId: row.log_id,
          logRoot: row.log_root,
          treeSize: toSafeInt(row.tree_size, 'tree_size'),
          windowStart: toSafeInt(row.window_start, 'window_start'),
          windowEnd: toSafeInt(row.window_end, 'window_end'),
          consistencyFrom: toSafeInt(row.consistency_from, 'consistency_from'),
          consistencyProof: Array.isArray(row.consistency_proof) ? (row.consistency_proof as string[]) : [],
          backend: row.backend,
          chainId: row.chain_id,
          ref: row.anchor_ref,
          txHash: row.tx_hash,
          attester: row.attester,
        }),
      );
    },
    async recordAnchor(workspaceId, a) {
      try {
        await db().unsafe(
          `INSERT INTO harness_shared.ledger_anchors
             (workspace_id, anchor_seq, log_id, log_root, tree_size, window_start, window_end,
              consistency_from, consistency_proof, backend, chain_id, anchor_ref, tx_hash, attester)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14)`,
          [
            workspaceId,
            a.anchorSeq,
            a.logId,
            a.logRoot,
            a.treeSize,
            a.windowStart,
            a.windowEnd,
            a.consistencyFrom,
            JSON.stringify(a.consistencyProof),
            a.backend,
            a.chainId,
            a.ref,
            a.txHash,
            a.attester,
          ] as never[],
        );
        return 'ok';
      } catch (error) {
        if (isLostRace(error)) return 'conflict';
        throw error;
      }
    },
  };
}

/** Every chain link of a workspace (P-040's `ledger_chain_links`). */
export function pgAnchorLinkFeed(sql?: Sql): AnchorLinkFeed {
  const db = (): Sql => sql ?? getOrgPg().sql;
  return {
    async links(workspaceId): Promise<readonly AnchorLeaf[]> {
      const rows = (await db().unsafe(
        `SELECT stream_id, seq, entry_hash
           FROM harness_shared.ledger_chain_links
          WHERE workspace_id = $1
          ORDER BY stream_id ASC, seq ASC`,
        [workspaceId],
      )) as unknown as { stream_id: string; seq: string | number; entry_hash: string }[];
      return rows.map((row) => ({ streamId: row.stream_id, seq: toSafeInt(row.seq, 'seq'), entryHash: row.entry_hash }));
    },
  };
}

/** Workspaces with chain links or anchors (an anchored workspace keeps its hourly cadence). */
export async function anchorWorkspaces(sql?: Sql): Promise<string[]> {
  const rows = (await (sql ?? getOrgPg().sql).unsafe(
    `SELECT workspace_id FROM harness_shared.ledger_chain_links
     UNION
     SELECT workspace_id FROM harness_shared.ledger_anchors
     ORDER BY 1`,
  )) as unknown as { workspace_id: string }[];
  return rows.map((r) => r.workspace_id);
}
