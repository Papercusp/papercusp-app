/**
 * GET /api/viewer — the current local viewer's GitHub identity.
 *
 * Resolves the local machine's GitHub identity (`resolveLocalGithubIdentity`)
 * = "who is operating this desktop". This is the viewer-identity infra the
 * live `/adv` shell was missing: it backs the `useViewer()` hook (UI
 * affordances — "this is you", working-set Start/Stop buttons) and lets
 * server-side handlers resolve the viewer for §18 privacy filtering.
 *
 * NEVER returns the OAuth token. Anonymous (gh not authenticated) →
 * `{ github_user_id: null, github_login: null }` at 200 — NOT an error;
 * the shell renders the public/anonymous view.
 *
 * Single-user desktop: each engineer runs their own operator, so the local
 * identity IS the viewer. The operator is loopback-bound (Host + 127.0.0.1),
 * so `auth: 'public'` here is effectively local-only.
 *
 * Plan: viewer-identity-infra (Phase-8 cross-cutting unblocker for P-038
 * write path, P-072 privacy filter, P-048/P-049/P-069 viewer surfaces).
 */

import { defineTool } from '@papercusp/agent-mcp';
import { resolveLocalGithubIdentity } from '../../../identity/resolve-local-github-identity';

export interface ViewerIdentityResponse {
  github_user_id: number | null;
  github_login: string | null;
}

const get = defineTool({
  method: 'GET',
  path: '/viewer',
  auth: 'public',
  async handler() {
    let id;
    try {
      id = await resolveLocalGithubIdentity();
    } catch {
      // resolveLocalGithubIdentity is documented never-throws, but be
      // defensive: a resolution failure is "anonymous", never a 500.
      return Response.json({ github_user_id: null, github_login: null } satisfies ViewerIdentityResponse);
    }
    if (id.kind !== 'ok') {
      return Response.json({ github_user_id: null, github_login: null } satisfies ViewerIdentityResponse);
    }
    // Token deliberately omitted — the frontend never sees it.
    return Response.json({
      github_user_id: id.githubUserId,
      github_login: id.githubLogin,
    } satisfies ViewerIdentityResponse);
  },
});

export default [get];
