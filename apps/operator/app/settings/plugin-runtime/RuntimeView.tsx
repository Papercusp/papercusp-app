'use client';


import { Button } from '@/app/harness/Button';
import { Tooltip } from '@/app/harness/Tooltip';
import { useState } from 'react';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';

interface RuntimeStatus {
  loaded: number;
  errors: number;
  reactionRules: { id: string; on: string | string[]; fire: string; plugin: string }[];
  plugins: { name: string; version: string; source: string }[];
  loadErrors: { error: string | object; path: string }[];
  initializedPairs: string[];
  registeredActions: { key: string; declared: string[]; registered: string[] }[];
}

type Plugin = RuntimeStatus['plugins'][number];
type Action = RuntimeStatus['registeredActions'][number];
type ReactionRule = RuntimeStatus['reactionRules'][number];

const PLUGIN_COLUMNS: ColumnDef<Plugin>[] = [
  { key: 'name', header: 'Name', width: 2, toCopyText: (r) => r.name, render: ({ row }) => <span style={{ fontFamily: 'var(--font-mono)' }}>{row.name}</span> },
  { key: 'version', header: 'Version', width: 1, toCopyText: (r) => r.version, render: ({ row }) => <>{row.version}</> },
  { key: 'source', header: 'Source', width: 2, toCopyText: (r) => r.source, render: ({ row }) => <>{row.source}</> },
];

const ACTION_COLUMNS: ColumnDef<Action>[] = [
  { key: 'key', header: 'Plugin :: Harness', width: 2, toCopyText: (r) => r.key, render: ({ row }) => <span style={{ fontFamily: 'var(--font-mono)' }}>{row.key}</span> },
  {
    key: 'declared', header: 'Declared', width: 2,
    toCopyText: (r) => r.declared.join(', '),
    render: ({ row }) => row.declared.length ? <span style={{ fontFamily: 'var(--font-mono)' }}>{row.declared.join(', ')}</span> : <span style={{ color: 'var(--fg-mute)' }}>—</span>,
  },
  {
    key: 'registered', header: 'Registered', width: 2,
    toCopyText: (r) => r.registered.join(', '),
    render: ({ row }) => row.registered.length ? <span style={{ fontFamily: 'var(--font-mono)' }}>{row.registered.join(', ')}</span> : <span style={{ color: 'var(--fg-mute)' }}>—</span>,
  },
];

export const onText = (on: string | string[]): string => (Array.isArray(on) ? on.join(', ') : on);
const REACTION_COLUMNS: ColumnDef<ReactionRule>[] = [
  { key: 'on', header: 'On', width: 2, toCopyText: (r) => onText(r.on), render: ({ row }) => <span style={{ fontFamily: 'var(--font-mono)' }}>{onText(row.on)}</span> },
  { key: 'fire', header: 'Fires', width: 2, toCopyText: (r) => r.fire, render: ({ row }) => <span style={{ fontFamily: 'var(--font-mono)' }}>{row.fire}</span> },
  { key: 'plugin', header: 'Plugin', width: 2, toCopyText: (r) => r.plugin, render: ({ row }) => <span style={{ fontFamily: 'var(--font-mono)' }}>{row.plugin}</span> },
];

