import { createFileRoute } from '@tanstack/react-router';
import { useLexicon } from '@/lib/useLexicon';

interface WikiMissingSearch {
  target?: string;
  harness?: string;
}

export const Route = createFileRoute('/wiki/missing')({
  validateSearch: (search): WikiMissingSearch => ({
    target: typeof search.target === 'string' ? search.target : undefined,
    harness: typeof search.harness === 'string' ? search.harness : undefined,
  }),
  component: WikiMissingPage,
});

/**
 * The intentional destination for unresolved [[wiki-links]]. The old Next
 * page reads the server filesystem and cannot be imported into the browser
 * SPA; keep this route client-safe so the Hono redirect has a real target.
 */
function WikiMissingPage() {
  const { target, harness } = Route.useSearch();
  const t = useLexicon();
  const targetLabel = target?.trim() || 'unknown target';

  return (
    <div
      className="pc-wiki-missing-shell"
      data-testid="wiki-missing-page"
      style={{ maxWidth: 720, margin: '40px auto', padding: 24, color: '#e6e6e6', fontFamily: 'system-ui' }}
    >
      <h1 className="pc-wiki-missing-title" style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>
        Wiki link not found
      </h1>
      <p className="pc-wiki-missing-copy" style={{ color: '#aaa', marginBottom: 16 }}>
        No file matched{' '}
        <code className="pc-wiki-missing-target" style={{ background: '#1a1d22', padding: '2px 6px', borderRadius: 3 }}>
          [[{targetLabel}]]
        </code>
        {harness ? <> in {t('pot', { lower: true })} <strong>{harness}</strong></> : null}.
      </p>
      <p className="pc-wiki-missing-none" style={{ color: '#aaa' }}>
        The link target may have been renamed or removed.
      </p>
      <div className="pc-wiki-missing-back" style={{ marginTop: 32 }}>
        <a href="/adv?tab=harnesses" className="pc-wiki-missing-link pc-wiki-missing-link--back" style={{ color: '#6ab0ff' }}>
          ← Back to {t('pot')} dashboard
        </a>
      </div>
    </div>
  );
}
