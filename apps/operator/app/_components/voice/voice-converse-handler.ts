'use client';

/**
 * voice-converse-handler — the module-level seam that connects voice-IN to the
 * in-process Papercup converse brain (the desktop chat's OperatorConversationProvider).
 *
 * Voice architecture (plan voice-public-release-readiness D-001, owner-ratified
 * 2026-07-12): Papercup is a fast, always-on converse FRONT-END that speaks short
 * summaries; hard thinking is delegated to a detached brain (the deep-delegation
 * lane). Voice and typed text share ONE brain + ONE shared thread, so there is no
 * modality split-brain and — crucially — no dependency on a dev zellij dock pane.
 *
 * This REPLACES the `writeToSentinelPane` / `routeVoiceToSentinelPane` path, which
 * wrote the transcript into a `psu --role=sentinel` zellij pane's stdin. A normal
 * desktop user has no such dock, so `resolveDockSession()` returned `no-dock`, the
 * turn was dropped, and voice-mode fired "Agent did not respond" after 15s.
 *
 * Wiring: OperatorConversationProvider registers its `sendUserMessage` here on
 * mount (and clears it on unmount); VoiceAppBridge calls `submitVoiceTurn()` with
 * each final STT transcript. A module-level handle (rather than a React hook in
 * VoiceAppBridge) keeps the voice ingress decoupled from provider mount ordering
 * and degrades gracefully when no conversation is mounted.
 */

export type VoiceConverseHandler = (
  text: string,
  opts?: { spoken?: boolean },
) => void;

let handler: VoiceConverseHandler | null = null;

/** Provider registration seam. Pass the live `sendUserMessage`; pass null on unmount. */
export function setVoiceConverseHandler(h: VoiceConverseHandler | null): void {
  handler = h;
}

/** True when a conversation provider is mounted and listening for voice turns. */
export function hasVoiceConverseHandler(): boolean {
  return handler != null;
}

/**
 * Submit a final voice transcript as a SPOKEN user turn into the shared Papercup
 * conversation (spoken:true → the reply is synthesized back via the active TTS
 * engine, e.g. kokoro). Returns false when no provider is mounted, so the caller
 * can degrade (e.g. fall back to the legacy dock path on a dev machine).
 */
export function submitVoiceTurn(text: string): boolean {
  const t = text.trim();
  if (!t || !handler) return false;
  handler(t, { spoken: true });
  return true;
}
