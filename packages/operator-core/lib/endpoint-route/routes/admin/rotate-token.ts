/**
 * POST /api/admin/rotate-token — generate a fresh harness_token for the
 * calling harness, mirror it to PG + config.json, invalidate the old one.
 *
 * Ported from app/api/admin/rotate-token/route.ts. `auth: 'public'` —
 * the route does its own Bearer-token auth (the caller's CURRENT token).
 */
import { getOrgPg, generated } from '@papercusp/db-org';
import { eq, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from '../../../workspace-registry';
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { deriveCallerFromBearer } from '../../../execute-action';
import { defineTool } from '@papercusp/agent-mcp';
import { operatorApiBase } from '../../../operator-api-base';

const ti = generated.tokenIndexInHarnessShared;

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export default defineTool({
  method: 'POST',
  path: '/admin/rotate-token',
  auth: { trust: ['verified', 'trusted'] },
  async handler(req) {
    const auth = await deriveCallerFromBearer(req.headers.get('authorization'));
    if (!auth.ok) {
      return Response.json({ ok: false, error: auth.error, detail: auth.detail }, { status: auth.status });
    }
    const slug = auth.slug;

    // Find the harness's path in the registry so we can write the new token.
    let harnessPath: string | null = null;
    try {
      const r = await fetch(`${operatorApiBase()}/api/harness/projects`);
      if (r.ok) {
        const d: any = await r.json();
        const row = (d?.projects ?? []).find((p: any) => p.slug === slug);
        if (row) harnessPath = row.path;
      }
    } catch { /* fall through */ }

    if (!harnessPath || !existsSync(harnessPath)) {
      return Response.json(
        { ok: false, error: 'not_found', detail: `harness ${slug} path not found in registry` },
        { status: 404 },
      );
    }

    const newToken = base64url(randomBytes(32));
    const oldToken = req.headers.get('authorization')!.slice(7).trim();
    const { db } = getOrgPg();

    // Insert the new token into token_index (the authoritative token store),
    // write to disk, then drop the old token. Order matters: if disk write
    // fails we don't want the old token already gone.
    try {
      await db
        .insert(ti)
        .values({ token: newToken, harnessSlug: slug, workspaceId: activeWorkspaceId() })
        .onConflictDoUpdate({
          target: ti.harnessSlug,
          set: { token: dsql`EXCLUDED.token`, createdAt: dsql`now()` },
        });
    } catch (e: any) {
      return Response.json(
        { ok: false, error: 'internal', detail: `failed to insert new token: ${e?.message}` },
        { status: 500 },
      );
    }

    // Write to disk before invalidating old token, so a crash here leaves
    // both tokens valid (caller can retry; idempotent).
    const cfgPath = join(harnessPath, '.papercusp', 'config.json');
    try {
      let cfg: any = {};
      if (existsSync(cfgPath)) {
        cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
      } else {
        await fs.mkdir(join(harnessPath, '.papercusp'), { recursive: true });
      }
      cfg.harness_token = newToken;
      await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
      await fs.chmod(cfgPath, 0o600);
    } catch (e: any) {
      // Roll back the new-token insert.
      try {
        await db.delete(ti).where(eq(ti.token, newToken));
      } catch { /* ignore */ }
      return Response.json(
        { ok: false, error: 'internal', detail: `failed to write config.json: ${e?.message}` },
        { status: 500 },
      );
    }

    // Drop the old token. Future requests with it return 401.
    try {
      await db.delete(ti).where(eq(ti.token, oldToken));
    } catch (e: any) {
      // Old token still works — not great, but the new one is also active.
      return Response.json({
        ok: true,
        slug,
        newToken,
        warning: `old token cleanup failed: ${e?.message}`,
      });
    }

    return Response.json({ ok: true, slug, newToken });
  },
});
