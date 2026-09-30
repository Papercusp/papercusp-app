'use client';


import { Tooltip } from '@/app/harness/Tooltip';
/**
 * OperatorActiveToggle — sidebar button that flips operator interaction
 * mode between active and passive.
 *
 * - Active = operator owns the conversation flow, speaks proactively
 *            (continuous turn-taking, silence prompts, etc.)
 * - Passive = operator only responds when spoken to.
 *
 * Either the user OR the operator (via <set_mode> tags) can flip the
 * mode; both writes go through the same sessionStorage hook in
 * lib/operator-converse-tags.ts. This component just owns the visible
 * control + visual state.
 *
 * Mode persistence is sessionStorage (resets per app open). Default on
 * first read is 'active' (matches the user's intent: "active mode by
 * default any time the user opens the app"). The /settings/voice
 * `activeOnStartup` toggle controls the seed; that lands in a later
 * commit.
 *
 * The control lives in the Operator chat sidebar header, next to the mic
 * and voice settings controls. It is NOT the deck/panel toggle — that one
 * stays in the main chrome.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  type OperatorMode,
  readOperatorModeFromSession,
  writeOperatorModeToSession,
  readSleepUntilMs,
  writeSleepUntilMs,
} from '@papercusp/operator-core/lib/operator-converse-tags';
import { useLexicon } from '@/lib/useLexicon';
import { loadVoicePrefsClient, subscribeVoicePrefsClient } from './voice/voice-prefs-client';

const MODE_CHANGE_EVENT = 'papercusp:operatorMode';
const SLEEP_CHANGE_EVENT = 'papercusp:operatorSleep';

/** Subscribe to mode changes (cross-component fanout via window event). */
function useOperatorMode(): [OperatorMode, (next: OperatorMode) => void] {
  // SSR-safe initial: 'active'. Hydration mounts and reads the actual
  // session value; the toggle visual flips on the first effect.
  const [mode, setModeLocal] = useState<OperatorMode>('active');

  useEffect(() => {
    const seeded = readOperatorModeFromSession() ?? 'active';
    setModeLocal(seeded);
    writeOperatorModeToSession(seeded);

    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<{ mode: OperatorMode }>).detail;
      if (detail?.mode === 'active' || detail?.mode === 'passive') {
        setModeLocal(detail.mode);
      }
    };
    window.addEventListener(MODE_CHANGE_EVENT, onChange as EventListener);
    return () => window.removeEventListener(MODE_CHANGE_EVENT, onChange as EventListener);
  }, []);

  const setMode = useCallback((next: OperatorMode) => {
    writeOperatorModeToSession(next);
    // Flipping TO active wakes the operator. Without this the chip
    // says "Active" but the silence-timer effect stays parked because
    // sleepUntilMs is still in the future from a prior <sleep> tag.
    // Fire the sleep-change event so the chip + provider's reactive
    // sleepUntilMs state both pick up the clear immediately rather
    // than waiting for the 5s tick poll. B5 of the audit.
    if (next === 'active') {
      writeSleepUntilMs(0);
      try { window.dispatchEvent(new Event(SLEEP_CHANGE_EVENT)); } catch { /* ignore */ }
    }
    setModeLocal(next);
    try {
      window.dispatchEvent(new CustomEvent(MODE_CHANGE_EVENT, { detail: { mode: next } }));
    } catch { /* ignore */ }
  }, []);

  return [mode, setMode];
}

/** Subscribe to sleep-until-ms changes. Returns the current value (0 = awake). */
function useOperatorSleepUntil(): number {
  const [sleepUntil, setSleepUntil] = useState(0);
  useEffect(() => {
    const refresh = () => setSleepUntil(readSleepUntilMs());
    refresh();
    window.addEventListener(SLEEP_CHANGE_EVENT, refresh);
    // When the deadline passes, re-render so the chip drops the
    // "(sleeping Nm)" suffix without the user having to refresh.
    // Pure UI timer over sessionStorage (no fetch) — the documented
    // UI-timer exception to the no-polling rule (audit P-058).
    const tick = setInterval(refresh, 5000);
    return () => {
      window.removeEventListener(SLEEP_CHANGE_EVENT, refresh);
      clearInterval(tick);
    };
  }, []);
  return sleepUntil;
}

