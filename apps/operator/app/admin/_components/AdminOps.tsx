'use client';

import { useEffect, useMemo, useState } from 'react';
import CommandCard, { type CommandSpec } from './CommandCard';
import '../admin-ops.css';

interface CommandsResponse {
  commands: CommandSpec[];
}

export default function AdminOps() {
  const [commands, setCommands] = useState<CommandSpec[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/commands')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: CommandsResponse) => { if (!cancelled) setCommands(j.commands); })
      .catch((e) => { if (!cancelled) setError(String(e?.message ?? e)); });
    return () => { cancelled = true; };
  }, []);

  const [building, running, simulators] = useMemo(() => {
    if (!commands) return [[], [], []] as [CommandSpec[], CommandSpec[], CommandSpec[]];
    return [
      commands.filter((c) => c.section === 'building'),
      commands.filter((c) => c.section === 'running'),
      commands.filter((c) => c.section === 'simulators'),
    ];
  }, [commands]);

  return (
    <div className="pc-ops-shell">
      <div className="pc-ops-body">
        <div className="pc-ops-intro">
          <p>
            Click <code>Run</code> on any card to spawn the command server-side. Output streams via SSE.
            Click <code>Stop</code> or close the panel to cancel — long-lived servers (Tauri dev, prod webapp)
            keep running after you stop the stream.
          </p>
        </div>

        {error && <div className="pc-ops-error">Failed to load commands: {error}</div>}

        <Section title="Building" entries={building} emptyHint="No building commands registered." loading={commands === null} />
        <Section title="Running" entries={running} emptyHint="No running commands registered." loading={commands === null} />
        <Section title="Simulators" entries={simulators} emptyHint="No simulator commands registered." loading={commands === null} />
      </div>
    </div>
  );
}

function Section({
  title,
  entries,
  emptyHint,
  loading,
}: {
  title: string;
  entries: CommandSpec[];
  emptyHint: string;
  loading: boolean;
}) {
  return (
    <section className="pc-ops-section">
      <h2 className="pc-ops-section-title">{title}</h2>
      {loading ? (
        <div className="pc-ops-empty">loading…</div>
      ) : entries.length === 0 ? (
        <div className="pc-ops-empty">{emptyHint}</div>
      ) : (
        <div className="pc-ops-grid">
          {entries.map((c) => (
            <CommandCard key={c.id} spec={c} />
          ))}
        </div>
      )}
    </section>
  );
}
