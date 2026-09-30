/**
 * POST /api/admin/owner-presence/touch — record a human-turn owner-presence signal
 * (owner-presence-human-turn-signal-2026-07-11 P-002). The psu pty-host hits this,
 * fire-and-forget, on every human keystroke into an agent's terminal (onStdin —
 * backend-agnostic across claude/codex/omp; socket-injected agent wakes take a
 * separate path and never reach it). It upserts `harness_shared.owner_activity`
 * so `readOwnerPresence` (coord:orient) reflects an owner who drives an agent over
 * the CLI/desktop pty channel — which the OMP/web token-refresh chain is blind to.
 *
 * Workspace: `?workspace=<id>` query (what the pty-host sends, from PAPERCUSP_WORKSPACE)
 * or `{ workspace }` body; defaults to 'default'. Non-secret, idempotent, harmless to
 * repeat. Returns { ok:true, workspace }.
 */
import { touchOwnerActivity } from '../../../power-user-sessions';
import { requireAllowedOriginOr403 } from '../../cors';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/admin/owner-presence/touch',
  // unverified-loopback: cookie-less desktop webview / local pty-host process (EI-338),
  // same trust posture as the sibling admin POSTs. Writes only a non-secret timestamp.
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  async handler(req) {
    // Hardens against a browser cross-origin POST; a no-Origin server-to-server
    // request (the pty-host fetch) passes through (cors: `if (!origin) return null`).
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;

    let workspace = '';
    try {
      workspace = String(new URL(req.url).searchParams.get('workspace') ?? '').trim();
    } catch {
      /* malformed URL — fall through to body/default */
    }
    if (!workspace) {
      try {
        const body = (await req.json()) as { workspace?: unknown } | null;
        if (body && typeof body.workspace === 'string') workspace = body.workspace.trim();
      } catch {
        /* no/invalid body — use default */
      }
    }
    if (!workspace) workspace = 'default';

    try {
      await touchOwnerActivity(workspace);
    } catch (err) {
      return Response.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
    return Response.json({ ok: true, workspace });
  },
});
