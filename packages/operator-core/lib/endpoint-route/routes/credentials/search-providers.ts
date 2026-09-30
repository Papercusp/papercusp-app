/**
 * GET / POST /api/credentials/search-providers
 *
 * GET  — masked view of configured search-provider keys.
 * POST — write env-var values; body `{ values: { ENV_VAR: string|null } }`.
 *
 * Ported from app/api/credentials/search-providers/route.ts.
 * `auth: 'public'` preserves original behavior.
 */
import { readMaskedView, writeSearchProviderCredentials } from '../../../search-provider-credentials';
import { requireAllowedOriginOr403 } from '../../cors';
import { defineTool } from '@papercusp/agent-mcp';

export default [
  defineTool({
    method: 'GET',
    path: '/credentials/search-providers',
    // unverified-loopback: cookie-less desktop webview (EI-338) — see credentials/index.ts.
    auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
    async handler() {
      return Response.json(await readMaskedView());
    },
  }),
  defineTool({
    method: 'POST',
    path: '/credentials/search-providers',
    // unverified-loopback: cookie-less desktop webview (EI-338) — see credentials/index.ts.
    auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
    async handler(req) {
      const csrf = requireAllowedOriginOr403(req);
      if (csrf) return csrf;
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: 'invalid JSON body' }, { status: 400 });
      }
      const values = (body as { values?: Record<string, string | null> } | null)?.values;
      if (!values || typeof values !== 'object') {
        return Response.json(
          { error: 'expected { values: { ENV_VAR_NAME: string | null, ... } }' },
          { status: 400 },
        );
      }
      const cleaned: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(values)) {
        if (!/^[A-Z][A-Z0-9_]*$/.test(k)) continue;
        if (v === null) cleaned[k] = null;
        else if (typeof v === 'string') cleaned[k] = v;
      }
      await writeSearchProviderCredentials(cleaned);
      return Response.json(await readMaskedView());
    },
  }),
];
