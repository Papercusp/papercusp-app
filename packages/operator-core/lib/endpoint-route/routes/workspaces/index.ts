/**
 * GET / POST /api/workspaces — list / create workspaces (webapp path;
 * desktop uses Tauri commands). Both write registry.json.
 * Ported from app/api/workspaces/route.ts. `auth: 'public'`.
 */
import { promises as fs } from 'node:fs';
import { readRegistry, workspacesRoot, writeRegistry } from '../../../workspace-registry';
import { join } from 'node:path';
import { defineTool } from '@papercusp/agent-mcp';

function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!base) throw new Error('name resolves to empty slug');
  return base;
}

export default [
  defineTool({
    method: 'GET',
    path: '/workspaces',
    auth: 'public',
    async handler() {
      return Response.json(readRegistry());
    },
  }),
  defineTool({
    method: 'POST',
    path: '/workspaces',
    auth: 'loopback',
    async handler(req) {
      let body: { name?: string };
      try {
        body = await req.json();
      } catch {
        return Response.json({ ok: false, error: 'invalid json' }, { status: 400 });
      }
      const name = String(body.name ?? '').trim();
      if (!name) return Response.json({ ok: false, error: 'name required' }, { status: 400 });

      const reg = readRegistry();
      let id: string;
      try {
        id = slugify(name);
      } catch (e) {
        return Response.json({ ok: false, error: (e as Error).message }, { status: 400 });
      }
      let candidate = id;
      let n = 2;
      while (reg.workspaces.some((w) => w.id === candidate)) candidate = `${id}-${n++}`;
      id = candidate;

      const dir = join(workspacesRoot(), id);
      await fs.mkdir(join(dir, '.papercusp'), { recursive: true });
      const ws = { id, name, createdAt: Date.now() };
      reg.workspaces.push(ws);
      if (!reg.current) reg.current = id;
      writeRegistry(reg);
      return Response.json(ws);
    },
  }),
];
