/**
 * Remote access screen — the management writes behind Settings → Remote access
 * (external-app-access-to-workspaces-2026-09-29 P-010, decision D-025).
 *
 *   GET  /remote-access?workspaceId=…     local-only  the workspace's switch
 *   POST /remote-access                   local-only  { workspaceId, enabled } — the instant kill switch
 *   POST /remote-access/pause             local-only  { workspaceId, id, paused } — an app/service key or a phone
 *   POST /remote-access/revoke            local-only  { workspaceId, id } — an app/service key or a phone
 *   POST /remote-access/scopes            local-only  { workspaceId, id, tools?, harnesses? } — edit a key's scope
 *
 * The list itself is a sync query (`remoteAccess.overview`, ../../../sync-resolver), and rotation
 * stays on POST /connected-apps/rotate. Every write here calls `notifySyncInvalidate` so the
 * screen updates without a refetch.
 *
 * All routes are loopback-only at the route stack AND re-checked in the handler (isLoopbackHost:
 * loopback Host, trusted loopback peer, and not a tunnel/relay request — P-004); writes also refuse
 * cross-site browser requests. None of these paths is served on the external-ingress listener, so a
 * tunnel can never reach the controls that govern it.
 */
import { defineTool } from '@papercusp/agent-mcp';
import type { RouteDefinition } from '@papercusp/agent-mcp';
import { isLoopbackHost } from '../device/_shared';
import { workspaceById } from '../../../workspace-registry';
import { LOCAL_OWNER_EMAIL } from '../connected-apps';
import {
  AppKeyScopeError,
  resolveAppKeyScopes,
  revokeAppKey,
  setAppKeyPaused,
  setAppKeyScopes,
  type AppKeyRow,
  type AppKeyScopeRequest,
  type AppKeyScopes,
} from '../../../connected-apps/store';
import { getRemoteAccess, setRemoteAccess, type RemoteAccessSetting } from '../../../connected-apps/remote-access';
import { revokeDevice, setDevicePaused } from '../../../device-store';
import { appActivitySummary, type AppActivitySummary } from '../../../connected-apps/activity';

type AnyRoute = RouteDefinition<any>;

/** The sync query the screen reads; every write here invalidates it. */
export const REMOTE_ACCESS_QUERY = 'remoteAccess.overview';

export interface RemoteAccessRouteDependencies {
  readonly isLocal: (req: Request) => boolean;
  readonly workspaceExists: (id: string) => boolean;
  readonly getSwitch: (workspaceId: string) => Promise<RemoteAccessSetting>;
  readonly setSwitch: (workspaceId: string, enabled: boolean, changedBy: string | null) => Promise<RemoteAccessSetting>;
  readonly pauseKey: (workspaceId: string, id: string, paused: boolean) => Promise<boolean>;
  readonly revokeKey: (workspaceId: string, id: string) => Promise<boolean>;
  readonly pauseDevice: (workspaceId: string, id: string, paused: boolean) => Promise<boolean>;
  readonly revokeDevice: (workspaceId: string, id: string) => Promise<boolean>;
  readonly resolveScopes: (req: AppKeyScopeRequest) => AppKeyScopes;
  readonly setScopes: (workspaceId: string, id: string, scopes: AppKeyScopes) => Promise<AppKeyRow | null>;
  /** Push the change to open screens. */
  readonly invalidate: (workspaceId: string) => Promise<void>;
  /** One key's spend against its cap and its recent calls (P-011). Absent = the route answers 404. */
  readonly activity?: (workspaceId: string, appId: string, limit: number) => Promise<AppActivitySummary | null>;
}

const noStore = { 'cache-control': 'no-store' };

function jsonError(code: string, status: number, extra: Record<string, unknown> = {}): Response {
  return Response.json({ ok: false, error: { code, ...extra } }, { status, headers: noStore });
}

function ok(body: Record<string, unknown>): Response {
  return Response.json({ ok: true, ...body }, { headers: noStore });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
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

function str(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  return typeof v === 'string' ? v.trim() : '';
}

function stringList(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) return null;
  return value as string[];
}

function settingView(s: RemoteAccessSetting) {
  return { workspaceId: s.workspaceId, enabled: s.enabled, changedAt: s.changedAt, changedBy: s.changedBy };
}

/** Phones are 'mobile' rows; everything else here is an app or service key. */
function isDeviceKind(kind: unknown): boolean {
  return kind === 'mobile';
}

