'use client';

/**
 * OperatorVoiceAnnouncer (Phase 3c, v4 §2d).
 *
 * Closed-panel cadence-bound spoken status. When the panel is CLOSED
 * and voice mode is `always-on` AND `speakCadenceStatus` toggle is on,
 * speak:
 *   - "Scanning..." on background scan start
 *   - "Surfaced N suggestions, M auto-dispatched" on scan done
 *
 * When the panel is OPEN, the panel itself owns suggestion-arrival
 * announcements; this component stays silent to avoid double-speech.
 *
 * Also speaks, each behind its own pref:
 *   - open ask_choice cards      (speakOpenCards)
 *   - pause / resume nudges      (speakNudges)
 *   - active↔passive mode flips  (speakModeFlips)
 *
 * Listens to background-scan SSE via a shared event mechanism (the
 * BackgroundScanner exposes scan lifecycle via window CustomEvents).
 */

import { useEffect, useRef } from 'react';
import { speak, getVoiceState } from './voice-mode';
import { sharedState, subscribeOperatorState } from '@papercusp/operator-core/lib/operator-shared-state';
import { readOperatorModeFromSession, type OperatorMode } from '@papercusp/operator-core/lib/operator-converse-tags';
import { loadVoicePrefsClient } from './voice-prefs-client';

type ScanEvent = { kind: 'scan-start' } | { kind: 'scan-done'; suggestions: number; autoDispatched: number };
void (null as unknown as ScanEvent); // type used in event detail shape; kept for documentation

