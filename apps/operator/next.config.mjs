/**
 * next.config.mjs — operator app (WI-3732).
 *
 * PAPERCUSP_PREVIEW_DATA_ORIGIN (env-gated, PREVIEW-ONLY): when set, every
 * `/api/*` request is rewritten to that origin — so a dev/staging preview
 * instance of THIS tree's UI rides a live data plane (`/api/zero-harness/
 * rest-query` + `/sse` are plain HTTP, see providers/HarnessSyncProvider.tsx).
 * Rationale: the envs here are git TREES plus ONE runtime — only the release
 * checkout runs and it exclusively owns the data store, so an ad-hoc preview
 * boots data-blind (owner friction 2026-07-10: could not see /rubrics before
 * the gate greened).
 *
 * Point it at ONE of two origins:
 *
 *   - the live release backend (`http://localhost:3070`) — simplest; serves
 *     every query the DEPLOYED snapshot knows. A UI-only change needs no more.
 *   - `lib/release/preview-data-plane.ts` (`http://localhost:3172`) — ALSO
 *     serves named queries that exist only in THIS tree, delegating everything
 *     else upstream. Required when the change adds a NEW resolver (e.g. the
 *     `rubrics.list` behind /rubrics), which the deployed backend answers with
 *     `unknown queryName`.
 *
 * Either way: tip UI, real data, no gate cycle required.
 *
 * UNSET (production, the release gate, plain `next dev`): rewrites() returns
 * [] — byte-for-byte identical routing to having no next.config at all. In
 * production the operator sidecar serves `/api/*` itself before Next sees it,
 * so this rewrite is doubly inert there.
 */
const previewDataOrigin = process.env.PAPERCUSP_PREVIEW_DATA_ORIGIN;

/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    if (!previewDataOrigin) return [];
    const origin = previewDataOrigin.replace(/\/+$/, '');
    return [
      {
        source: '/api/:path*',
        destination: `${origin}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
