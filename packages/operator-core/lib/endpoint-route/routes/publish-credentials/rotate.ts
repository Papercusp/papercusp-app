/**
 * POST /api/publish-credentials/rotate
 *
 * Rotates the Cloudflare-publish tenant secret via the publish host's
 * /rotate-secret endpoint, then persists the fresh secret.
 *
 * Ported from app/api/publish-credentials/rotate/route.ts.
 * `auth: 'public'` — gated on the CLOUDFLARE_PUBLISH flag, not a principal.
 */
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '../../../require-flag';
import {
  maskPublishCredentials,
  readPublishCredentials,
  writePublishCredentials,
} from '../../../publish-credentials';
import {
  b64uDecode,
  derivePublishKey,
  jti,
  manifestSha256Hex,
  mintJwt,
} from '@papercusp/publish-auth';
import { requireAllowedOriginOr403 } from '../../cors';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/publish-credentials/rotate',
  // unverified-loopback: cookie-less desktop webview (EI-338) — see credentials/index.ts.
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  async handler(req) {
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;
    const blocked = await gateApiRoute(req, FLAGS.CLOUDFLARE_PUBLISH);
    if (blocked) return blocked;
    const c = await readPublishCredentials();
    if (!c) return Response.json({ error: 'not registered' }, { status: 404 });

    const sha = await manifestSha256Hex({ files: [], deployment_slug: '__rotate__' });
    const key = await derivePublishKey(b64uDecode(c.tenantSecret));
    const token = await mintJwt(key, { sub: c.tenantId, jti: jti(), sha256: sha, aud: 'publish' });

    const r = await fetch(`https://${c.publishHost}/rotate-secret`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    if (!r.ok) {
      return Response.json(
        { error: `rotate failed: ${r.status} ${await r.text()}` },
        { status: 502 },
      );
    }
    const body = (await r.json()) as { tenantSecret: string };
    const fresh = { ...c, tenantSecret: body.tenantSecret, registeredAt: Date.now() };
    await writePublishCredentials(fresh);
    return Response.json(maskPublishCredentials(fresh));
  },
});
