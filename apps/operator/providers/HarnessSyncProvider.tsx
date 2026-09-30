'use client';

/**
 * HarnessSyncProvider — wraps every /harness/* route with a SyncProvider.
 *
 * (Renamed from `HarnessZeroProvider` 2026-06-22: the name was a leftover from
 * the retired Rocicorp-Zero client transport — see the History note below — and
 * misleadingly implied this provider still uses Zero. It is purely SSE now.)
 *
 * Transport: **SSE for every runtime** (desktop Tauri shell *and* plain
 * browser). Local installs use `/api/zero-harness/sse`; the hosted static
 * shell opts into its authenticated `/api/hosted/browser/sse` contract via
 * the server-injected marker. Both paths share this adapter and scheduler.
 *
 * History: the browser path used to mount a Zero WebSocket adapter against
 * a separate `zero-cache` process, configured via `/api/runtime-config`'s
 * `zeroServer` field. zero-cache was retired in the Level 1 + Phase 1 SSE
 * cutover (2026-05-07), leaving that WebSocket branch unreachable (the
 * browser silently fell through to `syncType="POLLING"`). The dead
 * `/api/runtime-config` endpoint and the `zeroServer` plumbing were removed
 * 2026-06-03. (`@papercusp/sync` retains the legacy `WEBSOCKETS` type seam for
 * source compatibility, but no WebSocket adapter is mounted by Papercusp.)
 *
 * POLLING is catastrophic here: the dashboard registers ~40 distinct sync
 * queries, and the polling adapter re-fetches *every one of them* via
 * `/api/zero-harness/rest-query` on each interval. ~40 concurrent requests
 * against a browser's 6-connection-per-host HTTP/1.1 cap permanently
 * saturates the pool — every other request on the page (the live-thinking
 * popover's EventSource, on-demand fetches, …) is starved and hangs in
 * `CONNECTING` forever. SSE uses a *single* long-lived connection plus
 * occasional invalidate-driven refetches, so the pool stays healthy.
 *
 * POLLING still exists as the genuine last-resort fallback — `SyncProvider`'s
 * internal `useTransportFallback` drops SSE → POLLING after sustained SSE
 * failure. That is the degraded mode, not the default.
 */
import { useEffect, useState, type ReactNode } from 'react';
import {
  SyncProvider,
  setSyncDeltaCodec,
  CONNECTION_CAPPED_MAX_IN_FLIGHT,
  syncMetrics,
} from '@papercusp/sync';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFlag } from '@/lib/flag-hooks';
import { FLAGS } from '@papercusp/flags';
import { isTauri } from '@/app/_components/SetupWizard/tauri-detect';
import { createSyncDeltaCodec } from './sync-delta-codec';
import { resolveBrowserApiTransport } from "../lib/hosted-browser-api";

const DEFAULT_REST_ENDPOINT = '/api/zero-harness';
// SSE drift-repair tick, NOT a freshness source (EI-278). Under SSE,
// freshness comes from invalidate-driven refetches; this interval only
// repairs pushes lost to an SSE blip or a table missing its bridge entry.
// It was a shared 5_000ms pollIntervalMs — which made every subscribed
// query REST-refetch every 5s ON TOP of SSE (~3.2 fetches/s sustained on
// /adv; the dominant workload behind the 16GB webview OOM, and contrary to
// the "occasional invalidate-driven refetches" intent documented above).
// Worst-case staleness for an unbridged table is now this interval. The
// degraded POLLING fallback keeps the lib's fast pollIntervalMs default —
// there the tick IS the freshness source.
const DEFAULT_SSE_DRIFT_REPAIR_MS = 180_000;
const HOSTED_QUERY_NAME_ALLOWLIST = ['workspaceHosts.control'] as const;

// One QueryClient for the app lifetime. Module-scope (not useMemo) so it
// survives the provider unmount/remount that happens on some route swaps.
const queryClient = new QueryClient();

/** Resolve the endpoint props passed to the shared SyncProvider boundary. */
export function resolveHarnessSyncTransport(): {
  restEndpoint: string;
  endpointOverride?: string;
  queryNameAllowlist?: readonly string[];
} {
  const browserTransport = resolveBrowserApiTransport();
  return {
    restEndpoint: browserTransport.restEndpoint || DEFAULT_REST_ENDPOINT,
    endpointOverride: browserTransport.sseEndpoint,
    queryNameAllowlist:
      browserTransport.mode === 'hosted' ? HOSTED_QUERY_NAME_ALLOWLIST : undefined,
  };
}

