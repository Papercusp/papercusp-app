/**
 * CLI: run the tau2-bench vanilla-vs-+memory comparison report from two standalone `results.json` files
 * (plan benchmark-capability-injection-redesign-2026-06-17, P-009 + P-011).
 *
 *   npx tsx packages/operator-core/lib/external-bench/tau2-results-cli.ts \
 *     <vanilla/results.json> <memory/results.json> [--run-id <id>] [--out <file.md>]
 *
 * Reads both arms' results.json, runs {@link reportTau2Comparison} (fair same-denominator attribution +
 * the mandatory C1-C10 fairness audit), prints the markdown, and writes it to --out (default
 * ~/.papercusp/bench-results/reports/tau2-attribution-<runId>.md).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { reportTau2Comparison, type Tau2ResultsFile } from './tau2-results-report';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--') && a !== process.argv[1]);
const vanPath = positional[0];
const memPath = positional[1];
if (!vanPath || !memPath) {
  console.error('usage: tau2-results-cli <vanilla/results.json> <memory/results.json> [--run-id <id>] [--out <file.md>]');
  process.exit(1);
}

function load(p: string): Tau2ResultsFile {
  return JSON.parse(readFileSync(p, 'utf8')) as Tau2ResultsFile;
}

const runId = arg('run-id') ?? `tau2-cmp-${dirname(vanPath).split('/').pop() ?? 'run'}`;
const rep = reportTau2Comparison({ vanilla: load(vanPath), memory: load(memPath), runId, modelId: arg('model') });

console.log(rep.markdown);

const outPath = arg('out') ?? join(homedir(), '.papercusp', 'bench-results', 'reports', `tau2-attribution-${runId}.md`);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, rep.markdown, 'utf8');
console.error(`\nwrote ${outPath}`);
process.exit(0);
