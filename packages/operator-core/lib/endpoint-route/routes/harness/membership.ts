/**
 * Harness ↔ workspace membership endpoints (Phase 3 of
 * harnesses-across-workspaces). Thin HTTP surface over lib/harness-membership.
 *
 *   GET  /api/harness/:slug/workspaces        — workspace ids carrying the slug
 *   POST /api/harness/:slug/membership        — { op, workspace?/fromWorkspace?/toWorkspace? }
 *        op='add'    { toWorkspace }   — register the harness (same path/link) in toWorkspace
 *        op='remove' { workspace }     — unregister from workspace (folder untouched)
 *        op='move'   { fromWorkspace, toWorkspace }
 *
 * Registry edits only: never moves/deletes the folder, never migrates run data
 * (D-1). `auth: 'public'` matches the sibling local harness routes.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { readRegistry } from '../../../workspace-registry';
import { loadHarnessRegistry } from '../../../harness-registry';
import {
  addHarnessToWorkspace,
  moveHarness,
  removeHarnessFromWorkspace,
  workspacesForHarness,
} from '../../../harness-membership';

const SLUG_RE = /^[A-Za-z0-9._-]+$/;

function knownWorkspace(id: unknown): id is string {
  return typeof id === 'string' && readRegistry().workspaces.some((w) => w.id === id);
}

const listWorkspaces = defineTool({
  method: 'GET',
  path: '/harness/:slug/workspaces',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = String(ctx.params.slug ?? '');
    if (!SLUG_RE.test(slug)) return Response.json({ error: 'invalid slug' }, { status: 400 });
    return Response.json({ slug, workspaces: await workspacesForHarness(slug) });
  },
});

const membership = defineTool({
  method: 'POST',
  path: '/harness/:slug/membership',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = String(ctx.params.slug ?? '');
    if (!SLUG_RE.test(slug)) return Response.json({ error: 'invalid slug' }, { status: 400 });

    let body: { op?: string; workspace?: string; fromWorkspace?: string; toWorkspace?: string };
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'invalid json' }, { status: 400 });
    }

    try {
      switch (body.op) {
        case 'add': {
          if (!knownWorkspace(body.toWorkspace)) {
            return Response.json({ error: 'unknown toWorkspace' }, { status: 400 });
          }
          // Carry the existing ProjectEntry (same path = preserve the link).
          const members = await workspacesForHarness(slug);
          if (members.length === 0) {
            return Response.json(
              { error: `harness '${slug}' is not registered in any workspace; use /harness/projects to create it first` },
              { status: 404 },
            );
          }
          const srcReg = await loadHarnessRegistry(members[0]);
          const entry = srcReg.projects.find((p) => p.slug === slug)!;
          return Response.json({ ok: true, result: await addHarnessToWorkspace(body.toWorkspace, entry) });
        }
        case 'remove': {
          if (!knownWorkspace(body.workspace)) {
            return Response.json({ error: 'unknown workspace' }, { status: 400 });
          }
          return Response.json({ ok: true, result: await removeHarnessFromWorkspace(body.workspace, slug) });
        }
        case 'move': {
          if (!knownWorkspace(body.fromWorkspace)) {
            return Response.json({ error: 'unknown fromWorkspace' }, { status: 400 });
          }
          if (!knownWorkspace(body.toWorkspace)) {
            return Response.json({ error: 'unknown toWorkspace' }, { status: 400 });
          }
          return Response.json({ ok: true, result: await moveHarness(slug, body.fromWorkspace, body.toWorkspace) });
        }
        default:
          return Response.json({ error: `unknown op '${body.op}' (expected add|remove|move)` }, { status: 400 });
      }
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
  },
});

export default [listWorkspaces, membership];
