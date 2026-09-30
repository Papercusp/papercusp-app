/**
 * POST /api/harness/binding/claim — Phase 8 P-069e claim CTA backend.
 *
 * Wraps Phase 1b P-068's `claimBinding` (binding-service.ts) over HTTP so
 * the live `/adv` HarnessClaimHeader's "Claim this harness" CTA can call
 * it. `claimBinding` was in tree but UNEXPOSED — there was no claim route,
 * so the CTA had no backend. This is that backend.
 *
 * Body: { binding_id: "github:<repoId>" } (the opaque id the claim-status
 * route returns). On success → 200 { binding }. On a typed BindingServiceError
 * (the GitHub maintain/admin permission check fails, binding gone, etc.) →
 * the structured error is mapped to an HTTP status + JSON body so the CTA
 * surfaces an actionable message (P-069e: "rejection surfaces structured
 * perm error").
 *
 * Core logic is `runClaim(bindingId, deps)` (deps injected) so it's unit-
 * testable without GitHub/PG; the handler wires the real `claimBinding`.
 *
 * Public (loopback desktop) — the claim itself is gated server-side by the
 * acting user's real GitHub repo permission inside `claimBinding`.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24 P-069e.
 */

import { defineTool } from '@papercusp/agent-mcp';
import { claimBinding } from '../../../harness/binding-service';
import {
  BindingServiceErrorThrowable,
  type BindingRecord,
  type BindingServiceError,
} from '../../../harness/binding-types';

export interface ClaimDeps {
  claimBinding: (input: { binding_id: string }) => Promise<BindingRecord>;
}

/** Raised on bad input; the handler maps it to a 400. */
export class ClaimInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaimInputError';
  }
}

export function parseClaimBody(
  body: unknown,
): { ok: true; bindingId: string } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body required' };
  const b = body as { binding_id?: unknown };
  if (typeof b.binding_id !== 'string' || b.binding_id.length === 0) {
    return { ok: false, error: 'binding_id required' };
  }
  return { ok: true, bindingId: b.binding_id };
}

/** Claim the binding. Rejects an empty id BEFORE calling the service. */
export async function runClaim(
  bindingId: string,
  deps: ClaimDeps,
): Promise<{ binding: BindingRecord }> {
  if (!bindingId || typeof bindingId !== 'string') {
    throw new ClaimInputError('binding_id required');
  }
  const binding = await deps.claimBinding({ binding_id: bindingId });
  return { binding };
}

/**
 * Map a BindingServiceError to { status, body, retryAfterSec? }. The body
 * carries the structured detail (e.g. actual/required perm) so the CTA can
 * render a precise message rather than a generic failure.
 */
export function httpForClaimError(err: BindingServiceError): {
  status: number;
  body: Record<string, unknown>;
  retryAfterSec?: number;
} {
  switch (err.code) {
    case 'CLAIM_PERMISSION_DENIED':
      return {
        status: 403,
        body: { error: err.code, actual: err.actual, required: err.required },
      };
    case 'BINDING_NOT_FOUND':
      return { status: 404, body: { error: err.code } };
    case 'BINDING_NOT_CLAIMABLE':
      return { status: 409, body: { error: err.code, reason: err.reason } };
    case 'GITHUB_REPO_NOT_FOUND':
      return { status: 404, body: { error: err.code } };
    case 'GITHUB_REPO_PRIVATE_NO_ACCESS':
      return { status: 403, body: { error: err.code } };
    case 'GITHUB_API_RATE_LIMIT':
      return {
        status: 429,
        body: { error: err.code },
        retryAfterSec: Math.ceil(err.retry_after_ms / 1000),
      };
    case 'GITHUB_API_DOWN':
      return { status: 502, body: { error: err.code } };
    default:
      return { status: 500, body: { error: (err as { code?: string }).code ?? 'UNKNOWN' } };
  }
}

const realDeps: ClaimDeps = { claimBinding };

const post = defineTool({
  method: 'POST',
  path: '/harness/binding/claim',
  auth: 'loopback',
  async handler(req) {
    const parsed = parseClaimBody(await req.json().catch(() => null));
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    try {
      const result = await runClaim(parsed.bindingId, realDeps);
      return Response.json(result);
    } catch (e) {
      if (e instanceof ClaimInputError) {
        return Response.json({ error: e.message }, { status: 400 });
      }
      if (e instanceof BindingServiceErrorThrowable) {
        const { status, body, retryAfterSec } = httpForClaimError(e.error);
        return Response.json(body, {
          status,
          ...(retryAfterSec !== undefined
            ? { headers: { 'Retry-After': String(retryAfterSec) } }
            : {}),
        });
      }
      throw e;
    }
  },
});

export default [post];
