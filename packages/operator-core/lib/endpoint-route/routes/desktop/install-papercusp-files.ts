/**
 * POST /api/desktop/install/papercusp-files
 *
 * Phase 1 of desktop-app-install-integration-2026-05-23: always-on
 * file install. Mints/reuses token + agent_id, refreshes the engineer-
 * collaborator playbook + coordination extension under ~/.papercusp/.
 *
 * No third-party-config touches — that's Phase 2 (opt-in
 * /api/desktop/install/omp-integration).
 *
 * `auth: 'public'` — localhost-only by virtue of the sidecar's bind
 * (PAPERCUSP_BIND_HOST default 127.0.0.1; see operator-auth-loopback
 * memory). The Tauri host fires this at startup; best-effort, logs on
 * failure.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { installPapercuspFiles } from '../../../desktop-install/papercusp-files';

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export default [
  defineTool({
    method: 'POST',
    path: '/desktop/install/papercusp-files',
    auth: 'loopback',
    async handler() {
      try {
        const result = await installPapercuspFiles();
        return new Response(
          JSON.stringify({
            ok: true,
            tokenPath: result.tokenPath,
            agentIdPath: result.agentIdPath,
            playbookPath: result.playbookPath,
            extensionPath: result.extensionPath,
            playbookWritten: result.playbookWritten,
            extensionWritten: result.extensionWritten,
            playbookSource: result.playbookSource,
            extensionSource: result.extensionSource,
            minted: result.minted,
            claudeHooksInstalled: result.claudeHooksInstalled,
            claudeSettingsMerged: result.claudeSettingsMerged,
          }),
          { status: 200, headers: { 'content-type': 'application/json', ...CORS_HEADERS } },
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ ok: false, error: String((err as Error).message ?? err) }),
          { status: 500, headers: { 'content-type': 'application/json', ...CORS_HEADERS } },
        );
      }
    },
  }),
  defineTool({
    method: 'OPTIONS',
    path: '/desktop/install/papercusp-files',
    auth: 'public',
    handler() {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    },
  }),
];
