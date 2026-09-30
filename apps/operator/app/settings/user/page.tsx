'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { OverridableSetting } from '@papercusp/ui-primitives/override';
import { Checkbox } from '../../harness/Checkbox';
import { Select } from '../../harness/Select';
import { DraftNumberInput } from '@/lib/forms';
import RouteLink from '@/app/_components/RouteLink';
import { useSyncQuery } from '@papercusp/sync';

interface User {
  id: string;
  username: string;
  display_name: string;
  has_password: boolean;
}

/**
 * Auto-login fallback identity — MUST match UserPicker's FALLBACK_USER. Under
 * auto-login the deployment runs single-user and `/api/auth/me` returns
 * `{ autoLogin: true, user: null }` (no cookie session). The top-right UserPicker
 * already falls back to this and shows "User · auto"; this page must do the SAME,
 * otherwise it wrongly renders "Not signed in" while the header says you're signed
 * in (owner report 2026-06-23). The identity edits below operate on the resolved
 * current user the same way the rest of the app does.
 */
const FALLBACK_USER: User = {
  id: '00000000-0000-0000-0000-000000000001',
  username: 'default',
  display_name: 'User',
  has_password: false,
};

/**
 * Override-eligible voice/operator pref keys. Must stay in sync with
 * VOICE_USER_OVERRIDE_KEYS in lib/user-preferences.ts and the underlying
 * VoicePrefs schema in lib/voice-prefs.ts.
 *
 * Each entry describes how to render + parse the value:
 *   - kind 'bool' → checkbox, default false
 *   - kind 'number' → number input, optional min/max
 *   - kind 'string' → text input
 *   - kind 'enum' → select dropdown
 */
type OverrideSpec =
  | { key: string; label: string; help: string; kind: 'bool' }
  | { key: string; label: string; help: string; kind: 'number'; min?: number; max?: number; step?: number }
  | { key: string; label: string; help: string; kind: 'string' }
  | { key: string; label: string; help: string; kind: 'enum'; options: { value: string; label: string }[] };

