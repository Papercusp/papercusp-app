'use client';

/**
 * PeopleCard — Phase 8 P-073c.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24.
 * v5 §9.0 Insights tab — people card.
 *
 * Horizontal avatar stack with verified-binding badges. Click an avatar
 * → §18 user profile. Overflow shows "+N more". Empty-state when no
 * contributors.
 *
 * Pure UI. Consumer feeds pre-computed avatar rows.
 */

import type { CSSProperties, ReactNode } from 'react';
import type {
  PeopleCardPerson,
  PeopleCardProps,
} from '@papercusp/operator-core/lib/harness-insights/card-types';
import { BindingStatusBadge } from '../../_components/BindingStatusBadge';

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

const TITLE: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--fg)',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

const COUNT_PILL: CSSProperties = {
  fontSize: 12,
  background: 'var(--bg-2)',
  color: 'var(--fg-dim)',
  padding: '1px 6px',
  borderRadius: 8,
};

const STACK: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 12,
};

const PERSON: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 4,
  width: 64,
  textDecoration: 'none',
  color: 'inherit',
};

const AVATAR_WRAP: CSSProperties = {
  position: 'relative',
};

const AVATAR: CSSProperties = {
  width: 48,
  height: 48,
  borderRadius: '50%',
  display: 'block',
  background: 'var(--bg-2)',
};

const AVATAR_FALLBACK: CSSProperties = {
  ...AVATAR,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 16,
  fontWeight: 600,
  color: 'var(--fg)',
};

const BINDING_OVERLAY: CSSProperties = {
  position: 'absolute',
  bottom: -2,
  right: -2,
  transform: 'scale(0.7)',
  transformOrigin: 'bottom right',
};

const LOGIN: CSSProperties = {
  fontSize: 12,
  color: 'var(--fg)',
  maxWidth: 64,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const COMMITS: CSSProperties = {
  fontSize: 11,
  color: 'var(--good)',
  whiteSpace: 'nowrap',
};

const MORE_PILL: CSSProperties = {
  width: 48,
  height: 48,
  borderRadius: '50%',
  background: 'var(--bg-2)',
  color: 'var(--fg-dim)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 13,
  fontWeight: 600,
};

const EMPTY: CSSProperties = {
  fontSize: 13,
  color: 'var(--fg-dim)',
};

export type { PeopleCardPerson, PeopleCardProps };

const DEFAULT_PROFILE_HREF = (p: PeopleCardPerson): string =>
  `/users/github/${p.github_user_id}`;

function initials(p: PeopleCardPerson): string {
  const base = p.display_name ?? p.login ?? '?';
  const parts = base.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (
      (parts[0]?.charAt(0) ?? '') + (parts[1]?.charAt(0) ?? '')
    ).toUpperCase();
  }
  return (base.charAt(0) ?? '?').toUpperCase();
}

export function PeopleCard(props: PeopleCardProps): ReactNode {
  const {
    people,
    maxAvatars = 12,
    buildProfileHref = DEFAULT_PROFILE_HREF,
  } = props;

  const visible = people.slice(0, maxAvatars);
  const overflow = Math.max(0, people.length - visible.length);

  return (
    <div style={CARD} data-testid="insights-people-card">
      <div style={TITLE}>
        People <span style={COUNT_PILL}>{people.length}</span>
      </div>

      {people.length === 0 ? (
        <div style={EMPTY} data-testid="people-card-empty">
          No contributors yet.
        </div>
      ) : (
        <div style={STACK}>
          {visible.map((p) => (
            <a
              key={p.github_user_id}
              href={buildProfileHref(p)}
              style={PERSON}
              aria-label={p.display_name ? `${p.display_name} profile` : `${p.login} profile`}
              data-testid={`people-card-person-${p.github_user_id}`}
            >
              <div style={AVATAR_WRAP}>
                {p.avatar_url ? (
                  <img
                    src={p.avatar_url}
                    alt={p.login}
                    style={AVATAR}
                  />
                ) : (
                  <div style={AVATAR_FALLBACK}>{initials(p)}</div>
                )}
                <div style={BINDING_OVERLAY}>
                  <BindingStatusBadge status={p.binding_status} />
                </div>
              </div>
              <div style={LOGIN}>@{p.login}</div>
              {typeof p.commitCount === 'number' ? (
                <div
                  style={COMMITS}
                  title={`${p.commitCount} commits on GitHub (tier-A, verified)`}
                  data-testid={`people-card-commits-${p.github_user_id}`}
                >
                  ✓ {p.commitCount.toLocaleString()}
                </div>
              ) : null}
            </a>
          ))}
          {overflow > 0 ? (
            <div
              style={PERSON}
              title={`${overflow} more`}
              data-testid="people-card-overflow"
            >
              <div style={MORE_PILL}>+{overflow}</div>
              <div style={LOGIN}>more</div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
