'use client';

/**
 * SpendCard — real per-harness agent spend.
 *
 * Plan: cross-backend-cost-capture-2026-06-01 (P-006). Reads
 * `agent_usage_samples` (load-spend.ts) — actual token + $cost telemetry
 * captured per agent run across all three backends (claude/codex/omp).
 *
 * Renders:
 *   - Harness total spend this week ($, provider-billed + token-estimated).
 *   - Token throughput + run count this week.
 *   - An "includes $X estimated" note when any spend was priced from tokens
 *     (codex reports no $cost), so list-price estimates are never confused
 *     with billed spend (D-005 honesty rule).
 *
 * The original phantom-column / per-viewer-share / proxy-witness version is
 * gone (the column never existed → always $0; runs have no per-person
 * attribution — D-003 #2).
 */

import type { CSSProperties, ReactNode } from 'react';
import type { SpendCardProps } from '@papercusp/operator-core/lib/harness-insights/card-types';

const CARD: CSSProperties = {
  border: '1px solid var(--border)',
  background: 'var(--bg-1)',
  borderRadius: 8,
  padding: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  fontSize: 14,
};

const TITLE_ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const TITLE: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--fg)',
};

const TIER_PILL: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  fontSize: 10,
  fontWeight: 600,
  padding: '1px 6px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  color: 'var(--fg-dim)',
  textTransform: 'uppercase',
};

const STATS: CSSProperties = {
  display: 'flex',
  gap: 20,
};

const STAT_VAL: CSSProperties = {
  fontSize: 22,
  fontWeight: 600,
  color: 'var(--fg)',
};

const STAT_LABEL: CSSProperties = {
  fontSize: 11,
  color: 'var(--fg-dim)',
  marginTop: 2,
};

const BANNER: CSSProperties = {
  fontSize: 12,
  padding: '8px 12px',
  borderRadius: 6,
  background: 'var(--bg-2)',
  color: 'var(--fg-dim)',
  lineHeight: 1.5,
};

export type { SpendCardProps };

function formatUsd(n: number): string {
  return n < 1
    ? `$${n.toFixed(2)}`
    : n < 100
      ? `$${n.toFixed(1)}`
      : `$${Math.round(n)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

export function SpendCard(props: SpendCardProps): ReactNode {
  const {
    harnessTotalUsdThisWeek,
    estimatedUsdThisWeek,
    tokensThisWeek,
    runsThisWeek,
  } = props;

  return (
    <div style={CARD} data-testid="insights-spend-card">
      <div style={TITLE_ROW}>
        <div style={TITLE}>Spend</div>
        <span style={TIER_PILL} data-testid="spend-card-tier-pill">
          this week
        </span>
      </div>

      <div style={STATS}>
        <div data-testid="spend-card-harness-total">
          <div style={STAT_VAL}>{formatUsd(harnessTotalUsdThisWeek)}</div>
          <div style={STAT_LABEL}>Harness spend</div>
        </div>
        <div data-testid="spend-card-tokens">
          <div style={STAT_VAL}>{formatTokens(tokensThisWeek)}</div>
          <div style={STAT_LABEL}>Tokens</div>
        </div>
        <div data-testid="spend-card-runs">
          <div style={STAT_VAL}>{runsThisWeek}</div>
          <div style={STAT_LABEL}>Agent runs</div>
        </div>
      </div>

      {estimatedUsdThisWeek > 0 ? (
        <div style={BANNER} data-testid="spend-card-estimate-note">
          Includes {formatUsd(estimatedUsdThisWeek)} estimated from token
          counts at provider list price (codex / OMP report no billed cost);
          the rest is provider-reported.
        </div>
      ) : (
        <div style={BANNER} data-testid="spend-card-note">
          Provider-reported cost across all agent backends this week.
        </div>
      )}
    </div>
  );
}
