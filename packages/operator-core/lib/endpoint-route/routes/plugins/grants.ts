/**
 * GET  /api/plugins/grants — fetch user-granted caps for a (plugin, version, harness).
 * POST /api/plugins/grants — grant or revoke caps.
 * Ported from app/api/plugins/grants/route.ts. `auth: 'public'`.
 */
import {
  getGrantsForPluginInHarness,
  grantCapabilities,
  revokeCapabilities,
} from '../../../plugin-grants';
import { defineTool } from '@papercusp/agent-mcp';

const get = defineTool({
  method: 'GET',
  path: '/plugins/grants',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const plugin = url.searchParams.get('plugin') ?? '';
    const version = url.searchParams.get('version') ?? '';
    // '' harness = the GLOBAL grant scope, not a swallowed missing scope: it is the
    // documented sentinel for plugin-grants (GrantInput `harnessSlug: '' for global`),
    // and getGrantsForPluginInHarness reads `harness_slug IN (harness, '')`. An absent
    // `harness` param is therefore an explicit global read — no fail-loud gate needed.
    const harness = url.searchParams.get('harness') ?? '';
    if (!plugin || !version) {
      return Response.json({ error: 'plugin + version required' }, { status: 400 });
    }
    const capabilities = await getGrantsForPluginInHarness(plugin, version, harness);
    return Response.json({ capabilities });
  },
});

interface PostBody {
  plugin: string;
  version: string;
  harness: string;
  capabilities: string[];
  action?: 'grant' | 'revoke';
  reason?: string;
}

const post = defineTool({
  method: 'POST',
  path: '/plugins/grants',
  auth: 'loopback',
  async handler(req) {
    let body: PostBody;
    try {
      body = (await req.json()) as PostBody;
    } catch {
      return Response.json({ ok: false, error: 'invalid json' }, { status: 400 });
    }
    if (!body.plugin || !body.version) {
      return Response.json({ ok: false, error: 'plugin + version required' }, { status: 400 });
    }
    const caps = Array.isArray(body.capabilities) ? body.capabilities.filter((c) => typeof c === 'string') : [];
    if (caps.length === 0) {
      return Response.json({ ok: false, error: 'capabilities[] required' }, { status: 400 });
    }
    // As in the GET handler, an absent `body.harness` means the GLOBAL grant scope
    // (`harnessSlug: '' for global`, documented in plugin-grants GrantInput) — the
    // `body.harness ?? ''` below is that explicit global default, not a swallowed
    // missing scope. A per-harness grant/revoke passes a concrete slug.
    const action = body.action ?? 'grant';
    if (action === 'revoke') {
      await revokeCapabilities({
        pluginName: body.plugin,
        pluginVersion: body.version,
        harnessSlug: body.harness ?? '',
        capabilities: caps,
      });
    } else {
      await grantCapabilities({
        pluginName: body.plugin,
        pluginVersion: body.version,
        harnessSlug: body.harness ?? '',
        capabilities: caps,
        grantedBy: 'user',
        reason: body.reason ?? 'install consent',
      });
    }
    return Response.json({ ok: true });
  },
});

export default [get, post];