/**
 * Subscribe to the provider's `sub` state via window event. Lets the
 * chip reflect quiet_wait without pulling in React context (the
 * toggle is rendered above the provider tree in the navbar).
 */
const SUB_CHANGE_EVENT = 'papercusp:operatorSub';
function useOperatorSub(): string {
  const [sub, setSub] = useState<string>('ready');
  useEffect(() => {
    const onSub = (e: Event) => {
      const detail = (e as CustomEvent<{ sub: string }>).detail;
      if (typeof detail?.sub === 'string') setSub(detail.sub);
    };
    window.addEventListener(SUB_CHANGE_EVENT, onSub as EventListener);
    return () => window.removeEventListener(SUB_CHANGE_EVENT, onSub as EventListener);
  }, []);
  return sub;
}

/**
 * Public hook other components (state machine, voice path, set_mode tag
 * dispatcher) use to read / write operator mode with cross-component fanout.
 */
export function useOperatorModeState() {
  return useOperatorMode();
}

/** Imperative setter usable from outside React (tag dispatcher, voice). */
export function setOperatorMode(next: OperatorMode): void {
  if (typeof window === 'undefined') return;
  writeOperatorModeToSession(next);
  try {
    window.dispatchEvent(new CustomEvent(MODE_CHANGE_EVENT, { detail: { mode: next } }));
  } catch { /* ignore */ }
}

/** Read the effective `silenceVoice` (Sentinel muted) + write the per-user
 *  override. Drives the toggle's "Off" state — the same flag the old
 *  "Pause Sentinel" control set (sentinel-tui-shared-backend §9, 2026-06-22). */
function useOperatorSilenced(): [boolean, (v: boolean) => void] {
  const [silenced, setSilencedLocal] = useState(() => loadVoicePrefsClient().silenceVoice ?? false);
  useEffect(() => {
    return subscribeVoicePrefsClient((prefs) => setSilencedLocal(prefs.silenceVoice ?? false));
  }, []);
  const setSilenced = useCallback((v: boolean) => {
    setSilencedLocal(v); // optimistic
    if (typeof fetch !== 'function') return;
    void fetch('/api/user/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ silenceVoice: v }),
    }).catch(() => { /* best-effort; local state already reflects it */ });
  }, []);
  return [silenced, setSilenced];
}

