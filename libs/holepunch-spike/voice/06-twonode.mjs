/**
 * voice/06 — two-NODE test across a real OS/NAT boundary (P-013 partial).
 *
 * Run the SAME script on two hosts with the SAME topic hex:
 *   ECHOER (server):     node voice/06-twonode.mjs echoer   <topicHex>
 *   ORIGINATOR (client): node voice/06-twonode.mjs originator <topicHex>
 *
 * Used host(originator) ↔ QEMU-slirp VM(echoer). slirp has no UDP inbound
 * hostfwd, so a direct UDP hole-punch is expected to fail → this measures
 * whether Holepunch connects at all (direct vs relay) and the resulting latency.
 *   - low RTT  → direct path punched (slirp traversed)
 *   - high RTT → relayed via a DHT relay (fallback works)
 *   - timeout  → neither: we'd need our own TURN-like relay
 */
import Hyperswarm from 'hyperswarm';
import b4a from 'b4a';
import { makeFrame, readFrame, summarize, FRAME_BYTES, FPS, DURATION_MS } from './lib-stats.mjs';

const role = process.argv[2];
const topicHex = process.argv[3];
if (!['echoer', 'originator'].includes(role) || !topicHex || topicHex.length !== 64) {
  console.error('usage: node voice/06-twonode.mjs <echoer|originator> <64-char-topic-hex>');
  process.exit(2);
}
const topic = b4a.from(topicHex, 'hex');
const CONNECT_TIMEOUT_MS = 60_000;
const swarm = new Hyperswarm();
const startedAt = Date.now();
let handled = false;

function frameReader(conn, onFrame) {
  let acc = Buffer.alloc(0);
  conn.on('data', (d) => { acc = acc.length ? Buffer.concat([acc, d]) : d; while (acc.length >= FRAME_BYTES) { onFrame(acc.subarray(0, FRAME_BYTES)); acc = acc.subarray(FRAME_BYTES); } });
  conn.on('error', () => {});
}
function connInfo(conn) {
  const rs = conn.rawStream || {};
  return `remote=${rs.remoteHost || '?'}:${rs.remotePort || '?'}`;
}

swarm.on('connection', (conn) => {
  if (handled) { conn.on('error', () => {}); return; }
  handled = true;
  clearTimeout(timer);
  const connectedMs = Date.now() - startedAt;
  console.log(`connected after ${connectedMs}ms  ${connInfo(conn)}`);
  if (role === 'echoer') {
    frameReader(conn, (f) => { try { conn.write(Buffer.from(f)); } catch {} });
    console.log('echoing frames... (leave running until originator finishes)');
  } else {
    const inflight = new Map(); const rttsMs = []; let sent = 0, seq = 0;
    frameReader(conn, (f) => { const { seq: s } = readFrame(f); const t0 = inflight.get(s); if (t0 === undefined) return; inflight.delete(s); rttsMs.push(Number(process.hrtime.bigint() - t0) / 1e6); });
    const total = Math.round((DURATION_MS / 1000) * FPS);
    const iv = setInterval(() => {
      if (seq >= total) { clearInterval(iv); setTimeout(async () => { console.log(`\n(connect: ${connectedMs}ms  ${connInfo(conn)})`); summarize('two-node host↔VM', { sent, rttsMs }); await swarm.destroy(); process.exit(0); }, 1500); return; }
      const now = process.hrtime.bigint(); inflight.set(seq, now); conn.write(makeFrame(seq, now)); sent++; seq++;
    }, 1000 / FPS);
  }
});

const timer = setTimeout(() => { console.error(`\nTIMEOUT ${CONNECT_TIMEOUT_MS}ms — peers never connected (no direct punch AND no relay → need our own TURN).`); process.exit(1); }, CONNECT_TIMEOUT_MS);

console.log(`voice/06 ${role} — topic ${topicHex.slice(0, 12)}… joining via public DHT`);
const disc = swarm.join(topic, { server: true, client: true });
if (role === 'echoer') { await disc.flushed(); console.log('ANNOUNCED'); }
