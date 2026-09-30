/**
 * Cross-client saved-prompts CRUD for the harness-settings + personalization
 * UI (plan saved-prompts-cross-client):
 *
 *   GET  /api/agent-mcp/saved-prompts          — list one scope
 *   POST /api/agent-mcp/saved-prompts          — upsert
 *   POST /api/agent-mcp/saved-prompts/remove   — delete by name
 *
 * Route-shaped `defineTool` with `auth: 'public'` (loopback-trusted), the
 * same shape every other settings surface uses (operator-config,
 * operator-credentials, omp-config) — the dashboard has no bearer/principal
 * path, so this is the idiomatic settings endpoint (D-007; supersedes the
 * principal-gated D-005). Each write re-materializes the affected scope's
 * on-disk command files so ambient Claude/OMP sessions pick them up.
 *
 * Why writes are POST, not PUT/DELETE (D-010): the desktop WebView
 * (WebKitGTK) silently fails CORS preflight handshakes, and the client
 * routes these calls through the sibling loopback host (crossOriginUrl) to
 * escape SSE socket-pool starvation — which makes them cross-origin. Only
 * GET/HEAD/POST + a safelisted content-type (text/plain) are CORS-"simple"
 * (no preflight); PUT/DELETE always preflight. So both writes are POST and
 * the client sends `text/plain` bodies. The global `/api/*` host CORS
 * (bin/host-cors.ts) reflects the loopback origin on the response, so no
 * per-route `cors` field is needed (mirrors the git/show read).
 * `req.json()` parses the body regardless of its content-type header.
 *
 * Scope: no `?harness=`/`harness` ⇒ workspace-global; a slug ⇒ that harness.
 * Workspace is the request's active workspace.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import {
  listSavedPrompts,
  upsertSavedPrompt,
  removeSavedPrompt,
  createPromptNode,
  updatePromptNodeById,
  movePromptNodes,
  removePromptNodeById,
  archivePromptSubtree,
  unarchivePromptNodes,
  recordPromptUse,
  type MovePromptNodeAssignment,
  type PromptScope,
  type UpdatePromptNodePatch,
} from '../../../saved-prompts-store';
import {
  materializeWorkspacePrompts,
  materializeHarnessPrompts,
} from '../../../saved-prompts-materialize';
import { validatePromptName } from '../../../saved-prompts-projection';
import { notifySyncInvalidate } from '../../../sync-sse';

function scopeFromHarness(harness: string | null): PromptScope {
  return harness ? { kind: 'harness', slug: harness } : { kind: 'workspace' };
}

/** Re-project the affected scope to disk so a save/delete is reflected immediately. */
async function rematerialize(workspaceId: string, scope: PromptScope): Promise<void> {
  if (scope.kind === 'harness') await materializeHarnessPrompts(workspaceId, scope.slug);
  else await materializeWorkspacePrompts(workspaceId);
}

/** Push the scope's savedPrompts.byScope subscribers a refetch (Quick Panel). */
async function invalidateScope(scope: PromptScope): Promise<void> {
  const args = scope.kind === 'harness' ? { harness: scope.slug } : {};
  await notifySyncInvalidate('savedPrompts.byScope', args).catch(() => {});
}

const get = defineTool({
  method: 'GET',
  path: '/agent-mcp/saved-prompts',
  auth: 'public',
  async handler(req) {
    const harness = new URL(req.url).searchParams.get('harness');
    const ws = activeWorkspaceId();
    const prompts = await listSavedPrompts(getOrgPg().sql, ws, scopeFromHarness(harness));
    return Response.json({ prompts });
  },
});

