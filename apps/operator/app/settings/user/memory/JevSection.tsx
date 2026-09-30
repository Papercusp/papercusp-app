'use client';

/**
 * "Jev decisions" (plan jev-decision-model-integration-2026-09-29, P-013 / D-008):
 * turn TypeSafe's Jev on or off for memory injection, and enter the Jev API key.
 * Off keeps the current system exactly as it is.
 *
 * Backed by GET/POST /api/user/jev-settings, the same bounded one-shot REST
 * pattern as the sibling EmbedDeviceSection (every fetch carries an AbortSignal
 * timeout). The mode select applies live; the key is saved or removed with its
 * own buttons. The raw key never comes back from the server — only a masked form.
 * State here is lifecycle (loading/saving/error), server data, or a mid-edit key
 * draft, so nothing belongs in the URL.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Select } from '@/app/harness/Select';
import {
  JEV_EGRESS_NOTICE,
  JEV_MODE_OPTIONS,
  jevKeyDraftProblem,
  jevModeName,
  jevView,
  type JevMode,
  type JevSettingsEnvelopeView,
} from './jev-view';

const LOAD_TIMEOUT_MS = 15_000;
const SAVE_TIMEOUT_MS = 15_000;

type SaveResponse = JevSettingsEnvelopeView & { ok?: boolean; error?: string };

const muted: React.CSSProperties = { fontSize: 12, color: 'var(--fg-mute)' };
const label: React.CSSProperties = { fontSize: 13, color: 'var(--fg-mute)', minWidth: 240 };
const notice: React.CSSProperties = {
  padding: 8,
  border: '1px solid var(--warn-border)',
  borderRadius: 6,
  background: 'var(--warn-bg)',
  fontSize: 13,
};
const button: React.CSSProperties = {
  padding: '4px 12px',
  fontSize: 12,
  borderRadius: 4,
  border: '1px solid var(--border)',
  background: 'var(--bg-3)',
  color: 'var(--fg)',
  cursor: 'pointer',
};

export function JevSection(): React.ReactElement {
  const [env, setEnv] = useState<JevSettingsEnvelopeView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch('/api/user/jev-settings', { signal: AbortSignal.timeout(LOAD_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEnv((await res.json()) as JevSettingsEnvelopeView);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  /** One POST for every change; returns the new view, or null when it failed (already toasted). */
  const post = useCallback(async (body: { mode?: JevMode; apiKey?: string | null }): Promise<SaveResponse | null> => {
    setSaving(true);
    try {
      const res = await fetch('/api/user/jev-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
      });
      const out = (await res.json()) as SaveResponse;
      if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
      setEnv(out);
      return out;
    } catch (e) {
      toast.error(`Saving the Jev setting failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    } finally {
      setSaving(false);
    }
  }, []);

  const saveMode = useCallback(
    async (mode: JevMode) => {
      const out = await post({ mode });
      if (!out) return;
      if (out.mode !== 'off' && out.effective === 'off') toast.warning(`Jev set to ${jevModeName(out.mode)}. Save a key to start it.`);
      else toast.success(`Jev set to ${jevModeName(out.mode)}.`);
    },
    [post],
  );

  const saveKey = useCallback(async () => {
    const problem = jevKeyDraftProblem(keyDraft);
    if (problem) {
      toast.error(problem);
      return;
    }
    const out = await post({ apiKey: keyDraft.trim() });
    if (!out) return;
    setKeyDraft('');
    toast.success('Jev key saved.');
  }, [keyDraft, post]);

  const removeKey = useCallback(async () => {
    const out = await post({ apiKey: null });
    if (out) toast.success('Jev key removed. The current system is in use.');
  }, [post]);

  const view = env ? jevView(env) : null;

  return (
    <div
      data-testid="jev-section"
      style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-2)' }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 14 }}>Jev decisions</strong>
        <span style={muted}>
          Let TypeSafe&rsquo;s Jev model decide which memories are relevant enough to add to a turn. Off keeps the current system.
        </span>
      </div>

      {loadError && (
        <div style={notice}>
          Couldn&rsquo;t load the Jev setting: <code>{loadError}</code>{' '}
          <button type="button" onClick={() => void load()} style={{ fontSize: 12, cursor: 'pointer' }}>
            retry
          </button>
        </div>
      )}

      {env && view && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={label}>Use Jev for memory injection</span>
            <Select
              value={view.choice}
              disabled={saving}
              onChange={(value) => void saveMode(value as JevMode)}
              ariaLabel="Jev mode"
              triggerStyle={{ padding: '4px 8px', fontSize: 13 }}
              options={[...JEV_MODE_OPTIONS]}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <span style={label}>In use</span>
            <span data-testid="jev-in-use" style={{ fontSize: 13, fontWeight: 600 }}>
              {view.inUse}
            </span>
          </div>

          {view.missingKeyWarning && (
            <div data-testid="jev-missing-key" style={notice}>
              {view.missingKeyWarning}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={label}>Jev API key</span>
            <span data-testid="jev-key-line" style={{ fontSize: 13, fontFamily: env.keyPresent ? 'monospace' : undefined }}>
              {view.keyLine}
            </span>
            {env.keyPresent && (
              <button
                type="button"
                data-testid="jev-key-remove"
                disabled={saving}
                onClick={() => void removeKey()}
                style={{ ...button, color: 'var(--bad)', background: 'transparent' }}
              >
                Remove
              </button>
            )}
          </div>

          <form
            style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
            onSubmit={(e) => {
              e.preventDefault();
              void saveKey();
            }}
          >
            <span style={label}>{env.keyPresent ? 'Replace the key' : 'Paste your key'}</span>
            <input
              type="password"
              data-testid="jev-key-input"
              aria-label="Jev API key"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              placeholder="Jev API key from typesafe.ai"
              autoComplete="off"
              spellCheck={false}
              style={{ flex: '1 1 220px', maxWidth: 360, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--fg)', fontSize: 12, fontFamily: 'monospace' }}
            />
            <button
              type="submit"
              data-testid="jev-key-save"
              disabled={saving || keyDraft.trim().length === 0}
              style={{ ...button, background: 'var(--accent)', color: 'var(--accent-ink)', border: 'none', fontWeight: 600 }}
            >
              Save key
            </button>
            {saving && <span style={muted}>saving…</span>}
          </form>

          <div style={muted}>{JEV_EGRESS_NOTICE}</div>
        </>
      )}
    </div>
  );
}
