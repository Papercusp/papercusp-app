/**
 * POST /api/admin/substrate/revoke-self-device
 *
 * Plan: substrate-revocation-v1 Task 3 (D-003/D-004/D-005).
 *
 * Trigger a self-revocation: revoke ONE of the caller's own device pubkeys
 * from a harness (lost or rotated device). Writes the updated contributor
 * row to the booted handle's own log (replicates + projects to
 * `harness_shared.contributors`) AND calls handle.revoke() for immediate
 * local effect.
 *
 * Auth: `{ trust: ['verified', 'trusted'] }` — same gate as the sibling
 * admin substrate-health endpoint. Admin-only.
 *
 * Core logic is `handleRevokeSelfDevice(input, deps)` (deps injected) so
 * it's unit-testable without a live substrate; the defineTool handler wires
 * the real impl and maps result codes to HTTP status codes.
 *
 * Status-code mapping:
 *   ok:true              → 200
 *   not_your_key         → 403 (can only revoke own keys)
 *   no_contributor_row   → 404 (no published identity for this harness)
 *   gh_auth_required     → 401 (not authenticated with GitHub)
 *   bad input            → 400
 */

import { defineTool } from '@papercusp/agent-mcp';
import { revokeSelfDevice, type RevokeSelfDeviceSeams } from '../../../sync/hyperbee/revoke-self-device';

// ─── injectable core ──────────────────────────────────────────────────────────

export interface RevokeSelfDeviceEndpointInput {
  workspaceId: string;
  harnessSlug: string;
  devicePubkey: string;
}

export interface RevokeSelfDeviceEndpointDeps {
  revoke: (input: RevokeSelfDeviceEndpointInput, seams?: RevokeSelfDeviceSeams) => ReturnType<typeof revokeSelfDevice>;
}

const realDeps: RevokeSelfDeviceEndpointDeps = {
  revoke: (input) => revokeSelfDevice(input),
};

function parseBody(body: unknown): RevokeSelfDeviceEndpointInput | { error: string } {
  if (body === null || typeof body !== 'object') {
    return { error: 'request body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  const workspaceId = typeof b.workspaceId === 'string' ? b.workspaceId.trim() : '';
  const harnessSlug = typeof b.harnessSlug === 'string' ? b.harnessSlug.trim() : '';
  const devicePubkey = typeof b.devicePubkey === 'string' ? b.devicePubkey.trim() : '';
  if (!workspaceId) return { error: 'workspaceId is required and must be a non-empty string' };
  if (!harnessSlug) return { error: 'harnessSlug is required and must be a non-empty string' };
  if (!devicePubkey) return { error: 'devicePubkey is required and must be a non-empty string' };
  return { workspaceId, harnessSlug, devicePubkey };
}

export async function handleRevokeSelfDevice(
  input: RevokeSelfDeviceEndpointInput,
  deps: RevokeSelfDeviceEndpointDeps = realDeps,
): Promise<Response> {
  const result = await deps.revoke(input);
  if (result.ok) {
    return Response.json(result);
  }
  switch (result.code) {
    case 'not_your_key':
      return Response.json(
        { error: 'You can only revoke your own device keys', code: result.code },
        { status: 403 },
      );
    case 'no_contributor_row':
      return Response.json(
        { error: 'No published contributor row found for this harness — cannot self-revoke without a published identity', code: result.code },
        { status: 404 },
      );
    case 'gh_auth_required':
      return Response.json(
        { error: 'GitHub authentication required — run `gh auth login` and retry', code: result.code },
        { status: 401 },
      );
    default: {
      // TypeScript exhaustiveness guard.
      const _never: never = result;
      return Response.json({ error: 'unexpected error', detail: String(_never) }, { status: 500 });
    }
  }
}

// ─── endpoint ─────────────────────────────────────────────────────────────────

const post = defineTool({
  method: 'POST',
  path: '/admin/substrate/revoke-self-device',
  // Admin-only: same trust gate as dogfood-substrate-health (per D-003 decision).
  auth: { trust: ['verified', 'trusted'] },
  async handler(req) {
    const body = await req.json().catch(() => null);
    const parsed = parseBody(body);
    if ('error' in parsed) {
      return Response.json({ error: parsed.error }, { status: 400 });
    }
    return handleRevokeSelfDevice(parsed);
  },
});

export default [post];
