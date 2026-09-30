/**
 * GET / DELETE /api/publish-credentials
 *
 * GET    — masked view of the Cloudflare-publish tenant credentials.
 * DELETE — clear them.
 *
 * Ported from app/api/publish-credentials/route.ts. `auth: 'public'` —
 * the route gates on the CLOUDFLARE_PUBLISH feature flag via
 * gateApiRoute, not on a principal.
 */
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '../../../require-flag';
import {
  deletePublishCredentials,
  maskPublishCredentials,
  readPublishCredentials,
} from '../../../publish-credentials';
import { requireAllowedOriginOr403 } from '../../cors';
import { defineTool } from '@papercusp/agent-mcp';

export default [
  defineTool({
    method: 'GET',
    path: '/publish-credentials',
    // unverified-loopback: cookie-less desktop webview (EI-338) — see credentials/index.ts.
    auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
    async handler(req) {
      const blocked = await gateApiRoute(req, FLAGS.CLOUDFLARE_PUBLISH);
      if (blocked) return blocked;
      return Response.json(maskPublishCredentials(await readPublishCredentials()));
    },
  }),
  defineTool({
    method: 'DELETE',
    path: '/publish-credentials',
    // unverified-loopback: cookie-less desktop webview (EI-338) — see credentials/index.ts.
    auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
    async handler(req) {
      const csrf = requireAllowedOriginOr403(req);
      if (csrf) return csrf;
      const blocked = await gateApiRoute(req, FLAGS.CLOUDFLARE_PUBLISH);
      if (blocked) return blocked;
      await deletePublishCredentials();
      return Response.json({ ok: true });
    },
  }),
];
