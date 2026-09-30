'use client';

/**
 * UserProfile — Phase 8 P-072.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24.
 * v5 addendum 3 §18 + D-028: route at `/users/github/<github_user_id>`;
 * username route redirects to numeric.
 *
 * Render component fed real PG-backed data by `lib/user-profile/load.ts`
 * (via the SSR Next page + the GET /api/users/github/:id endpoint that
 * the Vite route consumes).
 *
 * Sub-acceptances rendered here:
 *   P-072a — header (avatar, name, login, verified-binding badge, GH link).
 *   P-072b — per-harness collapsible blocks (one per visible harness),
 *            tier-A PRs / tier-B features-shipped / tier-C activity.
 *   P-072c — recent activity feed (last ~30 events).
 *   P-072d — footer: verified-claimant harnesses.
 *
 * Wiring (shipped in the P-072b–f real-data follow-up):
 *   - `loadUserProfile` fetches the user + per-harness tier rollups (PRs
 *     from auto_review_audit, features from harness_features_consolidated,
 *     activity from contributor_usage_events) + cross-harness feed.
 *   - The §18 privacy filter runs through the pure
 *     `visibleHarnessesForViewer` seam. NOTE: the real viewer-identity
 *     filter is the KNOWN SHARED GAP — the live /adv shell has no
 *     viewer-identity resolution, so the viewer defaults to anonymous
 *     (shared-public harnesses only). The seam drops the real filter in
 *     at the call site without touching this component.
 *   - The Marketplace `publishedBy` link now targets this profile
 *     (P-072f); the GitHub link still lives in the header above.
 */

import type { CSSProperties, ReactNode } from 'react';
import { useLexicon } from '@/lib/useLexicon';
import { ContributorBadgeRow } from '@/app/_components/ContributorBadge';
import { LazyDetails } from '@/app/_components/LazyDetails';
import { BindingStatusBadge, type BindingStatus } from '@/app/_components/BindingStatusBadge';
import { ClaimStatusBadge, type ClaimStatus } from '@/app/_components/ClaimStatusBadge';
import type {
  UserProfileData,
  HarnessBlock,
  ActivityEntry,
  ClaimedHarness,
} from '@papercusp/operator-core/lib/user-profile/types';

export type { UserProfileData, HarnessBlock, ActivityEntry, ClaimedHarness };

const PAGE_STYLE: CSSProperties = {
  padding: '32px max(24px, calc((100% - 960px) / 2))',
  fontFamily: 'inherit',
  color: 'var(--fg)',
};

const SECTION_STYLE: CSSProperties = {
  marginTop: 32,
};

const SECTION_TITLE: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--fg-dim)',
  textTransform: 'uppercase',
  marginBottom: 12,
};

const CARD_STYLE: CSSProperties = {
  background: 'var(--bg-2)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: 16,
  marginBottom: 8,
};

function fmtTime(ts: number): string {
  const ageMs = Date.now() - ts;
  const hours = Math.floor(ageMs / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

export function UserProfile(props: { data: UserProfileData }): ReactNode {
  const t = useLexicon();
  const u = props.data;
  return (
    <div style={PAGE_STYLE} data-testid="user-profile-page">
      {/* ── P-072a — Header ─────────────────────────────────────── */}
      <header style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
        {u.avatar_url && (
          <img
            src={u.avatar_url}
            alt=""
            width={96}
            height={96}
            style={{ borderRadius: '50%', border: '1px solid var(--border)' }}
          />
        )}
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600 }}>
            {u.display_name ?? u.github_login}
          </h1>
          <div style={{ marginTop: 4, color: 'var(--fg-dim)', display: 'flex', alignItems: 'center', gap: 12 }}>
            <a
              href={`https://github.com/${u.github_login}`}
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--fg-dim)', textDecoration: 'underline' }}
            >
              @{u.github_login}
            </a>
            <BindingStatusBadge status={u.binding_status} />
          </div>
        </div>
      </header>

      {/* ── P-072b — Per-harness collapsible blocks ─────────────── */}
      <section style={SECTION_STYLE} data-testid="profile-section-harnesses">
        <div style={SECTION_TITLE}>{t('pot', { plural: true })}</div>
        {u.harnesses.length === 0 && (
          <div style={{ color: 'var(--fg-dim)', fontSize: 14 }}>
            No visible {t('pot', { plural: true, lower: true })} for this user.
          </div>
        )}
        {u.harnesses.map((h) => (
          <LazyDetails
            key={h.harness_slug}
            style={CARD_STYLE}
            summaryStyle={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
            summary={
              <>
                <a href={h.href} style={{ color: 'var(--fg)', textDecoration: 'none', fontWeight: 500 }}>
                  {h.display_title}
                </a>
                <ContributorBadgeRow
                  prsMerged={h.prs_merged}
                  featuresShipped={h.features_shipped}
                  activityEvents={h.activity_events}
                />
              </>
            }
          >
            <div style={{ marginTop: 12, fontSize: 13, color: 'var(--fg-dim)' }}>
              Recent activity in <code>{h.harness_slug}</code>:{' '}
              {h.activity_events} events, {h.features_shipped} features shipped, {h.prs_merged} PRs merged.
            </div>
          </LazyDetails>
        ))}
      </section>

      {/* ── P-072c — Recent activity feed ───────────────────────── */}
      <section style={SECTION_STYLE} data-testid="profile-section-activity">
        <div style={SECTION_TITLE}>Recent activity</div>
        {u.recent_activity.length === 0 && (
          <div style={{ color: 'var(--fg-dim)', fontSize: 14 }}>
            No recent activity.
          </div>
        )}
        {u.recent_activity.slice(0, 30).map((e) => {
          const body: ReactNode = e.href
            ? <a href={e.href} style={{ color: 'var(--fg)', textDecoration: 'none' }}>{e.label}</a>
            : e.label;
          return (
            <div
              key={e.id}
              style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}
            >
              <span>{body}</span>
              <span style={{ color: 'var(--fg-dim)', whiteSpace: 'nowrap' }}>{fmtTime(e.ts)}</span>
            </div>
          );
        })}
      </section>

      {/* ── P-072d — Claimed harnesses footer ────────────────────── */}
      {u.claimed_harnesses.length > 0 && (
        <section style={SECTION_STYLE} data-testid="profile-section-claimed">
          <div style={SECTION_TITLE}>Claimed {t('pot', { plural: true })}</div>
          {u.claimed_harnesses.map((c) => (
            <div key={c.harness_slug} style={{ ...CARD_STYLE, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <a href={c.href} style={{ color: 'var(--fg)', textDecoration: 'none', fontWeight: 500 }}>
                {c.display_title}
              </a>
              <ClaimStatusBadge status={c.claim_status} claimantLogin={u.github_login} />
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
