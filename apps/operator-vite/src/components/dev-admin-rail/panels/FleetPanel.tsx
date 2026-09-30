/**
 * Fleet / coord glance (P-008) — who's working on what right now. Reads two sync
 * queries: `dev.coordPresence` (live agents + their declared intent, with stale
 * rows summarised) and `dev.fleetGovernor` (the fleet rate/cap: in-flight vs cap
 * vs AIMD-effective concurrency). Manual refresh re-reads both.
 */
import { useMemo } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { useLexicon } from '@/lib/useLexicon';
import { PanelBar, PanelState, formatRelative } from '../panel-kit';

interface PresenceRecord {
  ownerId: string;
  ownerLabel: string;
  intent: string | null;
  currentPlanSlug: string | null;
  currentFiles?: string[] | null;
  heartbeatAt: string | number | null;
  stale: boolean;
}
interface FleetGovernor {
  fleet: { cap: number; inFlight: number; effective: number; floor: number };
}

function hbMs(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

export default function FleetPanel({ active }: { active: boolean }) {
  const t = useLexicon();
  const presence = useSyncQuery<PresenceRecord>({
    queryName: 'dev.coordPresence',
    enabled: active,
    staleTime: 8_000,
  });
  const gov = useSyncQuery<FleetGovernor>({
    queryName: 'dev.fleetGovernor',
    enabled: active,
    staleTime: 8_000,
  });

  const all = presence.data ?? [];
  const { activeAgents, staleCount } = useMemo(() => {
    const a = all.filter((r) => !r.stale).sort((x, y) => (hbMs(y.heartbeatAt) ?? 0) - (hbMs(x.heartbeatAt) ?? 0));
    return { activeAgents: a, staleCount: all.filter((r) => r.stale).length };
  }, [all]);
  const fleet = gov.data?.[0]?.fleet;

  const refresh = () => {
    presence.invalidate();
    gov.invalidate();
  };

  return (
    <div className="pcdar-panel">
      <PanelBar label={`${t('fleet')} / coord`} fetching={presence.fetching || gov.fetching} onRefresh={refresh} />
      {fleet && (
        <div className="pcdar-kv">
          <span className="pcdar-kv__k">in-flight / cap</span>
          <span className="pcdar-kv__v">
            {fleet.inFlight} / {fleet.cap}
            {fleet.effective < fleet.cap ? ` · eff ${fleet.effective}` : ''}
          </span>
          <span className="pcdar-kv__k">live agents</span>
          <span className="pcdar-kv__v">
            {activeAgents.length}
            {staleCount ? ` · ${staleCount} stale` : ''}
          </span>
        </div>
      )}
      <PanelState
        loading={presence.loading && all.length === 0}
        error={presence.error ?? gov.error}
        empty={activeAgents.length === 0}
        emptyHint="No agents active right now."
      />
      {activeAgents.map((r) => (
        <div key={r.ownerId} className="pcdar-row">
          <span className="pcdar-dot is-up" aria-hidden="true" />
          <div className="pcdar-row__main">
            <div className="pcdar-row__title" title={r.ownerId}>
              {r.ownerLabel || r.ownerId}
            </div>
            <div className="pcdar-row__sub" style={{ fontFamily: 'inherit' }} title={r.intent ?? undefined}>
              {r.intent || 'no declared intent'}
            </div>
            <div className="pcdar-row__sub">
              {r.currentPlanSlug ? `${r.currentPlanSlug} · ` : ''}
              {formatRelative(hbMs(r.heartbeatAt))}
              {r.currentFiles && r.currentFiles.length > 0 ? ` · ${r.currentFiles.length} file(s)` : ''}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
