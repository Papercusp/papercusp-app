'use client';

import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkFeatureLinks } from './remarkFeatureLinks';
import { FeatureLink, type FeatureLite } from './FeatureLink';

interface Props {
  slug: string;
  onOpenFeature?: (id: string) => void;
}

export default function SummaryPanel({ slug, onOpenFeature }: Props) {
  const [source, setSource] = useState<string | null>(null);
  const [features, setFeatures] = useState<FeatureLite[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [sumRes, statusRes] = await Promise.all([
          fetch(`/api/harness/${encodeURIComponent(slug)}/summary`),
          fetch(`/api/harness/${encodeURIComponent(slug)}/status`),
        ]);
        if (!sumRes.ok) throw new Error(`summary HTTP ${sumRes.status}`);
        const sum = await sumRes.json();
        const status = statusRes.ok ? await statusRes.json() : null;
        if (cancelled) return;
        setSource(typeof sum.summary === 'string' ? sum.summary : '');
        setFeatures(status?.features ?? []);
        setError(null);
      } catch (e: any) {
        if (cancelled) return;
        setError(e?.message ?? 'failed to load');
      }
    };
    load();
    const id = setInterval(load, 10_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [slug]);

  const featuresById = useMemo(() => {
    const m = new Map<string, FeatureLite>();
    for (const f of features) m.set(f.id, f);
    return m;
  }, [features]);

  const components = useMemo(() => ({
    a: (props: any) => {
      const fid = props['data-fid'];
      if (fid) {
        return (
          <FeatureLink fid={fid} feature={featuresById.get(fid) ?? null} onOpen={onOpenFeature}>
            {props.children}
          </FeatureLink>
        );
      }
      return <a {...props} target="_blank" rel="noreferrer" />;
    },
  }), [featuresById, onOpenFeature]);

  const outerStyle = {
    flex: 1,
    width: '100%',
    height: '100%',
    overflowY: 'auto' as const,
    padding: 20,
    background: 'var(--bg-2)',
    border: '1px solid color-mix(in oklab, var(--border), white 8%)',
    borderRadius: 14,
    boxShadow: '0 18px 48px rgba(0,0,0,0.28)',
  };

  if (error) {
    return (
      <div style={outerStyle}>
        <div className="h-empty">
          <span className="h-empty-icon">!</span>
          <span>summary unavailable: {error}</span>
        </div>
      </div>
    );
  }

  if (source === null) {
    return (
      <div style={outerStyle}>
        <div className="h-empty"><span className="h-empty-icon">…</span><span>loading…</span></div>
      </div>
    );
  }

  if (!source.trim()) {
    return (
      <div style={outerStyle}>
        <div className="h-empty">
          <span className="h-empty-icon">—</span>
          <span>no summary entries yet — the orchestrator writes one when something user-visible ships or a foundational decision is made</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-md" style={outerStyle}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkFeatureLinks]} components={components as any}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
