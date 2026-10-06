/**
 * Voice-node manager — the operator-side singleton wiring @papercusp/p2p-voice
 * to real infrastructure (plan holepunch-voice-channels-2026-06-05 P-006).
 *
 * Swarm: a DEDICATED lazy Hyperswarm instance (not the shared hyperbee swarm).
 * Rationale (amends D-011 as recorded in the plan): voice frames on the shared
 * swarm would multiplex via Protomux next to corestore replication bursts —
 * poor isolation for real-time audio — and the spike validated exactly the
 * dedicated-swarm + raw-stream-framing shape. Peer gating is the channel
 * topic + hello handshake.
 *
 * Listeners (mixed frames / peer events) are held HERE and survive channel
 * switches — the local audio socket and the agent peer subscribe once.
 *
 * Encryption (P-013): the operator↔operator media path is end-to-end encrypted
 * by construction. `ensureNode` injects ONLY the real Hyperswarm (below), and
 * every Hyperswarm connection is a `NoiseSecretStream` (X25519 Noise handshake
 * over HyperDHT) — there is no plaintext-transport code path in production; the
 * identity/plaintext `SwarmLike` exists solely as a test stub. So every CTRL +
 * AUDIO frame written to a peer `conn` rides the Noise stream. This was measured
 * empirically by the P-001 spike (`libs/holepunch-spike/voice/RESULTS.md`:
 * "Noise-encrypted UDX stream"). The local operator↔client leg is a same-host
 * unix socket (`local-audio-socket`, loopback — never network-exposed).
 */
import { hostname, userInfo } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  createVoiceNode,
  type ChannelHandle,
  type SwarmLike,
  type VoiceNode,
  type VoicePeerState,
} from '@papercusp/p2p-voice';
import { getOpusCodec, VOICE_FRAME_SAMPLES } from './codec';
import { createMicDsp, micDspConfigFromPrefs, type MicDspStatus } from './mic-dsp';
import { ensureVideoChannel, resolveVoiceChannel, type VoiceChannel } from './registry';
import { dhtBootstrapMisconfigured, swarmConstructorOpts } from '../sync/hyperbee/swarm';

export interface VoiceStatus {
  channel: VoiceChannel | null;
  muted: boolean;
  peers: VoicePeerState[];
  identity: { id: string; label: string };
  /** True while the local agent brain is speaking a reply (P-011 indicator). */
  agentSpeaking: boolean;
}

interface VoiceSwarmLike extends SwarmLike {
  destroy(): Promise<void>;
}

const identity = {
  id: `${hostname()}-${randomBytes(3).toString('hex')}`,
  label: `${(() => {
    try {
      return userInfo().username;
    } catch {
      return 'operator';
    }
  })()}@${hostname()}`,
};

let swarm: VoiceSwarmLike | null = null;
let node: VoiceNode | null = null;
// In-flight-build memo (WI-37484): `ensureNode` used to be a bare
// check-then-act — `if (node) return node;` followed by several `await`s
// (dynamic hyperswarm import, relay-key lookup, codec load) before the
// `node = createVoiceNode(...)` assignment. Two concurrent callers (the
// `voice:join` agent tool and the desktop local-audio-socket handler both
// call `joinVoiceChannel` → `ensureNode`) each passed the guard, each built
// its OWN hyperswarm instance, and only the last assignment survived — the
// other swarm was constructed, joined the DHT, and then leaked (never
// destroyed, never referenced again). Same promise-memo pattern already used
// correctly by mem0-client.ts's `_clientBuildPromise`.
let nodeBuildPromise: Promise<VoiceNode> | null = null;
let handle: ChannelHandle | null = null;
let channel: VoiceChannel | null = null;
let agentSpeaking = false;

const mixedCbs = new Set<(frame: Int16Array) => void>();
const peerFrameCbs = new Set<(peerId: string, frame: Int16Array) => void>();
const peerVideoCbs = new Set<(peerId: string, payload: Uint8Array) => void>();
const changedCbs = new Set<(status: VoiceStatus) => void>();
const handleUnsubs: Array<() => void> = [];

/**
 * Mic-path DSP (P-010/D-013): gain → AEC → spectral NS between the clients'
 * raw capture and the channel encoder. Far-end (the local MIX) feeds the AEC
 * from the mixed-frame fan-out below; prefs are applied on every join.
 */
const micDsp = createMicDsp();

async function configureMicDspFromPrefs(): Promise<void> {
  try {
    const { loadVoicePrefs } = await import('../voice-prefs');
    await micDsp.configure(micDspConfigFromPrefs(await loadVoicePrefs()));
  } catch (e) {
    console.warn('[voice] mic-dsp prefs configure failed (chain stays pass-through):', e);
  }
}

async function ensureNode(): Promise<VoiceNode> {
  if (node) return node;
  if (nodeBuildPromise) return nodeBuildPromise;
  nodeBuildPromise = (async (): Promise<VoiceNode> => {
    const mod = (await import('hyperswarm')) as { default: new (opts?: unknown) => VoiceSwarmLike };
    // Explicit relay fallback (P-013/D-009): when relay keys are configured,
    // hyperswarm retries failed hole-punches THROUGH the blind relay (it stays
    // blind — the Noise stream is peer↔peer, so D-012's E2E guarantee holds).
    const { getVoiceRelayKeys } = await import('./voice-relay');
    const ctorOpts = swarmConstructorOpts();
    const relayKeys = await getVoiceRelayKeys({
      dhtBootstrap: ctorOpts.bootstrap,
      bootstrapMisconfigured: dhtBootstrapMisconfigured(),
    });
    swarm = new mod.default({
      ...(ctorOpts as Record<string, unknown>),
      ...(relayKeys.length > 0 ? { relayThrough: relayKeys } : {}),
    });
    const codec = await getOpusCodec();
    node = createVoiceNode({ swarm, codec, identity });
    return node;
  })().finally(() => {
    nodeBuildPromise = null;
  });
  return nodeBuildPromise;
}

