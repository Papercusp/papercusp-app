'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import RouteLink from '../../_components/RouteLink';

import { toast } from 'sonner';
import { Checkbox } from '../../harness/Checkbox';
import { Select } from '../../harness/Select';
import { Modal } from '../../harness/Modal';
import { useConfirmDialog } from '../../harness/useConfirmDialog';
import { Button } from '../../harness/Button';
import { DraftInput } from '@/lib/forms';
import { NumField } from './NumField';
import {
  initVoiceMode,
  listAvailableVoices,
  getVoiceConfig,
  updateVoiceConfig,
  speak,
} from '@/app/_components/voice/voice-mode';
import { setVoicePrefsClient } from '@/app/_components/voice/voice-prefs-client';
import type { VoicePrefs, SttEngineKind, TtsEngineKind } from '@papercusp/operator-core/lib/voice-prefs';
import {
  RELEASE_UNAVAILABLE_LABEL,
  isFullAgentEngineUnavailable,
  isTtsEngineUnavailable,
  isWakeEngineUnavailable,
  releaseUnavailableMessage,
} from '@papercusp/operator-core/lib/voice-release-availability';
import type { TtsSpendState } from '@papercusp/operator-core/lib/tts-spend';
import type { SttSpendState } from '@papercusp/operator-core/lib/stt-spend';
import { useSyncQuery } from '@papercusp/sync';

interface ApiKeyState { configured: boolean; apiKey: string | null }
interface CloudCredentialsSnapshot {
  elevenlabs: ApiKeyState;
  openai: ApiKeyState;
  cartesia: ApiKeyState;
  deepgram: ApiKeyState;
  picovoice: ApiKeyState;
  google: ApiKeyState;
}
type ElevenLabsKeyState = ApiKeyState;
interface ElevenLabsConnTest { ok: boolean; tier?: string; characterCount?: number; characterLimit?: number; email?: string | null; error?: string }
interface ElevenLabsVoice { id: string; name: string; lang?: string }

/**
 * Full-agent engines that require a cloud key. Maps the engine enum value
 * to the credential it needs so the option can (a) stay selectable even when
 * the key is missing and (b) reveal an inline key-entry box below on select.
 */
const FULL_AGENT_KEY: Record<string, {
  service: keyof CloudCredentialsSnapshot;
  field: 'openaiApiKey' | 'googleApiKey' | 'elevenlabsApiKey';
  label: string;
  placeholder: string;
  helpUrl: string;
}> = {
  'openai-realtime':           { service: 'openai',     field: 'openaiApiKey',     label: 'OpenAI',    placeholder: 'sk-…',  helpUrl: 'https://platform.openai.com/api-keys' },
  'elevenlabs-conv':           { service: 'elevenlabs', field: 'elevenlabsApiKey', label: 'ElevenLabs', placeholder: 'sk_…', helpUrl: 'https://elevenlabs.io/app/settings/api-keys' },
  // Legacy alias for 'elevenlabs-conv' — kept so a stored value still resolves,
  // but deliberately NOT offered in the engine picker's option list.
  'elevenlabs-conversational': { service: 'elevenlabs', field: 'elevenlabsApiKey', label: 'ElevenLabs', placeholder: 'sk_…', helpUrl: 'https://elevenlabs.io/app/settings/api-keys' },
};

