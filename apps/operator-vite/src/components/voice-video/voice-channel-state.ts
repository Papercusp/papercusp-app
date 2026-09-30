/**
 * Pure view-model for the desktop voice-channel panel
 * (holepunch-voice-channels-2026-06-05 P-015, D-014) — the testable shape
 * behind `VoiceChannelPanel`, mirroring `video-grid-state.ts` for the grid.
 * Mirrors the pui Voice tab's semantics: channel list, in-channel peers with
 * speaking/muted state, the agent-speaking indicator, and the mic meter.
 */
import type { VoiceChannelState } from '../../lib/voice/desktop-voice-channel-runtime';

export interface VoiceChannelRowVm {
  id: string;
  name: string;
  /** This row is the channel we are currently in. */
  active: boolean;
}

export interface VoicePeerVm {
  id: string;
  label: string;
  speaking: boolean;
  muted: boolean;
}

export interface VoiceChannelViewModel {
  connected: boolean;
  rows: VoiceChannelRowVm[];
  inChannel: {
    id: string;
    name: string;
    muted: boolean;
    agentSpeaking: boolean;
    peers: VoicePeerVm[];
  } | null;
  /** Mic level for the meter, 0..100 (already perception-scaled). */
  micLevelPct: number;
  micError: string | null;
  lastError: string | null;
}

/**
 * RMS 0..1 → meter percent 0..100. Square-root scaling so quiet speech
 * (RMS ~0.02–0.1) still moves the meter visibly (the pui meter does the
 * same job with a bar of block glyphs).
 */
export function meterPct(rms: number): number {
  if (!(rms > 0)) return 0;
  return Math.min(100, Math.round(Math.sqrt(Math.min(1, rms)) * 100));
}

export function buildVoiceChannelModel(state: VoiceChannelState): VoiceChannelViewModel {
  const current = state.status?.channel ?? null;
  const rows: VoiceChannelRowVm[] = state.channels.map((c) => ({
    id: c.id,
    name: c.name,
    active: current != null && c.id === current.id,
  }));
  return {
    connected: state.connected,
    rows,
    inChannel: current
      ? {
          id: current.id,
          name: current.name ?? current.id,
          muted: state.status?.muted === true,
          agentSpeaking: state.status?.agentSpeaking === true,
          peers: (state.status?.peers ?? []).map((p) => ({
            id: p.id,
            label: p.label,
            speaking: p.speaking,
            muted: p.muted,
          })),
        }
      : null,
    micLevelPct: meterPct(state.micLevel),
    micError: state.micError,
    lastError: state.lastError,
  };
}
