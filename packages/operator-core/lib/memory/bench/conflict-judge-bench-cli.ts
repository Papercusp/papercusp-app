/**
 * Jev conflict-judge validation CLI (plan jev-decision-model-integration-2026-09-29, P-009).
 *
 *   npx tsx packages/operator-core/lib/memory/bench/conflict-judge-bench-cli.ts [--concurrency 4]
 *
 * Asks the production judge (judgeConflictsWithJev, the exact request memory:remember
 * sends) about every case in the frozen labelled sample, three times: twice in
 * retrieval order and once with the neighbour order reversed. Scores the results
 * against decision D-015 (conflict-judge-bench.ts) and writes
 * .papercusp/bench-reports/jev-conflict-<stamp>.{json,md}.
 *
 * Every call goes through the process decision client, so it lands in
 * harness_shared.decision_model_calls under consumer `memory-conflict-bench` (P-003).
 * Needs PG (the ledger and the key store) and a stored Jev key (Settings > Memory,
 * or setup:save_integration_key TYPESAFE_API_KEY). Exits 2 without a key.
 */
import fs from 'node:fs';
import path from 'node:path';

import { decisionModelLedgerStats } from '../../decision-model-ledger';
import {
  JevConflictInconclusiveError,
  judgeConflictsWithJev,
  parseConflictWording,
  type ConflictVerdict,
} from '../jev-conflict-judge';
import { ensureJevDecisionClient, readJevApiKey } from '../jev-settings';
import {
  evaluateD015,
  renderConflictBenchReport,
  scoreConflictBench,
  type ConflictBenchCalls,
  type ConflictPairResult,
} from './conflict-judge-bench';
import { CONFLICT_JUDGE_SAMPLE, type ConflictSampleCase } from './conflict-judge-sample';

const CONSUMER = 'memory-conflict-bench';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const concurrency = Math.max(1, Number(flag('--concurrency') ?? 4));
/** P-009 / D-007: which wording to ask; absent means the production wording. */
const wording = parseConflictWording(flag('--wording'));

interface RunTally {
  calls: number;
  inconclusive: number;
  reasons: Record<string, number>;
  models: Set<string>;
}

async function judge(
  kase: ConflictSampleCase,
  order: 'forward' | 'reversed',
  tally: RunTally,
): Promise<Map<string, ConflictVerdict | null>> {
  const neighbours = order === 'forward' ? [...kase.neighbours] : [...kase.neighbours].reverse();
  tally.calls += 1;
  const out = new Map<string, ConflictVerdict | null>();
  try {
    const r = await judgeConflictsWithJev(
      { newText: kase.newText, neighbors: neighbours.map((n) => ({ id: n.id, text: n.text })) },
      { client: ensureJevDecisionClient, consumer: CONSUMER, wording },
    );
    tally.models.add(r.model);
    neighbours.forEach((n, i) => out.set(n.id, r.verdicts[i]));
  } catch (e) {
    tally.inconclusive += 1;
    const reason = e instanceof JevConflictInconclusiveError ? e.reason : `error: ${e instanceof Error ? e.message : String(e)}`;
    tally.reasons[reason] = (tally.reasons[reason] ?? 0) + 1;
    neighbours.forEach((n) => out.set(n.id, null));
  }
  return out;
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
  const tally: RunTally = { calls: 0, inconclusive: 0, reasons: {}, models: new Set() };
  const perCase = await pool(CONFLICT_JUDGE_SAMPLE, concurrency, async (kase) => {
    const forward = await judge(kase, 'forward', tally);
    const repeat = await judge(kase, 'forward', tally);
    const reversed = await judge(kase, 'reversed', tally);
    return kase.neighbours.map(
      (n): ConflictPairResult => ({
        caseId: kase.id,
        neighbourId: n.id,
        gold: n.gold,
        forward: forward.get(n.id) ?? null,
        repeat: repeat.get(n.id) ?? null,
        reversed: reversed.get(n.id) ?? null,
      }),
    );
  });
  const pairs = perCase.flat();
  const calls: ConflictBenchCalls = {
    calls: tally.calls,
    inconclusive: tally.inconclusive,
    inconclusiveReasons: tally.reasons,
    models: [...tally.models],
  };
  const metrics = scoreConflictBench(pairs, calls);
  const verdict = evaluateD015(metrics);
  const generatedAt = new Date().toISOString();
  const md = renderConflictBenchReport({ generatedAt, wording, calls, metrics, verdict, pairs });

  // Ledger rows are written fire-and-forget; give them a bounded moment to land.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const s = decisionModelLedgerStats();
    if (s.written + s.failed >= tally.calls) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const ledger = decisionModelLedgerStats();

  const dir = path.join(process.cwd(), '.papercusp', 'bench-reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = generatedAt.replace(/[:.]/g, '-');
  const jsonPath = path.join(dir, `jev-conflict-${stamp}.json`);
  const mdPath = path.join(dir, `jev-conflict-${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt, wording, calls, metrics, verdict, ledger, pairs }, null, 2) + '\n', 'utf8');
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
