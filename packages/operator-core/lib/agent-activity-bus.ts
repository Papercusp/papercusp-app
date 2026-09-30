/**
 * agent_activity observer — the push side of the cross-CLI activity bridge
 * (papercusp-worker-integration-2026-06-04, D-003).
 *
 * Migration 143 fires `NOTIFY agent_activity` for every
 * `harness_shared.agent_activity` insert (the per-CLI hooks → activity:report write),
 * payload `"<workspace_id>::<owner_id>"`. Unlike coord_inbox there is no
 * human-relevance filter: EVERY activity row is a wake (the fleet view wants the full
 * native tool stream). So this bus is a thin LISTEN→fan-out: on each notification it
 * calls every registered handler with the notified owner_id, and each handler (the
 * /api/activity/stream SSE route) decides — by its own cursor + owner filter — what to
 * push.
 *
 * Mirrors `coord-inbox-bus.ts` / `pending-events-listener.ts`: one dedicated LISTEN
 * connection, lazy start, max 1 connection on the embedded-PG admin URL. Host-only —
 * opens a long-lived PG connection, so only the Hono host imports it (never a
 * browser/Vite chunk).
 *
 * EI-9991: shares EI-9920's fix (createNotifyBus / pg-notify-bus.ts) for the
 * identical no-retry-on-failed-LISTEN defect — a failed `listen()` (e.g.
 * CONNECTION_DESTROYED during embedded-PG boot warmup) used to reset `started =
 * false` and give up with no self-retry, permanently orphaning any handler
 * already registered via `onAgentActivity` (the cross-CLI activity stream would
 * silently stay dark for the whole session). Retries with the same capped
 * exponential backoff (500ms→10s) as long as ≥1 handler is registered, cancelled
 * the instant the last handler unsubscribes. Kept as a bespoke retry (not
 * delegated to `createNotifyBus`) to avoid reshaping this module's owner-id
 * payload parsing / fan-out signature in the same change.
 */
import postgres from "postgres";
import { longLivedPoolConnectionOptions } from "@papercusp/db-org";
import { getHarnessAdminUrl } from "./embedded-pg-discovery";
import { hubListen, listenHubEnabled } from "./pg-listen-hub";

/** A wake handler — invoked once per notification with the notified owner_id (may be
 *  empty). The handler queries new rows itself (by its own cursor + filter). */
type Handler = (ownerId: string) => void;

/** Backoff schedule for a failed LISTEN start (EI-9991, mirrors EI-9920): 500ms, 1s, 2s, 4s, capped at 10s. */
const RETRY_INITIAL_MS = 500;
const RETRY_MAX_MS = 10_000;

const handlers = new Set<Handler>();
let started = false;
let listenerSql: postgres.Sql | null = null;
/** Hub unsubscribe (set only when PAPERCUSP_LISTEN_HUB=1 routes us onto the shared connection). */
let hubUnsub: (() => void) | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelayMs = RETRY_INITIAL_MS;

/** Register a wake handler; lazily starts the single LISTEN. Returns unsubscribe. */
export function onAgentActivity(handler: Handler): () => void {
  handlers.add(handler);
  void ensureStarted();
  return () => {
    handlers.delete(handler);
    void maybeCloseListener();
  };
}

function clearRetry(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  retryDelayMs = RETRY_INITIAL_MS;
}

/** Schedule a retry of `ensureStarted` with capped exponential backoff, as long
 *  as a handler is still registered (EI-9991). */
function scheduleRetry(): void {
  if (retryTimer || handlers.size === 0) return;
  const delay = retryDelayMs;
  retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void ensureStarted();
  }, delay);
  retryTimer.unref?.();
}

/**
 * WI-10004194: bumped by every close. A start still in flight when the last
 * handler leaves belongs to an older generation: the close already ended its
 * pool, which makes postgres.js destroy the pending LISTEN (CONNECTION_DESTROYED).
 * That rejection is our own teardown, not a failed start — it must not be
 * logged as one, and it must not reset state a newer start now owns. A hub
 * subscription that lands after its close is released at once.
 */
let generation = 0;

/** Close the listener if there are no handlers left (cleanup to avoid listener leak). */
async function maybeCloseListener(): Promise<void> {
  if (handlers.size !== 0) return;
  // No subscribers left — cancel any pending retry even if we never actually
  // got a live connection (started === false), or it would fire into an empty
  // bus and leak a connection nobody asked for.
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
}

/** Parse the NOTIFY payload "<workspace_id>::<owner_id>" → owner_id (best-effort). */
export function ownerFromPayload(payload: string | undefined): string {
  if (!payload) return "";
  const idx = payload.indexOf("::");
  return idx >= 0 ? payload.slice(idx + 2) : "";
}

function fanout(ownerId: string): void {
  for (const h of handlers) {
    try {
      h(ownerId);
    } catch (err) {
      console.error("[agent-activity-bus] handler threw:", err);
    }
  }
}

async function ensureStarted(): Promise<void> {
  if (started) return;
  started = true;
  const gen = generation;
  try {
    const onNotify = (payload: string) => {
      if (handlers.size === 0) return;
      fanout(ownerFromPayload(payload));
    };
    if (listenHubEnabled()) {
      const unsub = await hubListen("agent_activity", onNotify);
      if (gen !== generation) {
        unsub();
        return;
      }
      hubUnsub = unsub;
    } else {
      // Assigned straight to the module singleton so pool-idle-timeout-declared
      // still sees this LISTEN site (its allowlist entry must keep matching it).
      listenerSql = postgres(getHarnessAdminUrl(), {
        ...longLivedPoolConnectionOptions("agent-activity-bus"),
        max: 1,
        // LISTEN: idle by design — never reap for idleness (would drop the subscription).
        idle_timeout: 0,
      });
      const sql = listenerSql;
      await sql.listen("agent_activity", onNotify);
      if (gen !== generation) return;
    }
    clearRetry();
  } catch (err) {
    if (gen !== generation) return;
    console.error("[agent-activity-bus] failed to start (will retry):", err);
    started = false;
    listenerSql = null;
    hubUnsub = null;
    scheduleRetry();
  }
}

export async function _stopForTests(): Promise<void> {
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
}