export default function VoiceSettingsPage() {
  const [voices, setVoices] = useState<Array<{ name: string; lang: string }>>([]);
  const [config, setConfig] = useState(() => getVoiceConfig());

  // v4 prefs + engine state
  const [prefs, setPrefs] = useState<VoicePrefs | null>(null);
  const voicePrefsSync = useSyncQuery<VoicePrefs>({ queryName: 'voicePrefs.effective', staleTime: 30_000 });
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [credentials, setCredentials] = useState<ElevenLabsKeyState>({ configured: false, apiKey: null });
  const [allCreds, setAllCreds] = useState<CloudCredentialsSnapshot | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [connTest, setConnTest] = useState<ElevenLabsConnTest | null>(null);
  const [testing, setTesting] = useState(false);
  const [elevenVoices, setElevenVoices] = useState<ElevenLabsVoice[]>([]);
  const [spend, setSpend] = useState<TtsSpendState | null>(null);
  const [sttSpend, setSttSpend] = useState<SttSpendState | null>(null);
  const [showLeakWarning, setShowLeakWarning] = useState(false);
  const { askConfirm, confirmEl } = useConfirmDialog();

  useEffect(() => {
    if (voicePrefsSync.data?.[0]) setPrefs(voicePrefsSync.data[0]);
  }, [voicePrefsSync.data]);

  useEffect(() => {
    initVoiceMode();
    setConfig(getVoiceConfig());

    // Browsers fire `voiceschanged` exactly once after the voice list
    // is populated. Listen for that AND poll a few times in case the
    // browser doesn't emit the event (some Linux Chromium builds);
    // stop polling as soon as voices arrive or after a short window so
    // we don't churn the page on environments without Web Speech (Tauri
    // WebKitGTK), where the list stays empty forever.
    let stopped = false;
    let attempts = 0;
    const maxAttempts = 10; // 10 × 500ms = 5s ceiling
    let interval: ReturnType<typeof setInterval> | null = null;

    const tryRefresh = () => {
      if (stopped) return;
      const v = listAvailableVoices();
      if (v.length) {
        // Only set state when the list actually changed length — avoids
        // a no-op render loop.
        setVoices((prev) => (prev.length === v.length ? prev : v));
        stopped = true;
        if (interval) clearInterval(interval);
        return;
      }
      attempts += 1;
      if (attempts >= maxAttempts) {
        stopped = true;
        if (interval) clearInterval(interval);
      }
    };

    tryRefresh();
    interval = setInterval(tryRefresh, 500);

    const onVoicesChanged = () => tryRefresh();
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.addEventListener?.('voiceschanged', onVoicesChanged);
    }

    // Four INDEPENDENT fetches — deliberately not Promise.all. Each section
    // renders as its data lands, so one slow/starved request (the shell's
    // SSE streams can monopolize the per-origin HTTP/1.1 socket budget)
    // delays only its own widget instead of holding back the whole page.
    const load = (url: string, apply: (v: unknown) => void) => {
      void fetch(url)
        .then((r) => (r.ok ? r.json() : null))
        .then((v) => { if (v) apply(v); })
        .catch(() => { /* section stays in its empty state */ });
    };
    load('/api/agent-mcp/operator-credentials', (c) => {
      const snap = c as CloudCredentialsSnapshot & { elevenlabs?: ElevenLabsKeyState };
      if (snap.elevenlabs) setCredentials(snap.elevenlabs);
      setAllCreds(snap);
    });
    load('/api/agent-mcp/operator-tts-spend', (s) => setSpend(s as TtsSpendState));
    load('/api/agent-mcp/operator-stt-spend', (ss) => setSttSpend(ss as SttSpendState));

    return () => {
      stopped = true;
      if (interval) clearInterval(interval);
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.removeEventListener?.('voiceschanged', onVoicesChanged);
      }
    };
  }, []);

  const savePrefsPatch = useCallback(async (patch: Partial<VoicePrefs>) => {
    setSavingPrefs(true);
    try {
      const r = await fetch('/api/agent-mcp/operator-voice-prefs', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const next = await r.json() as VoicePrefs;
      setPrefs(next);
      // Push into the module-level cache so subscribers
      // (voice-card router, announcer, etc.) see live updates.
      setVoicePrefsClient(next);
      voicePrefsSync.invalidate();
    } catch (err) {
      // A silent failure reads as "saved" — surface it.
      toast.error(`voice setting not saved: ${(err as Error).message}`);
    } finally {
      setSavingPrefs(false);
    }
  }, [voicePrefsSync]);

  const onTestVoice = useCallback(() => {
    speak('Voice mode is working.', 'system:operator', 'polite', { force: true });
  }, []);

  const onRedetect = useCallback(async () => {
    // Actually probe engine reachability (WI-3663) instead of the old no-op that
    // only re-fetched prefs. operator-voice-engine-health probes the LOCAL engines
    // live (kokoro TTS :8880, voicemode Whisper :2022) and reports which cloud
    // providers have a key configured — all server-side, no key in the browser.
    const t = toast.loading('Re-detecting engines…');
    try {
      const health = await fetch('/api/agent-mcp/operator-voice-engine-health').then((r) => (r.ok ? r.json() : null));
      voicePrefsSync.invalidate();
      if (!health) {
        toast.error('Engine detection failed', { id: t });
        return;
      }
      const m = (b: boolean) => (b ? '✓' : '✗');
      toast.success(
        `Local: Kokoro ${m(health.kokoro)} · Voicemode ${m(health.voicemode)}  —  ` +
          `Cloud keys: ElevenLabs ${m(health.elevenlabs)} · OpenAI ${m(health.openai)} · Cartesia ${m(health.cartesia)}`,
        { id: t, duration: 8000 },
      );
    } catch (e) {
      toast.error(`Engine detection failed: ${(e as Error).message}`, { id: t });
    }
  }, [voicePrefsSync]);

  const setSttEngine = useCallback((kind: SttEngineKind) => {
    if ((kind === 'webspeech' || kind === 'deepgram') && !prefs?.webSpeechLeakAcked) {
      setShowLeakWarning(true);
      return;
    }
    void savePrefsPatch({ sttEngine: kind });
  }, [prefs?.webSpeechLeakAcked, savePrefsPatch]);

  const ackLeakWarning = useCallback(async () => {
    await savePrefsPatch({ webSpeechLeakAcked: true, sttEngine: 'webspeech' });
    setShowLeakWarning(false);
  }, [savePrefsPatch]);

  // Populate the account's ElevenLabs voice list via the SERVER proxy
  // (operator-elevenlabs-voices reads the key server-side). The browser only
  // ever holds a MASKED key, so the old direct api.elevenlabs.io fetch always
  // 401'd and the picker was stuck on the hardcoded default (WI-3662).
  const loadElevenVoices = useCallback(async () => {
    try {
      const r = await fetch('/api/agent-mcp/operator-elevenlabs-voices');
      if (!r.ok) return;
      const body = (await r.json()) as { voices?: ElevenLabsVoice[] };
      if (Array.isArray(body.voices) && body.voices.length) setElevenVoices(body.voices);
    } catch {
      /* keep the default list */
    }
  }, []);

  // Auto-load the account voices once a key is configured, so the Default-voice
  // picker fills in on page load (not only after clicking "Test connection").
  useEffect(() => {
    if (credentials.configured) void loadElevenVoices();
  }, [credentials.configured, loadElevenVoices]);

  const setTtsEngine = useCallback((kind: TtsEngineKind) => {
    void savePrefsPatch({ ttsEngine: kind });
    if (kind === 'elevenlabs' && credentials.configured) void loadElevenVoices();
  }, [savePrefsPatch, credentials, loadElevenVoices]);

  const onSaveKey = useCallback(async () => {
    if (!keyDraft.trim()) return;
    const r = await fetch('/api/agent-mcp/operator-credentials', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elevenlabsApiKey: keyDraft.trim() }),
    });
    if (r.ok) {
      setCredentials((await r.json()).elevenlabs);
      setKeyDraft('');
      toast.success('ElevenLabs key saved');
    }
  }, [keyDraft]);

  // Save an arbitrary cloud voice key (used by the inline full-agent key box).
  // Round-trips the full snapshot so allCreds + the ElevenLabs-specific state
  // both reflect the new value immediately.
  const onSaveCloudKey = useCallback(async (field: string, value: string): Promise<boolean> => {
    const v = value.trim();
    if (!v) return false;
    const r = await fetch('/api/agent-mcp/operator-credentials', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [field]: v }),
    });
    if (!r.ok) {
      toast.error(`Save failed: HTTP ${r.status}`);
      return false;
    }
    const snap = (await r.json()) as CloudCredentialsSnapshot;
    setAllCreds(snap);
    if (snap.elevenlabs) setCredentials(snap.elevenlabs);
    toast.success('API key saved');
    return true;
  }, []);

  const onClearKey = useCallback(async () => {
    const ok = await askConfirm({
      title: 'Clear the ElevenLabs API key?',
      body: 'Voice features that depend on ElevenLabs (Conv AI, Turbo v2.5, voices) will stop working until a new key is saved.',
      confirmLabel: 'Clear',
      destructive: true,
    });
    if (!ok) return;
    const r = await fetch('/api/agent-mcp/operator-credentials', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elevenlabsApiKey: null }),
    });
    if (r.ok) {
      setCredentials((await r.json()).elevenlabs);
      setConnTest(null);
      setElevenVoices([]);
    }
  }, [askConfirm]);

  const onTestConnection = useCallback(async () => {
    setTesting(true);
    try {
      const r = await fetch('/api/agent-mcp/operator-elevenlabs-test', { method: 'POST' });
      const data: ElevenLabsConnTest = await r.json();
      setConnTest(data);
      if (data.ok) {
        // Populate the voice picker via the SERVER proxy — the browser only holds a
        // masked key, so it must fetch /v1/voices server-side (WI-3662).
        await loadElevenVoices();
        toast.success(`ElevenLabs connected — ${data.tier} tier`);
      } else {
        toast.error(`ElevenLabs test failed: ${data.error ?? 'unknown'}`);
      }
    } finally {
      setTesting(false);
    }
  }, [loadElevenVoices]);

  const onRateUiChange = useCallback((rate: number) => {
    updateVoiceConfig({ rate });
    setConfig(getVoiceConfig());
  }, []);

  const onWakeWordChange = useCallback((wakeWord: string) => {
    updateVoiceConfig({ wakeWord });
    setConfig(getVoiceConfig());
  }, []);

  const updateSpendKnob = useCallback(async (patch: Partial<TtsSpendState>) => {
    const r = await fetch('/api/agent-mcp/operator-tts-spend', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (r.ok) setSpend(await r.json());
  }, []);

  const todaySpend = spend?.spend?.[0];

  // Hold the render until the prefs fetch resolves. Otherwise every
  // `prefs?.sttEngine ?? 'voicemode'` style fallback in the JSX paints
  // the default value, then the fetch lands and every control snaps to
  // its real value half a second later. The skeleton matches the real
  // layout's outer dimensions so there's no shift when prefs arrives.
  if (!prefs) {
    return (
      <div className="pc-settings-page--voice" aria-busy="true">
        <h1>Voice mode</h1>
        <p className="pc-settings-loading">Loading your voice settings…</p>
      </div>
    );
  }

  return (
    <div className="pc-settings-page--voice">
      <h1>Voice mode</h1>
      <p className="pc-settings-intro">
        Voice runs in the browser. Local Voicemode (Whisper STT + Kokoro TTS) is the default;
        ElevenLabs cloud TTS is opt-in with bring-your-own API key.
      </p>

      {/* ── ENGINE SELECTORS ─────────────────────────────────────── */}
      <section className="pc-settings-section">
        <h2>Engines</h2>
        {(() => {
          const fullAgentVal = prefs?.fullAgentEngine ?? 'off';
          const fullAgentOn = fullAgentVal !== 'off';
          const sttTtsDisabled = savingPrefs || fullAgentOn;
          const sttTtsDimStyle: React.CSSProperties = fullAgentOn
            ? { opacity: 0.5, pointerEvents: 'none' as const }
            : {};
          // Selected full-agent engine needs a cloud key that isn't set yet →
          // keep the option selectable and reveal an inline key-entry box.
          const keyCfg = FULL_AGENT_KEY[fullAgentVal];
          const needsKey = !!keyCfg && !allCreds?.[keyCfg.service]?.configured;
          return (
            <>
              <div style={{ marginBottom: 16 }}>
                <label style={lbl}>Full-agent engine</label>
                <Select
                  value={fullAgentVal}
                  onChange={(v) => {
                    if (!isFullAgentEngineUnavailable(v)) void savePrefsPatch({ fullAgentEngine: v as VoicePrefs['fullAgentEngine'] });
                  }}
                  ariaLabel="Full-agent engine"
                  disabled={savingPrefs}
                  triggerStyle={sel as React.CSSProperties}
                  // Release scope (voice-final-public-release-2026-10-01#D-005): each
                  // full-agent engine below is visible but disabled when the release
                  // list marks it unavailable; a saved value is kept and explained.
                  options={[
                    { value: 'off', label: 'Off — use the STT + TTS pair below' },
                    ...([
                      ['openai-realtime', 'OpenAI Realtime (gpt-4o-realtime)'],
                      ['gemini-live', 'Google Gemini Live'],
                      ['elevenlabs-conv', 'ElevenLabs Conversational AI (Claude Haiku)'],
                    ] as const).map(([value, name]) => ({
                      value,
                      label: isFullAgentEngineUnavailable(value) ? `${name} — ${RELEASE_UNAVAILABLE_LABEL}` : name,
                      disabled: isFullAgentEngineUnavailable(value),
                    })),
                    // 'elevenlabs-conversational' is a legacy alias for 'elevenlabs-conv'
                    // (design memo: accept it when stored, never offer it). Only included
                    // when it IS the stored value so the trigger can render a label.
                    ...(fullAgentVal === 'elevenlabs-conversational'
                      ? [{ value: 'elevenlabs-conversational', label: `ElevenLabs Conversational AI (legacy) — ${RELEASE_UNAVAILABLE_LABEL}`, disabled: true }]
                      : []),
                  ]}
                />
                <p style={hint}>
                  Full-agent mode replaces the STT + TTS pair with a single conversational session.
                  This release supports voice through the STT + TTS pair below.
                </p>
                {isFullAgentEngineUnavailable(fullAgentVal) && (
                  <p role="alert" style={hint}>
                    {releaseUnavailableMessage(fullAgentVal)} Choose Off to use the STT + TTS pair.
                    Your saved engine preference has been kept.
                  </p>
                )}
              </div>

              {/* ── CLOUD API KEYS POINTER ────────────────────────────────
                  Sits directly under the full-agent engine selector, whose
                  options reference the keys it points to. Full catalog lives
                  on the dedicated /settings/api-keys page. */}
              <div style={{ marginBottom: 16, padding: 12, border: '1px dashed var(--border)', borderRadius: 4 }}>
                <p style={{ ...hint, margin: 0 }}>
                  Cloud API keys (OpenAI, ElevenLabs, Cartesia, Deepgram, Picovoice, Google AI) live on
                  the dedicated <RouteLink href="/settings/api-keys" style={{ textDecoration: 'underline' }}>API keys</RouteLink> page.
                </p>
              </div>

              {/* Inline key entry — the selected full-agent engine needs a cloud
                  key that isn't configured yet. The option stays selectable; picking
                  it reveals this box instead of being disabled. */}
              {needsKey && keyCfg && (
                <CloudKeyInline cfg={keyCfg} onSave={onSaveCloudKey} />
              )}

              {(prefs?.fullAgentEngine === 'elevenlabs-conv' ||
                prefs?.fullAgentEngine === 'elevenlabs-conversational') && (
                <>
                  <div style={{ marginBottom: 16 }}>
                    <label style={lbl}>ElevenLabs Agent ID</label>
                    <DraftInput
                      type="text"
                      aria-label="ElevenLabs Agent ID"
                      value={prefs?.elevenLabsAgentId ?? ''}
                      onCommit={(v) => savePrefsPatch({ elevenLabsAgentId: v.trim() })}
                      validate={(d) => {
                        const s = d.trim();
                        if (!s) return null; // empty = unset
                        if (/\s/.test(s)) return 'agent ids have no spaces';
                        if (!s.startsWith('agent_')) return 'ElevenLabs Conv AI agent ids start with agent_';
                        return null;
                      }}
                      placeholder="agent_…"
                      style={{ ...sel, fontFamily: "'SF Mono', monospace", fontSize: 12 }}
                    />
                    <p style={hint}>
                      Find this in your ElevenLabs Conv AI agent's settings page —
                      starts with <code>agent_</code>. Paired with your ElevenLabs API key
                      (set in /settings/api-keys), this is what voice connects to.
                    </p>
                  </div>
                  <ConvAgentVoice />
                </>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, ...sttTtsDimStyle }}
                   aria-disabled={fullAgentOn}>
                <div>
                  <label style={lbl}>STT (speech → text){fullAgentOn ? ' — overridden by full-agent' : ''}</label>
                  <Select
                    value={prefs?.sttEngine ?? 'voicemode'}
                    onChange={(v) => setSttEngine(v as SttEngineKind)}
                    ariaLabel="STT engine"
                    disabled={sttTtsDisabled}
                    triggerStyle={sel as React.CSSProperties}
                    options={[
                      { value: 'voicemode', label: 'Voicemode (Whisper, local)' },
                      { value: 'webspeech', label: 'Web Speech (browser cloud)' },
                      // Deepgram streaming STT was REMOVED from operator-core
                      // (voice-engine slim-down, 2026-07-09 — WI-3510). Not
                      // offered here anymore: selecting it silently degrades to
                      // wake-word listening (voice-mode.ts), which looked like a
                      // working "cloud STT" choice but wasn't. A stored
                      // sttEngine:'deepgram' preference still resolves via that
                      // fallback, same pattern as the elevenlabs-conversational
                      // legacy alias above — just no longer selectable here.
                      { value: 'off', label: 'Off' },
                    ]}
                  />
                  <p style={hint}>
                    Whisper runs locally — audio never leaves your machine. No whisper server
                    installed? Use “Install local voice” below; the operator then manages it
                    automatically.
                  </p>
                </div>
                <div>
                  <label style={lbl}>TTS (text → speech){fullAgentOn ? ' — overridden by full-agent' : ''}</label>
                  <Select
                    value={prefs?.ttsEngine ?? 'kokoro'}
                    onChange={(v) => setTtsEngine(v as TtsEngineKind)}
                    ariaLabel="TTS engine"
                    disabled={sttTtsDisabled}
                    triggerStyle={sel as React.CSSProperties}
                    options={[
                      { value: 'kokoro', label: 'Kokoro (Voicemode, local) — recommended' },
                      { value: 'browser', label: 'Browser (OS voices)' },
                      ...([
                        ['elevenlabs', 'ElevenLabs Turbo v2.5 (cloud, BYO key)'],
                        ['openai', 'OpenAI tts-1 (cloud, BYO key)'],
                        ['cartesia', 'Cartesia Sonic-2 (cloud, BYO key)'],
                      ] as const).map(([value, name]) => ({
                        value,
                        label: isTtsEngineUnavailable(value) ? `${name} — ${RELEASE_UNAVAILABLE_LABEL}` : name,
                        disabled: isTtsEngineUnavailable(value),
                      })),
                    ]}
                  />
                  {isTtsEngineUnavailable(prefs?.ttsEngine) && (
                    <p role="alert" style={hint}>
                      {releaseUnavailableMessage(String(prefs?.ttsEngine))} Your saved engine preference has been kept.
                    </p>
                  )}
                  <EnginePreview engine={prefs?.ttsEngine ?? 'kokoro'} />
                  <p style={hint}>
                    Kokoro uses a local server (port 8880) when one is running, else the built-in
                    engine from “Install local voice” below. Browser TTS works without setup but
                    quality varies by OS. ElevenLabs requires an API key below.
                  </p>
                </div>
                <LocalVoiceInstall />
              </div>
            </>
          );
        })()}

        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button variant="primary" onClick={onTestVoice}>Test voice</Button>
          <Button onClick={onRedetect}>Re-detect engines</Button>
          <p style={{ ...hint, margin: 0, flexBasis: '100%' }}>
            Test buttons play immediately even when voice mode is off — they're how you check the engine works.
            Toggle voice mode (mic icon in the header) to enable announcements during normal use.
          </p>
        </div>
      </section>

      {/* ── ELEVENLABS SUB-SECTION ───────────────────────────────── */}
      {prefs?.ttsEngine === 'elevenlabs' && (
        <section style={{ marginBottom: 32, padding: 16, background: 'color-mix(in srgb, var(--accent), transparent 96%)', borderRadius: 6 }}>
          <h2>ElevenLabs</h2>
          <p style={{ ...hint, marginBottom: 12 }}>
            Cloud TTS — text leaves the machine to ElevenLabs.
            BYO API key from <a href="https://elevenlabs.io" target="_blank" rel="noreferrer">elevenlabs.io</a>.
          </p>

          <div style={{ marginBottom: 16 }}>
            <label style={lbl}>API key</label>
            {credentials.configured ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <code style={{ padding: '6px 10px', background: 'var(--bg-1)', borderRadius: 4, fontSize: 13 }}>
                  {credentials.apiKey ?? '(masked)'}
                </code>
                <Button onClick={onTestConnection} disabled={testing}>
                  {testing ? 'Testing…' : 'Test connection'}
                </Button>
                <Button variant="destructive" onClick={onClearKey}>Clear</Button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="password"
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  placeholder="sk_..."
                  style={{ flex: 1, padding: '6px 10px', fontSize: 13, fontFamily: 'monospace' }}
                />
                <Button variant="primary" onClick={onSaveKey} disabled={!keyDraft.trim()}>Save</Button>
              </div>
            )}
          </div>

          {connTest && connTest.ok && (
            <div style={{ marginBottom: 12, padding: 8, background: 'color-mix(in srgb, var(--good), transparent 90%)', borderRadius: 4, fontSize: 13 }}>
              Connected as <strong>{connTest.email ?? '(no email)'}</strong> — <strong>{connTest.tier}</strong> tier
              · {connTest.characterCount?.toLocaleString()} / {connTest.characterLimit?.toLocaleString()} chars used
            </div>
          )}

          {credentials.configured && (
            <div style={{ marginBottom: 16 }}>
              <label style={lbl}>Default voice</label>
              <Select
                value={prefs?.elevenlabsVoiceId ?? '21m00Tcm4TlvDq8ikWAM'}
                onChange={(v) => savePrefsPatch({ elevenlabsVoiceId: v })}
                ariaLabel="Default ElevenLabs voice"
                triggerStyle={sel as React.CSSProperties}
                options={[
                  { value: '21m00Tcm4TlvDq8ikWAM', label: 'Adam (default)' },
                  ...elevenVoices.map((v) => ({ value: v.id, label: v.name })),
                ]}
              />
              <p style={hint}>Click &quot;Test connection&quot; above to populate the full voice list from your account.</p>
            </div>
          )}

          {spend && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 12 }}>
              <Stat label="Today" value={`$${(todaySpend?.estimatedUsd ?? 0).toFixed(2)}`} />
              <Stat label="Last 7 days" value={`$${spend.spend.reduce((a, d) => a + d.estimatedUsd, 0).toFixed(2)}`} />
              <Stat label="Soft cap" value={`$${spend.softCapUsd}`} />
              <Stat label="Hard cap" value={`$${spend.hardCapUsd}`} />
            </div>
          )}

          {spend && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
              <NumField
                label="Rate per 1k chars (USD)"
                value={spend.perKCharRate}
                step={0.01}
                onCommit={(n) => updateSpendKnob({ perKCharRate: n })}
                hint="Approximate; defaults to ElevenLabs Creator tier (~$0.18/1k). Check your dashboard for actual billing. Set to 0 to hide estimates."
              />
              <NumField
                label="Soft cap (USD/day)"
                value={spend.softCapUsd}
                step={1}
                onCommit={(n) => updateSpendKnob({ softCapUsd: n })}
                hint="Spoken nudge once per day when crossed."
              />
              <NumField
                label="Hard cap (USD/day)"
                value={spend.hardCapUsd}
                step={1}
                onCommit={(n) => updateSpendKnob({ hardCapUsd: n })}
                hint="Auto-fall-back to Kokoro/browser when crossed."
              />
            </div>
          )}

        </section>
      )}

      {/* STT spend lives outside the ElevenLabs sub-section — Deepgram is the cloud STT,
          unrelated to TTS engine choice. Only renders once the API has loaded the state. */}
      {sttSpend && (
        <section className="pc-settings-section">
          <h2>STT spend (Deepgram)</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 12 }}>
            <Stat label="Today" value={`${(sttSpend.spend[0]?.estimatedUsd ?? 0).toFixed(2)}`} />
            <Stat label="Minutes" value={(sttSpend.spend[0]?.minutes ?? 0).toFixed(1)} />
            <Stat label="Soft cap" value={`${sttSpend.softCapUsd}`} />
            <Stat label="Hard cap" value={`${sttSpend.hardCapUsd}`} />
          </div>
          <p style={hint}>
            Voicemode (local Whisper) and Web Speech are free; only Deepgram accrues spend.
            Recorded server-side from the capture loop's heartbeat.
          </p>
        </section>
      )}

      {/* ── OUTPUT BEHAVIOR (delegation-related) ─────────────────── */}
      {prefs && (
        <section className="pc-settings-section">
          <h2>Output behavior</h2>
          <div style={{ display: 'grid', gap: 12, fontSize: 13 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Checkbox
                checked={prefs.voicePanelAutoOpen ?? true}
                onChange={(v) => savePrefsPatch({ voicePanelAutoOpen: v })}
                disabled={savingPrefs}
              />
              <span>Auto-open the Papercup panel when voice delegates a complex task to Claude</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <Checkbox
                checked={prefs.narrateLongOps ?? true}
                onChange={(v) => savePrefsPatch({ narrateLongOps: v })}
                disabled={savingPrefs}
                style={{ marginTop: 3 }}
              />
              <span>
                <strong>Papercup narrates long operations</strong>
                <span style={hint}> — replan, supervisor, cleanup, provisioning. Side-channel TTS, doesn&apos;t use ElevenLabs Conv AI minutes.</span>
              </span>
            </label>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <Checkbox
                checked={prefs.operatorBackstoryEnabled ?? true}
                onChange={(v) => savePrefsPatch({ operatorBackstoryEnabled: v })}
                disabled={savingPrefs}
                style={{ marginTop: 3 }}
              />
              <span>
                <strong>Papercup references past experience</strong>
                <span style={hint}> — when relevant, may share short anecdotes from prior work. Limited to a few times per session.</span>
              </span>
            </label>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <Checkbox
                checked={prefs.operatorActiveOnStartup ?? true}
                onChange={(v) => savePrefsPatch({ operatorActiveOnStartup: v })}
                disabled={savingPrefs}
                style={{ marginTop: 3 }}
              />
              <span>
                <strong>Active mode on startup</strong>
                <span style={hint}> — every fresh app load starts Papercup in active mode (continuous turn-taking, draws ideas out of you). Off → starts passive (Papercup only responds when spoken to). Mid-session toggling via the navbar still works either way; the toggle resets on refresh per this setting.</span>
              </span>
            </label>
            <NumField
              label="Max spoken words for cached / readout content (longer → speak gist + show in panel)"
              ariaLabel="Max spoken words for cached or readout content"
              min={20}
              max={500}
              value={prefs.voiceMaxSpokenWords ?? 120}
              onCommit={(v) => savePrefsPatch({ voiceMaxSpokenWords: v })}
              inputStyle={{ ...sel, width: 120 }}
              hint={<>
                Default 120 words ≈ 60 seconds of speech. Above this threshold,
                voice speaks a one-sentence gist and the panel shows the full content.
              </>}
            />
            <NumField
              label={<>Auto-disconnect after this many minutes of <strong>user</strong> silence</>}
              ariaLabel="Auto-disconnect after minutes of user silence"
              min={0}
              max={60}
              value={prefs.fullAgentIdleTimeoutMin ?? 2}
              onCommit={(v) => savePrefsPatch({ fullAgentIdleTimeoutMin: v })}
              inputStyle={{ ...sel, width: 120 }}
              hint={<>
                Default <strong>2 minutes</strong>. Only counts USER silence — the agent talking
                doesn&apos;t reset the timer (so a chatty agent can&apos;t keep the session alive
                indefinitely). The mic streams continuously while connected; silence still costs
                minutes (~$0.08–0.30/min on EL). 0 disables auto-disconnect (not recommended).
              </>}
            />
            <NumField
              label="Hard maximum session duration (minutes)"
              ariaLabel="Hard maximum session duration in minutes"
              min={0}
              max={240}
              value={prefs.fullAgentSessionMaxMin ?? 30}
              onCommit={(v) => savePrefsPatch({ fullAgentSessionMaxMin: v })}
              inputStyle={{ ...sel, width: 120 }}
              hint={<>
                Default <strong>30 minutes</strong>. Backstop for edge cases — the session
                auto-disconnects after this many minutes regardless of activity. Tap the voice
                button to start another. 0 disables the cap.
              </>}
            />
            <NumField
              label="Silence-nudge grace before EL teardown (seconds)"
              ariaLabel="Silence-nudge grace before teardown in seconds"
              min={0}
              max={120}
              value={prefs.silenceNudgeGraceSecs ?? 30}
              onCommit={(v) => savePrefsPatch({ silenceNudgeGraceSecs: v })}
              inputStyle={{ ...sel, width: 120 }}
              hint={<>
                Default <strong>30 seconds</strong>. After the silence-nudge Ready card appears,
                tear down the active EL Conv AI session this many seconds later (saves credits
                during silence). Wake-word listener resumes when configured. 0 disables — EL
                stays up until its own idle timeout above. Range 5-120.
              </>}
            />
            <NumField
              label={<>Max `&lt;continue/&gt;` chain depth</>}
              ariaLabel="Max continue chain depth"
              min={1}
              max={20}
              value={prefs.maxConsecutiveContinues ?? 5}
              onCommit={(v) => savePrefsPatch({ maxConsecutiveContinues: v })}
              inputStyle={{ ...sel, width: 120 }}
              hint={<>
                Default <strong>5</strong>. When the brain narrates user-visible multi-step work
                (&quot;Did X, now doing Y&quot;), each `&lt;continue/&gt;` triggers another turn.
                Capped to prevent runaway chains. After this many in a row without user input,
                the runtime force-waits.
              </>}
            />
            <NumField
              label={<>Max `&lt;continue/&gt;` chain duration (seconds)</>}
              ariaLabel="Max continue chain duration in seconds"
              min={30}
              max={1800}
              value={prefs.maxContinueChainSecs ?? 300}
              onCommit={(v) => savePrefsPatch({ maxContinueChainSecs: v })}
              inputStyle={{ ...sel, width: 120 }}
              hint={<>
                Default <strong>300</strong> (5 min). Hard wall-clock cap on a single chain.
                Forces a wait once exceeded, regardless of how many chained turns ran. Range 30-1800.
              </>}
            />
            <NumField
              label="Papercup history budget (tokens)"
              ariaLabel="Papercup history budget in tokens"
              min={5000}
              max={150000}
              step={1000}
              value={prefs.operatorHistoryTokenBudget ?? 40000}
              onCommit={(v) => savePrefsPatch({ operatorHistoryTokenBudget: v })}
              inputStyle={{ ...sel, width: 140 }}
              hint={<>
                Default <strong>40000</strong>. How much chat history the operator brain sees per
                turn. Higher = better recall on long conversations, more cost per reply.
                Claude&apos;s full context is 200000 — we reserve the rest for the system prompt,
                tools, and the response. Range 5000–150000.
              </>}
            />
            <div>
              <label style={lbl}>Privacy mode for ElevenLabs / Realtime sessions</label>
              <Select
                value={prefs.voicePrivacyMode ?? 'always-on'}
                onChange={(v) => savePrefsPatch({ voicePrivacyMode: v as 'always-on' | 'wake-word-gated' })}
                ariaLabel="Voice privacy mode"
                disabled={savingPrefs}
                triggerStyle={sel as React.CSSProperties}
                options={[
                  { value: 'always-on', label: 'Always-on — mic streams continuously to the provider' },
                  { value: 'wake-word-gated', label: 'Wake-word-gated — local wake word starts the session on demand' },
                ]}
              />
              <p style={hint}>
                <strong>always-on</strong>: lowest latency, audio leaves the box at all times the session is
                connected. <strong>wake-word-gated</strong>: Porcupine / openWakeWord listens on-device;
                ElevenLabs only sees audio between &quot;{prefs.porcupineKeyword ?? prefs.openwakewordKeyword ?? 'wake word'}&quot;
                and the gated-idle timer. Adds ~1.5s on first turn after wake. Requires a wake-word engine
                set above (Porcupine or openWakeWord).
              </p>
            </div>
            <div>
              <label style={lbl}>Agent language</label>
              <Select
                value={prefs.agentLanguage && prefs.agentLanguage !== '' ? prefs.agentLanguage : '_auto'}
                onChange={(v) => savePrefsPatch({ agentLanguage: v === '_auto' ? '' : v })}
                ariaLabel="Agent language"
                disabled={savingPrefs}
                triggerStyle={sel as React.CSSProperties}
                options={[
                  { value: 'en', label: 'English (en)' },
                  { value: 'es', label: 'Spanish (es)' },
                  { value: 'fr', label: 'French (fr)' },
                  { value: 'de', label: 'German (de)' },
                  { value: 'pt', label: 'Portuguese (pt)' },
                  { value: 'it', label: 'Italian (it)' },
                  { value: 'nl', label: 'Dutch (nl)' },
                  { value: 'pl', label: 'Polish (pl)' },
                  { value: 'ja', label: 'Japanese (ja)' },
                  { value: 'ko', label: 'Korean (ko)' },
                  { value: 'zh', label: 'Chinese (zh)' },
                  { value: 'hi', label: 'Hindi (hi)' },
                  { value: 'ar', label: 'Arabic (ar)' },
                  { value: '_auto', label: '— Auto-detect (no pin)' },
                ]}
              />
              <p style={hint}>
                Pinning a language stops ElevenLabs&apos; speech-to-text auto-detect from flipping when
                background music or ambient noise has speech-like timbre — the cause of the &quot;operator
                started speaking Spanish while music was on&quot; failure mode. Default <strong>en</strong>.
                Set to <strong>Auto-detect</strong> only if you need the operator to understand
                multiple languages in one session; expect occasional mis-classifications with background
                audio.
              </p>
            </div>
            {prefs.voicePrivacyMode === 'wake-word-gated' && (
              <div>
                <label style={lbl}>Gated-mode idle timeout (seconds)</label>
                <input
                  aria-label="Gated-mode idle timeout in seconds"
                  type="number"
                  min={5}
                  max={300}
                  value={prefs.wakeGatedIdleTimeoutSec ?? 20}
                  onChange={(e) => {
                    const v = Math.max(5, Math.min(300, parseInt(e.target.value, 10) || 20));
                    savePrefsPatch({ wakeGatedIdleTimeoutSec: v });
                  }}
                  style={{ ...sel, width: 120 }}
                  disabled={savingPrefs}
                />
                <p style={hint}>
                  Default 20s. After this much silence within a wake-triggered session, mic returns to
                  on-device wake-word listening. Tighter than the always-on idle since restart is just
                  the wake word again.
                </p>
              </div>
            )}
            <div>
              <label style={lbl}>
                Hard monthly minute cap on ElevenLabs Conv AI
              </label>
              <input
                aria-label="Hard monthly minute cap on ElevenLabs Conv AI"
                type="number"
                min={0}
                max={50000}
                step={50}
                value={prefs.fullAgentMonthlyMinuteCap ?? 600}
                onChange={(e) => {
                  const v = Math.max(0, Math.min(50000, parseInt(e.target.value, 10) || 0));
                  savePrefsPatch({ fullAgentMonthlyMinuteCap: v });
                }}
                style={{ ...sel, width: 120 }}
                disabled={savingPrefs}
              />
              <ElSpendStatus />
              <ElSubscriptionStatus />
              <p style={hint}>
                Default 600 min (~10 hours). When the current month&apos;s usage hits this cap, new EL
                sessions refuse to start and you get a toast. 0 disables the cap. Usage is read
                directly from ElevenLabs <code>/v1/convai/conversations</code> (canonical) with a
                <code> harness_shared.el_conv_calls</code> fallback if the EL API is unreachable.
              </p>
            </div>
          </div>
        </section>
      )}

      {/* ── FEATURE TOGGLES ──────────────────────────────────────── */}
      {prefs && (
        <section className="pc-settings-section">
          <h2>Feature toggles</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 13 }}>
            {([
              ['speakSuggestions',       'Speak suggestions when they arrive in the panel'],
              ['speakBackgroundToasts',  'Speak background auto-fire toasts (with cancel cue)'],
              ['speakModeFlips',         'Speak Papercup active/passive mode flips (chatty)'],
              ['speakCadenceStatus',     'Speak scan-start / scan-done status (chatty)'],
              ['speakNudges',            'Speak budget / breaker / pause nudges'],
              ['wakeWordIntents',        'Enable "operator scan" wake-word commands'],
              ['speakOpenCards',         'Speak open card prompts aloud when voice is on'],
              ['cardAnsweringEnabled',   'Resolve voice-answerable cards from spoken answers'],
              ['speakSessionHandoff',    'Speak a cue when voice idles back to wake-word listening'],
              ['proactiveTicksEnabled',  'Active mode auto-suggests next steps when conversation idles'],
            ] as const).map(([key, label]) => (
              <label key={key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <Checkbox
                  checked={prefs[key]}
                  onChange={(v) => savePrefsPatch({ [key]: v } as any)}
                  disabled={savingPrefs}
                  ariaLabel={label}
                  style={{ marginTop: 2 }}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </section>
      )}

      {/* ── WAKE WORD + NOISE SUPPRESSION ────────────────────────── */}
      <section className="pc-settings-section">
        <h2>Wake word (always-on mode)</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            aria-label="Wake word phrase"
            type="text"
            value={config.wakeWord}
            onChange={(e) => onWakeWordChange(e.target.value)}
            style={{ padding: '6px 10px', minWidth: 240, fontSize: 14 }}
          />
          <WakeWordTestButton wakeWord={config.wakeWord} />
        </div>
        <p style={hint}>3-syllable phrase that doesn't appear in normal speech (e.g. "hey operator"). Click <strong>Test wake word</strong> to simulate the dispatch path without using your voice.</p>

        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
          {/* Wake-word engine: single enum (engine + keyword are paired). */}
          <label style={lbl}>Wake-word engine</label>
          <Select
            value={prefs?.wakeWordEngine ?? 'off'}
            onChange={(v) => savePrefsPatch({ wakeWordEngine: v as VoicePrefs['wakeWordEngine'] })}
            ariaLabel="Wake-word engine"
            disabled={savingPrefs}
            triggerStyle={{ ...sel, maxWidth: 360 } as React.CSSProperties}
            options={[
              { value: 'off', label: 'Off — string-match wake word in transcript' },
              { value: 'openwakeword', label: 'openWakeWord (Apache 2.0, no key)' },
              isWakeEngineUnavailable('porcupine')
                ? { value: 'porcupine', label: `Porcupine (Picovoice) — ${RELEASE_UNAVAILABLE_LABEL}`, disabled: true }
                : {
                    value: 'porcupine',
                    label: `Porcupine (Picovoice, BYO key${!allCreds?.picovoice?.configured ? ' — not configured' : ''})`,
                    disabled: !allCreds?.picovoice?.configured,
                  },
            ]}
          />
          <p style={hint}>
            On-device neural wake-word. Whisper only spins up AFTER the wake fires —
            big idle-CPU win when always-on mode is enabled.{' '}
            <strong>openWakeWord</strong> is open source and free; <strong>Porcupine</strong> is
            commercial (requires a Picovoice API key in the section above) but more accurate.
          </p>
          {prefs?.wakeWordEngine === 'porcupine' && (
            <div style={{ marginTop: 8 }}>
              <label style={lbl}>Porcupine keyword (built-in)</label>
              <Select
                value={prefs?.porcupineKeyword ?? 'Computer'}
                onChange={(v) => savePrefsPatch({ porcupineKeyword: v as VoicePrefs['porcupineKeyword'] })}
                ariaLabel="Porcupine keyword"
                disabled={savingPrefs}
                triggerStyle={{ ...sel, maxWidth: 240 } as React.CSSProperties}
                options={['Computer','Jarvis','Bumblebee','Picovoice','Porcupine','Alexa','Hey Google','Hey Siri','Okay Google','Terminator','Americano','Blueberry','Grapefruit','Grasshopper'].map((k) => ({ value: k, label: k }))}
              />
              <p style={hint}>Custom keywords need a .ppn file trained on Picovoice Console.</p>
            </div>
          )}
          {prefs?.wakeWordEngine === 'openwakeword' && (
            <div style={{ marginTop: 8 }}>
              <label style={lbl}>openWakeWord keyword (built-in)</label>
              <Select
                value={prefs?.openwakewordKeyword ?? 'hey_jarvis'}
                onChange={(v) => savePrefsPatch({ openwakewordKeyword: v as VoicePrefs['openwakewordKeyword'] })}
                ariaLabel="openWakeWord keyword"
                disabled={savingPrefs}
                triggerStyle={{ ...sel, maxWidth: 240 } as React.CSSProperties}
                options={['alexa', 'hey_jarvis', 'hey_mycroft', 'hey_rhasspy', 'ok_nabu', 'weather', 'timer'].map((k) => ({ value: k, label: k.replace(/_/g, ' ') }))}
              />
              <p style={hint}>
                Custom &quot;hey operator&quot; needs an ONNX classifier trained via the openWakeWord
                Colab/Kaggle tutorial (~30 min). Drop the .onnx into <code>/public/wake/</code>.
              </p>
            </div>
          )}

          {/* Noise suppression engine: single enum dropdown. */}
          <label style={{ ...lbl, marginTop: 16 }}>Noise suppression</label>
          <Select
            value={prefs?.noiseSuppressionEngine ?? 'browser'}
            onChange={(v) => savePrefsPatch({ noiseSuppressionEngine: v as VoicePrefs['noiseSuppressionEngine'] })}
            ariaLabel="Noise suppression engine"
            disabled={savingPrefs}
            triggerStyle={{ ...sel, maxWidth: 360 } as React.CSSProperties}
            options={[
              { value: 'off', label: 'Off — raw mic input' },
              { value: 'browser', label: 'Browser native (WebRTC noiseSuppression)' },
              { value: 'rnnoise', label: 'Jitsi RNNoise (BSD, stronger)' },
              {
                value: 'koala',
                label: `Picovoice Koala (BYO key${!allCreds?.picovoice?.configured ? ' — not configured' : ''})`,
                disabled: !allCreds?.picovoice?.configured,
              },
            ]}
          />
          <p style={hint}>
            Removes fan / keyboard / HVAC from the mic input before STT.
            Reduces VAD false positives. <strong>Browser native</strong> is the default and
            works without setup; the others trade higher CPU for stronger suppression.
          </p>
        </div>
      </section>

      <section className="pc-settings-section">
        <h2>Speech rate</h2>
        <input
          aria-label="Speech rate"
          type="range"
          min={0.5} max={2.0} step={0.1}
          value={config.rate}
          onChange={(e) => onRateUiChange(Number(e.target.value))}
          style={{ width: 240 }}
        />
        <span style={{ marginLeft: 12, fontSize: 13 }}>{config.rate.toFixed(1)}x</span>
      </section>

      {/* ── WEB SPEECH LEAK WARNING MODAL ────────────────────────── */}
      <Modal
        open={showLeakWarning}
        onOpenChange={(o) => { if (!o) setShowLeakWarning(false); }}
        title="⚠ Web Speech sends audio to the cloud"
        contentStyle={{ maxWidth: 480 }}
      >
        <h3 style={{ margin: '0 0 12px' }}>⚠ Web Speech sends audio to the cloud</h3>
        <p style={{ fontSize: 14, marginBottom: 16 }}>
          Web Speech sends audio to your browser vendor&apos;s cloud (Google for Chrome,
          Microsoft for Edge). Use only on machines where that&apos;s acceptable.
        </p>
        <p style={{ fontSize: 13, color: 'var(--fg-mute)', marginBottom: 16 }}>
          Voicemode (Whisper, local) is the default — audio never leaves your machine.
          You can re-enable Voicemode any time.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button onClick={() => setShowLeakWarning(false)}>Cancel</Button>
          <Button variant="destructive" onClick={ackLeakWarning}>
            I understand — use Web Speech
          </Button>
        </div>
      </Modal>
      {confirmEl}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, opacity: 0.6, textTransform: 'uppercase' }}>{label}</div>
      <strong style={{ fontSize: 18 }}>{value}</strong>
    </div>
  );
}

