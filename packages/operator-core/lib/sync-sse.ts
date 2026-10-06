/**
 * Operator wiring of the @papercusp/sync server-half invalidation bus.
 *
 * The generic mechanism (LISTEN fan-out, ring-buffer replay, source-side
 * dedupe, 32KB payload cap, PG-trigger → camelCase bridge) now lives in
 * `@papercusp/sync/server`. This module just injects the operator's
 * domain: the embedded-PG admin URL for the dedicated LISTEN connection,
 * the shared org pool for `pg_notify`, the `'sync_invalidate'` channel,
 * and the `queryNamesForTriggerEvent` bridge.
 *
 * Exports are unchanged (`subscribe`, `backfillSince`, `notifySyncInvalidate`,
 * `SyncEvent`) so every existing emitter + the SSE route keep importing
 * from here.
 *
 * Host-only module: opens a long-lived PG LISTEN connection. Only the
 * Hono host (Node) imports it — Vite bundles `apps/operator-vite/src/`
 * only, so this never reaches a browser chunk.
 */
import postgres from 'postgres';
import { getOrgPg, longLivedPoolConnectionOptions } from '@papercusp/db-org';
import {
  createInvalidationBus,
  type SyncEvent as LibSyncEvent,
  type SubscribeHandle as LibSubscribeHandle,
  type SubscribeOptions as LibSubscribeOptions,
  type NotifyInvalidateOpts,
} from '@papercusp/sync/server';
import { createPgListenSource, createPgNotifySink, type PgSqlLike } from '@papercusp/sync/server/pg';
import { pinModuleState } from '@papercusp/module-singleton';
import { getHarnessAdminUrl } from './embedded-pg-discovery';
import { queryNamesForTriggerEvent } from './sync-resolver/table-to-query-names';
import { getOperatorCache } from './cache/instance';
import { emitSystemEvent } from './events/engine';
import { hubListen, listenHubEnabled } from './pg-listen-hub';

export type SyncEvent = LibSyncEvent;
export type SubscribeHandle = LibSubscribeHandle;
export type SubscribeOptions = LibSubscribeOptions;
export interface Subscriber {
  send: (e: SyncEvent) => void;
}

const CHANNEL = 'sync_invalidate';

// Host-side consumers can keep process-local projections coherent across the
// reuse-port cluster by rebuilding them whenever this process establishes (or
// re-establishes) its LISTEN. A bare NOTIFY is not replayed after a disconnect;
// the reconnect hook is therefore the durable catch-up half of the push rail.
// Pin the set to the realm so dev module re-evaluation cannot register the same
// rebuild hook repeatedly. Pinned through the primitive rather than by hand: a
// hand-rolled `globalThis` slot fixes correctness but is invisible to
// `listModuleDuplications()`, so the central report answers a confident `[]`
// while this module is split. Pinned at MODULE SCOPE exactly once — pinning
// inside the accessor would count every call as an evaluation and manufacture a
// false duplication in that same report.
type InvalidationListenHook = () => void | Promise<void>;

const invalidationListenHooksState = pinModuleState<{ hooks: Set<InvalidationListenHook> }>(
  '__papercuspInvalidationListenHooks__',
  () => ({ hooks: new Set<InvalidationListenHook>() }),
);

function invalidationListenHooks(): Set<InvalidationListenHook> {
  return invalidationListenHooksState.hooks;
}

/**
 * Register a process-local projection rebuild to run on the initial
 * `sync_invalidate` LISTEN and every reconnect. The returned function removes
 * the hook. Hook failures are isolated: one projection must never take down the
 * shared invalidation bus or prevent the other rebuilds.
 */
export function registerInvalidationListenHook(hook: InvalidationListenHook): () => void {
  const hooks = invalidationListenHooks();
  hooks.add(hook);
  return () => void hooks.delete(hook);
}

function runInvalidationListenHooks(): void {
  for (const hook of invalidationListenHooks()) {
    try {
      void Promise.resolve(hook()).catch((e) => {
        console.error('[sync-sse] invalidation LISTEN rebuild hook failed:', e);
      });
    } catch (e) {
      console.error('[sync-sse] invalidation LISTEN rebuild hook failed:', e);
    }
  }
}

