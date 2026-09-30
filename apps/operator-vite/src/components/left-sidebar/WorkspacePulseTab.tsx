import { useMemo } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { Activity, Bot, ChevronRight, HeartPulse, Workflow } from 'lucide-react';
import type { SystemHealth } from '@papercusp/operator-core/lib/system-health/types';
import { advRosterArgs } from '@/lib/adv-roster-args';
import AskAgentPane from './AskAgentPane';
import PotFederationStatus from './PotFederationStatus';
import PotPeerRoster from './PotPeerRoster';

interface PulseAgent {
  ownerId: string;
  label: string;
  intent: string;
  sessionState?: string | null;
}

interface PulseRoster {
  active: PulseAgent[];
}

export default function WorkspacePulseTab({ active }: { active: boolean }) {
  const [, setTab] = useQueryState('tab', parseAsString);
  const rosterQuery = useSyncQuery<PulseRoster>({
    queryName: 'advRoster.list',
    args: advRosterArgs(null),
    enabled: active,
    pollIntervalMs: 5_000,
  });
  const healthQuery = useSyncQuery<SystemHealth>({
    queryName: 'health.snapshot',
    args: {},
    enabled: active,
    staleTime: 15_000,
  });
  const liveAgents = useMemo(
    () => (rosterQuery.data?.[0]?.active ?? []).filter((agent) => agent.sessionState === 'live'),
    [rosterQuery.data],
  );
  const health = healthQuery.data?.[0] ?? null;
  const warnings = health
    ? Object.values(health.panels).filter((panel) => !panel.ack && (panel.status === 'warn' || panel.status === 'crit'))
    : [];

  return (
    <div className="pclsb-pulse" data-testid="left-sidebar-pulse">
      <header>
        <div><span>Workspace pulse</span><strong>What needs attention now</strong></div>
        <Activity size={17} aria-hidden />
      </header>

      <div className="pclsb-pulse__shortcuts">
        <button type="button" onClick={() => void setTab('hud')}>
          <span className="pclsb-pulse__shortcut-layout">
            <Bot size={15} aria-hidden />
            <span><small>Live agents</small><strong>{liveAgents.length} running</strong><em>Open HUD</em></span>
            <ChevronRight size={13} aria-hidden />
          </span>
        </button>
        <button type="button" onClick={() => void setTab('health')}>
          <span className="pclsb-pulse__shortcut-layout">
            <HeartPulse size={15} aria-hidden />
            <span><small>System health</small><strong>{warnings.length === 0 ? 'All clear' : `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`}</strong><em>Open Health</em></span>
            <ChevronRight size={13} aria-hidden />
          </span>
        </button>
      </div>

      <AskAgentPane active={active} />

      <section>
        <div className="pclsb-pulse__section-head"><strong>Live work</strong><span>{liveAgents.length}</span></div>
        {liveAgents.slice(0, 5).map((agent) => (
          <button className="pclsb-pulse__attention" type="button" key={agent.ownerId} onClick={() => void setTab('hud')}>
            <span className="pclsb-pulse__attention-layout">
              <i data-tone="live" aria-hidden />
              <span><strong>{agent.label || agent.ownerId}</strong><small>{agent.intent || 'Working'}</small></span>
              <em>live</em>
            </span>
          </button>
        ))}
        {liveAgents.length === 0 ? <p>No agents are running right now.</p> : null}
      </section>

      <section>
        <div className="pclsb-pulse__section-head"><strong>Health attention</strong><span>{warnings.length}</span></div>
        {warnings.slice(0, 4).map((panel) => (
          <button className="pclsb-pulse__attention" type="button" key={panel.key} onClick={() => void setTab('health')}>
            <span className="pclsb-pulse__attention-layout">
              <i data-tone={panel.status} aria-hidden />
              <span><strong>{panel.label}</strong><small>{panel.summary}</small></span>
              <em>{panel.status}</em>
            </span>
          </button>
        ))}
        {health && warnings.length === 0 ? <p>No system warnings need attention.</p> : null}
        {!health ? <p>{healthQuery.loading ? 'Checking system health…' : 'System health unavailable.'}</p> : null}
      </section>

      <PotFederationStatus collapsible />
      <PotPeerRoster />

      <div className="pclsb-pulse__rule">
        <strong>No automation catalog lives here.</strong>
        <span>Schedules, controls, sources, run history, and spend are consolidated in the full-width Workflows tab.</span>
      </div>
      <button className="pclsb-pulse__open" type="button" onClick={() => void setTab('workflows')}>
        <span className="pclsb-pulse__open-layout"><Workflow size={14} aria-hidden /> Open Workflows <ChevronRight size={13} aria-hidden /></span>
      </button>
      <style>{PULSE_CSS}</style>
    </div>
  );
}

