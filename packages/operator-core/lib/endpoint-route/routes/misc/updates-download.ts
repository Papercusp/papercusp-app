/**
 * GET /api/updates/download — streaming proxy for desktop update
 * artifacts (desktop-auto-update-operational-2026-07-09 P-003).
 *
 * The release repo is PRIVATE: `browser_download_url` 404s without auth,
 * and tauri-plugin-updater sends no Authorization header. The manifest
 * route (`/updates/manifest`) therefore points the updater at THIS
 * loopback route, which streams the artifact server-side with the
 * operator's GitHub token.
 *
 * Two sources:
 *   - `?asset_id=<n>[&name=…]` — a GitHub release asset, fetched through
 *     the API (Accept: octet-stream) with the redirect followed manually
 *     so the token never leaks to the CDN.
 *   - `?tag=<tag>&name=<file>` — the static release host
 *     (PAPERCUSP_RELEASE_HOST) for artifacts over GitHub's 2 GiB asset
 *     cap (Linux bundles). Tries `<host>/<tag>/<file>` then
 *     `<host>/<file>`.
 *
 * `auth: 'public'`: the Tauri updater downloads unauthenticated on
 * loopback, exactly like the manifest poll. Content-Length is passed
 * through so the updater's progress callbacks work.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { fetchAssetResponse, releaseHostBase, resolveGithubToken } from './updates-github';

/** Release artifact names: version/product tokens, dots, spaces, +~. */
const SAFE_NAME = /^[A-Za-z0-9 ._+~-]+$/;

function streamThrough(upstream: Response, filename: string | null): Response {
  const headers = new Headers({
    'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
  });
  const len = upstream.headers.get('content-length');
  if (len) headers.set('content-length', len);
  if (filename) headers.set('content-disposition', `attachment; filename="${filename}"`);
  return new Response(upstream.body, { status: 200, headers });
}

export default defineTool({
  method: 'GET',
  path: '/updates/download',
  auth: 'public',
  async handler(req) {
    const params = new URL(req.url).searchParams;
    const assetId = params.get('asset_id');
    const tag = params.get('tag');
    const name = params.get('name');

    if (name && !SAFE_NAME.test(name)) {
      return Response.json({ error: 'invalid name' }, { status: 400 });
    }

    if (assetId) {
      if (!/^\d+$/.test(assetId)) {
        return Response.json({ error: 'invalid asset_id' }, { status: 400 });
      }
      const token = await resolveGithubToken();
      const upstream = await fetchAssetResponse(assetId, token);
      if (!upstream || !upstream.ok || !upstream.body) {
        console.warn(
          `[updates/download] asset ${assetId} (${name ?? 'unnamed'}) unreachable (status ${upstream?.status ?? 'n/a'})`,
        );
        return Response.json({ error: `asset ${assetId} unreachable` }, { status: 502 });
      }
      return streamThrough(upstream, name);
    }

    if (tag && name) {
      const host = releaseHostBase();
      if (!host) {
        return Response.json(
          { error: 'PAPERCUSP_RELEASE_HOST not configured — cannot serve off-GitHub artifact' },
          { status: 404 },
        );
      }
      if (!SAFE_NAME.test(tag)) {
        return Response.json({ error: 'invalid tag' }, { status: 400 });
      }
      for (const url of [
        `${host}/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
        `${host}/${encodeURIComponent(name)}`,
      ]) {
        try {
          const upstream = await fetch(url);
          if (upstream.ok && upstream.body) return streamThrough(upstream, name);
        } catch {
          /* try next candidate */
        }
      }
      console.warn(`[updates/download] ${name} (${tag}) not found on release host ${host}`);
      return Response.json({ error: `${name} not found on release host` }, { status: 404 });
    }

    return Response.json({ error: 'pass asset_id, or tag + name' }, { status: 400 });
  },
});
