/**
 * GET /api/desktop/git-pipeline  (+ OPTIONS preflight)
 *
 * The full `gitPipelineSnapshot()` as plain JSON — the SAME data the
 * /admin/git GitClient reads via the sync-resolver query `dev.gitPipeline`,
 * projected onto a plain HTTP route for clients that cannot ride the SPA's
 * @papercusp/sync stack. Consumer: the desktop's native dev-wrapper bar
 * (papercusp-desktop src-tauri/src/dev_wrapper.rs) polls this on a 30s
 * interval — matching VersionBadge's cadence — to render the always-visible
 * pipeline status + SPA-vs-API skew line
 * (desktop-build-switcher-wrapper-2026-06-09 P-010 / D-003).
 *
 * Lives under /desktop/ (NOT /dev/) because the auth posture is per-family
 * (auth-posture.test.ts): /dev/* must be trust-gated, while this route's
 * consumer is the desktop shell's native bar, which has no auth context to
 * send — `auth: 'public'` like desktop/version.ts (loopback-bound,
 * read-only, non-secret: shas, routine timestamps, gate state). Pinned in
 * the test's MUST_BE_PUBLIC list so it can't silently tighten and break
 * the bar. Same CORS posture as version.ts so a webview origin can read it
 * directly too.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { gitPipelineSnapshot } from '../../../git-pipeline-stats';

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export default [
  defineTool({
    method: 'GET',
    path: '/desktop/git-pipeline',
    auth: 'public',
    async handler() {
      const snapshot = await gitPipelineSnapshot();
      return new Response(JSON.stringify(snapshot), {
        headers: { 'content-type': 'application/json', ...CORS_HEADERS },
      });
    },
  }),
  defineTool({
    method: 'OPTIONS',
    path: '/desktop/git-pipeline',
    auth: 'public',
    handler() {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    },
  }),
];
