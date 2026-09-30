/**
 * /dev — cross-harness, cross-workspace developer console.
 *
 * Three-pane shell: left rail (workspace picker + tabs), main content,
 * right rail (live state). Every tab is built on top of the
 * function-as-truth tool registry so adding a new MCP tool surfaces here
 * on next refresh without any per-tool code.
 */
'use client';

import { Suspense, useCallback, useMemo, useState } from 'react';
import { useQueryState, parseAsString, parseAsStringEnum } from 'nuqs';
import { useLexicon } from '@/lib/useLexicon';
import dynamic from '@/lib/router-compat/dynamic';
import WorkspacePicker from './_components/WorkspacePicker';
import RightRail from './_components/RightRail';

export interface RerunContext {
  toolName: string;
  workspace?: string;
  harness?: string;
  role?: string;
  run?: string;
  spawn?: string;
  /** Pre-fill the API tab form with these args (post-zod-parse JSON). */
  args?: Record<string, unknown>;
}

const ApiTab = dynamic(() => import('./_components/ApiTab'), { ssr: false });
const HarnessesTab = dynamic(() => import('./_components/HarnessesTab'), { ssr: false });
const SessionsTab = dynamic(() => import('./_components/SessionsTab'), { ssr: false });
const TelemetryTab = dynamic(() => import('./_components/TelemetryTab'), { ssr: false });
const AuditTab = dynamic(() => import('./_components/AuditTab'), { ssr: false });
const RoutesTab = dynamic(() => import('./_components/RoutesTab'), { ssr: false });
const PgTab = dynamic(() => import('./_components/PgTab'), { ssr: false });
const ProcessesTab = dynamic(() => import('./_components/ProcessesTab'), { ssr: false });
const StudioTab = dynamic(() => import('./_components/StudioTab'), { ssr: false });
const TablesTab = dynamic(() => import('./_components/TablesTab'), { ssr: false });
const SqlTab = dynamic(() => import('./_components/SqlTab'), { ssr: false });
const BackupsTab = dynamic(() => import('./_components/BackupsTab'), { ssr: false });
const TerminalTab = dynamic(() => import('./_components/TerminalTab'), { ssr: false });
const IpcTab = dynamic(() => import('./_components/IpcTab'), { ssr: false });

type TabId = 'harnesses' | 'api' | 'sessions' | 'routes' | 'telemetry' | 'audit' | 'pg' | 'processes' | 'tables' | 'sql' | 'studio' | 'backups' | 'terminal' | 'ipc';

const TAB_GROUPS: Array<{ label: string; tabs: Array<{ id: TabId; label: string; hint: string }> }> = [
  {
    label: 'Operate',
    tabs: [
      { id: 'api', label: 'API', hint: 'invoke tools' },
      // label resolved through the lexicon at render (see DevPage) → "Hives"
      { id: 'harnesses', label: 'Harnesses', hint: 'health matrix' },
      { id: 'sessions', label: 'Sessions', hint: 'spawn drilldown' },
      { id: 'routes', label: 'Routes', hint: 'HTTP traffic' },
      { id: 'telemetry', label: 'Telemetry', hint: 'latency + errors' },
      { id: 'audit', label: 'Audit', hint: 'operator log' },
    ],
  },
  {
    label: 'Data',
    tabs: [
      { id: 'tables', label: 'Tables', hint: 'schema + rows' },
      { id: 'sql', label: 'SQL', hint: 'read-only query' },
      { id: 'pg', label: 'PG', hint: 'connections' },
      { id: 'studio', label: 'Drizzle Studio', hint: 'embedded db UI' },
    ],
  },
  {
    label: 'Runtime',
    tabs: [
      { id: 'processes', label: 'Processes', hint: 'local pids' },
      { id: 'backups', label: 'Backups', hint: 'kopia + restore' },
      { id: 'terminal', label: 'Terminal', hint: 'xterm.js shell' },
      { id: 'ipc', label: 'IPC', hint: 'endpoint-IPC probe' },
    ],
  },
];

const DENSE_TABS = new Set<TabId>(['tables', 'sql', 'studio', 'backups', 'terminal']);