/**
 * `createPgListenSource`'s `open()` returns a `PgSqlLike` — something with a
 * `.listen(channel, onNotify, onListen)` + optional `.end()`. When the shared
 * listen-hub is enabled (EI-19285171982840672 / pg-listen-hub.ts), this shim
 * routes `sync_invalidate`'s LISTEN onto that ONE shared per-process backend
 * instead of opening a dedicated connection — the 5th and last of the
 * homogeneous wake buses to join it. `onListen` (the cold-bust cache-clear
 * hook) is passed straight through: postgres-js re-invokes it on reconnect,
 * per-channel, independent of the hub's other subscribers.
 *
 * Never called as a template tag — `createPgListenSource` only calls
 * `.listen()`/`.end()` on what `open()` returns — so the callable half of
 * `PgSqlLike` is a defensive throw, never reached in practice.
 */
function hubBackedListenSource(): PgSqlLike {
  let unsub: (() => void) | null = null;
  const fn = ((..._args: unknown[]) => {
    throw new Error('[sync-sse] hub-backed listen source does not support direct queries');
  }) as unknown as PgSqlLike;
  fn.listen = async (channel, onNotify, onListen) => {
    unsub = await hubListen(channel, onNotify, onListen);
    return undefined;
  };
  fn.end = async () => {
    unsub?.();
    unsub = null;
  };
  return fn;
}

/**
 * Bridge a raw PG-trigger `<schema>.<table>.changed` event to the camelCase query names
 * existing useSyncQuery consumers subscribe to (P-006/P-067) — AND tap it into the in-process
 * reaction matcher (caching-layer-tag-eca KEYSTONE) so the `cache.bumpTags` ECA rule, and any
 * other reaction registered on a `*.changed` key, fire on REAL DB changes. The bus `bridge` is
 * the single per-event hook that carries the trigger's `args` (workspace_id, op, and the row PK
 * from mig 368), so it is the correct place to feed the change stream into the event system.
 *
 * `emitSystemEvent` never throws and the bump is flag-gated downstream (CACHE_TAG_ECA, default
 * ON; OFF ⇒ the rule's `when` is false ⇒ no-op). Non-`.changed` events are ignored. Without this
 * tap the cache layer is built but INERT — nothing invalidates on a real write.
 */
export function bridgeTriggerEvent(
  name: string,
  args?: Record<string, unknown>,
): ReturnType<typeof queryNamesForTriggerEvent> {
  if (name.endsWith('.changed')) {
    const ws = typeof args?.workspace_id === 'string' ? args.workspace_id : undefined;
    emitSystemEvent({ tool: name, args: args ?? {}, ...(ws ? { workspaceId: ws } : {}) });
  }
  return queryNamesForTriggerEvent(name, args);
}

// These query names are low-volume control-plane projections of an agent's
// posture. Their `agent_modes.changed` trigger is meaningful and should reach
// an open popup promptly, but the same targets are also bridged from hot
// sources such as coord_presence. Keep the override keyed by SOURCE + TARGET:
// lowering a target-wide window would re-arm the heartbeat invalidate storm
// that the bus's 90s default is designed to contain (WI-840/WI-37446).
const LOW_VOLUME_AGENT_MODE_QUERY_NAMES = new Set([
  'advRoster.list',
  'agentDetail.byOwner',
  'goals.detail',
]);
const LOW_VOLUME_AGENT_MODE_DEDUPE_WINDOW_MS = 1_000;

function bridgedDedupeWindowMs(queryName: string, sourceEventName: string): number | undefined {
  return sourceEventName === 'harness_shared.agent_modes.changed' &&
    LOW_VOLUME_AGENT_MODE_QUERY_NAMES.has(queryName)
    ? LOW_VOLUME_AGENT_MODE_DEDUPE_WINDOW_MS
    : undefined;
}

