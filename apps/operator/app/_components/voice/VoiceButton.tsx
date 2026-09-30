'use client';


/**
 * Voice mode toggle button. Lives in the Operator chat sidebar header.
 *
 * Click cycles: off → push-to-talk → always-on → off.
 * Long-press while in push-to-talk holds the mic open.
 */

import { useEffect, useState, useCallback, useRef, type ReactElement } from 'react';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';
import { navigateClient } from '@papercusp/operator-core/lib/client-navigation';
import { Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import { Tooltip } from '../../harness/Tooltip';
import {
  forceOperatorVoiceHost,
  getVoiceConfig,
  getOperatorVoiceSessionUiState,
  getVoiceState,
  initVoiceMode,
  setAudioReceiving,
  setMicCaptureError,
  setOperatorVoicePtt,
  setVoiceMode,
  startPushToTalk,
  stopPushToTalk,
  subscribeVoiceState,
  toggleOperatorVoiceBusMode,
  toggleOperatorVoiceMute,
  type VoiceState,
  type VoiceMode,
} from './voice-mode';
import { useMicLevel } from './useMicLevel';

const ICON: Record<VoiceState['status'], string> = {
  off: '🚫',
  connecting: '⏳',
  idle: '🎤',
  listening: '🔴',
  speaking: '🔊',
  paused: '⏸',
};

const NEXT_MODE: Record<VoiceMode, VoiceMode> = {
  'off': 'push-to-talk',
  'push-to-talk': 'always-on',
  'always-on': 'off',
};

// Short labels so the control fits the slim header box. Longer descriptions
// live in MODE_TITLE (the tooltip), so terseness here doesn't cost clarity.
const MODE_LABEL: Record<VoiceMode, string> = {
  'off': 'Off',
  'push-to-talk': 'PTT',
  'always-on': 'On',
};

const MODE_TITLE: Record<VoiceMode, string> = {
  'off': 'off',
  'push-to-talk': 'push-to-talk',
  'always-on': 'always-on',
};

const WAKE_HINT_SEEN_KEY = 'pc-voice-wake-hint-seen-v1';
const PTT_HINT_SEEN_KEY = 'pc-voice-ptt-hint-seen-v1';
// Push-to-talk key. Backtick (`) is reserved exclusively for PTT: it never
// types a literal backtick anywhere in the app except code editors / the
// terminal (see isCodeEntryTarget), so the key is always available to talk
// without colliding with text input. Easy to find by touch (top-left, below
// Escape). The listener is mounted whenever voice is supported (not just in
// push-to-talk mode) so holding it in always-on/off acts as a force-listen.
//
// `event.code === 'Backquote'` matches the physical key regardless of
// keyboard layout (US/UK/etc), which is more reliable than e.key.
const PTT_SHORTCUT_CODE = 'Backquote';
const PTT_SHORTCUT_LABEL = '`';

// Deep link to the OS-permissions step of the setup wizard — the canonical
// place to grant microphone access, pick the input device, and watch a live
// level meter. `/settings/voice` is engine/voice config, not permissions, so
// the "no audio detected" toast points here instead.
const MIC_PERMISSIONS_HREF = '/settings/setup-wizard?step=os-permissions';

// The backtick is reserved EXCLUSIVELY for push-to-talk — it never types a
// literal `` ` `` anywhere in the app, EXCEPT the surfaces below where a
// backtick is genuinely needed for input: code editors (CodeMirror / Monaco)
// and the terminal (xterm). In those, the key falls through to normal typing
// and PTT does not fire. Everywhere else (normal inputs, textareas,
// contenteditable, buttons, the page) the keystroke is swallowed and drives PTT.
function isCodeEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest('.cm-editor, .monaco-editor, .xterm, .xterm-screen');
}

/** Tiny CSS ring spinner — shown in place of a "Connecting…" word. */
function VoiceSpinner({ label }: { label: string }): ReactElement {
  return <span className="pc-voice-spinner" role="status" aria-label={label} />;
}