export function createRemoteAccessRoutes(deps: RemoteAccessRouteDependencies): ReadonlyArray<AnyRoute> {
  const guard = (req: Request, mutating: boolean): Response | null => {
    if (!deps.isLocal(req)) return jsonError('local_only', 403);
    if (mutating && !isSameOriginOrNonBrowser(req)) return jsonError('cross_origin_blocked', 403);
    return null;
  };

  /** Parse and check the workspace of a write; a Response when the request is refused. */
  async function writeTarget(req: Request): Promise<{ body: Record<string, unknown>; workspaceId: string } | Response> {
    const denied = guard(req, true);
    if (denied) return denied;
    const body = await readJson(req);
    if (!body) return jsonError('invalid_json', 400);
    const workspaceId = str(body, 'workspaceId');
    if (!workspaceId) return jsonError('invalid_request', 400);
    if (!deps.workspaceExists(workspaceId)) return jsonError('workspace_not_found', 400);
    return { body, workspaceId };
  }

  const getSwitch = defineTool({
    method: 'GET',
    path: '/remote-access',
    auth: 'loopback',
    async handler(req) {
      const denied = guard(req, false);
      if (denied) return denied;
      const workspaceId = new URL(req.url).searchParams.get('workspaceId')?.trim() ?? '';
      if (!workspaceId) return jsonError('invalid_request', 400);
      if (!deps.workspaceExists(workspaceId)) return jsonError('workspace_not_found', 400);
      return ok({ remoteAccess: settingView(await deps.getSwitch(workspaceId)) });
    },
  });

  const setSwitch = defineTool({
    method: 'POST',
    path: '/remote-access',
    auth: 'loopback',
    async handler(req) {
      const target = await writeTarget(req);
      if (target instanceof Response) return target;
      const { body, workspaceId } = target;
      if (typeof body.enabled !== 'boolean') return jsonError('invalid_request', 400);
      const setting = await deps.setSwitch(workspaceId, body.enabled, LOCAL_OWNER_EMAIL);
      await deps.invalidate(workspaceId);
      return ok({ remoteAccess: settingView(setting) });
    },
  });

  const pause = defineTool({
    method: 'POST',
    path: '/remote-access/pause',
    auth: 'loopback',
    async handler(req) {
      const target = await writeTarget(req);
      if (target instanceof Response) return target;
      const { body, workspaceId } = target;
      const id = str(body, 'id');
      if (!id || typeof body.paused !== 'boolean') return jsonError('invalid_request', 400);
      const done = isDeviceKind(body.kind)
        ? await deps.pauseDevice(workspaceId, id, body.paused)
        : await deps.pauseKey(workspaceId, id, body.paused);
      if (!done) return jsonError('not_found', 404);
      await deps.invalidate(workspaceId);
      return ok({ id, paused: body.paused });
    },
  });

  const revoke = defineTool({
    method: 'POST',
    path: '/remote-access/revoke',
    auth: 'loopback',
    async handler(req) {
      const target = await writeTarget(req);
      if (target instanceof Response) return target;
      const { body, workspaceId } = target;
      const id = str(body, 'id');
      if (!id) return jsonError('invalid_request', 400);
      const done = isDeviceKind(body.kind)
        ? await deps.revokeDevice(workspaceId, id)
        : await deps.revokeKey(workspaceId, id);
      if (!done) return jsonError('not_found', 404);
      await deps.invalidate(workspaceId);
      return ok({ id, revoked: true });
    },
  });

  const scopes = defineTool({
    method: 'POST',
    path: '/remote-access/scopes',
    auth: 'loopback',
    async handler(req) {
      const target = await writeTarget(req);
      if (target instanceof Response) return target;
      const { body, workspaceId } = target;
      const id = str(body, 'id');
      const tools = stringList(body.tools);
      const harnesses = stringList(body.harnesses);
      if (!id || tools === null || harnesses === null) return jsonError('invalid_request', 400);
      let resolved: AppKeyScopes;
      try {
        resolved = deps.resolveScopes({ tools, harnesses });
      } catch (err) {
        if (err instanceof AppKeyScopeError) return jsonError('invalid_scope', 400, { problems: err.problems });
        throw err;
      }
      const app = await deps.setScopes(workspaceId, id, resolved);
      if (!app) return jsonError('not_found', 404);
      await deps.invalidate(workspaceId);
      return ok({ id, scopes: app.scopes });
    },
  });

  /** GET /remote-access/activity?workspaceId=&appId=&limit= — one app's spend and recent calls. */
  const activity = defineTool({
    method: 'GET',
    path: '/remote-access/activity',
    auth: 'loopback',
    async handler(req) {
      const denied = guard(req, false);
      if (denied) return denied;
      const params = new URL(req.url).searchParams;
      const workspaceId = params.get('workspaceId')?.trim() ?? '';
      const appId = params.get('appId')?.trim() ?? '';
      if (!workspaceId || !appId) return jsonError('invalid_request', 400);
      if (!deps.workspaceExists(workspaceId)) return jsonError('workspace_not_found', 400);
      if (!deps.activity) return jsonError('not_found', 404);
      const limit = Number(params.get('limit') ?? 50);
      const summary = await deps.activity(workspaceId, appId, Number.isFinite(limit) ? limit : 50);
      if (!summary) return jsonError('not_found', 404);
      return ok({ activity: summary });
    },
  });

  return [getSwitch, setSwitch, pause, revoke, scopes, activity];
}

/** revokeDevice resolves void; the screen needs to know whether a live phone was hit. */
async function revokeLiveDevice(workspaceId: string, id: string): Promise<boolean> {
  const live = await setDevicePaused(workspaceId, id, false);
  if (!live) return false;
  await revokeDevice(id, workspaceId);
  return true;
}

const routes: ReadonlyArray<AnyRoute> = createRemoteAccessRoutes({
  isLocal: isLoopbackHost,
  workspaceExists: (id) => Boolean(workspaceById(id)),
  getSwitch: getRemoteAccess,
  setSwitch: setRemoteAccess,
  pauseKey: setAppKeyPaused,
  revokeKey: revokeAppKey,
  pauseDevice: setDevicePaused,
  revokeDevice: revokeLiveDevice,
  resolveScopes: resolveAppKeyScopes,
  setScopes: setAppKeyScopes,
  activity: appActivitySummary,
  invalidate: async (workspaceId) => {
    const { notifySyncInvalidate } = await import('../../../sync-sse');
    await notifySyncInvalidate(REMOTE_ACCESS_QUERY, { workspaceId });
  },
});

export default routes;
