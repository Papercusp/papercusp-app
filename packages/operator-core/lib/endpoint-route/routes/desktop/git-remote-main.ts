/**
 * POST /api/desktop/git/reset-to-remote-main
 *
 * The "switch to remote main" RECOVERY action (dogfood-silent-canonical-hive-join
 * P-015 / R2): restore a checkout whose LOCAL main is messed up to the CANONICAL/public
 * remote main. Snapshots first (recovery branch + stash) so it is fully recoverable, runs
 * under the git-sync lock, then `git reset --hard <remote>/<branch>`. Delegates to the
 * tested lib `resetToRemoteMain`.
 *
 * Body (all optional): { slug?, remote?, branch? } — defaults to the `papercusp` hive
 * checkout, origin/main. Status: 200 ok · 404 unknown_project · 409 git_sync_busy · 500 git_failed.
 *
 * SECURITY (CSRF): this is a DESTRUCTIVE side effect and `auth: 'loopback'` is source-IP
 * based, so — like its sibling bootstrap-pot/start — it also REJECTS cross-site browser
 * requests (Sec-Fetch-Site: cross-site) so a forged cross-origin POST cannot trigger it.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { resetToRemoteMain } from '../../../harness/git-reset-to-remote-main';
import { PAPERCUSP_HIVE_SLUG } from '../../../harness/ensure-papercusp-hive';

const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json' };

export default [
  defineTool({
    method: 'POST',
    path: '/desktop/git/reset-to-remote-main',
    auth: 'loopback',
    async handler(req) {
      // CSRF guard: refuse a cross-site browser request before any side effect.
      const site = req?.headers?.get?.('sec-fetch-site');
      if (site === 'cross-site') {
        return new Response(
          JSON.stringify({ ok: false, error: 'cross_site_forbidden' }),
          { status: 403, headers: JSON_HEADERS },
        );
      }
      let body: { slug?: string; remote?: string; branch?: string } = {};
      try {
        body = (await req?.json?.()) ?? {};
      } catch {
        body = {};
      }
      const slug = (typeof body.slug === 'string' && body.slug.trim()) || PAPERCUSP_HIVE_SLUG;
      const res = await resetToRemoteMain({
        slug,
        ...(typeof body.remote === 'string' && body.remote.trim() ? { remote: body.remote.trim() } : {}),
        ...(typeof body.branch === 'string' && body.branch.trim() ? { branch: body.branch.trim() } : {}),
      });
      const status = res.ok
        ? 200
        : res.error === 'unknown_project'
          ? 404
          : res.error === 'git_sync_busy'
            ? 409
            : 500;
      return new Response(JSON.stringify(res), { status, headers: JSON_HEADERS });
    },
  }),
];
