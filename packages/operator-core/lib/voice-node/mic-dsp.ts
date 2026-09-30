/**
 * Mic-path DSP chain (holepunch-voice-channels P-010 / D-013) — the
 * operator-side stage between the local clients' raw 48 kHz capture and the
 * channel encoder: **gain → AEC → spectral NS**, each leg driven by the
 * voice prefs (P-016):
 *
 *   • `voiceInputGain`          — clamped PCM gain (unity = skipped)
 *   • `voiceAec`                — NLMS echo canceller (@papercusp/audio-dsp);
 *                                 far-end = the local MIX (what the user hears),
 *                                 fed by the manager's mixed-frame fan-out
 *   • `voiceNoiseSuppression` + `noiseSuppressionEngine === 'rnnoise'`
 *                               — RNNoise WASM spectral suppression. The
 *                                 'browser' engine means the CLIENT suppresses
 *                                 (desktop getUserMedia constraint) — the
 *                                 operator must not double-suppress; 'koala'
 *                                 has no operator binding (BYO-key, unwired).
 *
 * Sited here per D-010/D-013: the operator holds both the decoded mic path and
 * the playback reference AEC needs to subtract. Frames whose DSP isn't ready
 * yet (WASM still loading) pass through unprocessed — never block audio.
 *
 * Real-audio efficacy (does the echo audibly vanish?) needs a physical
 * speaker→mic loop and is the hardware-gated remainder; the chain's plumbing,
 * pref wiring, and the cores' behaviour are unit-tested.
 */
import {
  NlmsAec,
  applyGainPcm16,
  type NoiseSuppressor,
} from '@papercusp/audio-dsp';
import { createRnnoiseSuppressor } from './rnnoise-suppressor';
import type { VoicePrefs } from '../voice-prefs';

export interface MicDspConfig {
  inputGain: number;
  aec: boolean;
  noiseSuppression: boolean;
  nsEngine: VoicePrefs['noiseSuppressionEngine'];
}

export function micDspConfigFromPrefs(prefs: Pick<
  VoicePrefs,
  'voiceInputGain' | 'voiceAec' | 'voiceNoiseSuppression' | 'noiseSuppressionEngine'
>): MicDspConfig {
  return {
    inputGain: prefs.voiceInputGain,
    aec: prefs.voiceAec,
    noiseSuppression: prefs.voiceNoiseSuppression,
    nsEngine: prefs.noiseSuppressionEngine,
  };
}

export interface MicDspStatus {
  gain: number;
  aec: boolean;
  /** 'rnnoise' when the operator-side suppressor is active; else 'off'. */
  ns: 'rnnoise' | 'off';
  /** AEC bulk-delay estimate (samples @48k), null before lock / when off. */
  aecDelaySamples: number | null;
  /** Running ERLE in dB, null when AEC is off. */
  erleDb: number | null;
}

export interface MicDsp {
  /** Apply a config (idempotent; loads the NS WASM lazily when first needed). */
  configure(cfg: MicDspConfig): Promise<void>;
  /** Feed one local-playback frame — the AEC far-end reference. */
  pushFarEnd(frame: Int16Array): void;
  /** Process one mic frame through the active chain. */
  process(frame: Int16Array): Int16Array;
  /** Drop adaptive state (channel left — the echo path is gone). */
  reset(): void;
  status(): MicDspStatus;
}

export interface MicDspDeps {
  /** NS factory seam (tests inject a stub; default = RNNoise WASM). */
  nsFactory?: () => Promise<NoiseSuppressor>;
  /** AEC factory seam. */
  aecFactory?: () => NlmsAec;
}

export function createMicDsp(deps: MicDspDeps = {}): MicDsp {
  const nsFactory = deps.nsFactory ?? createRnnoiseSuppressor;
  const aecFactory = deps.aecFactory ?? (() => new NlmsAec());

  let gain = 1;
  let aec: NlmsAec | null = null;
  let ns: NoiseSuppressor | null = null;
  let nsWanted = false;
  let nsLoading: Promise<void> | null = null;

  async function ensureNs(): Promise<void> {
    if (ns || nsLoading) return nsLoading ?? undefined;
    nsLoading = nsFactory()
      .then((s) => {
        // Config may have flipped off while the WASM loaded.
        if (nsWanted) ns = s;
        else s.destroy?.();
      })
      .catch((e) => {
        console.warn('[mic-dsp] noise suppressor failed to load:', e);
      })
      .finally(() => {
        nsLoading = null;
      });
    return nsLoading;
  }

  return {
    async configure(cfg: MicDspConfig): Promise<void> {
      gain = Number.isFinite(cfg.inputGain) && cfg.inputGain > 0 ? cfg.inputGain : 1;
      if (cfg.aec && !aec) aec = aecFactory();
      else if (!cfg.aec && aec) aec = null;
      nsWanted = cfg.noiseSuppression && cfg.nsEngine === 'rnnoise';
      if (nsWanted) {
        await ensureNs();
      } else if (ns) {
        ns.destroy?.();
        ns = null;
      }
    },
    pushFarEnd(frame: Int16Array): void {
      aec?.pushFarEnd(frame);
    },
    process(frame: Int16Array): Int16Array {
      let out = applyGainPcm16(frame, gain);
      if (aec) out = aec.process(out);
      if (ns) out = ns.process(out);
      return out;
    },
    reset(): void {
      // Re-create adaptive state lazily; the room/echo path changed.
      if (aec) aec = aecFactory();
    },
    status(): MicDspStatus {
      return {
        gain,
        aec: aec !== null,
        ns: ns ? 'rnnoise' : 'off',
        aecDelaySamples: aec?.estimatedDelaySamples() ?? null,
        erleDb: aec ? aec.erleDb() : null,
      };
    },
  };
}
