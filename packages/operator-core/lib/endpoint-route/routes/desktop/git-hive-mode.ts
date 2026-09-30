/**
 * POST /api/desktop/git/hive-mode
 *
 * Ops lever for the per-hive `hiveGit.mode` seam (p2p-git-live-activation-2026-07-09
 * P-306, WI-3500) — the runbook (hive-git-p2p-ops-runbook-2026-07-09) documents the
 * mode flip as a direct `setPotGitMode`/`getPotGitMode` call with NO admin route,
 * because activation is structural (no flag gates the drivers themselves). That
 * still left NO operator-reachable lever to actually flip/verify/rollback a real
 * hive's mode outside a raw SQL statement against the hive's home box — this route
 * closes that ops gap for GET (read) and POST (flip/rollback), mirroring
 * git-pot-green-cmd.ts's shape exactly (same auth, same CSRF guard, same body
 * contract). Needed for the Phase-3 Leg E drill (P-306) today and the Phase-4 canary
 * activation (P-401) next — both need a lever, not a raw SQL runbook step.
 *
 * GET  /api/desktop/git/hive-mode?slug=<hive-home-slug>&workspace=<workspace-id>
 *      -> { ok, slug, workspaceId, mode }
 * POST /api/desktop/git/hive-mode  { slug, workspace, mode: 'legacy'|'bridged'|'p2p-only'|null }
 *      mode: null (or omitted) clears the row -> hive reads as 'legacy' again
 *      (the documented instant fail-open rollback lever).
 *
 * `workspace` is REQUIRED on both verbs (400 `missing_workspace` otherwise) — EI-14076:
 * this is a multi-tenant table keyed on (workspace_id, slug), and a silent default to
 * `DEFAULT_WORKSPACE_ID` reads/writes the WRONG tenant's row while returning a confident
 * `{ ok: true, ... }`, both on GET (masks the real diagnosis) and on POST (the documented
 * rollback lever appears to succeed against a no-op row). A loud 400 during an incident
 * beats a well-formed wrong answer.
 *
 * SECURITY (CSRF): `auth:'loopback'` is source-IP based, so — like its sibling
 * git-pot-green-cmd — the POST also REJECTS cross-site browser requests
 * (Sec-Fetch-Site: cross-site) so a forged cross-origin POST cannot flip a hive's
 * git mode.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { readPotGitMode, setPotGitMode, POT_GIT_MODES, type PotGitMode } from '../../../harness/git-sync/hive-git-mode';

const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json' };

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export default [
  defineTool({
    method: 'GET',
    path: '/desktop/git/hive-mode',
    auth: 'loopback',
    async handler(req) {
      const url = new URL(req?.url ?? 'http://localhost/desktop/git/hive-mode');
      const slug = (url.searchParams.get('slug') ?? '').trim();
      if (!slug) return json({ ok: false, error: 'missing_slug' }, 400);
      const ws = (url.searchParams.get('workspace') ?? '').trim();
      if (!ws) return json({ ok: false, error: 'missing_workspace' }, 400);
      const read = await readPotGitMode(ws, slug);
      if (read.source === 'error') {
        return json({ ok: false, error: 'mode_read_failed', slug, workspaceId: ws }, 503);
      }
      return json({ ok: true, slug, workspaceId: ws, mode: read.mode, source: read.source }, 200);
    },
  }),
  defineTool({
    method: 'POST',
    path: '/desktop/git/hive-mode',
    auth: 'loopback',
    async handler(req) {
      // CSRF guard: refuse a cross-site browser request before any side effect.
      if (req?.headers?.get?.('sec-fetch-site') === 'cross-site') {
        return json({ ok: false, error: 'cross_site_forbidden' }, 403);
      }
      let body: { slug?: string; mode?: string | null; workspace?: string } = {};
      try {
        body = (await req?.json?.()) ?? {};
      } catch {
        body = {};
      }
      const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
      if (!slug) return json({ ok: false, error: 'missing_slug' }, 400);
      const ws = typeof body.workspace === 'string' ? body.workspace.trim() : '';
      if (!ws) return json({ ok: false, error: 'missing_workspace' }, 400);

      const rawMode = body.mode;
      const clearing = rawMode == null || rawMode === '';
      if (!clearing && !POT_GIT_MODES.includes(rawMode as PotGitMode)) {
        return json({ ok: false, error: 'invalid_mode', expected: POT_GIT_MODES }, 400);
      }

      try {
        await setPotGitMode(ws, slug, clearing ? null : (rawMode as PotGitMode));
      } catch (e) {
        return json(
          { ok: false, error: 'mode_write_failed', message: e instanceof Error ? e.message : String(e) },
          409,
        );
      }

      const after = await readPotGitMode(ws, slug);
      if (after.source === 'error') {
        return json(
          { ok: false, error: 'mode_verify_failed', slug, workspaceId: ws, writeApplied: true },
          503,
        );
      }
      const expected = clearing ? 'legacy' : rawMode;
      if (after.mode !== expected || (!clearing && after.source !== 'set')) {
        return json(
          {
            ok: false,
            error: 'mode_verify_mismatch',
            slug,
            workspaceId: ws,
            expected,
            actual: after.mode,
            source: after.source,
            writeApplied: true,
          },
          409,
        );
      }
      return json({ ok: true, slug, workspaceId: ws, mode: after.mode, source: after.source, cleared: clearing }, 200);
    },
  }),
];
