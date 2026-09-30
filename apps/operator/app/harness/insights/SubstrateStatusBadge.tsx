'use client';

/**
 * SubstrateStatusBadge — Phase 5a diagnostic.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * Compact pill showing the local process's substrate state for one
 * harness (or for the workspace as a whole). Three modes:
 *
 *   disabled  — substrate reported off (a forced/diagnostic state only;
 *               the substrate always boots as of Stage 4d).
 *               Greyed pill: "Substrate off".
 *   booting   — substrate on, but this harness not yet in handle map.
 *               Yellow pill: "Booting…".
 *   booted    — substrate on, harness handle present.
 *               Green pill: "Substrate live".
 *
 * Pure UI; consumer fetches state via /api/admin/dogfood-substrate-status
 * and decides which mode to render.
 */

import type { CSSProperties, ReactNode } from 'react';

export type SubstrateStatus = 'disabled' | 'booting' | 'booted';

export interface SubstrateStatusBadgeProps {
  status: SubstrateStatus;
  /** When set, appended to the label as a parenthesized hint. */
  hint?: string | null;
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
  borderColor: 'var(--border)',
};

const DISABLED: CSSProperties = {
  ...PILL_BASE,
  background: 'var(--bg-2)',
  color: 'var(--fg-dim)',
};

const BOOTING: CSSProperties = {
  ...PILL_BASE,
  background: 'var(--warn-bg)',
  color: 'var(--warn)',
  borderColor: 'var(--warn-border)',
};

const BOOTED: CSSProperties = {
  ...PILL_BASE,
  background: 'color-mix(in oklab, var(--good), transparent 84%)',
  color: 'var(--good)',
  borderColor: 'color-mix(in oklab, var(--good), transparent 56%)',
};

const DOT_BASE: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: 3,
};

const DOT_BY_STATUS: Record<SubstrateStatus, CSSProperties> = {
  disabled: { ...DOT_BASE, background: 'var(--fg-dim)' },
  booting: { ...DOT_BASE, background: 'var(--warn)' },
  booted: { ...DOT_BASE, background: 'var(--good)' },
};

const LABEL_BY_STATUS: Record<SubstrateStatus, string> = {
  disabled: 'Substrate off',
  booting: 'Booting…',
  booted: 'Substrate live',
};

const PILL_BY_STATUS: Record<SubstrateStatus, CSSProperties> = {
  disabled: DISABLED,
  booting: BOOTING,
  booted: BOOTED,
};

export function SubstrateStatusBadge(
  props: SubstrateStatusBadgeProps,
): ReactNode {
  const { status, hint } = props;
  return (
    <span
      style={PILL_BY_STATUS[status]}
      data-testid="substrate-status-badge"
      data-status={status}
      title={
        hint
          ? `${LABEL_BY_STATUS[status]} (${hint})`
          : LABEL_BY_STATUS[status]
      }
    >
      <span style={DOT_BY_STATUS[status]} />
      {LABEL_BY_STATUS[status]}
      {hint ? (
        <span
          style={{ color: 'var(--fg-dim)', marginLeft: 4 }}
          data-testid="substrate-status-hint"
        >
          {hint}
        </span>
      ) : null}
    </span>
  );
}