/**
 * Inline cloud-key entry shown directly under the full-agent engine selector
 * when the chosen engine needs a key that isn't configured yet. Saves through
 * the same /operator-credentials endpoint as the dedicated API-keys page, so
 * the user can pick an engine and supply its key without leaving voice settings.
 */
function CloudKeyInline({
  cfg, onSave,
}: {
  cfg: { field: string; label: string; placeholder: string; helpUrl: string };
  onSave: (field: string, value: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const doSave = async () => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    const ok = await onSave(cfg.field, draft);
    setBusy(false);
    if (ok) setDraft('');
  };
  return (
    <div style={{ marginBottom: 16, padding: 12, border: '1px solid var(--border)', borderRadius: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <label style={{ ...lbl, marginBottom: 0 }}>{cfg.label} API key — required for this engine</label>
        <a href={cfg.helpUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11, opacity: 0.7, flex: '0 0 auto' }}>get key →</a>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void doSave(); }}
          placeholder={cfg.placeholder}
          style={{ flex: 1, padding: '6px 10px', fontSize: 13, fontFamily: 'monospace' }}
        />
        <Button variant="primary" onClick={() => void doSave()} disabled={busy || !draft.trim()}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
      <p style={hint}>
        Stored locally in <code>~/.papercusp/credentials.json</code>. You can also manage it on the{' '}
        <RouteLink href="/settings/api-keys" style={{ textDecoration: 'underline' }}>API keys</RouteLink> page.
      </p>
    </div>
  );
}

