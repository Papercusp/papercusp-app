/**
 * useViewer — the current local viewer's GitHub identity in the live shell.
 *
 * Backed by `GET /api/viewer` (resolveLocalGithubIdentity, no token). This is
 * the viewer-identity infra the `/adv` shell was missing: it tells components
 * "who is operating this desktop" so they can show "this is you" affordances
 * and enable viewer-scoped writes (e.g. the working-set Start/Stop button).
 *
 * Lives in apps/operator/app (consumed by operator-vite via the @/app alias),
 * NOT operator-vite — the panels under app/adv import it directly.
 *
 * Module-cached: `/api/viewer` is fetched once and shared (identity rarely
 * changes within a session). Anonymous (no gh auth) → `{ githubUserId: null }`.
 *
 * Plan: viewer-identity-infra (Phase-8 cross-cutting unblocker).
 */
import { useEffect, useState } from 'react';

export interface Viewer {
  githubUserId: number | null;
  githubLogin: string | null;
}

const ANONYMOUS: Viewer = { githubUserId: null, githubLogin: null };

/** Normalize the raw `/api/viewer` JSON into a `Viewer` (pure — unit-tested). */
export function normalizeViewer(raw: unknown): Viewer {
  if (!raw || typeof raw !== 'object') return ANONYMOUS;
  const r = raw as { github_user_id?: unknown; github_login?: unknown };
  const id = typeof r.github_user_id === 'number' && r.github_user_id > 0 ? r.github_user_id : null;
  const login = typeof r.github_login === 'string' && r.github_login.length > 0 ? r.github_login : null;
  return { githubUserId: id, githubLogin: login };
}

/** True iff the given github id is the current viewer (pure — unit-tested). */
export function isViewer(viewer: Viewer | null, githubUserId: number | null | undefined): boolean {
  return viewer?.githubUserId != null && viewer.githubUserId === githubUserId;
}

let cached: Viewer | null = null;
let inflight: Promise<Viewer> | null = null;

async function fetchViewer(): Promise<Viewer> {
  if (cached) return cached;
  if (!inflight) {
    inflight = fetch('/api/viewer', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : ANONYMOUS))
      .then(normalizeViewer)
      .catch(() => ANONYMOUS)
      .then((v) => {
        cached = v;
        return v;
      });
  }
  return inflight;
}

/** Test-only: reset the module cache (so tests don't bleed identity). */
export function __resetViewerCacheForTests(): void {
  cached = null;
  inflight = null;
}

export interface UseViewerResult {
  viewer: Viewer | null;
  loading: boolean;
  /** Convenience: is `githubUserId` the current viewer? */
  isMe: (githubUserId: number | null | undefined) => boolean;
}

export function useViewer(): UseViewerResult {
  const [viewer, setViewer] = useState<Viewer | null>(cached);
  const [loading, setLoading] = useState<boolean>(cached == null);

  useEffect(() => {
    let alive = true;
    fetchViewer().then((v) => {
      if (!alive) return;
      setViewer(v);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  return { viewer, loading, isMe: (id) => isViewer(viewer, id) };
}
