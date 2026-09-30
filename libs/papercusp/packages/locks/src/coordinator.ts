/**
 * SuLocksCoordinator — thin adapter that makes the PG-backed SU-locks
 * store satisfy @papercusp/file-claim's FileClaimCoordinator
 * interface (file-locking #11).
 *
 * Workspace is fixed at construction (matches the SU-locks model: a
 * coordinator instance speaks for one coordination domain). Each file-claim
 * method wraps the underlying store call in inWorkspaceTxn with its canonical
 * paths so unrelated claims do not serialize; global reap remains workspace
 * scoped.
 *
 * Implementation notes:
 *   - claimId = the SU-locks lock_id (PG UUID). Stable across the
 *     adapter, the store, and any direct SQL.
 *   - acquire(waitMs=0) → tryAcquire. waitMs>0 is NOT supported in
 *     this first cut (the SU-locks waiter queue is conceptually
 *     different from in-process FIFO; the existing locks:acquire
 *     MCP tool exposes it separately). Conformance only exercises
 *     waitMs=0, so this is sufficient for the alignment value the
 *     interface provides today.
 *   - extend() re-calls tryAcquire with the UNION of existing and
 *     new paths. SU-locks is idempotent on same-owner re-acquire
 *     and returns the same lock_id, so the resulting claim shares
 *     claimId with the input — but per the FileClaimCoordinator
 *     contract the adapter returns a fresh FileClaim OBJECT
 *     (never mutates the input).
 *   - reap drops every lock_id the owner currently holds in this
 *     workspace and cancels any pending waiters, returning the
 *     distinct claim count.
 *   - heartbeat → tryHeartbeat.
 *
 * The store remains the lower-layer surface (used by the MCP tools
 * and the OMP hook); the coordinator is the cross-backend shape used
 * wherever client code wants to be backend-agnostic.
 */

import type {
  AcquireOptions,
  AcquireResult,
  BusyEntry,
  ExtendOptions,
  ExtendResult,
  FileClaim,
  FileClaimCoordinator,
  HeartbeatResult,
} from '@papercusp/file-claim';
import { inWorkspaceTxn } from './in-workspace-txn';
import {
  tryAcquire,
  tryHeartbeat,
  tryRelease,
  type AcquireBusy,
} from './su-lock-store';
import type { Sql } from 'postgres';

const DEFAULT_TTL_SEC = 1200;

export interface SuLocksCoordinatorOptions {
  coordinationDomain: string;
}

export class SuLocksCoordinator implements FileClaimCoordinator {
  private readonly coordinationDomain: string;

  constructor(opts: SuLocksCoordinatorOptions) {
    this.coordinationDomain = opts.coordinationDomain;
  }

  async acquire(
    owner: string,
    paths: readonly string[],
    options: AcquireOptions = {},
  ): Promise<AcquireResult> {
    const ttlSec = options.ttlMs
      ? Math.max(1, Math.round(options.ttlMs / 1000))
      : DEFAULT_TTL_SEC;
    return inWorkspaceTxn(this.coordinationDomain, owner, async (tx) => {
      const r = await tryAcquire(tx, {
        coordinationDomain: this.coordinationDomain,
        owner,
        ownerLabel: options.ownerLabel ?? null,
        paths: [...paths],
        intent: options.intent ?? 'file-claim',
        ttlSec,
      });
      if (r.ok) {
        return {
          ok: true,
          claim: {
            claimId: r.lock_id,
            owner,
            paths: [...r.held],
            expiresAt: r.expires_ts,
          },
        };
      }
      return { ok: false, busy: r.busy.map(toBusyEntry) };
    }, { paths });
  }

  async release(claim: FileClaim): Promise<void> {
    await inWorkspaceTxn(this.coordinationDomain, claim.owner, async (tx) => {
      await tryRelease(tx, {
        coordinationDomain: this.coordinationDomain,
        owner: claim.owner,
        lockId: claim.claimId,
        paths: [...claim.paths],
      });
    }, { paths: claim.paths });
  }

  async extend(claim: FileClaim, options: ExtendOptions): Promise<ExtendResult> {
    const adds = options.addPaths ?? [];
    const ttlSec = options.ttlMs
      ? Math.max(1, Math.round(options.ttlMs / 1000))
      : DEFAULT_TTL_SEC;
    const union = Array.from(new Set([...claim.paths, ...adds]));
    return inWorkspaceTxn(this.coordinationDomain, claim.owner, async (tx) => {
      const r = await tryAcquire(tx, {
        coordinationDomain: this.coordinationDomain,
        owner: claim.owner,
        ownerLabel: null,
        paths: union,
        intent: 'file-claim:extend',
        ttlSec,
      });
      if (r.ok) {
        return {
          ok: true,
          claim: {
            claimId: r.lock_id,
            owner: claim.owner,
            paths: [...r.held],
            expiresAt: r.expires_ts,
          },
        };
      }
      // Original claim is intact (SU-locks tryAcquire is atomic on
      // failure — same-owner refresh of the original paths did not
      // happen because Step 2b returned busy before the upsert).
      return { ok: false, busy: r.busy.map(toBusyEntry) };
    }, { paths: union });
  }

  async heartbeat(claim: FileClaim, ttlMs?: number): Promise<HeartbeatResult> {
    const ttlSec = ttlMs ? Math.max(1, Math.round(ttlMs / 1000)) : DEFAULT_TTL_SEC;
    return inWorkspaceTxn(this.coordinationDomain, claim.owner, async (tx) => {
      // tryHeartbeat takes positional args (tx, domain, owner, lockId,
      // ttlSec) and returns { expires_ts, extended } — NOT an object
      // param / { ok } result. (file-locking #11 audit — this call was
      // built against a signature tryHeartbeat never had.)
      const r = await tryHeartbeat(
        tx,
        this.coordinationDomain,
        claim.owner,
        claim.claimId,
        ttlSec,
      );
      if (r.extended) {
        return {
          ok: true,
          claim: {
            claimId: claim.claimId,
            owner: claim.owner,
            paths: [...claim.paths],
            expiresAt: r.expires_ts,
          },
        };
      }
      return { ok: false, expired: true };
    }, { paths: claim.paths });
  }

  async reap(owner: string): Promise<number> {
    return inWorkspaceTxn(this.coordinationDomain, owner, async (tx) => {
      const reaped = await (tx as Sql)<Array<{ n: number }>>`
        WITH d AS (
          DELETE FROM agent_file_locks
           WHERE coordination_domain = ${this.coordinationDomain} AND owner = ${owner}
          RETURNING lock_id
        )
        SELECT COUNT(DISTINCT lock_id)::int AS n FROM d
      `;
      await (tx as Sql)`
        UPDATE agent_lock_waiters
           SET status = 'cancelled'
         WHERE coordination_domain = ${this.coordinationDomain}
           AND owner = ${owner}
           AND status = 'waiting'
      `;
      const n = reaped[0]?.n ?? 0;
      if (n > 0) {
        await (tx as Sql)`SELECT grant_cascade(${this.coordinationDomain}, clock_timestamp())`;
      }
      return n;
    });
  }
}

function toBusyEntry(b: AcquireBusy): BusyEntry {
  return {
    path: b.path,
    owner: b.owner,
    ownerLabel: b.owner_label,
    intent: b.intent,
    expiresAt: b.expires_ts,
  };
}