const OVERRIDES: readonly OverrideSpec[] = [
  { key: 'agentLanguage', kind: 'enum', label: 'Agent language pin',
    help: 'Force the operator to reply in this language regardless of what the workspace default says.',
    options: [
      { value: 'en', label: 'English (en)' },
      { value: 'es', label: 'Spanish (es)' },
      { value: 'fr', label: 'French (fr)' },
      { value: 'de', label: 'German (de)' },
      { value: 'it', label: 'Italian (it)' },
      { value: 'pt', label: 'Portuguese (pt)' },
      { value: 'pl', label: 'Polish (pl)' },
      { value: 'tr', label: 'Turkish (tr)' },
      { value: 'ru', label: 'Russian (ru)' },
      { value: 'nl', label: 'Dutch (nl)' },
      { value: 'cs', label: 'Czech (cs)' },
      { value: 'ar', label: 'Arabic (ar)' },
      { value: 'zh', label: 'Chinese (zh)' },
    ] },
  { key: 'elevenlabsVoiceId', kind: 'string', label: 'EL voice id',
    help: 'ElevenLabs voice id (overrides workspace default).' },
  // settings-audit 2026-07-09: this was a single free-text `wakeWordKeyword` row, but
  // no such field exists in VoicePrefs — the override was written and then read by
  // nothing, so the "Wake word" box silently did nothing. VoicePrefs has TWO
  // engine-scoped keys (each its own model name-space), picked by `wakeWordEngine`,
  // and both are closed enums rather than free text. Surface them as they really are.
  { key: 'porcupineKeyword', kind: 'enum', label: 'Wake word (Porcupine)',
    help: 'Wake word used when the Porcupine engine is selected in Settings → Voice & speech.',
    options: [
      { value: 'Computer', label: 'Computer' },
      { value: 'Jarvis', label: 'Jarvis' },
      { value: 'Bumblebee', label: 'Bumblebee' },
      { value: 'Picovoice', label: 'Picovoice' },
      { value: 'Porcupine', label: 'Porcupine' },
      { value: 'Alexa', label: 'Alexa' },
      { value: 'Hey Google', label: 'Hey Google' },
      { value: 'Hey Siri', label: 'Hey Siri' },
      { value: 'Okay Google', label: 'Okay Google' },
      { value: 'Terminator', label: 'Terminator' },
      { value: 'Americano', label: 'Americano' },
      { value: 'Blueberry', label: 'Blueberry' },
      { value: 'Grapefruit', label: 'Grapefruit' },
      { value: 'Grasshopper', label: 'Grasshopper' },
    ] },
  { key: 'openwakewordKeyword', kind: 'enum', label: 'Wake word (openWakeWord)',
    help: 'Wake word used when the openWakeWord engine is selected in Settings → Voice & speech.',
    options: [
      { value: 'alexa', label: 'alexa' },
      { value: 'hey_jarvis', label: 'hey jarvis' },
      { value: 'hey_mycroft', label: 'hey mycroft' },
      { value: 'hey_rhasspy', label: 'hey rhasspy' },
      { value: 'ok_nabu', label: 'ok nabu' },
      { value: 'weather', label: 'weather' },
      { value: 'timer', label: 'timer' },
    ] },
  { key: 'voiceMaxSpokenWords', kind: 'number', min: 5, max: 200, step: 1, label: 'Max spoken words per reply',
    help: 'Cap on TTS length per operator turn.' },
  { key: 'fullAgentIdleTimeoutMin', kind: 'number', min: 0, max: 60, step: 1, label: 'Idle timeout (min)',
    help: 'Auto-disconnect voice session after this many minutes of user silence. 0 = never.' },
  { key: 'fullAgentSessionMaxMin', kind: 'number', min: 0, max: 240, step: 5, label: 'Session max (min)',
    help: 'Hard session-duration cap. 0 = no max.' },
  { key: 'fullAgentAckVoice', kind: 'enum', label: 'Full-agent instant ack',
    help: 'In full-agent voice mode the provider speaks a short "On it…" ack in its own (paid) voice before the real answer arrives in your configured voice. Suppress it to hear only one voice and skip the provider-TTS cost.',
    options: [
      { value: 'provider', label: 'Provider voice speaks the ack (default)' },
      { value: 'suppressed', label: 'Silent — no spoken ack, only the real answer' },
    ] },
  { key: 'operatorHistoryTokenBudget', kind: 'number', min: 5000, max: 150000, step: 1000, label: 'Papercup history budget (tokens)',
    help: 'How much chat history the Papercup brain sees per turn. Higher = better recall, more cost.' },
  { key: 'operatorContextMode', kind: 'enum', label: 'Papercup long-conversation memory',
    help: 'Compaction keeps recent turns verbatim plus a rolling summary of everything older, so Papercup remembers the whole conversation at bounded cost. Window is the legacy escape hatch: verbatim budget only, older turns are forgotten.',
    options: [
      { value: 'compaction', label: 'Compaction (recommended) — window + rolling summary' },
      { value: 'window', label: 'Window only — forget turns past the budget' },
    ] },
  { key: 'operatorActiveOnStartup', kind: 'bool', label: 'Papercup active on startup',
    help: 'When a new chat opens, start in active mode (Papercup initiates) vs passive.' },
  { key: 'voicePrivacyMode', kind: 'enum', label: 'Voice privacy mode',
    help: 'Always-on streams the mic continuously; wake-word-gated only streams after the wake word.',
    options: [
      { value: 'always-on', label: 'Always on' },
      { value: 'wake-word-gated', label: 'Wake-word gated' },
      { value: 'ptt', label: 'Push-to-talk' },
    ] },
  { key: 'speakSuggestions', kind: 'bool', label: 'Speak suggestions out loud',
    help: 'When the operator surfaces suggestions, also speak them via TTS.' },
  { key: 'speakModeFlips', kind: 'bool', label: 'Speak mode flips',
    help: 'Announce active/passive mode changes via TTS.' },
  { key: 'speakCadenceStatus', kind: 'bool', label: 'Speak cadence status',
    help: 'Announce silence-nudge events via TTS.' },
  { key: 'operatorBackstoryEnabled', kind: 'bool', label: 'Papercup backstory enabled',
    help: 'Include the Papercup persona backstory in the system prompt.' },
  { key: 'memoryEmbedderMode', kind: 'enum', label: 'Memory system',
    help: 'Which model embeds your memories for search. Harrier-OSS-0.6b is the default — best recall, fully local & private. EmbeddingGemma-300m uses less resources (~4× faster embeds, ~2.4GB less RAM) if you want a lighter footprint. Each system stores vectors in its own space, so switching then running "Re-embed" (on the Memory page) brings old memories forward. When Harrier is selected, semantic search over docs, recipes, and knowledge still uses EmbeddingGemma (Harrier\'s vectors don\'t fit the prose search index); both run locally.',
    options: [
      { value: 'harrier', label: 'Harrier-OSS-0.6b (default) — best recall on the internal gold set, local & private, no API key; ~2.5GB RAM, ~4× slower embeds than Gemma' },
      { value: 'gemma', label: 'EmbeddingGemma-300m — uses less resources (~1GB RAM, ~4× faster embeds), local & private, no API key; slightly lower recall than Harrier' },
      { value: 'local', label: 'BGE-small — lightest local (~400MB RAM), no API key; lower quality than Gemma' },
      { value: 'openai', label: 'OpenAI text-embedding-3-small — cloud, needs an API key, memory text leaves your device' },
      { value: 'disabled', label: 'Disabled — turn off persistent memory' },
    ] },
] as const;