function WakeWordTestButton({ wakeWord }: { wakeWord: string }) {
  type Stage =
    | 'idle'
    | 'prompting'      // we asked the user to speak; STT is hot
    | 'heard-correct'  // got the right phrase; intent fired
    | 'heard-other'    // STT got something but not what we asked for
    | 'timeout'        // no transcript after window
    | 'error';
  const [stage, setStage] = useState<Stage>('idle');
  const [transcript, setTranscript] = useState<string | null>(null);
  const phrase = `${wakeWord} open`;

  const run = async () => {
    setStage('prompting');
    setTranscript(null);
    const { onFinalUtterance, setVoiceMode } = await import('../../_components/voice/voice-mode');
    // Force a fresh always-on cycle. setVoiceMode early-returns when the
    // mode hasn't changed, so if the user is already in always-on the
    // capture loop won't re-spin. Toggle off → on to force a fresh start.
    type VoiceRestoreMode = 'off' | 'push-to-talk' | 'always-on' | null;
    let restoreMode: VoiceRestoreMode = null;
    try {
      const stMod = await import('../../_components/voice/voice-mode');
      const stCfg = stMod.getVoiceConfig();
      restoreMode = (stCfg.lastMode ?? 'off') as VoiceRestoreMode;
      setVoiceMode('off');
      // Brief tick so the prior capture tears down before we restart.
      await new Promise(r => setTimeout(r, 200));
      setVoiceMode('always-on');
    } catch { /* best-effort */ }

    let resolved = false;
    const expectedNorm = phrase.trim().toLowerCase();

    const unsub = onFinalUtterance((text) => {
      if (resolved) return;
      const norm = text.trim().toLowerCase();
      setTranscript(text);
      // Loose match: must contain the wake word + "open"
      const containsWake = norm.includes(wakeWord.toLowerCase());
      const containsVerb = /\bopen\b/.test(norm);
      if (containsWake && containsVerb) {
        resolved = true;
        setStage('heard-correct');
        unsub();
      } else if (norm.length > 1) {
        // Got SOMETHING but not the right thing — keep listening for the
        // remainder of the timeout window in case the user retries.
        setStage('heard-other');
      }
    });

    // 15s window
    setTimeout(() => {
      if (!resolved) {
        setStage((s) => (s === 'heard-correct' ? s : 'timeout'));
        unsub();
      }
      // Restore prior voice mode if we changed it.
      if (restoreMode && restoreMode !== 'always-on') {
        setVoiceMode(restoreMode);
      }
    }, 15000);
    void expectedNorm;
  };

  let label = 'Test wake word';
  if (stage === 'prompting') label = 'Listening…';
  else if (stage === 'heard-correct') label = '✓ Working — try again';
  else if (stage === 'heard-other') label = 'Heard something — try again';
  else if (stage === 'timeout') label = 'No audio — try again';
  else if (stage === 'error') label = 'Error — try again';

  return (
    <>
      <Button
        variant={stage === 'heard-correct' ? 'primary' : undefined}
        onClick={run}
        disabled={stage === 'prompting'}
      >
        {label}
      </Button>
      {stage === 'prompting' && (
        <span style={{ ...hint, marginTop: 0, marginLeft: 4, flexBasis: '100%' }}>
          Say <strong>"{phrase}"</strong> now. We'll wait up to 15 seconds. The Papercup panel should open if the pipeline is healthy.
        </span>
      )}
      {stage === 'heard-correct' && (
        <span style={{ ...hint, marginTop: 0, marginLeft: 4, flexBasis: '100%', color: 'var(--good)' }}>
          Heard: <em>"{transcript}"</em> — the Papercup panel should have opened.
        </span>
      )}
      {stage === 'heard-other' && transcript && (
        <span style={{ ...hint, marginTop: 0, marginLeft: 4, flexBasis: '100%' }}>
          Got: <em>"{transcript}"</em> — that's not "{phrase}". STT is working but didn't catch the wake phrase. Speak more clearly or retry.
        </span>
      )}
      {stage === 'timeout' && (
        <span style={{ ...hint, marginTop: 0, marginLeft: 4, flexBasis: '100%' }}>
          No audio captured in 15s. Check that Voicemode whisper is running, the mic isn't muted, and you've granted browser permission.
        </span>
      )}
    </>
  );
}

