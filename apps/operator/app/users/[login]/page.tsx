/**
 * /users/[login] — username-keyed entry point, redirects to the
 * canonical numeric route per v5 D-028.
 *
 * Plan: papercusp-dogfood-phase8 P-072e.
 *
 * Shell: resolves the username to a github_user_id via PG (contributors
 * table) when available; otherwise returns a 404. The real resolver
 * will land alongside the data fetch in /users/github/[id]/page.tsx.
 */

import { redirect, notFound } from '@/lib/router-compat/navigation';
import { getOrgPg } from '@papercusp/db-org';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ login: string }>;
}

async function resolveLoginToId(login: string): Promise<number | null> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ github_user_id: number }[]>`
      SELECT github_user_id
        FROM harness_shared.contributors
       WHERE github_username = ${login}
       LIMIT 1
    `;
    return rows[0]?.github_user_id ?? null;
  } catch {
    // PG unreachable — fall through; the canonical route can still be
    // hit directly by id. Better than crashing the username flow.
    return null;
  }
}

export default async function UserByLoginRedirect({ params }: PageProps) {
  const { login } = await params;
  if (!login || login.length > 100) notFound();
  const id = await resolveLoginToId(login);
  if (id == null) notFound();
  redirect(`/users/github/${id}`);
}
