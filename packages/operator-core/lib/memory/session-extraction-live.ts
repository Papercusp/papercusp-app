/**
 * LIVE session-extraction round-trip (mem0-extraction-via-claude-session
 * P-007): proves the cascade's session rung end-to-end on the REAL
 * anthropic-direct transport — `remember(raw text)` → facts extracted by
 * claude-haiku-4-5 riding the Claude session → stored in pgvector →
 * found by paraphrase search. Runs in its own isolated PG schema
 * (`bench_memory` D-009 pattern) so the live `harness_shared.memory_*`
 * tables are never touched; the schema is dropped on exit.
 *
 *   npx tsx packages/operator-core/lib/memory/session-extraction-live.ts
 *
 * Needs: a Claude session (`~/.claude/.credentials.json`), PG reachable
 * via the memory host's admin URL, and an embedder key (OpenAI) in
 * operator credentials. Exit codes: 0 = pass, 1 = fail, 2 = skipped
 * (no usable Claude session — the probe is about the session rung, so
 * a key-rung fallback pass would be a false positive).
 *
 * Registered in the memory testing domain as a node runner — see
 * `lib/testing-domains-registry.ts` (memory → Live).
 */
import { Mem0Backend, invalidateMemoryClient } from '@papercusp/memory';

import { benchPgClient, dropBenchSchema, ensureBenchSchema, setupBenchMemoryHost } from './bench/bench-host';
import {
  getSessionExtractionLlm,
  sessionExtractionUsage,
} from './session-extraction-llm';

const LIVE_SCHEMA = 'live_session_extraction';
const SCOPE = 'live-session-probe';
// A cipher marker no extractor will paraphrase away (the bench's trick).
const MARKER = 'zephyrglass-9000';
const RAW_TEXT =
  `note for memory: the team's experimental build server is nicknamed ${MARKER} ` +
  `and it only accepts deploys between 2am and 4am UTC`;
const PARAPHRASE = `what are the deploy-window constraints on the ${MARKER} machine?`;

function log(msg: string): void {
  console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);
}

// 1. Preflight: this probe is ABOUT the session rung — skip (don't
//    false-pass via key rungs) when no usable Claude session exists.
const sessionLlm = await getSessionExtractionLlm();
if (!sessionLlm) {
  console.error(
    'SKIP: no usable Claude session (~/.claude/.credentials.json missing, probe-rejected, ' +
      'rung demoted, or PAPERCUSP_MEM0_SESSION_EXTRACTION=0) — the session rung cannot be live-tested here.',
  );
  process.exit(2);
}
log('preflight ok: session extraction LLM resolved (probe passed)');

// 1b. EI-11042 invariant: with INFERENCE_GATEWAY on, `getSessionExtractionLlm`
//     (just called) must have pointed the anthropic-direct extraction egress at
//     the localhost gateway POOL (cross-account 429 failover) — never direct to
//     api.anthropic.com on a single account, the wall that flaked the bench write
//     probes. Off ⇒ direct egress is expected, so this only asserts when the
//     gateway is on. A gateway URL or any explicit override passes; only the bare
//     direct path fails.
{
  const { getFlag } = await import('@papercusp/flags/server');
  const { FLAGS } = await import('@papercusp/flags');
  const { resolveAnthropicBaseUrl } = await import('@papercusp/papercusp-shared/agent');
  const gatewayOn = await getFlag(FLAGS.INFERENCE_GATEWAY, 'system');
  const egress = resolveAnthropicBaseUrl();
  log(`extraction egress: ${egress} (INFERENCE_GATEWAY ${gatewayOn ? 'ON' : 'off'})`);
  if (gatewayOn && /(^|\/\/)api\.anthropic\.com/.test(egress)) {
    console.error(
      `FAIL: INFERENCE_GATEWAY is on but extraction still egresses DIRECT to ${egress} ` +
        `(single-account, no 429 failover) — the EI-11042 gateway-pool egress did not apply.`,
    );
    process.exit(1);
  }
}

// 2. Isolated schema + host pointed at it (operator seams carried over,
//    including the session rung).
setupBenchMemoryHost(LIVE_SCHEMA);
const pg = await benchPgClient();
await ensureBenchSchema(pg, LIVE_SCHEMA);
invalidateMemoryClient(); // force a clean client build under the live host

let failed: string | null = null;
try {
  const backend = new Mem0Backend();
  const usageBefore = { ...sessionExtractionUsage() };

  // 3. The real write path — extraction included (NOT verbatim).
  log(`remember(): ${RAW_TEXT.slice(0, 80)}…`);
  const t0 = performance.now();
  const r = await backend.remember(RAW_TEXT, { scope: SCOPE, kind: 'project' });
  const rememberMs = Math.round(performance.now() - t0);
  const stored = r.storedEvents ?? r.ids.length;
  log(`remember() → ${r.ids.length} ids, ${stored} stored events in ${rememberMs}ms`);
  if (stored <= 0) {
    failed = 'remember() stored nothing — extraction produced no facts';
  }

  // 4. Proof the extraction rode the SESSION rung, not a key rung.
  const usageAfter = sessionExtractionUsage();
  const callsDelta = usageAfter.calls - usageBefore.calls;
  const tokensDelta =
    usageAfter.tokensIn + usageAfter.tokensOut - (usageBefore.tokensIn + usageBefore.tokensOut);
  log(
    `session rung usage: +${callsDelta} calls, +${tokensDelta} tokens (model ${usageAfter.model}); ` +
      `authRetries=${usageAfter.authRetries}, jsonRepairs=${usageAfter.jsonRepairs}, failures=${usageAfter.failures}`,
  );
  if (!failed && callsDelta <= 0) {
    failed = 'extraction did NOT ride the session adapter (usage counters unchanged)';
  }

  // 5. Paraphrase search finds the extracted fact.
  if (!failed) {
    await new Promise((res) => setTimeout(res, 300)); // settle
    const hits = await backend.search(PARAPHRASE, { scope: SCOPE, limit: 5 });
    const rank = hits.findIndex((h) => h.text.toLowerCase().includes(MARKER));
    log(
      `search(paraphrase) → ${hits.length} hits; marker rank ${rank + 1}` +
        (rank >= 0 ? ` ("${hits[rank].text.slice(0, 90)}…")` : ''),
    );
    if (rank === -1) failed = `extracted fact not found by paraphrase search (marker ${MARKER})`;
  }
} catch (e) {
  failed = `threw: ${(e as Error).stack ?? (e as Error).message}`;
} finally {
  log('cleanup: dropping isolated schema');
  await dropBenchSchema(pg, LIVE_SCHEMA).catch((e) =>
    console.error(`cleanup failed (manual: DROP SCHEMA ${LIVE_SCHEMA} CASCADE): ${e.message}`),
  );
  await pg.end();
  invalidateMemoryClient();
}

if (failed) {
  console.error(`FAIL: ${failed}`);
  process.exit(1);
}
log('PASS: session-rung extraction round-trip (remember → Haiku facts → searchable)');
process.exit(0);
