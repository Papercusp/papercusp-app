'use client';

/**
 * BootHistoryTableClient — fetch + render wrapper.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * Polls /api/admin/dogfood-substrate-boot-history and renders
 * BootHistoryTable. Supports per-(workspace, harness) filters +
 * kinds filter + limit so the same component can power a global
 * dev page or a focused per-harness debug panel.
 *
 * Renders nothing during first load + on sustained failure so the
 * embedding slot stays empty rather than flashing a placeholder.
 *
 * Pure UI; fetchImpl + refresh interval injectable for tests.
 */

import { useEffect, useState, type ReactNode } from 'react';
import {
  BootHistoryTable,
  type BootHistoryEntry,
  type BootHistoryKind,
} from './BootHistoryTable';

export interface BootHistoryTableClientProps {
  workspaceId?: string;
  harnessSlug?: string;
  kinds?: ReadonlyArray<BootHistoryKind>;
  limit?: number;
  refreshIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

interface HistoryResponse {
  entries?: BootHistoryEntry[];
  depth?: number;
}

function buildUrl(props: BootHistoryTableClientProps): string {
  const params = new URLSearchParams();
  if (props.workspaceId) params.set('workspace_id', props.workspaceId);
  if (props.harnessSlug) params.set('harness_slug', props.harnessSlug);
  if (props.kinds && props.kinds.length > 0) {
    params.set('kinds', props.kinds.join(','));
  }
  if (typeof props.limit === 'number') {
    params.set('limit', String(props.limit));
  }
  const qs = params.toString();
  return `/api/admin/dogfood-substrate-boot-history${qs ? '?' + qs : ''}`;
}

export function BootHistoryTableClient(
  props: BootHistoryTableClientProps,
): ReactNode {
  const { refreshIntervalMs = 10_000, fetchImpl } = props;
  const [entries, setEntries] = useState<BootHistoryEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const f = fetchImpl ?? fetch;
    const url = buildUrl(props);
    const run = async () => {
      try {
        const r = await f(url, { cache: 'no-store' });
        if (!r.ok) return;
        const json = (await r.json()) as HistoryResponse;
        if (cancelled) return;
        if (Array.isArray(json.entries)) setEntries(json.entries);
      } catch {
        // stay on last-known state
      }
    };
    void run();
    let timer: ReturnType<typeof setInterval> | null = null;
    if (refreshIntervalMs > 0) {
      // Documented polling exception (audit P-058): admin boot-history
      // aggregate with no sync queryName/invalidation source. Paused while
      // the tab is hidden.
      timer = setInterval(() => {
        if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void run();
      }, refreshIntervalMs);
    }
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
    // url is derived from these props — depending on them keeps the
    // effect re-running on any filter change.
  }, [
    fetchImpl,
    refreshIntervalMs,
    props.workspaceId,
    props.harnessSlug,
    props.kinds,
    props.limit,
  ]);

  if (entries === null) return null;
  return <BootHistoryTable entries={entries} />;
}
