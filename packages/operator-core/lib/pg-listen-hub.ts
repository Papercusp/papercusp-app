/**
 * pg-listen-hub — ONE shared LISTEN connection for the homogeneous wake buses.
 *
 * C1-3 of backend-connection-scaling-2026-06-17. Historically each
 * `postgres().listen()` bus (agent-activity, fleet-assignment, pending-events,
 * coord-inbox, and — since EI-19285171982840672 — sync-sse) opened its OWN
 * dedicated `postgres(getHarnessAdminUrl(), {max:1})` connection — five
 * long-lived PG backends that never close, one per operator-host process.
 * postgres-js multiplexes MULTIPLE `.listen(channel, cb)` calls on ONE `sql`
 * instance onto a single backend (verified), so routing them all through one
 * shared instance collapses 5 backends → 1 per process.
 *
 * `hubListen`'s optional `onListen` callback (per-channel, passed straight
 * through to postgres-js) is what let the fifth bus — sync-sse, whose
 * `onListen` clears an in-process cache on every (re)connect so a NOTIFY that
 * fired during a connection gap can't leave a stale entry behind — join
 * without losing that cold-bust safety net: postgres-js re-invokes each
 * channel's own `onListen` on reconnect-relisten independent of the other
 * channels riding the same shared backend.
 *
 * DEFAULT-ON for server-class hosts (see {@link listenHubEnabled}) — proven live
 * on the :3070 cluster + an integration test, so it no longer ships dark.
 * `PAPERCUSP_LISTEN_HUB=0` is the instant kill-switch back to one dedicated LISTEN
 * connection per bus (the historical, byte-identical behavior). Desktop
 * (laptop/workstation class) stays per-bus. See D-002 @
 * backend-connection-scaling-2026-06-17.
 *
 * Host-only — opens a long-lived PG connection, so only the Hono host imports
 * the buses that import this (never a browser/Vite chunk). LISTEN ONLY: a bus
 * that also runs a query (coord-inbox's peek) routes that query through its own
 * client (getOrgPg().sql), not the hub connection.
 */
import postgres from "postgres";
import { longLivedPoolConnectionOptions } from "@papercusp/db-org";
import { getHarnessAdminUrl } from "./embedded-pg-discovery";
import { getResourceProfile } from "./resource-profile";

/**
 * Whether the shared listen hub is enabled. DEFAULT-ON for server-class hosts
 * (mirrors `pgbouncerEnabled()` — "finished work must not ship dark"):
 *   - `PAPERCUSP_LISTEN_HUB=1` → force ON  (explicit override)
 *   - `PAPERCUSP_LISTEN_HUB=0` → force OFF (kill-switch — instant revert to one
 *      dedicated LISTEN connection per bus, the historical behavior)
 *   - unset → ON for a SERVER-class host (the dev box + any dedicated server /
 *      cluster), OFF for laptop/workstation — every Tauri DESKTOP (single process,
 *      embedded PG: the 4 LISTEN backends are negligible and cross-process
 *      sync-invalidate is moot, so the hub adds risk without benefit there).
 *
 * Gated on `hostClass` (NOT resource-profile `embeddedPg`) for the same reason as
 * `pgbouncerEnabled()`: `detectEmbeddedPg()` misfires on any host with an explicit
 * DATABASE_URL. The hub collapses the 4 homogeneous wake-bus LISTEN backends
 * (agent-activity, fleet-assignment, pending-events, coord-inbox) onto ONE per
 * process, and is REQUIRED under clustering so cross-process sync-invalidate rides
 * PG NOTIFY (operator-scalability-event-loop-2026-06-16). C1-3 / D-002 @
 * backend-connection-scaling-2026-06-17 — proven live on :3070 + integration test.
 */
export function listenHubEnabled(): boolean {
  const flag = process.env.PAPERCUSP_LISTEN_HUB;
  if (flag === "1") return true;
  if (flag === "0") return false;
  try {
    return getResourceProfile().hostClass === "server";
  } catch {
    return false; // resource-profile unreadable → safe default (per-bus direct)
  }
}

/** The single shared LISTEN connection (lazily created, nulled on last unsub). */
let sql: postgres.Sql | null = null;
/** Live subscription count — `.end()`s + nulls `sql` when it returns to zero. */
let subCount = 0;

function ensureSql(): postgres.Sql {
  if (!sql) {
    sql = postgres(getHarnessAdminUrl(), {
      ...longLivedPoolConnectionOptions("listen-hub"),
      max: 1,
      idle_timeout: 0,
    });
  }
  return sql;
}

/**
 * Subscribe a callback to `channel` on the SHARED hub connection. Ref-counts
 * subscriptions; the FIRST subscription lazily opens the connection and the LAST
 * unsubscribe `.end()`s + nulls it. Returns an unsubscribe fn (idempotent).
 *
 * Multiple `hubListen` calls — to the same or different channels — ride the one
 * backend (postgres-js multiplexes `.listen()` over a single connection).
 */
export async function hubListen(
  channel: string,
  cb: (payload: string) => void,
  onListen?: () => void,
): Promise<() => void> {
  const instance = ensureSql();
  subCount++;
  let unlisten: (() => Promise<void>) | null = null;
  try {
    // postgres-js .listen() resolves with a meta object carrying .unlisten().
    // `onListen` (this channel's own 3rd callback) fires on the initial LISTEN
    // AND every reconnect-relisten postgres-js performs after the shared hub
    // connection drops — independent of every other channel riding the same
    // backend, since postgres-js tracks reconnect-relisten per channel. This is
    // what lets a subscriber with cold-bust-on-reconnect semantics (sync-sse's
    // cache clear) move onto the hub without losing that safety net.
    const handle = await instance.listen(channel, cb, onListen);
    unlisten = handle.unlisten;
  } catch (err) {
    // Failed to establish this subscription — undo the ref-count bump and, if we
    // were the only would-be subscriber, tear the just-opened connection down.
    subCount--;
    if (subCount === 0 && sql) {
      const dead = sql;
      sql = null;
      await dead.end({ timeout: 5 }).catch(() => {});
    }
    throw err;
  }

  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    // Best-effort UNLISTEN for this channel (don't block the caller on it).
    if (unlisten) void unlisten().catch(() => {});
    subCount--;
    if (subCount === 0 && sql) {
      const dead = sql;
      sql = null;
      void dead.end({ timeout: 5 }).catch(() => {});
    }
  };
}

/** Test-only — force-close the shared connection and reset the ref-count. */
export async function _stopHubForTests(): Promise<void> {
  if (sql) {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
  sql = null;
  subCount = 0;
}
