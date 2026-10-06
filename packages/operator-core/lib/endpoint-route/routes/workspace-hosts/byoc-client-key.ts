/** Desktop key lifecycle and customer-host public-key authorization over the local provider tunnel. */
import { defineTool } from '@papercusp/agent-mcp';
import {
  createByocClientKey,
  revokeByocClientKey,
  rotateByocClientKey,
  type ByocClientKeyScope,
} from '../../../workspace-host/byoc-client-key-custody';
import {
  assertAuthorizedByocClientKey,
  authorizeByocClientKey,
  FileByocClientAuthorizationStore,
  revokeAuthorizedByocClientKey,
  rotateAuthorizedByocClientKey,
  type ByocClientAuthorizationScope,
  type ByocClientAuthorizationStore,
} from '../../../workspace-host/byoc-client-authorization';

type JsonRecord = Record<string, unknown>;
const HOST_ID = /^[a-z0-9][a-z0-9._:-]{0,159}$/i;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseScope(value: unknown, hostId: string): ByocClientAuthorizationScope | null {
  if (!isRecord(value)) return null;
  const scope = {
    organizationId: value.organizationId,
    workspaceId: value.workspaceId,
    hostId: value.hostId,
    clientId: value.clientId,
  };
  if (Object.values(scope).some((field) => typeof field !== 'string') || scope.hostId !== hostId) return null;
  return scope as ByocClientAuthorizationScope;
}

export function requireCustomerHostLoopbackOrigin(value: unknown): string {
  if (typeof value !== 'string') throw new Error('customerHostOrigin is required');
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) throw new Error('customerHostOrigin must be a bare http://127.0.0.1:<port> tunnel origin');
  return url.origin;
}

async function hostMutation(
  fetchImpl: typeof fetch,
  origin: string,
  hostId: string,
  body: JsonRecord,
): Promise<JsonRecord> {
  const response = await fetchImpl(`${origin}/api/workspace-hosts/${encodeURIComponent(hostId)}/byoc-client-authorization`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({})) as JsonRecord;
  if (!response.ok || result.ok !== true) {
    throw new Error(typeof result.error === 'string' ? result.error : `customer host refused BYOC key (${response.status})`);
  }
  return result;
}

export interface ByocClientKeyRouteDependencies {
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  authorizationStore: ByocClientAuthorizationStore;
  now: () => string;
}

const DEFAULT_DEPENDENCIES: ByocClientKeyRouteDependencies = {
  env: process.env,
  fetchImpl: globalThis.fetch,
  authorizationStore: new FileByocClientAuthorizationStore(),
  now: () => new Date().toISOString(),
};

