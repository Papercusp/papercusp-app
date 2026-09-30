/**
 * TrustBadge — the author trust-state chip on shared (federated) work items
 * (shared-hive-trust-admission-2026-06-14 Phase 4 / P-011, Trust A4).
 *
 * Pure, from the provenance fields already on the WorkItem shape (origin /
 * auditVerdict / verifiedAuthorGithubUserId) + whether the verified author is on
 * the owner's trust list (the `trust.list` set the panel passes in):
 *
 *   - local-origin work has no cross-author trust dimension → NO badge (null);
 *   - trusted   — remote, verified author on the trust list → its verified work auto-runs (green);
 *   - admitted  — remote, the G2 auditor admitted it (blue);
 *   - rejected  — remote, the G2 auditor rejected it (red);
 *   - pending   — remote, awaiting the G2 admission verdict — not auto-running yet (amber).
 *
 * Mirrors the EkgPanel severity-chip palette (hardcoded semantic colors are the
 * established chip idiom alongside the CSS-var tokens).
 */
import type { CSSProperties } from 'react';

export interface TrustBadgeProps {
  origin: string | null;
  auditVerdict: string | null;
  verifiedAuthorGithubUserId: number | null;
  /** Whether {@link verifiedAuthorGithubUserId} is on the owner's trust list. */
  trusted: boolean;
}

type TrustState = { label: string; color: string; title: string };

/** Pure classifier — exported for unit tests. null = render no badge (local work). */
export function trustBadgeState(p: TrustBadgeProps): TrustState | null {
  if (p.origin !== 'remote') return null;
  const who = p.verifiedAuthorGithubUserId != null ? `GitHub user ${p.verifiedAuthorGithubUserId}` : 'an unverified author';
  if (p.trusted) {
    return {
      label: 'trusted',
      color: '#34d399',
      title: `Remote work by ${who}, on your trust list — verified remote work auto-runs.`,
    };
  }
  if (p.auditVerdict === 'reject') {
    return { label: 'rejected', color: '#fb7185', title: `Remote work by ${who} — the admission auditor rejected it.` };
  }
  if (p.auditVerdict === 'admit') {
    return {
      label: 'admitted',
      color: 'var(--accent-strong, var(--accent))',
      title: `Remote work by ${who} — admitted by the auditor${p.verifiedAuthorGithubUserId != null ? ' (author not on your trust list)' : ''}.`,
    };
  }
  return {
    label: 'pending audit',
    color: '#fcd34d',
    title: `Remote work by ${who} — awaiting the admission verdict; not auto-running yet.`,
  };
}

export function TrustBadge(props: TrustBadgeProps) {
  const state = trustBadgeState(props);
  if (!state) return null;
  const style: CSSProperties = {
    display: 'inline-block',
    padding: '1px 8px',
    borderRadius: 999,
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
    color: state.color,
    background: `color-mix(in srgb, ${state.color}, transparent 85%)`,
  };
  return (
    <span style={style} title={state.title}>
      {state.label}
    </span>
  );
}

export default TrustBadge;