// D-012 (plan papercusp-log-performance-remediation-2026-09-23, WI-10004929).
// These list targets aggregate over the whole work_items table, so each refetch
// is expensive. Five hot sources (work_items, harness_features_consolidated,
// engineer_issues, coord_links, spawned_agents) feed them. Under sustained writes
// the bus's 2 s trailing bound, not its 90 s floor, sets the delivered rate.
// Measured 2026-10-01: 51 invalidations per 180 s per target, so every open Work
// Items panel refetched summary + page about every 3.5 s. A 10 s window keeps
// staleness bounded (the library clamps overrides to 15 s) and cuts that rate
// about fivefold. Every other target keeps the 2 s default: a cheap query should
// not pay a freshness cost for an expensive one.
export const EXPENSIVE_LIST_QUERY_NAMES: ReadonlySet<string> = new Set([
  'workItems.summary',
  'workItems.byHarness',
]);
export const EXPENSIVE_LIST_COALESCE_WINDOW_MS = 10_000;

export function bridgedCoalesceWindowMs(queryName: string, _sourceEventName: string): number | undefined {
  return EXPENSIVE_LIST_QUERY_NAMES.has(queryName) ? EXPENSIVE_LIST_COALESCE_WINDOW_MS : undefined;
}

/**
 * Best-effort invalidation notifications can outlive the database they use.
 * This is expected when an integration-test database is torn down while a
 * detached capture is still flushing, and it is also expected when a partial
 * test schema does not contain a projection table. Keep those lifecycle
 * failures quiet, but preserve a loud signal for every other sync failure.
 */
function isExpectedNotifyFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/does not exist/.test(message)) return true;
  const code = (error as { code?: unknown } | null)?.code;
  return (
    code === 'CONNECTION_ENDED' ||
    code === 'CONNECTION_DESTROYED' ||
    /CONNECTION_ENDED|CONNECTION_DESTROYED|Connection ended/i.test(message)
  );
}

const bus = createInvalidationBus({
  // Onto the shared listen-hub when enabled (server-class hosts, default ON —
  // see hubBackedListenSource above); a dedicated single LISTEN connection on
  // the embedded-PG admin URL otherwise (desktop / PAPERCUSP_LISTEN_HUB=0).
  listen: createPgListenSource({
    // EI-18122461766429683: tagged + zombie-safe — this untagged, unreaped singleton
    // (one per operator-host process, never closed on an abrupt kill/restart) was a
    // major contributor to the server-wide PG connection-saturation crit.
    open: () =>
      listenHubEnabled()
        ? hubBackedListenSource()
        : postgres(getHarnessAdminUrl(), {
            ...longLivedPoolConnectionOptions('sync-sse-listen'),
            max: 1,
            idle_timeout: 0,
            connect_timeout: 30,
          }),
    channel: CHANNEL,
    // caching-layer-tag-eca P-017 — cold-bust on (re)connect. Fires on the initial
    // LISTEN AND every reconnect (postgres-js re-issues LISTEN after a dropped
    // connection and re-invokes this `onlisten`). A fire-and-forget
    // `pg_notify('sync_invalidate', …)` → `cache.bumpTags` that fired while this
    // single LISTEN connection was down is NEVER replayed here, so an L1 entry built
    // before the gap could outlive an invalidation it missed. Clearing the entire L1
    // on reconnect makes every entry rebuild — the audit's cold-bust requirement. On
    // the very first connect the L1 is empty, so the clear is a harmless no-op.
    onListen: () => {
      getOperatorCache().clearL1();
      runInvalidationListenHooks();
    },
  }),
  // pg_notify through the shared org pool — same connection budget every
  // other writer manages (opening a fresh client per notify exhausted
  // max_connections when the watcher fired).
  notify: createPgNotifySink({ getSql: () => getOrgPg().sql, channel: CHANNEL }),
  // P-067: bridge raw PG-trigger `<schema>.<table>.changed` events to the
  // camelCase query names existing useSyncQuery consumers subscribe to.
  // caching-layer-tag-eca P-006: pass the trigger's `args` (workspace_id, op,
  // row id from mig 368) so a per-row query can be SCOPE-invalidated by id
  // instead of full-busting; queries without a per-id scope still full-bust.
  bridge: (name, args) => bridgeTriggerEvent(name, args),
  // WI-37446: only low-volume agent-mode projections use the short bridge
  // window; hot sources feeding those same names retain the global 90s guard.
  bridgedDedupeWindowMs,
  // D-012: expensive aggregate list targets get a longer, still-bounded
  // trailing window; every other target keeps the bus default.
  bridgedCoalesceWindowMs,
  log: (m) => console.log(m),
  onError: (where, e) => {
    // The notify path is intentionally detached from writes. A test fixture
    // can therefore close its PG before the notification settles; match the
    // same expected-teardown classifier used by the other fire-and-forget
    // event emitters instead of turning a green test into console noise.
    if (isExpectedNotifyFailure(e)) return;
    console.error(`[sync-sse] ${where} failed:`, e);
  },
});

