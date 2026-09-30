/**
 * /api/tui/* — persistence routes for the `pui` (apps/tui) terminal workbench.
 *
 * Plan: tui-workbench-ratatui-2026-06-04 (P12 / D-002). Backs the three
 * per-user persisted concepts: LAYOUTS (named zellij KDL), CREWS (saved agent
 * session sets), and VIEW_STATE (quiet UI/nav state). The CRUD lives in
 * `tui-workbench-store.ts`; these routes are the thin HTTP seam `pui` consumes
 * over its IPC/HTTP transport (the same `sys:http` rail as /api/coord/inbox).
 *
 * `auth: 'public'` mirrors the sibling /api/coord/* routes — loopback-protected
 * by the host bind, owner-scoped by the explicit `owner` arg (the pui owner key).
 *
 *   GET    /api/tui/view-state?owner=        the quiet UI/nav state ({} if none)
 *   PUT    /api/tui/view-state               upsert { owner, state }
 *   GET    /api/tui/layouts?owner=           layout summaries (no kdl)
 *   GET    /api/tui/layouts/:name?owner=     one layout incl. kdl (404 if absent)
 *   PUT    /api/tui/layouts                  upsert { owner, name, kdl, description? }
 *   DELETE /api/tui/layouts/:name?owner=     delete one
 *   GET    /api/tui/crews?owner=             crew summaries
 *   GET    /api/tui/crews/:name?owner=       one crew incl. members (404 if absent)
 *   PUT    /api/tui/crews                    upsert { owner, name, members, layout_name?, description? }
 *   DELETE /api/tui/crews/:name?owner=       delete one
 */
import { defineTool } from '@papercusp/agent-mcp';
import { createHash } from 'node:crypto';
import intentsStream from './intents-stream';
import intentResult from './intent-result';
import planItemStates from './plan-item-states';
import goalsRoute from './goals';
import planItemConvert from './plan-item-convert';
import planItemRelease from './plan-item-release';
import { getBuildInfo } from '../../../build-info';
import { getHarnessAdminUrlWithSource } from '../../../embedded-pg-discovery';
import { activeWorkspaceId } from '../../../workspace-registry';
import {
  getViewState,
  putViewState,
  listLayouts,
  getLayout,
  putLayout,
  deleteLayout,
  listCrews,
  getCrew,
  putCrew,
  deleteCrew,
  type CrewMember,
} from '../../../tui-workbench-store';

function ownerFromQuery(req: Request): string | null {
  const owner = new URL(req.url).searchParams.get('owner');
  return owner && owner.trim() ? owner.trim() : null;
}

function ownerRequired(): Response {
  return Response.json({ error: 'owner_required: pass ?owner=<pui owner id>' }, { status: 400 });
}

/**
 * A non-secret, stable description of the Postgres store this operator uses.
 * Credentials and query parameters never leave the process; the short id is
 * derived only from protocol/host/port/database + the resolver source.
 */
function operatorStoreIdentity(): { id: string; target: string; source: string } {
  const resolved = getHarnessAdminUrlWithSource();
  let target: string;
  try {
    const url = new URL(resolved.url);
    const port = url.port || (url.protocol === 'postgresql:' || url.protocol === 'postgres:' ? '5432' : 'default');
    const database = url.pathname.replace(/^\/+/, '') || 'default';
    target = `${url.protocol}//${url.hostname}:${port}/${database}`;
  } catch {
    // Keep the route diagnostic even if an experimental resolver returns a
    // non-URL DSN. Never echo that raw value: it may contain credentials.
    target = `unparseable (${resolved.source})`;
  }
  // Resolver provenance is diagnostic, not store identity: the same database
  // may legitimately move from discovery-file to env resolution across boots.
  const id = createHash('sha256').update(target).digest('hex').slice(0, 12);
  return { id: `pg-${id}`, target, source: resolved.source };
}

// ─── canonical operator/store identity ────────────────────────────────────
const identityGet = defineTool({
  method: 'GET',
  path: '/tui/identity',
  auth: 'public',
  handler() {
    const workspaceId = activeWorkspaceId();
    const build = getBuildInfo();
    return Response.json({
      schemaVersion: 1,
      workspaceId,
      store: operatorStoreIdentity(),
      build: { version: build.version, sha: build.sha },
      agentChat: {
        scope: `workspace:${workspaceId}`,
        route: '/api/agent-chats',
      },
      capabilities: {
        // PUI probes this before calling launch-su.  Older operators omit the
        // field, so a current client fails closed instead of falling through
        // to the legacy visible-terminal launcher.
        attachedSuSession: true,
        attachedSuSessionApprovals: true,
      },
    });
  },
});

