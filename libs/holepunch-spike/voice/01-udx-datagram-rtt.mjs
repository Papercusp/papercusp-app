/**
 * voice/01 — raw UDX datagram RTT baseline (loopback, no DHT, no encryption).
 *
 * Two UDX sockets, unreliable datagrams (trySend) ping-ponged at 50 fps with
 * ~Opus-sized frames. This is the floor: pure UDX + Node event-loop overhead.
 * If THIS is slow, nothing built on UDX will be fast.
 */
import UDX from 'udx-native';
import { makeFrame, readFrame, summarize, FRAME_BYTES, FPS, DURATION_MS } from './lib-stats.mjs';

const u = new UDX();
const origin = u.createSocket();
const echoer = u.createSocket();
origin.bind(0, '127.0.0.1');
echoer.bind(0, '127.0.0.1');
const echoerPort = echoer.address().port;
const originPort = origin.address().port;

// Echoer: bounce every datagram straight back.
echoer.on('message', (buf, { host, port }) => {
  try { echoer.trySend(Buffer.from(buf), port, host); } catch {}
});

const inflight = new Map(); // seq -> t_send_ns
const rttsMs = [];
let sent = 0;

origin.on('message', (buf) => {
  if (buf.length < FRAME_BYTES) return;
  const { seq } = readFrame(buf);
  const t0 = inflight.get(seq);
  if (t0 === undefined) return;
  inflight.delete(seq);
  rttsMs.push(Number(process.hrtime.bigint() - t0) / 1e6);
});

const totalFrames = Math.round((DURATION_MS / 1000) * FPS);
let seq = 0;
const interval = setInterval(() => {
  if (seq >= totalFrames) {
    clearInterval(interval);
    setTimeout(finish, 500); // drain in-flight
    return;
  }
  const now = process.hrtime.bigint();
  inflight.set(seq, now);
  try { origin.trySend(makeFrame(seq, now), echoerPort, '127.0.0.1'); sent++; } catch {}
  seq++;
}, 1000 / FPS);

function finish() {
  const r = summarize('UDX datagram (loopback)', { sent, rttsMs });
  origin.close(); echoer.close();
  console.log(r.ok && r.oneWayP50 < 10 ? '\nRESULT: PASS — UDX datagram overhead is negligible.' : '\nRESULT: see numbers above.');
  process.exit(0);
}

console.log(`voice/01 UDX datagram RTT — ${totalFrames} frames @ ${FPS}fps, ${FRAME_BYTES}B, origin:${originPort}→echoer:${echoerPort}`);
