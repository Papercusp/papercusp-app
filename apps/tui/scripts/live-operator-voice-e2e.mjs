#!/usr/bin/env node
/**
 * LIVE operator-voice E2E — the real-EL leg of universal-voice-interface
 * -2026-06-05 P-011, push-button.
 *
 * Drives the RUNNING operator's voice host over the real bus with SYNTHETIC
 * SPEECH (espeak-ng → 16 kHz PCM, streamed at real-time pace as a mic), through
 * REAL ElevenLabs Conv-AI (STT → ask_operator brain → TTS), with TWO attached
 * bus clients (a "desktop" + a "tui") proving the shared-session contract:
 * both receive the input transcript, the response transcript, and the response
 * audio; exactly one is the elected player.
 *
 * Requires: a running operator (discovery at ~/.papercusp/voice-ipc.json),
 * espeak-ng + ffmpeg on PATH, and ElevenLabs configured in the operator
 * (/settings/voice → fullAgentEngine=elevenlabs-conv + agent ID; /settings/
 * api-keys → ElevenLabs API key). Burns ONE short EL session.
 *
 * Exit codes: 0 = full pass (evidence printed) · 2 = blocked on EL config
 * (the host's graceful error path — message printed) · 1 = failure/timeout.
 *
 *   node apps/tui/scripts/live-operator-voice-e2e.mjs ["utterance to speak"]
 */
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const UTTERANCE = process.argv[2] ?? 'hello operator, can you hear me?';
const VOICE_RELAY_ACK = "On it — I'll come back to you in a moment.";
const HOST_DEPENDENCIES = Object.freeze([
  { command: 'espeak-ng', packageName: 'espeak-ng' },
  { command: 'ffmpeg', packageName: 'ffmpeg' },
]);

function commandAvailable(command) {
  try {
    // command -v is a shell builtin, so use the POSIX shell that is present
    // in the WSL runtime rather than assuming a separate which package.
    execFileSync('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'papercup-live-e2e-preflight', command], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function preflightHostDependencies() {
  const missing = HOST_DEPENDENCIES.filter(({ command }) => !commandAvailable(command));
  if (missing.length === 0) return;

  const commands = missing.map(({ command }) => command).join(', ');
  const packages = missing.map(({ packageName }) => packageName).join(' ');
  throw new Error(
    'missing required host command(s): ' + commands + '\n' +
    'Install them on Ubuntu/WSL with:\n' +
    '  sudo apt-get update && sudo apt-get install -y ' + packages + '\n' +
    'Then re-run this live voice E2E.',
  );
}

// ── minimal opvoice codec (mirror of operator-voice-bus.ts; bytes 0x10–0x1F) ──
const OPV = { HELLO: 0x10, MIC: 0x11, CONTROL: 0x12, INPUT_T: 0x13, RESP_A: 0x14, RESP_T: 0x15, STATE: 0x17 };
const frame = (t, p) => { const b = Buffer.alloc(5 + p.length); b.writeUInt32BE(p.length, 0); b[4] = t; p.copy(b, 5); return b; };
const jframe = (t, o) => frame(t, Buffer.from(JSON.stringify(o)));

function makeClient(sockPath, id, kind) {
  const c = net.connect(sockPath);
  const ev = { state: [], inputT: [], respT: [], respAudioBytes: 0 };
  let buf = Buffer.alloc(0);
  c.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 5) {
      const len = buf.readUInt32BE(0);
      if (buf.length < 5 + len) break;
      const t = buf[4]; const p = buf.subarray(5, 5 + len); buf = buf.subarray(5 + len);
      if (t === OPV.STATE) ev.state.push(JSON.parse(p.toString()));
      else if (t === OPV.INPUT_T) ev.inputT.push(JSON.parse(p.toString()).text);
      else if (t === OPV.RESP_T) ev.respT.push(JSON.parse(p.toString()).text);
      else if (t === OPV.RESP_A) ev.respAudioBytes += Math.max(0, len - 5); // [1B fmt][4B rate][audio]
    }
  });
  const ready = new Promise((res, rej) => { c.once('connect', res); c.once('error', rej); });
  return { c, ev, ready, hello: () => c.write(jframe(OPV.HELLO, { clientId: id, clientKind: kind })) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return; await sleep(50); }
  throw new Error(`timeout waiting for ${what}`);
}

