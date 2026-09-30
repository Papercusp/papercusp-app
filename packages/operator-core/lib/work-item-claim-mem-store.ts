/**
 * work-item-claim-mem-store — an in-memory work-item claim store with the EXACT
 * lease semantics of the SQL store (`work-item-claims.ts` `acquireClaimLocal` et al.),
 * for environments that have no Postgres (decentralized-dispatch-scaling-2026-06-08
 * P-013, the ≥3-Swarm cross-machine claim E2E).
 *
 * # Why this exists
 *
 * The P-013 E2E proves the DISTRIBUTED dispatch dynamics — ≥3 real Swarms claim off a
 * shared Hive backlog with no central dispatcher, the per-Hive authority serializes,
 * the authority is killed mid-run, survivors fail OPEN, and the deterministic reconcile
 * (`work-item-claim-reconcile.ts`) resolves the tolerated double-claims to a single
 * winner per item. Those dynamics live in the AUTHORITY ROUTING + RPC + RECONCILE layer
 * (`authority/lock-authority.ts`, `authority/http-peer-rpc-transport.ts`,
 * `work-item-claim-reconcile.ts`) — all of which this E2E exercises FOR REAL across
 * machines. The one piece that cannot run on a Tier-3 bench frame is the SQL store:
 * a bench frame is deliberately PG-less (it runs only `node --import tsx` against the
 * hyperbee substrate — see `deployment/p2p-perf-tier3/bench-bootstrap.ts`).
 *
 * The claim store is reached only through the `WorkItemClaimCoordinator` SEAM
 * (`work-item-claim-authority-ops.ts`) + the authority op's `local` leg, whose entire
 * purpose is "tests inject a fake (or a real-PG-backed) coordinator". This module is
 * that injected store: it implements acquire/heartbeat/release with semantics that
 * MATCH `acquireClaimLocal` line-for-line (free-grant / steal-lapsed / extend-own /
 * conflict-on-live; owner+claim_id-checked heartbeat & release). The parity is proven
 * by `work-item-claim-mem-store.test.ts`, which runs the SAME scenarios against THIS
 * store and the real SQL store and asserts identical outcomes — so the in-memory store
 * provably does not drift from the SQL one.
 *
 * The real SQL store's own cross-Swarm serialization (authority-fronted) is separately
 * proven on real PG by `work-item-claims-two-instance.integration.test.ts` (N=2) and
 * `work-item-claim-reconcile.integration.test.ts` (fail-open). This store + that
 * coverage + the parity test = the full picture with zero per-frame PG provisioning.
 *
 * Pure, dependency-free (no PG, no React), injectable clock — usable in a child process
 * on a bench frame and in-process in the local-parity test alike.
 */

import { randomUUID } from 'node:crypto';
import type {
  AcquireOpts,
  AcquireResult,
  HeartbeatClaimParams,
  HeartbeatResult,
  ReleaseClaimParams,
  ReleaseClaimForItemParams,
  WorkItemClaim,
} from './work-item-claims';
import { DEFAULT_WORK_ITEM_TTL_SEC, MAX_WORK_ITEM_TTL_SEC } from './work-item-claims';
import type { WorkItemClaimCoordinator } from './work-item-claim-authority-ops';

/** A stored row, time kept as epoch-ms internally for exact lease comparisons. */
interface MemRow {
  workspaceId: string;
  harnessSlug: string;
  workItemId: string;
  potSlug: string | null;
  claimId: string;
  owner: string;
  ownerLabel: string | null;
  holderPubkey: string | null;
  intent: string;
  ttlSec: number;
  acquiredMs: number;
  expiresMs: number;
  lastActivityMs: number;
}

function clampTtl(n: number | undefined): number {
  if (n == null || !Number.isFinite(n) || n <= 0) return DEFAULT_WORK_ITEM_TTL_SEC;
  return Math.min(Math.floor(n), MAX_WORK_ITEM_TTL_SEC);
}

function keyOf(workspaceId: string, harnessSlug: string, workItemId: string): string {
  return `${workspaceId}\x00${harnessSlug}\x00${workItemId}`;
}

/**
 * In-memory work-item claim store. One instance == one Swarm's local store (the same
 * way each machine has its own `papercusp_su`). The PK is (workspace, harness, item):
 * exactly one holder per item, just like the SQL `work_item_claims_pkey`.
 */
export class InMemoryWorkItemClaimStore {
  private readonly rows = new Map<string, MemRow>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** Mirrors `acquireClaimLocal`: free-grant / steal-lapsed / extend-own; else conflict. */
  acquire = (opts: AcquireOpts): Promise<AcquireResult> => {
    const ttlSec = clampTtl(opts.ttlSec);
    const now = this.now();
    const k = keyOf(opts.workspaceId, opts.harnessSlug, opts.workItemId);
    const existing = this.rows.get(k);

    // The SQL ON CONFLICT updates only WHEN expires_ts <= now OR owner = EXCLUDED.owner.
    const canTake =
      !existing || existing.expiresMs <= now || existing.owner === opts.owner;
    if (!canTake) {
      // A LIVE claim held by another owner — refuse, report it (with derived expired).
      return Promise.resolve({ ok: false, conflict: this.toClaim(existing!, now) });
    }
    const row: MemRow = {
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      workItemId: opts.workItemId,
      potSlug: opts.potSlug ?? null,
      claimId: randomUUID(),
      owner: opts.owner,
      ownerLabel: opts.ownerLabel ?? null,
      holderPubkey: opts.holderPubkey ?? null,
      intent: opts.intent ?? '',
      ttlSec,
      acquiredMs: now,
      expiresMs: now + ttlSec * 1000,
      lastActivityMs: now,
    };
    this.rows.set(k, row);
    return Promise.resolve({ ok: true, claim: this.toClaim(row, now) });
  };

