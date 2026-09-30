'use client';

/**
 * Backups settings — per-workspace kopia repo configuration.
 * Mirrors the conventions of /settings/agent + /settings/omp.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Checkbox } from '../../harness/Checkbox';
import { Select } from '../../harness/Select';
import { useLexicon } from '@/lib/useLexicon';
import type {
  BackupSettings,
  CadenceMode,
  RepoStats,
  RetentionPolicy,
  RetentionPreset,
  SnapshotTriggerReason,
} from '@papercusp/operator-core/lib/backup';

const RETENTION_PRESETS: Record<Exclude<RetentionPreset, 'custom'>, RetentionPolicy> = {
  aggressive:   { keepLatest: 10,  keepHourly: 24, keepDaily: 7,  keepWeekly: 4,  keepMonthly: 3  },
  default:      { keepLatest: 24,  keepHourly: 48, keepDaily: 30, keepWeekly: 12, keepMonthly: 12 },
  conservative: { keepLatest: 100, keepHourly: 96, keepDaily: 90, keepWeekly: 26, keepMonthly: 36 },
};

// `post_run`'s label names the project-level unit, so it is resolved through
// the lexicon at render (see `triggerLabel` below) rather than baked in here.
const TRIGGER_LABELS: Record<SnapshotTriggerReason, string> = {
  manual:           'Manual snapshots',
  interval:         'Interval timer',
  pre_destructive:  'Before agent destructive ops',
  post_run:         'After each run',
  plugin_install:   'After plugin install',
  secret_change:    'After secret change',
  startup:          'On operator startup',
};

const TRIGGER_CHECKBOXES: SnapshotTriggerReason[] = [
  'pre_destructive', 'post_run', 'plugin_install', 'secret_change',
];

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}

function fmtAgo(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

interface HealthInfo {
  state: 'ok' | 'stale' | 'failing' | 'disabled' | 'never_run';
  ageSeconds: number | null;
  kopia: { ok: boolean; version?: string; reason?: string };
}

export default function BackupsSettingsPage() {
  const lex = useLexicon();
  // Resolve trigger labels at render so `post_run` can name the project unit
  // through the lexicon (the rest are static, from TRIGGER_LABELS).
  const triggerLabel = (reason: SnapshotTriggerReason): string =>
    reason === 'post_run'
      ? `After each ${lex('pot', { lower: true })} run`
      : TRIGGER_LABELS[reason];
  const [settings, setSettings] = useState<BackupSettings | null>(null);
  const [stats, setStats] = useState<RepoStats | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [snapshotting, setSnapshotting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [a, h] = await Promise.all([
        fetch('/api/backups').then((r) => r.json()),
        fetch('/api/backups/healthcheck').then((r) => r.json()),
      ]);
      setSettings(a.settings);
      setStats(a.stats);
      setHealth(h.error ? null : h);
    } catch (err) {
      toast.error(`load failed: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async (next: BackupSettings) => {
    setSaving(true);
    try {
      const r = await fetch('/api/backups', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled: next.enabled,
          cadenceMode: next.cadenceMode,
          cadenceMinutes: next.cadenceMinutes,
          retentionPreset: next.retentionPreset,
          retentionCustom: next.retentionCustom,
          eventTriggers: next.eventTriggers,
          excludedPaths: next.excludedPaths,
        }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      const d = await r.json() as { settings: BackupSettings };
      setSettings(d.settings);
      toast.success('saved');
    } catch (err) {
      toast.error(`save failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, []);

  const snapshotNow = useCallback(async () => {
    setSnapshotting(true);
    try {
      const r = await fetch('/api/backups/snapshots', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'manual' }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      toast.success('snapshot created');
      await load();
    } catch (err) {
      toast.error(`snapshot failed: ${(err as Error).message}`);
    } finally {
      setSnapshotting(false);
    }
  }, [load]);

  const runMaintenance = useCallback(async () => {
    try {
      const r = await fetch('/api/backups/maintenance', { method: 'POST', body: JSON.stringify({ level: 'quick' }) });
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      toast.success('maintenance complete');
    } catch (err) {
      toast.error(`maintenance failed: ${(err as Error).message}`);
    }
  }, []);

  const verifyRepo = useCallback(async () => {
    try {
      const r = await fetch('/api/backups/verify', { method: 'POST' });
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      const d = await r.json() as { result: { ok: boolean; errors: string[] } };
      if (d.result.ok) toast.success('repo verified clean');
      else toast.error(`repo errors: ${d.result.errors.join('; ')}`);
    } catch (err) {
      toast.error(`verify failed: ${(err as Error).message}`);
    }
  }, []);

  if (loading || !settings || !stats) {
    return <main className="pc-settings-page"><h1>Backups</h1><p>Loading…</p></main>;
  }

  const set = <K extends keyof BackupSettings>(k: K, v: BackupSettings[K]) =>
    setSettings({ ...settings, [k]: v });

  const retentionEffective: RetentionPolicy =
    settings.retentionPreset === 'custom' && settings.retentionCustom
      ? settings.retentionCustom
      : RETENTION_PRESETS[settings.retentionPreset === 'custom' ? 'default' : settings.retentionPreset];

  return (
    <main className="pc-settings-page">
      <header>
        <h1>Backups</h1>
        <p className="pc-settings-intro">
          Per-workspace deduplicated snapshots via kopia. Local repo at{' '}
          <code>~/.papercusp-workspaces/&lt;id&gt;/backups/kopia-repo/</code>. Repo password is derived
          from your workspace key — no separate secret.
        </p>
      </header>

      {health && !health.kopia.ok && (
        <section className="pc-settings-section" style={{ borderLeft: '3px solid color-mix(in srgb, var(--bad), transparent 40%)', paddingLeft: 12 }}>
          <strong>kopia binary not found</strong> ({health.kopia.reason ?? 'unknown'}).
          <p className="pc-settings-note">
            Install kopia (https://kopia.io/docs/installation/) or set <code>KOPIA_BIN</code> to the binary path.
            Snapshots will not run until this is resolved.
          </p>
        </section>
      )}
      {health && health.kopia.ok && health.state === 'stale' && (
        <section className="pc-settings-section" style={{ borderLeft: '3px solid color-mix(in srgb, var(--warn), transparent 40%)', paddingLeft: 12 }}>
          <strong>Backups are stale</strong>
          {health.ageSeconds != null && ` — last snapshot was ${Math.round(health.ageSeconds / 60)} min ago.`}
        </section>
      )}

      <section className="pc-settings-section">
        <h2>Status</h2>
        <dl className="pc-settings-status">
          <div><dt>Enabled</dt><dd>{settings.enabled ? 'Yes' : 'No'}</dd></div>
          <div><dt>Snapshots</dt><dd>{stats.totalSnapshots.toLocaleString()}</dd></div>
          <div><dt>Repo size (post-dedup)</dt><dd>{fmtBytes(stats.bytesOnDisk)}</dd></div>
          <div><dt>Raw scanned</dt><dd>{fmtBytes(stats.bytesRaw)}</dd></div>
          <div><dt>Dedup ratio</dt><dd>{(stats.dedupRatio * 100).toFixed(1)}%</dd></div>
          <div><dt>Last successful</dt><dd>{fmtAgo(stats.lastSnapshotAt)}</dd></div>
          <div><dt>Last failure</dt><dd>{fmtAgo(stats.lastFailureAt)}</dd></div>
        </dl>
        <div className="pc-settings-actions">
          <button type="button" disabled={snapshotting} onClick={snapshotNow}>
            {snapshotting ? 'Snapshotting…' : 'Snapshot now'}
          </button>
          <button type="button" onClick={runMaintenance}>Run maintenance</button>
          <button type="button" onClick={verifyRepo}>Verify repo</button>
          <button type="button" onClick={load}>Refresh</button>
        </div>
      </section>

      <section className="pc-settings-section">
        <h2>Enable</h2>
        <label className="pc-settings-row">
          <Checkbox checked={settings.enabled} onChange={(v) => set('enabled', v)} />
          <span>Take snapshots for this workspace</span>
        </label>
      </section>

      <section className="pc-settings-section">
        <h2>Snapshot cadence</h2>
        <div className="pc-settings-radio-group" role="radiogroup" aria-label="Snapshot cadence">
          {(['event', 'interval', 'both'] as CadenceMode[]).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={settings.cadenceMode === m}
              className="pc-settings-choice"
              onClick={() => set('cadenceMode', m)}
            >
              <span>{m === 'event' ? 'Event-driven (recommended)' : m === 'interval' ? 'Hourly timer only' : 'Events + hourly timer'}</span>
            </button>
          ))}
        </div>
        {settings.cadenceMode !== 'event' && (
          <label className="pc-settings-row">
            <span>Every</span>
            <Select
              value={String(settings.cadenceMinutes)}
              onChange={(v) => set('cadenceMinutes', Number(v))}
              ariaLabel="Snapshot cadence (minutes)"
              options={[
                { value: '60', label: '1 hour' },
                { value: '360', label: '6 hours' },
                { value: '720', label: '12 hours' },
                { value: '1440', label: '24 hours' },
              ]}
            />
          </label>
        )}
        {settings.cadenceMode !== 'interval' && (
          <fieldset className="pc-settings-fieldset">
            <legend>Event triggers</legend>
            {TRIGGER_CHECKBOXES.map((t) => (
              <label key={t} className="pc-settings-row">
                <Checkbox
                  checked={settings.eventTriggers.includes(t)}
                  onChange={(checked) => {
                    const next = checked
                      ? [...settings.eventTriggers, t]
                      : settings.eventTriggers.filter((x) => x !== t);
                    set('eventTriggers', next);
                  }}
                />
                <span>{triggerLabel(t)}</span>
              </label>
            ))}
          </fieldset>
        )}
      </section>

      <section className="pc-settings-section">
        <h2>Retention</h2>
        <div className="pc-settings-radio-group" role="radiogroup" aria-label="Retention preset">
          {(['aggressive', 'default', 'conservative', 'custom'] as RetentionPreset[]).map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={settings.retentionPreset === p}
              className="pc-settings-choice"
              onClick={() => set('retentionPreset', p)}
            >
              <span>{p[0]!.toUpperCase() + p.slice(1)}</span>
            </button>
          ))}
        </div>
        {settings.retentionPreset === 'custom' ? (
          <div className="pc-settings-retention-grid">
            {(['keepLatest', 'keepHourly', 'keepDaily', 'keepWeekly', 'keepMonthly'] as const).map((k) => (
              <label key={k}>
                <span>{k.replace('keep', 'Keep ').toLowerCase()}</span>
                <input
                  type="number"
                  min={0}
                  value={(settings.retentionCustom ?? RETENTION_PRESETS.default)[k]}
                  onChange={(e) => set('retentionCustom', {
                    ...(settings.retentionCustom ?? RETENTION_PRESETS.default),
                    [k]: Number(e.target.value),
                  })}
                />
              </label>
            ))}
          </div>
        ) : (
          <p className="pc-settings-note">
            Keeping latest {retentionEffective.keepLatest}, hourly {retentionEffective.keepHourly},
            daily {retentionEffective.keepDaily}, weekly {retentionEffective.keepWeekly},
            monthly {retentionEffective.keepMonthly}.
          </p>
        )}
      </section>

      <DestinationSection />

      <section className="pc-settings-section">
        <h2>Excluded paths</h2>
        <p className="pc-settings-note">
          One glob pattern per line. Standard build-artifact/dep-cache patterns are always excluded.
        </p>
        <textarea
          rows={6}
          value={settings.excludedPaths.join('\n')}
          onChange={(e) => set('excludedPaths', e.target.value.split('\n').map((l) => l.trim()).filter(Boolean))}
        />
      </section>

      <footer className="pc-settings-footer">
        <button type="button" disabled={saving} onClick={() => save(settings)}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </footer>
    </main>
  );
}

function DestinationSection() {
  return (
    <section className="pc-settings-section">
      <h2>Backup destination</h2>
      <p className="pc-settings-note">
        Local only. Snapshots are written to the kopia repository on this machine.
      </p>
    </section>
  );
}
