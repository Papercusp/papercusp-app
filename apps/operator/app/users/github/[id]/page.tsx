/**
 * /users/github/[id] — numeric canonical route for user profile.
 *
 * Plan: papercusp-dogfood-phase8 P-072e + D-028.
 *
 * Resolves the numeric github_user_id via `loadUserProfile`, which
 * queries PG (contributors + harness_features_consolidated +
 * shared_repo_binding_cache). Falls back to an empty profile if
 * the tables aren't populated yet (defensive — fresh installs
 * before dogfood ensure ran).
 *
 * Privacy filter (Q-2) honors `viewer_github_user_id` resolved from
 * the session; viewers seeing their own profile bypass the filter.
 */

import { getOrgPg } from '@papercusp/db-org';
import { UserProfile } from './UserProfile';
import { loadUserProfile } from '@papercusp/operator-core/lib/user-profile/load';
import { getSessionUserOrDefault } from '@papercusp/operator-core/lib/auth';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

async function viewerGithubUserId(): Promise<number | null> {
  try {
    const user = await getSessionUserOrDefault();
    const ghId = (user as { github_user_id?: number | string | null })?.github_user_id;
    if (typeof ghId === 'number' && Number.isFinite(ghId)) return ghId;
    if (typeof ghId === 'string') {
      const parsed = Number.parseInt(ghId, 10);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  } catch {
    return null;
  }
}

export default async function UserProfilePage({ params }: PageProps) {
  const { id } = await params;
  const numericId = parseInt(id, 10);
  if (!Number.isFinite(numericId) || numericId <= 0) {
    return (
      <div style={{ padding: 32 }}>
        <p>Invalid user id: {id}</p>
      </div>
    );
  }
  const viewerId = await viewerGithubUserId();
  const { sql } = getOrgPg();
  // Postgres tagged-template signature is `(strings, ...values)`. The
  // loader uses an injectable runQuery for testability; here we adapt
  // it to sql.unsafe which accepts a parameterized string + values.
  const runQuery = async <T,>(query: string, paramsArr: unknown[]): Promise<T[]> => {
    return (await sql.unsafe(query, paramsArr as never)) as unknown as T[];
  };
  const data = await loadUserProfile({
    github_user_id: numericId,
    viewer_github_user_id: viewerId,
    runQuery,
  });
  return <UserProfile data={data} />;
}