export function OperatorActiveToggle() {
  const [mode, setMode] = useOperatorMode();
  const [silenced, setSilenced] = useOperatorSilenced();
  const sleepUntil = useOperatorSleepUntil();
  const sub = useOperatorSub();
  // Persona name from the active brand pack — "Papercup" in classic (owner final
  // cast 2026-07-04, restore-pot-lexicon D-006; voice-release D-001: ONE
  // user-facing identity), "Sentinel" in the internal the-hive skin. Always
  // resolved via the lexicon, never hardcoded. Reactive via useLexicon → useFlag.
  const t = useLexicon();
  const persona = t('operator');
  // OFF is the 3rd toggle state (owner 2026-06-22): replaces the separate
  // "Pause Sentinel" control and drives the same `silenceVoice` flag, so the
  // Sentinel is muted exactly as Pause did. OFF outranks active/passive display.
  const off = silenced;
  const active = !off && mode === 'active';
  const sleepingMs = sleepUntil > 0 ? sleepUntil - Date.now() : 0;
  const sleeping = active && sleepingMs > 0;
  // Quiet = active mode that exhausted the silence ladder. Subordinate
  // to sleeping (if both, sleep wins because it has a deadline).
  const quiet = active && !sleeping && sub === 'quiet_wait';

  // Click cycles Active → Passive → Off → Active (sleeping/quiet wake as before).
  const onClick = useCallback(() => {
    if (off) {
      // Off → Active: un-mute the Sentinel and re-engage.
      setSilenced(false);
      setMode('active');
      return;
    }
    if (sleeping) {
      writeSleepUntilMs(0);
      try { window.dispatchEvent(new Event(SLEEP_CHANGE_EVENT)); } catch { /* ignore */ }
      return;
    }
    if (quiet) {
      // Quiet → click is a no-op for now; the user is supposed to type
      // in the chat to resume. Surfacing the state is the value.
      return;
    }
    if (active) {
      setMode('passive');
      return;
    }
    // Passive → Off: mute the Sentinel (silenceVoice).
    setSilenced(true);
  }, [off, active, sleeping, quiet, setMode, setSilenced]);

  const sleepLabel = sleeping
    ? sleepingMs < 60_000
      ? `${Math.max(1, Math.ceil(sleepingMs / 1000))}s`
      : `${Math.ceil(sleepingMs / 60_000)}m`
    : '';

  const stateClass = off ? 'off' : sleeping ? 'sleeping' : quiet ? 'quiet' : active ? 'active' : 'passive';
  const label = off
    ? 'Off'
    : sleeping
      ? `Sleeping ${sleepLabel}`
      : quiet
        ? 'Quiet'
        : active ? 'Active' : 'Passive';
  const aria = off
    ? `${persona} is off — voice muted. Click to turn on (active).`
    : sleeping
      ? `${persona} sleeping for ${sleepLabel}. Click to wake.`
      : quiet
        ? `${persona} is quiet — type to pick up where you left off.`
        : active
          ? `${persona} interaction mode: active. Click to set passive.`
          : `${persona} interaction mode: passive. Click to turn off.`;
  const title = off
    ? `${persona} is off — ${persona} voice is muted. Click to turn it back on.`
    : sleeping
      ? `${persona} went quiet for ${sleepLabel} (via <sleep> tag). Click to wake immediately.`
      : quiet
        ? `${persona} went silent after the silence ladder ran out. Type to wake it.`
        : active
          ? `${persona} is active — speaks proactively. Click to make passive.`
          : `${persona} is passive — only responds when spoken to. Click to turn it off (mute).`;
  const dotKind = (off || sleeping || quiet) ? 'static' : active ? 'pulsing' : 'static';

  return (
    <>
      <style>{TOGGLE_CSS}</style>
      <Tooltip label={title}><button
        type="button"
        onClick={onClick}
        className={`op-active-toggle op-active-toggle--${stateClass}`}
        aria-label={aria}

      >
        <span className={`op-active-toggle-dot op-active-toggle-dot--${dotKind}`} aria-hidden="true" />
        <span className="op-active-toggle-label">{label}</span>
      </button></Tooltip>
    </>
  );
}

const TOGGLE_CSS = `
.op-active-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 80%));
  color: var(--fg-mute, #94a3b8);
  cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease, color 140ms ease;
}
.op-active-toggle:hover {
  background: color-mix(in srgb, var(--accent-strong), transparent 90%);
  color: var(--fg, #e7eef7);
}
.op-active-toggle--active {
  background: color-mix(in srgb, var(--accent), transparent 86%);
  border-color: color-mix(in srgb, var(--accent), transparent 50%);
  color: var(--accent-strong, #7dd3fc);
}
.op-active-toggle--passive {
  /* default look */
}
.op-active-toggle--sleeping {
  background: rgba(148, 163, 184, 0.10);
  border-color: rgba(148, 163, 184, 0.40);
  color: var(--fg-mute, #94a3b8);
  font-style: italic;
}
.op-active-toggle--quiet {
  background: rgba(148, 163, 184, 0.06);
  border-color: rgba(148, 163, 184, 0.30);
  color: var(--fg-mute, #94a3b8);
  cursor: default;
}
.op-active-toggle--off {
  background: rgba(148, 163, 184, 0.10);
  border-color: rgba(148, 163, 184, 0.40);
  color: var(--fg-mute, #94a3b8);
}

.op-active-toggle-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: currentColor;
}
/* WI-6530: this dot used to pulse on a 1.25s infinite animation. ANY always-on
   animation keeps the whole 60fps repaint loop alive, and on this software-rendered
   webview that repaint costs ~40% of a CPU core permanently (measured: 48-63% of a
   core at idle with animations running, 9-16% with all of them paused; pausing only
   SOME buys nothing). The dot keeps its "active" read as a static halo — the mid-cycle
   glow the pulse spent most of its time showing — instead of animating to get there. */
.op-active-toggle-dot--pulsing {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent), transparent 82%);
}
`;