/**
 * Register an SSE subscriber; lazily starts the LISTEN connection.
 *
 * The optional second argument narrows delivery to THIS subscriber (used by the
 * SSE route to honour a client's declared query-name interest set). It fails
 * open in every ambiguous case — no predicate, a throwing predicate, or any
 * return other than a literal `false` all deliver the event. The annotation
 * MUST keep the `opts` parameter: an explicit narrower type here silently
 * strips it from every caller of this re-export, and the resulting filter would
 * simply never be applied.
 */
export const subscribe: (
  send: (e: SyncEvent) => void,
  opts?: SubscribeOptions,
) => Promise<SubscribeHandle> = bus.subscribe;

/** Replay events newer than `lastEventId` from the 60s ring buffer. */
export const backfillSince: (lastEventId: number) => SyncEvent[] = bus.backfillSince;

/**
 * Eagerly start the `sync_invalidate` LISTEN in THIS process (WI-1547 root-cause
 * fix). The bus starts its single PG LISTEN lazily on the first SSE subscribe —
 * but the cache-ECA (`bridge` → `emitSystemEvent` → `cache.bumpTags`) rides that
 * SAME listen, so a process that never receives an SSE subscriber (a `:3070`
 * reuseport cluster worker serving only MCP/tool HTTP; the staging host) had a
 * cache layer that was built but INERT: entries never invalidated on real writes,
 * and cachedRead's SWR served arbitrarily old snapshots once per idle period
 * (the plans:get ~45-min-stale read-consistency flap, WI-1547). Every operator
 * host process MUST call this at boot (hono-host `startRequestServers`).
 *
 * Bounded retry, fail-soft: a failed attempt is logged and retried (PG may still
 * be coming up at boot); after the attempts are exhausted the host keeps serving
 * (cache degrades to the pre-fix behavior, now bounded by cachedRead's default
 * hard TTL) and the next SSE subscribe retries via the bus's own reset. Once
 * connected, postgres-js re-issues LISTEN on reconnect and the `onListen`
 * cold-bust (`clearL1`) covers any missed-bump gap.
 */
export async function ensureInvalidationListener(
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<boolean> {
  const attempts = Math.max(1, opts.attempts ?? 6);
  const delayMs = opts.delayMs ?? 5_000;
  for (let i = 1; i <= attempts; i++) {
    try {
      await bus.start();
      return true;
    } catch (e) {
      console.error(
        `[sync-sse] invalidation LISTEN start attempt ${i}/${attempts} failed` +
          (i < attempts ? ` (retrying in ${delayMs}ms):` : ' (giving up — cache-ECA inert in this process until an SSE subscribe retries):'),
        e,
      );
      if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false;
}

/**
 * Close this process's `sync_invalidate` LISTEN source during host shutdown.
 *
 * The invalidation bus owns either a dedicated postgres-js connection or a
 * ref-counted slot on the shared listen hub. Exposing the bus's stop seam lets
 * the host send an explicit FIN/UNLISTEN before a recycle; otherwise a killed
 * operator generation can leave an idle LISTEN backend behind until PostgreSQL
 * notices the dead socket.
 */
export async function stopInvalidationListener(): Promise<void> {
  await bus.stop();
}

/**
 * Server-side notify helper. Mutation/watcher code calls this after writes;
 * fires `pg_notify('sync_invalidate', ...)` which the LISTEN above fans out
 * to all SSE subscribers. Dedupe + 32KB payload cap live in the bus.
 */
export const notifySyncInvalidate: (
  name: string,
  args?: Record<string, unknown>,
  data?: unknown[],
  notifyOpts?: NotifyInvalidateOpts,
) => Promise<void> = bus.notifyInvalidate;
