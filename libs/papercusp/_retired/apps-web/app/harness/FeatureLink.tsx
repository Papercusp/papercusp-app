'use client';

import { ReactNode } from 'react';
import * as HoverCard from '@radix-ui/react-hover-card';
import { ExternalLink, Circle, Loader2, AlertTriangle, CheckCircle2, CircleSlash, Clock } from 'lucide-react';

export interface FeatureLite {
  id: string;
  title: string;
  status: 'todo' | 'in_progress' | 'validating' | 'failing' | 'passed' | 'blocked';
  attempts: number;
  claims?: string[];
  notes?: string;
  source?: string;
}

const STATUS_META: Record<FeatureLite['status'], { color: string; bg: string; label: string; Icon: typeof Circle }> = {
  todo:        { color: '#9ca3af', bg: 'rgba(156,163,175,0.15)',  label: 'todo',       Icon: Clock },
  in_progress: { color: '#7aa2f7', bg: 'rgba(122,162,247,0.15)', label: 'working',    Icon: Loader2 },
  validating:  { color: '#c084fc', bg: 'rgba(192,132,252,0.15)', label: 'validating', Icon: Loader2 },
  failing:     { color: '#f7768e', bg: 'rgba(247,118,142,0.15)', label: 'failing',    Icon: AlertTriangle },
  passed:      { color: '#9ece6a', bg: 'rgba(158,206,106,0.15)', label: 'passed',     Icon: CheckCircle2 },
  blocked:     { color: '#e0af68', bg: 'rgba(224,175,104,0.15)', label: 'blocked',    Icon: CircleSlash },
};

export function FeatureLink({
  fid,
  feature,
  onOpen,
  children,
}: {
  fid: string;
  feature: FeatureLite | null;
  onOpen?: (id: string) => void;
  children: ReactNode;
}) {
  if (!feature) {
    // Unknown id — render as dimmed monospace with a tooltip explaining
    return (
      <HoverCard.Root openDelay={150} closeDelay={80}>
        <HoverCard.Trigger asChild>
          <span className="h-fid-chip h-fid-unknown">{children}</span>
        </HoverCard.Trigger>
        <HoverCard.Portal>
          <HoverCard.Content className="h-fid-pop" sideOffset={6} collisionPadding={10}>
            <div style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
              No matching feature for <code>{fid}</code>. It may have been renamed or deleted.
            </div>
          </HoverCard.Content>
        </HoverCard.Portal>
      </HoverCard.Root>
    );
  }

  const meta = STATUS_META[feature.status];
  const spin = feature.status === 'in_progress' || feature.status === 'validating';

  return (
    <HoverCard.Root openDelay={150} closeDelay={80}>
      <HoverCard.Trigger asChild>
        <button
          type="button"
          className="h-fid-chip"
          onClick={() => onOpen?.(fid)}
          style={{
            color: meta.color,
            background: meta.bg,
            borderColor: `color-mix(in oklab, ${meta.color}, transparent 55%)`,
          }}
        >
          <meta.Icon size={10} className={spin ? 'h-spin' : ''} style={{ flexShrink: 0 }} />
          {children}
        </button>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content className="h-fid-pop" sideOffset={6} collisionPadding={10}>
          <div className="h-fid-pop-head">
            <span className="h-fid-pop-id">{feature.id}</span>
            <span
              className="h-fid-pop-status"
              style={{ color: meta.color, background: meta.bg, borderColor: `color-mix(in oklab, ${meta.color}, transparent 55%)` }}
            >
              <meta.Icon size={10} className={spin ? 'h-spin' : ''} /> {meta.label}
            </span>
            {feature.attempts > 0 && (
              <span className="h-fid-pop-attempts" title="attempts">×{feature.attempts}</span>
            )}
          </div>
          <div className="h-fid-pop-title">{feature.title}</div>
          {feature.claims && feature.claims.length > 0 && (
            <div className="h-fid-pop-claims">
              {feature.claims.slice(0, 5).map((c) => (
                <code key={c} className="h-fid-pop-claim">{c}</code>
              ))}
              {feature.claims.length > 5 && (
                <span className="h-fid-pop-more">+ {feature.claims.length - 5} more</span>
              )}
            </div>
          )}
          {feature.notes && (
            <div className="h-fid-pop-notes">{feature.notes.slice(0, 300)}{feature.notes.length > 300 ? '…' : ''}</div>
          )}
          {onOpen && (
            <div className="h-fid-pop-footer">
              <span>click to open in queue</span>
              <ExternalLink size={10} />
            </div>
          )}
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
