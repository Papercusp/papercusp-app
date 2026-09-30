/**
 * POST /api/desktop/workspace-validate — pre-flight check for the Setup
 * Wizard's "Default project directory" field.
 *
 * Ported from app/api/desktop/workspace-validate/route.ts. `auth: {}`.
 */
import { promises as fs } from 'node:fs';
import { workspacesRoot } from '../../../workspace-registry';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { defineTool } from '@papercusp/agent-mcp';

function expand(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  if (trimmed === '~') return homedir();
  return resolve(trimmed);
}

async function isWritableDir(path: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path);
    if (!stat.isDirectory()) return false;
    await fs.access(path, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export default defineTool({
  method: 'POST',
  path: '/desktop/workspace-validate',
  auth: {},
  async handler(req) {
    const body = (await req.json().catch(() => null)) as { path?: string } | null;
    if (!body || typeof body.path !== 'string') {
      return Response.json({ ok: false, reason: 'invalid body' }, { status: 400 });
    }
    if (body.path.trim().length === 0) {
      return Response.json({ ok: true, normalized: '', exists: false, writable: true });
    }

    const normalized = expand(body.path);

    if (!normalized.startsWith('/')) {
      return Response.json({
        ok: false,
        reason: 'Path must be absolute (start with `/` or `~/`).',
      });
    }

    const reserved = workspacesRoot();
    if (normalized === reserved || normalized.startsWith(reserved + '/')) {
      return Response.json({
        ok: false,
        reason: `Pick a path outside ${reserved}. That directory is managed by Papercusp.`,
      });
    }

    const exists = existsSync(normalized);
    if (exists) {
      const writable = await isWritableDir(normalized);
      if (!writable) {
        return Response.json({
          ok: false,
          reason: 'That path exists but isn\'t a writable directory.',
        });
      }
      return Response.json({ ok: true, normalized, exists: true, writable: true });
    }
    // Doesn't exist — check parent is writable so we can mkdir later.
    const parentWritable = await isWritableDir(dirname(normalized));
    if (!parentWritable) {
      return Response.json({
        ok: false,
        reason: `Parent directory ${dirname(normalized)} doesn't exist or isn't writable.`,
      });
    }
    return Response.json({ ok: true, normalized, exists: false, writable: true });
  },
});