  /** Mirrors `heartbeatClaimLocal`: owner + claim_id + not-yet-expired required. */
  heartbeat = (p: HeartbeatClaimParams): Promise<HeartbeatResult> => {
    const now = this.now();
    const k = keyOf(p.workspaceId, p.harnessSlug, p.workItemId);
    const existing = this.rows.get(k);
    const renewable =
      existing &&
      existing.claimId === p.claimId &&
      existing.owner === p.owner &&
      existing.expiresMs > now;
    if (renewable) {
      const ttlSec = p.ttlSecOverride != null ? clampTtl(p.ttlSecOverride) : existing!.ttlSec;
      existing!.ttlSec = ttlSec;
      existing!.expiresMs = now + ttlSec * 1000;
      existing!.lastActivityMs = now;
      return Promise.resolve({
        renewed: true,
        held: true,
        expiresTs: new Date(existing!.expiresMs).toISOString(),
      });
    }
    const held = existing ?? null;
    const isOwnLapsed =
      held != null && held.claimId === p.claimId && held.owner === p.owner && held.expiresMs <= now;
    return Promise.resolve({
      renewed: false,
      held: false,
      expiresTs: null,
      reason:
        held && !isOwnLapsed
          ? 'claim is held by another owner or under a new claim_id'
          : 'claim has lapsed or was released — re-acquire it',
    });
  };

  /** Mirrors `releaseClaimLocal`: owner + claim_id checked; returns whether a row was removed. */
  release = (p: ReleaseClaimParams): Promise<boolean> => {
    const k = keyOf(p.workspaceId, p.harnessSlug, p.workItemId);
    const existing = this.rows.get(k);
    if (existing && existing.claimId === p.claimId && existing.owner === p.owner) {
      this.rows.delete(k);
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  };

  /** Mirrors `releaseClaimForItemLocal` (EI-6832): owner-checked only, NO claim_id
   *  requirement — the base work-item release path never tracks a claimId. */
  releaseForItem = (p: ReleaseClaimForItemParams): Promise<boolean> => {
    const k = keyOf(p.workspaceId, p.harnessSlug, p.workItemId);
    const existing = this.rows.get(k);
    if (existing && existing.owner === p.owner) {
      this.rows.delete(k);
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  };

  /** The current claim on an item (with derived `expired`), or null. */
  getClaim(workspaceId: string, harnessSlug: string, workItemId: string): WorkItemClaim | null {
    const row = this.rows.get(keyOf(workspaceId, harnessSlug, workItemId));
    return row ? this.toClaim(row, this.now()) : null;
  }

  /** All live (non-lapsed) claims for a Hive — the "what's already taken" view. */
  listLiveClaimsForHive(workspaceId: string, potSlug: string): WorkItemClaim[] {
    const now = this.now();
    const out: WorkItemClaim[] = [];
    for (const row of this.rows.values()) {
      if (row.workspaceId === workspaceId && row.potSlug === potSlug && row.expiresMs > now) {
        out.push(this.toClaim(row, now));
      }
    }
    out.sort((a, b) => (a.workItemId < b.workItemId ? -1 : a.workItemId > b.workItemId ? 1 : 0));
    return out;
  }

  /** Every claim this store currently holds (for end-of-run reconcile collection). */
  allClaims(): WorkItemClaim[] {
    const now = this.now();
    return [...this.rows.values()].map((r) => this.toClaim(r, now));
  }

  /** The coordinator seam this store satisfies — pass to registerWorkItemClaimAuthorityOps. */
  asCoordinator(): WorkItemClaimCoordinator {
    return { acquire: this.acquire, heartbeat: this.heartbeat, release: this.release, releaseForItem: this.releaseForItem };
  }

  private toClaim(row: MemRow, now: number): WorkItemClaim {
    return {
      workspaceId: row.workspaceId,
      harnessSlug: row.harnessSlug,
      workItemId: row.workItemId,
      potSlug: row.potSlug,
      claimId: row.claimId,
      owner: row.owner,
      ownerLabel: row.ownerLabel,
      holderPubkey: row.holderPubkey,
      intent: row.intent,
      ttlSec: row.ttlSec,
      acquiredTs: new Date(row.acquiredMs).toISOString(),
      expiresTs: new Date(row.expiresMs).toISOString(),
      lastActivityTs: new Date(row.lastActivityMs).toISOString(),
      expired: row.expiresMs <= now,
    };
  }
}
