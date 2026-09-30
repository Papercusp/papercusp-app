'use client';

import { useEffect, useMemo, useState } from 'react';
import { COLORS, FONTS, RADIUS, SIZES, STATUS, HarnessStatus } from './theme';
import { StatusPill } from './primitives';

interface Feature {
  id: string;
  status: HarnessStatus;
  attempts: number;
  title: string;
}

export interface PulseEvent {
  id: string;
  kind: 'status' | 'attempts' | 'iteration' | 'escalation' | 'agent_start';
  ts: number;
  featureId?: string;
  title?: string;
  from?: HarnessStatus;
  to?: HarnessStatus;
  iteration?: number;
  role?: string;
  text?: string;
}

/**
 * Derives a rolling activity feed from feature state changes. The backend
 * doesn't maintain an event log, so we diff successive feature snapshots
 * in-memory and surface transitions.
 */
export function usePulse(features: Feature[], iteration: number, escalated: boolean) {
  const [events, setEvents] = useState<PulseEvent[]>([]);
  const [prevMap, setPrevMap] = useState<Map<string, Feature> | null>(null);
  const [prevIter, setPrevIter] = useState<number | null>(null);
  const [prevEsc, setPrevEsc] = useState<boolean | null>(null);

  useEffect(() => {
    if (prevMap === null) {
      setPrevMap(new Map(features.map((f) => [f.id, f])));
      setPrevIter(iteration);
      setPrevEsc(escalated);
      return;
    }
    const now = Date.now();
    const fresh: PulseEvent[] = [];
    for (const f of features) {
      const before = prevMap.get(f.id);
      if (!before) continue;
      if (before.status !== f.status) {
        fresh.push({
          id: `${f.id}-${now}-s`,
          kind: 'status',
          ts: now,
          featureId: f.id,
          title: f.title,
          from: before.status,
          to: f.status,
        });
      } else if (before.attempts !== f.attempts) {
        fresh.push({
          id: `${f.id}-${now}-a`,
          kind: 'attempts',
          ts: now,
          featureId: f.id,
          title: f.title,
        });
      }
    }
    if (prevIter !== null && iteration !== prevIter && iteration > 0) {
      fresh.push({ id: `iter-${iteration}-${now}`, kind: 'iteration', ts: now, iteration });
    }
    if (prevEsc !== null && escalated && !prevEsc) {
      fresh.push({ id: `esc-${now}`, kind: 'escalation', ts: now });
    }
    if (fresh.length) {
      setEvents((prev) => [...fresh, ...prev].slice(0, 60));
    }
    setPrevMap(new Map(features.map((f) => [f.id, f])));
    setPrevIter(iteration);
    setPrevEsc(escalated);
  }, [features, iteration, escalated]); // eslint-disable-line react-hooks/exhaustive-deps

  return events;
}

function fmtAgo(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

export default function PulseFeed({
  events,
  onOpenFeature,
}: {
  events: PulseEvent[];
  onOpenFeature: (id: string) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

  if (events.length === 0) {
    return (
      <div style={{
        padding: '6px 10px',
        fontSize: SIZES.xs,
        color: COLORS.textDim,
        borderTop: `1px solid ${COLORS.borderSubtle}`,
        borderBottom: `1px solid ${COLORS.borderSubtle}`,
      }}>
        <span style={{ color: COLORS.textFaint }}>● no recent activity</span>
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 16,
      padding: '4px 10px',
      background: COLORS.surface,
      borderTop: `1px solid ${COLORS.borderSubtle}`,
      borderBottom: `1px solid ${COLORS.borderSubtle}`,
      overflow: 'hidden',
    }}>
      <span style={{
        fontSize: '0.6rem',
        color: COLORS.textDim,
        textTransform: 'uppercase',
        letterSpacing: '0.1em',
        fontWeight: 600,
        flexShrink: 0,
      }}>PULSE</span>
      <div style={{
        display: 'flex',
        gap: 18,
        overflowX: 'auto',
        flex: 1,
        fontSize: SIZES.xs,
        whiteSpace: 'nowrap',
      }}>
        {events.slice(0, 10).map((e) => (
          <PulseRow key={e.id} e={e} now={now} onOpenFeature={onOpenFeature} />
        ))}
      </div>
    </div>
  );
}

function PulseRow({
  e, now, onOpenFeature,
}: {
  e: PulseEvent;
  now: number;
  onOpenFeature: (id: string) => void;
}) {
  const age = fmtAgo(now - e.ts);
  if (e.kind === 'status' && e.featureId && e.to) {
    const from = e.from ? STATUS[e.from] : null;
    const to = STATUS[e.to];
    return (
      <span
        onClick={() => onOpenFeature(e.featureId!)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: COLORS.text }}
      >
        <span style={{ fontFamily: FONTS.mono, color: COLORS.textMuted }}>{e.featureId}</span>
        {from && <span style={{ color: COLORS.textDim }}>{from.label.toLowerCase()}</span>}
        <span style={{ color: COLORS.textDim }}>→</span>
        <span style={{ color: to.text, fontWeight: 500 }}>{to.label.toLowerCase()}</span>
        <span style={{ color: COLORS.textFaint }}>{age}</span>
      </span>
    );
  }
  if (e.kind === 'attempts' && e.featureId) {
    return (
      <span
        onClick={() => onOpenFeature(e.featureId!)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: COLORS.textMuted }}
      >
        <span style={{ fontFamily: FONTS.mono }}>{e.featureId}</span>
        <span>retry</span>
        <span style={{ color: COLORS.textFaint }}>{age}</span>
      </span>
    );
  }
  if (e.kind === 'iteration') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: COLORS.text }}>
        <span style={{ color: COLORS.accent }}>iteration {e.iteration}</span>
        <span style={{ color: COLORS.textFaint }}>{age}</span>
      </span>
    );
  }
  if (e.kind === 'escalation') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: STATUS.blocked.text, fontWeight: 500 }}>
        escalated
        <span style={{ color: COLORS.textFaint, fontWeight: 400 }}>{age}</span>
      </span>
    );
  }
  return null;
}
