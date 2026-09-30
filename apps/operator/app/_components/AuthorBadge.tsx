'use client';

/**
 * AuthorBadge — plan ownership / attribution badge
 * (shared-hive-collaboration-2026-06-14 P-001, Brief B1).
 *
 * Renders a resolved author identity as an avatar (GitHub avatar when bound,
 * else an initials chip) + a handle — NEVER a raw email. Used for plan owner +
 * last-editor (plan list rows + detail) and per-item author. The identity is
 * resolved server-side by lib/identity/resolve-plan-author-identity and arrives
 * pre-shaped on the plans.* sync payloads; this component never queries data
 * (mirrors ContributorBadge), so it is trivially testable from any surface.
 *
 * Styling mirrors ContributorBadge: inline CSSProperties over CSS variables, so
 * no shared stylesheet edit is needed and the badge themes with the app.
 */

import type { CSSProperties, ReactNode } from 'react';
import { ownerColor } from './owner-color';

/** Client-side mirror of lib/identity ResolvedAuthor (kept local so the SPA
 *  bundle never pulls the server-side resolver module). */
export interface AuthorIdentity {
  id: string;
  handle: string;
  /**
   * OPTIONAL on the wire, not just nullable (EI-19455103442009801). The
   * plans:list UI projection now OMITS this key when it is null — it was null on
   * 1,475/1,475 live occurrences, 25,075 B of pure dead weight — so a list-fed
   * identity arrives WITHOUT the key, while plans:items and the attention feed
   * still send an explicit `null`. Both readings must stay legal, hence
   * `?: string | null`.
   *
   * ⚠ Read it with TRUTHINESS (`avatarUrl ? … : …`, `??`, `?.`) as the badge
   * below does. `=== null`, `'avatarUrl' in identity`, `hasOwnProperty` and
   * destructuring-with-a-default all break on an omitted key — see
   * {@link file://../../../../packages/operator-core/lib/agent-tools/plans/ui-read-projection.ts}
   * `omitNullValues` for the full wire contract.
   */
  avatarUrl?: string | null;
  kind: 'human' | 'agent';
  verified: boolean;
}

export interface AuthorBadgeProps {
  identity: AuthorIdentity | null | undefined;
  /** A small dim lead-in, e.g. "owner" or "edited by". */
  prefix?: string;
  /** Compact (avatar-only) vs full (avatar + handle). Default 'full'. */
  variant?: 'full' | 'compact';
}

const WRAP: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 12,
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
  maxWidth: '100%',
  minWidth: 0,
};

const AVATAR_SIZE = 16;

const AVATAR_BASE: CSSProperties = {
  width: AVATAR_SIZE,
  height: AVATAR_SIZE,
  borderRadius: '50%',
  flex: '0 0 auto',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 9,
  fontWeight: 600,
  lineHeight: 1,
  overflow: 'hidden',
  border: '1px solid var(--border)',
};

const HANDLE: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: 0,
};

function initialOf(handle: string): string {
  return (handle.trim()[0] || '?').toUpperCase();
}

export function AuthorBadge(props: AuthorBadgeProps): ReactNode {
  const { identity, prefix, variant = 'full' } = props;
  if (!identity) return null;

  const { handle, avatarUrl, kind, verified } = identity;
  const isAgent = kind === 'agent';

  // P-003 per-user color: a stable per-identity hue makes a busy shared plan
  // list visually parseable at a glance. Applied to HUMANS only (agents are
  // machines → the muted ⚙ chip); keyed on the resolved identity id so the same
  // owner reads as the same color everywhere.
  const tintBorder = isAgent ? undefined : ownerColor(identity.id, { saturation: 55, lightness: 60 });
  const tintBg = isAgent ? undefined : ownerColor(identity.id, { saturation: 55, lightness: 32, alpha: 0.35 });

  // Agents are machines — a muted, monospace, glyph-led chip; humans get an
  // avatar (github when verified, else initials) ringed in their identity color.
  const avatar = avatarUrl ? (
    <img
      src={avatarUrl}
      alt=""
      width={AVATAR_SIZE}
      height={AVATAR_SIZE}
      style={{ ...AVATAR_BASE, objectFit: 'cover', ...(tintBorder ? { borderColor: tintBorder } : {}) }}
      referrerPolicy="no-referrer"
    />
  ) : (
    <span
      aria-hidden="true"
      style={{
        ...AVATAR_BASE,
        background: isAgent ? 'var(--bg-1, transparent)' : (tintBg ?? 'var(--bg-2)'),
        color: 'var(--fg-dim)',
        fontFamily: isAgent ? 'var(--font-mono, monospace)' : undefined,
        ...(tintBorder ? { borderColor: tintBorder } : {}),
      }}
    >
      {isAgent ? '⚙' : initialOf(handle)}
    </span>
  );

  const title = `${prefix ? `${prefix}: ` : ''}${handle}${isAgent ? ' (agent)' : ''}${
    verified ? ' · github-verified' : ''
  }`;

  return (
    <span
      style={WRAP}
      title={title}
      data-testid="author-badge"
      data-kind={kind}
      data-verified={verified ? 'true' : 'false'}
    >
      {prefix && variant === 'full' && (
        <span style={{ color: 'var(--fg-dim)' }}>{prefix}</span>
      )}
      {avatar}
      {variant === 'full' && (
        <span
          style={{
            ...HANDLE,
            color: isAgent ? 'var(--fg-dim)' : 'var(--fg)',
            fontFamily: isAgent ? 'var(--font-mono, monospace)' : undefined,
          }}
        >
          {handle}
        </span>
      )}
      {verified && (
        <span aria-hidden="true" style={{ color: 'var(--accent, #4CAF50)' }} title="GitHub-verified">
          ✓
        </span>
      )}
    </span>
  );
}
