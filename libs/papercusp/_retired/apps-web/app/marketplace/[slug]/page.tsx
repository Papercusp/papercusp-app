interface DetailResponse {
  slug: string;
  versions: string[];
  latest: {
    name: string;
    version: string;
    description?: string;
    author?: string;
    license?: string;
    plugins?: string[];
    homepage?: string;
    publishedBy?: string;
    publishedAt?: string;
  };
  manifest?: Record<string, unknown>;
  readme?: string | null;
  error?: string;
}

async function loadDetail(slug: string): Promise<DetailResponse | null> {
  const base = process.env.PAPERCUSP_INTERNAL_BASE ?? 'http://localhost:3055';
  try {
    const r = await fetch(`${base}/api/marketplace/${slug}`, { cache: 'no-store' });
    if (!r.ok) return null;
    return (await r.json()) as DetailResponse;
  } catch {
    return null;
  }
}

export default async function HarnessDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const detail = await loadDetail(slug);

  if (!detail || detail.error || !detail.latest) {
    return (
      <div className="pc-shell">
        <h1>{slug}</h1>
        <p style={{ color: 'var(--bad)' }}>This harness isn&rsquo;t in the catalog.</p>
        <p>
          <a href="/marketplace" className="pc-button">← back to marketplace</a>
        </p>
      </div>
    );
  }

  const m = detail.latest;
  return (
    <div className="pc-shell">
      <p style={{ marginBottom: 8 }}>
        <a href="/marketplace" style={{ color: 'var(--fg-mute)', fontSize: 12 }}>← back to marketplace</a>
      </p>
      <h1>{m.name}</h1>
      <p style={{ marginTop: -8 }}>
        <code>v{m.version}</code> · {m.license ?? 'unspecified'} · {m.author ?? 'unknown'}
        {m.publishedBy && (
          <> · published by <strong>@{m.publishedBy}</strong></>
        )}
      </p>

      <p style={{ fontSize: 16, color: 'var(--fg)', maxWidth: 720 }}>{m.description}</p>

      <div className="pc-card" style={{ marginTop: 24, marginBottom: 24 }}>
        <h3 style={{ marginTop: 0 }}>Install</h3>
        <pre style={{ background: 'var(--bg-1)', padding: '10px 12px', borderRadius: 4, fontSize: 13, color: 'var(--fg)', overflow: 'auto' }}>
$ papercusp install {m.name}{`\n`}
$ papercusp init my-project --from {m.name}{`\n`}
$ papercusp run my-project
        </pre>
      </div>

      <h2>Versions</h2>
      <ul>
        {detail.versions.map((v) => (
          <li key={v}><code>{v}</code></li>
        ))}
      </ul>

      {m.plugins && m.plugins.length > 0 && (
        <>
          <h2>Plugins</h2>
          <ul>
            {m.plugins.map((p) => <li key={p}><code>{p}</code></li>)}
          </ul>
        </>
      )}

      {detail.readme && (
        <>
          <h2>README</h2>
          <pre style={{ whiteSpace: 'pre-wrap', background: 'var(--bg-2)', padding: 16, borderRadius: 8, fontSize: 13, lineHeight: 1.6, color: 'var(--fg)' }}>
            {detail.readme}
          </pre>
        </>
      )}
    </div>
  );
}