// ─── view_state ────────────────────────────────────────────────────────────
const viewStateGet = defineTool({
  method: 'GET',
  path: '/tui/view-state',
  auth: 'public',
  async handler(req) {
    const owner = ownerFromQuery(req);
    if (!owner) return ownerRequired();
    return Response.json({ state: await getViewState(owner) });
  },
});

const viewStatePut = defineTool({
  method: 'PUT',
  path: '/tui/view-state',
  auth: 'loopback',
  async handler(req) {
    const body = (await req.json().catch(() => null)) as { owner?: string; state?: Record<string, unknown> } | null;
    const owner = body?.owner?.trim();
    if (!owner) return ownerRequired();
    await putViewState(owner, body?.state ?? {});
    return Response.json({ ok: true });
  },
});

// ─── layouts ───────────────────────────────────────────────────────────────
const layoutsList = defineTool({
  method: 'GET',
  path: '/tui/layouts',
  auth: 'public',
  async handler(req) {
    const owner = ownerFromQuery(req);
    if (!owner) return ownerRequired();
    return Response.json({ layouts: await listLayouts(owner) });
  },
});

const layoutGet = defineTool({
  method: 'GET',
  path: '/tui/layouts/:name',
  auth: 'public',
  async handler(req, ctx) {
    const owner = ownerFromQuery(req);
    if (!owner) return ownerRequired();
    const row = await getLayout(owner, ctx.params.name as string);
    if (!row) return Response.json({ error: 'layout not found' }, { status: 404 });
    return Response.json(row);
  },
});

const layoutPut = defineTool({
  method: 'PUT',
  path: '/tui/layouts',
  auth: 'loopback',
  async handler(req) {
    const body = (await req.json().catch(() => null)) as
      | { owner?: string; name?: string; kdl?: string; description?: string | null }
      | null;
    const owner = body?.owner?.trim();
    const name = body?.name?.trim();
    if (!owner) return ownerRequired();
    if (!name) return Response.json({ error: 'name_required' }, { status: 400 });
    if (typeof body?.kdl !== 'string' || !body.kdl) {
      return Response.json({ error: 'kdl_required' }, { status: 400 });
    }
    await putLayout(owner, name, body.kdl, body.description ?? null);
    return Response.json({ ok: true });
  },
});

const layoutDelete = defineTool({
  method: 'DELETE',
  path: '/tui/layouts/:name',
  auth: 'loopback',
  async handler(req, ctx) {
    const owner = ownerFromQuery(req);
    if (!owner) return ownerRequired();
    const deleted = await deleteLayout(owner, ctx.params.name as string);
    return Response.json({ ok: true, deleted });
  },
});

// ─── crews ─────────────────────────────────────────────────────────────────
const crewsList = defineTool({
  method: 'GET',
  path: '/tui/crews',
  auth: 'public',
  async handler(req) {
    const owner = ownerFromQuery(req);
    if (!owner) return ownerRequired();
    return Response.json({ crews: await listCrews(owner) });
  },
});

const crewGet = defineTool({
  method: 'GET',
  path: '/tui/crews/:name',
  auth: 'public',
  async handler(req, ctx) {
    const owner = ownerFromQuery(req);
    if (!owner) return ownerRequired();
    const row = await getCrew(owner, ctx.params.name as string);
    if (!row) return Response.json({ error: 'crew not found' }, { status: 404 });
    return Response.json(row);
  },
});

const crewPut = defineTool({
  method: 'PUT',
  path: '/tui/crews',
  auth: 'loopback',
  async handler(req) {
    const body = (await req.json().catch(() => null)) as
      | { owner?: string; name?: string; members?: CrewMember[]; layout_name?: string | null; description?: string | null }
      | null;
    const owner = body?.owner?.trim();
    const name = body?.name?.trim();
    if (!owner) return ownerRequired();
    if (!name) return Response.json({ error: 'name_required' }, { status: 400 });
    const members = Array.isArray(body?.members) ? body!.members : [];
    await putCrew(owner, name, members, body?.layout_name ?? null, body?.description ?? null);
    return Response.json({ ok: true });
  },
});

const crewDelete = defineTool({
  method: 'DELETE',
  path: '/tui/crews/:name',
  auth: 'loopback',
  async handler(req, ctx) {
    const owner = ownerFromQuery(req);
    if (!owner) return ownerRequired();
    const deleted = await deleteCrew(owner, ctx.params.name as string);
    return Response.json({ ok: true, deleted });
  },
});

export default [
  identityGet,
  viewStateGet,
  viewStatePut,
  layoutsList,
  layoutGet,
  layoutPut,
  layoutDelete,
  crewsList,
  crewGet,
  crewPut,
  crewDelete,
  intentsStream,
  intentResult,
  planItemStates,
  planItemConvert,
  planItemRelease,
  goalsRoute,
];
