/**
 * gateway-stall-store.ts — durable write-through for inference-gateway rate-limit
 * STALL candidates (EI-2431, follow-up to gateway-rate-limit-stall-autowake P-002/P-003).
 *
 * Problem this closes: `recordStall()` in gateway.ts appends to an in-process ring
 * buffer (`recentStalls`) surfaced on GET /admin/stalls; the stall-waker-loop polls
 * that endpoint every ~20s. Both the ring buffer AND the waker's own `pending` map
 * are volatile — a gateway restart in the window between a stall being recorded and
 * the waker's next poll silently drops it, and the stalled bee is never woken.
 *
 * This store gives the WRITE side (inside the gateway process) a durable target and
 * the READ side (the stall-waker, running in the OPERATOR process which already has
 * PG access) a way to recover a stall that outlived a gateway restart — independent
 * of the gateway's own HTTP contract, which stays untouched (GET /admin/stalls keeps
 * serving straight from the in-memory ring; see stall-waker-loop.ts's `fetchStalls`
 * for how the two sources are merged).
 *
 * Store shape mirrors runtime-vintage.ts: a module-level default Pg store with
 * configure/reset seams so tests inject the in-memory variant and never touch the
 * live row. Global (no workspace filter on read) — the gateway is one process
 * serving bees across every workspace, matching the existing unscoped GET
 * /admin/stalls contract; `workspaceId` is stored for observability only.
 */

import { getOrgPg } from '@papercusp/db-org';

export interface GatewayStallEvent {
  ownerId: string;
  accountId: string;
  soonestResetAt: number;
  /** epoch ms — matches gateway.ts's in-memory StallEvent.at */
  at: number;
}

/** Mirrors gateway.ts's own STALL_MAX_AGE_MS (kept as an independent constant here,
 *  matching this codebase's existing per-file-tuned-constant style, e.g. POLL_MS /
 *  IDLE_SILENCE_MS in stall-waker-loop.ts) — generous vs the waker's 2h pendingTtlMs
 *  give-up window, since this store's job is only "don't grow unbounded", not the
 *  waker's give-up business logic. */
const STALL_MAX_AGE_MS = 4 * 60 * 60_000;

export interface GatewayStallStore {
  /** Best-effort durable write. MUST NOT throw on a reachable-but-slow DB in a way
   *  that blocks the caller for long — callers wrap this in a bounded fire-and-forget
   *  (see gateway.ts's recordStall). Errors are the caller's to log; this rejects. */
  record(e: GatewayStallEvent, workspaceId: string): Promise<void>;
  /** Every stall recorded after `sinceMs`, globally (no workspace scoping — see
   *  module doc). Bounded to recent (age-pruned) rows. */
  listSince(sinceMs: number): Promise<GatewayStallEvent[]>;
}

class PgGatewayStallStore implements GatewayStallStore {
  async record(e: GatewayStallEvent, workspaceId: string): Promise<void> {
    const { sql } = getOrgPg();
    await sql`
      INSERT INTO harness_shared.gateway_stall_events
             (workspace_id, owner_id, account_id, soonest_reset_at, recorded_at_ms)
      VALUES (${workspaceId}, ${e.ownerId}, ${e.accountId}, ${e.soonestResetAt}, ${e.at})
    `;
    // Opportunistic prune (mirrors the in-memory ring's own age-based prune on write) —
    // no separate scheduled reaper needed for a low-volume, short-lived append table.
    const cutoff = Date.now() - STALL_MAX_AGE_MS;
    await sql`DELETE FROM harness_shared.gateway_stall_events WHERE recorded_at_ms < ${cutoff}`;
  }

  async listSince(sinceMs: number): Promise<GatewayStallEvent[]> {
    const { sql } = getOrgPg();
    const cutoff = Date.now() - STALL_MAX_AGE_MS;
    const floor = Math.max(sinceMs, cutoff);
    const rows = await sql<
      Array<{ owner_id: string; account_id: string; soonest_reset_at: string | number; recorded_at_ms: string | number }>
    >`
      SELECT owner_id, account_id, soonest_reset_at, recorded_at_ms
        FROM harness_shared.gateway_stall_events
       WHERE recorded_at_ms > ${floor}
       ORDER BY recorded_at_ms ASC
    `;
    return rows.map((r) => ({
      ownerId: r.owner_id,
      accountId: r.account_id,
      soonestResetAt: Number(r.soonest_reset_at),
      at: Number(r.recorded_at_ms),
    }));
  }
}

/** In-memory variant for tests (mirrors InMemoryRuntimeVintageStore's contract). */
export class InMemoryGatewayStallStore implements GatewayStallStore {
  rows: Array<GatewayStallEvent & { workspaceId: string }> = [];
  async record(e: GatewayStallEvent, workspaceId: string): Promise<void> {
    this.rows.push({ ...e, workspaceId });
    const cutoff = Date.now() - STALL_MAX_AGE_MS;
    this.rows = this.rows.filter((r) => r.at >= cutoff);
  }
  async listSince(sinceMs: number): Promise<GatewayStallEvent[]> {
    const cutoff = Date.now() - STALL_MAX_AGE_MS;
    const floor = Math.max(sinceMs, cutoff);
    return this.rows
      .filter((r) => r.at > floor)
      .sort((a, b) => a.at - b.at)
      .map(({ ownerId, accountId, soonestResetAt, at }) => ({ ownerId, accountId, soonestResetAt, at }));
  }
}

let store: GatewayStallStore = new PgGatewayStallStore();

/** Swap the backing store (tests inject InMemoryGatewayStallStore). */
export function configureGatewayStallStore(next: GatewayStallStore): void {
  store = next;
}

/** Restore the default Pg store (afterEach in tests). */
export function resetGatewayStallStore(): void {
  store = new PgGatewayStallStore();
}

/** Durable write. See GatewayStallStore.record — callers must bound/guard this
 *  themselves (gateway.ts fires it with a timeout race, never awaiting it inline
 *  on the request-serving hot path). */
export async function recordGatewayStall(e: GatewayStallEvent, workspaceId: string): Promise<void> {
  return store.record(e, workspaceId);
}

/** Every durably-recorded stall since `sinceMs` (see GatewayStallStore.listSince). */
export async function listGatewayStallsSince(sinceMs: number): Promise<GatewayStallEvent[]> {
  return store.listSince(sinceMs);
}