export function OperatorVoiceAnnouncer(): null {
  const lastScanStartRef = useRef<number>(0);

  useEffect(() => {
    const onScan = (e: Event) => {
      const ce = e as CustomEvent<{ kind: string; suggestions?: number; autoDispatched?: number }>;
      const detail = ce.detail;
      if (!detail) return;

      // Gate: voice mode = always-on, panel CLOSED, toggle on
      const v = getVoiceState();
      if (v.mode !== 'always-on') return;
      if (sharedState.open) return;
      const prefs = loadVoicePrefsClient();
      if (!prefs.speakCadenceStatus) return;

      if (detail.kind === 'scan-start') {
        // Dedup back-to-back scan-starts (debounce window collapses)
        const now = Date.now();
        if (now - lastScanStartRef.current < 30_000) return;
        lastScanStartRef.current = now;
        speak('Scanning workspace.', 'system:operator', 'polite');
      } else if (detail.kind === 'scan-done') {
        const n = detail.suggestions ?? 0;
        const m = detail.autoDispatched ?? 0;
        const base = n === 0
          ? 'Scan complete. No new suggestions.'
          : m > 0
            ? `Scan complete. Surfaced ${n} suggestion${n === 1 ? '' : 's'}, ${m} auto-dispatched.`
            : `Scan complete. Surfaced ${n} suggestion${n === 1 ? '' : 's'}.`;
        // Phase 6: append adaptive ack-latency when it differs significantly
        // from the static fallback (4 min). Pulled from the operator-stats
        // endpoint; fire-and-forget so we don't delay the speak.
        void fetch('/api/agent-mcp/operator-stats')
          .then((r) => r.ok ? r.json() : null)
          .then((stats) => {
            const ms: number | null = stats?.medianAckLatencyMs ?? null;
            if (ms !== null && Math.abs(ms - 240_000) > 60_000) {
              const sec = Math.round(ms / 1000);
              speak(`${base} Median ack ${sec} seconds.`, 'system:operator', 'polite');
            } else {
              speak(base, 'system:operator', 'polite');
            }
          })
          .catch(() => speak(base, 'system:operator', 'polite'));
      }
    };

    window.addEventListener('operator:scan', onScan as EventListener);

    // ── Open-card announcer (plan §C.4 + Phase 5) ────────────────
    // When a chat:ask_choice card appears on the state-snapshot
    // stream, speak its fallbackText (or prompt) aloud. Gating:
    //   - Voice must be ON (any mode, push-to-talk or always-on).
    //   - prefs.speakOpenCards toggle on.
    //   - Panel CLOSED — when open, the user can read the card
    //     themselves; the chat surface already shows it.
    // Idempotent per correlationId via the provider's dedup set;
    // this handler will only see one event per card.
    const onCardOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ correlationId?: string; prompt?: string; fallbackText?: string }>).detail;
      if (!detail || !detail.correlationId) return;
      const v = getVoiceState();
      if (v.mode === 'off') return;
      if (sharedState.open) return;
      const prefs = loadVoicePrefsClient();
      if (!prefs.speakOpenCards) return;
      const text = (detail.fallbackText ?? '').trim() || (detail.prompt ?? '').trim();
      if (!text) return;
      speak(text, 'system:operator', 'polite');
    };
    window.addEventListener('operator:cardOpen', onCardOpen as EventListener);

    // Pause nudge (v4 §2e): speak when paused state flips. Per-kind dedup
    // (5 min for pause) is server-side via voice-nudges; here we just fire
    // the request and let the server arbitrate.
    let lastPausedSpoken: boolean | null = null;
    const unsubPause = subscribeOperatorState((s) => {
      if (typeof s.paused !== 'boolean') return;
      // First observation anchors without speaking.
      if (lastPausedSpoken === null) { lastPausedSpoken = s.paused; return; }
      if (s.paused === lastPausedSpoken) return;
      lastPausedSpoken = s.paused;
      const v = getVoiceState();
      if (v.mode === 'off') return;
      const prefs = loadVoicePrefsClient();
      if (!prefs.speakNudges) return;
      // Fire-and-forget the dedup arbitration.
      void fetch('/api/agent-mcp/operator-nudge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'pause' }),
      }).then((r) => r.ok ? r.json() : { fired: false }).then((res) => {
        if (res.fired) {
          speak(s.paused ? 'Papercup paused.' : 'Papercup resumed.', 'system:operator-nudge', 'polite');
        }
      }).catch(() => {});
    });

    // Mode flips (settings-audit 2026-07-09). `speakModeFlips` — surfaced as
    // "Speak mode flips" on /settings/user and /settings/voice — was rendered,
    // persisted to PG, and read by NOTHING: the toggle did nothing at all. The
    // provider already broadcasts every active↔passive change as a
    // `papercusp:operatorMode` CustomEvent, so gate a spoken announcement on it.
    //
    // Anchor from sessionStorage (the provider's own source of truth) rather than
    // on the first event: the provider DISPATCHES 'passive' during startup when
    // operatorActiveOnStartup is false, and anchoring on the first event instead
    // would either announce that boot flip aloud or swallow the user's first real
    // toggle. Default 'active' matches the provider's safe default.
    let lastModeSpoken: OperatorMode = readOperatorModeFromSession() ?? 'active';
    const onModeFlip = (e: Event) => {
      const detail = (e as CustomEvent<{ mode?: OperatorMode }>).detail;
      const mode = detail?.mode;
      if (mode !== 'active' && mode !== 'passive') return;
      if (mode === lastModeSpoken) return; // idempotent re-broadcast, not a flip
      lastModeSpoken = mode;
      if (getVoiceState().mode === 'off') return;
      if (!loadVoicePrefsClient().speakModeFlips) return;
      speak(
        mode === 'active' ? 'Papercup active.' : 'Papercup passive.',
        'system:operator',
        'polite',
      );
    };
    window.addEventListener('papercusp:operatorMode', onModeFlip as EventListener);

    return () => {
      window.removeEventListener('operator:scan', onScan as EventListener);
      window.removeEventListener('operator:cardOpen', onCardOpen as EventListener);
      window.removeEventListener('papercusp:operatorMode', onModeFlip as EventListener);
      unsubPause();
    };
  }, []);

  return null;
}
