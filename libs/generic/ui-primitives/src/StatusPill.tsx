'use client';

import { Check, Circle, CircleSlash, Loader2, AlertTriangle, Clock } from 'lucide-react';

// Canonical FeatureStatus. Imported by HarnessDashboard etc. so adding
// a new status here doesn't require editing the dashboard's local
// duplicate.
export type FeatureStatus = 'todo' | 'in_progress' | 'validating' | 'failing' | 'passed' | 'blocked';

const ICONS: Record<FeatureStatus, typeof Check> = {
  todo: Clock,
  in_progress: Loader2,
  validating: Loader2,
  failing: AlertTriangle,
  passed: Check,
  blocked: CircleSlash,
};

const LABELS: Record<FeatureStatus, string> = {
  todo: 'todo',
  in_progress: 'working',
  validating: 'validating',
  failing: 'failing',
  passed: 'passed',
  blocked: 'blocked',
};

export function StatusPill({ status }: { status: FeatureStatus }) {
  const Icon = ICONS[status] ?? Circle;
  const spin = status === 'in_progress' || status === 'validating';
  return (
    <span className={`h-pill ${status}`}>
      <Icon size={11} className={spin ? 'animate-spin' : ''} style={spin ? { animation: 'spin 1s linear infinite' } : undefined} />
      {LABELS[status] ?? status}
    </span>
  );
}
