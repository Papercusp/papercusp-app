'use client';

import { useEffect, useState } from 'react';

interface PreflightCheck {
  name: string;
  status: 'ok' | 'missing' | 'error';
  detail?: string;
  hint?: string;
}

export function StepEmbeddedPg() {
  const [pg, setPg] = useState<PreflightCheck | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch('/api/desktop/preflight', { cache: 'no-store' });
        const j = await r.json();
        if (cancelled) return;
        const found = j.checks?.find((c: PreflightCheck) => c.name === 'postgres') ?? null;
        setPg(found);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void tick();
    const id = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const status = pg?.status ?? (loading ? 'loading' : 'unknown');

  return (
    <div className="pc-step">
      <p className="pc-step__lead">
        The desktop app bundles its own Postgres binary. Nothing for you to install — we just wait
        for it to finish starting up.
      </p>
      <div className="pc-step__progress" data-status={status}>
        <div className="pc-step__progress-dot" />
        <div className="pc-step__progress-text">
          {loading && <span>Checking…</span>}
          {!loading && pg?.status === 'ok' && (
            <>
              <strong>Ready.</strong> <span>{pg.detail}</span>
            </>
          )}
          {!loading && pg?.status === 'missing' && (
            <>
              <strong>Starting up.</strong> <span>{pg.detail}</span>
            </>
          )}
          {!loading && pg?.status === 'error' && (
            <>
              <strong>Failed to start.</strong> <span>{pg.detail}</span>
            </>
          )}
          {!loading && !pg && <span>No status reported.</span>}
        </div>
      </div>
      {pg?.hint && <p className="pc-step__hint">{pg.hint}</p>}
    </div>
  );
}