/**
 * WI-6253: the sync concurrency gate's 24-wide default is tuned for the
 * Tauri webview→sidecar IPC path, which has no real per-host connection cap.
 * Anything riding a real HTTP connection must use the connection-capped value
 * instead, because WebKitGTK grants ~6 connections per host and standing SSE
 * streams already hold 3-4 of them.
 *
 * D-047 (`no-http-anywhere-2026-07-28`): the parameter is "does IPC actually
 * carry `fetch` RIGHT NOW", proven by `endpoint_ipc_status().client`, never
 * inferred. It used to be `isTauri()` — a `window.__TAURI_INTERNALS__` probe
 * written for the SetupWizard's button captions — which tests SHELL PRESENCE,
 * a different question. The shell can be present while `/api` is demonstrably
 * on HTTP, in three cases:
 *
 *   1. the rollback lever `PAPERCUSP_DESKTOP_IPC=0` — Rust logs verbatim
 *      "endpoint-ipc DISABLED (PAPERCUSP_DESKTOP_IPC=0) — /api on HTTP", and
 *      `IpcStatus.client` reads `'disabled'`;
 *   2. the pre-IPC startup window (`'never-connected'` / `'dial-in-flight'`);
 *   3. a dropped connection (`'dead'`).
 *
 * In all three the old predicate returned `true` and handed the webview the
 * IPC-tuned 24 against a ~6-connection pool — re-arming the exact WI-6253
 * stampede, and doing it precisely when the lever was pulled BECAUSE something
 * was already broken.
 *
 * (Whether 2 is the right FLOOR is a separate, still-open question — WI-6460.
 * This decides only which signal selects it.)
 *
 * Exported as a pure function (rather than inlined in the component) so this
 * decision is unit-testable without mounting React.
 */
export function resolveMaxInFlightFetches(ipcCarriesFetch: boolean): number | undefined {
  // undefined ⇒ SyncProvider's own default (DEFAULT_MAX_IN_FLIGHT, IPC-tuned).
  return ipcCarriesFetch ? undefined : CONNECTION_CAPPED_MAX_IN_FLIGHT;
}

/**
 * Ask the shell whether the IPC bridge is actually connected.
 *
 * Reads the STRUCTURED `IpcStatus.client` flag, never `resolution_detail`
 * prose — the infer-from-a-string class D-005 exists to retire, and the same
 * read D-008 established for `ipcOwnerIsContentOrigin`.
 *
 * Fails CAPPED in every ambiguous direction: no Tauri, an older shell whose
 * `IpcStatus` predates the field, a rejected invoke, or any state other than
 * `connected`. Over-capping costs a little latency; under-capping is the
 * stampede this exists to prevent.
 */
export async function assertIpcCarriesFetch(): Promise<boolean> {
  return (await readIpcClient()) === 'connected';
}

async function readIpcClient(): Promise<string | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const status = await invoke<{ client?: string }>('endpoint_ipc_status');
    return status?.client ?? null;
  } catch {
    return null;
  }
}

/** Bounded startup poll — how long to keep asking before settling for capped. */
const IPC_ASSERT_TIMEOUT_MS = 30_000;
const IPC_ASSERT_INTERVAL_MS = 500;

/**
 * Make the bounded fallback visible after it settles. The warning is the
 * immediate operator signal; the metrics fields are the durable in-page
 * evidence available to the health panel and DevTools snapshot.
 */
export function reportIpcAssertionTimeout(lastClient: string | null): void {
  syncMetrics.recordIpcAssertionTimeout(lastClient);
  // eslint-disable-next-line no-console
  console.warn(
    `[HarnessSyncProvider] IPC fetch assertion timed out after ${IPC_ASSERT_TIMEOUT_MS}ms; ` +
      `remaining connection-capped. Last observed client: ${lastClient ?? 'unknown'}.`,
  );
}

/**
 * Start CAPPED; raise only once IPC is PROVEN to carry fetch.
 *
 * The assertion is an async `invoke`, so it cannot be read during the render
 * that first builds the gate — hence start-capped-then-raise rather than a
 * drop-in swap. Raising later is free: `SSEAdapter`'s memo deps include
 * `maxInFlightFetches`, so a change re-runs `getQueryFetcher`, which retunes
 * the EXISTING gate in place (`setLimit` + `pump`) rather than minting a
 * second one.
 *
 * ⚠ There is no webview-visible PUSH signal for IPC readiness. The
 * `PAPERCUSP_IPC_READY` handshake that some @papercusp/sync comments cite as
 * though this layer could observe it is a sidecar→Rust STDOUT line that never
 * reaches the webview — so a bounded poll is the only way to see the startup
 * transition. It stops permanently on the first proof, so steady state is free.
 *
 * KNOWN GAP (deliberate, D-047): an IPC connection that dies MID-SESSION does
 * not re-cap, because the poll has already stopped. Closing that needs a push
 * signal from Rust and is a separate item — recorded, not silently omitted.
 */
