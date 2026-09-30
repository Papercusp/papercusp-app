/**
 * POST /api/admin/testing/memory/probe — single-shot mem0 call for the
 * manual probes panel. Free-form remember/search/list/forget against
 * the current session user; never touches the synthetic test users.
 *
 * Action body shape:
 *   { action: 'remember', content, kind?, shared?, expires_at? }
 *   { action: 'search',   query, limit? }
 *   { action: 'list',     kind?, include_shared? }
 *   { action: 'forget',   id }
 *   { action: 'update',   id, content }
 */
import { defineTool } from '@papercusp/agent-mcp';
import { getMemoryClient } from '../../../memory/mem0-client';
import { getSessionUserOrDefault } from '../../../auth';
import { activeWorkspaceId } from '../../../workspace-registry';

interface ProbeBody {
  action?: string;
  content?: string;
  kind?: 'identity' | 'preference' | 'project' | 'correction' | 'ephemeral';
  shared?: boolean;
  expires_at?: string;
  query?: string;
  limit?: number;
  id?: string;
  include_shared?: boolean;
}

export default defineTool({
  method: 'POST',
  path: '/admin/testing/memory/probe',
  auth: { trust: ['verified', 'trusted'] },
  async handler(req): Promise<Response> {
    const body = (await req.json().catch(() => null)) as ProbeBody | null;
    if (!body || !body.action) return new Response('action required', { status: 400 });
    const user = await getSessionUserOrDefault();
    const workspaceId = activeWorkspaceId();
    const client = await getMemoryClient();
    if (!client) return Response.json({ ok: false, reason: 'mem0_unavailable' }, { status: 503 });

    try {
      switch (body.action) {
        case 'remember': {
          if (!body.content) return new Response('content required', { status: 400 });
          const kind = body.kind ?? 'project';
          if (kind === 'ephemeral' && !body.expires_at) {
            return Response.json({ ok: false, reason: 'ephemeral_requires_expires_at' });
          }
          const metadata: Record<string, unknown> = {
            kind,
            workspace_id: workspaceId,
            created_by: user.id,
            display_name: user.display_name,
          };
          if (body.expires_at) metadata.expires_at = body.expires_at;
          if (body.shared) metadata.shared = true;
          const result = await client.add(body.content, {
            userId: body.shared ? `workspace:${workspaceId}` : user.id,
            metadata,
          });
          return Response.json({ ok: true, result });
        }
        case 'search': {
          if (!body.query) return new Response('query required', { status: 400 });
          const limit = Math.max(1, Math.min(20, body.limit ?? 6));
          const result = await client.search(body.query, { userId: user.id, limit });
          const sharedResult = await client.search(body.query, { userId: `workspace:${workspaceId}`, limit });
          const merged = [
            ...(result.results ?? []),
            ...(sharedResult.results ?? []),
          ];
          return Response.json({ ok: true, results: merged });
        }
        case 'list': {
          const includeShared = body.include_shared !== false;
          const userRows = await client.getAll({ filters: { user_id: user.id }, topK: 5000 });
          const sharedRows = includeShared
            ? await client.getAll({ filters: { user_id: `workspace:${workspaceId}` }, topK: 5000 })
            : { results: [] };
          let combined = [...(userRows.results ?? []), ...(sharedRows.results ?? [])];
          if (body.kind) {
            combined = combined.filter((m) => (m.metadata as Record<string, unknown> | undefined)?.kind === body.kind);
          }
          return Response.json({ ok: true, results: combined });
        }
        case 'forget': {
          if (!body.id) return new Response('id required', { status: 400 });
          await client.delete(body.id);
          return Response.json({ ok: true });
        }
        case 'update': {
          if (!body.id || !body.content) return new Response('id + content required', { status: 400 });
          await client.update(body.id, body.content);
          return Response.json({ ok: true });
        }
        default:
          return new Response(`unknown action: ${body.action}`, { status: 400 });
      }
    } catch (e) {
      return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
    }
  },
});
