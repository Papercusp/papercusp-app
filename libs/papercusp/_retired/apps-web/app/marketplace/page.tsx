interface CatalogEntry {
  slug: string;
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  plugins: string[];
  homepage?: string;
  install: string;
}

interface InstalledHarness {
  slug: string;
  version: string | null;
  description: string | null;
}

async function loadCatalog(): Promise<CatalogEntry[]> {
  // Server-side fetch against our own API route. Using a relative URL would
  // fail in RSC (Next requires absolute URLs for fetch in server components).
  const base = process.env.PAPERCUSP_INTERNAL_BASE ?? 'http://localhost:3055';
  try {
    const r = await fetch(`${base}/api/marketplace/catalog`, { cache: 'no-store' });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d?.catalog) ? d.catalog : [];
  } catch {
    return [];
  }
}

async function loadInstalled(): Promise<InstalledHarness[]> {
  const base = process.env.PAPERCUSP_INTERNAL_BASE ?? 'http://localhost:3055';
  try {
    const r = await fetch(`${base}/api/installed`, { cache: 'no-store' });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d?.harnesses) ? d.harnesses : [];
  } catch {
    return [];
  }
}

export default async function MarketplacePage() {
  const [catalog, installed] = await Promise.all([loadCatalog(), loadInstalled()]);
  const installedSlugs = new Set(installed.map((h) => h.slug));
  return (
    <div className="pc-shell">
      <h1>Marketplace</h1>
      <p>
        Browse community-published harnesses. Pick one, copy the install
        command, and run it locally.
      </p>

      <div className="pc-card" style={{ marginBottom: 24 }}>
        <p style={{ color: 'var(--warn)', margin: 0 }}>
          <strong>Preview catalog.</strong> The marketplace server is being
          built. For now this page shows the curated list of harnesses we
          plan to publish; the install commands won&rsquo;t resolve yet.
        </p>
      </div>

      {installed.length > 0 && (
        <>
          <h2>Installed on this machine</h2>
          <div className="pc-grid cards-3" style={{ marginBottom: 32 }}>
            {installed.map((h) => (
              <a className="pc-card" key={h.slug} href={`/marketplace/${h.slug}`} style={{ textDecoration: 'none', color: 'inherit', cursor: 'pointer' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
                  <h3 style={{ marginTop: 0, marginBottom: 0 }}>{h.slug}</h3>
                  <span style={{ fontSize: 10, color: 'var(--good)', textTransform: 'uppercase', letterSpacing: 0.04 }}>installed</span>
                </div>
                {h.version && <p style={{ margin: '4px 0', fontSize: 11, color: 'var(--fg-mute)' }}>v{h.version}</p>}
                {h.description && <p style={{ minHeight: 48, fontSize: 13 }}>{h.description}</p>}
                <pre style={{ background: 'var(--bg-1)', padding: '8px 10px', borderRadius: 4, fontSize: 12, color: 'var(--fg-mute)', overflow: 'auto' }}>
                  $ papercusp init my-project --from {h.slug}
                </pre>
              </a>
            ))}
          </div>
        </>
      )}

      <h2>{installed.length > 0 ? 'Browse the catalog' : 'Featured'}</h2>
      <div className="pc-grid cards-3">
        {catalog.map((h) => (
          <a className="pc-card" key={h.slug} href={`/marketplace/${h.slug}`} style={{ textDecoration: 'none', color: 'inherit', cursor: 'pointer', transition: 'border-color 120ms ease' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <h3 style={{ marginTop: 0 }}>{h.name}</h3>
              {installedSlugs.has(h.slug) && (
                <span style={{ fontSize: 10, color: 'var(--good)', textTransform: 'uppercase', letterSpacing: 0.04 }}>installed</span>
              )}
            </div>
            <p style={{ minHeight: 64 }}>{h.description}</p>
            <pre style={{ background: 'var(--bg-1)', padding: '8px 10px', borderRadius: 4, fontSize: 12, color: 'var(--fg-mute)', overflow: 'auto' }}>
              $ {h.install}
            </pre>
            <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--fg-mute)' }}>
              <span>v{h.version}</span>
              <span>·</span>
              <span>{h.license}</span>
              {h.plugins.length > 0 && (
                <>
                  <span>·</span>
                  <span>plugins: {h.plugins.join(', ')}</span>
                </>
              )}
            </div>
          </a>
        ))}
        {catalog.length === 0 && <div className="pc-card pc-skeleton" />}
      </div>
    </div>
  );
}