// ── synthesize speech: espeak-ng → wav → ffmpeg → raw PCM16 LE mono 16k ──
function synthesizeSpeech(text) {
  const wav = join(tmpdir(), `opv-e2e-${process.pid}.wav`);
  const raw = join(tmpdir(), `opv-e2e-${process.pid}.raw`);
  execFileSync('espeak-ng', ['-v', 'en-us', '-s', '150', '-w', wav, text]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-f', 's16le', '-ar', '16000', '-ac', '1', raw]);
  return readFileSync(raw);
}

(async () => {
  preflightHostDependencies();

  // VOICE_SOCK overrides discovery — on a multi-operator dev box the discovery
  // file is last-writer-wins and can point at a dead operator's socket.
  const socketPath =
    process.env.VOICE_SOCK ?? JSON.parse(readFileSync(join(homedir(), '.papercusp', 'voice-ipc.json'), 'utf8')).socketPath;
  console.log(`[live-e2e] host socket: ${socketPath}`);
  console.log(`[live-e2e] utterance: "${UTTERANCE}"`);
  const speech = synthesizeSpeech(UTTERANCE);
  console.log(`[live-e2e] synthesized speech: ${speech.length} bytes PCM16 @16k (~${(speech.length / 32000).toFixed(1)}s)`);

  const A = makeClient(socketPath, 'e2e-desktop', 'desktop'); // driver → elected player
  const B = makeClient(socketPath, 'e2e-tui', 'tui');         // observer → display-only
  await Promise.all([A.ready, B.ready]);
  A.hello(); B.hello();
  await sleep(150);
  A.c.write(jframe(OPV.CONTROL, { op: 'start' }));

  // Reach a live session — or surface the host's graceful config error.
  try {
    await waitFor(() => {
      const s = A.ev.state.at(-1);
      if (s?.status === 'error') throw new Error(`EL-CONFIG: ${s.reason ?? 'voice error'}`);
      return ['idle', 'listening', 'speaking'].includes(s?.status ?? '');
    }, 25_000, 'EL session live (status idle)');
  } catch (e) {
    if (String(e.message).startsWith('EL-CONFIG:')) {
      console.error(`[live-e2e] BLOCKED on ElevenLabs config — host said: ${e.message.slice(11)}`);
      console.error('[live-e2e] → add the EL API key (/settings/api-keys) + agent ID & engine (/settings/voice), then re-run.');
      process.exit(2);
    }
    throw e;
  }
  console.log('[live-e2e] ✓ EL session live; player =', A.ev.state.at(-1)?.playerId);
  if (A.ev.state.at(-1)?.playerId !== 'e2e-desktop') throw new Error('driver was not elected player');

  // Stream the speech at real-time pace (250 ms chunks), then 2 s of silence
  // so EL's server VAD detects end-of-turn.
  const CHUNK = 8000; // 250 ms @ 16k mono PCM16
  for (let off = 0; off < speech.length; off += CHUNK) {
    A.c.write(frame(OPV.MIC, speech.subarray(off, Math.min(off + CHUNK, speech.length))));
    await sleep(250);
  }
  const silence = Buffer.alloc(CHUNK);
  for (let i = 0; i < 8; i++) { A.c.write(frame(OPV.MIC, silence)); await sleep(250); }
  console.log('[live-e2e] speech streamed; awaiting EL STT…');

  await waitFor(() => A.ev.inputT.length > 0 && B.ev.inputT.length > 0, 30_000, 'input transcript on BOTH clients');
  console.log(`[live-e2e] ✓ EL transcribed (both clients): "${A.ev.inputT[0]}"`);

  const nonAckResponses = (ev) => ev.respT.filter((t) => t && t.trim() !== VOICE_RELAY_ACK);
  await waitFor(
    () =>
      A.ev.respT.includes(VOICE_RELAY_ACK) &&
      B.ev.respT.includes(VOICE_RELAY_ACK) &&
      nonAckResponses(A.ev).length > 0 &&
      nonAckResponses(B.ev).length > 0 &&
      A.ev.respAudioBytes > 0 &&
      B.ev.respAudioBytes > 0,
    75_000,
    'relay ack + later pane answer on BOTH clients',
  );
  console.log(`[live-e2e] ✓ relay ack (both clients): "${VOICE_RELAY_ACK}"`);
  console.log(`[live-e2e] ✓ pane answer (both clients): "${nonAckResponses(A.ev)[0]?.slice(0, 160)}"`);
  console.log(`[live-e2e] ✓ response audio: A=${A.ev.respAudioBytes}B B=${B.ev.respAudioBytes}B (equal fan-out: ${A.ev.respAudioBytes === B.ev.respAudioBytes})`);
  console.log(`[live-e2e] ✓ exactly-one-player held: playerId stayed '${A.ev.state.at(-1)?.playerId}' (B is display-only)`);

  A.c.write(jframe(OPV.CONTROL, { op: 'stop' }));
  await sleep(300);
  A.c.destroy(); B.c.destroy();
  console.log('[live-e2e] PASS — one shared EL session, both surfaces received the relay ack and the later pane answer, single elected player.');
  process.exit(0);
})().catch((e) => {
  console.error('[live-e2e] FAIL:', e.message);
  process.exit(1);
});
