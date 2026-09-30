/**
 * POST /api/agent-mcp/console/resolve — returns ConsoleEnvelope for native term.
 * Ported from app/api/agent-mcp/console/resolve/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 */
import { activeWorkspaceId } from '../../../workspace-registry';
import { buildConsoleEnvelope } from '../../../console-launcher';
import { PrincipalCheckError, requirePrincipal } from '../../../auth/require-principal';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/console/resolve',
  auth: 'loopback',
  async handler(req) {
    try {
      await requirePrincipal(req.headers);
    } catch (err) {
      if (err instanceof PrincipalCheckError) {
        return Response.json({ error: err.reason }, { status: err.status });
      }
      throw err;
    }
    const body = (await req.json().catch(() => ({}))) as {
      slug?: string | null;
      // psu-in-desktop-builds B: the Tauri (mac/Windows) path threads runPsu so
      // the native console runs psu on open. Flag-gated in buildConsoleEnvelope.
      runPsu?: boolean;
      // WI-3882: the Tauri-fallback twin of console-launch.ts's resumeSessionId
      // — was accepted on the primary /console/launch route but silently
      // dropped on this one, so a resume request on a non-Linux operator (the
      // only case that reaches this fallback) always opened a fresh session.
      resumeSessionId?: string | null;
      // WI-3882: fork twin of console-launch.ts's `fork` — branch the resumed
      // (still-live) session instead of resuming it in place, so the Tauri
      // (non-Linux operator) fallback path forks identically to the primary one.
      fork?: boolean;
    };
    const workspaceId = activeWorkspaceId();
    try {
      const envelope = await buildConsoleEnvelope({
        workspaceId,
        slug: body.slug ?? null,
        operatorBaseUrl: new URL(req.url).origin,
        runPsu: body.runPsu ?? false,
        resumeSessionId: body.resumeSessionId ?? undefined,
        fork: body.fork ?? false,
      });
      return Response.json(envelope);
    } catch (e: any) {
      return Response.json({ error: e?.message ?? 'console-resolve failed' }, { status: 400 });
    }
  },
});