const upsert = defineTool({
  method: 'POST',
  path: '/agent-mcp/saved-prompts',
  auth: 'loopback',
  async handler(req) {
    const body = (await req.json()) as {
      harness?: string | null;
      name?: string;
      body?: string;
      description?: string | null;
      argHint?: string | null;
    };
    const name = (body.name ?? '').trim();
    if (!validatePromptName(name)) {
      return Response.json(
        { error: 'invalid_name', detail: 'name must match ^[a-z0-9][a-z0-9-]*$' },
        { status: 400 },
      );
    }
    if (typeof body.body !== 'string' || body.body.trim().length === 0) {
      return Response.json({ error: 'missing_body' }, { status: 400 });
    }
    const ws = activeWorkspaceId();
    const scope = scopeFromHarness(body.harness?.trim() || null);
    const prompt = await upsertSavedPrompt(getOrgPg().sql, {
      workspaceId: ws,
      scope,
      name,
      body: body.body,
      description: body.description ?? null,
      argHint: body.argHint ?? null,
    });
    await rematerialize(ws, scope);
    await invalidateScope(scope);
    return Response.json({ prompt });
  },
});

const remove = defineTool({
  method: 'POST',
  path: '/agent-mcp/saved-prompts/remove',
  auth: 'loopback',
  async handler(req) {
    const body = (await req.json().catch(() => ({}))) as {
      harness?: string | null;
      name?: string;
    };
    const name = (body.name ?? '').trim();
    if (!name) return Response.json({ error: 'missing_name' }, { status: 400 });
    const ws = activeWorkspaceId();
    const scope = scopeFromHarness(body.harness?.trim() || null);
    const removed = await removeSavedPrompt(getOrgPg().sql, ws, scope, name);
    await rematerialize(ws, scope);
    await invalidateScope(scope);
    return Response.json({ removed });
  },
});

// ---------------------------------------------------------------------------
// Outline-node verbs (quick-panel-saved-prompts-2026-07-13 P-004). Id-based —
// the Quick Panel organizer renames titles and moves nodes; `name` stays the
// stable slash-command key. Same D-010 shape as the verbs above: POST +
// text/plain "simple" requests, auth loopback.
// ---------------------------------------------------------------------------

const nodeCreate = defineTool({
  method: 'POST',
  path: '/agent-mcp/saved-prompts/node',
  auth: 'loopback',
  async handler(req) {
    const body = (await req.json().catch(() => ({}))) as {
      harness?: string | null;
      title?: string;
      body?: string;
      parentId?: string | null;
      position?: string | null;
      description?: string | null;
      argHint?: string | null;
    };
    // Blank titles are legal (WI-4806): the Workflowy-style outline creates an
    // empty bullet you type into — the store derives the unique 'prompt-N'
    // slug and keeps title NULL until the first rename.
    const title = (body.title ?? '').trim();
    const ws = activeWorkspaceId();
    const scope = scopeFromHarness(body.harness?.trim() || null);
    const prompt = await createPromptNode(getOrgPg().sql, {
      workspaceId: ws,
      scope,
      title,
      body: typeof body.body === 'string' ? body.body : '',
      parentId: body.parentId ?? null,
      position: body.position ?? null,
      description: body.description ?? null,
      argHint: body.argHint ?? null,
    });
    await rematerialize(ws, scope);
    await invalidateScope(scope);
    return Response.json({ prompt });
  },
});

const nodeUpdate = defineTool({
  method: 'POST',
  path: '/agent-mcp/saved-prompts/node/update',
  auth: 'loopback',
  async handler(req) {
    const body = (await req.json().catch(() => ({}))) as {
      harness?: string | null;
      id?: string;
      patch?: UpdatePromptNodePatch;
    };
    const id = (body.id ?? '').trim();
    if (!id) return Response.json({ error: 'missing_id' }, { status: 400 });
    const patch = body.patch ?? {};
    const ws = activeWorkspaceId();
    const scope = scopeFromHarness(body.harness?.trim() || null);
    const prompt = await updatePromptNodeById(getOrgPg().sql, ws, id, patch);
    if (!prompt) return Response.json({ error: 'not_found' }, { status: 404 });
    // Only content edits change the on-disk projection; collapse/pin don't.
    if (patch.title !== undefined || patch.body !== undefined || patch.description !== undefined || patch.argHint !== undefined) {
      await rematerialize(ws, scope);
    }
    await invalidateScope(scope);
    return Response.json({ prompt });
  },
});

