'use client';

import { useEffect, useState } from 'react';
import dynamic from '@/lib/router-compat/dynamic';

/**
 * dockview-react v5 + Next 16 Turbopack hydration: when the dock
 * component is rendered both server- and client-side, the SSR'd
 * static DOM is not picked up by client hydration (no React fibers
 * attach to the dock subtree, dockview's onReady never fires).
 * Wrapping with `next/dynamic({ ssr: false })` skips the SSR pass
 * for this subtree entirely, so the client mount path is the only
 * one — which dockview's imperative-init pattern can rely on.
 *
 * The earlier `useSearchParams()` Suspense form had the same
 * symptom; reading from `window.location` after mount sidesteps
 * it cleanly without a Suspense boundary.
 */
const PiTerminalsDock = dynamic(() => import('../harness/PiTerminalsDock'), {
  ssr: false,
});

export default function Page() {
  const [params, setParams] = useState<{ slug: string; lane?: string } | null>(null);

  useEffect(() => {
    const usp = new URLSearchParams(window.location.search);
    const slug = usp.get('harness') ?? '';
    const lane = usp.get('lane') ?? undefined;
    setParams(slug ? { slug, lane } : { slug: '' });
  }, []);

  if (!params) return null;
  if (!params.slug) {
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui', color: '#aaa' }}>
        Missing <code>?harness=&lt;slug&gt;</code> query parameter.
      </div>
    );
  }

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', minHeight: 0 }}>
      <PiTerminalsDock slug={params.slug} initialLaneId={params.lane} />
    </div>
  );
}
