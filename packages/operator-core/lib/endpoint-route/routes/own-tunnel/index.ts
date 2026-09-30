/**
 * Own-tunnel routes (external-app-access P-009, D-001): the HTTP surface of
 * lib/own-tunnel/service.ts for the setup wizard's "use my own tunnel" step and the
 * Remote access screen (P-010).
 *
 * Every route is loopback-only at the route stack AND re-checked in the handler: only the
 * person at this computer sets up, switches off or removes the install's tunnel. Mutating
 * routes also refuse cross-site browser requests. None of these paths is served on the
 * external-ingress listener (external-ingress-paths.ts), so the tunnel can never reach
 * its own controls.
 */
import { defineTool } from '@papercusp/agent-mcp';
import type { RouteDefinition } from '@papercusp/agent-mcp';
import { isLoopbackHost } from '../device/_shared';
import { CloudflareApiError } from '../../../own-tunnel/cloudflare-api';
import { OwnTunnelInputError } from '../../../own-tunnel/config';
import { installCloudflared } from '../../../own-tunnel/install';
import { loginStatus } from '../../../own-tunnel/runtime';
import {
  beginCloudflareSignIn,
  cancelCloudflareSignIn,
  ownTunnelStatus,
  provisionOwnTunnel,
  removeOwnTunnel,
  setOwnTunnelEnabledNow,
  signedInZone,
  useManualTunnel,
} from '../../../own-tunnel/service';

type AnyRoute = RouteDefinition<any>;

const noStore = { 'cache-control': 'no-store' };

export interface OwnTunnelRouteDependencies {
  readonly isLocal: (req: Request) => boolean;
  readonly status: typeof ownTunnelStatus;
  readonly install: typeof installCloudflared;
  readonly beginSignIn: typeof beginCloudflareSignIn;
  readonly cancelSignIn: typeof cancelCloudflareSignIn;
  readonly signInStatus: typeof loginStatus;
  readonly signedInZone: typeof signedInZone;
  readonly provision: typeof provisionOwnTunnel;
  readonly manual: typeof useManualTunnel;
  readonly setEnabled: typeof setOwnTunnelEnabledNow;
  readonly remove: typeof removeOwnTunnel;
}

function jsonError(code: string, status: number, extra: Record<string, unknown> = {}): Response {
  return Response.json({ ok: false, error: { code, ...extra } }, { status, headers: noStore });
}

