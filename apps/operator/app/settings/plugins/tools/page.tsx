/**
 * Settings → Plugins → Tools
 *
 * Read-only surface listing every tool currently registered in the
 * projected-tool registry. Grouped by plugin. Shows MCP name + HTTP path
 * + capabilities + roles + per-role quota + last-24h invocation count.
 *
 * Backed by `GET /api/plugins/tools?stats=true`.
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md.
 */
'use client';

import { useEffect, useMemo, useState } from 'react';

interface ToolRow {
  name: string;
  pluginName: string;
  description: string;
  capabilities: string[];
  roles?: string[];
  rolesQuota?: Record<string, { perChunk?: number; perRun?: number; perDay?: number }>;
  timeoutSec?: number;
  expose: {
    http?: { path: string; methods?: string[] };
    mcp?: { name: string; streaming?: boolean; largeOutput?: boolean };
  };
  recentInvocations?: number;
  recentErrors?: number;
}

export default function PluginToolsPage(): React.JSX.Element {
  const [tools, setTools] = useState<ToolRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    fetch('/api/plugins/tools?stats=true', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (!d.tools) throw new Error('unexpected response shape');
        setTools(d.tools as ToolRow[]);
      })
      .catch((e) => setError(e?.message ?? String(e)));
  }, []);

  const grouped = useMemo(() => {
    if (!tools) return null;
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? tools.filter(
          (t) =>
            t.name.toLowerCase().includes(q) ||
            t.pluginName.toLowerCase().includes(q) ||
            (t.description ?? '').toLowerCase().includes(q),
        )
      : tools;
    const byPlugin = new Map<string, ToolRow[]>();
    for (const t of filtered) {
      const arr = byPlugin.get(t.pluginName) ?? [];
      arr.push(t);
      byPlugin.set(t.pluginName, arr);
    }
    return Array.from(byPlugin.entries()).sort((a, b) => {
      // Built-ins first
      if (a[0] === 'agent-mcp' && b[0] !== 'agent-mcp') return -1;
      if (b[0] === 'agent-mcp' && a[0] !== 'agent-mcp') return 1;
      return a[0].localeCompare(b[0]);
    });
  }, [tools, filter]);

  return (
    <div>
      <h1>Plugin tools</h1>
      <p className="pc-settings-intro">
        Every tool currently registered in the projected-tool registry — both
        built-in agent-mcp tools and plugin-contributed tools. Each is callable
        on both transports (HTTP at the listed path, MCP under the listed name).
      </p>

      <div style={{ margin: '16px 0' }}>
        <input
          type="search"
          placeholder="Filter by name, plugin, or description…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ width: '100%', maxWidth: 480 }}
        />
      </div>

      {error && (
        <div className="pc-warn" role="alert">
          Failed to load tools: {error}
        </div>
      )}
      {!tools && !error && <div style={{ color: 'var(--fg-mute)' }}>Loading…</div>}

      {grouped && grouped.length === 0 && (
        <div style={{ color: 'var(--fg-mute)', fontStyle: 'italic' }}>
          No tools match the filter.
        </div>
      )}

      {grouped?.map(([pluginName, pluginTools]) => (
        <section key={pluginName} style={{ marginBottom: 32 }}>
          <h2>
            {pluginName === 'agent-mcp' ? 'Built-in (agent-mcp)' : pluginName}
            <span style={{ marginLeft: 8, color: 'var(--fg-mute)', fontSize: 12, fontWeight: 'normal' }}>
              {pluginTools.length} {pluginTools.length === 1 ? 'tool' : 'tools'}
            </span>
          </h2>
          <div style={{ display: 'grid', gap: 12 }}>
            {pluginTools.map((t) => (
              <ToolCard key={t.name} tool={t} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ToolCard({ tool: t }: { tool: ToolRow }): React.JSX.Element {
  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 6, padding: 12,
      background: 'var(--bg-2)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <code style={{ fontSize: 14, fontWeight: 600 }}>{t.name}</code>
        {(t.recentInvocations !== undefined || t.recentErrors !== undefined) && (
          <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>
            {t.recentInvocations ?? 0} ok
            {t.recentErrors ? ` · ${t.recentErrors} err` : ''} (24h)
          </span>
        )}
      </div>
      <div style={{ marginTop: 4, fontSize: 12, color: 'var(--fg-dim)' }}>
        {t.description}
      </div>
      <div style={{ marginTop: 8, display: 'grid', gap: 4, fontSize: 11, color: 'var(--fg-mute)' }}>
        {t.expose.http && (
          <Row label="HTTP">
            <code>{(t.expose.http.methods ?? ['POST']).join(', ')} {t.expose.http.path}</code>
          </Row>
        )}
        {t.expose.mcp && (
          <Row label="MCP">
            <code>{t.expose.mcp.name}</code>
            {t.expose.mcp.streaming && <Badge>streaming</Badge>}
            {t.expose.mcp.largeOutput && <Badge>large-output</Badge>}
          </Row>
        )}
        {t.capabilities.length > 0 && (
          <Row label="capabilities">
            {t.capabilities.map((c) => <Badge key={c}>{c}</Badge>)}
          </Row>
        )}
        {t.roles && t.roles.length > 0 && (
          <Row label="roles">
            {t.roles.map((r) => (
              <Badge key={r}>
                {r}
                {t.rolesQuota?.[r] && ` (${quotaSummary(t.rolesQuota[r])})`}
              </Badge>
            ))}
          </Row>
        )}
        {t.timeoutSec !== undefined && (
          <Row label="timeout">{t.timeoutSec}s</Row>
        )}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ minWidth: 90, color: 'var(--fg-mute)' }}>{label}:</span>
      <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'baseline' }}>
        {children}
      </span>
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span style={{
      padding: '1px 6px',
      border: '1px solid var(--border)',
      borderRadius: 3,
      background: 'var(--bg)',
      fontSize: 10,
      fontFamily: 'var(--font-mono, monospace)',
    }}>
      {children}
    </span>
  );
}

function quotaSummary(q: { perChunk?: number; perRun?: number; perDay?: number }): string {
  const parts: string[] = [];
  if (q.perChunk !== undefined) parts.push(`${q.perChunk}/chunk`);
  if (q.perRun !== undefined) parts.push(`${q.perRun}/run`);
  if (q.perDay !== undefined) parts.push(`${q.perDay}/day`);
  return parts.join(', ');
}
