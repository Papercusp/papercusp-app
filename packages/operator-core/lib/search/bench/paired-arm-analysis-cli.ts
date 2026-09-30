/**
 * paired-arm-analysis-cli.ts — pair two labelled-relevance arms and report the
 * adoption verdict for one stratum.
 *
 *   npx tsx .../paired-arm-analysis-cli.ts --rerank A.json --control B.json
 *
 * WHY IT EXISTS
 * D-081's paired comparison was assembled by hand across two run files whose
 * census had drifted, which is both error-prone and unreproducible. This does
 * the join once, in code, with the pairing rule stated: pair on (tool, query),
 * drop a query degraded or excluded in EITHER arm, and report the dropped count
 * rather than silently shrinking n.
 *
 * WHAT IT DELIBERATELY DOES NOT REPORT
 * nDCG. Four independent runs have now shown it saturated on this corpus
 * (D-088: nDCG@10 0.954 with ndcgUninformative=4) — a query whose returned hits
 * the judge graded uniformly relevant scores ~1.0 however the engine ordered
 * them, so it cannot separate the arms. P@10 and the pollution rate are the
 * verdict fields; `ndcgUninformative` is surfaced only as a health signal.
 *
 * LATENCY: the first query of a run is reported SEPARATELY, never pooled. The
 * cross-encoder is cold on first use and pays a ~150MB model load
 * (EI-19380773834961669), so query #1 measures model-load + rerank. Pooling it
 * inflates the cost side of the trade-off — the exact number an adoption
 * decision turns on.
 */
import fs from 'node:fs';

