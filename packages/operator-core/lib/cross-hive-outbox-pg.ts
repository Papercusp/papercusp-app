/**
 * cross-hive-outbox-pg — durable store-and-forward outbox for the cross-Hive
 * boundary (cross-hive-boundary-2026-06-08 P-006). Swaps the in-memory
 * InMemoryCrossHiveOutbox (cross-hive-transport.ts) for a PG-backed one so a
 * directed Hive→Hive envelope survives a crash mid-send or a peer Hive being
 * offline: sendCrossHive enqueues BEFORE the swarm send, flushCrossHiveOutbox
 * redelivers the pending rows on reconnect.
 *
 * Scoped to ONE sending Hive (workspace_id, potSlug). The row stores the full
 * wire envelope (incl. from/to Hive pubkeys + sig) so a pending row reconstructs
 * exactly the bytes the peer verifies. Local-only (does NOT federate). Storage:
 * harness_shared.cross_pot_outbox (migration 196).
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import type { CrossHiveOutbox, CrossHiveWireEnvelope, CrossHiveWireKind } from './cross-hive-transport';

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

interface OutboxRow {
  id: string;
  from_hive_pubkey: string;
  to_hive_pubkey: string;
  kind: string;
  subject: string;
  body: string;
  correlation_id: string | null;
  sig: string;
}

/**
 * A pending envelope WITH its delivery-attempt metadata — what the backoff-aware
 * drain (cross-hive-outbox-drain.ts, hive-network-surface-2026-06-11 P-001)
 * plans over. `attemptCount`/`lastAttemptAt` come from `noteAttempt`.
 */
export interface DetailedPendingEnvelope {
  env: CrossHiveWireEnvelope;
  attemptCount: number;
  /** Epoch ms of the last failed attempt; 0 = never attempted. */
  lastAttemptAt: number;
}

function rowToEnvelope(r: OutboxRow): CrossHiveWireEnvelope {
  const env: CrossHiveWireEnvelope = {
    id: r.id,
    fromHivePubkey: r.from_hive_pubkey,
    toHivePubkey: r.to_hive_pubkey,
    kind: r.kind as CrossHiveWireKind,
    subject: r.subject,
    body: r.body,
    sig: r.sig,
  };
  if (r.correlation_id != null) env.correlationId = r.correlation_id;
  return env;
}

/**
 * PG-backed CrossHiveOutbox for one sending Hive. Pass an optional `sql` client
 * so integration tests can use a per-file test schema; production omits it and
 * the shared org pool is used.
 */
export class PgCrossHiveOutbox implements CrossHiveOutbox {
  constructor(
    private readonly workspaceId: string,
    private readonly potSlug: string,
    private readonly sql?: Sql,
  ) {}

  /** Durably enqueue (idempotent on envelope id — a re-enqueue is a no-op). */
  async enqueue(env: CrossHiveWireEnvelope): Promise<void> {
    const s = pg(this.sql);
    const now = Date.now();
    await s.unsafe(
      `INSERT INTO harness_shared.cross_pot_outbox
         (workspace_id, pot_slug, id, from_hive_pubkey, to_hive_pubkey, kind,
          subject, body, correlation_id, sig, created_at, attempt_count, last_attempt_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,0)
       ON CONFLICT (workspace_id, pot_slug, id) DO NOTHING`,
      [
        this.workspaceId,
        this.potSlug,
        env.id,
        env.fromHivePubkey,
        env.toHivePubkey,
        env.kind,
        env.subject,
        env.body,
        env.correlationId ?? null,
        env.sig,
        now,
      ],
    );
  }

  /** Every still-undelivered envelope for this Hive, oldest-first. */
  async pending(): Promise<CrossHiveWireEnvelope[]> {
    const s = pg(this.sql);
    const rows = (await s.unsafe(
      `SELECT id, from_hive_pubkey, to_hive_pubkey, kind, subject, body, correlation_id, sig
         FROM harness_shared.cross_pot_outbox
        WHERE workspace_id = $1 AND pot_slug = $2
        ORDER BY created_at ASC, id ASC`,
      [this.workspaceId, this.potSlug],
    )) as unknown as OutboxRow[];
    return rows.map(rowToEnvelope);
  }

  /**
   * Every still-undelivered envelope WITH attempt metadata, oldest-first — the
   * read the backoff-aware drain plans over (`pending()` stays the lean
   * CrossHiveOutbox-port read).
   */
  async pendingDetailed(): Promise<DetailedPendingEnvelope[]> {
    const s = pg(this.sql);
    const rows = (await s.unsafe(
      `SELECT id, from_hive_pubkey, to_hive_pubkey, kind, subject, body, correlation_id, sig,
              attempt_count, last_attempt_at
         FROM harness_shared.cross_pot_outbox
        WHERE workspace_id = $1 AND pot_slug = $2
        ORDER BY created_at ASC, id ASC`,
      [this.workspaceId, this.potSlug],
    )) as unknown as Array<OutboxRow & { attempt_count: number; last_attempt_at: number | string }>;
    return rows.map((r) => ({
      env: rowToEnvelope(r),
      attemptCount: Number(r.attempt_count),
      lastAttemptAt: Number(r.last_attempt_at),
    }));
  }

  /** Remove a delivered envelope (idempotent). */
  async markDelivered(id: string): Promise<void> {
    const s = pg(this.sql);
    await s.unsafe(
      `DELETE FROM harness_shared.cross_pot_outbox
        WHERE workspace_id = $1 AND pot_slug = $2 AND id = $3`,
      [this.workspaceId, this.potSlug, id],
    );
  }

  /**
   * Record a failed delivery attempt (bumps attempt_count + last_attempt_at).
   * Not part of the CrossHiveOutbox port — an optional durability/observability
   * hook callers may use to age out or back off poison envelopes.
   */
  async noteAttempt(id: string): Promise<void> {
    const s = pg(this.sql);
    const now = Date.now();
    await s.unsafe(
      `UPDATE harness_shared.cross_pot_outbox
          SET attempt_count = attempt_count + 1, last_attempt_at = $4
        WHERE workspace_id = $1 AND pot_slug = $2 AND id = $3`,
      [this.workspaceId, this.potSlug, id, now],
    );
  }
}
