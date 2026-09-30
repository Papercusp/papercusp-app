/**
 * useEventSource — React hook wrapping createResilientEventSource.
 *
 * Subscribes to a server-sent-events stream with all the resilience
 * primitives of createResilientEventSource: backoff with jitter, zombie
 * watchdog, escalation on consecutive failures, optional visibility pause.
 *
 * Pass `url=null` to disable (component renders but no connection opens).
 * When `url` changes, the hook cleanly closes the old source and opens a
 * new one.
 *
 * Handlers are kept in a ref so callers don't have to memoize them — only
 * `url` and `withCredentials` cause re-subscription. Lifecycle callbacks
 * (onOpen, onStatusChange, onError) follow refs too.
 */

'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  createResilientEventSource,
  type ResilientEventSource,
  type ResilientEventSourceOptions,
  type ResilientEventSourceStatus,
} from './resilient-event-source';

export type { ResilientEventSourceStatus } from './resilient-event-source';

export interface UseEventSourceOptions extends Omit<ResilientEventSourceOptions, 'url'> {}

export interface UseEventSourceResult {
  status: ResilientEventSourceStatus;
  lastEventId: string | null;
  reconnect: () => void;
  close: () => void;
}

export function useEventSource(
  url: string | null,
  opts: UseEventSourceOptions,
): UseEventSourceResult {
  const [status, setStatus] = useState<ResilientEventSourceStatus>('idle');
  const [lastEventId, setLastEventId] = useState<string | null>(null);
  const sourceRef = useRef<ResilientEventSource | null>(null);

  // Keep handlers + callbacks in refs so they don't trigger re-subscription.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    if (!url) {
      setStatus('idle');
      return;
    }
    const source = createResilientEventSource({
      ...optsRef.current,
      url,
      // Wrap lifecycle callbacks to keep our state in sync AND forward to caller.
      onStatusChange: (s) => {
        setStatus(s);
        optsRef.current.onStatusChange?.(s);
      },
      onOpen: () => {
        optsRef.current.onOpen?.();
      },
      onError: (err) => {
        optsRef.current.onError?.(err);
      },
      // Wrap each user handler so we capture lastEventId without forcing
      // the caller to do it themselves. Wrapper looks up the latest handler
      // from optsRef each time, so re-renders with new handler closures
      // work without re-subscription.
      handlers: Object.fromEntries(
        Object.keys(optsRef.current.handlers).map((name) => [
          name,
          (data: string, ev: MessageEvent) => {
            if (ev.lastEventId) setLastEventId(ev.lastEventId);
            optsRef.current.handlers[name]?.(data, ev);
          },
        ]),
      ),
    });
    sourceRef.current = source;
    return () => {
      source.close();
      sourceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, opts.withCredentials]);

  const reconnect = useCallback(() => {
    sourceRef.current?.reconnect();
  }, []);
  const close = useCallback(() => {
    sourceRef.current?.close();
  }, []);

  return { status, lastEventId, reconnect, close };
}
