/**
 * Dedup re-run under Haiku (mem0-extraction-via-claude-session P-008):
 * re-runs the memory-backend benchmark's write-round-trip/near-dup tier
 * with the SESSION-backed extractor (claude-haiku-4-5 on anthropic-direct)
 * and persists a comparison artifact next to the original scorecard.
 *
 *   npx tsx packages/operator-core/lib/memory/bench/dedup-rerun-cli.ts
 *
 * Context: the scorecard's near-dup result — **0/6 merged**
 * (memory-bench-2026-06-05T14-40-41-392Z) — was measured under the
 * gpt-4o-mini FALLBACK extractor (a stale Anthropic key forced the
 * understudy), with the note "may differ under Haiku". This CLI settles
 * that open question by re-running the SAME tier (same ROUNDTRIP_SPECS,
 * same runRoundtrips methodology, same isolation pattern) with the
 * intended extractor.
 *
 * Like the benchmark, the run DECIDES NOTHING (bench D-006): it emits
 * the observed merge counts; the revive-vs-retire call stays the
 * owner's. The only failure mode is methodological: if the extraction
 * did NOT ride the session rung (usage counters unchanged), the run is
 * invalid — it would just re-measure a key rung — and exits 1.
 *
 * Needs: a Claude session (`~/.claude/.credentials.json`), PG reachable
 * via the memory host's admin URL, and an embedder key (OpenAI). Exit
 * codes: 0 = ran + artifact written, 1 = failed/invalid, 2 = skipped
 * (no usable Claude session).
 */
import fs from 'node:fs';
import path from 'node:path';

import { Mem0Backend, invalidateMemoryClient } from '@papercusp/memory';
import { runRoundtrips, type RoundtripOutcome } from '@papercusp/memory/bench';

import { benchPgClient, dropBenchSchema, ensureBenchSchema, setupBenchMemoryHost } from './bench-host';
import { ROUNDTRIP_SPECS } from './roundtrip-specs';
import {
  getSessionExtractionLlm,
  sessionExtractionUsage,
} from '../session-extraction-llm';

const SCHEMA = 'bench_dedup_haiku';
const SCOPE = 'bench-dedup';
/** The result this re-run answers (gpt-4o-mini fallback, 2026-06-05). */
const BASELINE = {
  artifact: 'memory-bench-2026-06-05T14-40-41-392Z',
  extractor: 'gpt-4o-mini (key-rung fallback — stale Anthropic key)',
  merged: 0,
  of: 6,
};

function log(msg: string): void {
  console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);
}

// Preflight: the re-run is ABOUT the session-backed Haiku extractor —
// skip rather than silently re-measure a key rung.
const sessionLlm = await getSessionExtractionLlm();
if (!sessionLlm) {
  console.error(
    'SKIP: no usable Claude session — the dedup re-run needs the session-backed Haiku extractor.',
  );
  process.exit(2);
}
log('preflight ok: session extraction LLM resolved (probe passed)');

setupBenchMemoryHost(SCHEMA);
const pg = await benchPgClient();
await ensureBenchSchema(pg, SCHEMA);
invalidateMemoryClient();

let failed: string | null = null;
let outcomes: RoundtripOutcome[] = [];
const usageBefore = { ...sessionExtractionUsage() };
try {
  const backend = new Mem0Backend();
  log(`write round-trips (${ROUNDTRIP_SPECS.length} specs) on the session-backed extractor…`);
  outcomes = await runRoundtrips(backend, ROUNDTRIP_SPECS, { scope: SCOPE });
} catch (e) {
  failed = `threw: ${(e as Error).stack ?? (e as Error).message}`;
} finally {
  log('cleanup: dropping isolated schema');
  await dropBenchSchema(pg, SCHEMA).catch((e) =>
    console.error(`cleanup failed (manual: DROP SCHEMA ${SCHEMA} CASCADE): ${e.message}`),
  );
  await pg.end();
  invalidateMemoryClient();
}

const usageAfter = sessionExtractionUsage();
const callsDelta = usageAfter.calls - usageBefore.calls;
const tokensDelta =
  usageAfter.tokensIn + usageAfter.tokensOut - (usageBefore.tokensIn + usageBefore.tokensOut);
