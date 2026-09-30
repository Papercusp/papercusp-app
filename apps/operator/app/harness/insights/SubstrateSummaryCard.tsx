'use client';

/**
 * SubstrateSummaryCard — Phase 5a workspace-level tile.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * Larger dashboard tile composing the workspace summary into a single
 * surface. Shows:
 *
 *   - Worst verdict as a colored stripe + verbose label.
 *   - Per-verdict counts (healthy / booting / degraded / unhealthy).
 *   - Total harness count.
 *   - Optional CTA href ("Open diagnostic →").
 *
 * Pure UI — consumer feeds the same shape returned by
 * GET /api/admin/dogfood-substrate-health's `summary` field.
 */

import type { CSSProperties, ReactNode } from 'react';
import type { SubstrateHealthVerdict } from './SubstrateHealthPill';

export interface SubstrateSummaryData {
  enabled: boolean;
  totalHarnesses: number;
  healthy: number;
  booting: number;
  degraded: number;
  unhealthy: number;
  disabled: number;
  worstVerdict: SubstrateHealthVerdict;
}

export interface SubstrateSummaryCardProps {
  summary: SubstrateSummaryData;
  /** Optional anchor href for the bottom-right CTA. */
  diagnosticHref?: string;
}

const CARD: CSSProperties = {
  display: 'block',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--border)',
  borderRadius: 8,
  background: 'var(--bg-1)',
  padding: 16,
  fontSize: 13,
  position: 'relative',
};

const STRIPE: CSSProperties = {
  height: 4,
  borderTopLeftRadius: 8,
  borderTopRightRadius: 8,
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
};

const HEADER: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginTop: 6,
  marginBottom: 8,
};

const VERDICT_LABEL: CSSProperties = {
  fontWeight: 600,
  fontSize: 14,
};

const TOTAL: CSSProperties = {
  color: 'var(--fg-dim)',
  fontSize: 12,
};

const STAT_ROW: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, 1fr)',
  gap: 8,
  marginTop: 4,
};

const STAT: CSSProperties = {
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--border)',
  borderRadius: 6,
  padding: '6px 8px',
  textAlign: 'center',
};

const STAT_NUM: CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  lineHeight: 1.1,
};

const STAT_LABEL: CSSProperties = {
  fontSize: 11,
  color: 'var(--fg-dim)',
  marginTop: 2,
  textTransform: 'uppercase',
};

const CTA: CSSProperties = {
  marginTop: 12,
  display: 'inline-block',
  color: 'var(--accent)',
  fontSize: 12,
  textDecoration: 'none',
};

const VERDICT_COLOR: Record<SubstrateHealthVerdict, string> = {
  disabled: 'var(--fg-dim)',
  healthy: 'var(--good)',
  booting: 'var(--warn)',
  degraded: 'var(--warn)',
  unhealthy: 'var(--bad)',
};

const VERDICT_LABEL_TEXT: Record<SubstrateHealthVerdict, string> = {
  disabled: 'Substrate off',
  healthy: 'All harnesses healthy',
  booting: 'Booting',
  degraded: 'Degraded',
  unhealthy: 'Unhealthy',
};

export function SubstrateSummaryCard(
  props: SubstrateSummaryCardProps,
): ReactNode {
  const { summary, diagnosticHref } = props;
  const color = VERDICT_COLOR[summary.worstVerdict];
  return (
    <div
      style={CARD}
      data-testid="substrate-summary-card"
      data-verdict={summary.worstVerdict}
    >
      <div style={{ ...STRIPE, background: color }} />
      <div style={HEADER}>
        <span style={{ ...VERDICT_LABEL, color }}>
          {VERDICT_LABEL_TEXT[summary.worstVerdict]}
        </span>
        <span style={TOTAL}>
          {summary.totalHarnesses} harness
          {summary.totalHarnesses === 1 ? '' : 'es'}
        </span>
      </div>
      <div style={STAT_ROW}>
        <div
          style={STAT}
          data-testid="substrate-summary-healthy"
          title={`${summary.healthy} healthy`}
        >
          <div style={{ ...STAT_NUM, color: VERDICT_COLOR.healthy }}>
            {summary.healthy}
          </div>
          <div style={STAT_LABEL}>healthy</div>
        </div>
        <div
          style={STAT}
          data-testid="substrate-summary-booting"
          title={`${summary.booting} booting`}
        >
          <div style={{ ...STAT_NUM, color: VERDICT_COLOR.booting }}>
            {summary.booting}
          </div>
          <div style={STAT_LABEL}>booting</div>
        </div>
        <div
          style={STAT}
          data-testid="substrate-summary-degraded"
          title={`${summary.degraded} degraded`}
        >
          <div style={{ ...STAT_NUM, color: VERDICT_COLOR.degraded }}>
            {summary.degraded}
          </div>
          <div style={STAT_LABEL}>degraded</div>
        </div>
        <div
          style={STAT}
          data-testid="substrate-summary-unhealthy"
          title={`${summary.unhealthy} unhealthy`}
        >
          <div style={{ ...STAT_NUM, color: VERDICT_COLOR.unhealthy }}>
            {summary.unhealthy}
          </div>
          <div style={STAT_LABEL}>unhealthy</div>
        </div>
      </div>
      {diagnosticHref ? (
        <a href={diagnosticHref} style={CTA} data-testid="substrate-summary-cta">
          Open diagnostic →
        </a>
      ) : null}
    </div>
  );
}
