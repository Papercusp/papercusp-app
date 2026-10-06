/**
 * Save-time substance check measurement CLI (plan jev-performance-improvements-2026-09-30, P-010).
 *
 *   npx tsx packages/operator-core/lib/memory/bench/jev-substance-cli.ts \
 *     [--sample 600] [--seed p010] [--paired 150] [--concurrency 4] [--substance-wording v1|trigger]
 *
 * `--substance-wording` (WI-10004428) asks the substance question under a named wording
 * (jev-substance-wording.ts); absent, it asks the production JEV_SUBSTANCE_WORDING.
 * `--exclude-sample-seed a,b` draws a sample disjoint from those seeds' samples.
 * Every run also scores the held-out trigger set (jev-substance-heldout.ts) at the
 * production threshold, CONTENT_FREE_MAX_P_CONCRETE.
 *
 * Asks memory:remember's substance question (jev-conflict-judge.ts buildConflictRequest
 * with `substance`) of every bench self-promoter and of a deterministic sample of the
 * live store's real memories (allowlisted pools only, entity nodes and closed rows
 * excluded — corpus-sweep-io.ts), chooses the refusal threshold on half the real sample
 * and confirms it on the other half (jev-substance.ts). `--paired N` re-asks the first N
 * rows with three other sampled memories as conflict neighbours, the request shape the
 * write path sends, and reports how far P(concrete) moves.
 *
 * Every call is live (consumer `memory-substance-bench`, recorded in
 * harness_shared.decision_model_calls). Nothing is written to the memory store.
 * Needs PG and the Jev key. Artifacts: .papercusp/bench-reports/jev-substance-<stamp>.{json,md}.
 */
import fs from 'node:fs';
import path from 'node:path';

import { JEV_PINNED_MODEL } from '@papercusp/decision-model';

import { decisionModelLedgerStats } from '../../decision-model-ledger';
import { classifyPool, normalizeForDedup } from '../corpus-sweep';
import { liveCorpusSweepDeps } from '../corpus-sweep-io';
import {
  buildConflictRequest,
  CONTENT_FREE_MAX_P_CONCRETE,
  JEV_CONFLICT_TIMEOUT_MS,
  substancePConcrete,
} from '../jev-conflict-judge';
import { ensureJevDecisionClient, readJevApiKey } from '../jev-settings';
import { parseSubstanceWording } from '../jev-substance-wording';
import { loadGoldSetFixture } from './gold-set';
import { buildAdversarialCorpus } from './jev-robustness';
import {
  HELDOUT_TRIGGER_CONCRETE,
  HELDOUT_TRIGGER_PROMOTERS,
  renderHeldoutMarkdown,
  summarizeHeldout,
  type HeldoutScored,
} from './jev-substance-heldout';
import {
  pairedShift,
  percentile,
  rateAt,
  renderSubstanceMarkdown,
  seededSample,
  selectThreshold,
  splitHalves,
  substanceVerdict,
  type SubstanceReport,
  type SubstanceRow,
} from './jev-substance';

const CONSUMER = 'memory-substance-bench';
const MIN_REAL_SAMPLE = 500;

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const intArg = (flag: string, dflt: number) => {
  const v = argValue(flag);
  const n = v === undefined ? dflt : Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};
const sampleSize = intArg('--sample', 600);
const seed = argValue('--seed') ?? 'p010';
const pairedN = intArg('--paired', 150);
const concurrency = Math.max(1, intArg('--concurrency', 4));
const wording = parseSubstanceWording(argValue('--substance-wording'));
/**
 * Draw the sample from rows earlier samples did NOT draw: a fresh, disjoint confirmation
 * sample. Comma-separated seeds are replayed in order, each drawn from what the previous
 * ones left, which reproduces how those earlier runs were themselves drawn.
 */
const excludeSampleSeed = argValue('--exclude-sample-seed');

