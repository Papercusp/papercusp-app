/**
 * GET /api/users/by-login/:login — resolve a github username to its
 * numeric user id.
 *
 * Plan: papercusp-dogfood-phase8 P-072e + D-028.
 *
 * Backs the /users/:login → /users/github/:id redirect in the Vite SPA.
 * Reads harness_shared.contributors (any harness — the username is
 * unique across GitHub). Returns 404 when no contributor row exists
 * for the username yet (e.g. they have not joined any shared harness).
 */

import { getOrgPg } from '@papercusp/db-org';
import { defineTool } from '@papercusp/agent-mcp';

export function isValidLogin(login: unknown): login is string {
  if (typeof login !== 'string') return false;
  if (login.length === 0 || login.length > 100) return false;
  // GitHub usernames: alnum, hyphen (not at start or end), up to 39 chars.
  // We allow up to 100 here for forward-compat; the hard SQL params escape
  // anyway, but a sanity filter rejects path-traversal noise early.
  return /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(login);
}

const get = defineTool({
  method: 'GET',
  path: '/users/by-login/:login',
  auth: 'public',
  async handler(_req, ctx) {
    const login = ctx.params.login as string;
    if (!isValidLogin(login)) {
      return Response.json({ error: 'invalid login' }, { status: 400 });
    }
    try {
      const { sql } = getOrgPg();
      const rows = await sql<{ github_user_id: number }[]>`
        SELECT github_user_id
          FROM harness_shared.contributors
         WHERE github_username = ${login}
         LIMIT 1
      `;
      const id = rows[0]?.github_user_id;
      if (id == null) {
        return Response.json({ error: 'not found', login }, { status: 404 });
      }
      return Response.json({ github_user_id: id, login });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Defensive: PG unreachable / table missing. Treat as 404 so the
      // username redirect falls through to the not-found surface
      // instead of bubbling a 500.
      if (/does not exist|relation .* does not exist/i.test(msg)) {
        return Response.json({ error: 'not found (no contributors yet)', login }, { status: 404 });
      }
      throw e;
    }
  },
});

export default [get];