export default function DevPage() {
  const t = useLexicon();
  // Top-level /dev tab — URL-backed so agents can read it via ui:get_state
  // and switch panels via set_url. nuqs keeps the deep-link working
  // across reloads and lets agents navigate the dev console without
  // a per-tab tool.
  const [tab, setTab] = useQueryState(
    'tab',
    parseAsStringEnum<TabId>([
      'harnesses', 'api', 'sessions', 'routes', 'telemetry', 'audit',
      'pg', 'processes', 'tables', 'sql', 'studio', 'backups', 'terminal', 'ipc',
    ]).withDefault('api'),
  );
  // null = all workspaces; otherwise specific ids. URL-backed because it is
  // meaningful filter state for agents and deep-links.
  const [workspaceParam, setWorkspaceParam] = useQueryState(
    'devWs',
    parseAsString.withDefault('*'),
  );
  const workspaceIds = useMemo(() => {
    if (workspaceParam === '*') return null;
    if (workspaceParam === '') return [];
    return workspaceParam.split(',').map((id) => id.trim()).filter(Boolean);
  }, [workspaceParam]);
  const setWorkspaceIds = useCallback((ids: string[] | null) => {
    setWorkspaceParam(ids === null ? '*' : ids.join(','));
  }, [setWorkspaceParam]);
  const [railParam, setRailParam] = useQueryState(
    'rail',
    parseAsStringEnum<'open' | 'closed'>(['open', 'closed']),
  );
  const railOpen = (railParam ?? (DENSE_TABS.has(tab) ? 'closed' : 'open')) === 'open';
  // Set by Sessions/Telemetry "rerun" → consumed by ApiTab on mount.
  const [rerun, setRerun] = useState<RerunContext | null>(null);

  const rerunAndSwitch = useCallback((ctx: RerunContext) => {
    setRerun(ctx);
    setTab('api');
  }, [setTab]);

  return (
    <div className={`pc-dev-shell ${railOpen ? '' : 'is-rail-closed'}`}>
      <aside className="pc-dev-left">
        <div className="pc-dev-section">
          <div className="pc-dev-section-label">Workspaces</div>
          <WorkspacePicker selected={workspaceIds} onChange={setWorkspaceIds} />
        </div>
        <nav className="pc-dev-nav" aria-label="Dev page tabs">
          {TAB_GROUPS.map((group) => (
            <section key={group.label} className="pc-dev-section pc-dev-nav-group">
              <div className="pc-dev-section-label">{group.label}</div>
              {group.tabs.map((tab_) => (
                <button
                  key={tab_.id}
                  type="button"
                  className={`pc-dev-tab ${tab === tab_.id ? 'is-active' : ''}`}
                  onClick={() => setTab(tab_.id)}
                >
                  <span className="pc-dev-tab-label">
                    {tab_.id === 'harnesses' ? t('pot', { plural: true }) : tab_.label}
                  </span>
                  <span className="pc-dev-tab-hint">{tab_.hint}</span>
                </button>
              ))}
            </section>
          ))}
        </nav>
        <button
          type="button"
          className="pc-dev-rail-toggle"
          onClick={() => setRailParam(railOpen ? 'closed' : 'open')}
        >
          <span>Status rail</span>
          <strong>{railOpen ? 'open' : 'hidden'}</strong>
        </button>
      </aside>
      <main className="pc-dev-main">
        <Suspense fallback={<div className="pc-dev-loading">loading…</div>}>
          {tab === 'api' && (
            <ApiTab workspaceIds={workspaceIds} rerun={rerun} onRerunConsumed={() => setRerun(null)} />
          )}
          {tab === 'harnesses' && <HarnessesTab workspaceIds={workspaceIds} />}
          {tab === 'sessions' && <SessionsTab workspaceIds={workspaceIds} onRerun={rerunAndSwitch} />}
          {tab === 'routes' && <RoutesTab />}
          {tab === 'telemetry' && <TelemetryTab workspaceIds={workspaceIds} onRerun={rerunAndSwitch} />}
          {tab === 'audit' && <AuditTab workspaceIds={workspaceIds} />}
          {tab === 'pg' && <PgTab />}
          {tab === 'processes' && <ProcessesTab />}
          {tab === 'tables' && <TablesTab />}
          {tab === 'sql' && <SqlTab />}
          {tab === 'studio' && <StudioTab />}
          {tab === 'backups' && <BackupsTab />}
          {tab === 'terminal' && <TerminalTab />}
          {tab === 'ipc' && <IpcTab />}
        </Suspense>
      </main>
      {railOpen && (
        <aside className="pc-dev-right">
          <RightRail workspaceIds={workspaceIds} />
        </aside>
      )}
    </div>
  );
}
