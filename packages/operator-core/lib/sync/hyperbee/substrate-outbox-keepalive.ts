/**
 * Substrate outbox keepalive — re-boot-on-NOTIFY (P-008, AC#2).
 *
 * Holds a single process-global `pg.listen('substrate_outbox', …)` that watches for
 * NOTIFY payloads written by the DB-level `capture_substrate_outbox_trg` trigger for
 * any local write to a captured table. When a NOTIFY arrives for a harness the reaper
 * has evicted, calls `handleOutboxNotifyForEvictedHarness` to trigger a background
 * re-boot so the drain comes up and the outbox row is consumed — closing the
 * "evicted harness accumulates undrained rows" gap (EI-126 regression guard).
 *
 * One listener per process (not per harness): lighter than per-harness LISTEN and
 * matches the trigger's one-per-write-payload model.
 *
 * The per-harness drain in outbox-drain.ts USED to open its own dedicated pg.listen
 * once the engine re-booted — N harnesses meant N PG backends on this same global
 * channel. That was the other half of P-008 and is now closed: the production seam
 * (wire-outbox.ts) passes `hubListen` into `startOutboxDrain({ listen })`, so those
 * drains ride the shared ref-counted `pg-listen-hub` connection. This keepalive
 * still keeps its OWN listener, deliberately — it must stay up for harnesses the
 * reaper has EVICTED, i.e. exactly when no drain is subscribed to notice.
 */

import type postgres from 'postgres';
import { handleOutboxNotifyForEvictedHarness } from './boot-all';

/** The PG NOTIFY channel that capture_substrate_outbox_trg fires on. */
const NOTIFY_CHANNEL = 'substrate_outbox';

export interface OutboxKeepaliveHandle {
  /** Unlisten + stop. Best-effort; never rejects. */
  stop(): Promise<void>;
}

/**
 * Start the process-global outbox NOTIFY keepalive. The caller owns the
 * returned handle and must call stop() on shutdown.
 *
 * @param pg — a `postgres.Sql` instance. The underlying pg.listen opens a
 *   dedicated LISTEN connection; the caller's pool is unaffected.
 */
export function startSubstrateOutboxKeepalive(pg: postgres.Sql): OutboxKeepaliveHandle {
  let stopped = false;

  // pg.listen returns a Promise<{ unlisten(): Promise<void> }>. Fire-and-forget
  // the setup; errors are caught via the .catch() below so they never crash the
  // caller — a keepalive failure degrades to "no re-boot-on-NOTIFY" (the
  // EI-126 backstop GC still runs; we just lose the hot-path drain trigger).
  const listenReq = pg.listen(NOTIFY_CHANNEL, (payload: string) => {
    if (stopped) return;
    // Payload format: "${workspaceId}::${harnessSlug}" (same as the handle-map key).
    // Use indexOf to avoid splitting on a potential '::' in a future slug (defensive).
    const sep = payload.indexOf('::');
    if (sep < 0) return; // malformed — skip
    const workspaceId = payload.slice(0, sep);
    const harnessSlug = payload.slice(sep + 2);
    if (!workspaceId || !harnessSlug) return; // paranoid empty-segment check
    handleOutboxNotifyForEvictedHarness(workspaceId, harnessSlug);
  });

  // Surface setup errors as a console warning (never throw into the caller).
  void Promise.resolve(listenReq).catch((e: unknown) => {
    if (stopped) return;
    console.error(
      '[substrate-outbox-keepalive] pg.listen setup failed (re-boot-on-NOTIFY disabled):',
      e instanceof Error ? e.message : String(e),
    );
  });

  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      try {
        const req = await listenReq;
        await req.unlisten();
      } catch {
        // best-effort — the connection may already be dead
      }
    },
  };
}