export default function RuntimeView({ status: initial }: { status: RuntimeStatus }) {
  const [status, setStatus] = useState(initial);
  const [resetting, setResetting] = useState(false);

  async function reset() {
    setResetting(true);
    try {
      const r = await fetch('/api/plugins/runtime/status?reset=1', { cache: 'no-store' });
      if (r.ok) setStatus(await r.json());
    } finally {
      setResetting(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Stat label="Loaded" value={status.loaded} />
        <Stat label="Load errors" value={status.errors} bad={status.errors > 0} />
        <Stat label="Initialized pairs" value={status.initializedPairs.length} />
        <Tooltip label="Drop the cache; the next request rediscovers."><Button
          size="lg"
          variant="accent"
          onClick={reset}
          disabled={resetting}
          style={{ marginLeft: 'auto' }}
        >
          {resetting ? 'Resetting…' : 'Reset cache'}
        </Button></Tooltip>
      </div>

      <Card title={`Loaded plugins (${status.plugins.length})`}>
        {status.plugins.length === 0 ? (
          <Empty>No plugins loaded.</Empty>
        ) : (
          <div style={{ height: Math.min(360, 36 + status.plugins.length * 28 + 4) }}>
            <RichGrid<Plugin> columns={PLUGIN_COLUMNS} rows={status.plugins} getRowId={(r) => r.name} rowMinHeight={28} headerHeight={28} />
          </div>
        )}
      </Card>

      <Card title={`Initialized (plugin, harness) pairs — ${status.initializedPairs.length}`}>
        {status.initializedPairs.length === 0 ? (
          <Empty>No (plugin, harness) pair has been initialized yet. The next lifecycle fire will warm them up.</Empty>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 20, fontFamily: 'var(--font-mono)', fontSize: 13 }}>
            {status.initializedPairs.map((k) => <li key={k}>{k}</li>)}
          </ul>
        )}
      </Card>

      <Card title={`Registered actions — ${status.registeredActions.length}`}>
        {status.registeredActions.length === 0 ? (
          <Empty>No action registries built yet (plugins haven&apos;t been initialized for any harness).</Empty>
        ) : (
          <div style={{ height: Math.min(360, 36 + status.registeredActions.length * 28 + 4) }}>
            <RichGrid<Action>
              columns={ACTION_COLUMNS}
              rows={status.registeredActions}
              getRowId={(r) => r.key}
              rowMinHeight={28}
              headerHeight={28}
              getRowBg={(row) => row.declared.length !== row.registered.length ? 'var(--warn-bg, transparent)' : undefined}
            />
          </div>
        )}
      </Card>

      <Card title={`Reaction rules — ${(status.reactionRules ?? []).length}`}>
        {(status.reactionRules ?? []).length === 0 ? (
          <Empty>No plugin has contributed event-reaction rules (<code>reactions</code> in the manifest or plugin export).</Empty>
        ) : (
          <div style={{ height: Math.min(360, 36 + status.reactionRules.length * 28 + 4) }}>
            <RichGrid<ReactionRule>
              columns={REACTION_COLUMNS}
              rows={status.reactionRules}
              getRowId={(r) => r.id}
              rowMinHeight={28}
              headerHeight={28}
            />
          </div>
        )}
      </Card>

      <Card title={`Load errors — ${status.loadErrors.length}`} variant={status.loadErrors.length > 0 ? 'warn' : 'default'}>
        {status.loadErrors.length === 0 ? (
          <Empty>None.</Empty>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13 }}>
            {status.loadErrors.map((e, i) => {
              const errStr = typeof e.error === 'string' ? e.error : JSON.stringify(e.error);
              return (
                <li key={i} style={{ marginBottom: 6 }}>
                  <code style={{ fontSize: 12 }}>{e.path.split('global-plugins/').slice(-1)[0]}</code>
                  <div style={{ color: 'var(--fg-mute)', fontSize: 12, marginTop: 2 }}>{errStr.slice(0, 240)}</div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Stat({ label, value, bad }: { label: string; value: number; bad?: boolean }) {
  return (
    <div className="pc-card" style={{ padding: '8px 16px', minWidth: 110 }}>
      <div style={{ fontSize: 11, color: 'var(--fg-mute)' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color: bad ? 'var(--bad)' : 'var(--fg)' }}>{value}</div>
    </div>
  );
}

function Card({ title, children, variant }: { title: string; children: React.ReactNode; variant?: 'default' | 'warn' }) {
  return (
    <section
      className="pc-card"
      style={{
        padding: 16,
        borderColor: variant === 'warn' ? 'var(--bad)' : undefined,
      }}
    >
      <h3 style={{ margin: '0 0 8px 0', fontSize: 14 }}>{title}</h3>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ color: 'var(--fg-mute)', fontSize: 13 }}>{children}</div>;
}


