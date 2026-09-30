'use client';

import { useEffect, useState } from 'react';
import RouteLink from '../RouteLink';
import { Checkbox } from '../../harness/Checkbox';

interface BackupSettings {
  enabled: boolean;
  cadenceMode: 'event' | 'interval' | 'both';
  cadenceMinutes: number;
  retentionPreset: 'aggressive' | 'default' | 'conservative' | 'custom';
  retentionCustom: unknown;
  eventTriggers: string[];
  excludedPaths: string[];
}

interface BackupsResponse {
  workspaceId: string;
  settings: BackupSettings;
  stats?: unknown;
  kopia?: { ok: boolean; version?: string; reason?: string };
}

export function StepBackups() {
  const [settings, setSettings] = useState<BackupSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kopia, setKopia] = useState<BackupsResponse['kopia']>(undefined);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/backups', { cache: 'no-store' });
        if (!r.ok) throw new Error(`backups: ${r.status}`);
        const j = (await r.json()) as BackupsResponse;
        setSettings(j.settings);
        setKopia(j.kopia);
      } catch (e: any) {
        setError(e?.message ?? String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const kopiaMissing = kopia !== undefined && !kopia.ok;

  const setEnabled = async (enabled: boolean) => {
    if (!settings) return;
    setBusy(true);
    setError(null);
    const next = { ...settings, enabled };
    try {
      const r = await fetch('/api/backups', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (!r.ok) throw new Error(`backups: ${r.status}`);
      setSettings(next);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pc-step">
      <p className="pc-step__lead">
        Papercusp uses <strong>Kopia</strong> to take local snapshots of your projects.{' '}
        <strong>Agents shouldn't delete git history</strong> — but if one ever does, this is a layer
        they can't touch. <strong>Enabled by default.</strong>
      </p>
      <ul className="pc-bullets">
        <li>Snapshots run before destructive agent operations and after each harness run.</li>
        <li>Restore from any snapshot via the Backups settings page.</li>
        <li>Storage is local-only by default; no cloud upload unless you configure one.</li>
      </ul>

      {kopiaMissing && (
        <div className="pc-step__progress" data-status="missing" style={{ marginTop: 16 }}>
          <div className="pc-step__progress-dot" />
          <div className="pc-step__progress-text">
            <strong>Kopia isn't installed in this runtime.</strong>
            <span>
              {kopia?.reason ?? 'The kopia binary was not found.'} Snapshots stay off until it's
              installed; everything else keeps working. You can continue setup and revisit this
              later in Settings → Backups.
            </span>
          </div>
        </div>
      )}

      <div className="pc-consent" style={{ marginTop: 16 }}>
        {loading && <span>Loading current setting…</span>}
        {!loading && settings && (
          <label className="pc-consent__toggle">
            <Checkbox
              checked={settings.enabled && !kopiaMissing}
              disabled={busy || kopiaMissing}
              onChange={(checked) => void setEnabled(checked)}
              ariaLabel="Enable local backups"
            />
            <span>
              {kopiaMissing
                ? 'Backups unavailable (kopia not installed)'
                : settings.enabled
                  ? 'Backups enabled'
                  : 'Backups disabled'}
              {busy && <em style={{ marginLeft: 8, opacity: 0.7 }}>saving…</em>}
            </span>
          </label>
        )}
        {error && (
          <span className="pc-field__hint pc-field__hint--err" style={{ marginTop: 8 }}>
            ⚠ {error}
          </span>
        )}
      </div>

      <p className="pc-step__hint" style={{ marginTop: 12 }}>
        Default retention keeps 24 latest + 48 hourly + 30 daily + 12 weekly + 12 monthly snapshots.
        Tune cadence, retention, and destination at{' '}
        <RouteLink href="/settings/backups" style={{ color: 'var(--accent)' }}>
          Settings → Backups
        </RouteLink>
        .
      </p>
    </div>
  );
}
