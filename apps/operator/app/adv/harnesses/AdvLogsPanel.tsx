'use client';

// adv:logs — recent structured log events from run.log.jsonl (+ rotated
// peers) via /log/history. Ports the legacy RealLogsPanel: terminal-style
// time/level/source/message rows. One-shot read + manual Refresh (no 3s
// auto-poll, per the /adv ethos).
//
// Filtering rides the generic column-filter system
// (generic-column-filters-2026-06-14 Phase 3): columns tag a `filter:` spec
// (Lvl/Source → enum, Message/Time → text) and the shared <ColumnFilterBar>
// drives a single nuqs param (`lgf`) — replacing the legacy bespoke level
// chips + source text input.
//
// Rendered on @papercusp/grid-core RichGrid in LEGACY (non-virtual) mode: the
// feed is bounded (≤300 events from useHarnessLogs) and the message column
// wraps to multiple lines, so auto-height rows are simpler + read better than
// a fixed-height virtualized window.

import { useMemo } from 'react';
import { RefreshCw } from 'lucide-react';
import { RichGrid, usePersistedColumnWidths, type ColumnDef } from '@papercusp/grid-core';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';
import { Tooltip } from '../../harness/Tooltip';
import { ColumnFilterBar, useColumnFilters, type CountEvidence } from '../../harness/filters';
import { useHarnessLogs, type HarnessLogEvent } from './useHarnessData';

// Per-level accent — token-first with hex fallbacks. Log levels are a
// distinct axis from feature/issue status; these map to the shared semantic
// tokens (--bad / --warn / sky) so they stay on-theme.
const LEVEL_ACCENT: Record<string, string> = {
  error: 'var(--bad, #f87171)',
  warn: 'var(--warn, #fbbf24)',
  info: 'var(--accent-strong, #7dd3fc)',
  debug: 'var(--fg-mute)',
  trace: 'color-mix(in oklab, var(--fg-mute), transparent 35%)',
};

export function levelOf(e: HarnessLogEvent): string {
  return String(e.level ?? 'info').toLowerCase();
}

// Localized clock string ('' for an unparseable ts) — shared by the Time cell
// render and its text-filter accessor so they match exactly.
export function timeText(e: HarnessLogEvent): string {
  const t = new Date(e.ts);
  return isNaN(t.getTime()) ? '' : t.toLocaleTimeString();
}

// The writer's schema is loose — read the message under whichever key it
// used, falling back to a compact dump of the non-envelope fields.
export function messageOf(e: HarnessLogEvent): string {
  if (typeof e.msg === 'string') return e.msg;
  if (typeof e.message === 'string') return e.message;
  const { ts: _ts, source: _source, level: _level, msg: _msg, message: _message, ...rest } = e;
  const keys = Object.keys(rest);
  if (keys.length === 0) return '';
  try {
    return JSON.stringify(rest);
  } catch {
    return keys.join(', ');
  }
}

type LogRow = { id: string; ev: HarnessLogEvent };

export const RECENT_LOG_WINDOW_SIZE = 300;

