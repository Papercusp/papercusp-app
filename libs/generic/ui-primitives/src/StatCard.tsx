'use client';

import { ReactNode } from 'react';

export function StatCard({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: ReactNode;
  tone?: 'good' | 'bad' | 'warn' | 'info';
  icon?: ReactNode;
}) {
  return (
    <div className="h-stat">
      <span className="h-stat-label">{label}</span>
      <span className={`h-stat-value${tone ? ' ' + tone : ''}`}>
        {icon}
        {value}
      </span>
    </div>
  );
}
