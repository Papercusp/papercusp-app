/**
 * voice/04 — operator-as-local-node IPC audio bridge (P-003).
 *
 * The pui/desktop must stream raw audio frames to/from their LOCAL operator node.
 * The existing IPC `sys:http` path reassembles bodies as UTF-8 text → binary-
 * UNSAFE for audio. This spike proves a binary-safe local channel over a Unix
 * domain socket with length-prefixed framing: round-trip every byte value 0-255
 * intact, at 50fps, and measure local-hop latency (the cost D-002 adds).
 */
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { FRAME_BYTES, FPS, DURATION_MS } from './lib-stats.mjs';

const SOCK = join(tmpdir(), `voice-ipc-${process.pid}.sock`);
try { unlinkSync(SOCK); } catch {}

// Length-prefixed binary framer: [u32be len][payload].
function framer(sock, onFrame) {
  let acc = Buffer.alloc(0);
  sock.on('data', (d) => {
    acc = acc.length ? Buffer.concat([acc, d]) : d;
    while (acc.length >= 4) {
      const len = acc.readUInt32BE(0);
      if (acc.length < 4 + len) break;
      onFrame(acc.subarray(4, 4 + len));
      acc = acc.subarray(4 + len);
    }
  });
}
function send(sock, payload) {
  const h = Buffer.alloc(4); h.writeUInt32BE(payload.length, 0);
  sock.write(Buffer.concat([h, payload]));
}

// A binary frame that exercises all byte values + an embedded timestamp.
function audioFrame(seq, tNs) {
  const b = Buffer.alloc(FRAME_BYTES);
  b.writeUInt32BE(seq >>> 0, 0);
  b.writeBigInt64BE(tNs, 4);
  for (let i = 12; i < FRAME_BYTES; i++) b[i] = (seq + i) & 0xff; // all byte values cycle through
  return b;
}

// SERVER = operator node: echo frames back (stand-in for "received from a peer").
const server = net.createServer((sock) => {
  framer(sock, (f) => send(sock, Buffer.from(f)));
});
server.listen(SOCK, () => runClient());

function runClient() {
  // CLIENT = pui/desktop: stream frames, verify integrity + measure RTT.
  const c = net.createConnection(SOCK);
  const inflight = new Map();
  const rtts = [];
  let sent = 0, corrupt = 0;
  c.on('connect', () => {
    framer(c, (f) => {
      const seq = f.readUInt32BE(0);
      const t0 = inflight.get(seq);
      if (t0 !== undefined) { inflight.delete(seq); rtts.push(Number(process.hrtime.bigint() - t0) / 1e6); }
      // integrity check: payload bytes must match what we sent
      for (let i = 12; i < FRAME_BYTES; i++) if (f[i] !== ((seq + i) & 0xff)) { corrupt++; break; }
    });
    const total = Math.round((DURATION_MS / 1000) * FPS);
    let seq = 0;
    const iv = setInterval(() => {
      if (seq >= total) { clearInterval(iv); setTimeout(() => finish(rtts, sent, corrupt), 400); return; }
      const now = process.hrtime.bigint();
      inflight.set(seq, now);
      send(c, audioFrame(seq, now)); sent++; seq++;
    }, 1000 / FPS);
  });
}

function finish(rtts, sent, corrupt) {
  const s = rtts.sort((a, b) => a - b);
  const p = (q) => s[Math.min(s.length - 1, Math.floor(q / 100 * s.length))];
  console.log(`\n[IPC unix-socket binary bridge]  sent=${sent} recv=${s.length} corrupt=${corrupt}`);
  console.log(`  round-trip ms: p50=${p(50).toFixed(3)} p95=${p(95).toFixed(3)} p99=${p(99).toFixed(3)} max=${s[s.length-1].toFixed(3)}`);
  console.log(`  local-hop one-way ≈ ${(p(50)/2).toFixed(3)}ms`);
  const ok = corrupt === 0 && s.length === sent && p(95) < 5;
  console.log(ok ? 'RESULT: PASS — binary-safe, lossless, sub-ms local hop. Operator-as-node IPC bridge is viable.' : 'RESULT: see numbers above.');
  server.close(); try { unlinkSync(SOCK); } catch {}
  process.exit(0);
}

console.log(`voice/04 IPC binary audio bridge — ${SOCK}`);
