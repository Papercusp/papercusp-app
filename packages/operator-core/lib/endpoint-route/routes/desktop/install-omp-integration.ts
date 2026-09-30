/**
 * /api/desktop/install/omp-integration  — GET / POST / DELETE / OPTIONS
 *
 * Phase 2 of desktop-app-install-integration-2026-05-23 (D-002a:
 * POSIX-only in v1). The settings UI hits GET to read state and POST
 * to apply / re-apply; DELETE uninstalls.
 *
 * `auth: 'public'` — localhost-only by sidecar bind (same posture as
 * sibling /desktop/install/papercusp-files).
 */
import { defineTool } from '@papercusp/agent-mcp';
import {
  installOmpIntegration,
  readOmpIntegrationState,
  uninstallOmpIntegration,
} from '../../../desktop-install/omp-integration';

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

export default [
  defineTool({
    method: 'GET',
    path: '/desktop/install/omp-integration',
    auth: 'public',
    async handler() {
      try {
        const state = await readOmpIntegrationState();
        return json(200, { ok: true, ...state });
      } catch (err) {
        return json(500, { ok: false, error: String((err as Error).message ?? err) });
      }
    },
  }),
  defineTool({
    method: 'POST',
    path: '/desktop/install/omp-integration',
    auth: 'loopback',
    async handler() {
      try {
        const result = await installOmpIntegration();
        return json(200, { ok: true, ...result });
      } catch (err) {
        return json(500, { ok: false, error: String((err as Error).message ?? err) });
      }
    },
  }),
  defineTool({
    method: 'DELETE',
    path: '/desktop/install/omp-integration',
    auth: 'loopback',
    async handler() {
      try {
        const result = await uninstallOmpIntegration();
        return json(200, { ok: true, ...result });
      } catch (err) {
        return json(500, { ok: false, error: String((err as Error).message ?? err) });
      }
    },
  }),
  defineTool({
    method: 'OPTIONS',
    path: '/desktop/install/omp-integration',
    auth: 'public',
    handler() {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    },
  }),
];
