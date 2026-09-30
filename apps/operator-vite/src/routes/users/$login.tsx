import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

/**
 * /users/$login — username-keyed entry point.
 *
 * Phase 8 P-072e + D-028. Resolves the login via
 * GET /api/users/by-login/:login → { github_user_id } and replaces
 * the URL with the canonical numeric /users/github/:id route.
 *
 * Mirrors the SSR Next page at apps/operator/app/users/[login]/page.tsx
 * which uses Next's `redirect()`. Under Vite we navigate client-side
 * so the user lands on the canonical route without a full page reload.
 *
 * 404 + invalid-login errors render a small not-found state in place;
 * the canonical numeric route is still reachable directly.
 */

export const Route = createFileRoute('/users/$login')({
  component: UserLoginRedirect,
});

interface ResolveResponse {
  github_user_id?: number;
  error?: string;
}

function UserLoginRedirect() {
  const { login } = Route.useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!login || login.length > 100) {
      setError(`Invalid username: ${login}`);
      return;
    }
    let cancelled = false;
    const resolve = async () => {
      try {
        const res = await fetch(`/api/users/by-login/${encodeURIComponent(login)}`, {
          cache: 'no-store',
        });
        if (cancelled) return;
        if (res.status === 404) {
          setError(`No profile found for @${login}.`);
          return;
        }
        if (!res.ok) {
          setError(`HTTP ${res.status}`);
          return;
        }
        const body = (await res.json().catch(() => ({}))) as ResolveResponse;
        if (cancelled) return;
        if (typeof body.github_user_id === 'number') {
          // TSR navigate with `replace: true` so back-button skips the
          // redirect step (matches Next's redirect() semantics).
          void navigate({
            to: '/users/github/$id',
            params: { id: String(body.github_user_id) },
            replace: true,
          });
        } else {
          setError(body.error ?? 'profile resolution returned no id');
        }
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void resolve();
    return () => {
      cancelled = true;
    };
  }, [login, navigate]);

  if (error) {
    return (
      <div style={{ padding: 32, color: 'var(--fg-dim, #888)', fontSize: 13 }}>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div style={{ padding: 32, color: 'var(--fg-dim, #888)', fontSize: 13 }}>
      Looking up @{login}…
    </div>
  );
}
