/**
 * Papercusp relay routes (external-app-access P-008, D-001 / D-009 / D-031): the HTTP surface of
 * lib/remote-access/relay-opt-in.ts for the Remote access screen's "Papercusp relay" card.
 *
 * Same rule as the own-tunnel routes: every route is loopback-only at the route stack AND
 * re-checked in the handler (isLoopbackHost also refuses a request carrying the external-ingress
 * marker, so a call relayed IN through the portal can never reach these controls), and mutating
 * routes refuse cross-site browser requests. Only the person at this computer agrees to the
 * notice, connects, or disconnects.
 */
import { defineTool } from '@papercusp/agent-mcp';
import type { RouteDefinition } from '@papercusp/agent-mcp';
import { isLoopbackHost } from '../device/_shared';
import {
  PortalRelayError,
  acceptPortalRelayNotice,
  beginPortalRelayLink,
  cancelPortalRelayLink,
  disconnectPortalRelay,
  portalRelayStatus,
  reconcilePortalRelay,
} from '../../../remote-access/relay-opt-in';

type AnyRoute = RouteDefinition<any>;

const noStore = { 'cache-control': 'no-store' };

export interface PortalRelayRouteDependencies {
  readonly isLocal: (req: Request) => boolean;
  readonly status: () => ReturnType<typeof portalRelayStatus>;
  readonly accept: (input: { noticeVersion: number; by?: string | null }) => ReturnType<typeof acceptPortalRelayNotice>;
  readonly begin: (input: { portalOrigin?: string }) => ReturnType<typeof beginPortalRelayLink>;
  readonly cancel: () => ReturnType<typeof cancelPortalRelayLink>;
  readonly disconnect: () => ReturnType<typeof disconnectPortalRelay>;
  /** Nudge the reconciler after a change so the screen moves without waiting for the next tick. */
  readonly reconcileSoon: () => void;
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

const USER_FIXABLE: ReadonlySet<PortalRelayError['code']> = new Set([
  'consent_required',
  'notice_outdated',
  'hosted_machine',
  'already_linked',
  'invalid_portal_origin',
]);

/** User-fixable refusal → 400 (hosted machine → 409), portal trouble → 502, anything else → 500. */
function failure(err: unknown): Response {
  if (err instanceof PortalRelayError) {
    if (err.code === 'hosted_machine' || err.code === 'already_linked') return jsonError(err.code, 409, { message: err.message });
    if (USER_FIXABLE.has(err.code)) return jsonError(err.code, 400, { message: err.message });
    return jsonError(err.code, 502, { message: err.message });
  }
  return jsonError('internal_error', 500, { message: err instanceof Error ? err.message : String(err) });
}

export function createPortalRelayRoutes(deps: PortalRelayRouteDependencies): ReadonlyArray<AnyRoute> {
  const guard = (req: Request, mutating: boolean): Response | null => {
    if (!deps.isLocal(req)) return jsonError('local_only', 403);
    if (mutating && !isSameOriginOrNonBrowser(req)) return jsonError('cross_origin_blocked', 403);
    return null;
  };

  const status = defineTool({
    method: 'GET',
    path: '/remote-access/portal-relay',
    auth: 'loopback',
    async handler(req) {
      const denied = guard(req, false);
      if (denied) return denied;
      try {
        return ok({ relay: await deps.status() });
      } catch (err) {
        return failure(err);
      }
    },
  });

  const consent = defineTool({
    method: 'POST',
    path: '/remote-access/portal-relay/consent',
    auth: 'loopback',
    async handler(req) {
      const denied = guard(req, true);
      if (denied) return denied;
      const body = await readJson(req);
      if (!body || typeof body.noticeVersion !== 'number') return jsonError('invalid_request', 400);
      try {
        return ok({ relay: await deps.accept({ noticeVersion: body.noticeVersion }) });
      } catch (err) {
        return failure(err);
      }
    },
  });

  const connect = defineTool({
    method: 'POST',
    path: '/remote-access/portal-relay/connect',
    auth: 'loopback',
    async handler(req) {
      const denied = guard(req, true);
      if (denied) return denied;
      const body = await readJson(req);
      if (!body) return jsonError('invalid_json', 400);
      if (body.portalOrigin !== undefined && typeof body.portalOrigin !== 'string') return jsonError('invalid_request', 400);
      try {
        const relay = await deps.begin({ portalOrigin: typeof body.portalOrigin === 'string' && body.portalOrigin.trim() ? body.portalOrigin : undefined });
        deps.reconcileSoon();
        return ok({ relay });
      } catch (err) {
        return failure(err);
      }
    },
  });

  const cancel = defineTool({
    method: 'POST',
    path: '/remote-access/portal-relay/cancel',
    auth: 'loopback',
    async handler(req) {
      const denied = guard(req, true);
      if (denied) return denied;
      try {
        const relay = await deps.cancel();
        deps.reconcileSoon();
        return ok({ relay });
      } catch (err) {
        return failure(err);
      }
    },
  });

  const disconnect = defineTool({
    method: 'POST',
    path: '/remote-access/portal-relay/disconnect',
    auth: 'loopback',
    async handler(req) {
      const denied = guard(req, true);
      if (denied) return denied;
      try {
        const relay = await deps.disconnect();
        deps.reconcileSoon();
        return ok({ relay });
      } catch (err) {
        return failure(err);
      }
    },
  });

  return [status, consent, connect, cancel, disconnect];
}

const routes: ReadonlyArray<AnyRoute> = createPortalRelayRoutes({
  isLocal: isLoopbackHost,
  status: () => portalRelayStatus(),
  accept: (input) => acceptPortalRelayNotice(input),
  begin: (input) => beginPortalRelayLink(input),
  cancel: () => cancelPortalRelayLink(),
  disconnect: () => disconnectPortalRelay(),
  reconcileSoon: () => {
    void reconcilePortalRelay();
  },
});

export default routes;
