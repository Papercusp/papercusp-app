/**
 * createNotifyBus — a thin LISTEN→fan-out bus over a single Postgres NOTIFY
 * channel (agent-tool-delta-protocol-2026-06-22, Lane D / P-010).
 *
 * Generalizes the per-channel listener pattern (agent-activity-bus, coord-inbox-bus):
 * lazy single LISTEN connection (or the shared listen-hub when PAPERCUSP_LISTEN_HUB=1),
 * fan-out the raw NOTIFY payload to every subscriber, and close the connection when the
 * last subscriber unsubscribes. Host-only — opens a long-lived PG connection, so only
 * the Hono host imports it (never a browser/Vite chunk).
 *
 * Each subscriber decides what to do with the payload (typically: drain new rows since
 * its own cursor). This is what lets the /ui|/tui/intents/stream routes drop their 250ms
 * poll: the bus wakes them on each insert instead.
 */
import postgres from "postgres";
import { longLivedPoolConnectionOptions } from "@papercusp/db-org";
import { getHarnessAdminUrl } from "./embedded-pg-discovery";
import { hubListen, listenHubEnabled } from "./pg-listen-hub";

export interface NotifyBus {
  /** Register a wake handler (called with the NOTIFY payload). Returns unsubscribe. */
  subscribe(handler: (payload: string) => void): () => void;
  /** Test-only: force-close the listener + drop all handlers. */
  _stopForTests(): Promise<void>;
}

/** Backoff schedule for a failed LISTEN start (EI-9920): 500ms, 1s, 2s, 4s, capped at 10s. */
const RETRY_INITIAL_MS = 500;
const RETRY_MAX_MS = 10_000;

export function createNotifyBus(channel: string, label: string = channel): NotifyBus {
  const handlers = new Set<(payload: string) => void>();
  let started = false;
  let listenerSql: postgres.Sql | null = null;
  let hubUnsub: (() => void) | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelayMs = RETRY_INITIAL_MS;

  const fanout = (payload: string): void => {
    for (const h of handlers) {
      try {
        h(payload);
      } catch (err) {
        console.error(`[${label}] handler threw:`, err);
      }
    }
  };

  const clearRetry = (): void => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    retryDelayMs = RETRY_INITIAL_MS;
  };

  /**
   * EI-9920: on boot (packaged install, pristine VM first run) the embedded-PG
   * connection can still be churning when the bus's very first `subscribe()`
   * fires — `listen()` throws CONNECTION_DESTROYED. The pre-fix code just
   * reset `started = false` and gave up: with nobody else calling
   * `subscribe()` again for that session, the handler already registered in
   * `handlers` sat forever with no working LISTEN behind it — the bus, and
   * whatever UI intents ride it, silently stayed dead for the whole session.
   * Retry with capped exponential backoff instead, as long as a handler is
   * still registered (a handler that unsubscribed while a retry was pending
   * is caught by `maybeClose`, which cancels it).
   */
  const scheduleRetry = (): void => {
    if (retryTimer || handlers.size === 0) return;
    const delay = retryDelayMs;
    retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void ensureStarted();
    }, delay);
    retryTimer.unref?.();
  };

  /**
   * WI-10004194: bumped by every close. A start still in flight when the last
   * handler leaves belongs to an older generation: the close already ended its
   * pool, which makes postgres.js destroy the pending LISTEN (CONNECTION_DESTROYED).
   * That rejection is our own teardown, not a failed start — it must not be
   * logged as one, and it must not reset state a newer start now owns. A hub
   * subscription that lands after its close is released at once.
   */
  let generation = 0;

  const ensureStarted = async (): Promise<void> => {
    if (started) return;
    started = true;
    const gen = generation;
    try {
      const onNotify = (payload: string) => {
        if (handlers.size === 0) return;
        fanout(payload ?? "");
      };
      if (listenHubEnabled()) {
        const unsub = await hubListen(channel, onNotify);
        if (gen !== generation) {
          unsub();
          return;
        }
        hubUnsub = unsub;
      } else {
        const sql = postgres(getHarnessAdminUrl(), {
          ...longLivedPoolConnectionOptions(`notify-bus:${label}`),
          max: 1,
          // LISTEN: idle by design — never reap for idleness (would drop the subscription).
          idle_timeout: 0,
        });
        listenerSql = sql;
        await sql.listen(channel, onNotify);
        if (gen !== generation) return;
      }
      clearRetry();
    } catch (err) {
      if (gen !== generation) return;
      console.error(`[${label}] failed to start (will retry):`, err);
      started = false;
      listenerSql = null;
      hubUnsub = null;
      scheduleRetry();
    }
  };

  const maybeClose = async (): Promise<void> => {
    if (handlers.size !== 0) return;
    // No subscribers left — cancel any pending retry even if we never
    // actually got a live connection (started === false), or it would fire
    // into an empty bus and leak a connection nobody asked for.
    clearRetry();
    if (!started) return;
    // Also covers a start still in flight: it sees the new generation and
    // stands down instead of reporting our close as its failure.
    generation++;
    started = false;
    const unsub = hubUnsub;
    const sql = listenerSql;
    hubUnsub = null;
    listenerSql = null;
    if (unsub) unsub();
    if (sql) await sql.end({ timeout: 5 }).catch(() => {});
  };

  return {
    subscribe(handler) {
      handlers.add(handler);
      void ensureStarted();
      return () => {
        handlers.delete(handler);
        void maybeClose();
      };
    },
    async _stopForTests() {
      clearRetry();
      generation++;
      if (hubUnsub) {
        hubUnsub();
        hubUnsub = null;
      }
      if (listenerSql) {
        await listenerSql.end({ timeout: 5 }).catch(() => {});
      }
      listenerSql = null;
      started = false;
      handlers.clear();
    },
  };
}
