'use client';

/**
 * Listens for delegation lifecycle events:
 *   - operator:delegation-start  — emitted right before the SSE stream
 *     begins. We arm announceOpStart('delegate') so the side-channel
 *     TTS fires periodic "still researching" mid-narrations.
 *   - operator:delegation-complete — emitted on terminal SSE event. We
 *     stash the result in operator-shared-state, optionally auto-open
 *     the panel, and fire announceOpEnd('delegate') for the audio cue.
 *
 * Mounted once at the chrome shell level; no UI of its own.
 */

import { useEffect, useRef } from 'react';
import type { NarrationHandle } from '@papercusp/operator-core/lib/voice-narration';
import { loadVoicePrefsClient } from './voice/voice-prefs-client';

export default function OperatorDelegationListener() {
  const narrationHandle = useRef<NarrationHandle | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const onStart = async () => {
      // Cancel any previous handle (back-to-back delegations) before
      // arming a new one. announceOpStart for 'delegate' is silent on
      // kickoff but schedules the mid-narration timers.
      narrationHandle.current?.cancel();
      try {
        const { announceOpStart } = await import('@papercusp/operator-core/lib/voice-narration');
        narrationHandle.current = announceOpStart('delegate');
      } catch { /* best-effort */ }
    };

    const onDelegation = async (evt: Event) => {
      const detail = (evt as CustomEvent).detail as
        | { fullText?: string; agentSessionId?: string | null; costUsd?: number }
        | undefined;
      if (!detail) return;

      // Read pref to decide auto-open. Don't block the panel update on it.
      const autoOpen = loadVoicePrefsClient().voicePanelAutoOpen !== false;

      try {
        const { setOperatorState } = await import('@papercusp/operator-core/lib/operator-shared-state');
        // Stash the latest delegation result on the shared state so the
        // panel can render it. We extend the state object with a
        // best-effort structural cast — older readers ignore unknown keys.
        setOperatorState({
          ...(autoOpen ? { open: true } : {}),
          // @ts-expect-error: lastDelegation is added in PR 3 but the
          // shared-state type is in libs/papercusp; widen later.
          lastDelegation: {
            fullText: detail.fullText ?? '',
            agentSessionId: detail.agentSessionId ?? null,
            costUsd: detail.costUsd ?? 0,
            ts: Date.now(),
          },
        });
      } catch { /* ignore */ }

      // Audio cue: side-channel TTS announces completion so the user
      // gets a signal even when the panel was already open or they're
      // in another tab. Short and concrete; the panel shows the full
      // gist. Honors the narrateLongOps pref same as op narration.
      // The handle from operator:delegation-start carries the pending
      // mid-narration timers — pass it so they get cancelled cleanly.
      try {
        const { announceOpEnd } = await import('@papercusp/operator-core/lib/voice-narration');
        announceOpEnd('delegate', { outcome: 'ok' }, narrationHandle.current ?? undefined);
        narrationHandle.current = null;
      } catch { /* narration is best-effort */ }
    };

    /**
     * Async-delegate completion: the long-delegate path returns
     * `{ status: 'started' }` synchronously and finishes in the
     * background. When done, it fires this event so the live EL
     * session gets a contextual update — without it the agent would
     * have already said "looking into that" minutes ago and never
     * speak about the result.
     */
    const onAsyncDelegation = async (evt: Event) => {
      const detail = (evt as CustomEvent).detail as
        | { status?: 'complete' | 'error'; fullText?: string; agentSessionId?: string | null; task?: string; message?: string }
        | undefined;
      if (!detail) return;
      const sid = detail.agentSessionId ? detail.agentSessionId.slice(0, 8) : '';
      const headline = detail.status === 'error'
        ? `[Delegate ${sid} failed] ${detail.message ?? 'unknown error'}.`
        : `[Delegate ${sid} completed] ${(detail.fullText ?? '').slice(0, 280)}${(detail.fullText ?? '').length > 280 ? '…' : ''} Full text in the panel.`;
      let delivered = false;
      try {
        const { sendSystemToActiveSession } = await import('./voice/voice-mode');
        delivered = sendSystemToActiveSession(headline);
      } catch { /* voice-mode not loaded; treat as undelivered */ }
      if (!delivered) {
        // No live EL session — stash on the operator's coord-inbox hindsight channel
        // (collapse-delegate D-003) for the next "[While you were away]" briefing.
        try {
          await fetch('/api/agent-mcp/operator-hindsight', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ headline, kind: 'delegate-complete' }),
          });
        } catch { /* best-effort; panel still has the result */ }
      }
    };

    /**
     * Scan completion — same Hindsight-inbox pattern as delegates.
     * The background scanner fires `operator:scan` with kind:'scan-done'
     * when an SSE scan finishes. If a live EL session is connected we
     * push the headline as a contextual update so the agent can mention
     * findings on its next turn. If not, stash to inbox so the *next*
     * EL session announces it via the "[While you were away]" briefing.
     *
     * Only fires for scans that emitted ≥1 suggestion — empty scans
     * aren't worth interrupting the user about.
     */
    const onScan = async (evt: Event) => {
      const detail = (evt as CustomEvent).detail as
        | { kind?: string; suggestions?: number; autoDispatched?: number }
        | undefined;
      if (!detail || detail.kind !== 'scan-done') return;
      const n = detail.suggestions ?? 0;
      if (n === 0) return;
      const auto = detail.autoDispatched ?? 0;
      const headline = auto > 0
        ? `[Scan complete] ${n} suggestion${n === 1 ? '' : 's'} surfaced (${auto} auto-dispatched). Details in the panel.`
        : `[Scan complete] ${n} suggestion${n === 1 ? '' : 's'} surfaced. Details in the panel.`;
      let delivered = false;
      try {
        const { sendSystemToActiveSession } = await import('./voice/voice-mode');
        delivered = sendSystemToActiveSession(headline);
      } catch { /* voice-mode not loaded */ }
      if (!delivered) {
        try {
          await fetch('/api/agent-mcp/operator-hindsight', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ headline, kind: 'scan-complete' }),
          });
        } catch { /* best-effort */ }
      }
    };

    window.addEventListener('operator:delegation-start', onStart as EventListener);
    window.addEventListener('operator:delegation-complete', onDelegation as EventListener);
    window.addEventListener('operator:delegation-async-complete', onAsyncDelegation as EventListener);
    window.addEventListener('operator:scan', onScan as EventListener);
    return () => {
      window.removeEventListener('operator:delegation-start', onStart as EventListener);
      window.removeEventListener('operator:delegation-complete', onDelegation as EventListener);
      window.removeEventListener('operator:delegation-async-complete', onAsyncDelegation as EventListener);
      window.removeEventListener('operator:scan', onScan as EventListener);
      narrationHandle.current?.cancel();
      narrationHandle.current = null;
    };
  }, []);

  return null;
}