async function mapPool<T, R>(items: readonly T[], width: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

if (!(await readJevApiKey())) {
  console.error('No Jev key stored (TYPESAFE_API_KEY). Save one in Settings > Memory, then re-run.');
  process.exit(2);
}
const client = ensureJevDecisionClient();

async function ask(text: string, neighbours: readonly string[] = []): Promise<{ p: number | null; ms: number; failure: string | null }> {
  const { request, substanceId } = buildConflictRequest(
    text,
    neighbours.map((t) => ({ text: t })),
    { substance: true, substanceWording: wording },
  );
  const started = Date.now();
  try {
    const outcome = await client.decide(request, { consumer: CONSUMER, timeoutMs: JEV_CONFLICT_TIMEOUT_MS });
    const ms = Date.now() - started;
    if (outcome.kind === 'inconclusive') return { p: null, ms, failure: outcome.reason };
    const p = substancePConcrete(outcome, substanceId!);
    return { p, ms, failure: p === null ? 'malformed-response' : null };
  } catch (e) {
    return { p: null, ms: Date.now() - started, failure: String(e).slice(0, 200) };
  }
}

let exitCode = 0;
const wired = await liveCorpusSweepDeps();
if (!wired) {
  console.error('memory store unreachable');
  process.exit(2);
}
try {
  const pools = (await wired.deps.listPools()).filter((p) => classifyPool(p) !== null);
  const seen = new Set<string>();
  const live: { id: string; pool: string; text: string }[] = [];
  for (const pool of pools) {
    for (const r of await wired.deps.listRows(pool)) {
      if (r.invalidAt !== null || !r.text.trim()) continue;
      const norm = normalizeForDedup(r.text);
      if (seen.has(norm)) continue; // one copy of an exact duplicate
      seen.add(norm);
      live.push({ id: r.id, pool: r.pool, text: r.text });
    }
  }
  const excluded = new Set<string>();
  for (const s of (excludeSampleSeed ?? '').split(',').filter(Boolean)) {
    for (const r of seededSample(live.filter((x) => !excluded.has(x.id)), sampleSize, s)) excluded.add(r.id);
  }
  const sample = seededSample(
    live.filter((r) => !excluded.has(r.id)),
    sampleSize,
    seed,
  );
  const promoters = buildAdversarialCorpus(loadGoldSetFixture().queries).map((e) => ({ id: e.key, pool: null, text: e.text }));
  console.log(`[jev-substance] ${live.length} live real memories in ${pools.length} pools; sample ${sample.length}; ${promoters.length} self-promoters`);

  const inputs = [
    ...promoters.map((p) => ({ ...p, population: 'self-promoter' as const })),
    ...sample.map((s) => ({ ...s, population: 'real' as const })),
  ];
  let done = 0;
  const rows: SubstanceRow[] = await mapPool(inputs, concurrency, async (item) => {
    const r = await ask(item.text);
    if (++done % 100 === 0) console.log(`[jev-substance] ${done}/${inputs.length}`);
    return { id: item.id, population: item.population, pool: item.pool, text: item.text, pConcrete: r.p, latencyMs: r.ms, failure: r.failure };
  });

  const real = rows.filter((r) => r.population === 'real');
  const { selection, confirmation } = splitHalves(real);
  const threshold = selectThreshold(selection);

  // Paired check: half real, half self-promoters, each re-asked with three other
  // sampled memories as conflict neighbours.
  const pairedRows = [
    ...real.slice(0, Math.ceil(pairedN / 2)),
    ...rows.filter((r) => r.population === 'self-promoter').slice(0, Math.floor(pairedN / 2)),
  ];
  const pairs = await mapPool(pairedRows, concurrency, async (row, i) => {
    const neighbours = [1, 2, 3].map((k) => sample[(i * 7 + k * 13) % sample.length].text).filter((t) => t !== row.text);
    const again = await ask(row.text, neighbours);
    return { id: row.id, population: row.population, alone: row.pConcrete, withNeighbours: again.p };
  });
  const paired = pairedN > 0 && threshold !== null ? pairedShift(pairs, threshold) : null;

  // Held-out trigger set, scored at the production threshold (never used to choose t).
  const heldoutInputs = [
    ...HELDOUT_TRIGGER_PROMOTERS.map((r) => ({ ...r, population: 'heldout-promoter' as const })),
    ...HELDOUT_TRIGGER_CONCRETE.map((r) => ({ ...r, population: 'heldout-concrete' as const })),
  ];
  const heldoutRows: HeldoutScored[] = await mapPool(heldoutInputs, concurrency, async (item) => {
    const r = await ask(item.text);
    return { ...item, pConcrete: r.p };
  });
  const heldout = summarizeHeldout(heldoutRows, CONTENT_FREE_MAX_P_CONCRETE);
  const benchSavedAtProduction = rows.filter(
    (r) => r.population === 'self-promoter' && r.pConcrete !== null && r.pConcrete >= CONTENT_FREE_MAX_P_CONCRETE,
  );

  const deadline = Date.now() + 15_000;
  const liveCalls = inputs.length + pairedRows.length + heldoutInputs.length;
  while (Date.now() < deadline) {
    const st = decisionModelLedgerStats();
    if (st.written + st.failed >= liveCalls) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const ledger = decisionModelLedgerStats();

  const latencies = rows.map((r) => r.latencyMs).filter((v): v is number => v !== null);
  const verdict = substanceVerdict({
    threshold,
    confirmation: rateAt(confirmation, threshold ?? 0),
    whole: rateAt(real, threshold ?? 0),
    sampleSize: real.length,
    minSample: MIN_REAL_SAMPLE,
  });
  const generatedAt = new Date().toISOString();
  const report: SubstanceReport = {
    generatedAt,
    params: {
      jevModel: JEV_PINNED_MODEL,
      question: 'jev-conflict-judge.ts buildConflictRequest { substance: true }, substance question per jev-substance-wording.ts',
      substanceWording: wording,
      productionThreshold: CONTENT_FREE_MAX_P_CONCRETE,
      benchSelfPromotersSavedAtProductionThreshold: benchSavedAtProduction.length,
      liveRealMemories: live.length,
      pools: pools.length,
      realSample: real.length,
      seed,
      excludedSampleSeed: excludeSampleSeed ?? null,
      selfPromoters: promoters.length,
      timeoutMs: JEV_CONFLICT_TIMEOUT_MS,
      pairedRows: pairedRows.length,
      decisionLedger: `${ledger.written} rows written, ${ledger.failed} failed; ${liveCalls} live Jev calls`,
    },
    rows,
    selectionIds: selection.map((r) => r.id),
    confirmationIds: confirmation.map((r) => r.id),
    threshold,
    verdict,
    paired,
    latency: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), failures: rows.filter((r) => r.failure).length },
  };
  const md = `${renderSubstanceMarkdown(report)}\n\n${renderHeldoutMarkdown(heldout)}`;
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..', '..');
  const dir = path.join(repoRoot, '.papercusp', 'bench-reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = `${wording}-${generatedAt.replace(/[:.]/g, '-')}`;
  fs.writeFileSync(
    path.join(dir, `jev-substance-${stamp}.json`),
    JSON.stringify({ report, pairs, heldoutRows, heldout }, null, 2) + '\n',
    'utf8',
  );
  fs.writeFileSync(path.join(dir, `jev-substance-${stamp}.md`), md + '\n', 'utf8');
  console.log('\n' + md + '\n');
  console.log('wrote', path.join(dir, `jev-substance-${stamp}.md`));
  if (!verdict.pass) exitCode = 3;
} catch (e) {
  console.error(e);
  exitCode = 1;
} finally {
  await wired.close();
}
process.exit(exitCode);
