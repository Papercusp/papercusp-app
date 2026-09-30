'use client';

/**
 * SubstrateSummaryCardClient — fetch + render wrapper.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * Polls /api/admin/dogfood-substrate-health and renders
 * SubstrateSummaryCard with the `summary` field. Renders nothing while
 * the first fetch is in flight (or on persistent failures); the
 * dashboard slot stays empty rather than flashing a placeholder.
 *
 * Pure UI; fetchImpl + refresh interval injectable for tests.
 */

import { useEffect, useState, type ReactNode } from 'react';
import {
  SubstrateSummaryCard,
  type SubstrateSummaryData,
} from './SubstrateSummaryCard';

export interface SubstrateSummaryCardClientProps {
  /** Default 30s. */
  refreshIntervalMs?: number;
  fetchImpl?: typeof fetch;
  /** Optional CTA href forwarded to SubstrateSummaryCard. */
  diagnosticHref?: string;
}

interface HealthResponse {
  flagEnabled?: boolean;
  summary?: SubstrateSummaryData;
}

export function SubstrateSummaryCardClient(
  props: SubstrateSummaryCardClientProps,
): ReactNode {
  const {
    refreshIntervalMs = 30_000,
    fetchImpl,
    diagnosticHref,
  } = props;
  const [summary, setSummary] = useState<SubstrateSummaryData | null>(null);

  useEffect(() => {
    let cancelled = false;
    const f = fetchImpl ?? fetch;
    const run = async () => {
      try {
        const r = await f('/api/admin/dogfood-substrate-health', {
          cache: 'no-store',
        });
        if (!r.ok) return;
        const json = (await r.json()) as HealthResponse;
        if (cancelled) return;
        if (json.summary) setSummary(json.summary);
      } catch {
        // stay on last-known state
      }
    };
    void run();
    let timer: ReturnType<typeof setInterval> | null = null;
    if (refreshIntervalMs > 0) {
      // Documented polling exception (audit P-058): live substrate status
      // probe — no sync invalidation source. Paused while the tab is hidden.
      timer = setInterval(() => {
        if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void run();
      }, refreshIntervalMs);
    }
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [fetchImpl, refreshIntervalMs]);

  if (!summary) return null;
  return (
    <SubstrateSummaryCard
      summary={summary}
      diagnosticHref={diagnosticHref}
    />
  );
}
