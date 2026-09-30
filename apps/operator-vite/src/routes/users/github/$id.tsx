import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import {
  UserProfile,
  type UserProfileData,
} from '@/app/users/github/[id]/UserProfile';

/**
 * /users/github/$id — Vite mirror of the SSR Next page at
 * apps/operator/app/users/github/[id]/page.tsx.
 *
 * Phase 8 P-072 + D-028. The canonical numeric profile route. Fetches
 * GET /api/users/github/:id (the JSON endpoint that wraps
 * loadUserProfile) on mount + renders the UserProfile component.
 *
 * Without this route the SPA fallback served the 200 shell + TSR
 * could not locate the page; Marketplace `publishedBy` deep-links
 * landed on the not-found component.
 */

export const Route = createFileRoute('/users/github/$id')({
  component: UserProfilePage,
});

interface ProfileApiResponse {
  profile?: UserProfileData;
  error?: string;
}

function UserProfilePage() {
  const { id } = Route.useParams();
  const [data, setData] = useState<UserProfileData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const numericId = Number.parseInt(id, 10);
    if (!Number.isFinite(numericId) || numericId <= 0) {
      setError(`Invalid user id: ${id}`);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/users/github/${numericId}`, {
          cache: 'no-store',
        });
        if (!res.ok) {
          if (!cancelled) setError(`HTTP ${res.status}`);
          return;
        }
        const body = (await res.json().catch(() => ({}))) as ProfileApiResponse;
        if (cancelled) return;
        if (body.profile) setData(body.profile);
        else setError(body.error ?? 'profile payload missing');
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <div style={{ padding: 32, color: 'var(--fg-dim, #888)', fontSize: 13 }}>
        <p>Could not load profile: {error}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ padding: 32, color: 'var(--fg-dim, #888)', fontSize: 13 }}>
        Loading profile…
      </div>
    );
  }

  return <UserProfile data={data} />;
}
