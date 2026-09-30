'use client';

/**
 * ClaimAttemptTimeline — Phase 6 P-039b.
 *
 * Plan: papercusp-dogfood-phase6-orchestrator-claim-2026-05-24.
 *
 * Renders the last N claim attempts for a harness — feature_id, who
 * claimed it, outcome (won / lost / error), timestamp, optional detail
 * line. Pure UI; the client wrapper fetches /api/harness/:slug/claim-
 * attempts (no `?stats=1`) and feeds the rows in.
 *
 * Read-only diagnostic surface. Today the orchestrator's pre-dispatch
 * P-037 fetch is observability-only, so the table fills with `won`
 * rows when the substrate is booted + `PAPERCUSP_GITHUB_USER_ID` is
 * set. Once multi-engineer contention exists the rows will show real
 * `lost` outcomes with winner pubkeys.
 */

import type { CSSProperties, ReactNode } from 'react';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';

export interface ClaimAttemptDisplayRow {
  id: number;
  feature_id: string;
  claimer_pubkey: string;
  claimer_github_user_id: number;
  /** Epoch ms. */
  ts: number;
  outcome: 'won' | 'lost' | 'error' | string;
  detail: string | null;
}

export interface ClaimAttemptTimelineProps {
  attempts: ClaimAttemptDisplayRow[];
  /** Highlight rows whose outcome matches this filter (empty = no filter). */
  highlightOutcome?: 'won' | 'lost' | 'error';
  /** Loading flag — defer empty-state text until at least one fetch resolved. */
  loaded?: boolean;
}

const WRAP: CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 8,
  background: 'var(--bg-1)',
  fontSize: 12,
  color: 'var(--fg)',
  overflow: 'hidden',
};

const HEADER: CSSProperties = {
  padding: '8px 12px',
  borderBottom: '1px solid var(--border)',
  fontWeight: 600,
  fontSize: 13,
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
};

const COUNT_PILL: CSSProperties = {
  fontSize: 11,
  fontWeight: 400,
  color: 'var(--fg-dim)',
};

const MONO: CSSProperties = {
  fontFamily: 'ui-monospace, SF Mono, Menlo, monospace',
  fontSize: 11,
  color: 'var(--fg-dim)',
};

const OUTCOME_PILL_BASE: CSSProperties = {
  display: 'inline-block',
  padding: '0px 6px',
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 500,
  textTransform: 'uppercase',
};

const OUTCOME_STYLES: Record<string, CSSProperties> = {
  won: { ...OUTCOME_PILL_BASE, background: 'color-mix(in oklab, var(--good), transparent 82%)', color: 'var(--good)' },
  lost: { ...OUTCOME_PILL_BASE, background: 'color-mix(in oklab, var(--bad), transparent 84%)', color: 'var(--bad)' },
  error: { ...OUTCOME_PILL_BASE, background: 'color-mix(in oklab, var(--warn), transparent 82%)', color: 'var(--warn)' },
};

const EMPTY: CSSProperties = {
  padding: 16,
  color: 'var(--fg-dim)',
  fontStyle: 'italic',
  fontSize: 12,
};

function fmtTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  try {
    return new Date(ms).toLocaleTimeString();
  } catch {
    return String(ms);
  }
}

function shortPubkey(p: string): string {
  if (!p) return '—';
  if (p.length <= 12) return p;
  return `${p.slice(0, 8)}…${p.slice(-4)}`;
}

function outcomeStyle(outcome: string): CSSProperties {
  return OUTCOME_STYLES[outcome] ?? OUTCOME_PILL_BASE;
}

const columns: ColumnDef<ClaimAttemptDisplayRow>[] = [
  {
    key: 'feature',
    header: 'Feature',
    width: 1.1,
    toCopyText: (row) => row.feature_id,
    render: ({ row }) => <span style={MONO}>{row.feature_id}</span>,
  },
  {
    key: 'claimer',
    header: 'Claimer',
    width: 1.4,
    toCopyText: (row) => `@${row.claimer_github_user_id || '?'} · ${row.claimer_pubkey}`,
    render: ({ row }) => (
      <span style={MONO} title={row.claimer_pubkey}>
        @{row.claimer_github_user_id || '?'} · {shortPubkey(row.claimer_pubkey)}
      </span>
    ),
  },
  {
    key: 'outcome',
    header: 'Outcome',
    width: 0.9,
    toCopyText: (row) => row.outcome,
    render: ({ row }) => <span style={outcomeStyle(row.outcome)}>{row.outcome}</span>,
  },
  {
    key: 'when',
    header: 'When',
    width: 0.9,
    toCopyText: (row) => fmtTime(row.ts),
    render: ({ row }) => <span style={MONO}>{fmtTime(row.ts)}</span>,
  },
  { key: 'detail', header: 'Detail', width: 2, toCopyText: (row) => row.detail ?? '', render: ({ row }) => row.detail ?? '' },
];

export function ClaimAttemptTimeline(props: ClaimAttemptTimelineProps): ReactNode {
  const attempts = props.attempts ?? [];
  // Single source of truth for "this row matches the highlight filter" — drives
  // BOTH the visual bg (getRowBg) and the stable data-highlighted attribute the
  // tests assert on. Asserting the highlight DECISION via a data-* flag keeps the
  // test independent of whether jsdom/cssstyle round-trips the color-mix() bg
  // value through the CSSOM `style` attribute (it varies by version — the cause
  // of EI-10457's env-flaky red).
  const isHighlighted = (row: ClaimAttemptDisplayRow): boolean =>
    props.highlightOutcome !== undefined && row.outcome === props.highlightOutcome;
  return (
    <div data-testid="claim-attempt-timeline" style={WRAP}>
      <div style={HEADER}>
        <span>Claim attempts</span>
        <span style={COUNT_PILL}>{attempts.length} recent</span>
      </div>
      {attempts.length === 0 ? (
        <div data-testid="claim-attempt-timeline-empty" style={EMPTY}>
          {props.loaded === false
            ? 'Loading…'
            : 'No claim attempts recorded yet. Substrate may be off, or the orchestrator has not dispatched a worker on a feature claim this run.'}
        </div>
      ) : (
        <div style={{ height: Math.min(520, 32 + attempts.length * 32 + 4) }}>
          <RichGrid<ClaimAttemptDisplayRow>
            columns={columns}
            rows={attempts}
            getRowId={(row) => String(row.id)}
            rowMinHeight={32}
            headerHeight={32}
            getRowBg={(row) => isHighlighted(row) ? 'color-mix(in oklab, var(--accent), transparent 92%)' : undefined}
            rowProps={({ row }) => ({
              'data-testid': `claim-attempt-row-${row.id}`,
              'data-outcome': row.outcome,
              'data-highlighted': isHighlighted(row) ? 'true' : 'false',
            })}
          />
        </div>
      )}
    </div>
  );
}
