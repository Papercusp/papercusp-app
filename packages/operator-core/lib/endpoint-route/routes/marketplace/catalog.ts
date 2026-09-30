/**
 * GET /api/marketplace/catalog
 *
 * Serves the bundled fallback catalog, filtered by hidden plugins from
 * harness_shared.hidden_plugins (cached 30s).
 *
 * The legacy marketplace server (`:3057`) is RETIRED (distribution D-005), and
 * the legacy `/marketplace` UI + the `FLAGS.MARKETPLACE` flag are retired too
 * (revive-cupboard-distribution D-004). Plugin/blueprint distribution lives in
 * the (ungated) Cupboard now. This endpoint survives UNGATED as the
 * bundled-catalog source for the internal `scaffold_harness` verb + prompt-build's
 * "Available templates" section (via `/marketplace/spawnable`); it serves the
 * bundled fallback only — no `:3057` fetch.
 *
 * Ported from app/api/marketplace/catalog/route.ts. `auth: 'public'`.
 */
import { getOrgPg, generated } from '@papercusp/db-org';
import FALLBACK_CATALOG from './fallback-catalog.json';
import { defineTool } from '@papercusp/agent-mcp';

const hp = generated.hiddenPluginsInHarnessShared;

let _hiddenCache: { value: Set<string>; expires: number } | null = null;
const HIDDEN_TTL_MS = 30_000;

async function getHiddenBasenames(): Promise<Set<string>> {
  const now = Date.now();
  if (_hiddenCache && _hiddenCache.expires > now) return _hiddenCache.value;
  try {
    // `harness_shared.hidden_plugins` is migration-sourced (000-baseline.sql;
    // harness_app grants from migration 109) — no runtime ensure needed.
    const { db } = getOrgPg();
    const rows = await db.select({ basename: hp.basename }).from(hp);
    const set = new Set(rows.map((r) => r.basename));
    _hiddenCache = { value: set, expires: now + HIDDEN_TTL_MS };
    return set;
  } catch {
    return new Set();
  }
}

function makeIsHidden(hidden: Set<string>) {
  return function isHidden(slugOrName: string | undefined | null): boolean {
    if (!slugOrName) return false;
    const base = slugOrName.includes('/') ? slugOrName.split('/').pop()! : slugOrName;
    return hidden.has(base);
  };
}

export default defineTool({
  method: 'GET',
  path: '/marketplace/catalog',
  auth: 'public',
  async handler() {
    const isHidden = makeIsHidden(await getHiddenBasenames());
    // Bundled fallback catalog only (the :3057 marketplace is retired — D-005).
    // The hidden-plugins filter (the live bit) still applies.
    const items = FALLBACK_CATALOG.filter((m) => !isHidden(m.name)).map((m) => ({
      slug: m.name, name: m.name, version: m.version,
      description: m.description, author: m.author, license: m.license,
      plugins: m.plugins, homepage: m.homepage ?? null,
      install: `papercusp install ${m.name}`,
      source: 'fallback',
    }));
    return Response.json({ catalog: items, source: 'fallback' });
  },
});
