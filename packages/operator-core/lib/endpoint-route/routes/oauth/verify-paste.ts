/**
 * POST /api/oauth/verify-paste
 *
 * Hybrid mode: user pastes a PAT. The provider's introspection endpoint
 * verifies the token's granted scopes against the plugin's required
 * scopes (exact/superset accept, subset reject).
 *
 * Ported from app/api/oauth/verify-paste/route.ts. `auth: 'public'`.
 */
import {
  compareScopes,
  getProvider,
  loadAndRegisterProvidersFromDisk,
} from '../../../oauth/providers';
import { fsTokenStorage } from '../../../oauth/storage-fs';
import { defineTool } from '@papercusp/agent-mcp';

let providersLoaded = false;
async function ensureProvidersLoaded(): Promise<void> {
  if (providersLoaded) return;
  await loadAndRegisterProvidersFromDisk();
  providersLoaded = true;
}

interface Body {
  provider?: string;
  plugin?: string;
  harness?: string;
  field?: string;
  token?: string;
  requiredScopes?: string[];
}

export default defineTool({
  method: 'POST',
  path: '/oauth/verify-paste',
  auth: { trust: ['verified', 'trusted'] },
  async handler(req) {
    await ensureProvidersLoaded();
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return Response.json({ ok: false, error: 'invalid json' }, { status: 400 });
    }
    const { provider: providerId, plugin, harness, field, token } = body;
    if (!providerId || !plugin || !harness || !field || !token) {
      return Response.json(
        { ok: false, error: 'provider, plugin, harness, field, token all required' },
        { status: 400 },
      );
    }
    const provider = getProvider(providerId);
    if (!provider) {
      return Response.json({ ok: false, error: `unknown provider "${providerId}"` }, { status: 404 });
    }
    if (!provider.introspect) {
      await fsTokenStorage.update(plugin, harness, { [field]: token });
      return Response.json({ ok: true, outcome: 'no-introspection', scopes: [] });
    }

    let granted: string[];
    try {
      granted = (await provider.introspect(token)).scopes;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ ok: false, error: `introspect failed: ${msg}` }, { status: 400 });
    }

    const outcome = compareScopes(granted, body.requiredScopes ?? []);
    if (outcome.kind === 'subset') {
      return Response.json(
        {
          ok: false,
          outcome: 'subset',
          missing: outcome.missing,
          scopes: granted,
          error: `token missing required scopes: ${outcome.missing.join(', ')}`,
        },
        { status: 400 },
      );
    }
    await fsTokenStorage.update(plugin, harness, { [field]: token });
    if (outcome.kind === 'superset') {
      return Response.json({ ok: true, outcome: 'superset', extra: outcome.extra, scopes: granted });
    }
    return Response.json({ ok: true, outcome: 'exact', scopes: granted });
  },
});
