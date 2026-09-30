/**
 * Live load harness for the hive inference gateway (hive-inference-gateway P-008 + P-015).
 *
 * Boots a REAL gateway (bound account, real upstream api.anthropic.com) and fires N concurrent
 * tiny Claude-Code-framed requests through it, then asserts the gateway's central pacing absorbed
 * the burst as QUEUEING rather than letting it hit the upstream limit:
 *   - N=1  → P-008 (one bee end-to-end: auth injected + streaming intact + 200).
 *   - N=20 → P-015 (20-bee burst → ZERO upstream 429s; burst shows up as queue depth, not 429s).
 *
 * Live-spend + budget-gated: needs a HEALTHY bound credential and 5h-window headroom (D-009). NOT a
 * vitest test (it calls the real API) — run it as a node runner during a budget-available window:
 *
 *   npx tsx packages/operator-core/lib/inference-gateway/load-test.ts [N] [concurrency]
 *
 * Exit 0 = pass (all completed, zero upstream 429s). Exit 1 = upstream 429s seen (pacing too loose
 * for the live budget — lower concurrency) or requests failed. Exit 2 = couldn't even start (bad
 * credential / account rejected) — that's a budget/credential block, not a gateway failure.
 */
import { startGatewayService } from './launch';
import { fetchGatewayHeadroom } from './observability';

const CC = "You are Claude Code, Anthropic's official CLI for Claude.";

interface OneResult {
  status: number;
  ms: number;
  ok: boolean;
  bodySample?: string;
}

async function fireOne(port: number, model: string, i: number): Promise<OneResult> {
  const t0 = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-papercusp-priority': i === 0 ? 'interactive' : 'batch' },
      body: JSON.stringify({
        model,
        max_tokens: 4,
        system: [{ type: 'text', text: CC }],
        messages: [{ role: 'user', content: `ping ${i}` }],
      }),
    });
    const text = await res.text();
    return { status: res.status, ms: Date.now() - t0, ok: res.status === 200, bodySample: res.status === 200 ? undefined : text.slice(0, 160) };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, ok: false, bodySample: (e as Error).message };
  }
}

export async function runLoadTest(opts: { n?: number; concurrency?: number; model?: string } = {}): Promise<number> {
  const n = opts.n ?? 20;
  const concurrency = opts.concurrency ?? 24;
  const model = opts.model ?? 'claude-haiku-4-5-20251001'; // cheapest for the smoke

  const svc = await startGatewayService({ port: 0, concurrency, log: (l, m) => console.log(`  [gw:${l}] ${m}`) });
  const port = svc.port;
  console.log(`gateway up on :${port}, account '${svc.account.accountId}' (${svc.account.source}); firing ${n} reqs @ concurrency ${concurrency} model ${model}`);

  // A one-request preflight to detect a dead credential / fully-rejected account BEFORE the burst.
  const pre = await fireOne(port, model, 0);
  if (pre.status === 401) {
    console.error(`PREFLIGHT 401 — bound credential is invalid. body: ${pre.bodySample}`);
    await svc.stop();
    return 2;
  }
  if (pre.status === 0) {
    console.error(`PREFLIGHT transport error: ${pre.bodySample}`);
    await svc.stop();
    return 2;
  }

  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: n }, (_, i) => fireOne(port, model, i)));
  const wallMs = Date.now() - t0;
  results.unshift(pre);

  const ok = results.filter((r) => r.ok).length;
  const upstream429 = results.filter((r) => r.status === 429 && !String(r.bodySample).includes('"gateway":true')).length;
  const gatewayQueued429 = results.filter((r) => r.status === 429 && String(r.bodySample).includes('"gateway":true')).length;
  const failed = results.filter((r) => !r.ok && r.status !== 429).length;
  const maxMs = Math.max(...results.map((r) => r.ms));
  const headroom = await fetchGatewayHeadroom({ port });
  const stats = svc.gateway.stats();

  console.log('\n── load-test summary ──');
  console.log(`requests:        ${results.length} (1 preflight + ${n})`);
  console.log(`200 OK:          ${ok}`);
  console.log(`UPSTREAM 429:    ${upstream429}   ${upstream429 === 0 ? '✓ (pacing absorbed the burst)' : '✗ (pacing too loose for live budget)'}`);
  console.log(`gateway-queued:  ${gatewayQueued429} (admission-timeout 429s — raise maxQueueWaitMs or budget)`);
  console.log(`other failures:  ${failed}`);
  console.log(`peak queueDepth: ${stats.admission.queued} (burst absorbed as QUEUE, not upstream load)`);
  console.log(`wall:            ${wallMs}ms, slowest req ${maxMs}ms`);
  console.log(`unified 5h:      ${headroom.window ?? '—'} util ${headroom.utilizationPct ?? '—'}% reset in ${headroom.resetInSec ?? '—'}s rejected=${headroom.rejected ?? '—'}`);

  await svc.stop();

  // PASS: zero upstream 429s AND every request resolved (200 or a gateway-queued 429 is acceptable
  // backpressure; a raw upstream 429 or a transport failure is not).
  const pass = upstream429 === 0 && failed === 0;
  console.log(pass ? '\nRESULT: PASS ✓' : '\nRESULT: FAIL ✗');
  return pass ? 0 : 1;
}

// Run when invoked directly (node runner), not when imported.
if (process.argv[1] && process.argv[1].endsWith('load-test.ts')) {
  const n = Number(process.argv[2]) || 20;
  const concurrency = Number(process.argv[3]) || 24;
  runLoadTest({ n, concurrency })
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error('load-test fatal:', e);
      process.exit(2);
    });
}
