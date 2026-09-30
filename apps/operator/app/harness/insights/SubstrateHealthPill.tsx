'use client';

/**
 * SubstrateHealthPill — Phase 5a diagnostic.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * Compact pill for one (workspace, harness) health verdict from
 * assessHarnessSubstrateHealth. Five states:
 *
 *   disabled / booting / healthy / degraded / unhealthy
 *
 * Each renders with distinct colour + dot + tooltip listing reasons.
 *
 * Pure UI; consumer fetches /api/admin/dogfood-substrate-health and
 * passes per-row verdicts.
 */

import type { CSSProperties, ReactNode } from 'react';

export type SubstrateHealthVerdict =
  | 'disabled'
  | 'booting'
  | 'healthy'
  | 'degraded'
  | 'unhealthy';

export interface SubstrateHealthPillProps {
  verdict: SubstrateHealthVerdict;
  reasons?: ReadonlyArray<string>;
}

const PILL_BASE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '3px 10px',
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 500,
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
  borderWidth: 1,
  borderStyle: 'solid',
};

const DOT: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: 3,
};

interface Style {
  label: string;
  background: string;
  color: string;
  borderColor: string;
}

const STYLES: Record<SubstrateHealthVerdict, Style> = {
  disabled: {
    label: 'Disabled',
    background: 'var(--bg-2)',
    color: 'var(--fg-dim)',
    borderColor: 'var(--border)',
  },
  booting: {
    label: 'Booting',
    background: 'var(--warn-bg)',
    color: 'var(--warn)',
    borderColor: 'var(--warn-border)',
  },
  healthy: {
    label: 'Healthy',
    background: 'color-mix(in oklab, var(--good), transparent 84%)',
    color: 'var(--good)',
    borderColor: 'color-mix(in oklab, var(--good), transparent 56%)',
  },
  degraded: {
    label: 'Degraded',
    background: 'var(--warn-bg)',
    color: 'var(--warn)',
    borderColor: 'var(--warn-border)',
  },
  unhealthy: {
    label: 'Unhealthy',
    background: 'color-mix(in oklab, var(--bad), transparent 84%)',
    color: 'var(--bad)',
    borderColor: 'color-mix(in oklab, var(--bad), transparent 56%)',
  },
};

export function SubstrateHealthPill(
  props: SubstrateHealthPillProps,
): ReactNode {
  const { verdict, reasons } = props;
  const s = STYLES[verdict];
  const title = reasons && reasons.length > 0 ? reasons.join(' · ') : s.label;
  return (
    <span
      style={{
        ...PILL_BASE,
        background: s.background,
        color: s.color,
        borderColor: s.borderColor,
      }}
      data-testid="substrate-health-pill"
      data-verdict={verdict}
      title={title}
    >
      <span style={{ ...DOT, background: s.color }} />
      {s.label}
    </span>
  );
}
