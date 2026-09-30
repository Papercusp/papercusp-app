/**
 * Run the D-017 comparison: the Jev doc-contradiction judge against the incumbent
 * Anthropic judge on the labelled sample (plan jev-decision-model-integration-2026-09-29,
 * P-010).
 *
 *   npx tsx packages/operator-core/lib/search/bench/doc-contradiction-bench-cli.ts [--concurrency 4]
 *     [--incumbent-base-url http://127.0.0.1:8788]
 *
 * Needs a stored Jev key (Settings > Memory). The incumbent is the production
 * factory, createGatewayContradictionJudge, with its production model. On a host
 * without ANTHROPIC_API_KEY it is pointed at the local inference gateway, which
 * supplies the account credential itself; the key sent is then a placeholder.
 *
 * Both judges are probed on one pair first. If either cannot answer, the run stops
 * with exit 2 rather than scoring a judge that never ran.
 *
 * Writes .papercusp/bench-reports/jev-doc-contradiction-<stamp>.{json,md}.
 */
import fs from 'node:fs';
import path from 'node:path';

import { decisionModelLedgerStats } from '../../decision-model-ledger';
import { ensureJevDecisionClient, readJevApiKey } from '../../memory/jev-settings';
import type { ContradictionJudgeFn } from '../doc-contradiction-judge';
import { createGatewayContradictionJudge, DOC_CONTRADICTION_JUDGE_MODEL } from '../doc-contradiction-scan';
import {
  JevContradictionInconclusiveError,
  judgeContradictionWithJev,
  type ContradictionJudgement,
} from '../jev-contradiction-judge';
import {
  evaluateD017,
  renderDocContradictionReport,
  scoreDocContradictionBench,
  type DocContradictionCalls,
  type DocContradictionPairResult,
} from './doc-contradiction-bench';
import { DOC_CONTRADICTION_SAMPLE, type DocContradictionSamplePair } from './doc-contradiction-sample';

const CONSUMER = 'doc-contradiction-bench';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const concurrency = Math.max(1, Number(flag('--concurrency') ?? 4));

interface Tally {
  jevCalls: number;
  jevInconclusive: number;
  reasons: Record<string, number>;
  models: Set<string>;
  incumbentCalls: number;
  incumbentErrors: number;
}

async function askJev(p: DocContradictionSamplePair, swapped: boolean, t: Tally): Promise<ContradictionJudgement | null> {
  t.jevCalls += 1;
  try {
    const j = await judgeContradictionWithJev(swapped ? { a: p.b, b: p.a } : { a: p.a, b: p.b }, {
      client: ensureJevDecisionClient,
      consumer: CONSUMER,
    });
    t.models.add(j.model);
    return j;
  } catch (e) {
    t.jevInconclusive += 1;
    const reason = e instanceof JevContradictionInconclusiveError ? e.reason : `error: ${e instanceof Error ? e.message : String(e)}`;
    t.reasons[reason] = (t.reasons[reason] ?? 0) + 1;
    return null;
  }
}

async function askIncumbent(judge: ContradictionJudgeFn, p: DocContradictionSamplePair, swapped: boolean, t: Tally): Promise<boolean | null> {
  t.incumbentCalls += 1;
  const v = await judge(swapped ? { a: p.b, b: p.a } : { a: p.a, b: p.b });
  if (!v || typeof v.contradicts !== 'boolean') {
    t.incumbentErrors += 1;
    return null;
  }
  return v.contradicts;
}

async function pool<T, R>(items: readonly T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

let exitCode = 0;
try {
  if (!(await readJevApiKey())) {
    console.error('No Jev key is stored (TYPESAFE_API_KEY). Save one in Settings > Memory first.');
    process.exit(2);
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.PAPERCUSP_ANTHROPIC_URL && !process.env.ANTHROPIC_BASE_URL) {
    process.env.PAPERCUSP_ANTHROPIC_URL = flag('--incumbent-base-url') ?? 'http://127.0.0.1:8788';
  }
  const incumbent = createGatewayContradictionJudge({
    apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? 'local-gateway',
  });

  const probe = DOC_CONTRADICTION_SAMPLE[0];
  const probeTally: Tally = { jevCalls: 0, jevInconclusive: 0, reasons: {}, models: new Set(), incumbentCalls: 0, incumbentErrors: 0 };
  const [jevProbe, incProbe] = await Promise.all([askJev(probe, false, probeTally), askIncumbent(incumbent, probe, false, probeTally)]);
  if (!jevProbe || incProbe === null) {
    console.error(
      `Probe failed before scoring: jev=${jevProbe ? 'ok' : JSON.stringify(probeTally.reasons)} incumbent=${incProbe === null ? 'no answer' : 'ok'}. ` +
        'Not scoring a judge that cannot answer.',
    );
    process.exit(2);
  }

  const t: Tally = { jevCalls: 0, jevInconclusive: 0, reasons: {}, models: new Set(), incumbentCalls: 0, incumbentErrors: 0 };
  const pairs = await pool(DOC_CONTRADICTION_SAMPLE, concurrency, async (p): Promise<DocContradictionPairResult> => {
    const [jevForward, incumbentForward] = await Promise.all([askJev(p, false, t), askIncumbent(incumbent, p, false, t)]);
    const [jevRepeat, jevSwapped, incumbentSwapped] = await Promise.all([
      askJev(p, false, t),
      askJev(p, true, t),
      askIncumbent(incumbent, p, true, t),
    ]);
    return { id: p.id, gold: p.gold, note: p.note, jevForward, jevRepeat, jevSwapped, incumbentForward, incumbentSwapped };
  });

  const calls: DocContradictionCalls = {
    jevCalls: t.jevCalls,
    jevInconclusive: t.jevInconclusive,
    jevInconclusiveReasons: t.reasons,
    jevModels: [...t.models],
    incumbentCalls: t.incumbentCalls,
    incumbentErrors: t.incumbentErrors,
    incumbentModel: DOC_CONTRADICTION_JUDGE_MODEL,
  };
  const metrics = scoreDocContradictionBench(pairs, calls);
  const verdict = evaluateD017(metrics);
  const generatedAt = new Date().toISOString();
  const md = renderDocContradictionReport({ generatedAt, calls, metrics, verdict, pairs });

  // Ledger rows are written fire-and-forget; give them a bounded moment to land.
  const expected = t.jevCalls + probeTally.jevCalls;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const s = decisionModelLedgerStats();
    if (s.written + s.failed >= expected) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const ledger = decisionModelLedgerStats();

  const dir = path.join(process.cwd(), '.papercusp', 'bench-reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = generatedAt.replace(/[:.]/g, '-');
  const jsonPath = path.join(dir, `jev-doc-contradiction-${stamp}.json`);
  const mdPath = path.join(dir, `jev-doc-contradiction-${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt, calls, metrics, verdict, ledger, pairs }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(mdPath, md + '\n', 'utf8');
  console.log('\n' + md + '\n');
  console.log(`ledger: written=${ledger.written} failed=${ledger.failed}${ledger.lastError ? ` lastError=${ledger.lastError}` : ''}`);
  console.log('wrote', jsonPath);
  console.log('wrote', mdPath);
} catch (e) {
  console.error(e);
  exitCode = 1;
}
process.exit(exitCode);