const PULSE_CSS = `
  .pclsb-pulse { min-height: 100%; padding: 11px; color: var(--fg); background: var(--bg); }
  .pclsb-pulse > header { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:3px 2px 11px; border-bottom:1px solid var(--border); color:var(--accent); }
  .pclsb-pulse > header span, .pclsb-pulse > header strong { display:block; }
  .pclsb-pulse > header span { color:var(--fg-mute); font-size:9px; text-transform:uppercase; }
  .pclsb-pulse > header strong { margin-top:3px; color:var(--fg); font-size:12px; }
  .pclsb-pulse__shortcuts { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin:10px 0; }
  .pclsb-pulse__shortcuts button { display:block; min-width:0; padding:9px 7px; border:1px solid var(--border); border-radius:8px; color:var(--fg); text-align:left; background:var(--bg-raised); cursor:pointer; }
  .pclsb-pulse__shortcut-layout { display:grid; grid-template-columns:18px minmax(0,1fr) 12px; gap:6px; align-items:center; min-width:0; }
  .pclsb-pulse__shortcuts button:hover { border-color:color-mix(in srgb,var(--accent),transparent 48%); }
  .pclsb-pulse__shortcut-layout > svg:first-child { color:var(--accent); }
  .pclsb-pulse__shortcuts span { min-width:0; }
  .pclsb-pulse__shortcuts small, .pclsb-pulse__shortcuts strong, .pclsb-pulse__shortcuts em { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .pclsb-pulse__shortcuts small { color:var(--fg-mute); font-size:7px; text-transform:uppercase; }
  .pclsb-pulse__shortcuts strong { margin-top:3px; font-size:10px; }
  .pclsb-pulse__shortcuts em { margin-top:4px; color:var(--accent); font-size:7px; font-style:normal; }
  .pclsb-pulse section { margin-top:12px; }
  .pclsb-pulse__section-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:5px; color:var(--fg-mute); font-size:8px; text-transform:uppercase; }
  .pclsb-pulse__section-head span { padding:1px 5px; border-radius:999px; background:color-mix(in srgb,var(--fg),transparent 91%); }
  .pclsb-pulse__attention { display:block; width:100%; margin-top:5px; padding:8px; border:1px solid var(--border); border-radius:7px; color:var(--fg); text-align:left; background:var(--bg-raised); cursor:pointer; }
  .pclsb-pulse__attention-layout { display:grid; grid-template-columns:7px minmax(0,1fr) auto; gap:7px; align-items:center; width:100%; }
  .pclsb-pulse__attention:hover { border-color:color-mix(in srgb,var(--accent),transparent 52%); }
  .pclsb-pulse__attention i { width:6px; height:6px; border-radius:50%; background:var(--good); }
  .pclsb-pulse__attention i[data-tone='warn'] { background:var(--warn); }
  .pclsb-pulse__attention i[data-tone='crit'] { background:var(--bad); }
  .pclsb-pulse__attention span { min-width:0; }
  .pclsb-pulse__attention strong, .pclsb-pulse__attention small { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .pclsb-pulse__attention strong { font-size:9px; }
  .pclsb-pulse__attention small { margin-top:2px; color:var(--fg-mute); font-size:7px; }
  .pclsb-pulse__attention em { color:var(--fg-mute); font-size:7px; font-style:normal; text-transform:uppercase; }
  .pclsb-pulse section > p { margin:5px 0 0; padding:10px 8px; border:1px dashed var(--border); border-radius:7px; color:var(--fg-mute); font-size:8px; text-align:center; }
  .pclsb-pulse__rule { margin-top:12px; padding:9px; border:1px dashed var(--border); border-radius:8px; color:var(--fg-mute); font-size:8px; line-height:1.4; }
  .pclsb-pulse__rule strong, .pclsb-pulse__rule span { display:block; }
  .pclsb-pulse__rule strong { margin-bottom:3px; color:var(--fg-dim); }
  .pclsb-pulse__open { display:block; width:100%; margin-top:8px; padding:8px; border:1px solid color-mix(in srgb,var(--accent),transparent 50%); border-radius:8px; color:var(--accent); background:color-mix(in srgb,var(--accent),transparent 93%); font-size:9px; font-weight:750; cursor:pointer; }
  .pclsb-pulse__open-layout { display:inline-flex; align-items:center; justify-content:center; gap:6px; width:100%; }
  .pclsb-pulse__open:hover { background:color-mix(in srgb,var(--accent),transparent 88%); }
`;
