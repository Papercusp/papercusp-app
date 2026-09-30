'use client';

/**
 * BootstrapProgressIndicator — Phase 5b P-066.
 *
 * Plan: papercusp-dogfood-v5-2026-05-23 (Q-6 resolution).
 *
 * "Sleeping laptop just woke up; substrate is replaying remote ops" —
 * shows N/M progress in the harness sidebar header. Auto-dismisses
 * when M=N (caught up).
 *
 * Pure UI; consumer passes the current numbers + a manual dismiss
 * callback. The numbers are fed by the substrate's bootstrap-progress
 * poller (own-log length), which always runs now (Stage 4d).
 *
 * Three render states:
 *   - syncing (M > N): pill with spinner + "Syncing N/M ops"
 *   - caught_up (M === N > 0): brief "Up to date" badge, fades out
 *   - idle (M === 0): renders nothing
 */

import type { CSSProperties, ReactNode } from 'react';

const PILL_BASE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 10px',
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 500,
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
};

const SYNCING_PILL: CSSProperties = {
  ...PILL_BASE,
  background: 'color-mix(in oklab, var(--accent), transparent 84%)',
  color: 'var(--accent)',
  border: '1px solid color-mix(in oklab, var(--accent), transparent 56%)',
};

const CAUGHT_UP_PILL: CSSProperties = {
  ...PILL_BASE,
  background: 'color-mix(in oklab, var(--good), transparent 84%)',
  color: 'var(--good)',
  border: '1px solid color-mix(in oklab, var(--good), transparent 56%)',
};

const SPINNER: CSSProperties = {
  display: 'inline-block',
  width: 10,
  height: 10,
  border: '1.5px solid currentColor',
  borderTopColor: 'transparent',
  borderRadius: '50%',
  animation: 'bootstrap-progress-spin 0.8s linear infinite',
};

const DISMISS_BUTTON: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'currentColor',
  cursor: 'pointer',
  padding: 0,
  marginLeft: 4,
  fontSize: 14,
  lineHeight: 1,
};

export interface BootstrapProgressIndicatorProps {
  /** Total expected ops across the substrate. 0 = not booted yet. */
  totalOps: number;
  /** Ops merged so far. */
  mergedOps: number;
  /** Show the small dismiss x to suppress the indicator. */
  onDismiss?: () => void;
}

export function BootstrapProgressIndicator(
  props: BootstrapProgressIndicatorProps,
): ReactNode {
  const { totalOps, mergedOps, onDismiss } = props;

  if (totalOps === 0) return null;

  const caughtUp = mergedOps >= totalOps && totalOps > 0;
  const pct = totalOps > 0 ? Math.min(100, (mergedOps / totalOps) * 100) : 0;

  if (caughtUp) {
    return (
      <span
        style={CAUGHT_UP_PILL}
        data-testid="bootstrap-progress-indicator"
        data-state="caught-up"
      >
        ✓ Up to date
        {onDismiss ? (
          <button
            type="button"
            style={DISMISS_BUTTON}
            onClick={onDismiss}
            aria-label="dismiss"
            data-testid="bootstrap-progress-dismiss"
          >
            ×
          </button>
        ) : null}
      </span>
    );
  }

  return (
    <span
      style={SYNCING_PILL}
      data-testid="bootstrap-progress-indicator"
      data-state="syncing"
      title={`Syncing harness — ${mergedOps} of ${totalOps} ops merged (${pct.toFixed(0)}%)`}
    >
      <style>{`
        @keyframes bootstrap-progress-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
      <span style={SPINNER} />
      Syncing {mergedOps}/{totalOps}
      {onDismiss ? (
        <button
          type="button"
          style={DISMISS_BUTTON}
          onClick={onDismiss}
          aria-label="dismiss"
          data-testid="bootstrap-progress-dismiss"
        >
          ×
        </button>
      ) : null}
    </span>
  );
}
