'use client';

/**
 * ClaimStatusBadge — Phase 8 P-069a.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24.
 * v5 addendum 1 §5.1 — canonical repo binding's `claim_status` field.
 *
 * Renders one of four states with distinct visual treatment:
 *
 *   Unclaimed   — neutral pill. Provisional owner controls owner-scoped
 *                  settings. A GitHub maintainer/admin can claim later.
 *
 *   Claimed     — accent pill, includes the claimant's GitHub login when
 *                  provided. Repo-authoritative owner controls settings.
 *
 *   Stale       — warning pill. The last claimant has lost the repo
 *                  permission they claimed with (24h daily re-check
 *                  failed). Provisional-owner controls re-enabled.
 *
 *   Superseded  — historical pill, links to the successor harness when
 *                  provided. Existing contributors see a migration banner
 *                  elsewhere; the badge just marks the historical row.
 *
 * Used by:
 *   - Harness header (ChromeShell)
 *   - Settings banner explaining who controls owner-scoped settings
 *   - Cupboard card + detail view
 *   - Contributors tab claimant indicator
 */

import type { CSSProperties, ReactNode } from 'react';

import type { ClaimStatus } from '@papercusp/operator-core/lib/harness/claim-status-types';
export type { ClaimStatus };

export interface ClaimStatusBadgeProps {
  status: ClaimStatus;
  /** For `claimed`, the @login of the current claimant. */
  claimantLogin?: string | null;
  /** For `claimed`, epoch ms of the claim — the "when" half of who/when
   *  (comb-hive-native-sharing P-003); surfaces in the tooltip. */
  claimedAt?: number | null;
  /** For `superseded`, an optional href to the successor harness. */
  supersededByHref?: string | null;
}

const BADGE_BASE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 8px',
  borderRadius: 12,
  fontSize: 12,
  fontWeight: 500,
  border: '1px solid var(--border)',
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
};

interface StatusStyle {
  label: string;
  background: string;
  color: string;
  tooltip: string;
}

/**
 * The ONE copy source for what claimed/unclaimed means (comb-hive-native-sharing
 * P-003; P-012's explainer reuses these strings). The framing rule: a claim is
 * a TRUST SIGNAL — a verified repo maintainer vouching for the listing — not
 * ownership of the code.
 */
export const CLAIM_STATUS_COPY: Record<ClaimStatus, string> = {
  unclaimed:
    'Unclaimed — no verified repo maintainer has vouched for this listing yet. A claim is a trust signal, not ownership of the code; anyone with maintain/admin on the GitHub repo can claim it.',
  claimed:
    'Claimed — a verified repo maintainer (maintain/admin on GitHub) has vouched for this listing. A claim is a trust signal, not ownership of the code.',
  stale:
    'Stale claim — the claimant has lost the GitHub permission they claimed with, so the trust signal no longer holds. Provisional-owner controls are re-enabled.',
  superseded:
    'Superseded — this listing has been replaced by a newer canonical binding.',
};

const STATUS_STYLES: Record<ClaimStatus, StatusStyle> = {
  unclaimed: {
    label: 'Unclaimed',
    background: 'var(--bg-2)',
    color: 'var(--fg-dim)',
    tooltip: CLAIM_STATUS_COPY.unclaimed,
  },
  claimed: {
    label: 'Claimed',
    background: 'var(--accent-soft, rgba(76, 175, 80, 0.15))',
    color: 'var(--accent, #4CAF50)',
    tooltip: CLAIM_STATUS_COPY.claimed,
  },
  stale: {
    label: 'Stale claim',
    background: 'var(--warn-bg, rgba(255, 152, 0, 0.12))',
    color: 'var(--warn, #FF9800)',
    tooltip: CLAIM_STATUS_COPY.stale,
  },
  superseded: {
    label: 'Superseded',
    background: 'var(--bg-1, transparent)',
    color: 'var(--fg-dim)',
    tooltip: CLAIM_STATUS_COPY.superseded,
  },
};

export function ClaimStatusBadge(props: ClaimStatusBadgeProps): ReactNode {
  const { status, claimantLogin, claimedAt, supersededByHref } = props;
  const style = STATUS_STYLES[status];
  const composed: CSSProperties = {
    ...BADGE_BASE,
    background: style.background,
    color: style.color,
  };
  const tooltip =
    status === 'claimed' && claimedAt
      ? `${style.tooltip} Claimed ${new Date(claimedAt).toLocaleDateString()}.`
      : style.tooltip;

  // Body content depends on status.
  let inner: ReactNode;
  if (status === 'claimed' && claimantLogin) {
    inner = <>{style.label} by <strong>@{claimantLogin}</strong></>;
  } else if (status === 'superseded' && supersededByHref) {
    inner = (
      <>
        {style.label}{' '}
        <a
          href={supersededByHref}
          style={{ color: 'inherit', textDecoration: 'underline' }}
          data-testid="claim-status-superseded-link"
        >
          (open successor)
        </a>
      </>
    );
  } else {
    inner = style.label;
  }

  return (
    <span
      data-claim-status={status}
      data-testid={`claim-status-badge-${status}`}
      title={tooltip}
      style={composed}
    >
      {inner}
    </span>
  );
}
