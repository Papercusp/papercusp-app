/**
 * PapercupTab — the Sentinel settings panel, docked in the Colony left
 * sidebar. Mirrors the OverwatchTab / MugTab
 * idiom: a header + vertical sections, `{ active }`-gated, rendered only while the
 * tab is open. Flag-gated by PAPERCUP at the sidebar (LeftSidebar hides the tab
 * when the role is dark).
 *
 * The Sentinel speaks for the system, so this tab surfaces its voice/persona
 * prefs as QUICK LIVE OVERRIDES over the workspace defaults. Each
 * setting renders through the shared <OverridableSetting> primitive: an
 * override/default badge + a reset ↺ that clears the per-user override, shown only
 * while the setting is overridden (isOverridden(workspaceDefault, userOverride)).
 *
 * Read/write wiring (mirrors apps/operator/app/settings/user/page.tsx — the Next
 * page that already shows BOTH layers for these prefs):
 *  - workspace DEFAULT ← `voicePrefs.workspace` shared sync query.
 *  - per-user OVERRIDE ← `userPreferences.current` shared sync query.
 *  - write override     → PATCH /api/user/preferences { [key]: value }.
 *  - clear override     → DELETE /api/user/preferences?key=<key> (the reset ↺).
 *
 * The "full settings" (workspace defaults) live at /settings/user — a deep link in
 * the footer jumps there. Settings surfaced here are all voice/persona prefs:
 *  - Audience mode (audienceMode: engineer ↔ novice) — a segmented toggle.
 *  - Voice on/off (speakSuggestions — the master "speak out loud" toggle).
 *  - Proactive nudges (proactiveTicksEnabled).
 *  - Speak status/cadence (speakCadenceStatus).
 *  - Do-not-disturb / pause (silenceVoice — when on, hushes the Sentinel).
 */
import { useCallback, useEffect, useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { useNavigate } from '@tanstack/react-router';
import { Megaphone, RotateCcw, Settings2 } from 'lucide-react';
import { Tooltip } from '@/app/harness/Tooltip';
import { useLexicon } from '@/lib/useLexicon';
import OverridableSetting from '../override/OverridableSetting';
import { isOverridden } from '../override/isOverridden';
import ModelOverride from './ModelOverride';
import { useModelOverride } from './useModelOverride';

/** The voice/persona pref keys the Sentinel surfaces as live overrides.
 *  Each MUST exist in the VoicePrefs schema (voice-prefs.ts) so the workspace
 *  fallback resolves; the bool ones must be in VOICE_USER_OVERRIDE_KEYS so the
 *  per-user PATCH actually overrides. `audienceMode` is the segmented control. */
export type AudienceMode = 'engineer' | 'novice';

/** Defaults used only as the last-resort fallback when the workspace read hasn't
 *  landed yet (the real defaults come from DEFAULT_VOICE_PREFS via the workspace
 *  layer). Kept tiny + matching the schema defaults. */
const FALLBACK_WORKSPACE = {
  audienceMode: 'engineer' as AudienceMode,
  speakSuggestions: true,
  proactiveTicksEnabled: true,
  speakCadenceStatus: false,
  silenceVoice: false,
} as const;

type PrefBag = Record<string, unknown>;

/** Write one per-user override (PATCH /api/user/preferences). Throws on failure. */
async function writeOverride(key: string, value: unknown): Promise<void> {
  const r = await fetch('/api/user/preferences', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [key]: value }),
  });
  if (!r.ok) throw new Error(`Failed to set ${key} (HTTP ${r.status})`);
}

