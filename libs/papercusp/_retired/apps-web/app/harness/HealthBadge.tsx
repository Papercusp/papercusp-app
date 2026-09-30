'use client';

import { useCallback, useEffect, useState } from 'react';
import { Heart } from 'lucide-react';
import { StatCard } from '@papercusp/ui-primitives';

interface HealthCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

interface HealthPayload {
  ok: boolean;
  alive: boolean;
  escalated: boolean;
  features: { total: number; passed: number; failing: number; inProgress: number; blocked: number };
  lastRunAgeSeconds: number | null;
  ghostRate: number;
  checks: HealthCheck[];
}

interface Props {
  slug: string;
}

export default function HealthBadge({ slug }: Props) {
  const [data, setData] = useState<HealthPayload | null>(null);
  const [err, setErr] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/harness/${slug}/health`);
      if (!r.ok) throw new Error(`${r.status}`);
      const d: HealthPayload = await r.json();
      setData(d);
      setErr(false);
    } catch {
      setErr(true);
    }
  }, [slug]);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  if (err) {
    return (
      <div title="Health endpoint failed to load">
        <StatCard label="health" value="—" tone="bad" icon={<Heart size={13} />} />
      </div>
    );
  }

  if (!data) {
    return (
      <div title="Loading health…">
        <StatCard label="health" value="…" icon={<Heart size={13} />} />
      </div>
    );
  }

  const passed = data.checks.filter((c) => c.ok).length;
  const total = data.checks.length;
  const tone: 'good' | 'warn' | 'bad' = data.ok ? 'good' : passed >= Math.ceil(total * 0.7) ? 'warn' : 'bad';

  const tooltip = [
    `overall: ${data.ok ? 'OK' : 'degraded'}`,
    `alive: ${data.alive ? 'yes' : 'no'}`,
    `escalated: ${data.escalated ? 'yes' : 'no'}`,
    `features: ${data.features.passed}/${data.features.total} passed, ${data.features.failing} failing, ${data.features.blocked} blocked`,
    data.lastRunAgeSeconds !== null ? `last run: ${data.lastRunAgeSeconds}s ago` : 'last run: —',
    `ghost rate: ${(data.ghostRate * 100).toFixed(1)}%`,
    '',
    ...data.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`),
  ].join('\n');

  return (
    <div title={tooltip}>
      <StatCard
        label="health"
        value={`${passed}/${total}`}
        tone={tone}
        icon={<Heart size={13} />}
      />
    </div>
  );
}
