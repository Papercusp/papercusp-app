/**
 * voice/02 — realistic voice path: two Hyperswarm peers discover via the public
 * DHT, hole-punch, and stream framed audio over the Noise-encrypted UDX stream.
 *
 * This is what a real P2P voice-channel connection IS. Measures discovery +
 * encryption + UDX-stream overhead end to end. The connection initiator
 * (conn.client) is the originator; the other side echoes.
 *
 * Fixed 80B frames over a byte stream → reassemble in 80B chunks.
 */
import Hyperswarm from 'hyperswarm';
import crypto from 'node:crypto';
import { makeFrame, readFrame, summarize, FRAME_BYTES, FPS, DURATION_MS } from './lib-stats.mjs';

const CONNECT_TIMEOUT_MS = 40_000;
const topic = crypto.randomBytes(32);

const a = new Hyperswarm();
const b = new Hyperswarm();
const startedAt = Date.now();
let measured = false;

function frameStreamHandler(conn, onFrame) {
  let acc = Buffer.alloc(0);
  conn.on('data', (d) => {
    acc = acc.length ? Buffer.concat([acc, d]) : d;
    while (acc.length >= FRAME_BYTES) {
      onFrame(acc.subarray(0, FRAME_BYTES));
      acc = acc.subarray(FRAME_BYTES);
    }
  });
  conn.on('error', () => {});
}

let originatorStarted = false;
let echoerStarted = false;

function onConnection(conn, isOriginator) {
  const connectedMs = Date.now() - startedAt;
  // Two in-process swarms both joining client+server can dedupe such that both
  // ends report conn.client=false. Assign roles by swarm instance instead, and
  // ignore duplicate connection events per role.
  if (isOriginator) {
    if (originatorStarted) { conn.on('error', () => {}); return; }
    originatorStarted = true;
    // ORIGINATOR: stamp + send frames, measure RTT on echo.
    console.log(`connected (originator) after ${connectedMs}ms — streaming ${Math.round((DURATION_MS/1000)*FPS)} frames @ ${FPS}fps`);
    const inflight = new Map();
    const rttsMs = [];
    let sent = 0, seq = 0;
    frameStreamHandler(conn, (f) => {
      const { seq: s } = readFrame(f);
      const t0 = inflight.get(s);
      if (t0 === undefined) return;
      inflight.delete(s);
      rttsMs.push(Number(process.hrtime.bigint() - t0) / 1e6);
    });
    const total = Math.round((DURATION_MS / 1000) * FPS);
    const iv = setInterval(() => {
      if (seq >= total) {
        clearInterval(iv);
        setTimeout(() => finish({ connectedMs, sent, rttsMs }), 800);
        return;
      }
      const now = process.hrtime.bigint();
      inflight.set(seq, now);
      conn.write(makeFrame(seq, now)); sent++; seq++;
    }, 1000 / FPS);
  } else {
    // ECHOER: bounce every frame back.
    if (echoerStarted) { conn.on('error', () => {}); return; }
    echoerStarted = true;
    console.log(`connected (echoer) after ${connectedMs}ms`);
    frameStreamHandler(conn, (f) => { try { conn.write(Buffer.from(f)); } catch {} });
  }
}

a.on('connection', (c) => onConnection(c, true));  // a = originator
b.on('connection', (c) => onConnection(c, false)); // b = echoer

const timer = setTimeout(() => {
  console.error(`\nTIMEOUT after ${CONNECT_TIMEOUT_MS}ms — peers never connected (DHT/UDP issue).`);
  process.exit(1);
}, CONNECT_TIMEOUT_MS);

async function finish({ connectedMs, sent, rttsMs }) {
  if (measured) return; measured = true;
  clearTimeout(timer);
  console.log(`\n(discovery+holepunch: ${connectedMs}ms)`);
  const r = summarize('Hyperswarm encrypted UDX stream (loopback DHT)', { sent, rttsMs });
  await a.destroy(); await b.destroy();
  console.log(r.ok && r.oneWayP50 < 15 ? '\nRESULT: PASS — realistic path overhead acceptable (add WAN RTT for real links).' : '\nRESULT: see numbers above.');
  process.exit(0);
}

console.log('voice/02 Hyperswarm frame RTT — joining shared topic via public DHT...');
await a.join(topic, { server: true, client: true }).flushed();
b.join(topic, { server: true, client: true });
