/**
 * Video degrade + cost-bounding policy — plan
 * holepunch-video-shared-harnesses-2026-06-05 (P-008, D-005).
 *
 * Two knobs keep cost bounded as a call grows:
 *  1. Quality LEVELS (resolution / framerate / bitrate), stepped DOWN as the
 *     peer count rises and on sustained packet loss — start 360p@15, mirror the
 *     audio AIMD instinct (multiplicative-ish step-down, gradual step-up).
 *  2. A hard cap on visible tiles, so a 30-person channel never renders 30
 *     decoders.
 *
 * Pure + unit-tested. The component drives it: `setPeerCount` on roster change,
 * `onLoss`/`onClean` on link-health signals, and reconfigures the encoder with
 * the returned config.
 */
import { DEFAULT_VIDEO_CONFIG, type VideoEncodeConfig } from './video-codec';

/** Hard cap on simultaneously-rendered camera tiles (D-005). */
export const VIDEO_TILE_CAP = 9;

/**
 * Quality ladder, best → worst. Index 0 is the DEFAULT_VIDEO_CONFIG (360p@15).
 * Codec = VP9 throughout — VP8/H.264 fail to decode on the ship-target WebKitGTK
 * (plan D-012); the codec stays behind the seam (DEFAULT_VIDEO_CONFIG.codec).
 */
const LADDER_CODEC = DEFAULT_VIDEO_CONFIG.codec;
export const QUALITY_LEVELS: readonly VideoEncodeConfig[] = [
  DEFAULT_VIDEO_CONFIG, // 640x360 @15 ~500k
  { codec: LADDER_CODEC, width: 426, height: 240, framerate: 12, bitrate: 300_000 },
  { codec: LADDER_CODEC, width: 320, height: 180, framerate: 10, bitrate: 180_000 },
  { codec: LADDER_CODEC, width: 256, height: 144, framerate: 8, bitrate: 100_000 },
];

const MAX_LEVEL = QUALITY_LEVELS.length - 1;

/**
 * The best level (lowest index) we ALLOW at a given peer count. More peers ⇒ the
 * operator fans your stream to more peers and you decode more streams, so the
 * floor degrades. 1–2 peers → full; 3–4 → L1; 5–8 → L2; 9+ → L3.
 */
export function minLevelForPeers(peerCount: number): number {
  if (peerCount <= 2) return 0;
  if (peerCount <= 4) return 1;
  if (peerCount <= 8) return 2;
  return 3;
}

/** Tiles actually rendered, capped (D-005). */
export function visibleTileCount(peerCount: number): number {
  return Math.min(Math.max(peerCount, 0), VIDEO_TILE_CAP);
}

/** How many peers are hidden behind the cap (for an "+N more" affordance). */
export function hiddenTileCount(peerCount: number): number {
  return Math.max(0, peerCount - VIDEO_TILE_CAP);
}

/** Estimated operator swarm UPLINK: your one stream fanned to each peer. */
export function estimateUplinkMbps(config: VideoEncodeConfig, peerCount: number): number {
  return (config.bitrate * Math.max(0, peerCount)) / 1e6;
}

/** Estimated client DOWNLINK: you receive each peer's stream (~same config). */
export function estimateDownlinkMbps(config: VideoEncodeConfig, visibleTiles: number): number {
  return (config.bitrate * Math.max(0, visibleTiles)) / 1e6;
}

export interface DegradeInput {
  webCodecsSupported: boolean;
  cameraDenied?: boolean;
  cameraError?: boolean;
}

/** True when video can't run → the grid shows audio-only avatars (D-005). */
export function shouldDegradeToAudioOnly(input: DegradeInput): boolean {
  return !input.webCodecsSupported || Boolean(input.cameraDenied) || Boolean(input.cameraError);
}

/**
 * Stateful quality controller. Holds the current level and steps it per signal,
 * never finer than the peer-count floor.
 */
export class VideoAdapter {
  private level: number;

  constructor(peerCount = 1) {
    this.level = minLevelForPeers(peerCount);
  }

  config(): VideoEncodeConfig {
    return QUALITY_LEVELS[this.level];
  }

  level_(): number {
    return this.level;
  }

  /** Roster changed: ensure we're no finer than the new floor (degrade if needed). */
  setPeerCount(peerCount: number): VideoEncodeConfig {
    const floor = minLevelForPeers(peerCount);
    if (this.level < floor) this.level = floor;
    return this.config();
  }

  /** Sustained loss → step down one quality level. */
  onLoss(): VideoEncodeConfig {
    this.level = Math.min(this.level + 1, MAX_LEVEL);
    return this.config();
  }

  /** Link recovered → step up one level, but not finer than the peer-count floor. */
  onClean(peerCount: number): VideoEncodeConfig {
    const floor = minLevelForPeers(peerCount);
    this.level = Math.max(this.level - 1, floor);
    return this.config();
  }
}
