'use client';

import { useMemo, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { SyncContext } from '../../SyncContext';
import { getQueryClient } from './queryClient';
import { createUsePollingQuery, createPrefetchSync } from './usePollingQuery';
import type { SyncType } from '../../types';

interface PollingAdapterProps {
  children: ReactNode;
  userId?: string;
  server?: string;
  restEndpoint?: string;
  pollIntervalMs?: number;
  /** When set, every `/rest-query` URL gets `?token=<encoded>` appended.
   *  Mirrors the SSE adapter's `tokenQueryParam`. */
  tokenQueryParam?: string;
  /** Max sync requests in flight at once (default 24). See query-fetcher.ts. */
  maxInFlightFetches?: number;
  /** Query names excluded from the host's persisted-cache snapshot (WI-6656). */
  persistExcludeQueryNames?: readonly string[];
  /** Exact query names this endpoint admits; absent means unrestricted. */
  queryNameAllowlist?: readonly string[];
  onTransportError?: (error: Error) => void;
}

const DEFAULT_REST_ENDPOINT = 'http://localhost:3100/zero';

let warnedDefaultRestEndpoint = false;

function warnIfDefaultUsedInProd(endpoint: string): void {
  if (warnedDefaultRestEndpoint) return;
  if (typeof window === 'undefined') return;
  if (endpoint !== DEFAULT_REST_ENDPOINT) return;
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return;
  warnedDefaultRestEndpoint = true;
  console.warn(
    `[Sync] PollingAdapter has no \`restEndpoint\` or \`server\` prop on ${location.hostname}; using ${DEFAULT_REST_ENDPOINT}. ` +
    'Pass `restEndpoint="/api/your-zero"` (relative) or `server="https://..."` to silence this.',
  );
}

export function PollingAdapter({
  children,
  restEndpoint,
  server,
  pollIntervalMs = 10_000,
  tokenQueryParam,
  maxInFlightFetches,
  persistExcludeQueryNames,
  queryNameAllowlist,
}: PollingAdapterProps) {
  const endpoint = restEndpoint ?? (server ? `${server}/zero` : DEFAULT_REST_ENDPOINT);
  warnIfDefaultUsedInProd(endpoint);
  const queryClient = getQueryClient();

  const useDataImpl = useMemo(
    () => createUsePollingQuery({ restEndpoint: endpoint, defaultPollIntervalMs: pollIntervalMs, tokenQueryParam, maxInFlightFetches, persistExcludeQueryNames, queryNameAllowlist }),
    [endpoint, pollIntervalMs, tokenQueryParam, maxInFlightFetches, persistExcludeQueryNames, queryNameAllowlist],
  );

  const prefetch = useMemo(
    () => createPrefetchSync({ restEndpoint: endpoint, defaultPollIntervalMs: pollIntervalMs, tokenQueryParam, maxInFlightFetches, queryNameAllowlist }, queryClient),
    [endpoint, pollIntervalMs, tokenQueryParam, maxInFlightFetches, queryNameAllowlist, queryClient],
  );

  const ctxValue = useMemo(
    () => ({ transport: 'POLLING' as SyncType, useDataImpl, prefetch }),
    [useDataImpl, prefetch],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <SyncContext.Provider value={ctxValue}>
        {children}
      </SyncContext.Provider>
    </QueryClientProvider>
  );
}
