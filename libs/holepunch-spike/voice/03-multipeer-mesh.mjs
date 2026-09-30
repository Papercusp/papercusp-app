/**
 * voice/03 — N-party mesh de-risk (P-006 mesh topology + P-014 multi-peer).
 *
 * 1 originator + K echoer peers, each its own Hyperswarm instance (separate UDP
 * socket + DHT presence) joined to one topic — a real K+1-party mesh in one
 * process. Originator streams frames to ALL peers and measures per-peer RTT.
 *
 * Answers: does one Node node hold several simultaneous P2P peer connections and
 * keep frame latency low? (The mesh-fan-out unknown; bandwidth is known-tiny.)
 */
import Hyperswarm from 'hyperswarm';
import crypto from 'node:crypto';
import { makeFrame, readFrame, FRAME_BYTES, FPS, DURATION_MS } from './lib-stats.mjs';

const K = Number(process.env.PEERS || 3); // echoer peers → (K+1)-party call
const CONNECT_TIMEOUT_MS = 60_000;
const topic = crypto.randomBytes(32);
const mkSwarm = () => new Hyperswarm(); // public DHT (proven in voice/02)

function frameReader(conn, onFrame) {
  let acc = Buffer.alloc(0);
  conn.on('data', (d) => {
    acc = acc.length ? Buffer.concat([acc, d]) : d;
    while (acc.length >= FRAME_BYTES) { onFrame(acc.subarray(0, FRAME_BYTES)); acc = acc.subarray(FRAME_BYTES); }
  });
  conn.on('error', () => {});
}

// Echoer peers
const echoers = [];
for (let i = 0; i < K; i++) {
  const sw = mkSwarm();
  sw.on('connection', (conn) => frameReader(conn, (f) => { try { conn.write(Buffer.from(f)); } catch {} }));
  echoers.push(sw);
}

// Originator
const origin = mkSwarm();
const peers = new Map(); // conn -> { rtts:[], inflight:Map }
let streaming = false;

origin.on('connection', (conn) => {
  if (peers.has(conn)) return;
  const st = { rtts: [], inflight: new Map() };
  peers.set(conn, st);
  frameReader(conn, (f) => {
    const { seq } = readFrame(f);
    const t0 = st.inflight.get(seq);
    if (t0 === undefined) return;
    st.inflight.delete(seq);
    st.rtts.push(Number(process.hrtime.bigint() - t0) / 1e6);
  });
  console.log(`peer ${peers.size}/${K} connected (${Date.now() - startedAt}ms)`);
  if (peers.size === K && !streaming) startStreaming();
});

const startedAt = Date.now();
const timer = setTimeout(() => { console.error(`\nTIMEOUT — only ${peers.size}/${K} peers connected`); process.exit(1); }, CONNECT_TIMEOUT_MS);

function startStreaming() {
  streaming = true;
  clearTimeout(timer);
  const total = Math.round((DURATION_MS / 1000) * FPS);
  let seq = 0;
  console.log(`\nall ${K} peers up — broadcasting ${total} frames @ ${FPS}fps to each`);
  const iv = setInterval(() => {
    if (seq >= total) { clearInterval(iv); setTimeout(finish, 1000); return; }
    const now = process.hrtime.bigint();
    const fr = makeFrame(seq, now);
    for (const [conn, st] of peers) { st.inflight.set(seq, now); try { conn.write(fr); } catch {} }
    seq++;
  }, 1000 / FPS);
}

async function finish() {
  let i = 0; const allRtts = [];
  for (const [, st] of peers) {
    i++;
    const s = [...st.rtts].sort((a, b) => a - b);
    allRtts.push(...st.rtts);
    const p = (q) => s.length ? s[Math.min(s.length - 1, Math.floor(q / 100 * s.length))] : NaN;
    console.log(`  peer ${i}: recv=${st.rtts.length} p50=${p(50)?.toFixed(3)}ms p95=${p(95)?.toFixed(3)}ms max=${s[s.length-1]?.toFixed(3)}ms`);
  }
  const s = allRtts.sort((a, b) => a - b);
  const p = (q) => s[Math.min(s.length - 1, Math.floor(q / 100 * s.length))];
  console.log(`\n[${K + 1}-party mesh] aggregate frames=${s.length} p50=${p(50).toFixed(3)}ms p95=${p(95).toFixed(3)}ms p99=${p(99).toFixed(3)}ms`);
  console.log(p(95) < 20 ? `RESULT: PASS — one node holds ${K} peer streams with low latency.` : 'RESULT: see numbers.');
  await origin.destroy(); for (const e of echoers) await e.destroy();
  process.exit(0);
}

console.log(`voice/03 ${K + 1}-party mesh — joining topic via public DHT (${K} echoers + 1 originator)...`);
// Echoers are the announced servers — they MUST flush (announce) before the
// originator (client) can discover them. (The bug in the first cut: unflushed
// echoer joins → nothing to discover → 0 connections.)
await Promise.all(echoers.map((e) => e.join(topic, { server: true, client: true }).flushed()));
origin.join(topic, { server: true, client: true });
