'use client';

import { Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { PollingAdapter } from './transports/polling/PollingAdapter';
import { useTransportFallback } from './fallback/useTransportFallback';
import { SSEAdapter } from './transports/sse/SSEAdapter';
import { SyncContext } from './SyncContext';
import type { SyncProviderProps, SyncQueryResult, SyncType } from './types';

/**
 * Normalize the public transport preference at the provider boundary.
 *
 * `WEBSOCKETS` remains in `SyncType` for source compatibility with older
 * callers, but the Zero client/adapter was removed. Treating that legacy input
 * as SSE here keeps the fallback state and the pre-mount context honest instead
 * of exposing an impossible WebSocket transport.
 */
export function normalizeSyncType(syncType: SyncType): Exclude<SyncType, 'WEBSOCKETS'> {
  return syncType === 'WEBSOCKETS' ? 'SSE' : syncType;
}

/**
 * Lightweight SyncContext provider used where we can't (yet) mount a real
 * transport adapter:
 *
 *   1. Server-side rendering — no `window`, no EventSource, no polling.
 *   2. The first client render before `mounted` flips (SSR/CSR hydration
 *      parity — see the `mounted` gate below).
 *
 * Children still need a SyncContext so `useSyncQuery` calls don't throw.
 * This provider returns empty data and does not initiate any fetches.
 */
function PendingSyncAdapter({
  children,
  transport,
}: {
  children: ReactNode;
  transport: SyncType;
}) {
  const value = useMemo(() => {
    const emptyResult: SyncQueryResult<unknown> = {
      data: [],
      loading: true,
      fetching: false,
      transport,
      invalidate: () => {},
      error: null,
      // No adapter is mounted yet, so no attempt has been made — let alone
      // failed. No adapter attempt is the honest reading here, and it keeps a consumer's
      // `failureCount > 0` branch (the "failing and retrying" copy) correctly
      // silent during this pre-mount window rather than accusing a read that
      // has not run.
      failureCount: 0,
      failureReason: null,
    };
    return {
      transport,
      useDataImpl: <T,>(_opts: unknown) => emptyResult as SyncQueryResult<T>,
      prefetch: () => {},
    };
  }, [transport]);
  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

/**
 * Renders a sync-transport provider: SSE (primary path for desktop/operator)
 * with a POLLING fallback driven by `useTransportFallback`.
 *
 * The legacy Zero-powered WebSocket transport was removed in Z-2 (2026-06-20).
 * The live path has run on SSE + the sync-resolver REST endpoints since the
 * P-022 cutover (2026-05-25), so `@rocicorp/zero` and the WS adapter were dead
 * code. SSE is the default; a legacy `WEBSOCKETS` preference is normalized to
 * SSE, while an explicit POLLING preference (or an SSE fallback) renders the
 * polling adapter.
 */
export function SyncProvider({
  syncType = 'SSE',
  children,
  userId,
  server,
  restEndpoint,
  pollIntervalMs = 10_000,
  ssePollIntervalMs,
  fallbackDelayMs = 10_000,
  recoveryDelayMs,
  recoveryMaxDelayMs,
  tokenQueryParam,
  endpointOverride,
  visibilityPause,
  maxInFlightFetches,
  persistExcludeQueryNames,
  queryNameAllowlist,
}: SyncProviderProps) {
  const normalizedSyncType = normalizeSyncType(syncType);
  const { activeTransport, onTransportError } = useTransportFallback({
    preferred: normalizedSyncType,
    fallbackDelayMs,
    recoveryDelayMs,
    recoveryMaxDelayMs,
  });

  // SSR/CSR parity: defer mounting the real adapter until after the first
  // client commit so server HTML and the first client render both show the
  // empty PendingSyncAdapter and hydration can't mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const commonProps = {
    userId,
    server,
    restEndpoint,
    pollIntervalMs,
    onTransportError,
    // Shared by both adapters — both drive the same single-query fetcher.
    maxInFlightFetches,
    persistExcludeQueryNames,
    queryNameAllowlist,
    // SSE-only knobs — the polling adapter ignores them.
    tokenQueryParam,
    endpointOverride,
    visibilityPause,
  };

  if (!mounted) {
    return <PendingSyncAdapter transport={normalizedSyncType}>{children}</PendingSyncAdapter>;
  }

  // SSE primary path. The SSEAdapter wraps the polling fetcher (initial load +
  // post-invalidate refetch) and adds an EventSource subscriber. The interval
  // it gets is `ssePollIntervalMs` (the LONG drift-repair tick, default 180s),
  // NOT `pollIntervalMs` — under SSE the tick is gap insurance, not the
  // freshness source (EI-278). Falls back to POLLING via useTransportFallback.
  if (normalizedSyncType === 'SSE' && activeTransport === 'SSE') {
    return (
      <Suspense
        fallback={<PendingSyncAdapter transport="SSE">{children}</PendingSyncAdapter>}
      >
        <SSEAdapter key="sse" {...commonProps} pollIntervalMs={ssePollIntervalMs}>
          {children}
        </SSEAdapter>
      </Suspense>
    );
  }

  // POLLING — an explicit preference, or the SSE fallback. Stable key across the
  // polling lifecycle so React preserves children state (scroll, filters) when
  // fallback progresses SSE → POLLING.
  return (
    <PollingAdapter key="polling" {...commonProps}>
      {children}
    </PollingAdapter>
  );
}
