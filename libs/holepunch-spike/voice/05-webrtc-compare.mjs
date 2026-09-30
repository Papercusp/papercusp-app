/**
 * voice/05 — WebRTC-media comparison (P-002 other half: the "Quibble way").
 *
 * Two node-datachannel PeerConnections on loopback, manual in-process signaling,
 * a DataChannel ping-pong of ~Opus-sized binary frames. Compared head-to-head
 * with the UDX-native path (voice/02) to settle D-004.
 *
 * NOTE: a fair latency comparison on loopback is limited — both transports are
 * sub-ms locally. The decisive differences are architectural (extra native dep,
 * separate ICE/DTLS stack, does it reuse Holepunch discovery) + cross-NAT.
 */
import dc from 'node-datachannel';
import { makeFrame, readFrame, FRAME_BYTES, FPS, DURATION_MS } from './lib-stats.mjs';

const p1 = new dc.PeerConnection('p1', { iceServers: [] });
const p2 = new dc.PeerConnection('p2', { iceServers: [] });

p1.onLocalDescription((sdp, type) => p2.setRemoteDescription(sdp, type));
p1.onLocalCandidate((c, m) => p2.addRemoteCandidate(c, m));
p2.onLocalDescription((sdp, type) => p1.setRemoteDescription(sdp, type));
p2.onLocalCandidate((c, m) => p1.addRemoteCandidate(c, m));

const startedAt = Date.now();
const inflight = new Map();
const rtts = [];
let sent = 0, done = false;

// p2 echoes whatever it receives.
p2.onDataChannel((ch) => { ch.onMessage((msg) => { if (Buffer.isBuffer(msg)) ch.sendMessageBinary(msg); }); });

const ch1 = p1.createDataChannel('audio');
ch1.onOpen(() => {
  console.log(`datachannel open after ${Date.now() - startedAt}ms — streaming frames`);
  ch1.onMessage((msg) => {
    if (!Buffer.isBuffer(msg) || msg.length < FRAME_BYTES) return;
    const { seq } = readFrame(msg);
    const t0 = inflight.get(seq);
    if (t0 === undefined) return;
    inflight.delete(seq);
    rtts.push(Number(process.hrtime.bigint() - t0) / 1e6);
  });
  const total = Math.round((DURATION_MS / 1000) * FPS);
  let seq = 0;
  const iv = setInterval(() => {
    if (seq >= total) { clearInterval(iv); setTimeout(finish, 800); return; }
    const now = process.hrtime.bigint();
    inflight.set(seq, now);
    try { ch1.sendMessageBinary(makeFrame(seq, now)); sent++; } catch {}
    seq++;
  }, 1000 / FPS);
});

const timer = setTimeout(() => { if (!done) { console.error('\nTIMEOUT — datachannel never opened'); process.exit(1); } }, 30_000);

function finish() {
  if (done) return; done = true; clearTimeout(timer);
  const s = rtts.sort((a, b) => a - b);
  if (!s.length) { console.log('\n[WebRTC datachannel] NO frames returned'); process.exit(1); }
  const p = (q) => s[Math.min(s.length - 1, Math.floor(q / 100 * s.length))];
  console.log(`\n[WebRTC datachannel (loopback)]  sent=${sent} recv=${s.length} lost=${sent - s.length}`);
  console.log(`  RTT ms: p50=${p(50).toFixed(3)} p95=${p(95).toFixed(3)} p99=${p(99).toFixed(3)} max=${s[s.length-1].toFixed(3)}  one-way ≈ ${(p(50)/2).toFixed(3)}ms`);
  try { p1.close(); p2.close(); dc.cleanup(); } catch {}
  process.exit(0);
}

console.log('voice/05 WebRTC datachannel RTT (node-datachannel, loopback)...');