log(
  `session rung usage: +${callsDelta} calls, +${tokensDelta} tokens (model ${usageAfter.model}); ` +
    `authRetries=${usageAfter.authRetries - usageBefore.authRetries}, ` +
    `jsonRepairs=${usageAfter.jsonRepairs - usageBefore.jsonRepairs}, ` +
    `failures=${usageAfter.failures - usageBefore.failures}`,
);
if (!failed && callsDelta <= 0) {
  failed = 'extraction did NOT ride the session adapter (usage counters unchanged) — re-run invalid';
}

if (failed) {
  console.error(`FAIL: ${failed}`);
  process.exit(1);
}

// ---- Persist the comparison artifact -------------------------------------
const stored = outcomes.filter((o) => o.stored);
const dupCounts = stored.map((o) => o.nearDupNewEntries);
const merged = dupCounts.filter((c) => c === 0).length;
const threw = dupCounts.filter((c) => c < 0).length;

const startedAt = new Date().toISOString();
const stamp = startedAt.replace(/[:.]/g, '-');
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..', '..');
const dir = path.join(repoRoot, '.papercusp', 'bench-reports');
fs.mkdirSync(dir, { recursive: true });

const report = {
  kind: 'dedup-rerun-haiku',
  plan: 'mem0-extraction-via-claude-session-2026-06-06 P-008',
  startedAt,
  extractor: {
    rung: 'claude-session (anthropic-direct)',
    model: usageAfter.model,
    calls: callsDelta,
    tokens: tokensDelta,
    authRetries: usageAfter.authRetries - usageBefore.authRetries,
    jsonRepairs: usageAfter.jsonRepairs - usageBefore.jsonRepairs,
    failures: usageAfter.failures - usageBefore.failures,
  },
  baseline: BASELINE,
  result: { merged, of: stored.length, threw },
  outcomes,
};
const jsonPath = path.join(dir, `memory-dedup-haiku-${stamp}.json`);
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

const rows = outcomes
  .map(
    (o) =>
      `| ${o.specId} | ${o.stored ? 'yes' : 'NO'} | ${
        o.nearDupNewEntries < 0 ? 'threw' : o.nearDupNewEntries
      } | ${o.stored && o.nearDupNewEntries === 0 ? 'merged' : o.nearDupNewEntries > 0 ? 'appended' : '—'} |`,
  )
  .join('\n');
const md =
  `# mem0 near-dup re-run under Haiku — ${startedAt}\n\n` +
  `Re-runs the write-round-trip/near-dup tier (same specs + methodology as the\n` +
  `memory-backend benchmark) with the SESSION-backed extractor\n` +
  `(\`${usageAfter.model}\` on anthropic-direct), per\n` +
  `mem0-extraction-via-claude-session-2026-06-06 P-008.\n\n` +
  `| | extractor | near-dup behavior |\n| --- | --- | --- |\n` +
  `| baseline (${BASELINE.artifact}) | ${BASELINE.extractor} | **${BASELINE.merged}/${BASELINE.of} merged** |\n` +
  `| this run | claude-session rung, ${usageAfter.model} | **${merged}/${stored.length} merged**${threw ? ` (${threw} threw)` : ''} |\n\n` +
  `## Per-spec\n\n| spec | stored | near-dup new entries | behavior |\n| --- | --- | --- | --- |\n` +
  rows +
  `\n\n## Session-rung proof\n` +
  `${callsDelta} extraction calls, ${tokensDelta} tokens on the session rung's own counters ` +
  `(authRetries=${report.extractor.authRetries}, jsonRepairs=${report.extractor.jsonRepairs}, ` +
  `failures=${report.extractor.failures}). A zero delta would have invalidated the run (exit 1).\n\n` +
  `## Reading it\n` +
  `"merged" = the near-dup write produced 0 new entries (the extractor chose\n` +
  `UPDATE/NONE over ADD). Observational per bench D-006 — no recommendation here;\n` +
  `this updates the facts under the owner's revive-vs-retire call.\n`;
const mdPath = path.join(dir, `memory-dedup-haiku-${stamp}.md`);
fs.writeFileSync(mdPath, md, 'utf8');

log(`near-dup under Haiku: ${merged}/${stored.length} merged (baseline ${BASELINE.merged}/${BASELINE.of} under gpt-4o-mini)`);
log(`wrote ${jsonPath}`);
log(`wrote ${mdPath}`);
process.exit(0);