export function useIpcCarriesFetch(): boolean {
  const [carries, setCarries] = useState(false);

  useEffect(() => {
    // Shell ABSENCE is a sound negative: with no Tauri runtime there is no IPC
    // bridge at all, so fetch is certainly on HTTP and polling would only burn
    // ~60 failing invokes in a dev browser tab. Only the POSITIVE direction
    // (shell present ⇒ on IPC) is the unsound inference D-047 removes.
    if (!isTauri()) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + IPC_ASSERT_TIMEOUT_MS;
    let lastClient: string | null = null;

    const poll = async () => {
      if (cancelled) return;
      lastClient = await readIpcClient();
      if (lastClient === 'connected') {
        if (!cancelled) setCarries(true);
        return; // proven — stop asking
      }
      if (cancelled) return;
      if (Date.now() >= deadline) {
        reportIpcAssertionTimeout(lastClient);
        return;
      }
      timer = setTimeout(poll, IPC_ASSERT_INTERVAL_MS);
    };
    void poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return carries;
}

// One rows-delta codec for the app lifetime (P-006). Injected into @papercusp/sync only while
// FLAGS.SYNC_RESOURCE_DELTA is ON (the effect below); OFF ⇒ no codec ⇒ full re-fetches, as today.
const syncDeltaCodec = createSyncDeltaCodec();

/**
 * WI-6656: the persisted sync cache (WI-3318, `enablePersistedSyncCache()` in
 * RootSyncProvider) dehydrates every SUCCESSFUL query in this app's shared
 * QueryClient. Measured live 2026-07-28: a handful of queries dominate the
 * payload (`plans.attention` ~1002KB, `plans.list` ~800KB, `operatorTurns.page`
 * ~421KB, `advRoster.list` ~254KB; a second `operatorTurns.byConversation` ~421KB
 * was in this measurement and is now GONE — P-025 merged it into operatorTurns.page,
 * so that whole 421KB is no longer fetched at all, let alone persisted) —
 * together enough to blow the ~5MB localStorage quota (3236KB dehydrated vs the
 * 4MiB `maxBytes` guard, before UTF-16 overhead), so the snapshot never wrote
 * at all and the reload-paints-from-disk benefit was entirely unrealized.
 *
 * Excluding these opts them out of PERSISTENCE only (`meta.persist = false` —
 * see `SyncProviderProps.persistExcludeQueryNames`); they keep polling/SSE
 * exactly as before and still populate the live in-memory cache. Excluding
 * them brings the remaining snapshot well under budget so the small,
 * high-value queries persist as designed.
 */
const PERSIST_EXCLUDE_QUERY_NAMES = [
  'plans.attention',
  'plans.list',
  'operatorTurns.page',
  'advRoster.list',
] as const;

export function HarnessSyncProvider({
  children,
  userID = 'papercusp-anon',
  ssePollIntervalMs = DEFAULT_SSE_DRIFT_REPAIR_MS,
}: {
  children: ReactNode;
  userID?: string;
  /** SSE drift-repair tick (see DEFAULT_SSE_DRIFT_REPAIR_MS). */
  ssePollIntervalMs?: number;
}) {
  // The hosted shell injects and validates this marker before the deferred
  // bundle runs.  Select the transport once at the provider boundary so a
  // later global mutation cannot retarget an already-mounted session. A normal
  // local install deterministically keeps the legacy endpoint; hosted mode
  // selects only its mounted tenant-aware boundary.
  const [browserTransport] = useState(resolveHarnessSyncTransport);

  // P-006: inject the rows-delta codec while the flag is on (the owner flips it after an attended
  // desktop verify). OFF ⇒ setSyncDeltaCodec(null) ⇒ the batch fetcher serves full re-fetches.
  // D-047: start capped, raise once the shell PROVES IPC is carrying fetch.
  const ipcCarriesFetch = useIpcCarriesFetch();

  const deltaOn = useFlag(FLAGS.SYNC_RESOURCE_DELTA);
  useEffect(() => {
    setSyncDeltaCodec(deltaOn ? syncDeltaCodec : null);
    return () => setSyncDeltaCodec(null);
  }, [deltaOn]);

  return (
    <QueryClientProvider client={queryClient}>
      <SyncProvider
        syncType="SSE"
        userId={userID}
        restEndpoint={browserTransport.restEndpoint}
        endpointOverride={browserTransport.endpointOverride}
        ssePollIntervalMs={ssePollIntervalMs}
        maxInFlightFetches={resolveMaxInFlightFetches(ipcCarriesFetch)}
        persistExcludeQueryNames={PERSIST_EXCLUDE_QUERY_NAMES}
        queryNameAllowlist={browserTransport.queryNameAllowlist}
      >
        {children}
      </SyncProvider>
    </QueryClientProvider>
  );
}