/** Clear one per-user override (DELETE …?key=) — the reset ↺ path. Throws on failure. */
async function clearOverride(key: string): Promise<void> {
  const r = await fetch(`/api/user/preferences?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`Failed to clear ${key} (HTTP ${r.status})`);
}

/** The effective value for a key: the user override when present, else workspace. */
export function effectiveFor(workspace: PrefBag, user: PrefBag, key: string, fallback: unknown): unknown {
  if (key in user && user[key] !== null && user[key] !== undefined) return user[key];
  if (key in workspace && workspace[key] !== undefined) return workspace[key];
  return fallback;
}

/** Is this key overridden? Mirrors isOverridden(workspaceDefault, userOverride): a
 *  user value that is set AND differs from the workspace default. Pure. */
export function keyOverridden(workspace: PrefBag, user: PrefBag, key: string, fallback: unknown): boolean {
  const base = key in workspace && workspace[key] !== undefined ? workspace[key] : fallback;
  const override = key in user ? user[key] : undefined;
  return isOverridden(base, override as unknown);
}

export default function PapercupTab({ active }: { active: boolean }) {
  const t = useLexicon();
  const navigate = useNavigate();
  const [workspace, setWorkspace] = useState<PrefBag>({ ...FALLBACK_WORKSPACE });
  const [user, setUser] = useState<PrefBag>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const workspaceSync = useSyncQuery<PrefBag>({
    queryName: 'voicePrefs.workspace',
    enabled: active,
    staleTime: 30_000,
  });
  const userSync = useSyncQuery<{ payload: PrefBag }>({
    queryName: 'userPreferences.current',
    enabled: active,
    staleTime: 30_000,
  });
  const loaded = active && !workspaceSync.loading && !userSync.loading;

  useEffect(() => {
    if (!active) return;
    setWorkspace({ ...FALLBACK_WORKSPACE, ...(workspaceSync.data?.[0] ?? {}) });
  }, [active, workspaceSync.data]);
  useEffect(() => {
    if (!active) return;
    setUser(userSync.data?.[0]?.payload ?? {});
  }, [active, userSync.data]);
  useEffect(() => {
    const syncError = workspaceSync.error ?? userSync.error;
    if (syncError) setErr(syncError instanceof Error ? syncError.message : String(syncError));
  }, [userSync.error, workspaceSync.error]);

  const refresh = useCallback(() => {
    workspaceSync.invalidate();
    userSync.invalidate();
  }, [userSync, workspaceSync]);

  const setOverride = useCallback(async (key: string, value: unknown) => {
    setBusyKey(key);
    setErr(null);
    // Optimistic — the reset/badge derive from `user`, so reflect the write at once.
    setUser((u) => ({ ...u, [key]: value }));
    try {
      await writeOverride(key, value);
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      void refresh();
    } finally {
      setBusyKey(null);
    }
  }, [refresh]);

  const reset = useCallback(async (key: string) => {
    setBusyKey(key);
    setErr(null);
    setUser((u) => {
      const next = { ...u };
      delete next[key];
      return next;
    });
    try {
      await clearOverride(key);
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      void refresh();
    } finally {
      setBusyKey(null);
    }
  }, [refresh]);

  const eff = (key: string, fallback: unknown) => effectiveFor(workspace, user, key, fallback);
  const over = (key: string, fallback: unknown) => keyOverridden(workspace, user, key, fallback);

  const audience = (eff('audienceMode', FALLBACK_WORKSPACE.audienceMode) as AudienceMode) ?? 'engineer';
  const voiceOn = eff('speakSuggestions', FALLBACK_WORKSPACE.speakSuggestions) === true;
  const nudges = eff('proactiveTicksEnabled', FALLBACK_WORKSPACE.proactiveTicksEnabled) === true;
  const cadence = eff('speakCadenceStatus', FALLBACK_WORKSPACE.speakCadenceStatus) === true;
  // "Pause Sentinel" (silenceVoice) moved to the Active/Passive/Off toggle in
  // the voice bar (owner 2026-06-22) — its Off state drives silenceVoice now.

  const busy = (key: string) => busyKey === key;

  // Session-only MODEL override for the dock 🛡 Sentinel (model-override-sidebar-2026-06-23).
  const sentinelModel = useModelOverride('papercup', active);

  return (
    <TooltipPrimitive.Provider delayDuration={250}>
      <style>{SENTINEL_CSS}</style>
      <div className="pc-sentinel">
        <header className="pc-queen__bar">
          <Megaphone size={14} aria-hidden />
          <span className="pc-queen__identity">
            <span className="pc-queen__title">{t('operator')}</span>
            <span className="pc-queen__subtitle">Voice &amp; persona</span>
          </span>
          <span className="pc-queen__spacer" />
        </header>

        {err && (
          <div className="pc-queen__err" role="alert">
            {err}
          </div>
        )}

        {sentinelModel.error && (
          <div className="pc-queen__err" role="alert">
            Model override: {sentinelModel.error}
          </div>
        )}
        <ModelOverride
          label={`${t('operator')} model`}
          override={sentinelModel.override}
          onWrite={sentinelModel.setOverride}
          busy={sentinelModel.busy}
        />

        {!loaded ? (
          <div className="pc-queen__placeholder">Loading {t('operator')} settings…</div>
        ) : (
          <>
            {/* Audience mode — engineer ↔ user-friendly. Segmented toggle. */}
            <section className="pc-queen__section">
              <div className="pc-queen__section-head">
                <span className="pc-queen__section-title">Audience mode</span>
              </div>
              <OverridableSetting
                label="Audience"
                isOverridden={over('audienceMode', FALLBACK_WORKSPACE.audienceMode)}
                onReset={() => void reset('audienceMode')}
                busy={busy('audienceMode')}
              >
                <div className="pc-sentinel__seg" role="group" aria-label="Audience mode">
                  {(['engineer', 'novice'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={`pc-sentinel__segbtn${audience === m ? ' pc-sentinel__segbtn--on' : ''}`}
                      aria-pressed={audience === m}
                      disabled={busy('audienceMode')}
                      onClick={() => void setOverride('audienceMode', m)}
                    >
                      {m === 'engineer' ? 'Engineer' : 'Novice'}
                    </button>
                  ))}
                </div>
              </OverridableSetting>
              <span className="pc-queen__hint">
                How the {t('operator')} addresses you — terse &amp; technical, or plain-English &amp; outcome-first.
              </span>
            </section>

            {/* Voice + behavior toggles. */}
            <section className="pc-queen__section">
              <div className="pc-queen__section-head">
                <span className="pc-queen__section-title">Voice</span>
              </div>
              <SentinelToggle
                label="Voice"
                checked={voiceOn}
                isOverridden={over('speakSuggestions', FALLBACK_WORKSPACE.speakSuggestions)}
                busy={busy('speakSuggestions')}
                onChange={(v) => void setOverride('speakSuggestions', v)}
                onReset={() => void reset('speakSuggestions')}
              />
              <SentinelToggle
                label="Proactive nudges"
                checked={nudges}
                isOverridden={over('proactiveTicksEnabled', FALLBACK_WORKSPACE.proactiveTicksEnabled)}
                busy={busy('proactiveTicksEnabled')}
                onChange={(v) => void setOverride('proactiveTicksEnabled', v)}
                onReset={() => void reset('proactiveTicksEnabled')}
              />
              <SentinelToggle
                label="Speak status / cadence"
                checked={cadence}
                isOverridden={over('speakCadenceStatus', FALLBACK_WORKSPACE.speakCadenceStatus)}
                busy={busy('speakCadenceStatus')}
                onChange={(v) => void setOverride('speakCadenceStatus', v)}
                onReset={() => void reset('speakCadenceStatus')}
              />
            </section>

            {/* "Do not disturb / Pause Sentinel" moved to the Active/Passive/Off
                toggle in the voice bar (owner 2026-06-22): the toggle's Off state
                now drives silenceVoice. Removed from here to avoid two controls. */}

            <button
              type="button"
              className="pc-sentinel__manage"
              onClick={() => void navigate({ to: '/settings/user' })}
            >
              <Settings2 size={12} aria-hidden /> Full settings (workspace defaults)
            </button>
          </>
        )}
      </div>
    </TooltipPrimitive.Provider>
  );
}

/** A bool override row — a checkbox-style toggle wrapped in <OverridableSetting>. */
function SentinelToggle({
  label,
  checked,
  isOverridden,
  busy,
  onChange,
  onReset,
}: {
  label: string;
  checked: boolean;
  isOverridden: boolean;
  busy: boolean;
  onChange: (v: boolean) => void;
  onReset: () => void;
}) {
  return (
    <OverridableSetting label={label} isOverridden={isOverridden} onReset={onReset} busy={busy} badgeStyle="inline">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={busy}
        className={`pc-sentinel__switch${checked ? ' pc-sentinel__switch--on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span className="pc-sentinel__switch-knob" aria-hidden />
        <span className="pc-sentinel__switch-text">{checked ? 'On' : 'Off'}</span>
      </button>
    </OverridableSetting>
  );
}

// Sentinel-only chrome. The section/header classes reuse `pc-queen__*` (defined in
// LEFT_SIDEBAR_CSS, injected once by LeftSidebar) — only the segmented control +
// switch + manage link are new, so this small block carries them.
const SENTINEL_CSS = `
.pc-sentinel { display: flex; flex-direction: column; gap: 9px; padding: 2px 1px 6px; }
.pc-sentinel .pc-queen__bar svg { color: var(--accent, #8b5cf6); }
.pc-sentinel__seg { display: inline-flex; border-radius: 8px; border: 1px solid var(--border, rgba(125, 211, 252, 0.2)); overflow: hidden; }
.pc-sentinel__segbtn { padding: 4px 9px; font-size: 10.5px; font-weight: 700; background: transparent; border: none; color: var(--fg-mute, #7f9bb4); cursor: pointer; white-space: nowrap; }
.pc-sentinel__segbtn + .pc-sentinel__segbtn { border-left: 1px solid var(--border, rgba(125, 211, 252, 0.2)); }
.pc-sentinel__segbtn:hover:not(:disabled) { color: var(--fg, #e7f7ff); }
.pc-sentinel__segbtn--on { color: var(--accent-strong, #c7d2fe); background: rgba(99, 102, 241, 0.16); }
.pc-sentinel__segbtn:disabled { opacity: 0.6; cursor: default; }
.pc-sentinel__switch { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px 2px 3px; border-radius: 999px; border: 1px solid var(--border, rgba(125, 211, 252, 0.22)); background: var(--bg-3, rgba(255, 255, 255, 0.05)); color: var(--fg-mute, #7f9bb4); cursor: pointer; font-size: 10px; font-weight: 700; }
.pc-sentinel__switch-knob { width: 12px; height: 12px; border-radius: 999px; background: var(--fg-mute, #7f9bb4); transition: background 120ms ease; }
.pc-sentinel__switch--on { color: var(--accent-strong, #c7d2fe); border-color: rgba(99, 102, 241, 0.5); background: rgba(99, 102, 241, 0.14); }
.pc-sentinel__switch--on .pc-sentinel__switch-knob { background: var(--accent, #8b5cf6); }
.pc-sentinel__switch:disabled { opacity: 0.6; cursor: default; }
.pc-sentinel__manage { display: inline-flex; align-items: center; gap: 5px; align-self: flex-start; font-size: 11.5px; padding: 4px 8px; border-radius: 6px; color: var(--accent, #8b5cf6); background: transparent; border: 1px solid var(--border, rgba(255, 255, 255, 0.12)); cursor: pointer; }
.pc-sentinel__manage:hover { text-decoration: underline; }
`;
