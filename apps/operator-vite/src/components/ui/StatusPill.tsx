import React from 'react';

export type PillTone = 'good' | 'warn' | 'bad' | 'neutral';

interface StatusPillProps {
  tone: PillTone;
  label: string;
  className?: string;
}

export const StatusPill: React.FC<StatusPillProps> = ({ tone, label, className = '' }) => {
  const baseClass = 'pclsb-pill';
  const toneClass = `pclsb-pill--${tone}`;
  return <span className={`${baseClass} ${toneClass} ${className}`}>{label}</span>;
};