interface EffectivePrefs {
  workspace: Record<string, unknown>;
  user: Record<string, unknown>;
}

export default function UserSettingsPage() {
  const [user, setUser] = useState<User>(FALLBACK_USER);
  const [effective, setEffective] = useState<EffectivePrefs>({ workspace: {}, user: {} });
  const [loading, setLoading] = useState(true);
  const userPrefsSync = useSyncQuery<{ payload: Record<string, unknown> }>({
    queryName: 'userPreferences.current', staleTime: 30_000,
  });
  const workspacePrefsSync = useSyncQuery<Record<string, unknown>>({
    queryName: 'voicePrefs.workspace', staleTime: 30_000,
  });

  // Display name edit
  const [displayName, setDisplayName] = useState('');
  const [savingName, setSavingName] = useState(false);

  // Password change UI
  const [currentPw, setCurrentPw] = useState('');
  const [nextPw, setNextPw] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [pwBusy, setPwBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const me = await fetch('/api/auth/me').then((r) => (r.ok ? r.json() : null)).catch(() => null);
      // Under auto-login `/api/auth/me` returns no `user`; fall back to the
      // default identity (matches UserPicker) instead of "Not signed in".
      const resolvedUser: User = me?.user ?? FALLBACK_USER;
      setUser(resolvedUser);
      setDisplayName(resolvedUser.display_name ?? '');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    setEffective({
      workspace: workspacePrefsSync.data?.[0] ?? {},
      user: userPrefsSync.data?.[0]?.payload ?? {},
    });
  }, [userPrefsSync.data, workspacePrefsSync.data]);

  const setOverride = useCallback(async (key: string, value: unknown) => {
    if (key === 'memoryEmbedderMode' && value !== 'disabled') {
      const manifestResponse = await fetch('/api/user/memory/reembed');
      const manifest = await manifestResponse.json().catch(() => ({})) as {
        current?: { mode?: string; profileId?: string } | null;
        rollback?: { mode?: string; profileId?: string } | null;
        profiles?: Record<string, { profileId?: string }>;
      };
      const current = manifest.current ?? manifest.rollback;
      const target = typeof value === 'string' ? manifest.profiles?.[value] : undefined;
      if (!manifestResponse.ok || !current?.mode || !current.profileId || !target?.profileId || typeof value !== 'string') {
        toast.error('Cannot resolve exact source and target memory profiles for a safe cutover.');
        return;
      }
      const cutoverResponse = await fetch('/api/user/memory/reembed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          from: current.mode,
          to: value,
          fromProfileId: current.profileId,
          toProfileId: target.profileId,
          cutover: true,
        }),
      });
      const cutover = await cutoverResponse.json().catch(() => ({}));
      if (!cutoverResponse.ok) {
        toast.error(`Memory profile cutover failed: ${cutover.message ?? cutover.error ?? cutoverResponse.status}`);
        return;
      }
      setEffective((p) => ({ ...p, user: { ...p.user, [key]: value } }));
      userPrefsSync.invalidate();
      workspacePrefsSync.invalidate();
      toast.success(`Memory profile → ${value} (${cutover.coverage?.target ?? 0}/${cutover.coverage?.eligible ?? 0} covered)`);
      return;
    }
    const r = await fetch('/api/user/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [key]: value }),
    });
    if (!r.ok) {
      toast.error(`Failed to set ${key}`);
      return;
    }
    setEffective((p) => ({ ...p, user: { ...p.user, [key]: value } }));
    userPrefsSync.invalidate();
    workspacePrefsSync.invalidate();
    toast.success(`Override saved for ${key}`);
  }, [userPrefsSync, workspacePrefsSync]);

  const clearOverride = useCallback(async (key: string) => {
    const r = await fetch(`/api/user/preferences?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
    if (!r.ok) {
      toast.error(`Failed to clear ${key}`);
      return;
    }
    setEffective((p) => { const u = { ...p.user }; delete u[key]; return { ...p, user: u }; });
    userPrefsSync.invalidate();
    workspacePrefsSync.invalidate();
    toast.success(`Cleared override for ${key}`);
  }, [userPrefsSync, workspacePrefsSync]);

  const saveDisplayName = useCallback(async () => {
    setSavingName(true);
    try {
      const r = await fetch('/api/auth/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ display_name: displayName }),
      });
      if (!r.ok) {
        toast.error('Failed to save display name');
        return;
      }
      toast.success('Display name updated');
    } finally {
      setSavingName(false);
    }
  }, [displayName]);

  const onSetPassword = useCallback(async () => {
    setPwBusy(true);
    try {
      const r = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          current: user?.has_password ? currentPw : null,
          next: nextPw || null,
          // EI-347: only meaningful (and only sent) while the account has no
          // password yet — the server ignores/doesn't need it once one exists.
          ...(user?.has_password ? {} : { setupToken }),
        }),
      });
      if (!r.ok) {
        const j = await r.json();
        if (j.error === 'setup_token_required') {
          toast.error('Setup code missing or incorrect — check the Papercusp server log for the code printed at startup.');
        } else {
          toast.error(`Password change failed: ${j.error}`);
        }
        return;
      }
      toast.success(nextPw ? 'Password updated' : 'Password removed');
      setCurrentPw(''); setNextPw(''); setSetupToken('');
      await refresh();
    } finally {
      setPwBusy(false);
    }
  }, [user?.has_password, currentPw, nextPw, setupToken, refresh]);

  if (loading) return <div style={{ padding: 32 }}>Loading…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
      <header>
        <h1>User preferences</h1>
        <p className="pc-settings-intro">
          Settings here override workspace defaults just for {user.display_name}.
        </p>
      </header>

      <section className="pc-settings-section">
        <h2>Identity</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label>Username: <code>{user.username}</code> (immutable)</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
              <span>Display name</span>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                style={{ padding: 6, border: '1px solid var(--border)', borderRadius: 4 }}
              />
            </label>
            <button type="button" onClick={saveDisplayName} disabled={savingName || displayName.trim() === user.display_name}>
              {savingName ? '…' : 'Save'}
            </button>
          </div>
        </div>
      </section>

      <section className="pc-settings-section">
        <h2>Password</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {user.has_password && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span>Current password</span>
              <input
                type="password"
                value={currentPw}
                onChange={(e) => setCurrentPw(e.target.value)}
                style={{ padding: 6, border: '1px solid var(--border)', borderRadius: 4 }}
              />
            </label>
          )}
          {!user.has_password && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span>Setup code</span>
              <span style={{ color: 'var(--fg-mute)', fontSize: 12 }}>
                Printed to the Papercusp server log/console when it started up
                (one-time, only needed for the very first password).
              </span>
              <input
                type="text"
                value={setupToken}
                onChange={(e) => setSetupToken(e.target.value)}
                style={{ padding: 6, border: '1px solid var(--border)', borderRadius: 4 }}
              />
            </label>
          )}
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>New password (leave blank to remove)</span>
            <input
              type="password"
              value={nextPw}
              onChange={(e) => setNextPw(e.target.value)}
              style={{ padding: 6, border: '1px solid var(--border)', borderRadius: 4 }}
            />
          </label>
          <button type="button" onClick={onSetPassword} disabled={pwBusy}>
            {pwBusy ? '…' : nextPw ? 'Update password' : (user.has_password ? 'Remove password' : 'Add password')}
          </button>
        </div>
      </section>

      <section className="pc-settings-section">
        <h2>Overrides</h2>
        <p style={{ color: 'var(--fg-mute)', fontSize: 13, marginBottom: 12 }}>
          Set a value here to override the workspace default for your account.
          Leave a row empty (or click Clear) to fall back to the workspace.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {OVERRIDES.map((spec) => {
            const overridden = spec.key in effective.user;
            const value = overridden ? effective.user[spec.key] : effective.workspace[spec.key];
            const workspaceValue = effective.workspace[spec.key];
            return (
              <div
                key={spec.key}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 12,
                  padding: 12, borderRadius: 6,
                  border: '1px solid var(--border)',
                  background: overridden ? 'color-mix(in srgb, var(--accent), transparent 95%)' : 'transparent',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* Override badge + Clear (reset) now route through the shared
                      <OverridableSetting> primitive (sentinel-herald P-035).
                      Presence-based: a key present in effective.user IS an
                      override (preserves the prior `spec.key in effective.user`
                      semantics — a re-stated workspace value still shows). */}
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
                    <OverridableSetting
                      label={spec.label}
                      isOverridden={overridden}
                      onReset={() => clearOverride(spec.key)}
                      resetLabel="Clear"
                    />
                    {overridden && (
                      <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>
                        workspace: <code>{formatValue(workspaceValue)}</code>
                      </span>
                    )}
                  </div>
                  <p style={{ color: 'var(--fg-mute)', fontSize: 12, margin: '0 0 8px' }}>{spec.help}</p>
                  <OverrideInput
                    spec={spec}
                    value={value}
                    onChange={(v) => setOverride(spec.key, v)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="pc-settings-section">
        <h2>Memory</h2>
        <p style={{ color: 'var(--fg-mute)', fontSize: 13 }}>
          The operator stores things it learns about you (preferences, corrections, etc).
          Inspect and delete per entry at <RouteLink href="/settings/user/memory" style={{ color: 'var(--accent)' }}>/settings/user/memory</RouteLink>.
          Search across memories + workspace prose at <RouteLink href="/settings/user/search" style={{ color: 'var(--accent)' }}>/settings/user/search</RouteLink>.
        </p>
      </section>
    </div>
  );
}

function formatValue(v: unknown): string {
  if (v === undefined || v === null) return '(unset)';
  if (typeof v === 'string') return v === '' ? '(empty)' : v;
  return String(v);
}

function OverrideInput({ spec, value, onChange }: {
  spec: OverrideSpec;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  // String + number commit on blur (never one PATCH per keystroke). Numbers
  // go through DraftNumberInput, which gates on the spec's declared min/max
  // before persisting — the HTML min/max attributes are UI hints only.
  const [draft, setDraft] = useState<string>(value == null ? '' : String(value));
  const focusedRef = useRef(false);
  // Adopt external value changes only while idle — a slow PATCH echo or a
  // peer field's save must not eat in-progress keystrokes.
  useEffect(() => {
    if (!focusedRef.current) setDraft(value == null ? '' : String(value));
  }, [value]);

  if (spec.kind === 'bool') {
    return (
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <Checkbox
          checked={value === true}
          onChange={(v) => onChange(v)}
          ariaLabel="bool"
        />
        <span>{value === true ? 'On' : 'Off'}</span>
      </label>
    );
  }
  if (spec.kind === 'enum') {
    return (
      <Select
        value={((value as string) ?? '') || '_default'}
        onChange={(v) => onChange(v === '_default' ? '' : v)}
        options={[
          { value: '_default', label: '(use workspace default)' },
          ...spec.options.map((o) => ({ value: o.value, label: o.label })),
        ]}
        ariaLabel={spec.label}
      />
    );
  }
  if (spec.kind === 'number') {
    return (
      <DraftNumberInput
        aria-label={spec.label}
        value={typeof value === 'number' ? value : null}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        // An empty draft is "nothing entered", not an error — overrides are
        // optional (the workspace default applies when unset).
        emptyDraft="ignore"
        onCommit={(n) => onChange(n)}
        wrapperStyle={{ display: 'inline-flex' }}
        style={{ padding: 6, border: '1px solid var(--border)', borderRadius: 4, width: 140 }}
      />
    );
  }
  // string
  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => { focusedRef.current = true; }}
      onBlur={() => { focusedRef.current = false; if (draft !== String(value ?? '')) onChange(draft.trim()); }}
      onKeyDown={(e) => { if (e.key === 'Escape') setDraft(value == null ? '' : String(value)); }}
      style={{ padding: 6, border: '1px solid var(--border)', borderRadius: 4, minWidth: 240 }}
    />
  );
}
