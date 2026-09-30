'use client';

/**
 * /dev → Backups tab.
 *
 * Custom metric bar + kopia's web UI in an iframe + restore-to-clone
 * panel + failure log. The timeline / diff explorer / live progress
 * come for free from kopia's UI; we wrap rather than rebuild.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useQueryState, parseAsString } from 'nuqs';
import { Select } from '@/app/harness/Select';
import { useConfirmDialog } from '@/app/harness/useConfirmDialog';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import type { RepoStats, SnapshotInfo } from '@papercusp/operator-core/lib/backup';

interface ServerInfo { workspaceId: string; port: number; url: string; startedAt: string; }
interface HealthInfo {
  state: 'ok' | 'stale' | 'failing' | 'disabled' | 'never_run';
  ageSeconds: number | null;
  lastOkAt: string | null;
  lastFailureAt: string | null;
  freeDiskBytes: number | null;
  staleThresholdSec: number;
  kopia: { ok: boolean; version?: string; reason?: string };
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${u[i]}`;
}
export function fmtAgo(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

export default function BackupsTab() {
  interface EventRow { id: number; snapshotId: number | null; kind: string; payload: unknown; at: string; }
  interface Trace { command: string; exitCode: number; stdout: string; stderr: string; durationMs: number; }
  // useConfirmDialog returns { confirm, element } — alias to the local names used below.
  // (Previously destructured the wrong keys, so askConfirm was undefined → restore/delete
  // threw "askConfirm is not a function" and the dialog never rendered.)
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  const [terminal, setTerminal] = useState<Array<Trace & { startedAt: string }>>([]);
  const appendTrace = (t: Trace) =>
    setTerminal((prev) => [{ ...t, startedAt: new Date().toISOString() }, ...prev].slice(0, 50));
  const [stats, setStats] = useState<RepoStats | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([]);
  const [failures, setFailures] = useState<SnapshotInfo[]>([]);
  const [server, setServer] = useState<ServerInfo | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [brokenDirs, setBrokenDirs] = useState<{ path: string; createdAt: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [restorePick, setRestorePick] = useQueryState('backupSnapshot', parseAsString.withDefault(''));
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const load = useCallback(async () => {
    try {
      const [a, b, c, h, e, br] = await Promise.all([
        fetch('/api/backups').then((r) => r.json()),
        fetch('/api/backups/snapshots?limit=200').then((r) => r.json()),
        fetch('/api/backups/failures?limit=50').then((r) => r.json()),
        fetch('/api/backups/healthcheck').then((r) => r.json()),
        fetch('/api/backups/events?limit=100').then((r) => r.json()),
        fetch('/api/backups/broken-list').then((r) => r.json()),
      ]);
      setStats(a.stats);
      setSnapshots(b.snapshots ?? []);
      setFailures(c.failures ?? []);
      setHealth(h.error ? null : h as HealthInfo);
      setEvents(e.events ?? []);
      setBrokenDirs(br.broken ?? []);
    } catch (err) {
      toast.error(`load failed: ${(err as Error).message}`);
    }
  }, []);

  const startServer = useCallback(async () => {
    try {
      const r = await fetch('/api/backups/server');
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      const d = await r.json() as { server: ServerInfo };
      setServer(d.server);
    } catch (err) {
      toast.error(`server start: ${(err as Error).message}`);
    }
  }, []);

  useEffect(() => { load(); startServer(); }, [load, startServer]);
  useEffect(() => {
    // Documented polling exception (audit P-058): kopia server state is an
    // external process probe — no sync invalidation source. 15s while
    // visible; paused when hidden.
    const t = setInterval(() => {
      if (document.visibilityState !== 'hidden') void load();
    }, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const fire = useCallback(async (label: string, fn: () => Promise<Response>) => {
    setBusy(label);
    try {
      const r = await fn();
      const json = await r.json().catch(() => ({}));
      if (json.trace) appendTrace(json.trace as Trace);
      if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
      toast.success(`${label} ok`);
      await load();
    } catch (err) {
      toast.error(`${label} failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [load]);

  const snapshotNow = () => fire('snapshot',
    () => fetch('/api/backups/snapshots', { method: 'POST', body: JSON.stringify({ reason: 'manual' }), headers: { 'content-type': 'application/json' } }));
  const maintenanceQuick = () => fire('quick maintenance',
    () => fetch('/api/backups/maintenance', { method: 'POST', body: JSON.stringify({ level: 'quick' }), headers: { 'content-type': 'application/json' } }));
  const maintenanceFull = () => fire('full maintenance',
    () => fetch('/api/backups/maintenance', { method: 'POST', body: JSON.stringify({ level: 'full' }), headers: { 'content-type': 'application/json' } }));
  const verify = () => fire('verify',
    () => fetch('/api/backups/verify', { method: 'POST' }));

  const [lastRestoredPath, setLastRestoredPath] = useState<string | null>(null);

  const doRestore = useCallback(async () => {
    if (!restorePick) return;
    setBusy('restore');
    const start = Date.now();
    try {
      const r = await fetch('/api/backups/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kopiaSnapshotId: restorePick }),
      });
      const d = await r.json();
      if (!r.ok) {
        appendTrace({ command: `POST /api/backups/restore ${restorePick.slice(0, 12)}…`, exitCode: 1, stdout: '', stderr: d.error ?? `HTTP ${r.status}`, durationMs: Date.now() - start });
        throw new Error(d.error ?? `HTTP ${r.status}`);
      }
      appendTrace({ command: `POST /api/backups/restore ${restorePick.slice(0, 12)}…`, exitCode: 0, stdout: `restored to ${d.result.targetPath}`, stderr: '', durationMs: Date.now() - start });
      setLastRestoredPath(d.result.targetPath);
      toast.success(`restored to ${d.result.targetPath}`);
    } catch (err) {
      toast.error(`restore failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [restorePick]);

  const doPromote = useCallback(async () => {
    if (!lastRestoredPath) return;
    const ok = await askConfirm({
      title: 'Promote this restored clone to live?',
      body: `Live workspace becomes ".broken-<ts>/" alongside. Reversible: rename the .broken-* dir back if this was wrong.\n\nRestored: ${lastRestoredPath}`,
      confirmLabel: 'Promote',
      destructive: true,
    });
    if (!ok) return;
    setBusy('promote');
    const start = Date.now();
    try {
      const r = await fetch('/api/backups/promote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ restoredPath: lastRestoredPath }),
      });
      const d = await r.json();
      if (!r.ok) {
        appendTrace({ command: `POST /api/backups/promote`, exitCode: 1, stdout: '', stderr: d.error ?? `HTTP ${r.status}`, durationMs: Date.now() - start });
        throw new Error(d.error ?? `HTTP ${r.status}`);
      }
      appendTrace({ command: `POST /api/backups/promote`, exitCode: 0, stdout: `live → ${d.result.broken}\nrestored → ${d.result.live}`, stderr: '', durationMs: Date.now() - start });
      toast.success(`promoted; old live moved to ${d.result.broken}`);
      setLastRestoredPath(null);
    } catch (err) {
      toast.error(`promote failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [lastRestoredPath, askConfirm]);

  // 'degraded' is offerable: the kopia snapshot succeeded and its file tree is
  // fully restorable — only the DB dump inside it is stale
  // (EI-20109034777197353). Excluding it would withdraw every recent recovery
  // option at exactly the moment something is already wrong, which is worse
  // than restoring a tree with an old database. The option is LABELLED instead,
  // so the choice is informed rather than hidden.
  const restoreOptions = useMemo(
    () => snapshots.filter((s) => s.kopiaSnapshotId && (s.status === 'ok' || s.status === 'degraded')),
    [snapshots],
  );

  const healthBanner = health && health.state !== 'ok' && (
    <div className={`pc-dev-backups-banner pc-dev-backups-banner-${health.state}`}>
      {!health.kopia.ok && (
        <span>
          kopia binary not found ({health.kopia.reason ?? 'unknown'}). Install kopia or set <code>KOPIA_BIN</code>.
        </span>
      )}
      {health.kopia.ok && health.state === 'disabled' && 'Backups are disabled for this workspace.'}
      {health.kopia.ok && health.state === 'never_run' && 'No snapshots have run yet for this workspace.'}
      {health.kopia.ok && health.state === 'stale' && health.ageSeconds != null && `Last snapshot was ${Math.round(health.ageSeconds / 60)} min ago — stale.`}
      {health.kopia.ok && health.state === 'failing' && 'The most recent snapshot failed. Check the failure log below.'}
      {' '}
      {health.freeDiskBytes != null && health.freeDiskBytes < 20 * 1024 ** 3 && (
        <span>· Free disk on backup destination: {fmtBytes(health.freeDiskBytes)}</span>
      )}
    </div>
  );

  return (
    <div className="pc-dev-backups">
      {confirmEl}
      <header className="pc-dev-tab-header">
        <h2>Backups</h2>
        <span className="pc-dev-muted">
          kopia {server ? `:${server.port}` : 'starting'} · refreshes every 15s
        </span>
      </header>
      {healthBanner}
      <div className="pc-dev-backups-metrics">
        <Metric label="Snapshots" value={stats?.totalSnapshots.toLocaleString() ?? '—'} />
        <Metric label="On disk" value={stats ? fmtBytes(stats.bytesOnDisk) : '—'} />
        <Metric label="Raw" value={stats ? fmtBytes(stats.bytesRaw) : '—'} />
        <Metric label="Dedup" value={stats ? `${(stats.dedupRatio * 100).toFixed(0)}%` : '—'} />
        <Metric label="Last ok" value={fmtAgo(stats?.lastSnapshotAt ?? null)} />
        <Metric label="Last fail" value={fmtAgo(stats?.lastFailureAt ?? null)} highlight={!!stats?.lastFailureAt} />
      </div>

      <div className="pc-dev-backups-actions">
        <button type="button" disabled={!!busy} onClick={snapshotNow}>Snapshot now</button>
        <button type="button" disabled={!!busy} onClick={maintenanceQuick}>Quick maintenance</button>
        <button type="button" disabled={!!busy} onClick={maintenanceFull}>Full maintenance</button>
        <button type="button" disabled={!!busy} onClick={verify}>Verify</button>
        <button
          type="button"
          onClick={() => {
            const url = server?.url ?? '(not started)';
            try {
              iframeRef.current?.contentWindow?.location.reload();
              appendTrace({ command: `iframe.contentWindow.location.reload()`, exitCode: 0, stdout: `Reloaded ${url}`, stderr: '', durationMs: 0 });
            } catch (e) {
              appendTrace({ command: `iframe.contentWindow.location.reload()`, exitCode: 1, stdout: '', stderr: String(e), durationMs: 0 });
            }
          }}
        >Reload kopia UI</button>
      </div>

      <section className="pc-dev-backups-terminal">
        <header>
          <h3>Terminal — {terminal.length === 0 ? 'idle' : `last ${terminal.length} action${terminal.length === 1 ? '' : 's'}`}</h3>
          <button type="button" disabled={terminal.length === 0} onClick={() => setTerminal([])}>Clear</button>
        </header>
        <pre className="pc-dev-api-response">
          {terminal.length === 0
            ? `# Idle.\n# Click an action above; the command, exit code, stdout, and stderr appear here.\n# Each kopia invocation is captured in full (no truncation).\n$ _`
            : terminal.map((t) => [
              `[${t.startedAt.slice(11, 19)}] $ ${t.command}`,
              `  exit=${t.exitCode}  duration=${t.durationMs}ms`,
              t.stdout ? `  ── stdout ──\n${t.stdout.split('\n').map((l) => '    ' + l).join('\n')}` : '',
              t.stderr ? `  ── stderr ──\n${t.stderr.split('\n').map((l) => '    ' + l).join('\n')}` : '',
              '',
            ].filter(Boolean).join('\n')).join('\n')}
        </pre>
      </section>

      {server && (
        <iframe
          ref={iframeRef}
          className="pc-dev-backups-iframe"
          src={server.url}
          title="kopia"
        />
      )}

      <section className="pc-dev-backups-restore">
        <h3>Restore (to clone, never overwrites)</h3>
        <Select
          value={restorePick === '' ? '_unset' : restorePick}
          onChange={(v) => setRestorePick(v === '_unset' ? '' : v)}
          ariaLabel="Snapshot to restore from"
          options={[
            { value: '_unset', label: '— pick a snapshot —' },
            ...restoreOptions.map((s) => ({
              value: s.kopiaSnapshotId ?? '',
              label: `${s.startedAt.replace('T', ' ').slice(0, 19)} · ${s.triggerReason} · ${fmtBytes(s.bytesAdded ?? 0)}${s.status === 'degraded' ? ' · ⚠ STALE DB DUMP' : ''}`,
            })),
          ]}
        />
        <div className="pc-dev-backups-actions">
          <button type="button" disabled={!restorePick || busy === 'restore'} onClick={doRestore}>
            {busy === 'restore' ? 'Restoring…' : 'Restore to clone'}
          </button>
          {lastRestoredPath && (
            <button type="button" disabled={busy === 'promote'} onClick={doPromote}>
              {busy === 'promote' ? 'Promoting…' : `Promote → live`}
            </button>
          )}
        </div>
        {lastRestoredPath && (
          <p className="pc-dev-backups-note">
            Last restored: <code>{lastRestoredPath}</code>
          </p>
        )}
        <p className="pc-dev-backups-note">
          Restores into <code>&lt;workspace&gt;/.restored/&lt;snapshot-id&gt;/</code>.
          Live workspace is untouched until you explicitly promote — at which
          point the current live becomes <code>.broken-&lt;ts&gt;/</code>, reversible
          by renaming back.
        </p>
      </section>

      {failures.length > 0 && (
        <section className="pc-dev-backups-failures">
          <h3>Recent failures ({failures.length})</h3>
          <ul>
            {failures.map((f) => (
              <li key={f.id}>
                <strong>{f.startedAt.replace('T', ' ').slice(0, 19)}</strong>
                {' · '}
                {f.triggerReason}
                {f.error && <pre>{f.error}</pre>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {brokenDirs.length > 0 && (
        <section className="pc-dev-backups-restore">
          <h3>Rollback recent promotions</h3>
          {brokenDirs.map((b) => (
            <div key={b.path} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
              <code style={{ flex: 1, fontSize: 12 }}>{b.path}</code>
              <button
                type="button"
                disabled={busy === `rollback:${b.path}`}
                onClick={async () => {
                  const ok = await askConfirm({
                    title: 'Rollback this promotion?',
                    body: `Current live becomes .rolled-back-<ts>-<name>/. Reversible.\n\n${b.path}`,
                    confirmLabel: 'Rollback',
                    destructive: true,
                  });
                  if (!ok) return;
                  setBusy(`rollback:${b.path}`);
                  const start = Date.now();
                  try {
                    const r = await fetch('/api/backups/rollback', {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ brokenPath: b.path }),
                    });
                    const d = await r.json();
                    if (!r.ok) {
                      appendTrace({ command: `POST /api/backups/rollback`, exitCode: 1, stdout: '', stderr: d.error ?? `HTTP ${r.status}`, durationMs: Date.now() - start });
                      throw new Error(d.error ?? `HTTP ${r.status}`);
                    }
                    appendTrace({ command: `POST /api/backups/rollback`, exitCode: 0, stdout: `live → ${d.result.liveBefore}\nbroken restored → ${d.result.liveAfter}`, stderr: '', durationMs: Date.now() - start });
                    toast.success('rolled back');
                    await load();
                  } catch (err) {
                    toast.error(`rollback failed: ${(err as Error).message}`);
                  } finally {
                    setBusy(null);
                  }
                }}
              >Rollback</button>
            </div>
          ))}
        </section>
      )}

      {events.length > 0 && (
        <section className="pc-dev-backups-events">
          <h3>Event log ({events.length})</h3>
          <div style={{ height: Math.min(360, 32 + events.length * 28 + 4) }}>
            <RichGrid<EventRow>
              columns={[
                { key: 'time', header: 'Time', width: 1, toCopyText: (r) => r.at, render: ({ row }) => <>{row.at.replace('T', ' ').slice(11, 19)}</> },
                { key: 'snap', header: 'Snapshot', width: 1, toCopyText: (r) => r.snapshotId != null ? String(r.snapshotId) : '', render: ({ row }) => <>{row.snapshotId ?? '—'}</> },
                { key: 'kind', header: 'Kind', width: 1, toCopyText: (r) => r.kind, render: ({ row }) => <>{row.kind}</> },
                { key: 'payload', header: 'Payload', width: 4, toCopyText: (r) => JSON.stringify(r.payload), render: ({ row }) => <code>{JSON.stringify(row.payload)}</code> },
              ]}
              rows={events}
              getRowId={(r) => String(r.id)}
              rowMinHeight={28}
              headerHeight={32}
            />
          </div>
        </section>
      )}
    </div>
  );
}

function Metric({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`pc-dev-backups-metric${highlight ? ' pc-dev-backups-metric-highlight' : ''}`}>
      <span className="pc-dev-backups-metric-label">{label}</span>
      <span className="pc-dev-backups-metric-value">{value}</span>
    </div>
  );
}