interface Hit {
  grade: number;
}
interface Outcome {
  tool: string;
  query: string;
  hits: Hit[];
  precisionAtK: number | null;
  ndcgUninformative?: number;
  degraded: boolean;
  rerankApplied: boolean;
  latencyMs?: number;
  excludedReason: string | null;
}
interface Report {
  outcomes: Outcome[];
  judgeCostUsd?: number;
  judgeModel?: string;
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function read(path: string): Report {
  return JSON.parse(fs.readFileSync(path, 'utf8')) as Report;
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Pollution = fraction of judged hits the judge graded 0 (D-080's definition). */
function pollution(outcomes: readonly Outcome[]): number {
  const grades = outcomes.flatMap((o) => o.hits.map((h) => h.grade));
  return grades.length === 0 ? Number.NaN : grades.filter((g) => g === 0).length / grades.length;
}

function logChoose(n: number, k: number): number {
  let r = 0;
  for (let i = 1; i <= k; i += 1) r += Math.log(n - k + i) - Math.log(i);
  return r;
}

/**
 * Exact two-sided sign test over the DISCORDANT pairs only (ties carry no
 * directional information and are excluded from the test, though they are
 * reported). Computed in log space so a few hundred pairs cannot overflow.
 */
function signTestTwoSided(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return Number.NaN;
  const extreme = Math.max(wins, losses);
  let tail = 0;
  for (let i = extreme; i <= n; i += 1) tail += Math.exp(logChoose(n, i) + n * Math.log(0.5));
  return Math.min(1, 2 * tail);
}

function usable(o: Outcome): boolean {
  return !o.degraded && o.excludedReason === null && o.precisionAtK !== null;
}

function main(): void {
  const rerankPath = argValue('--rerank');
  const controlPath = argValue('--control');
  if (!rerankPath || !controlPath) {
    throw new Error('usage: --rerank <A.json> --control <B.json> [--label <name>]');
  }
  const label = argValue('--label') ?? '';

  const A = read(rerankPath);
  const B = read(controlPath);

  const key = (o: Outcome): string => `${o.tool}\x00${o.query}`;
  const bByKey = new Map(B.outcomes.map((o) => [key(o), o]));

  const paired: Array<{ a: Outcome; b: Outcome }> = [];
  let droppedUnmatched = 0;
  let droppedDegraded = 0;
  for (const a of A.outcomes) {
    const b = bByKey.get(key(a));
    if (!b) {
      droppedUnmatched += 1;
      continue;
    }
    if (!usable(a) || !usable(b)) {
      droppedDegraded += 1;
      continue;
    }
    paired.push({ a, b });
  }

  // An arm that never actually reranked cannot be compared with a control —
  // this is D-081's pool=100 void (orderMoved 0/238), and it must be LOUD.
  const rerankEngaged = A.outcomes.filter((o) => o.rerankApplied).length;
  const controlEngaged = B.outcomes.filter((o) => o.rerankApplied).length;

  const pA = paired.map(({ a }) => a.precisionAtK as number);
  const pB = paired.map(({ b }) => b.precisionAtK as number);
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (let i = 0; i < paired.length; i += 1) {
    if (pA[i]! > pB[i]!) wins += 1;
    else if (pA[i]! < pB[i]!) losses += 1;
    else ties += 1;
  }

  // Latency: query #1 of each arm is cold-model-load contaminated.
  const latA = paired.map(({ a }) => a.latencyMs).filter((x): x is number => typeof x === 'number');
  const latB = paired.map(({ b }) => b.latencyMs).filter((x): x is number => typeof x === 'number');
  const warmA = latA.slice(1);
  const warmB = latB.slice(1);

  const byTool = new Map<string, Array<{ a: Outcome; b: Outcome }>>();
  for (const p of paired) {
    const arr = byTool.get(p.a.tool) ?? [];
    arr.push(p);
    byTool.set(p.a.tool, arr);
  }

  const lines: string[] = [];
  lines.push(`=== PAIRED ARM ANALYSIS ${label}`.trim());
  lines.push(`rerank arm : ${rerankPath}`);
  lines.push(`control arm: ${controlPath}`);
  lines.push('');
  lines.push(
    `INSTRUMENT: rerank arm engaged ${rerankEngaged}/${A.outcomes.length}; ` +
      `control arm engaged ${controlEngaged}/${B.outcomes.length} (control SHOULD be 0)`,
  );
  if (rerankEngaged === 0) {
    lines.push('⛔ VOID: the rerank arm never reranked. Any delta below is noise, not an effect (D-081 pool=100 shape).');
  }
  if (controlEngaged > 0) {
    lines.push('⛔ VOID: the CONTROL arm reranked. The arms do not differ in exactly one stage.');
  }
  lines.push(
    `pairing: ${paired.length} usable pairs ` +
      `(dropped ${droppedUnmatched} unmatched, ${droppedDegraded} degraded/excluded in either arm)`,
  );
  lines.push('');

  const row = (name: string, ps: Array<{ a: Outcome; b: Outcome }>): string => {
    const a = ps.map((p) => p.a.precisionAtK as number);
    const b = ps.map((p) => p.b.precisionAtK as number);
    let w = 0;
    let l = 0;
    for (let i = 0; i < ps.length; i += 1) {
      if (a[i]! > b[i]!) w += 1;
      else if (a[i]! < b[i]!) l += 1;
    }
    const polA = pollution(ps.map((p) => p.a));
    const polB = pollution(ps.map((p) => p.b));
    const cut = polB > 0 ? ((polB - polA) / polB) * 100 : Number.NaN;
    return (
      `${name.padEnd(20)} n=${String(ps.length).padStart(3)}  ` +
      `P@10 ${mean(a).toFixed(3)} vs ${mean(b).toFixed(3)}  Δ${(mean(a) - mean(b) >= 0 ? '+' : '')}${(mean(a) - mean(b)).toFixed(3)}  ` +
      `pollution ${polA.toFixed(3)} vs ${polB.toFixed(3)} (${cut >= 0 ? '-' : '+'}${Math.abs(cut).toFixed(0)}%)  ` +
      `${w}W/${l}L/${ps.length - w - l}T`
    );
  };

  for (const [tool, ps] of [...byTool.entries()].sort()) lines.push(row(tool, ps));
  lines.push(row('ALL PAIRED', paired));
  lines.push('');
  lines.push(
    `sign test (two-sided, ${wins + losses} discordant of ${paired.length}): ` +
      `p = ${signTestTwoSided(wins, losses).toFixed(6)}   [${wins}W / ${losses}L / ${ties}T]`,
  );
  lines.push(
    `latency: all ${mean(latA).toFixed(0)}ms vs ${mean(latB).toFixed(0)}ms  |  ` +
      `WARM (query #1 dropped, cold model load) ${mean(warmA).toFixed(0)}ms vs ${mean(warmB).toFixed(0)}ms  ` +
      `Δ+${(mean(warmA) - mean(warmB)).toFixed(0)}ms`,
  );
  lines.push(
    `nDCG deliberately not reported as a verdict (saturated on this corpus — D-088). ` +
      `judge spend: rerank $${(A.judgeCostUsd ?? 0).toFixed(3)}, control $${(B.judgeCostUsd ?? 0).toFixed(3)}`,
  );
  if (paired.length < 20) {
    lines.push(
      `⚠ UNDERPOWERED: ${paired.length} pairs. Report as directional only; a stratum this small ` +
        `cannot settle adoption (this is exactly D-081's docs n=11 caveat).`,
    );
  }
  console.log(lines.join('\n'));
}

main();
