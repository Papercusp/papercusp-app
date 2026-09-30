'use client';

import { useEffect, useState } from 'react';

interface Props {
  workspaceIds: string[] | null;
}

interface PluginHost {
  loaded?: number;
  errors?: number;
}

interface PgHealth {
  totalConnections: number;
  activeConnections: number;
  idleConnections: number;
}

interface BuildInfo {
  prodBuild: { exists: boolean; mtimeMs: number | null };
  prodLogTail: string | null;
  dev3055Reachable: boolean;
  prod3070Reachable: boolean;
}

interface ActivityEntry {
  id: string;
  workspace_id: string;
  harness_slug: string | null;
  tool_name: string;
  role: string | null;
  invoked_at: string;
  duration_ms: number | null;
  status: string;
}

export function fmtRel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

export function fmtRelMs(ms: number | null): string {
  if (ms == null) return '—';
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

const CTX = new URLSearchParams({
  workspace: 'default',
  role: 'architect',
  run: 'dev-page',
  spawn: 'dev-page',
});

async function postTool<T>(name: string, body: unknown): Promise<T | null> {
  try {
    const r = await fetch(`/api/agent-tools/dev/${name}?${CTX}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return JSON.parse(d.content[0].text);
  } catch {
    return null;
  }
}

export default function RightRail({ workspaceIds }: Props) {
  const [pluginHost, setPluginHost] = useState<PluginHost | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [pg, setPg] = useState<PgHealth | null>(null);
  const [build, setBuild] = useState<BuildInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    function refresh() {
      fetch('/api/plugins/host/refresh', { method: 'POST' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (cancelled || !d) return;
          setPluginHost(d.status ?? null);
        })
        .catch(() => {});
      postTool<{ entries: ActivityEntry[] }>('activity', { workspaceIds, limit: 30 }).then((d) => {
        if (cancelled || !d) return;
        setActivity(d.entries ?? []);
      });
      postTool<PgHealth>('pg_health', {}).then((d) => {
        if (cancelled || !d) return;
        setPg(d);
      });
      postTool<BuildInfo>('build_status', {}).then((d) => {
        if (cancelled || !d) return;
        setBuild(d);
      });
    }
    refresh();
    // Documented polling exception (audit P-058): plugin-host status, recent
    // activity, pg health and build status are live probes with no sync
    // invalidation source. 15s while visible; paused when hidden.
    const t = setInterval(() => {
      if (document.visibilityState !== 'hidden') refresh();
    }, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [workspaceIds]);

  return (
    <div className="pc-dev-rail-content">
      <section className="pc-dev-rail-block">
        <h3 className="pc-dev-rail-h">Plugin host</h3>
        {!pluginHost && <div className="pc-dev-muted">…</div>}
        {pluginHost && (
          <div className="pc-dev-rail-stats">
            <div>
              <span className="pc-dev-muted">loaded</span>
              <strong>{pluginHost.loaded ?? 0}</strong>
            </div>
            <div>
              <span className="pc-dev-muted">errors</span>
              <strong className={pluginHost.errors ? 'pc-dev-api-err' : ''}>
                {pluginHost.errors ?? 0}
              </strong>
            </div>
          </div>
        )}
      </section>

      <section className="pc-dev-rail-block">
        <h3 className="pc-dev-rail-h">Postgres</h3>
        {!pg && <div className="pc-dev-muted">…</div>}
        {pg && (
          <div className="pc-dev-rail-stats">
            <div>
              <span className="pc-dev-muted">total</span>
              <strong>{pg.totalConnections}</strong>
            </div>
            <div>
              <span className="pc-dev-muted">active</span>
              <strong>{pg.activeConnections}</strong>
            </div>
            <div>
              <span className="pc-dev-muted">idle</span>
              <strong className="pc-dev-muted">{pg.idleConnections}</strong>
            </div>
          </div>
        )}
      </section>

      <section className="pc-dev-rail-block">
        <h3 className="pc-dev-rail-h">Build</h3>
        {!build && <div className="pc-dev-muted">…</div>}
        {build && (
          <div className="pc-dev-build">
            <div>
              <span className="pc-dev-muted">prod build</span>
              <strong className={build.prodBuild.exists ? 'pc-dev-ok' : 'pc-dev-api-err'}>
                {build.prodBuild.exists ? fmtRelMs(build.prodBuild.mtimeMs) : 'missing'}
              </strong>
            </div>
            <div>
              <span className="pc-dev-muted">:3070</span>
              <strong className={build.prod3070Reachable ? 'pc-dev-ok' : 'pc-dev-api-err'}>
                {build.prod3070Reachable ? 'up' : 'down'}
              </strong>
            </div>
          </div>
        )}
      </section>

      <section className="pc-dev-rail-block">
        <h3 className="pc-dev-rail-h">Activity</h3>
        {activity.length === 0 && <div className="pc-dev-muted">no recent activity</div>}
        <ul className="pc-dev-activity">
          {activity.map((e) => (
            <li key={e.id} className="pc-dev-activity-row">
              <div className="pc-dev-activity-name">
                <span className={e.status !== 'ok' ? 'pc-dev-api-err' : ''}>
                  {e.tool_name}
                </span>
                <span className="pc-dev-activity-age">{fmtRel(e.invoked_at)}</span>
              </div>
              <div className="pc-dev-activity-meta">
                {e.harness_slug ?? e.workspace_id}
                {e.role && <> · {e.role}</>}
                {e.duration_ms != null && (
                  <> · {e.duration_ms < 1000 ? `${e.duration_ms}ms` : `${(e.duration_ms / 1000).toFixed(1)}s`}</>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
