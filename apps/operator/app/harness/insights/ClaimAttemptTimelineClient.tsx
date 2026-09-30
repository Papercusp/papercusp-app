'use client';

/**
 * ClaimAttemptTimelineClient — Phase 6 P-039b client wrapper.
 *
 * Polls /api/harness/:slug/claim-attempts (no `?stats=1`) every
 * `pollMs` (default 8000) and feeds the rows into ClaimAttemptTimeline.
 * Pauses while the document is hidden.
 *
 * Mirrors the polling shape of `ClaimAttemptStatsPillClient` so two
 * adjacent surfaces share the same fetch cadence.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ClaimAttemptTimeline,
  type ClaimAttemptDisplayRow,
} from './ClaimAttemptTimeline';

export interface ClaimAttemptTimelineClientProps {
  slug: string;
  /** Override poll interval (ms). Default 8000. */
  pollMs?: number;
  /** Override fetch (testing). */
  fetchImpl?: typeof fetch;
  /** Optional outcome filter for the highlight band. */
  highlightOutcome?: 'won' | 'lost' | 'error';
  /** Limit clamp passed through as `?limit=N`. Default 50. */
  limit?: number;
}

interface ApiBody {
  attempts?: ClaimAttemptDisplayRow[];
}

export function ClaimAttemptTimelineClient(
  props: ClaimAttemptTimelineClientProps,
): ReactNode {
  const [attempts, setAttempts] = useState<ClaimAttemptDisplayRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const tickRef = useRef(0);
  const pollMs = props.pollMs ?? 8000;
  const fetchImpl = props.fetchImpl ?? fetch;
  const limit = props.limit ?? 50;

  const doFetch = useCallback(async () => {
    if (!props.slug) return;
    try {
      const res = await fetchImpl(
        `/api/harness/${encodeURIComponent(props.slug)}/claim-attempts?limit=${limit}`,
      );
      if (!res.ok) {
        setLoaded(true);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as ApiBody;
      setAttempts(Array.isArray(body.attempts) ? body.attempts : []);
      setLoaded(true);
    } catch {
      setLoaded(true);
    }
  }, [props.slug, fetchImpl, limit]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      if (typeof document === 'undefined' || !document.hidden) {
        await doFetch();
      }
      tickRef.current = window.setTimeout(tick, pollMs);
    };
    void doFetch();
    tickRef.current = window.setTimeout(tick, pollMs);
    return () => {
      cancelled = true;
      window.clearTimeout(tickRef.current);
    };
  }, [doFetch, pollMs]);

  return (
    <ClaimAttemptTimeline
      attempts={attempts}
      highlightOutcome={props.highlightOutcome}
      loaded={loaded}
    />
  );
}
