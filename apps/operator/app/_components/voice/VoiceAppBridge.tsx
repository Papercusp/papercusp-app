'use client';

/**
 * Voice ingress bridge for app-level voice mode.
 *
 * When voice mode is enabled, a final spoken utterance is routed into the
 * live Sentinel voice path after wake-word intent handling and consumer
 * arbitration.
 *
 * This bridge:
 *   - Subscribes to voice utterances when voice mode is on.
 *   - Runs the legacy wake-word INTENT fast-path first (scan / approve),
 *     which short-circuits before any conversation routing.
 *   - Yields to a higher-priority registered voice consumer (e.g. a
 *     background-toast "say cancel" handler) when one is active.
 *   - Otherwise routes the transcript into the in-process Papercup converse
 *     brain (the operator chat sidebar's shared thread, submitVoiceTurn) —
 *     voice and text land in the SAME visible conversation
 *     (operator-chat-sidebar-revival-2026-07-13 P-007/D-001, reversing
 *     voice-public-release-readiness D-004's pane-primary routing: the
 *     zellij dock is now a TESTING-gated dev surface, not the shipped
 *     front-end). When FLAGS.TESTING is ON (the dock dev path), the
 *     transcript still goes to the dock's Papercup pane FIRST with a spoken
 *     instant ack, falling back to the converse thread when the pane is
 *     unavailable.
 *
 * The previous Oracle fallback (POST /api/oracle/chat) was removed
 * 2026-06-22: Oracle is a separate concierge brain (not the conversation)
 * and the endpoint 404s on the desktop host.
 */

import { useEffect, useRef } from 'react';
import {
  onFinalUtterance,
  subscribeVoiceState,
  cancelAllSpeech,
  getVoiceState,
  speak,
  type VoiceState,
} from './voice-mode';
import { routeVoiceToSentinelPane, drainSentinelOutput, drainHindsightForSpeech } from './voice-sentinel-bridge';
import { submitVoiceTurn } from './voice-converse-handler';
import { FLAGS } from '@papercusp/flags';
import { useFlag } from '@/lib/flag-hooks';

/**
 * Voice consumer priority registry (v4 §2b).
 *
 * Multiple chrome surfaces can claim utterances; the highest-priority
 * registered consumer wins. Oracle is the implicit lowest (no
 * registration needed — falls through when no consumer is registered).
 *
 * Priority order:
 *   panel-open               highest — the Operator panel is open
 *   background-toast         a 5s/8s undo toast is on-screen
 *   standing-approval-prompt (deferred per v4; reserved)
 *   oracle                   lowest, implicit
 */
export type VoiceConsumerPriority =
  | 'panel-open'
  | 'background-toast'
  | 'standing-approval-prompt';

const PRIORITY_RANK: Record<VoiceConsumerPriority, number> = {
  'panel-open': 100,
  'background-toast': 50,
  'standing-approval-prompt': 25,
};

interface Consumer {
  name: string;
  priority: VoiceConsumerPriority;
  /** Optional callback — when present, this consumer also handles the
   *  utterance directly (high-priority consumers like the toast cancel
   *  hook). When absent, the consumer's only effect is to suppress
   *  lower-priority routing. */
  onUtterance?: (text: string) => void;
}

const consumers: Map<string, Consumer> = new Map();
const consumerListeners = new Set<() => void>();

/**
 * Register a voice consumer. Defaults to `panel-open` priority for
 * back-compat with the original (name-only) signature.
 *
 * Returns a deregister function.
 */
export function registerVoiceConsumer(
  name: string,
  priority: VoiceConsumerPriority = 'panel-open',
  onUtterance?: (text: string) => void,
): () => void {
  consumers.set(name, { name, priority, onUtterance });
  consumerListeners.forEach((l) => l());
  return () => {
    consumers.delete(name);
    consumerListeners.forEach((l) => l());
  };
}

/** Highest-priority registered consumer, or null if none. */
function topConsumer(): Consumer | null {
  let best: Consumer | null = null;
  for (const c of consumers.values()) {
    if (!best || PRIORITY_RANK[c.priority] > PRIORITY_RANK[best.priority]) best = c;
  }
  return best;
}

function hasHigherPriorityConsumer(): boolean {
  return consumers.size > 0;
}