function ok(body: Record<string, unknown>): Response {
  return Response.json({ ok: true, ...body }, { headers: noStore });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    if (!text.trim()) return {};
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A browser request from another site never reaches these controls (fetch metadata + Origin). */
function isSameOriginOrNonBrowser(req: Request): boolean {
  const origin = req.headers.get('origin');
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  if (origin === null) return true;
  if (origin === 'null') return site === 'same-origin';
  return origin === new URL(req.url).origin;
}

function str(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Map a service failure to a response: user-fixable input → 400, Cloudflare refusal → 502. */
function failure(err: unknown): Response {
  if (err instanceof OwnTunnelInputError) return jsonError(err.code, 400, { message: err.message });
  if (err instanceof CloudflareApiError) {
    return jsonError('cloudflare_error', 502, { message: err.message, status: err.status });
  }
  return jsonError('internal_error', 500, { message: err instanceof Error ? err.message : String(err) });
}

export function createOwnTunnelRoutes(deps: OwnTunnelRouteDependencies): ReadonlyArray<AnyRoute> {
  const guard = (req: Request, mutating: boolean): Response | null => {
    if (!deps.isLocal(req)) return jsonError('local_only', 403);
    if (mutating && !isSameOriginOrNonBrowser(req)) return jsonError('cross_origin_blocked', 403);
    return null;
  };

  const status = defineTool({
    method: 'GET',
    path: '/remote-access/own-tunnel',
    auth: 'loopback',
    async handler(req) {
      const denied = guard(req, false);
      if (denied) return denied;
      try {
        return ok({ tunnel: await deps.status() });
      } catch (err) {
        return failure(err);
      }
    },
  });

  const install = defineTool({
    method: 'POST',
    path: '/remote-access/own-tunnel/install-cloudflared',
    auth: 'loopback',
    async handler(req) {
      const denied = guard(req, true);
      if (denied) return denied;
      try {
        const installed = await deps.install();
        return ok({ installed });
      } catch (err) {
        return failure(err);
      }
    },
  });

  const signInStart = defineTool({
    method: 'POST',
    path: '/remote-access/own-tunnel/sign-in',
    auth: 'loopback',
    async handler(req) {
      const denied = guard(req, true);
      if (denied) return denied;
      try {
        return ok({ signIn: await deps.beginSignIn() });
      } catch (err) {
        return failure(err);
      }
    },
  });

  const signInPoll = defineTool({
    method: 'GET',
    path: '/remote-access/own-tunnel/sign-in',
    auth: 'loopback',
    async handler(req) {
      const denied = guard(req, false);
      if (denied) return denied;
      const signIn = deps.signInStatus();
      try {
        const zone = signIn.state === 'complete' ? await deps.signedInZone() : null;
        return ok({ signIn: { ...signIn, zoneName: zone?.zoneName ?? null } });
      } catch (err) {
        return failure(err);
      }
    },
  });

  const signInCancel = defineTool({
    method: 'POST',
    path: '/remote-access/own-tunnel/sign-in/cancel',
    auth: 'loopback',
    async handler(req) {
      const denied = guard(req, true);
      if (denied) return denied;
      deps.cancelSignIn();
      return ok({});
    },
  });

  const provision = defineTool({
    method: 'POST',
    path: '/remote-access/own-tunnel/cloudflare',
    auth: 'loopback',
    async handler(req) {
      const denied = guard(req, true);
      if (denied) return denied;
      const body = await readJson(req);
      if (!body) return jsonError('invalid_json', 400);
      try {
        const tunnel = await deps.provision({
          hostname: str(body, 'hostname'),
          label: str(body, 'label'),
          apiToken: str(body, 'apiToken'),
        });
        return ok({ tunnel });
      } catch (err) {
        return failure(err);
      }
    },
  });

  const manual = defineTool({
    method: 'POST',
    path: '/remote-access/own-tunnel/manual',
    auth: 'loopback',
    async handler(req) {
      const denied = guard(req, true);
      if (denied) return denied;
      const body = await readJson(req);
      if (!body) return jsonError('invalid_json', 400);
      if (body.port !== undefined && typeof body.port !== 'number') return jsonError('invalid_port', 400);
      try {
        const tunnel = await deps.manual({
          port: typeof body.port === 'number' ? body.port : undefined,
          hostname: str(body, 'hostname') ?? null,
        });
        return ok({ tunnel });
      } catch (err) {
        return failure(err);
      }
    },
  });

  const setEnabled = defineTool({
    method: 'POST',
    path: '/remote-access/own-tunnel/enabled',
    auth: 'loopback',
    async handler(req) {
      const denied = guard(req, true);
      if (denied) return denied;
      const body = await readJson(req);
      if (!body || typeof body.enabled !== 'boolean') return jsonError('invalid_request', 400);
      try {
        return ok({ tunnel: await deps.setEnabled(body.enabled) });
      } catch (err) {
        return failure(err);
      }
    },
  });

  const remove = defineTool({
    method: 'POST',
    path: '/remote-access/own-tunnel/remove',
    auth: 'loopback',
    async handler(req) {
      const denied = guard(req, true);
      if (denied) return denied;
      const body = await readJson(req);
      if (!body) return jsonError('invalid_json', 400);
      try {
        const result = await deps.remove({ keepIfCloudflareFails: body.force !== true });
        return ok({ result });
      } catch (err) {
        return failure(err);
      }
    },
  });

  return [status, install, signInStart, signInPoll, signInCancel, provision, manual, setEnabled, remove];
}

const routes: ReadonlyArray<AnyRoute> = createOwnTunnelRoutes({
  isLocal: isLoopbackHost,
  status: ownTunnelStatus,
  install: installCloudflared,
  beginSignIn: beginCloudflareSignIn,
  cancelSignIn: cancelCloudflareSignIn,
  signInStatus: loginStatus,
  signedInZone,
  provision: provisionOwnTunnel,
  manual: useManualTunnel,
  setEnabled: setOwnTunnelEnabledNow,
  remove: removeOwnTunnel,
});

export default routes;