function ElSpendStatus() {
  const [data, setData] = useState<{ minutes_used: number; minutes_cap: number | null; ym: string; over_cap: boolean; pct_used: number | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch('/api/agent-mcp/operator-el-spend');
        if (!r.ok || cancelled) return;
        setData(await r.json());
      } catch { /* leave null */ }
    })();
    return () => { cancelled = true; };
  }, []);
  if (!data) return null;
  const cap = data.minutes_cap;
  const used = data.minutes_used;
  const pct = data.pct_used != null ? Math.round(data.pct_used * 100) : null;
  return (
    <div style={{ marginTop: 4, fontSize: 12, color: data.over_cap ? 'var(--bad)' : 'inherit' }}>
      This month ({data.ym}): <strong>{used} min</strong>
      {cap != null && (
        <>
          {' '}/ {cap} min ({pct}%)
          {data.over_cap && ' — cap reached, new sessions refused'}
        </>
      )}
      {cap == null && ' (uncapped)'}
    </div>
  );
}

function ElSubscriptionStatus() {
  type SubData = {
    tier: string | null;
    status: string | null;
    character_count: number;
    character_limit: number | null;
    character_limit_exceeded: boolean;
    pct_used: number | null;
    next_reset_unix: number | null;
    next_reset_iso: string | null;
    concurrent_session_limit: number | null;
    currency: string | null;
    billing_period: string | null;
    can_extend: boolean | null;
    source: 'elevenlabs' | 'no-key' | 'error';
    error_detail: string | null;
  };
  const [data, setData] = useState<SubData | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch('/api/agent-mcp/operator-el-subscription');
        if (!r.ok || cancelled) return;
        setData(await r.json());
      } catch { /* leave null */ }
    })();
    return () => { cancelled = true; };
  }, []);
  if (!data) return null;
  // No key configured — silent (the spend hint already covers the empty case).
  if (data.source === 'no-key') return null;
  // Error — surface clearly + actionable when it's the common scoped-key case.
  if (data.source === 'error') {
    const missingPerm = /missing_permissions|missing the permission/i.test(data.error_detail ?? '');
    return (
      <div style={{
        marginTop: 8, padding: 8, fontSize: 12, borderRadius: 6,
        background: missingPerm ? 'var(--warn-bg)' : 'color-mix(in srgb, var(--bad), transparent 90%)',
        color: missingPerm ? 'var(--warn)' : 'var(--bad)',
        border: `1px solid ${missingPerm ? 'var(--warn-border)' : 'color-mix(in srgb, var(--bad), transparent 65%)'}`,
      }}>
        <strong>ElevenLabs plan status: unavailable.</strong>
        {missingPerm ? (
          <>
            {' '}Your EL API key is missing the <code>user_read</code> permission, so we can&apos;t
            read your plan tier or character budget. Regenerate the key at{' '}
            <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noreferrer"
               style={{ color: 'inherit', textDecoration: 'underline' }}>
              elevenlabs.io/app/settings/api-keys
            </a>{' '}with <code>user_read</code> checked, then paste it on the Voice Credentials page.
          </>
        ) : (
          <> {data.error_detail}</>
        )}
      </div>
    );
  }
  const chars = data.character_count.toLocaleString();
  const limit = data.character_limit?.toLocaleString();
  const pct = data.pct_used != null ? Math.round(data.pct_used * 100) : null;
  const exceeded = data.character_limit_exceeded;
  const warn = !exceeded && (data.pct_used ?? 0) >= 0.8;
  const resetLabel = data.next_reset_unix
    ? new Date(data.next_reset_unix * 1000).toLocaleDateString(undefined, {
        month: 'short', day: 'numeric', year: 'numeric',
      })
    : null;
  return (
    <div style={{
      marginTop: 8, padding: 8, fontSize: 12, borderRadius: 6,
      background: exceeded ? 'color-mix(in srgb, var(--bad), transparent 90%)' : warn ? 'var(--warn-bg)' : 'var(--bg-raised)',
      color: exceeded ? 'var(--bad)' : warn ? 'var(--warn)' : 'var(--fg-dim)',
      border: `1px solid ${exceeded ? 'color-mix(in srgb, var(--bad), transparent 65%)' : warn ? 'var(--warn-border)' : 'var(--border)'}`,
    }}>
      <div>
        <strong>ElevenLabs plan</strong>
        {data.tier && <> · {data.tier}</>}
        {data.status && data.status !== 'active' && <> · <em>{data.status}</em></>}
      </div>
      {data.character_limit != null && (
        <div style={{ marginTop: 2 }}>
          Characters: <strong>{chars}</strong> / {limit} ({pct}%)
          {resetLabel && <> · resets {resetLabel}</>}
          {exceeded && ' — character cap reached'}
        </div>
      )}
      {data.character_limit == null && (
        <div style={{ marginTop: 2 }}>
          Characters used: <strong>{chars}</strong> (no plan cap){resetLabel && <> · resets {resetLabel}</>}
        </div>
      )}
      {data.concurrent_session_limit != null && (
        <div style={{ marginTop: 2 }}>
          Concurrent session limit: {data.concurrent_session_limit}
          {data.concurrent_session_limit <= 1 && (
            <> — only one EL session can run at a time across desktop + mobile</>
          )}
        </div>
      )}
      {exceeded && (
        <div style={{ marginTop: 4 }}>
          New EL sessions will fail with &quot;exceeds your quota limit&quot; until the period resets
          or you upgrade.
        </div>
      )}
    </div>
  );
}

