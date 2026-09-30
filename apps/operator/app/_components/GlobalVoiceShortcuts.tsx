'use client';

/**
 * Discord-parity voice shortcuts (discord-shortcuts 2026-06-06):
 *
 *   - Mod+Shift+M — toggle mic mute on the SHARED operator-voice session.
 *     A bus control: applies once at the session host, and the host's
 *     session_state broadcast updates every attached surface (P-004 of
 *     universal-voice-interface-2026-06-05).
 *   - Mod+Shift+D — toggle LOCAL deafen: this surface keeps receiving
 *     transcripts/state but silences its own playout.
 *
 * Both are silent no-ops when no bus session is active — same as pressing
 * Discord's combos outside a call. Mounted once at the app shell; renders
 * nothing.
 */
import { useShortcutAction } from '../../lib/hotkeys';
import {
  forceOperatorVoiceHost,
  toggleOperatorVoiceBusMode,
  toggleOperatorVoiceDeafen,
  toggleOperatorVoiceMute,
} from './voice/voice-mode';

export default function GlobalVoiceShortcuts() {
  // enableOnFormTags mirrors Discord — mute/deafen work while typing.
  const opts = { enableOnFormTags: ['INPUT', 'TEXTAREA'] as const };

  useShortcutAction('voice.toggleMute', () => {
    toggleOperatorVoiceMute();
  }, opts);

  useShortcutAction('voice.toggleDeafen', () => {
    toggleOperatorVoiceDeafen();
  }, opts);

  useShortcutAction('voice.toggleMode', () => {
    toggleOperatorVoiceBusMode();
  }, opts);

  useShortcutAction('voice.forceHost', () => {
    forceOperatorVoiceHost();
  }, opts);

  return null;
}
