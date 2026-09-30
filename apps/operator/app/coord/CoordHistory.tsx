'use client';

/**
 * /coord — coordination history viewer (Phase B remainder of
 * agent-coordination-architecture-v2).
 *
 * Single page; subscribes to the coord.history projection. Filters:
 *
 *   - source (plan_event / message / escalation / handoff)
 *   - plan_slug (free-text exact-match)
 *   - owner   (matches from/to/'*' on messages + handoffs)
 *
 * State lives in nuqs (URL-backed) so a particular filter view is
 * shareable / bookmarkable, per the operator's app-wide convention.
 */

import { useQueryState, parseAsArrayOf, parseAsString } from 'nuqs';
import { useCallback, useRef, useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import styles from './coord.module.css';

/**
 * A history row as the SYNC feed carries it.
 *
 * ⚠ `payload` is deliberately ABSENT (WI-7297). It is 76% of this read, and
 * this screen renders at most ONE of them — `expanded` is a single
 * `useState<string | null>`, so a payload is displayed only after a click, and
 * in the common case zero are. It is fetched per-row on expand from
 * /api/coord/history/:source/:msg_id instead. Do not re-declare it here to
 * "read it off the list": it is not in the payload, and a field declared but
 * never delivered is the D-023 trap this change exists to remove.
 */
interface HistoryItem {
  ts: string;
  msg_id: string;
  source: 'plan_event' | 'message' | 'escalation' | 'handoff';
  kind: string;
  from?: string;
  to?: string[];
  plan_slug?: string;
  harness_slug?: string;
  summary?: string;
}

const ALL_SOURCES: HistoryItem['source'][] = [
  'plan_event',
  'message',
  'escalation',
  'handoff',
];

const SOURCE_LABEL: Record<HistoryItem['source'], string> = {
  plan_event: 'Plan event',
  message: 'Message',
  escalation: 'Escalation',
  handoff: 'Handoff',
};

const SOURCE_BADGE: Record<HistoryItem['source'], string> = {
  plan_event: styles.sourceBadgePlanEvent,
  message: styles.sourceBadgeMessage,
  escalation: styles.sourceBadgeEscalation,
  handoff: styles.sourceBadgeHandoff,
};

export const COORD_HISTORY_WINDOW_SIZE = 200;

export function coordHistoryWindowLabel(
  shown: number,
  limit = COORD_HISTORY_WINDOW_SIZE,
): string {
  return `${shown.toLocaleString('en-US')} latest matches · up to ${limit.toLocaleString('en-US')}`;
}

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export default function CoordHistory() {
  const [sources, setSources] = useQueryState<string[]>(
    'sources',
    parseAsArrayOf(parseAsString).withDefault([...ALL_SOURCES]),
  );
  const [planSlug, setPlanSlug] = useQueryState('plan_slug', parseAsString.withDefault(''));
  const [owner, setOwner] = useQueryState('owner', parseAsString.withDefault(''));
  const [expanded, setExpanded] = useState<string | null>(null);
  const [payload, setPayload] = useState<unknown>(null);
  const [payloadLoading, setPayloadLoading] = useState(false);
  const [payloadError, setPayloadError] = useState<string | null>(null);
  // Guards the out-of-order response: clicking row A then row B can land A's
  // slower reply last and render A's payload under B's header. Only the reply
  // whose key is still the expanded one is allowed to write state.
  const inFlightKey = useRef<string | null>(null);

  const toggleExpanded = useCallback(
    async (key: string, source: HistoryItem['source'], msgId: string) => {
      if (expanded === key) {
        setExpanded(null);
        inFlightKey.current = null;
        setPayload(null);
        setPayloadError(null);
        setPayloadLoading(false);
        return;
      }
      setExpanded(key);
      inFlightKey.current = key;
      setPayload(null);
      setPayloadError(null);
      setPayloadLoading(true);
      try {
        const r = await fetch(
          `/api/coord/history/${encodeURIComponent(source)}/${encodeURIComponent(msgId)}`,
        );
        const j = (await r.json()) as { payload?: unknown; error?: string };
        if (inFlightKey.current !== key) return;
        if (!r.ok || j.error) setPayloadError(j.error ?? `HTTP ${r.status}`);
        else setPayload(j.payload ?? null);
      } catch (e) {
        if (inFlightKey.current !== key) return;
        setPayloadError(e instanceof Error ? e.message : String(e));
      } finally {
        if (inFlightKey.current === key) setPayloadLoading(false);
      }
    },
    [expanded],
  );

  const historySync = useSyncQuery<HistoryItem>({
    queryName: 'coord.history',
    args: {
      kinds: sources && sources.length < ALL_SOURCES.length ? sources : undefined,
      planSlug: planSlug || undefined,
      owner: owner || undefined,
      limit: COORD_HISTORY_WINDOW_SIZE,
    },
    staleTime: 30_000,
  });
  const loading = historySync.loading || historySync.fetching;
  const error = historySync.error?.message ?? null;

  const toggleSource = (s: HistoryItem['source']) => {
    const cur = new Set(sources ?? ALL_SOURCES);
    if (cur.has(s)) cur.delete(s);
    else cur.add(s);
    setSources(cur.size === 0 ? [...ALL_SOURCES] : [...cur]);
  };

  const items = historySync.data ?? [];

  return (
    <div>
      <div className={styles.toolbar}>
        <button
          onClick={historySync.invalidate}
          className={styles.button}
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className={styles.filterBar}>
        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>Sources</span>
          {ALL_SOURCES.map((s) => {
            const active = (sources ?? ALL_SOURCES).includes(s);
            return (
              <button
                key={s}
                onClick={() => toggleSource(s)}
                className={cx(
                  styles.sourcePill,
                  active ? SOURCE_BADGE[s] : styles.sourcePillInactive,
                )}
              >
                {SOURCE_LABEL[s]}
              </button>
            );
          })}
        </div>
        <label className={styles.filterControl}>
          <span className={styles.filterLabel}>plan_slug</span>
          <input
            value={planSlug ?? ''}
            onChange={(e) => setPlanSlug(e.target.value || null)}
            className={styles.filterInput}
            placeholder="(any)"
          />
        </label>
        <label className={styles.filterControl}>
          <span className={styles.filterLabel}>owner</span>
          <input
            value={owner ?? ''}
            onChange={(e) => setOwner(e.target.value || null)}
            className={styles.filterInput}
            placeholder="(any)"
          />
        </label>
        {!historySync.loading && (
          <span className={styles.resultCount}>
            {coordHistoryWindowLabel(items.length)}
          </span>
        )}
      </div>

      {error && (
        <div className={styles.alert}>
          Error: {error}
        </div>
      )}

      <ul className={styles.listCompact}>
        {items.length === 0 && !loading && (
          <li className={cx(styles.cardRow, styles.cardRowPadded, styles.emptyCopy)}>
            No coordination events match these filters.
          </li>
        )}
        {items.map((it) => {
          const key = `${it.source}:${it.msg_id}`;
          const isOpen = expanded === key;
          return (
            <li
              key={key}
              className={styles.cardRow}
            >
              <button
                onClick={() => void toggleExpanded(key, it.source, it.msg_id)}
                className={styles.eventButton}
              >
                <span
                  className={cx(styles.kindBadge, SOURCE_BADGE[it.source])}
                >
                  {it.kind}
                </span>
                <div className={styles.contentColumn}>
                  <div className={styles.eventTitleRow}>
                    <span className={styles.eventSummary}>
                      {it.summary ?? '—'}
                    </span>
                    {it.plan_slug && (
                      <span className={styles.miniBadge}>
                        plan: {it.plan_slug}
                      </span>
                    )}
                  </div>
                  <div className={styles.rowMeta}>
                    {new Date(it.ts).toLocaleString()}
                    {it.from && ` · from ${it.from}`}
                    {it.to && it.to.length > 0 && ` · to ${it.to.join(', ')}`}
                  </div>
                </div>
              </button>
              {isOpen && (
                <pre className={cx(styles.payloadPre, styles.historyPayload)}>
{payloadLoading
  ? 'Loading payload…'
  : payloadError
    ? `Error loading payload: ${payloadError}`
    : JSON.stringify(payload, null, 2)}
                </pre>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