export function VoiceAppBridge(): null {
  // Seed from the live module state instead of a hand-enumerated literal —
  // the old partial literal silently went stale every time VoiceState grew
  // a field (and eventually stopped typechecking). subscribeVoiceState
  // overwrites it on the first change either way.
  const voiceStateRef = useRef<VoiceState>(getVoiceState());

  // Pane dev path (operator-chat-sidebar-revival P-007): the dock's Papercup
  // pane only exists when FLAGS.TESTING is on, so pane-first voice routing is
  // gated on it. Mirrored into a ref — the utterance handler + FIFO poll
  // below live in mount-once effects.
  const paneDevPath = useFlag(FLAGS.TESTING);
  const paneDevPathRef = useRef(paneDevPath);
  useEffect(() => {
    paneDevPathRef.current = paneDevPath;
  }, [paneDevPath]);

  useEffect(() => {
    const unsubState = subscribeVoiceState((s) => {
      voiceStateRef.current = s;
    });

    const unsubUtterance = onFinalUtterance(async (text) => {
      // Skip if voice mode is off.
      if (voiceStateRef.current.mode === 'off') return;
      if (!text || text.trim().length < 2) return;

      // Read voice prefs once: gates the intent fast-path AND the
      // converse routing below. When a full-agent engine (EL Conv AI /
      // OpenAI Realtime) is in charge, that engine owns the brain + voice
      // (it processes intents and replies itself), so we must NOT also
      // route the transcript into operator:converse — that would double-
      // dispatch into two brains. Phase 1 of sentinel-tui-shared-backend
      // assumes fullAgentEngine:'off', where converse IS the brain.
      let fullAgentActive = false;
      try {
        const { loadVoicePrefsClient } = await import('./voice-prefs-client');
        const prefs = loadVoicePrefsClient();
        fullAgentActive = !!prefs.fullAgentEngine && prefs.fullAgentEngine !== 'off';
        if (fullAgentActive) {
          throw new Error('full-agent in charge');
        }
        if (!prefs.wakeWordIntents) {
          // Skip intent parsing; fall through to consumer/converse routing.
          throw new Error('wake-word disabled');
        }
        const { parseOperatorIntent, resolveApprove } = await import('@papercusp/operator-core/lib/voice-intents');
        // Engine-agnostic wake-word strip: Voicemode/Deepgram deliver the
        // raw transcript ("hey papercup approve sheets") without going
        // through the Web Speech wake-word listener, so we re-prefix here
        // so parseOperatorIntent sees a parseable string. Web Speech path
        // already passes a normalized "operator …" string and is a no-op
        // through this helper.
        const { stripWakeWordAndPrefix } = await import('@papercusp/operator-core/lib/wake-word');
        const { getVoiceConfig } = await import('./voice-mode');
        const wakeWord = getVoiceConfig().wakeWord ?? 'hey papercup';
        const stripped = stripWakeWordAndPrefix(text, wakeWord);
        // Pulse the visual wake-detected indicator on the voice button
        // so the user sees a flash the moment we recognize the wake
        // word — even if the dispatch path errors below or the verb
        // doesn't parse. Same signal feeds Porcupine + openWakeWord.
        if (stripped.matched) {
          const { signalWakeDetected } = await import('./voice-mode');
          signalWakeDetected();
        }
        // Wake word with no verb → audible acknowledgement so the user
        // knows the engine heard them. They then need to say
        // "hey papercup <verb>" as a single utterance — there's no
        // separate listen-window like Siri.
        if (stripped.matched && !stripped.trailing) {
          const { speak } = await import('./voice-mode');
          speak('Say a command after the wake word, like "scan" or "approve sheets".', 'system:operator', 'polite');
          return;
        }
        const normalized = stripped.matched ? stripped.dispatchText : text;
        const intent = parseOperatorIntent(normalized);
        // No matching intent → tell the user, so silence isn't a black hole.
        if (stripped.matched && stripped.trailing && !intent) {
          const { speak } = await import('./voice-mode');
          speak(`I didn't recognize "${stripped.trailing}". Try scan, or approve followed by a harness name.`, 'system:operator', 'polite');
          return;
        }
        if (intent) {
          if (intent.kind === 'scan') {
            // D-005 (unify-agent-launches): a voice scan fires the `scan` launch
            // blueprint via the invoke route (loopback inside the desktop webview).
            // Findings land as work_items in the self-improvement backlog — the
            // operator-card panel is retired.
            const { speak } = await import('./voice-mode');
            void fetch('/api/harness/papercup/invoke?role=scanner', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                kickoff: intent.query
                  ? `Voice-requested workspace scan: ${intent.query}. Capture each finding via improvements:capture.`
                  : 'Voice-requested workspace scan. Capture each finding via improvements:capture.',
                extra: ['BLUEPRINT_ID=scan'],
                timeoutMs: 900_000,
              }),
            }).catch(() => { /* fire-and-forget — the cadence routine is the reliable path */ });
            speak('Started a workspace scan. Findings will land in the improvements backlog.', 'system:operator', 'polite');
            return;
          }
          if (intent.kind === 'approve') {
            // Fetch candidates + resolve.
            try {
              const r = await fetch('/api/agent-mcp/operator-standing-approvals');
              const body = await r.json();
              const result = resolveApprove(intent, body.candidates ?? []);
              const { speak } = await import('./voice-mode');
              if (result.action === 'approve' && result.capability) {
                await fetch('/api/agent-mcp/operator-standing-approvals', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    capability: result.capability,
                    targetHarness: result.targetSlug,
                    decision: 'approve',
                  }),
                });
                speak(`Approved ${result.capability.replace(':', ' ')} for ${result.targetSlug}.`, 'system:operator', 'polite');
              } else if (result.action === 'refuse-no-match') {
                speak(`No candidate matches ${result.targetSlug} that I've shown you yet. Open settings to review.`, 'system:operator', 'polite');
              } else if (result.action === 'refuse-ambiguous') {
                const opts = (result.options ?? []).map((o) => o.replace(':', ' ')).join(', or ');
                speak(`Multiple pending approvals for ${result.targetSlug}: ${opts}. Say operator approve ${result.targetSlug} followed by the capability.`, 'system:operator', 'polite');
              } else if (result.action === 'refuse-complex-cap') {
                speak(`That capability has a complex name. Please approve in operator settings.`, 'system:operator', 'polite');
              }
            } catch {
              /* network blip — settings UI is the fallback */
            }
            return;
          }
        }
      } catch {
        /* intent module not yet loaded — fall through to normal routing */
      }

      // Highest-priority consumer wins. If it has an `onUtterance`
      // handler (e.g. background-toast looking for "cancel"), let it
      // process the utterance and stop. If it has no handler (e.g.
      // panel-open consumer, which uses its own onFinalUtterance
      // subscription), still suppress Oracle routing.
      const top = topConsumer();
      if (top) {
        if (top.onUtterance) top.onUtterance(text);
        return;
      }
      if (hasHigherPriorityConsumer()) return;

      // Voice-IN → the Papercup CONVERSE thread (operator-chat-sidebar-revival
      // P-007/D-001, reversing voice-public-release-readiness D-004's
      // pane-primary routing): the operator chat sidebar is the shipped
      // front-end again and the zellij dock is TESTING-gated, so voice routes
      // into the SAME conversation the sidebar renders — the user SEES their
      // spoken turn + the reply in the chat, and the reply is spoken via the
      // active TTS engine (sendUserMessage spoken:true). Same user identity
      // as text (voice D-001).
      //
      // DEV PATH (FLAGS.TESTING on — the dock exists): the dock's Papercup
      // pane keeps priority (the pre-revival P-019/D-007 behavior): a psu
      // `--role=papercup` session on a fast model with the full tool surface;
      // its reply returns via the voice-OUT FIFO poll below, and a short
      // local ack covers the seconds a real pane turn takes. A failed pane
      // write still degrades to the converse thread.
      //
      // Guard: when a full-agent engine (EL Conv-AI / OpenAI Realtime) owns the
      // session it is its own brain, so don't double-dispatch.
      if (fullAgentActive) return;
      if (paneDevPathRef.current) {
        const paneOk = await routeVoiceToSentinelPane(text);
        if (paneOk) {
          // Instant ack (P-019): the pane turn is composing — tell the user we
          // heard them. Speaking also flips status → 'speaking', which clears
          // the awaitingResponse timeout window; the real reply lands via the
          // drainSentinelOutput poll below.
          speak('On it.', 'system:operator', 'polite', {
            preserveAwaitingResponse: true,
          });
          return;
        }
      }
      if (submitVoiceTurn(text)) {
        // The shipped converse brain commonly needs 15–24s before its first
        // substantive word. Acknowledge immediately so the voice turn feels
        // accepted, but DO NOT clear the response deadline: if the brain never
        // replies, the audible timeout still fires 45s after the transcript.
        speak('On it.', 'system:operator', 'polite', {
          preserveAwaitingResponse: true,
        });
      } else {
        // No conversation provider available (should not happen in the desktop
        // app — the provider mounts with the shell). The turn is dropped; the
        // awaitingResponse window will surface the miss.
      }
    });

    return () => {
      unsubState();
      unsubUtterance();
      cancelAllSpeech();
    };
  }, []);

  // Phase D voice-OUT (sentinel-as-claude-tui-2026-06-22): while voice mode is
  // on, poll the shared Sentinel spoken-output FIFO and speak each line via
  // local TTS. Local app user only.
  useEffect(() => {
    let stopped = false;
    const id = setInterval(() => {
      if (stopped || voiceStateRef.current.mode === 'off') return;
      // One-brain voice-OUT (voice-unified-sentinel-pipeline P-002): while a
      // full-agent session is live, the SERVER-side sentinel-says pump owns the
      // FIFO (synth + bus fan-out to every attached client) — this local-mode
      // poll must not compete for the drain.
      if (voiceStateRef.current.micOwnedByFullAgent) return;
      // NOT gated on the pane dev path (WI-4838 E): the FIFO is fed by
      // `voice:say` from ANY permitted agent, not just the dock pane. With
      // no full-agent session and no local drain, those lines used to queue
      // forever — the tool promised speech and delivered dead air. Voice
      // mode on + no full-agent session ⇒ this webview is the consumer.
      void (async () => {
        const says = await drainSentinelOutput();
        if (says.length === 0) return;
        const { speak } = await import('./voice-mode');
        for (const line of says) speak(line, 'system:operator', 'polite');
      })();
      // WI-5174: local-mode counterpart of voice-mode.ts's
      // drainHindsightOnConnect (full-agent-only — see drainHindsightForSpeech's
      // docstring). Same gating (mode on, no full-agent session) as the
      // Sentinel FIFO poll above.
      void (async () => {
        const lines = await drainHindsightForSpeech();
        if (lines.length === 0) return;
        const { speak } = await import('./voice-mode');
        for (const line of lines) speak(line, 'system:operator', 'polite');
      })();
    }, 1500);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  return null;
}
