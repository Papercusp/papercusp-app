/**
 * GET /api/desktop/agent-auth-status — per-provider sign-in detection
 * for the Setup Wizard's logins step.
 *
 * Ported from app/api/desktop/agent-auth-status/route.ts. `auth: {}` —
 * any resolved principal (the route's prior `requirePrincipal(headers)`
 * with no requirements); the route-stack runs the gate.
 */
import { claudeSignedIn, codexSignedIn, ompSignedIn, ompAuthStatus, githubSignedIn } from '../../../agent-auth-detect';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/desktop/agent-auth-status',
  auth: {},
  handler() {
    let claude = false;
    let codex = false;
    let omp = false;
    let ompAuth: ReturnType<typeof ompAuthStatus> | null = null;
    let github = false;
    try { claude = claudeSignedIn(); } catch { /* fs error → false */ }
    try { codex = codexSignedIn(); } catch { /* fs error → false */ }
    try { omp = ompSignedIn(); } catch { /* fs error → false */ }
    // ompAuth.accessExpired distinguishes "signed in" from "signed in but the
    // OAuth token expired → re-login" — the file-presence `omp` boolean cannot.
    try { ompAuth = ompAuthStatus(); } catch { /* fs/parse error → null */ }
    try { github = githubSignedIn(); } catch { /* fs error → false */ }
    return Response.json({ claude, codex, omp, ompAuth, github });
  },
});