/**
 * P-009 (voice-public-release-readiness-2026-07-12, plan D-009): the "Install local voice"
 * surface. One click provisions everything free/offline voice needs — the whisper-server
 * binary + ggml model (STT) and the kokoro ONNX model (in-process TTS) — downloaded on
 * demand (a few hundred MB, first run only). Kick-off is POST operator-voice-provision;
 * progress/result is polled from operator-voice-engine-health's `localVoice` block.
 * useState (not nuqs) on purpose: install progress is transient request lifecycle.
 */
function LocalVoiceInstall() {
  type Leg = { done: boolean; blocked?: string };
  type LocalVoice = {
    kokoroProvisioned: boolean;
    whisperProvisioned: boolean;
    installer: { running: boolean; whisperBinary: Leg; whisperModel: Leg; kokoro: Leg } | null;
  };
  const [lv, setLv] = useState<LocalVoice | null>(null);
  const [installing, setInstalling] = useState(false);

  const refresh = useCallback(async (): Promise<LocalVoice | null> => {
    try {
      const h = await fetch('/api/agent-mcp/operator-voice-engine-health').then((r) => (r.ok ? r.json() : null));
      if (h?.localVoice) {
        setLv(h.localVoice);
        return h.localVoice as LocalVoice;
      }
    } catch {
      /* health probe failure just leaves the block unrendered */
    }
    return null;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onInstall = async () => {
    setInstalling(true);
    const t = toast.loading('Installing local voice — downloads a few hundred MB on first run…');
    try {
      const kick = await fetch('/api/agent-mcp/operator-voice-provision', { method: 'POST' });
      if (!kick.ok) {
        toast.error(`Install kick-off failed: ${kick.status}`, { id: t });
        return;
      }
      // Poll until the installer settles (bounded ~15min; an operator restart mid-install
      // reads running:false and simply lands on whatever legs completed).
      let last: LocalVoice | null = null;
      for (let i = 0; i < 450; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        last = await refresh();
        if (last && (!last.installer || !last.installer.running)) break;
      }
      const ok = !!(last?.kokoroProvisioned && last?.whisperProvisioned);
      if (ok) {
        toast.success('Local voice installed — speech-to-text and text-to-speech now run on this machine', { id: t, duration: 8000 });
      } else {
        const blocked = [last?.installer?.whisperBinary, last?.installer?.whisperModel, last?.installer?.kokoro]
          .map((l) => l?.blocked)
          .filter(Boolean);
        toast.error(`Local voice install incomplete${blocked.length ? ` — ${blocked[0]}` : ''}`, { id: t, duration: 10000 });
      }
    } finally {
      setInstalling(false);
    }
  };

  if (!lv) return null;
  const allDone = lv.kokoroProvisioned && lv.whisperProvisioned;
  const m = (b: boolean) => (b ? '✓ installed' : '– not installed');
  return (
    <div style={{ gridColumn: '1 / -1', border: '1px solid var(--border, #333)', borderRadius: 8, padding: 12, marginTop: 4 }}>
      <label style={lbl}>Local voice (free, offline)</label>
      <p style={{ ...hint, marginTop: 4 }}>
        Whisper STT {m(lv.whisperProvisioned)} · Kokoro TTS {m(lv.kokoroProvisioned)}
        {lv.installer?.running ? ' — installing…' : ''}
      </p>
      {!allDone && (
        <Button onClick={onInstall} disabled={installing || !!lv.installer?.running}>
          {installing || lv.installer?.running ? 'Installing…' : 'Install local voice'}
        </Button>
      )}
      <p style={{ ...hint, marginTop: 6 }}>
        Runs speech recognition and speech synthesis entirely on this machine — no cloud key, audio never
        leaves your computer. One-time download (~250 MB); cloud engines stay available for lower latency.
      </p>
    </div>
  );
}

function EnginePreview({ engine }: { engine: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const onClick = async () => {
    setError(null);
    setBusy(true);
    try {
      if (engine === 'browser') {
        if (typeof window === 'undefined' || !window.speechSynthesis) {
          setError('Web Speech not available in this browser');
          return;
        }
        const u = new SpeechSynthesisUtterance('This is a sample of the operator voice.');
        u.onend = () => setBusy(false);
        u.onerror = () => { setError('browser TTS errored'); setBusy(false); };
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
        return;
      }
      const r = await fetch('/api/agent-mcp/operator-tts-preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ engine }),
      });
      if (!r.ok) {
        if (r.status === 404) setError('No API key configured for this engine');
        else setError(`Preview failed: ${r.status}`);
        setBusy(false);
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      if (audioRef.current) {
        try { audioRef.current.pause(); } catch {}
        URL.revokeObjectURL(audioRef.current.src);
      }
      const a = new Audio(url);
      audioRef.current = a;
      a.onended = () => { URL.revokeObjectURL(url); setBusy(false); };
      a.onerror = () => { setError('audio playback failed'); setBusy(false); };
      await a.play();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'preview errored');
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 6 }}>
      <Button onClick={onClick} disabled={busy}>
        {busy ? '▶ Playing…' : `▶ Preview ${engine}`}
      </Button>
      {error && <p style={{ ...hint, color: 'var(--bad)' }}>{error}</p>}
    </div>
  );
}


/**
 * Conv-AI agent voice control. Reads/writes the agent's tts.voice_id
 * (and optionally model_id) via /api/agent-mcp/operator-conv-voice,
 * which handles "voice not yet in your library" by adding the public
 * voice on demand. Persisting to el-agent-sync.mjs is a separate step
 * (run the script after you settle on a voice you like).
 */
function ConvAgentVoice(): React.JSX.Element {
  const [current, setCurrent] = useState<{ voiceId: string | null; voiceName: string | null; modelId: string | null } | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/agent-mcp/operator-conv-voice');
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        setMsg({ kind: 'err', text: body?.error ?? `read failed: ${r.status}` });
        return;
      }
      const j = await r.json();
      setCurrent({ voiceId: j.voiceId ?? null, voiceName: j.voiceName ?? null, modelId: j.modelId ?? null });
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const onSave = async () => {
    const voiceId = draft.trim();
    if (!voiceId) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/agent-mcp/operator-conv-voice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ voiceId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg({ kind: 'err', text: j?.error ?? `save failed: ${r.status}` });
      } else {
        setMsg({ kind: 'ok', text: `set to ${j.voiceName ?? voiceId}. End the active EL session and start a new one to hear it.` });
        setDraft('');
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  const onPreview = async () => {
    const voiceId = (draft.trim() || current?.voiceId || '').trim();
    if (!voiceId) return;
    setPreviewing(true); setMsg(null);
    try {
      const r = await fetch('/api/agent-mcp/operator-tts-preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ engine: 'elevenlabs', voiceId }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setMsg({ kind: 'err', text: j?.error ?? `preview failed: ${r.status}` });
        setPreviewing(false);
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      if (audioRef.current) {
        try { audioRef.current.pause(); } catch {}
        URL.revokeObjectURL(audioRef.current.src);
      }
      const a = new Audio(url);
      audioRef.current = a;
      a.onended = () => { URL.revokeObjectURL(url); setPreviewing(false); };
      a.onerror = () => { setPreviewing(false); };
      await a.play();
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
      setPreviewing(false);
    }
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <label style={lbl}>Conv AI agent voice</label>
      <div className="pc-settings-conv-voice-row" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value.trim())}
          placeholder={current?.voiceId ?? 'paste voice id'}
          style={{ ...sel, fontFamily: "'SF Mono', monospace", fontSize: 12, flex: 1 }}
          disabled={busy}
          onKeyDown={(e) => { if (e.key === 'Enter') void onSave(); }}
        />
        <Button onClick={onPreview} disabled={previewing || (!draft.trim() && !current?.voiceId)}>
          {previewing ? 'Playing…' : 'Preview'}
        </Button>
        <Button variant="primary" onClick={onSave} disabled={busy || !draft.trim()}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
      <p style={hint}>
        Currently: <code>{current?.voiceId ?? '(unknown)'}</code>
        {current?.voiceName ? ` — ${current.voiceName}` : ''}
        {current?.modelId ? ` · ${current.modelId}` : ''}.
        Browse voices at <a href="https://elevenlabs.io/app/voice-library" target="_blank" rel="noopener noreferrer">elevenlabs.io/app/voice-library</a>;
        paste any voice id and Save. Public voices are added to your library automatically.
        Preview synthesises a sample with the entered (or current) voice id without changing the agent.
      </p>
      {msg && (
        <p style={{ ...hint, color: msg.kind === 'err' ? 'var(--bad)' : 'var(--good)' }}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

const lbl: React.CSSProperties = { display: 'block', fontWeight: 700, fontSize: 12, marginBottom: 4 };
const sel: React.CSSProperties = { padding: '6px 10px', width: '100%', fontSize: 13 };
const hint: React.CSSProperties = { fontSize: 12, color: 'var(--fg-mute)', marginTop: 6 };
