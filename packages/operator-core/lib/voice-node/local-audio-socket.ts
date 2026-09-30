/**
 * Local voice audio socket — the dedicated binary channel between the local
 * client (pui / desktop) and this operator's voice node (D-010).
 *
 * Why not the main IPC socket: that protocol has no client→server binary frame
 * type, and audio shouldn't share a pipe with bursty tool traffic. This socket
 * speaks the same `[4B len BE][1B type][payload]` framing (P-003-proven):
 *
 *   0x01 CTRL  (both ways, UTF-8 JSON)
 *     client→server: {op:'join', channel} | {op:'leave'} | {op:'mute', muted} | {op:'status'}
 *                  | {op:'channels'} | {op:'create', name}
 *                  | {op:'video', recv} | {op:'camera', on}
 *     server→client: {ev:'status', status} | {ev:'channels', channels} | {ev:'error', message}
 *   0x02 MIC   (client→server)  raw PCM16-LE mono 48kHz — any chunking; server reframes
 *   0x03 MIX   (server→client)  one mixed 20ms PCM16-LE frame (1920 bytes), 50/s while in a channel
 *   0x04 CAM   (client→server)  one opaque encoded VIDEO frame ([1B flags][8B ts][chunk]) → fanned per-peer
 *   0x05 VID   (server→client)  one peer's video, [1B idLen][peerId utf8][video frame] — per-peer, NOT mixed
 *   0x10–0x1F  OPV  (both ways)  operator-voice session bus (universal-voice-interface
 *               -2026-06-05): the ONE shared EL/operator session. HELLO/MIC/CONTROL
 *               inbound, INPUT_TRANSCRIPT + RESPONSE_x + SESSION_STATE outbound — decoded by
 *               operator-voice-bus, routed to the host-owned OperatorVoiceSession.
 *
 * Video (plan holepunch-video-shared-harnesses-2026-06-05 D-007/D-008): the
 * operator NEVER decodes video — it relays opaque chunks. A client only receives
 * VID after opting in via {op:'video',recv:true}, so the Rust pui (no video) and
 * any audio-only client pay nothing. Camera on/off is announced via
 * {op:'camera',on} → in-band swarm state. The WS bridge (desktop-voice-ws) is a
 * type-agnostic byte-pipe, so CAM/VID flow through it unchanged.
 *
 * Discovery: `~/.papercusp/voice-ipc.json` → { socketPath, sampleRate, frameSamples }.
 * (A bootstrap discovery file — the sanctioned file-not-PG case.)
 */
import { createServer, type Server, type Socket } from 'node:net';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FrameDecoder, encodeFrame, type VoiceFrame } from '@papercusp/p2p-voice';
import { VOICE_FRAME_SAMPLES, VOICE_SAMPLE_RATE } from './codec';
import {
  joinHarnessVideoChannel,
  joinVoiceChannel,
  leaveVoiceChannel,
  onMixedFrame,
  onPeerVideoFrame,
  onVoiceStatusChanged,
  pushMicFrame,
  pushVideoFrame,
  setVideoCameraOn,
  setVoiceMuted,
  voiceStatus,
} from './manager';
import { createVoiceChannel, listVoiceChannels } from './registry';
import { decodeOpVoiceFrame, isOpVoiceFrameType } from './operator-voice-bus';
import type { OperatorVoiceSession } from './operator-voice-session';

const CTRL = 0x01;
const MIC = 0x02;
const MIX = 0x03;
const CAM = 0x04; // client→server: one opaque encoded video frame
const VID = 0x05; // server→client: one peer's video, peerId-tagged

const FRAME_BYTES = VOICE_FRAME_SAMPLES * 2;
const te = new TextEncoder();

let server: Server | null = null;
let socketPath: string | null = null;
const clients = new Set<Socket>();
/** Sockets that opted into receiving peer video (VID frames) via {op:'video',recv:true}. */
const videoClients = new Set<Socket>();
const managerUnsubs: Array<() => void> = [];

