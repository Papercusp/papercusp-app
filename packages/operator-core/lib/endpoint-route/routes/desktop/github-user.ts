/**
 * GET /api/desktop/github-user
 *
 * Returns the locally authenticated GitHub user's numeric id and login
 * by running `gh api user`. Returns 404 when `gh` is not installed or
 * the user is not logged in.
 */
import execa from 'execa';
import { defineTool } from '@papercusp/agent-mcp';

export interface LocalGithubUser {
  id: number;
  login: string;
}

export const desktopGithubUser = defineTool({
  method: 'GET',
  path: '/desktop/github-user',
  auth: 'public',
  async handler() {
    try {
      const { stdout } = await execa('gh', ['api', 'user', '--jq', '{id:.id,login:.login}'], {
        timeout: 10_000,
      });
      const parsed = JSON.parse(stdout.trim()) as { id: number; login: string };
      if (typeof parsed.id !== 'number' || typeof parsed.login !== 'string') {
        return Response.json({ error: 'unexpected gh output' }, { status: 500 });
      }
      return Response.json({ id: parsed.id, login: parsed.login } satisfies LocalGithubUser);
    } catch {
      return Response.json({ error: 'gh not available or not authenticated' }, { status: 404 });
    }
  },
});
