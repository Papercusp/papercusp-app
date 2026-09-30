/**
 * Participant-grid pure state — plan holepunch-video-shared-harnesses-2026-06-05
 * (P-006). All the grid's derivable shape lives here so it can be unit-tested
 * without mounting media: who renders a tile vs an avatar, who's the active
 * speaker, the self PiP, and the capped/overflow counts. VideoGrid.tsx is a thin
 * shell over this.
 */
import { VIDEO_TILE_CAP, hiddenTileCount } from '../../lib/video/adaptation';
import type { VoicePeerStatus } from '../../lib/video/desktop-video-client';

export interface GridTile {
  id: string;
  label: string;
  kind: 'self' | 'peer';
  /** Render a live camera tile when true, an avatar when false. */
  cameraOn: boolean;
  muted: boolean;
  speaking: boolean;
  isActiveSpeaker: boolean;
}

export interface SelfState {
  id: string;
  label: string;
  cameraOn: boolean;
  muted: boolean;
}

/**
 * The active speaker is the speaking peer (deterministic by id for stability).
 * Self is never the active speaker (you don't highlight your own PiP). Returns
 * null when nobody is speaking.
 */
export function pickActiveSpeaker(peers: VoicePeerStatus[]): string | null {
  const speaking = peers
    .filter((p) => p.speaking)
    .map((p) => p.id)
    .sort((a, b) => a.localeCompare(b));
  return speaking[0] ?? null;
}

export interface BuildGridInput {
  peers: VoicePeerStatus[];
  self: SelfState;
  /** Audio-only degrade (no WebCodecs / camera denied): every tile is an avatar. */
  audioOnly?: boolean;
}

export interface GridModel {
  self: GridTile;
  peerTiles: GridTile[];
  /** Peers beyond VIDEO_TILE_CAP (surface as "+N more"). */
  hiddenCount: number;
  activeSpeakerId: string | null;
  /** No peers in the channel yet → render the waiting state. */
  empty: boolean;
}

export function buildGridModel(input: BuildGridInput): GridModel {
  const activeSpeakerId = pickActiveSpeaker(input.peers);
  const sorted = [...input.peers].sort((a, b) => a.id.localeCompare(b.id));
  const peerTiles: GridTile[] = sorted.slice(0, VIDEO_TILE_CAP).map((p) => ({
    id: p.id,
    label: p.label,
    kind: 'peer',
    cameraOn: input.audioOnly ? false : p.cameraOn,
    muted: p.muted,
    speaking: p.speaking,
    isActiveSpeaker: p.id === activeSpeakerId,
  }));
  const self: GridTile = {
    id: input.self.id,
    label: input.self.label,
    kind: 'self',
    cameraOn: input.audioOnly ? false : input.self.cameraOn,
    muted: input.self.muted,
    speaking: false,
    isActiveSpeaker: false,
  };
  return {
    self,
    peerTiles,
    hiddenCount: hiddenTileCount(input.peers.length),
    activeSpeakerId,
    empty: input.peers.length === 0,
  };
}
