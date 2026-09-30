/**
 * POST /api/agent-mcp/operator-dispatch — server-side card dispatch proxy.
 * Forwards to /api/admin/execute-action with the operator bearer attached.
 * Ported from app/api/agent-mcp/operator-dispatch/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 */
import { createHash, randomUUID } from 'node:crypto';
import { activeWorkspaceId } from '../../../workspace-registry';
import { readSystemPrincipal } from '../../../system-principal';
import { getSessionUser } from '../../../auth';
import { defineTool } from '@papercusp/agent-mcp';

interface SystemPrincipalConfig {
  bearer: string;
  name: string;
  workspaceId: string;
  capabilities: string[];
}

function seedToUuid(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

async function loadOperatorBearer(): Promise<SystemPrincipalConfig | null> {
  const p = await readSystemPrincipal('operator');
  return p ? { bearer: p.bearer, name: p.name, workspaceId: p.workspaceId, capabilities: p.capabilities } : null;
}

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/operator-dispatch',
  auth: 'loopback',
  async handler(req) {
    const user = await getSessionUser(req.headers);
    if (!user) {
      return Response.json(
        { ok: false, error: 'unauthenticated', detail: 'no session' },
        { status: 401 },
      );
    }

    const principal = await loadOperatorBearer();
    if (!principal) {
      return Response.json(
        { ok: false, error: 'operator_not_provisioned', detail: 'POST /api/agent-mcp/provision first' },
        { status: 503 },
      );
    }
    const workspaceId = activeWorkspaceId();
    if (principal.workspaceId !== workspaceId) {
      return Response.json(
        { ok: false, error: 'workspace_mismatch', detail: `file=${principal.workspaceId} active=${workspaceId}` },
        { status: 503 },
      );
    }

    let flat: Record<string, unknown>;
    try {
      flat = (await req.json()) as Record<string, unknown>;
    } catch {
      return Response.json(
        { ok: false, error: 'validation_error', detail: 'invalid JSON body' },
        { status: 400 },
      );
    }
    if (!flat || typeof flat !== 'object' || typeof flat.op !== 'string') {
      return Response.json(
        { ok: false, error: 'validation_error', detail: 'op required' },
        { status: 400 },
      );
    }

    const seed =
      typeof flat.actionId === 'string' && flat.actionId.length > 0
        ? flat.actionId
        : null;
    const actionId = seed ? seedToUuid(seed) : randomUUID();
    const { actionId: _unused, ...actionFields } = flat;
    const wrapped = { actionId, action: actionFields };

    const operatorBase = process.env.PAPERCUSP_OPERATOR_BASE ?? `http://localhost:${process.env.PORT ?? '3055'}`;
    const upstream = await fetch(`${operatorBase}/api/admin/execute-action`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${principal.bearer}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(wrapped),
    });

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
    });
  },
});
