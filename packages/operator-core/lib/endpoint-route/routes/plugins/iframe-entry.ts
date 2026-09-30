/**
 * GET /api/plugins/:slug/iframe/:entry — operator-templated iframe document.
 * Wraps the plugin's iframeEntry HTML in CSP + nonce + SDK script tag.
 * Ported from app/api/plugins/[slug]/iframe/[entry]/route.ts. `auth: 'public'`.
 */
import { readFile } from 'node:fs/promises';
import { normalize, resolve } from 'node:path';
import { getPluginHost } from '../../../plugin-host-runtime';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/plugins/:slug/iframe/:entry',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const entry = ctx.params.entry as string;
    const url = new URL(req.url);
    const nonce = url.searchParams.get('nonce') ?? '';

    const state = await getPluginHost();
    const lp = state.loaded.find((p) => p.plugin.name === slug);
    if (!lp) return new Response('plugin not found', { status: 404 });

    const entryAbs = resolve(lp.path, normalize(entry));
    if (!entryAbs.startsWith(lp.path + '/')) {
      return new Response('iframe entry outside plugin dir', { status: 400 });
    }
    let inner: string;
    try {
      inner = await readFile(entryAbs, 'utf8');
    } catch {
      return new Response('iframe entry not readable', { status: 404 });
    }

    const innerWithNonce = inner.replace(/__PAPERCUP_NONCE__/g, nonce);
    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'self'">
    <meta name="papercup-nonce" content="${nonce}">
    <meta name="papercup-plugin" content="${slug}">
  </head>
  <body>
${innerWithNonce}
  </body>
</html>
`;

    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      },
    });
  },
});
