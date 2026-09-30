'use client';

/**
 * "Embedding device" (plan memory-reduction-2026-09-24 P-008 / D-003 / D-008,
 * WI-10002872): choose whether the local embedding models run on the GPU or
 * the CPU — Auto by default — and see what they ACTUALLY run on.
 *
 * Backed by GET/POST /api/user/embed-device, the same bounded one-shot REST
 * pattern as the sibling FleetKnowledgePacksSection (every fetch carries an
 * AbortSignal timeout). The select applies live: the route stores the choice
 * and hot-applies it to the embedding process, so there is no Save button.
 * All state here is lifecycle (loading/saving/error) or server data, so nothing
 * belongs in the URL.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Select } from '@/app/harness/Select';
import {
  EMBED_DEVICE_OPTIONS,
  deviceLabel,
  embedDeviceView,
  type EmbedDeviceChoice,
  type EmbedDeviceEnvelopeView,
} from './embed-device-view';

/** The reload re-warms the models (bounded at 45s server-side), so saves get longer than loads. */
const LOAD_TIMEOUT_MS = 15_000;
const SAVE_TIMEOUT_MS = 70_000;

type SidecarApply = { ok: true; changed: boolean } | { ok: false; restartNeeded: boolean; error: string };
type SaveResponse = EmbedDeviceEnvelopeView & {
  ok?: boolean;
  error?: string;
  applied?: { sidecar: SidecarApply | null };
};

const muted: React.CSSProperties = { fontSize: 12, color: 'var(--fg-mute)' };
const notice: React.CSSProperties = {
  padding: 8,
  border: '1px solid var(--warn-border)',
  borderRadius: 6,
  background: 'var(--warn-bg)',
  fontSize: 13,
};

export function EmbedDeviceSection(): React.ReactElement {
  const [env, setEnv] = useState<EmbedDeviceEnvelopeView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch('/api/user/embed-device', { signal: AbortSignal.timeout(LOAD_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEnv((await res.json()) as EmbedDeviceEnvelopeView);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async (preference: EmbedDeviceChoice) => {
    setSaving(true);
    try {
      const res = await fetch('/api/user/embed-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preference }),
        signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
      });
      const body = (await res.json()) as SaveResponse;
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setEnv(body);
      const sidecar = body.applied?.sidecar ?? null;
      if (sidecar && !sidecar.ok) toast.warning(`Embedding device saved. ${sidecar.error}`);
      else {
        const inUse = body.health?.active.verified ? deviceLabel(body.health.active.device) : null;
        toast.success(inUse ? `Embedding device saved — now running on the ${inUse}.` : 'Embedding device saved.');
      }
    } catch (e) {
      toast.error(`Saving the embedding device failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }, []);

  const view = env ? embedDeviceView(env) : null;

  return (
    <div
      data-testid="embed-device-section"
      style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-2)' }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 14 }}>Embedding device</strong>
        <span style={muted}>
          Where the local embedding models that power memory search run. The GPU is faster and keeps the models out of system memory.
        </span>
      </div>

      {loadError && (
        <div style={notice}>
          Couldn&rsquo;t load the embedding device: <code>{loadError}</code>{' '}
          <button type="button" onClick={() => void load()} style={{ fontSize: 12, cursor: 'pointer' }}>
            retry
          </button>
        </div>
      )}

      {env && view && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: 'var(--fg-mute)', minWidth: 240 }}>Run embedding models on</span>
            <Select
              value={view.choice}
              disabled={saving}
              onChange={(value) => void save(value as EmbedDeviceChoice)}
              ariaLabel="Embedding device"
              triggerStyle={{ padding: '4px 8px', fontSize: 13 }}
              options={[...EMBED_DEVICE_OPTIONS]}
            />
            {saving && <span style={muted}>applying — reloading the models…</span>}
          </div>

          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: 'var(--fg-mute)', minWidth: 240 }}>In use</span>
            {view.inUse ? (
              <span data-testid="embed-device-in-use" style={{ fontSize: 13, fontWeight: 600 }}>
                {view.inUse}
              </span>
            ) : (
              <span style={muted}>{env.healthError ?? 'unknown'}</span>
            )}
            {view.perModel.length > 0 && <span style={muted}>{view.perModel.join(' · ')}</span>}
          </div>

          {view.demotionWarning && <div style={notice}>{view.demotionWarning}</div>}
          {view.notices.map((n) => (
            <div key={n} style={notice}>
              {n}
            </div>
          ))}
          {env.settingError && (
            <div style={notice}>
              Couldn&rsquo;t read the saved choice (<code>{env.settingError}</code>); Auto applies until it can be read.
            </div>
          )}

          <div style={muted}>
            {view.hostLine}
            {view.why ? ` ${view.why}` : ''}
          </div>
        </>
      )}
    </div>
  );
}
