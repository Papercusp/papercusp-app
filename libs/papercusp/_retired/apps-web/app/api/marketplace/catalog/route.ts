import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Marketplace catalog API.
 *
 * Proxies to the marketplace server at PAPERCUSP_MARKETPLACE_URL (default
 * http://localhost:3057). If the marketplace is unreachable, returns a
 * curated fallback list so the UI still renders something useful.
 */
const FALLBACK_CATALOG = [
  {
    name: 'papercup-org',
    version: '0.1.0',
    description: '5-department fictional company with cross-dept message bus, directives, and an automated YouTube briefing pipeline.',
    author: 'Papercusp Team',
    license: 'MIT',
    plugins: ['briefings@0.1.0'],
    homepage: 'https://papercupai.com',
  },
  {
    name: 'coding-project',
    version: '0.1.0',
    description: 'Solo coding harness: scoper plans features, workers implement, validators verify, reviewers gate proposals. Drop in a SPEC.md and go.',
    author: 'Papercusp Team',
    license: 'MIT',
    plugins: [],
  },
];

export async function GET() {
  const base = process.env.PAPERCUSP_MARKETPLACE_URL ?? 'http://localhost:3057';
  try {
    const r = await fetch(`${base}/catalog`, { cache: 'no-store', signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      const d = await r.json();
      // Reshape from marketplace's `{name, version, ...}` to UI's `{slug, name, install, ...}`.
      const items = (d.catalog ?? []).map((m: any) => ({
        slug: m.name,
        name: m.name,
        version: m.version,
        description: m.description ?? '',
        author: m.author ?? 'unknown',
        license: m.license ?? 'unspecified',
        plugins: m.plugins ?? [],
        homepage: m.homepage ?? null,
        install: `papercusp install ${m.name}`,
        source: 'live',
      }));
      return NextResponse.json({ catalog: items, source: 'marketplace' });
    }
  } catch {}
  // Fallback when marketplace isn't reachable.
  const items = FALLBACK_CATALOG.map((m) => ({
    slug: m.name,
    name: m.name,
    version: m.version,
    description: m.description,
    author: m.author,
    license: m.license,
    plugins: m.plugins,
    homepage: m.homepage ?? null,
    install: `papercusp install ${m.name}`,
    source: 'fallback',
  }));
  return NextResponse.json({ catalog: items, source: 'fallback' });
}
