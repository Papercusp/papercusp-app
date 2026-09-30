/**
 * Desktop video wire protocol — plan holepunch-video-shared-harnesses-2026-06-05
 * (P-005, D-007/D-008).
 *
 * The Tauri webview talks to its local operator voice node over the
 * desktop-voice-ws byte-pipe, which speaks the same `[4B len][1B type][payload]`
 * framing as the unix voice socket. Video uses two types alongside the audio
 * CTRL/MIC/MIX:
 *   CAM 0x04 (webview→operator)  one opaque encoded video frame → fanned per-peer
 *   VID 0x05 (operator→webview)  one peer's video: [1B idLen][peerId utf8][video payload]
 *
 * The video payload itself (`[1B flags][8B ts][chunk]`) is encoded/decoded with
 * @papercusp/p2p-voice's encodeVideoPayload/decodeVideo — the same unit the
 * operator relays opaquely, so there is exactly one video wire format end-to-end.
 *
 * Pure (no WebSocket / WebCodecs) → fully unit-tested. The browser orchestration
 * lives in desktop-video-client.ts.
 */
import { encodeFrame, encodeVideoPayload, decodeVideo, type VideoFrameMeta } from '@papercusp/p2p-voice';
import type { EncodedVideoFrame } from './video-codec';

/** Local-voice-socket frame types (mirror local-audio-socket.ts). */
export const CTRL = 0x01;
export const MIC = 0x02;
export const MIX = 0x03;
export const CAM = 0x04;
export const VID = 0x05;

export const DESKTOP_VOICE_WS_PATH = '/api/desktop/voice';
/**
 * Default WS URL. The operator's desktop voice bridge listens on
 * DESKTOP_VOICE_WS_PORT (default 3076) with an 8-port walk on EADDRINUSE.
 * Deterministic discovery of a walked port rides the same webview runtime-config
 * surface as holepunch-voice P-015 (D-014); until that lands the common default
 * is correct (the walk only triggers when 3076 is taken).
 */
export const DEFAULT_DESKTOP_VOICE_WS_URL = 'ws://127.0.0.1:3076/api/desktop/voice';

const te = new TextEncoder();
const td = new TextDecoder();

/** A CTRL frame carrying a JSON op. */
export function buildCtrl(msg: unknown): Uint8Array {
  return encodeFrame(CTRL, te.encode(JSON.stringify(msg)));
}

export const buildJoin = (channel: string): Uint8Array => buildCtrl({ op: 'join', channel });
/** Join the deterministic per-harness video channel (D-003). */
export const buildJoinVideo = (harness: string): Uint8Array => buildCtrl({ op: 'joinVideo', harness });
export const buildLeave = (): Uint8Array => buildCtrl({ op: 'leave' });
export const buildMute = (muted: boolean): Uint8Array => buildCtrl({ op: 'mute', muted });
/** Opt this connection in/out of receiving peer VID frames. */
export const buildVideoRecv = (recv: boolean): Uint8Array => buildCtrl({ op: 'video', recv });
/** Announce local camera on/off to peers. */
export const buildCamera = (on: boolean): Uint8Array => buildCtrl({ op: 'camera', on });

/** One outbound encoded video frame → a CAM wire frame. */
export function buildCamFrame(meta: VideoFrameMeta, data: Uint8Array): Uint8Array {
  return encodeFrame(CAM, encodeVideoPayload(meta, data));
}

/**
 * Parse an inbound VID frame payload (`[1B idLen][peerId][video payload]`) into
 * the sender id + decoded EncodedVideoFrame. Returns null if malformed.
 */
export function parseVidFrame(payload: Uint8Array): { peerId: string; frame: EncodedVideoFrame } | null {
  if (payload.length < 1) return null;
  const idLen = payload[0];
  if (payload.length < 1 + idLen) return null;
  const peerId = td.decode(payload.subarray(1, 1 + idLen));
  const { key, timestamp, data } = decodeVideo(payload.subarray(1 + idLen));
  return { peerId, frame: { key, timestamp, data } };
}