export default function AdvLogsPanel({ params }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || (params.slug as string) || '';
  const { events, loading, error, refresh } = useHarnessLogs(slug);
  // Dragged widths survive panel remounts (localStorage — render-only pref).
  const [colWidths, setColWidths] = usePersistedColumnWidths('pc-colw:adv:logs');

  // Unfiltered rows — the generic column-filter system does the filtering.
  const rows = useMemo<LogRow[]>(() => {
    if (!events) return [];
    return events.map((ev, i) => ({ id: `${i}:${ev.ts ?? ''}`, ev }));
  }, [events]);

  const columns = useMemo<ColumnDef<LogRow>[]>(() => [
    {
      key: 'time',
      header: 'Time',
      headerText: 'Time',
      width: '76px',
      filter: { type: 'text', accessor: (r: LogRow) => timeText(r.ev) },
      toCopyText: (r) => timeText(r.ev),
      render: ({ row }) => <span className="pc-adv-logs__time">{timeText(row.ev)}</span>,
    },
    {
      key: 'level',
      header: 'Lvl',
      headerText: 'Level',
      width: '52px',
      filter: { type: 'enum', accessor: (r: LogRow) => levelOf(r.ev) },
      toCopyText: (r) => levelOf(r.ev),
      render: ({ row }) => {
        const lvl = levelOf(row.ev);
        return <span className="pc-adv-logs__level" style={{ color: LEVEL_ACCENT[lvl] ?? 'var(--fg-mute)' }}>{lvl}</span>;
      },
    },
    {
      key: 'source',
      header: 'Source',
      headerText: 'Source',
      width: '150px',
      filter: { type: 'enum', accessor: (r: LogRow) => (r.ev.source ? String(r.ev.source) : null) },
      toCopyText: (r) => String(r.ev.source ?? ''),
      // Native title=, not <Tooltip>: per-row truncation hint in a grid cell —
      // a Radix portal per row is the documented perf anti-pattern.
      render: ({ row }) =>
        row.ev.source ? (
          <span className="pc-adv-logs__src" title={String(row.ev.source)}>
            {String(row.ev.source)}
          </span>
        ) : null,
    },
    {
      key: 'msg',
      header: 'Message',
      headerText: 'Message',
      width: 1,
      filter: { type: 'text', accessor: (r: LogRow) => messageOf(r.ev) },
      toCopyText: (r) => messageOf(r.ev),
      render: ({ row }) => <span className="pc-adv-logs__msg">{messageOf(row.ev)}</span>,
    },
  ], []);

  const countEvidence = useMemo<CountEvidence>(
    () => loading && !events
      ? { kind: 'unknown', reason: 'loading' }
      : {
          kind: 'window',
          count: rows.length,
          window: `latest ${RECENT_LOG_WINDOW_SIZE} events`,
        },
    [events, loading, rows.length],
  );
  const cf = useColumnFilters(columns, rows, { ns: 'lg', countEvidence });

  if (!slug) {
    return <div className="pc-advpanel__empty">No harness slug in params.</div>;
  }

  return (
    <div className="pc-advpanel pc-adv-logs">
      <div className="pc-advpanel__bar">
        <ColumnFilterBar
          controller={cf.controller}
          activeChips={cf.activeChips}
          hasActive={cf.hasActive}
          clearAll={cf.clearAll}
        />
        <Tooltip label="Refresh log">
          <button
            type="button"
            className="pc-advpanel__iconbtn"
            onClick={() => refresh()}
            disabled={loading}
            aria-label="Refresh log"
          >
            <RefreshCw size={13} aria-hidden className={loading ? 'pc-advpanel__spin' : undefined} />
          </button>
        </Tooltip>
      </div>

      <div className="pc-adv-logs__body">
        {error ? (
          <div className="pc-advpanel__empty pc-advpanel__empty--err">Failed: {error}</div>
        ) : loading ? (
          <div className="pc-advpanel__empty">Loading {slug}…</div>
        ) : (
          <RichGrid<LogRow>
            inline
            rows={cf.rows}
            columns={columns}
            resizableColumns
            columnWidths={colWidths}
            onColumnWidthsChange={setColWidths}
            getRowId={(r) => r.id}
            headerHeight={30}
            rowMinHeight={24}
            empty={
              <div className="pc-advpanel__empty">
                {events && events.length ? 'No events match the filter.' : 'No log events yet.'}
              </div>
            }
          />
        )}
      </div>

      <style>{`
        .pc-adv-logs__body {
          flex: 1; min-height: 0; overflow: auto;
          font-family: ui-monospace, monospace; font-size: 11px;
        }
        .pc-adv-logs__time { color: var(--fg-mute); font-family: ui-monospace, monospace; }
        .pc-adv-logs__level { text-transform: uppercase; font-family: ui-monospace, monospace; }
        .pc-adv-logs__src {
          color: var(--accent-strong, #7dd3fc); font-family: ui-monospace, monospace;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; max-width: 100%;
        }
        .pc-adv-logs__msg {
          color: color-mix(in oklab, var(--fg), transparent 12%);
          font-family: ui-monospace, monospace;
          white-space: pre-wrap; word-break: break-word;
        }
      `}</style>
    </div>
  );
}
