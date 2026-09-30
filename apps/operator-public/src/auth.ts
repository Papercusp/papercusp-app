/**
 * GitHub-bearer auth for Cupboard.
 *
 * Pattern: client sends `Authorization: Bearer <github_token>`. We
 * validate the token by calling GitHub's `/user` endpoint — if it
 * returns 200, we know the token is valid + we get the canonical
 * `id` (numeric) and `login` for the caller. Token never persisted.
 *
 * Token shape: anything that can call `/user` works — `gh auth login`
 * device-flow tokens, classic PATs, fine-grained PATs, OAuth-app tokens.
 * The desktop operator uses Phase 1b `gh-token.ts` which produces a
 * device-flow token; same shape goes here.
 *
 * Cache: 60s in-memory per-Worker LRU is overkill at v1 scale —
 * Cloudflare Workers have weak cross-request continuity anyway.
 * Skip caching; pay the ~50-150ms GitHub round-trip per authed call.
 * Re-evaluate when listing traffic justifies it.
 */

export interface GhUser {
  id: number;
  login: string;
}

export class AuthError extends Error {
  constructor(public reason: 'missing_bearer' | 'github_rejected' | 'github_unreachable', message?: string) {
    super(message ?? reason);
  }
}

const GH_API = 'https://api.github.com';

export async function resolveGithubBearer(req: Request): Promise<GhUser> {
  const auth = req.headers.get('authorization') ?? '';
  const m = auth.match(/^Bearer\s+(\S+)$/i);
  if (!m) throw new AuthError('missing_bearer', 'Authorization: Bearer <gh_token> required');
  const token = m[1];

  let res: Response;
  try {
    res = await fetch(`${GH_API}/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'papercusp-cupboard',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch (e) {
    throw new AuthError('github_unreachable', (e as Error).message);
  }
  if (res.status === 401 || res.status === 403) {
    throw new AuthError('github_rejected', `gh /user returned ${res.status}`);
  }
  if (!res.ok) {
    throw new AuthError('github_unreachable', `gh /user returned ${res.status}`);
  }
  const body = (await res.json()) as { id?: number; login?: string };
  if (typeof body.id !== 'number' || typeof body.login !== 'string') {
    throw new AuthError('github_rejected', 'gh /user response missing id/login');
  }
  return { id: body.id, login: body.login };
}

/**
 * Verify the authed user has `maintain` or `admin` permission on a
 * repo (for the claim/supersede flow per addendum 1 + Phase 1b P-068).
 */
export async function checkRepoPermission(
  token: string,
  owner: string,
  repo: string,
  required: 'maintain' | 'admin',
): Promise<{ has_permission: boolean; permission: string }> {
  const res = await fetch(
    `${GH_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'papercusp-cupboard',
      },
    },
  );
  if (!res.ok) return { has_permission: false, permission: '' };
  const body = (await res.json()) as { permissions?: Record<string, boolean> };
  const perm = body.permissions ?? {};
  if (required === 'admin') return { has_permission: !!perm.admin, permission: 'admin' };
  // maintain implies admin too
  return { has_permission: !!perm.admin || !!perm.maintain, permission: perm.admin ? 'admin' : (perm.maintain ? 'maintain' : '') };
}

/**
 * Cupboard-operator allowlist. Operators are identified by GitHub user id
 * (public, not secret) listed in the `CUPBOARD_OPERATOR_GITHUB_IDS` var. An
 * operator still authenticates with a normal GitHub bearer (`resolveGithubBearer`);
 * this gates every /admin operator surface (moderation and artifact publication).
 * Empty / unset ⇒ no operators ⇒ /admin is closed.
 */
export function parseOperatorIds(env: { CUPBOARD_OPERATOR_GITHUB_IDS?: string }): Set<number> {
  return new Set(
    (env.CUPBOARD_OPERATOR_GITHUB_IDS ?? '')
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0),
  );
}

export function isCupboardOperator(
  userId: number,
  env: { CUPBOARD_OPERATOR_GITHUB_IDS?: string },
): boolean {
  return parseOperatorIds(env).has(userId);
}

/** Lift the raw bearer back out of the request (for forwarded perm checks). */
export function extractBearer(req: Request): string {
  const auth = req.headers.get('authorization') ?? '';
  const m = auth.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : '';
}
