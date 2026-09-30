/**
 * Trust + consent endpoints.
 *
 *   POST /api/provision/consent — record (or revoke) user consent for a
 *     (publisher, plugin) pair to run a signed scriptHash.
 *   GET  /api/provision/consent — trust check result.
 *
 * Ported from app/api/provision/consent/route.ts. `auth: 'public'` —
 * faithful to the route's prior posture (no auth check). Spec:
 * /docs/snapshots/build-scripts#trust-lifecycle.
 */
import { checkTrust, recordTrust, revokeTrust } from '../../../provision/trust-store';
import { defineTool } from '@papercusp/agent-mcp';

interface PostBody {
  publisher?: string;
  plugin?: string;
  scriptHash?: string;
  publisherKeyFingerprint?: string;
  dev?: boolean;
  /** When true, drops trust instead of recording it. */
  revoke?: boolean;
}

const post = defineTool({
  method: 'POST',
  path: '/provision/consent',
  auth: { trust: ['verified', 'trusted'] },
  async handler(req) {
    let body: PostBody;
    try {
      body = (await req.json()) as PostBody;
    } catch {
      return Response.json({ ok: false, error: 'invalid json' }, { status: 400 });
    }
    if (!body.publisher || !body.plugin) {
      return Response.json({ ok: false, error: 'publisher + plugin required' }, { status: 400 });
    }
    if (body.revoke) {
      await revokeTrust(body.publisher, body.plugin);
      return Response.json({ ok: true });
    }
    if (!body.scriptHash || !body.publisherKeyFingerprint) {
      return Response.json(
        { ok: false, error: 'scriptHash + publisherKeyFingerprint required' },
        { status: 400 },
      );
    }
    await recordTrust({
      publisher: body.publisher,
      plugin: body.plugin,
      publisherKeyFingerprint: body.publisherKeyFingerprint,
      scriptHash: body.scriptHash,
      dev: body.dev,
    });
    return Response.json({ ok: true });
  },
});

const get = defineTool({
  method: 'GET',
  path: '/provision/consent',
  auth: { trust: ['verified', 'trusted'] },
  async handler(req) {
    const url = new URL(req.url);
    const publisher = url.searchParams.get('publisher') ?? '';
    const plugin = url.searchParams.get('plugin') ?? '';
    const scriptHash = url.searchParams.get('scriptHash') ?? '';
    const fingerprint = url.searchParams.get('fingerprint') ?? '';
    if (!publisher || !plugin || !scriptHash || !fingerprint) {
      return Response.json(
        { ok: false, error: 'publisher, plugin, scriptHash, fingerprint required' },
        { status: 400 },
      );
    }
    const result = await checkTrust({
      publisher,
      plugin,
      scriptHash,
      currentFingerprint: fingerprint,
    });
    return Response.json({ ok: true, result });
  },
});

export default [post, get];
