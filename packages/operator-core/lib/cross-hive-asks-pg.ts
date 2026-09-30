/**
 * cross-hive-asks-pg — the durable ask ledger for the cross-Hive boundary, the
 * ASKING side (hive-network-surface-2026-06-11 P-002, contract C-1). One row per
 * cross-Hive request this Hive tracks, so the request lifecycle survives a
 * restart that the ephemeral onReply callback could not: a Queen's outbound ask
 * is recorded `queued`, marked `sent` once delivered, and a later answer/decline
 * correlates back to its row (by correlation_id) to land `answered`/`declined`
 * with the reply body — replacing onReply as the production reply path.
 *
 * State machine (the legality guard below, mirrored by the CHECK in migration 231):
 *   queued -> sent -> answered | declined ; queued | sent -> expired
 * answered / declined / expired are terminal. Same-state re-application is an
 * idempotent no-op (store-and-forward redelivers).
 *
 * Scoped to ONE asking Hive (workspace_id, hive_slug). Local-only (does NOT
 * federate). Storage: harness_shared.cross_pot_asks (migration 231), mirroring
 * the cross_hive_outbox (migration 196) conventions. Pass an optional `sql` so
 * integration tests use a per-file test schema; production omits it and the
 * shared org pool is used.
 */
import type { Sql, TransactionSql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import type { CrossHiveRequestKind, CrossHiveReplyKind } from './cross-hive-transport';

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

/** Who initiated the request: `out` = we asked a peer; `in` = a peer asked us. */
export type CrossHiveAskDirection = 'out' | 'in';
/** Request kind — the grant-gated kinds carried through the boundary. */
export type CrossHiveAskKind = CrossHiveRequestKind; // 'ask' | 'work-request'
/** Lifecycle state of a ledgered request. */
export type CrossHiveAskState = 'queued' | 'sent' | 'answered' | 'declined' | 'expired';

/** A ledgered cross-Hive request (timestamps are ISO strings). */
export interface CrossHiveAsk {
  id: string;
  workspaceId: string;
  potSlug: string;
  peerPubkey: string;
  direction: CrossHiveAskDirection;
  kind: CrossHiveAskKind;
  subject: string;
  body: string;
  correlationId: string;
  state: CrossHiveAskState;
  replyBody: string | null;
  replyTs: string | null;
  /**
   * The ownerId (coord identity) of the agent that initiated this OUT ask
   * (hive-network-surface P-014). When present, the C-4 reply event fires
   * with `to: [askedBy]` so a sleeping Queen is woken on the answer without
   * polling. NULL for IN rows (we are the answerer) or pre-235 rows.
   */
  askedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/* ── State machine ─────────────────────────────────────────────────────────────── */

/**
 * The legal forward transitions. Pure + exported so the state machine is unit-tested
 * without a database. Does NOT include same-state (idempotency is the store's job).
 */
export const CROSS_HIVE_ASK_TRANSITIONS: Readonly<Record<CrossHiveAskState, readonly CrossHiveAskState[]>> = {
  queued: ['sent', 'expired'],
  sent: ['answered', 'declined', 'expired'],
  answered: [],
  declined: [],
  expired: [],
};

export const CROSS_HIVE_ASK_STATES: readonly CrossHiveAskState[] = [
  'queued',
  'sent',
  'answered',
  'declined',
  'expired',
];
export const TERMINAL_CROSS_HIVE_ASK_STATES: readonly CrossHiveAskState[] = ['answered', 'declined', 'expired'];

/** True iff `from -> to` is a legal forward edge (excludes same-state no-ops). */
export function isLegalCrossHiveAskTransition(from: CrossHiveAskState, to: CrossHiveAskState): boolean {
  return (CROSS_HIVE_ASK_TRANSITIONS[from] ?? []).includes(to);
}

/** Thrown by the strict `transition` primitive on an illegal edge. */
export class CrossHiveAskTransitionError extends Error {
  constructor(
    readonly from: CrossHiveAskState,
    readonly to: CrossHiveAskState,
    readonly id: string,
  ) {
    super(`illegal cross_hive_asks transition ${from} -> ${to} (id=${id})`);
    this.name = 'CrossHiveAskTransitionError';
  }
}

/** Result of recordReply — leniently classifies the outcome so the receive path never throws. */
export type RecordReplyResult =
  | { outcome: 'applied'; ask: CrossHiveAsk }
  | { outcome: 'duplicate'; ask: CrossHiveAsk } // already in this reply state (redelivery)
  | { outcome: 'conflict'; ask: CrossHiveAsk } // terminal in a different state (e.g. expired, opposite reply)
  | { outcome: 'not-found' };

/* ── Row mapping ───────────────────────────────────────────────────────────────── */

interface AskRow {
  id: string;
  workspace_id: string;
  pot_slug: string;
  peer_pubkey: string;
  direction: string;
  kind: string;
  subject: string;
  body: string;
  correlation_id: string;
  state: string;
  reply_body: string | null;
  reply_ts: Date | string | null;
  asked_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIso(v: Date | string | null): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function rowToAsk(r: AskRow): CrossHiveAsk {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    potSlug: r.pot_slug,
    peerPubkey: r.peer_pubkey,
    direction: r.direction as CrossHiveAskDirection,
    kind: r.kind as CrossHiveAskKind,
    subject: r.subject,
    body: r.body,
    correlationId: r.correlation_id,
    state: r.state as CrossHiveAskState,
    replyBody: r.reply_body,
    replyTs: toIso(r.reply_ts),
    askedBy: r.asked_by ?? null,
    createdAt: toIso(r.created_at)!,
    updatedAt: toIso(r.updated_at)!,
  };
}

const SELECT_COLS = `id, workspace_id, pot_slug, peer_pubkey, direction, kind, subject, body,
                     correlation_id, state, reply_body, reply_ts, asked_by,
                     created_at, updated_at`;

/* ── Store ─────────────────────────────────────────────────────────────────────── */

export interface InsertCrossHiveAskInput {
  peerPubkey: string;
  kind: CrossHiveAskKind;
  /** The wire-envelope id the eventual reply will correlate to. Unique per Hive. */
  correlationId: string;
  subject?: string;
  body?: string;
  /** Default 'out' (a request we initiated). */
  direction?: CrossHiveAskDirection;
  /** The ownerId of the agent initiating this ask (hive-network-surface P-014 item 4).
   *  When set, the C-4 reply event fires with `to: [askedBy]` so the initiating
   *  agent is woken on the answer. Optional — absent means broadcast path. */
  askedBy?: string;
}

export interface ListCrossHiveAsksFilter {
  state?: CrossHiveAskState;
  states?: readonly CrossHiveAskState[];
  direction?: CrossHiveAskDirection;
  peerPubkey?: string;
  kind?: CrossHiveAskKind;
  limit?: number;
}

/** PG-backed cross-Hive ask ledger for one asking Hive. */
export class PgCrossHiveAsks {
  constructor(
    private readonly workspaceId: string,
    private readonly potSlug: string,
    private readonly sql?: Sql,
  ) {}

  /**
   * Record a new request in state `queued`. Idempotent on (workspace, hive,
   * correlation_id): a re-insert with the same correlation_id returns the
   * existing row rather than raising a unique violation.
   */
  async insert(input: InsertCrossHiveAskInput): Promise<CrossHiveAsk> {
    const direction = input.direction ?? 'out';
    const kind = input.kind;
    if (kind !== 'ask' && kind !== 'work-request') throw new Error(`invalid cross_hive_asks kind: ${kind}`);
    if (direction !== 'out' && direction !== 'in') throw new Error(`invalid cross_hive_asks direction: ${direction}`);
    const s = pg(this.sql);
    const rows = (await s.unsafe(
      `INSERT INTO harness_shared.cross_pot_asks
         (workspace_id, pot_slug, peer_pubkey, direction, kind, subject, body, correlation_id, state, asked_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9)
       ON CONFLICT (workspace_id, pot_slug, correlation_id) DO NOTHING
       RETURNING ${SELECT_COLS}`,
      [
        this.workspaceId,
        this.potSlug,
        input.peerPubkey,
        direction,
        kind,
        input.subject ?? '',
        input.body ?? '',
        input.correlationId,
        input.askedBy ?? null,
      ],
    )) as unknown as AskRow[];
    if (rows.length > 0) return rowToAsk(rows[0]);
    const existing = await this.getByCorrelationId(input.correlationId);
    if (!existing) throw new Error(`cross_hive_asks insert conflicted but no existing row for ${input.correlationId}`);
    return existing;
  }

  async getById(id: string): Promise<CrossHiveAsk | null> {
    const s = pg(this.sql);
    const rows = (await s.unsafe(
      `SELECT ${SELECT_COLS} FROM harness_shared.cross_pot_asks
        WHERE workspace_id=$1 AND pot_slug=$2 AND id=$3`,
      [this.workspaceId, this.potSlug, id],
    )) as unknown as AskRow[];
    return rows.length ? rowToAsk(rows[0]) : null;
  }

  async getByCorrelationId(correlationId: string): Promise<CrossHiveAsk | null> {
    const s = pg(this.sql);
    const rows = (await s.unsafe(
      `SELECT ${SELECT_COLS} FROM harness_shared.cross_pot_asks
        WHERE workspace_id=$1 AND pot_slug=$2 AND correlation_id=$3`,
      [this.workspaceId, this.potSlug, correlationId],
    )) as unknown as AskRow[];
    return rows.length ? rowToAsk(rows[0]) : null;
  }

  /** List rows, most-recent-first, filtered. Used by pot:asks + the Network board. */
  async list(filter: ListCrossHiveAsksFilter = {}): Promise<CrossHiveAsk[]> {
    const where: string[] = ['workspace_id=$1', 'pot_slug=$2'];
    const params: unknown[] = [this.workspaceId, this.potSlug];
    const states = filter.states ?? (filter.state ? [filter.state] : undefined);
    if (states && states.length) {
      params.push(states as unknown as string[]);
      where.push(`state = ANY($${params.length}::text[])`);
    }
    if (filter.direction) {
      params.push(filter.direction);
      where.push(`direction=$${params.length}`);
    }
    if (filter.peerPubkey) {
      params.push(filter.peerPubkey);
      where.push(`peer_pubkey=$${params.length}`);
    }
    if (filter.kind) {
      params.push(filter.kind);
      where.push(`kind=$${params.length}`);
    }
    let q = `SELECT ${SELECT_COLS} FROM harness_shared.cross_pot_asks
              WHERE ${where.join(' AND ')}
              ORDER BY created_at DESC, id DESC`;
    if (typeof filter.limit === 'number' && filter.limit > 0) {
      params.push(Math.floor(filter.limit));
      q += ` LIMIT $${params.length}`;
    }
    const rows = (await pg(this.sql).unsafe(q, params as never[])) as unknown as AskRow[];
    return rows.map(rowToAsk);
  }

  /** Count rows per state (all states zero-filled), optionally narrowed by peer/direction. */
  async counts(filter: { peerPubkey?: string; direction?: CrossHiveAskDirection } = {}): Promise<Record<CrossHiveAskState, number>> {
    const where: string[] = ['workspace_id=$1', 'pot_slug=$2'];
    const params: unknown[] = [this.workspaceId, this.potSlug];
    if (filter.peerPubkey) {
      params.push(filter.peerPubkey);
      where.push(`peer_pubkey=$${params.length}`);
    }
    if (filter.direction) {
      params.push(filter.direction);
      where.push(`direction=$${params.length}`);
    }
    const rows = (await pg(this.sql).unsafe(
      `SELECT state, COUNT(*)::int AS n FROM harness_shared.cross_pot_asks
        WHERE ${where.join(' AND ')} GROUP BY state`,
      params as never[],
    )) as unknown as { state: string; n: number }[];
    const out: Record<CrossHiveAskState, number> = {
      queued: 0,
      sent: 0,
      answered: 0,
      declined: 0,
      expired: 0,
    };
    for (const r of rows) {
      if (r.state in out) out[r.state as CrossHiveAskState] = Number(r.n);
    }
    return out;
  }

  /**
   * Count requests exchanged with one peer in one direction since `sinceMs`
   * (epoch-ms) — the P-013 rolling-window rate-cap counter. Counts by
   * `created_at` regardless of state: an answered ask still consumed quota
   * when it was made.
   */
  async countRecentByPeer(
    peerPubkey: string,
    direction: CrossHiveAskDirection,
    sinceMs: number,
  ): Promise<number> {
    const rows = (await pg(this.sql).unsafe(
      `SELECT COUNT(*)::int AS n FROM harness_shared.cross_pot_asks
        WHERE workspace_id=$1 AND pot_slug=$2 AND peer_pubkey=$3 AND direction=$4
          AND created_at > to_timestamp($5::double precision / 1000.0)`,
      [this.workspaceId, this.potSlug, peerPubkey, direction, sinceMs],
    )) as unknown as { n: number }[];
    return rows.length ? Number(rows[0].n) : 0;
  }

  /**
   * Strict transition primitive: move a row to `to`, enforcing the legality
   * guard atomically. Returns the updated row, the unchanged row on a same-state
   * no-op, or null if the row does not exist. Throws CrossHiveAskTransitionError
   * on an illegal edge.
   */
  async transition(id: string, to: CrossHiveAskState): Promise<CrossHiveAsk | null> {
    return await pg(this.sql).begin(async (tx) => {
      const cur = await this.getByIdTx(tx, id);
      if (!cur) return null;
      if (cur.state === to) return cur;
      if (!isLegalCrossHiveAskTransition(cur.state, to)) {
        throw new CrossHiveAskTransitionError(cur.state, to, id);
      }
      const rows = (await tx.unsafe(
        `UPDATE harness_shared.cross_pot_asks
            SET state=$4, updated_at=now()
          WHERE workspace_id=$1 AND pot_slug=$2 AND id=$3
          RETURNING ${SELECT_COLS}`,
        [this.workspaceId, this.potSlug, id, to],
      )) as unknown as AskRow[];
      return rowToAsk(rows[0]);
    });
  }

  /** queued -> sent (idempotent). Convenience over `transition`. */
  async markSent(id: string): Promise<CrossHiveAsk | null> {
    return this.transition(id, 'sent');
  }

  /** queued -> sent keyed by correlation_id — the form the outbox drain (B-01) has. */
  async markSentByCorrelationId(correlationId: string): Promise<CrossHiveAsk | null> {
    const row = await this.getByCorrelationId(correlationId);
    if (!row) return null;
    return this.transition(row.id, 'sent');
  }

  /** queued|sent -> expired (idempotent). Convenience over `transition`. */
  async markExpired(id: string): Promise<CrossHiveAsk | null> {
    return this.transition(id, 'expired');
  }

  /**
   * Bulk-expire still-open (queued|sent) rows older than `olderThanMs`. Returns
   * the number of rows expired. A timeout sweep a routine can drive.
   */
  async expireStale(opts: { olderThanMs: number }): Promise<number> {
    const cutoff = new Date(Date.now() - opts.olderThanMs).toISOString();
    const rows = (await pg(this.sql).unsafe(
      `UPDATE harness_shared.cross_pot_asks
          SET state='expired', updated_at=now()
        WHERE workspace_id=$1 AND pot_slug=$2
          AND state IN ('queued','sent')
          AND created_at < $3
        RETURNING id`,
      [this.workspaceId, this.potSlug, cutoff],
    )) as unknown as { id: string }[];
    return rows.length;
  }

  /**
   * Persist an inbound reply to the originating ask, correlated by correlation_id
   * — the production reply path replacing onReply. Never throws on an unmatched or
   * conflicting reply (store-and-forward can redeliver / reorder); the outcome is
   * classified so the caller emits the C-4 event only on `applied`. If the local
   * row is still `queued` (a lost markSent), the reply implies delivery so the
   * effective prior state is treated as `sent` — keeping the hop on a legal edge.
   */
  async recordReply(input: {
    correlationId: string;
    replyKind: CrossHiveReplyKind;
    replyBody: string;
  }): Promise<RecordReplyResult> {
    const to: CrossHiveAskState = input.replyKind === 'answer' ? 'answered' : 'declined';
    return await pg(this.sql).begin(async (tx) => {
      const cur = await this.getByCorrelationTx(tx, input.correlationId);
      if (!cur) return { outcome: 'not-found' as const };
      if (cur.state === to) return { outcome: 'duplicate' as const, ask: cur };
      const effectiveFrom: CrossHiveAskState = cur.state === 'queued' ? 'sent' : cur.state;
      if (!isLegalCrossHiveAskTransition(effectiveFrom, to)) {
        return { outcome: 'conflict' as const, ask: cur };
      }
      const rows = (await tx.unsafe(
        `UPDATE harness_shared.cross_pot_asks
            SET state=$4, reply_body=$5, reply_ts=now(), updated_at=now()
          WHERE workspace_id=$1 AND pot_slug=$2 AND id=$3
          RETURNING ${SELECT_COLS}`,
        [this.workspaceId, this.potSlug, cur.id, to, input.replyBody],
      )) as unknown as AskRow[];
      return { outcome: 'applied' as const, ask: rowToAsk(rows[0]) };
    });
  }

  private async getByIdTx(tx: Sql | TransactionSql, id: string): Promise<CrossHiveAsk | null> {
    const rows = (await tx.unsafe(
      `SELECT ${SELECT_COLS} FROM harness_shared.cross_pot_asks
        WHERE workspace_id=$1 AND pot_slug=$2 AND id=$3 FOR UPDATE`,
      [this.workspaceId, this.potSlug, id],
    )) as unknown as AskRow[];
    return rows.length ? rowToAsk(rows[0]) : null;
  }

  private async getByCorrelationTx(tx: Sql | TransactionSql, correlationId: string): Promise<CrossHiveAsk | null> {
    const rows = (await tx.unsafe(
      `SELECT ${SELECT_COLS} FROM harness_shared.cross_pot_asks
        WHERE workspace_id=$1 AND pot_slug=$2 AND correlation_id=$3 FOR UPDATE`,
      [this.workspaceId, this.potSlug, correlationId],
    )) as unknown as AskRow[];
    return rows.length ? rowToAsk(rows[0]) : null;
  }
}
