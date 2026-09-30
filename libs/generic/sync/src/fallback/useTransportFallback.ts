'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import type { SyncType } from '../types';

const FALLBACK_ORDER: SyncType[] = ['WEBSOCKETS', 'SSE', 'POLLING'];

interface UseTransportFallbackOptions {
  preferred: SyncType;
  fallbackDelayMs: number;
  /**
   * After falling back, wait this long before retrying the preferred
   * transport. Each retry that fails again doubles the next wait (capped at
   * `recoveryMaxDelayMs`); a retry that stays healthy for one base delay
   * resets the backoff. Set to 0 to disable recovery entirely (the transport
   * then only moves down the fallback chain until remount/preferred change).
   * Default 30_000. Must be > `fallbackDelayMs`, otherwise a failed retry
   * would be miscounted as stable and the backoff never grows.
   */
  recoveryDelayMs?: number;
  /** Cap for the doubling recovery delay. Default 300_000 (5 min). */
  recoveryMaxDelayMs?: number;
}

interface UseTransportFallbackResult {
  activeTransport: SyncType;
  onTransportError: (error: Error) => void;
}

export function useTransportFallback(
  opts: UseTransportFallbackOptions,
): UseTransportFallbackResult {
  const {
    preferred,
    fallbackDelayMs,
    recoveryDelayMs = 30_000,
    recoveryMaxDelayMs = 300_000,
  } = opts;
  const [activeTransport, setActiveTransport] = useState<SyncType>(preferred);
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Current recovery wait — doubles per failed recovery, resets once a
  // recovery sticks (see the recovery effect below).
  const recoveryWaitRef = useRef(recoveryDelayMs);

  // Reset when preferred changes
  useEffect(() => {
    setActiveTransport(preferred);
    recoveryWaitRef.current = recoveryDelayMs;
    if (fallbackTimer.current) {
      clearTimeout(fallbackTimer.current);
      fallbackTimer.current = null;
    }
    // recoveryDelayMs is deliberately not a dep: a delay change alone should
    // not reset the active transport, only seed future resets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferred]);

  // A pending fallback timer was armed with the OLD delay — cancel it when
  // the delay changes; the next transport error re-arms with the new value.
  useEffect(() => {
    return () => {
      if (fallbackTimer.current) {
        clearTimeout(fallbackTimer.current);
        fallbackTimer.current = null;
      }
    };
  }, [fallbackDelayMs]);

  const onTransportError = useCallback(
    (error: Error) => {
      // Debounce: don't fall back immediately — wait for sustained failure
      if (fallbackTimer.current) return; // Already waiting

      fallbackTimer.current = setTimeout(() => {
        fallbackTimer.current = null;
        setActiveTransport((current) => {
          const currentIndex = FALLBACK_ORDER.indexOf(current);
          const nextIndex = currentIndex + 1;

          if (nextIndex >= FALLBACK_ORDER.length) {
            // Already at terminal fallback (POLLING) — nothing to do
            console.warn('[Sync] Already at terminal transport (POLLING)');
            return current;
          }

          const next = FALLBACK_ORDER[nextIndex];
          console.warn(
            `[Sync] Transport ${current} failed — falling back to ${next}`,
            error.message,
          );
          return next;
        });
      }, fallbackDelayMs);
    },
    [fallbackDelayMs],
  );

  // Recovery: while on a fallback transport, periodically retry the
  // preferred one instead of staying pinned down the chain forever (a single
  // SSE blip used to pin desktop to polling until remount). A retry that
  // fails falls back again via onTransportError, which re-enters this effect
  // with a doubled wait; a retry that holds for one base delay is considered
  // recovered and resets the backoff.
  useEffect(() => {
    if (recoveryDelayMs <= 0) return;

    if (activeTransport === preferred) {
      const stabilityTimer = setTimeout(() => {
        recoveryWaitRef.current = recoveryDelayMs;
      }, recoveryDelayMs);
      return () => clearTimeout(stabilityTimer);
    }

    const wait = recoveryWaitRef.current;
    const recoveryTimer = setTimeout(() => {
      // Double up-front; the stability timer above resets it if this attempt
      // sticks.
      recoveryWaitRef.current = Math.min(
        recoveryWaitRef.current * 2,
        recoveryMaxDelayMs,
      );
      console.info(
        `[Sync] Retrying preferred transport ${preferred} after ${wait}ms on ${activeTransport}`,
      );
      setActiveTransport(preferred);
    }, wait);
    return () => clearTimeout(recoveryTimer);
  }, [activeTransport, preferred, recoveryDelayMs, recoveryMaxDelayMs]);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
    };
  }, []);

  return { activeTransport, onTransportError };
}
