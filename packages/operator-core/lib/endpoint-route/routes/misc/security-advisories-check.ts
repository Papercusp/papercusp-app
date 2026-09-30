/**
 * POST /api/security-advisories/check
 *
 * Consults a plugin-advisory catalog for known advisories on a pinned plugin
 * version. The legacy `:3057` marketplace is RETIRED (revive-cupboard-distribution
 * D-004): there is no `:3057` default anymore. The Cupboard is a listing registry,
 * not an advisory DB, and plugin-advisory data is a deferred v1 feature (D-009 —
 * trust = capability-gate + install-consent), so with no advisory source
 * configured this returns `clean` (no doomed fetch). The http seam is kept for a
 * real advisory source set via `PAPERCUSP_MARKETPLACE_URL` (self-host / future).
 * `auth: 'loopback'` (auth-tier Wave 1).
 */
import {
  checkPinnedVersionAdvisories,
  type AdvisorySeverity,
  type CatalogClient,
  type MarketplaceCatalogEntry,
} from '../../../security-advisories';
import { defineTool } from '@papercusp/agent-mcp';

/** No advisory source configured → no entry → `checkPinnedVersionAdvisories` reports `clean`. */
const noOpCatalogClient: CatalogClient = {
  async getEntry(): Promise<MarketplaceCatalogEntry | null> {
    return null;
  },
};

/** An HTTP advisory-catalog client against an explicitly-configured source (not `:3057`). */
function makeHttpCatalogClient(baseUrl: string): CatalogClient {
  return {
    async getEntry(pluginSlug, version): Promise<MarketplaceCatalogEntry | null> {
      const url = `${baseUrl}/api/catalog/${encodeURIComponent(pluginSlug)}/${encodeURIComponent(version)}`;
      let res: Response;
      try {
        res = await fetch(url, { headers: { accept: 'application/json' } });
      } catch (e: unknown) {
        throw new Error(`advisory catalog fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`advisory catalog returned HTTP ${res.status}`);
      return ((await res.json()) as MarketplaceCatalogEntry) ?? null;
    },
    async getLatestSafe(pluginSlug, minSeverity) {
      const url = `${baseUrl}/api/catalog/${encodeURIComponent(pluginSlug)}/latest-safe?minSeverity=${minSeverity}`;
      try {
        const res = await fetch(url, { headers: { accept: 'application/json' } });
        if (!res.ok) return null;
        return ((await res.json()) as { version?: string }).version ?? null;
      } catch {
        return null;
      }
    },
  };
}

/** Resolve the advisory-catalog client per request: an explicitly-set source, else no-op. */
function resolveCatalogClient(): CatalogClient {
  const url = process.env.PAPERCUSP_MARKETPLACE_URL?.trim();
  return url ? makeHttpCatalogClient(url) : noOpCatalogClient;
}

interface Body {
  plugin?: string;
  version?: string;
  minSeverity?: AdvisorySeverity;
}

export default defineTool({
  method: 'POST',
  path: '/security-advisories/check',
  auth: 'loopback',
  async handler(req) {
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return Response.json({ ok: false, error: 'invalid json' }, { status: 400 });
    }
    if (!body.plugin || !body.version) {
      return Response.json({ ok: false, error: 'plugin + version required' }, { status: 400 });
    }
    const result = await checkPinnedVersionAdvisories(
      resolveCatalogClient(),
      body.plugin,
      body.version,
      body.minSeverity ?? 'moderate',
    );
    return Response.json({ ok: true, result });
  },
});