/**
 * Animated three-bar equalizer — the "actively listening" glyph that
 * replaces the "Listening…" / "Hearing you" text. Bars react bigger while
 * the mic is actually picking up voice (`hearing`).
 */
function VoiceListening({ hearing }: { hearing: boolean }): ReactElement {
  return (
    <span
      className={`pc-voice-listening${hearing ? ' is-hearing' : ''}`}
      role="status"
      aria-label={hearing ? 'Hearing you' : 'Listening'}
    >
      <i /><i /><i />
    </span>
  );
}

/** Pulsing speaker glyph — shown while the agent is talking (TTS playing). */
function VoiceSpeaking(): ReactElement {
  return <span className="pc-voice-speaking" role="status" aria-label="Speaking" />;
}

/** Three bouncing dots — the "agent is thinking" glyph (awaiting response). */
function VoiceThinking(): ReactElement {
  return (
    <span className="pc-voice-thinking" role="status" aria-label="Thinking">
      <i /><i /><i />
    </span>
  );
}

export function VoiceButton(): ReactElement {
  const [vs, setVs] = useState<VoiceState>(() => getVoiceState());
  const [sessionUi, setSessionUi] = useState(() => getOperatorVoiceSessionUiState());
  const [wakeWord, setWakeWord] = useState(() => getVoiceConfig().wakeWord);
  const [wakeHintSeen, setWakeHintSeen] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(wsLocalKey(WAKE_HINT_SEEN_KEY)) === '1';
  });
  const [pttHintSeen, setPttHintSeen] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(wsLocalKey(PTT_HINT_SEEN_KEY)) === '1';
  });
  const [pttHeld, setPttHeld] = useState(false);

  useEffect(() => {
    initVoiceMode();
    const unsub = subscribeVoiceState(setVs);
    return unsub;
  }, []);

  useEffect(() => {
    const syncSessionUi = () => setSessionUi(getOperatorVoiceSessionUiState());
    syncSessionUi();
    const onSessionChanged = () => syncSessionUi();
    window.addEventListener('papercusp:operatorVoiceSessionStateChanged', onSessionChanged as EventListener);
    return () => {
      window.removeEventListener('papercusp:operatorVoiceSessionStateChanged', onSessionChanged as EventListener);
    };
  }, []);

  // Surface phase-stall failures as toasts so the user can tell a
  // silent error apart from "still working." Wired via window event
  // from voice-mode.ts where the per-phase timers fire.
  useEffect(() => {
    const onTimeout = (e: Event) => {
      const detail = (e as CustomEvent<{ phase: string; message: string }>).detail;
      if (!detail?.message) return;
      // 'no-audio' means getUserMedia never delivered audio (permission
      // denied / wrong device / muted). Give the user a one-click path to
      // the mic-permissions page instead of a dead-end "check mic
      // permissions" string they can't act on.
      if (detail.phase === 'no-audio') {
        toast.error(detail.message, {
          action: {
            label: 'Mic permissions',
            onClick: () => navigateClient(MIC_PERMISSIONS_HREF),
          },
        });
        return;
      }
      toast.warning(detail.message);
    };
    window.addEventListener('papercusp:voiceTimeout', onTimeout as EventListener);
    return () => window.removeEventListener('papercusp:voiceTimeout', onTimeout as EventListener);
  }, []);

  useEffect(() => {
    const syncWakeWord = () => setWakeWord(getVoiceConfig().wakeWord);
    syncWakeWord();
    window.addEventListener('pc-voice-config-changed', syncWakeWord);
    window.addEventListener('focus', syncWakeWord);
    return () => {
      window.removeEventListener('pc-voice-config-changed', syncWakeWord);
      window.removeEventListener('focus', syncWakeWord);
    };
  }, []);

  const markWakeHintSeen = useCallback(() => {
    if (wakeHintSeen) return;
    setWakeHintSeen(true);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(wsLocalKey(WAKE_HINT_SEEN_KEY), '1');
      } catch {
        /* ignore storage issues */
      }
    }
  }, [wakeHintSeen]);

  const markPttHintSeen = useCallback(() => {
    if (pttHintSeen) return;
    setPttHintSeen(true);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(wsLocalKey(PTT_HINT_SEEN_KEY), '1');
      } catch {
        /* ignore storage issues */
      }
    }
  }, [pttHintSeen]);

  const busPttActive = sessionUi.active && sessionUi.mode === 'push-to-talk';

  const onClick = useCallback(() => {
    if (!vs.supported) {
      toast.error('Voice mode is not available in this environment.');
      return;
    }
    if (vs.mode === 'always-on') markWakeHintSeen();
    setVoiceMode(NEXT_MODE[vs.mode]);
  }, [markWakeHintSeen, vs.mode, vs.supported]);

  // Hold-detection threshold: a regular click (mousedown→mouseup within
  // ~250ms) is treated as a mode-cycle click only — onClick handles it.
  // Only sustained holds engage push-to-talk. Without this, every click
  // simultaneously fired startPushToTalk (loading MicVAD/Whisper) AND
  // setVoiceMode (loading EL/Realtime), and the two competed for the
  // mic — leaving EL's published track silent and the agent unable to
  // hear anything.
  const pttHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onPttDown = useCallback(() => {
    if (!vs.supported) return;
    if (pttHoldTimerRef.current) clearTimeout(pttHoldTimerRef.current);
    pttHoldTimerRef.current = setTimeout(() => {
      pttHoldTimerRef.current = null;
      setPttHeld(true);
      if (busPttActive) setOperatorVoicePtt(true);
      else startPushToTalk();
    }, 250);
  }, [busPttActive, vs.supported]);

  const onPttUp = useCallback(() => {
    // Held shorter than the threshold? Cancel the pending PTT start so
    // the click semantics (mode-cycle via onClick) are the only effect.
    if (pttHoldTimerRef.current) {
      clearTimeout(pttHoldTimerRef.current);
      pttHoldTimerRef.current = null;
      return;
    }
    if (!pttHeld) return;
    setPttHeld(false);
    if (busPttActive) setOperatorVoicePtt(false);
    else stopPushToTalk();
  }, [busPttActive, pttHeld]);

  // Hold-to-talk keyboard shortcut. Listener is mounted whenever voice
  // mode is "supported" (i.e. any voice path is viable), regardless of
  // current mode — holding the key in always-on mode acts as a force-
  // listen override; in off mode it temporarily activates the mic.
  // Previously the listener was gated on mode==='push-to-talk' which
  // made the key silently no-op in any other mode.
  useEffect(() => {
    if (!vs.supported) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== PTT_SHORTCUT_CODE) return;
      // Let modifier combos through — Ctrl+` / Cmd+` are real shortcuts.
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      // Code editors / terminal need a literal backtick — don't hijack it.
      if (isCodeEntryTarget(e.target)) return;
      // Reserve the backtick for PTT: swallow the character everywhere else,
      // including OS key-repeat while the key is held down.
      e.preventDefault();
      if (e.repeat) return;
      markPttHintSeen();
      if (pttHeld) return;
      setPttHeld(true);
      if (busPttActive) setOperatorVoicePtt(true);
      else startPushToTalk();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== PTT_SHORTCUT_CODE) return;
      if (!pttHeld) return;
      e.preventDefault();
      setPttHeld(false);
      if (busPttActive) setOperatorVoicePtt(false);
      else stopPushToTalk();
    };
    // Defensive: if the user releases the key while the window doesn't have
    // focus (alt-tab while held), keyup never fires. Treat blur as release.
    const onBlur = () => {
      if (!pttHeld) return;
      setPttHeld(false);
      if (busPttActive) setOperatorVoicePtt(false);
      else stopPushToTalk();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [busPttActive, markPttHintSeen, pttHeld, vs.supported]);

  // Live mic level — sampled whenever the mic is open. 'micActive' is
  // the CSS-class signal ("mic is hot, please show feedback") and the
  // analyser is its own visualization-only stream.
  const micActive =
    vs.mode === 'always-on' || vs.status === 'listening' || pttHeld;
  // Run the visualization analyser during PTT regardless of who owns
  // the mic. The previous "skip when micOwnedByFullAgent" rule was a
  // belt-and-suspenders guard against a Chrome-specific WebRTC issue
  // (two getUserMedia consumers contending). The cost of suppressing
  // it was: PTT users in always-on agent mode (EL Conv AI / Realtime)
  // got zero feedback — "I pressed the button, spoke, nothing
  // happened." For brief PTT holds (typical: 1-3s) the contention
  // risk is acceptable; for sustained always-on we keep the old
  // guard. Connecting still skipped — analyser nodes during ICE
  // negotiation can interleave audio init badly.
  const analyserActive =
    (pttHeld || (micActive && !vs.micOwnedByFullAgent)) &&
    vs.status !== 'connecting';
  const { ref: micRef } = useMicLevel(analyserActive, setAudioReceiving, setMicCaptureError);

  // Compact, glanceable status for the slim header box. Order matters:
  // speaking > awaiting > processing > actively-listening > connecting >
  // default mode. The busy/listening states render as icons (spinner /
  // equalizer) rather than words so they fit; persistent modes are short
  // labels (Off / PTT / On).
  let content: ReactElement;
  if (!vs.supported) {
    content = <span className="pc-voice-btn-label">No mic</span>;
  } else if (vs.status === 'speaking') {
    content = <VoiceSpeaking />;
  } else if (vs.awaitingResponse) {
    content = <VoiceThinking />;
  } else if (vs.processingTranscript) {
    content = <VoiceSpinner label="Processing" />;
  } else if (pttHeld || vs.audioReceiving) {
    content = <VoiceListening hearing={vs.audioReceiving} />;
  } else if (vs.status === 'connecting') {
    content = <VoiceSpinner label="Connecting" />;
  } else {
    content = <span className="pc-voice-btn-label">{MODE_LABEL[vs.mode]}</span>;
  }
  // P-003 honest wake copy: only advertise "Say <wakeWord>" when something
  // can actually HEAR it — a live wake-capable capture loop (wakeListening:
  // Silero/energy-VAD whisper, a wake-word engine, or the Web Speech wake
  // recognizer) or a full-agent session that owns the mic and hears
  // everything. On runtimes where neither holds (e.g. WebKitGTK without
  // local whisper AND without Web Speech), always-on used to show the wake
  // hint while NOTHING listened — the user spoke to a dead room. There, PTT
  // is the primary always-works trigger, so show the PTT hint instead.
  const wakeCanFire = vs.wakeListening || vs.micOwnedByFullAgent;
  const title = vs.status === 'connecting'
    ? 'Voice mode: connecting to agent (waiting for WebRTC negotiation)…'
    : vs.supported
    ? sessionUi.active
      ? `Voice mode: ${MODE_TITLE[vs.mode]} (shared session live; hold button or ${PTT_SHORTCUT_LABEL} for PTT, use mute/mode/host controls alongside)`
      : vs.mode === 'always-on' && !wakeCanFire
      ? `Voice mode: always-on, but wake listening is unavailable here — hold the button or ${PTT_SHORTCUT_LABEL} to talk`
      : `Voice mode: ${MODE_TITLE[vs.mode]} (click to cycle, hold button for PTT, hold ${PTT_SHORTCUT_LABEL} for keyboard PTT)`
    : 'Voice mode unsupported in this browser';
  // The hint bubbles ("Say <wakeWord>" / "Hold ` to talk") are persistent
  // affordances — keep them visible whenever the matching mode is active.
  // The historical 'seen' localStorage flags are kept up-to-date so any
  // future opt-out toggle can read them, but they no longer gate render.
  // Connecting is shown only as the in-button spinner now — no "Connecting…"
  // text hint bubble (keeps the control compact).
  const isConnecting = vs.status === 'connecting' && vs.supported;
  const showWakeHint = !isConnecting && vs.mode === 'always-on' && vs.supported && wakeCanFire;
  const showPttHint = !isConnecting && vs.supported &&
    (vs.mode === 'push-to-talk' || (vs.mode === 'always-on' && !wakeCanFire));

  return (
    <div className={`pc-voice-control${showWakeHint || showPttHint ? ' has-wake-hint' : ''}${isConnecting ? ' is-connecting' : ''}`}>
      <Tooltip label={title}><button
        type="button"
        aria-label="Voice mode"

        onClick={onClick}
        onMouseDown={onPttDown}
        onMouseUp={onPttUp}
        onMouseLeave={onPttUp}
        onTouchStart={onPttDown}
        onTouchEnd={onPttUp}
        ref={micRef as React.RefObject<HTMLButtonElement>}
        className={`pc-voice-btn pc-voice-btn--mode-${vs.mode} pc-voice-btn--status-${vs.status}${pttHeld ? ' is-held' : ''}${vs.supported ? '' : ' is-unsupported'}${micActive ? ' is-mic-active' : ''}${vs.wakeDetected ? ' is-wake-detected' : ''}${vs.userSpoke ? ' is-user-spoke' : ''}${vs.audioReceiving ? ' is-receiving-audio' : ''}${vs.processingTranscript ? ' is-processing-transcript' : ''}${vs.awaitingResponse ? ' is-awaiting-response' : ''}`}
      >
        <span className="pc-voice-btn-orb" aria-hidden="true">
          <span className="pc-voice-btn-level" aria-hidden="true" />
          <span className="pc-voice-btn-icon">{ICON[vs.status]}</span>
        </span>
        {content}
      </button></Tooltip>
      <Tooltip label="Open microphone settings">
        <a
          href="/settings/voice"
          className="pc-voice-settings-link"
          aria-label="Microphone settings"
          onClick={(e) => {
            // Plain left-click → soft client navigation. Without this the
            // bare <a> does a full document load, which on the desktop
            // re-bootstraps the whole SPA (several-second "reload"). Keep the
            // href so middle-click / modified-click / right-click still work.
            if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            navigateClient('/settings/voice');
          }}
        >
          {/* Icon-only to save space (owner ask 2026-06-23) — the "Voice" text
              label was dropped; the gear + aria-label/tooltip still name it. */}
          <Settings2 size={14} aria-hidden="true" />
        </a>
      </Tooltip>
      {sessionUi.active && (
        <div className="pc-voice-session-controls" aria-label="Shared voice session controls">
          <button
            type="button"
            className={`pc-voice-session-btn${sessionUi.muted ? ' is-active' : ''}`}
            aria-pressed={sessionUi.muted}
            aria-label={sessionUi.muted ? 'Unmute shared voice session' : 'Mute shared voice session'}
            onClick={() => {
              toggleOperatorVoiceMute();
            }}
          >
            {sessionUi.muted ? 'Muted' : 'Mute'}
          </button>
          <button
            type="button"
            className={`pc-voice-session-btn${sessionUi.mode === 'always-on' ? ' is-active' : ''}`}
            aria-pressed={sessionUi.mode === 'always-on'}
            aria-label={`Shared voice mode: ${sessionUi.mode === 'push-to-talk' ? 'push-to-talk' : 'always-on'}. Toggle mode.`}
            onClick={() => {
              toggleOperatorVoiceBusMode();
            }}
          >
            {sessionUi.mode === 'push-to-talk' ? 'PTT' : 'Live'}
          </button>
          <button
            type="button"
            className="pc-voice-session-btn"
            aria-label={sessionUi.elected ? 'This surface is already the shared voice host/player' : 'Force this surface to become the shared voice host/player'}
            disabled={sessionUi.elected}
            onClick={() => {
              if (!sessionUi.elected) forceOperatorVoiceHost();
            }}
          >
            {sessionUi.elected ? 'Host' : 'Take host'}
          </button>
        </div>
      )}
      {(showWakeHint || showPttHint) && (
        <div className="pc-voice-wake-hint" aria-live="polite">
          {showWakeHint ? (
            <>
              Say <strong>{wakeWord}</strong>
            </>
          ) : (
            <>
              Hold <strong>{PTT_SHORTCUT_LABEL}</strong> to talk
            </>
          )}
        </div>
      )}
    </div>
  );
}