// ── Operator-voice session bus (universal-voice-interface-2026-06-05) ─────────
// The ONE shared EL/operator session is hosted by `OperatorVoiceSession`,
// injected at bootstrap. Clients carry operator-voice over THIS socket in the
// 0x10–0x1F frame block: inbound HELLO/MIC/CONTROL route to the host, and the
// host's outbound frames fan to every attached operator-voice client. Distinct
// from the P2P channel path above — same pipe, separate frame block + client set.
let opVoiceSession: OperatorVoiceSession | null = null;
const opVoiceClients = new Set<Socket>();
const opVoiceClientIds = new Map<Socket, string>();

/** Inject the host-owned session (bootstrap); pass null to detach (tests/shutdown). */
export function setOperatorVoiceSession(session: OperatorVoiceSession | null): void {
  opVoiceSession = session;
}

/** Fan one already-framed operator-voice message to every attached opvoice client. */
export function broadcastOpVoice(frame: Uint8Array): void {
  for (const c of opVoiceClients) {
    if (c.destroyed) continue;
    try {
      c.write(frame);
    } catch {
      /* client went away mid-write */
    }
  }
}

function handleOpVoiceFrame(sock: Socket, frame: VoiceFrame): void {
  if (!opVoiceSession) return;
  const msg = decodeOpVoiceFrame(frame);
  if (!msg) return;
  switch (msg.kind) {
    case 'hello':
      // Register the socket BEFORE handleHello so the host's state broadcast
      // reaches this newly-attached client too.
      opVoiceClients.add(sock);
      opVoiceClientIds.set(sock, msg.clientId);
      opVoiceSession.handleHello(msg.clientId, msg.clientKind);
      break;
    case 'mic': {
      const id = opVoiceClientIds.get(sock);
      if (id) opVoiceSession.handleMic(id, msg.pcm16le);
      break;
    }
    case 'control': {
      const id = opVoiceClientIds.get(sock);
      if (id) opVoiceSession.handleControl(id, msg.control);
      break;
    }
    default:
      break; // host→client kinds never arrive inbound
  }
}

function send(sock: Socket, type: number, payload: Uint8Array): void {
  if (sock.destroyed) return;
  try {
    sock.write(encodeFrame(type, payload));
  } catch {
    /* client went away mid-write */
  }
}

function sendCtrl(sock: Socket, msg: unknown): void {
  send(sock, CTRL, te.encode(JSON.stringify(msg)));
}

function broadcastCtrl(msg: unknown): void {
  const payload = te.encode(JSON.stringify(msg));
  for (const c of clients) send(c, CTRL, payload);
}

