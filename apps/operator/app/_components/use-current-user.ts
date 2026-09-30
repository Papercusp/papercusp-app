'use client';

/**
 * The SIGNED-IN user's own identity, for surfaces that must render the USER's
 * profile icon rather than the pane's brand mark.
 *
 * WI-6503 [owner 2026-07-27, verbatim follow-up] "the chat box should
 * disaply the users profile icon in their chat, not the papercup icon". The
 * requirement is a SUBSTITUTION, not a deletion — rendering nothing satisfies
 * the item's original title and is explicitly NOT what was asked for.
 *
 * Source is `GET /api/auth/me` — the SAME endpoint the account menu
 * (UserPicker) reads — so the chip beside a user's chat message is the same
 * identity they already recognise from the top-right of the chrome. Resolving
 * it from the account (rather than from the conversation's title or role
 * label) is what the item requires: never a string match.
 *
 * `harness_shared.users` carries no avatar column, so a local account's profile
 * icon IS its initial — that is precisely what UserPicker renders as
 * `.pc-user-avatar`. Callers therefore get `initial` and fall back to a neutral
 * person glyph while the identity is still resolving, or if it never does.
 * Never fall back to the papercup mark: that fallback IS the reported bug.
 *
 * This is a stable per-session fact, not query data, which is why it is a
 * one-shot fetch rather than a `@papercusp/sync` query — the same call pattern
 * UserPicker, ChatwootWidget and HostCheckBanner already use for this endpoint.
 * One in-flight request is shared process-wide and a resolved identity is
 * cached, so mounting several chat panes at once costs a single request.
 */

import { useEffect, useState } from 'react';

export interface CurrentUserIdentity {
  id: string;
  username: string;
  displayName: string;
  /** Single uppercase character for the initials avatar (mirrors UserPicker). */
  initial: string;
}

interface AuthMeUser {
  id?: unknown;
  username?: unknown;
  display_name?: unknown;
}

/** Mirrors UserPicker's own displayName/initial derivation so the two agree. */
function toIdentity(raw: unknown): CurrentUserIdentity | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as AuthMeUser;
  const id = typeof u.id === 'string' ? u.id : '';
  const username = typeof u.username === 'string' ? u.username.trim() : '';
  const display = typeof u.display_name === 'string' ? u.display_name.trim() : '';
  const displayName = display || username;
  if (!displayName) return null;
  return {
    id,
    username: username || displayName,
    displayName,
    initial: (displayName[0] ?? 'U').toUpperCase(),
  };
}

// Only a SUCCESSFUL resolution is cached. A transient auth/me failure must not
// pin "no identity" for the life of the page — the next mount retries.
let cached: CurrentUserIdentity | null = null;
let inFlight: Promise<CurrentUserIdentity | null> | null = null;

async function loadCurrentUser(): Promise<CurrentUserIdentity | null> {
  if (cached) return cached;
  inFlight ??= (async () => {
    try {
      const res = await fetch('/api/auth/me');
      if (!res.ok) return null;
      const body = (await res.json()) as { user?: unknown };
      return toIdentity(body?.user);
    } catch {
      return null;
    }
  })().then((identity) => {
    if (identity) cached = identity;
    inFlight = null;
    return identity;
  });
  return inFlight;
}

/**
 * Returns the signed-in user's identity, or null until it resolves (or if it
 * cannot be resolved at all). Never throws and never surfaces an error state:
 * a chat avatar degrading to a neutral glyph is strictly better than a chat
 * pane that fails to render.
 */
export function useCurrentUserIdentity(): CurrentUserIdentity | null {
  const [identity, setIdentity] = useState<CurrentUserIdentity | null>(cached);

  useEffect(() => {
    if (identity) return;
    let cancelled = false;
    void loadCurrentUser().then((resolved) => {
      if (!cancelled && resolved) setIdentity(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [identity]);

  return identity;
}

/** Test-only: drops the module-level cache so each case starts clean. */
export function __resetCurrentUserCacheForTests(): void {
  cached = null;
  inFlight = null;
}