const nodeMove = defineTool({
  method: 'POST',
  path: '/agent-mcp/saved-prompts/node/move',
  auth: 'loopback',
  async handler(req) {
    const body = (await req.json().catch(() => ({}))) as {
      harness?: string | null;
      assignments?: MovePromptNodeAssignment[];
    };
    const assignments = Array.isArray(body.assignments) ? body.assignments : [];
    if (assignments.length === 0 || assignments.some((a) => !a || typeof a.id !== 'string' || typeof a.position !== 'string')) {
      return Response.json({ error: 'missing_assignments' }, { status: 400 });
    }
    const ws = activeWorkspaceId();
    const scope = scopeFromHarness(body.harness?.trim() || null);
    const moved = await movePromptNodes(getOrgPg().sql, ws, assignments.map((a) => ({
      id: a.id,
      parentId: a.parentId ?? null,
      position: a.position,
    })));
    await invalidateScope(scope);
    return Response.json({ moved });
  },
});

const nodeRemove = defineTool({
  method: 'POST',
  path: '/agent-mcp/saved-prompts/node/remove',
  auth: 'loopback',
  async handler(req) {
    const body = (await req.json().catch(() => ({}))) as { harness?: string | null; id?: string };
    const id = (body.id ?? '').trim();
    if (!id) return Response.json({ error: 'missing_id' }, { status: 400 });
    const ws = activeWorkspaceId();
    const scope = scopeFromHarness(body.harness?.trim() || null);
    const removed = await removePromptNodeById(getOrgPg().sql, ws, id);
    await rematerialize(ws, scope);
    await invalidateScope(scope);
    return Response.json({ removed });
  },
});

// WI-4840 D-004: the outline's delete is an UNDOABLE archive of the whole
// subtree — the returned ids are the client's undo set for /node/unarchive.
// The by-name hard delete above stays for the settings surface.
const nodeArchive = defineTool({
  method: 'POST',
  path: '/agent-mcp/saved-prompts/node/archive',
  auth: 'loopback',
  async handler(req) {
    const body = (await req.json().catch(() => ({}))) as { harness?: string | null; id?: string };
    const id = (body.id ?? '').trim();
    if (!id) return Response.json({ error: 'missing_id' }, { status: 400 });
    const ws = activeWorkspaceId();
    const scope = scopeFromHarness(body.harness?.trim() || null);
    const archivedIds = await archivePromptSubtree(getOrgPg().sql, ws, id);
    await rematerialize(ws, scope);
    await invalidateScope(scope);
    return Response.json({ archivedIds });
  },
});

const nodeUnarchive = defineTool({
  method: 'POST',
  path: '/agent-mcp/saved-prompts/node/unarchive',
  auth: 'loopback',
  async handler(req) {
    const body = (await req.json().catch(() => ({}))) as {
      harness?: string | null;
      ids?: string[];
    };
    const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string' && x) : [];
    if (ids.length === 0) return Response.json({ error: 'missing_ids' }, { status: 400 });
    const ws = activeWorkspaceId();
    const scope = scopeFromHarness(body.harness?.trim() || null);
    const restored = await unarchivePromptNodes(getOrgPg().sql, ws, ids);
    await rematerialize(ws, scope);
    await invalidateScope(scope);
    return Response.json({ restored });
  },
});

const nodeUse = defineTool({
  method: 'POST',
  path: '/agent-mcp/saved-prompts/node/use',
  auth: 'loopback',
  async handler(req) {
    const body = (await req.json().catch(() => ({}))) as { harness?: string | null; id?: string };
    const id = (body.id ?? '').trim();
    if (!id) return Response.json({ error: 'missing_id' }, { status: 400 });
    const ws = activeWorkspaceId();
    const scope = scopeFromHarness(body.harness?.trim() || null);
    await recordPromptUse(getOrgPg().sql, ws, id);
    await invalidateScope(scope);
    return Response.json({ ok: true });
  },
});

export default [
  get,
  upsert,
  remove,
  nodeCreate,
  nodeUpdate,
  nodeMove,
  nodeRemove,
  nodeArchive,
  nodeUnarchive,
  nodeUse,
];