export function createByocClientKeyRoutes(
  dependencies: ByocClientKeyRouteDependencies = DEFAULT_DEPENDENCIES,
) {
  const desktopLifecycle = defineTool({
    method: 'POST',
    path: '/workspace-hosts/:hostId/byoc-client-key',
    auth: 'loopback',
    async handler(req, ctx) {
      const hostId = String(ctx.params.hostId ?? '').trim();
      if (!HOST_ID.test(hostId)) return Response.json({ ok: false, error: 'invalid workspace host id' }, { status: 400 });
      if (dependencies.env.PAPERCUSP_DESKTOP !== '1') {
        return Response.json({ ok: false, error: 'BYOC client key lifecycle is available only in the signed desktop sidecar' }, { status: 403 });
      }
      const body = await req.json().catch(() => null);
      if (!isRecord(body)) return Response.json({ ok: false, error: 'body must be an object' }, { status: 400 });
      const scope = parseScope(body.scope, hostId);
      if (!scope) return Response.json({ ok: false, error: 'invalid BYOC client key scope' }, { status: 400 });
      let origin: string;
      try {
        origin = requireCustomerHostLoopbackOrigin(body.customerHostOrigin);
      } catch (error) {
        return Response.json({ ok: false, error: (error as Error).message }, { status: 400 });
      }

      try {
        if (body.action === 'create') {
          const created = await createByocClientKey(scope as ByocClientKeyScope);
          const authorization = await hostMutation(dependencies.fetchImpl, origin, hostId, {
            action: 'authorize', scope, publicKeyBase64: created.publicKeyBase64,
          });
          return Response.json({ ok: true, ...created, generation: authorization.generation });
        }
        if (body.action === 'rotate' && typeof body.publicKeyBase64 === 'string') {
          const rotated = await rotateByocClientKey(
            scope as ByocClientKeyScope,
            body.publicKeyBase64,
            async (nextPublicKeyBase64) => {
              await hostMutation(dependencies.fetchImpl, origin, hostId, {
                action: 'rotate', scope, oldPublicKeyBase64: body.publicKeyBase64, publicKeyBase64: nextPublicKeyBase64,
              });
            },
            async (oldPublicKeyBase64) => {
              await hostMutation(dependencies.fetchImpl, origin, hostId, {
                action: 'revoke', scope, publicKeyBase64: oldPublicKeyBase64,
              });
            },
          );
          return Response.json({ ok: true, ...rotated });
        }
        if (body.action === 'revoke' && typeof body.publicKeyBase64 === 'string') {
          await revokeByocClientKey(scope as ByocClientKeyScope, body.publicKeyBase64, async (publicKeyBase64) => {
            await hostMutation(dependencies.fetchImpl, origin, hostId, { action: 'revoke', scope, publicKeyBase64 });
          });
          return Response.json({ ok: true, status: 'revoked' });
        }
        return Response.json({ ok: false, error: 'action must be create, rotate, or revoke with the required public key' }, { status: 400 });
      } catch (error) {
        return Response.json({ ok: false, error: (error as Error).message }, { status: 409 });
      }
    },
  });

  const hostAuthorization = defineTool({
    method: 'POST',
    path: '/workspace-hosts/:hostId/byoc-client-authorization',
    auth: 'loopback',
    async handler(req, ctx) {
      const hostId = String(ctx.params.hostId ?? '').trim();
      if (!HOST_ID.test(hostId)) return Response.json({ ok: false, error: 'invalid workspace host id' }, { status: 400 });
      if (dependencies.env.PAPERCUSP_DISTRIBUTION_PROFILE !== 'vm-release') {
        return Response.json({ ok: false, error: 'BYOC client authorization is available only on the customer workspace host' }, { status: 403 });
      }
      const body = await req.json().catch(() => null);
      if (!isRecord(body)) return Response.json({ ok: false, error: 'body must be an object' }, { status: 400 });
      const scope = parseScope(body.scope, hostId);
      if (!scope || typeof body.publicKeyBase64 !== 'string') {
        return Response.json({ ok: false, error: 'invalid BYOC client authorization request' }, { status: 400 });
      }
      try {
        const record = body.action === 'authorize'
          ? await authorizeByocClientKey(dependencies.authorizationStore, scope, body.publicKeyBase64, dependencies.now())
          : body.action === 'rotate' && typeof body.oldPublicKeyBase64 === 'string'
            ? await rotateAuthorizedByocClientKey(dependencies.authorizationStore, scope, body.oldPublicKeyBase64, body.publicKeyBase64, dependencies.now())
            : body.action === 'revoke'
              ? await revokeAuthorizedByocClientKey(dependencies.authorizationStore, scope, body.publicKeyBase64, dependencies.now())
              : body.action === 'assert'
                ? await assertAuthorizedByocClientKey(
                    dependencies.authorizationStore,
                    scope,
                    body.publicKeyBase64,
                    typeof body.generation === 'number' ? body.generation : undefined,
                  )
                : null;
        if (!record) return Response.json({ ok: false, error: 'action must be authorize, rotate, revoke, or assert' }, { status: 400 });
        return Response.json({ ok: true, status: record.status, generation: record.generation });
      } catch (error) {
        return Response.json({ ok: false, error: (error as Error).message }, { status: 409 });
      }
    },
  });

  return [desktopLifecycle, hostAuthorization];
}

export default createByocClientKeyRoutes();
