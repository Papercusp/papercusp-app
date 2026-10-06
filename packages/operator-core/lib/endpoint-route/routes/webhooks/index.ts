/**
 * Signed webhook ingress (plan external-app-access-to-workspaces-2026-09-29, P-017 / WI-10004021,
 * decision D-032 #3): `POST /api/hooks/:sourceId`.
 *
 * `auth: 'public'` on purpose: an outside system holds no user or app token. The HMAC signature over
 * the raw body IS the credential, and lib/external-triggers/webhook.ts checks it (with the
 * workspace's Remote access switch) before anything is written. The body is read as raw bytes, never
 * re-serialized, because the signature covers the exact bytes the sender sent.
 *
 * Reachable from outside through the user's own tunnel (the external-ingress listener serves this
 * one path shape, apps/operator/bin/external-ingress-paths.ts) or through the Papercusp relay
 * (the portal forwards `POST /api/workspaces/:id/hooks/:sourceId` over the app-http channel).
 */
import { defineTool } from '@papercusp/agent-mcp';
import type { RouteDefinition } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { getRemoteAccess } from '../../../connected-apps/remote-access';
import {
  WEBHOOK_MAX_BODY_BYTES,
  handleWebhookDelivery,
  type WebhookDeliveryRequest,
  type WebhookDeliveryResponse,
} from '../../../external-triggers/webhook';

type AnyRoute = RouteDefinition<any>;

const noStore = { 'cache-control': 'no-store' };

export interface WebhookRouteDependencies {
  readonly deliver: (request: WebhookDeliveryRequest) => Promise<WebhookDeliveryResponse>;
}

function respond(result: WebhookDeliveryResponse): Response {
  return Response.json(result.body, { status: result.status, headers: { ...noStore, ...(result.headers ?? {}) } });
}

export function createWebhookRoutes(deps: WebhookRouteDependencies): ReadonlyArray<AnyRoute> {
  const receive = defineTool({
    method: 'POST',
    path: '/hooks/:sourceId',
    auth: 'public',
    async handler(req, ctx) {
      // Refuse an oversized body from its declared length before reading it.
      const declared = Number(req.headers.get('content-length') ?? '');
      if (Number.isFinite(declared) && declared > WEBHOOK_MAX_BODY_BYTES) {
        return respond({ status: 413, body: { ok: false, error: 'body_too_large', limitBytes: WEBHOOK_MAX_BODY_BYTES } });
      }
      let rawBody: Uint8Array;
      try {
        rawBody = new Uint8Array(await req.arrayBuffer());
      } catch {
        return respond({ status: 400, body: { ok: false, error: 'invalid_body' } });
      }
      const sourceId = String((ctx.params as Record<string, string> | undefined)?.sourceId ?? '');
      try {
        return respond(await deps.deliver({ sourceId, headers: req.headers, rawBody }));
      } catch (err) {
        return respond({
          status: 500,
          body: { ok: false, error: 'internal_error', message: (err instanceof Error ? err.message : String(err)).slice(0, 300) },
        });
      }
    },
  });
  return [receive];
}

const routes: ReadonlyArray<AnyRoute> = createWebhookRoutes({
  deliver: (request) =>
    handleWebhookDelivery(request, {
      // Lazy: a request refused on its body alone (size, not a JSON object, not a source id)
      // never opens the database pool, so unauthenticated junk costs no connection.
      get sql() {
        return getOrgPg().sql;
      },
      remoteAccessEnabled: async (workspaceId) => (await getRemoteAccess(workspaceId)).enabled,
    }),
});

export default routes;