export function voiceStatus(): VoiceStatus {
  return {
    channel,
    muted: handle?.muted ?? false,
    peers: handle?.peers() ?? [],
    identity,
    agentSpeaking,
  };
}

/**
 * The agent brain reports its speaking state here (P-011) so it rides the same
 * status push to every voice client. Kept on the manager (not the brain) to
 * avoid an import cycle — the brain imports the manager, never the reverse.
 */
export function setVoiceAgentSpeaking(speaking: boolean): void {
  if (agentSpeaking === speaking) return;
  agentSpeaking = speaking;
  emitChanged();
}

function emitChanged(): void {
  const s = voiceStatus();
  for (const cb of changedCbs) cb(s);
}

export async function joinVoiceChannel(idOrName: string): Promise<VoiceStatus> {
  const target = await resolveVoiceChannel(idOrName);
  if (!target) throw new Error(`voice: unknown channel "${idOrName}" — create it via voice:channels first`);
  if (channel?.id === target.id && handle) return voiceStatus();
  await leaveVoiceChannel();
  const n = await ensureNode();
  const h = n.joinChannel(target.topicHex);
  handle = h;
  channel = target;
  // Apply the current voice prefs to the mic DSP chain (fire-and-forget — a
  // frame arriving before the WASM loads just passes through).
  void configureMicDspFromPrefs();
  handleUnsubs.push(
    h.onMixedFrame((frame) => {
      micDsp.pushFarEnd(frame); // AEC far-end reference (P-010)
      for (const cb of mixedCbs) cb(frame);
    }),
    h.onPeerFrame((peerId, frame) => {
      for (const cb of peerFrameCbs) cb(peerId, frame);
    }),
    h.onPeerVideoFrame((peerId, payload) => {
      for (const cb of peerVideoCbs) cb(peerId, payload);
    }),
    h.onPeersChanged(() => emitChanged()),
  );
  emitChanged();
  return voiceStatus();
}

/**
 * Join the deterministic video channel for a shared harness (D-003). Ensures the
 * registry entry (deterministic topic) then joins it — both peers on the same
 * harness rendezvous on the same topic. Used by the desktop video surface.
 */
export async function joinHarnessVideoChannel(harness: string): Promise<VoiceStatus> {
  const ch = await ensureVideoChannel(harness);
  return joinVoiceChannel(ch.id);
}

export async function leaveVoiceChannel(): Promise<VoiceStatus> {
  if (handle) {
    for (const un of handleUnsubs.splice(0)) un();
    const h = handle;
    handle = null;
    channel = null;
    micDsp.reset(); // the room/echo path is gone with the channel
    await h.leave();
    emitChanged();
  }
  return voiceStatus();
}

/** Push one local mic frame (PCM16, VOICE_FRAME_SAMPLES samples). */
export function pushMicFrame(frame: Int16Array): void {
  handle?.pushMic(micDsp.process(frame));
}

/** Mic-DSP diagnostics (gain/AEC/NS state + delay/ERLE) — tools + tests. */
export function micDspStatus(): MicDspStatus {
  return micDsp.status();
}

/**
 * Push one local encoded VIDEO frame (opaque `[1B flags][8B ts][chunk]` bytes
 * from the webview's WebCodecs encoder) → fanned per-peer (plan
 * holepunch-video-shared-harnesses-2026-06-05 P-003). The operator never decodes
 * it; the codec lives in the webview (D-002/D-007).
 */
export function pushVideoFrame(payload: Uint8Array): void {
  handle?.pushVideo(payload);
}

export function setVoiceMuted(muted: boolean): void {
  handle?.setMuted(muted);
  emitChanged();
}

/** Announce the local camera on/off state to channel peers (in-band, D-008). */
export function setVideoCameraOn(on: boolean): void {
  handle?.setCameraOn(on);
  emitChanged();
}

/** Subscribe to the N-peer mix (local playback feed). Survives channel switches. */
export function onMixedFrame(cb: (frame: Int16Array) => void): () => void {
  mixedCbs.add(cb);
  return () => mixedCbs.delete(cb);
}

/** Subscribe to per-peer decoded frames (the agent/STT tap, D-007). */
export function onPeerFrame(cb: (peerId: string, frame: Int16Array) => void): () => void {
  peerFrameCbs.add(cb);
  return () => peerFrameCbs.delete(cb);
}

/**
 * Subscribe to per-peer inbound VIDEO frames (opaque encoded payload, tagged
 * with the sender peer id). The local voice socket fans these to opted-in
 * desktop clients as VID frames. Survives channel switches.
 */
export function onPeerVideoFrame(cb: (peerId: string, payload: Uint8Array) => void): () => void {
  peerVideoCbs.add(cb);
  return () => peerVideoCbs.delete(cb);
}

export function onVoiceStatusChanged(cb: (status: VoiceStatus) => void): () => void {
  changedCbs.add(cb);
  return () => changedCbs.delete(cb);
}

export const VOICE_MIC_FRAME_SAMPLES = VOICE_FRAME_SAMPLES;

/** Full teardown (tests + graceful shutdown). */
export async function destroyVoiceNode(): Promise<void> {
  await leaveVoiceChannel();
  if (node) {
    await node.destroy();
    node = null;
  }
  if (swarm) {
    try {
      await swarm.destroy();
    } catch {
      /* socket already gone */
    }
    swarm = null;
  }
}
