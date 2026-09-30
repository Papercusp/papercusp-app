// Shared frame protocol + latency stats for the voice spike.
// Frame = 80 bytes: [seq u32be][t_send_ns i64be][padding...] — ~Opus 20ms frame size.

export const FRAME_BYTES = 80;
export const FPS = 50; // 20ms frames
export const DURATION_MS = 6000; // ~300 frames per run

export function makeFrame(seq, tSendNs) {
  const b = Buffer.alloc(FRAME_BYTES);
  b.writeUInt32BE(seq >>> 0, 0);
  b.writeBigInt64BE(tSendNs, 4);
  return b;
}

export function readFrame(b) {
  return { seq: b.readUInt32BE(0), tSendNs: b.readBigInt64BE(4) };
}

export function summarize(label, { sent, rttsMs }) {
  const recv = rttsMs.length;
  const lost = sent - recv;
  if (recv === 0) {
    console.log(`\n[${label}] sent=${sent} received=0 — NO FRAMES RETURNED (transport failed)`);
    return { ok: false };
  }
  const s = [...rttsMs].sort((a, b) => a - b);
  const pct = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  const mean = s.reduce((a, b) => a + b, 0) / recv;
  // RFC3550-style jitter on RTT samples (mean abs consecutive delta)
  let jit = 0;
  for (let i = 1; i < rttsMs.length; i++) jit += Math.abs(rttsMs[i] - rttsMs[i - 1]);
  jit = rttsMs.length > 1 ? jit / (rttsMs.length - 1) : 0;
  const f = (n) => n.toFixed(3);
  console.log(`\n[${label}]  frames sent=${sent} received=${recv} lost=${lost} (${f((lost / sent) * 100)}%)`);
  console.log(`  RTT ms:  min=${f(s[0])}  p50=${f(pct(50))}  p95=${f(pct(95))}  p99=${f(pct(99))}  max=${f(s[recv - 1])}  mean=${f(mean)}`);
  console.log(`  one-way ≈ ${f(pct(50) / 2)} ms (p50/2)   jitter ≈ ${f(jit)} ms`);
  return { ok: true, recv, sent, lost, p50: pct(50), p95: pct(95), p99: pct(99), oneWayP50: pct(50) / 2, jitterMs: jit };
}