async function handleCtrl(sock: Socket, raw: Uint8Array): Promise<void> {
  let msg: {
    op?: string;
    channel?: string;
    muted?: boolean;
    name?: string;
    recv?: boolean;
    on?: boolean;
    harness?: string;
  };
  try {
    msg = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    sendCtrl(sock, { ev: 'error', message: 'bad ctrl json' });
    return;
  }
  try {
    switch (msg.op) {
      case 'join': {
        const status = await joinVoiceChannel(String(msg.channel ?? ''));
        sendCtrl(sock, { ev: 'status', status });
        break;
      }
      case 'joinVideo': {
        // Join the deterministic per-harness video channel (D-003).
        const status = await joinHarnessVideoChannel(String(msg.harness ?? ''));
        sendCtrl(sock, { ev: 'status', status });
        break;
      }
      case 'leave': {
        const status = await leaveVoiceChannel();
        sendCtrl(sock, { ev: 'status', status });
        break;
      }
      case 'mute': {
        setVoiceMuted(Boolean(msg.muted));
        sendCtrl(sock, { ev: 'status', status: voiceStatus() });
        break;
      }
      case 'channels': {
        sendCtrl(sock, { ev: 'channels', channels: await listVoiceChannels() });
        break;
      }
      case 'create': {
        await createVoiceChannel(String(msg.name ?? ''));
        sendCtrl(sock, { ev: 'channels', channels: await listVoiceChannels() });
        break;
      }
      case 'video': {
        // Opt this socket in/out of receiving peer video (D-008). Default opt-in
        // when recv is omitted; an explicit false unsubscribes.
        if (msg.recv === false) videoClients.delete(sock);
        else videoClients.add(sock);
        sendCtrl(sock, { ev: 'status', status: voiceStatus() });
        break;
      }
      case 'camera': {
        // Announce the local camera on/off state to channel peers (in-band).
        setVideoCameraOn(Boolean(msg.on));
        sendCtrl(sock, { ev: 'status', status: voiceStatus() });
        break;
      }
      case 'status':
      default:
        sendCtrl(sock, { ev: 'status', status: voiceStatus() });
    }
  } catch (err) {
    sendCtrl(sock, { ev: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

function handleClient(sock: Socket): void {
  clients.add(sock);
  const decoder = new FrameDecoder();
  // Mic byte accumulator: clients may chunk arbitrarily; reframe to exact 20ms.
  let micAcc = new Uint8Array(0);

  sock.on('data', (chunk: Buffer) => {
    let frames;
    try {
      frames = decoder.push(new Uint8Array(chunk));
    } catch {
      sock.destroy();
      return;
    }
    for (const f of frames) {
      if (f.type === CTRL) {
        void handleCtrl(sock, f.payload);
      } else if (f.type === MIC) {
        if (micAcc.length === 0 && f.payload.length % FRAME_BYTES === 0) {
          // fast path: exact frames, no copy accumulation
          for (let off = 0; off + FRAME_BYTES <= f.payload.length; off += FRAME_BYTES) {
            const slice = f.payload.subarray(off, off + FRAME_BYTES);
            pushMicFrame(new Int16Array(slice.buffer.slice(slice.byteOffset, slice.byteOffset + FRAME_BYTES)));
          }
        } else {
          const next = new Uint8Array(micAcc.length + f.payload.length);
          next.set(micAcc, 0);
          next.set(f.payload, micAcc.length);
          micAcc = next;
          let off = 0;
          while (off + FRAME_BYTES <= micAcc.length) {
            const slice = micAcc.subarray(off, off + FRAME_BYTES);
            pushMicFrame(new Int16Array(slice.buffer.slice(slice.byteOffset, slice.byteOffset + FRAME_BYTES)));
            off += FRAME_BYTES;
          }
          micAcc = micAcc.subarray(off);
        }
      } else if (f.type === CAM) {
        // One whole encoded video frame per CAM frame (the FrameDecoder already
        // reassembled it by length prefix) — relay opaque, fanned to peers.
        // pushVideoFrame → encodeFrame copies synchronously, so the view is safe.
        pushVideoFrame(f.payload);
      } else if (isOpVoiceFrameType(f.type)) {
        // Operator-voice session frame (0x10–0x1F) → the host-owned session.
        handleOpVoiceFrame(sock, f);
      }
    }
  });
  const drop = () => {
    clients.delete(sock);
    videoClients.delete(sock);
    if (opVoiceClients.delete(sock)) {
      const id = opVoiceClientIds.get(sock);
      opVoiceClientIds.delete(sock);
      if (id && opVoiceSession) opVoiceSession.handleClientGone(id);
    }
  };
  sock.on('error', drop);
  sock.on('close', drop);
  sendCtrl(sock, { ev: 'status', status: voiceStatus() });
}

/** Is `pid` a live process? `process.kill(pid,0)` succeeds ⇒ alive; ESRCH ⇒ dead;
 *  EPERM ⇒ exists-but-owned-by-another-user ⇒ treat as ALIVE (never reap a live
 *  process's socket). */
function ownerPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * GC orphaned `voice-<pid>.sock` files left by dead operators (EI-3290). A crashed
 * or SIGKILLed operator never runs {@link stopLocalVoiceSocket}, so its socket file
 * lingers forever — hundreds accumulate in ~/.papercusp/sockets/ and "which socket is
 * live" degrades into an O(hundreds) connect-probe. On start we reap files whose owning
 * pid (encoded in the filename) is dead. Skips our own pid and any file whose pid is
 * still alive. Best-effort + isolated: a readdir/unlink failure never blocks startup.
 * `isAlive` is injectable for tests. Returns the number of files reaped.
 */
export function gcDeadVoiceSockets(
  dir: string = join(homedir(), '.papercusp', 'sockets'),
  isAlive: (pid: number) => boolean = ownerPidAlive,
): number {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0; // dir absent — nothing to GC
  }
  let reaped = 0;
  for (const name of entries) {
    const m = /^voice-(\d+)\.sock$/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    if (isAlive(pid)) continue; // a live operator owns it — keep
    try {
      rmSync(join(dir, name), { force: true });
      reaped++;
    } catch {
      /* raced with another reaper / perms — skip */
    }
  }
  return reaped;
}

export interface VoiceSocketInfo {
  socketPath: string;
  discoveryPath: string;
}

/** Root for the voice socket dir + discovery file. `PAPERCUSP_VOICE_IPC_DIR` is a
 *  launch-time/test config override (hermetic tests must not reap the REAL
 *  ~/.papercusp/sockets or overwrite the live voice-ipc.json); prod uses ~/.papercusp. */
function voiceIpcRoot(): string {
  return process.env.PAPERCUSP_VOICE_IPC_DIR || join(homedir(), '.papercusp');
}

export function startLocalVoiceSocket(): VoiceSocketInfo {
  if (server && socketPath) {
    return { socketPath, discoveryPath: join(voiceIpcRoot(), 'voice-ipc.json') };
  }
  const dir = join(voiceIpcRoot(), 'sockets');
  mkdirSync(dir, { recursive: true });
  // EI-3290: reap orphaned voice-<pid>.sock files from dead operators before adding
  // ours, so ~/.papercusp/sockets/ doesn't grow unbounded across restarts/crashes.
  try {
    const reaped = gcDeadVoiceSockets(dir);
    if (reaped > 0) console.error(`[voice-socket] GC'd ${reaped} orphaned voice socket(s) from dead pids`);
  } catch {
    /* GC is best-effort — never block voice startup */
  }
  socketPath = join(dir, `voice-${process.pid}.sock`);
  try {
    rmSync(socketPath, { force: true });
  } catch {
    /* fresh path */
  }
  server = createServer(handleClient);
  server.on('error', (err) => console.error('[voice-socket] server error:', err));
  server.listen(socketPath);

  // Mixed frames fan out to every connected client; status pushes on change.
  managerUnsubs.push(
    onMixedFrame((frame) => {
      if (clients.size === 0) return;
      const bytes = new Uint8Array(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength));
      for (const c of clients) send(c, MIX, bytes);
    }),
    // Per-peer video → VID frames, ONLY to opted-in clients. NOT mixed: each peer
    // gets its own tile, so we forward each peer's frame tagged with its id.
    onPeerVideoFrame((peerId, payload) => {
      if (videoClients.size === 0) return;
      const idBytes = te.encode(peerId);
      if (idBytes.length > 255) return; // peer ids are short host-hex; never hit
      const vid = new Uint8Array(1 + idBytes.length + payload.length);
      vid[0] = idBytes.length;
      vid.set(idBytes, 1);
      vid.set(payload, 1 + idBytes.length);
      for (const c of videoClients) send(c, VID, vid);
    }),
    onVoiceStatusChanged((status) => broadcastCtrl({ ev: 'status', status })),
  );

  const discoveryPath = join(voiceIpcRoot(), 'voice-ipc.json');
  writeFileSync(
    discoveryPath,
    JSON.stringify({ socketPath, sampleRate: VOICE_SAMPLE_RATE, frameSamples: VOICE_FRAME_SAMPLES }, null, 2),
  );
  return { socketPath, discoveryPath };
}

export function stopLocalVoiceSocket(): void {
  for (const un of managerUnsubs.splice(0)) un();
  for (const c of clients) c.destroy();
  clients.clear();
  videoClients.clear();
  opVoiceClients.clear();
  opVoiceClientIds.clear();
  server?.close();
  server = null;
  if (socketPath) {
    try {
      rmSync(socketPath, { force: true });
    } catch {
      /* gone */
    }
    socketPath = null;
  }
}
