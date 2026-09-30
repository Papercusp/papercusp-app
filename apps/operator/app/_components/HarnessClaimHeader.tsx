'use client';

/**
 * HarnessClaimHeader — Phase 8 P-069b composer.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24.
 *
 * Drop-in header slot for any harness chrome that surfaces the
 * canonical-binding claim status. Composes:
 *
 *   - Harness title (linkified)
 *   - ClaimStatusBadge (4 states)
 *   - Provisional-owner explainer (one-liner) when status is unclaimed
 *   - "Claim this harness" CTA when status is unclaimed AND the
 *     viewer has GitHub maintainer+ permission (caller passes
 *     `viewerCanClaim`).
 *
 * Data inputs are pre-resolved — the component has no fetch logic.
 * Wiring to the binding service (Phase 1b P-068's `resolveBinding`)
 * lives in the consumer (typically ChromeShell or HarnessHeader).
 *
 * Intentionally a presentational component so it slots into either
 * the existing Next.js harness chrome or the new Vite harness shell
 * without coupling to either.
 */

import type { CSSProperties, ReactNode } from 'react';
import { ClaimStatusBadge, type ClaimStatus } from './ClaimStatusBadge';

export interface HarnessClaimHeaderProps {
  title: string;
  href?: string;
  status: ClaimStatus;
  /** For `claimed`, the @login of the current claimant. */
  claimantLogin?: string | null;
  /** For `superseded`, the successor harness href. */
  supersededByHref?: string | null;
  /**
   * Whether the viewer has GitHub maintainer/admin permission on the
   * bound repo. Caller pre-checks this via Phase 1b's
   * `checkRepoPermission`. When true AND status === 'unclaimed', the
   * "Claim this harness" CTA renders.
   */
  viewerCanClaim?: boolean;
  /** Click handler for the claim CTA. Caller calls P-068 `claimBinding`. */
  onClaimClick?: () => void;
}

const ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  flexWrap: 'wrap',
};

const TITLE_STYLE: CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  color: 'var(--fg)',
  textDecoration: 'none',
};

const EXPLAINER_STYLE: CSSProperties = {
  fontSize: 12,
  color: 'var(--fg-dim)',
  marginTop: 4,
};

const CLAIM_BUTTON_STYLE: CSSProperties = {
  padding: '4px 10px',
  background: 'var(--accent)',
  color: 'var(--accent-fg)',
  border: 0,
  borderRadius: 4,
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
};

export function HarnessClaimHeader(props: HarnessClaimHeaderProps): ReactNode {
  const {
    title, href, status, claimantLogin, supersededByHref,
    viewerCanClaim = false, onClaimClick,
  } = props;

  const titleEl: ReactNode = href
    ? <a href={href} style={TITLE_STYLE} data-testid="harness-claim-header-title-link">{title}</a>
    : <span style={TITLE_STYLE}>{title}</span>;

  const showClaimCta = status === 'unclaimed' && viewerCanClaim;

  return (
    <header data-testid="harness-claim-header">
      <div style={ROW_STYLE}>
        {titleEl}
        <ClaimStatusBadge
          status={status}
          claimantLogin={claimantLogin}
          supersededByHref={supersededByHref}
        />
        {showClaimCta && (
          <button
            type="button"
            style={CLAIM_BUTTON_STYLE}
            onClick={onClaimClick}
            data-testid="harness-claim-cta"
          >
            Claim this harness
          </button>
        )}
      </div>
      {status === 'unclaimed' && (
        <div style={EXPLAINER_STYLE} data-testid="harness-claim-explainer">
          No GitHub maintainer has claimed this harness. The creator is the provisional owner.
        </div>
      )}
      {status === 'stale' && (
        <div style={EXPLAINER_STYLE} data-testid="harness-claim-stale-explainer">
          The claimant lost the GitHub permission they claimed with. Provisional-owner controls are re-enabled until a maintainer reclaims.
        </div>
      )}
    </header>
  );
}
