/**
 * POST /api/admin/execute-action — auth-gated, slug-less verb dispatcher.
 *
 * Ported from app/api/admin/execute-action/route.ts. `auth: 'public'` —
 * the route does its own Bearer-token auth via `deriveCallerFromBearer`.
 * Wire contract: docs/host/execute-action.contract.md.
 */
import {
  deriveCallerFromBearer,
  validateIdentityFields,
  executeAction,
  type ExecuteActionRequest,
} from '../../../execute-action';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/admin/execute-action',
  auth: { trust: ['verified', 'trusted'] },
  async handler(req) {
    // 1. Auth: derive caller slug from Bearer token.
    const auth = await deriveCallerFromBearer(req.headers.get('authorization'));
    if (!auth.ok) {
      return Response.json(
        { ok: false, error: auth.error, detail: auth.detail ?? null },
        { status: auth.status },
      );
    }
    const callerSlug = auth.slug;

    // 2. Parse body.
    let body: ExecuteActionRequest;
    try {
      body = (await req.json()) as ExecuteActionRequest;
    } catch {
      return Response.json(
        { ok: false, error: 'validation_error', detail: 'invalid JSON body' },
        { status: 400 },
      );
    }

    // 3. Identity-field validation.
    const idFail = validateIdentityFields(callerSlug, body);
    if (idFail) {
      return Response.json(
        { ok: false, error: idFail.error, detail: idFail.detail ?? null },
        { status: idFail.status },
      );
    }

    // 4. Dispatch with idempotency.
    let result;
    try {
      result = await executeAction(callerSlug, body);
    } catch (e: any) {
      return Response.json(
        { ok: false, actionId: body.actionId ?? null, error: 'internal', detail: String(e?.message ?? e).slice(0, 500) },
        { status: 500 },
      );
    }

    if (result.ok) {
      return Response.json(result, { status: 200 });
    }

    // Map error → status code.
    const statusByError: Record<string, number> = {
      validation_error: 400,
      parent_slug_not_caller_controlled: 400,
      template_not_spawnable: 400,
      invalid_or_missing_token: 401,
      identity_mismatch: 403,
      not_found: 404,
      slug_already_in_use: 409,
      rate_limited: 429,
      internal: 500,
    };
    const status = statusByError[result.error ?? ''] ?? 500;
    return Response.json(result, { status });
  },
});
