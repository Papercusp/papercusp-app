/**
 * GET  /api/desktop/git-identity — resolve the user's git identity from
 *      global, then system, git config.
 * POST /api/desktop/git-identity — write user.name + user.email to the
 *      global git config (so the Setup Wizard can configure it with a
 *      form instead of telling the user to run `git config` by hand).
 *
 * Ported from app/api/desktop/git-identity/route.ts. `auth: {}`.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defineTool } from '@papercusp/agent-mcp';

const exec = promisify(execFile);

async function readConfig(scope: 'global' | 'system', key: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec('git', ['config', `--${scope}`, '--get', key], { timeout: 3000 });
    const v = stdout.trim();
    return v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

const get = defineTool({
  method: 'GET',
  path: '/desktop/git-identity',
  auth: {},
  async handler() {
    const [globalName, globalEmail, systemName, systemEmail] = await Promise.all([
      readConfig('global', 'user.name'),
      readConfig('global', 'user.email'),
      readConfig('system', 'user.name'),
      readConfig('system', 'user.email'),
    ]);

    if (globalName || globalEmail) {
      return Response.json({ name: globalName, email: globalEmail, source: 'global' });
    }
    if (systemName || systemEmail) {
      return Response.json({ name: systemName, email: systemEmail, source: 'system' });
    }
    return Response.json({ source: 'none' });
  },
});

const post = defineTool({
  method: 'POST',
  path: '/desktop/git-identity',
  auth: {},
  async handler(req) {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return Response.json({ error: 'invalid body' }, { status: 400 });
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (!name || name.length > 200) {
      return Response.json({ error: 'name is required (≤200 chars)' }, { status: 400 });
    }
    // Loose email check — git itself doesn't validate, but a missing @
    // is almost always a mistake worth catching at the form.
    if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return Response.json({ error: 'a valid email is required' }, { status: 400 });
    }
    // execFile (not a shell) — name/email are discrete argv entries, so
    // there's no shell-injection surface even with exotic characters.
    try {
      await exec('git', ['config', '--global', 'user.name', name], { timeout: 3000 });
      await exec('git', ['config', '--global', 'user.email', email], { timeout: 3000 });
    } catch (e) {
      return Response.json(
        { error: `git config failed: ${e instanceof Error ? e.message : String(e)}` },
        { status: 500 },
      );
    }
    return Response.json({ name, email, source: 'global' });
  },
});

export default [get, post];
