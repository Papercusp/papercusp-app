/**
 * Save-time substance check measurement (plan jev-performance-improvements-2026-09-30,
 * P-010). Pure helpers for jev-substance-cli.ts: deterministic sampling, the
 * selection/confirmation split, threshold choice and the report.
 *
 * The question under test is the one memory:remember asks (jev-conflict-judge.ts
 * buildConflictRequest with `substance`): does the new memory carry concrete
 * information? A memory is refused when P(concrete) < t. Two populations:
 *
 *   - self-promoters: the 156 bench memories that only claim their own relevance
 *     (jev-robustness.ts buildAdversarialCorpus) — the catch rate.
 *   - real memories: a deterministic sample of the live store — the refusal rate,
 *     which must stay at or under 1% (plan R-3).
 *
 * t is chosen on the SELECTION half of the real sample (at most half the budget,
 * so a lucky half cannot carry it) and the refusal rate is then CONFIRMED on the
 * other half, which played no part in choosing it.
 */
import { createHash } from 'node:crypto';

export const SUBSTANCE_THRESHOLDS = [0.02, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5] as const;

/** R-3: at most 1% of real memories refused. */
export const MAX_REAL_REFUSAL_RATE = 0.01;

/** The selection half must stay within half the budget, so the confirmation half has room. */
export const SELECTION_REFUSAL_RATE = MAX_REAL_REFUSAL_RATE / 2;

export interface SubstanceRow {
  readonly id: string;
  readonly population: 'self-promoter' | 'real';
  readonly pool: string | null;
  readonly text: string;
  /** P(concrete), or null when the call failed (the write would fail open). */
  readonly pConcrete: number | null;
  readonly latencyMs: number | null;
  readonly failure: string | null;
}

/** Deterministic order by a seeded hash of the id: the same seed draws the same sample. */
export function seededSample<T extends { readonly id: string }>(rows: readonly T[], n: number, seed: string): T[] {
  const key = (id: string) => createHash('sha256').update(`${seed}\u0000${id}`).digest('hex');
  return [...rows]
    .map((r) => ({ r, k: key(r.id) }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
    .slice(0, n)
    .map(({ r }) => r);
}

/** Even positions select, odd positions confirm. */
export function splitHalves<T>(rows: readonly T[]): { readonly selection: T[]; readonly confirmation: T[] } {
  return {
    selection: rows.filter((_, i) => i % 2 === 0),
    confirmation: rows.filter((_, i) => i % 2 === 1),
  };
}

/** How many answered rows would be refused at t (failed calls are never refused: fail open). */
export function refusedAt(rows: readonly SubstanceRow[], t: number): SubstanceRow[] {
  return rows.filter((r) => r.pConcrete !== null && r.pConcrete < t);
}

export interface RateCI {
  readonly k: number;
  readonly n: number;
  readonly rate: number;
  readonly lo: number;
  readonly hi: number;
}

/** Wilson 95% interval; n counts answered rows only. */
export function wilson(k: number, n: number): RateCI {
  if (n === 0) return { k, n, rate: 0, lo: 0, hi: 1 };
  const z = 1.959964;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { k, n, rate: p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

function answered(rows: readonly SubstanceRow[]): number {
  return rows.filter((r) => r.pConcrete !== null).length;
}

export function rateAt(rows: readonly SubstanceRow[], t: number): RateCI {
  return wilson(refusedAt(rows, t).length, answered(rows));
}

/**
 * The largest threshold whose refusal rate on the selection half stays within
 * `maxRate`; null when even the smallest threshold refuses too much. Larger t
 * catches more self-promoters, so the largest safe t is the one to take.
 */
export function selectThreshold(
  selection: readonly SubstanceRow[],
  thresholds: readonly number[] = SUBSTANCE_THRESHOLDS,
  maxRate: number = SELECTION_REFUSAL_RATE,
): number | null {
  let best: number | null = null;
  for (const t of [...thresholds].sort((a, b) => a - b)) {
    if (rateAt(selection, t).rate <= maxRate) best = t;
  }
  return best;
}

export interface PairedShift {
  readonly n: number;
  readonly meanAbsDelta: number;
  readonly maxAbsDelta: number;
  /** Rows whose refuse/keep decision at t differs between the two request shapes. */
  readonly flips: number;
}

/** Substance-only vs substance asked alongside conflict questions, as memory:remember sends it. */
export function pairedShift(
  pairs: readonly { readonly alone: number | null; readonly withNeighbours: number | null }[],
  t: number,
): PairedShift {
  const usable = pairs.filter((p): p is { alone: number; withNeighbours: number } => p.alone !== null && p.withNeighbours !== null);
  const deltas = usable.map((p) => Math.abs(p.alone - p.withNeighbours));
  return {
    n: usable.length,
    meanAbsDelta: deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0,
    maxAbsDelta: deltas.length ? Math.max(...deltas) : 0,
    flips: usable.filter((p) => p.alone < t !== p.withNeighbours < t).length,
  };
}

export interface SubstanceVerdict {
  readonly threshold: number | null;
  readonly pass: boolean;
  readonly reasons: readonly string[];
}

/** R-3 on the confirmation half and on the whole sample; a catch rate is reported, not gated. */
export function substanceVerdict(input: {
  readonly threshold: number | null;
  readonly confirmation: RateCI;
  readonly whole: RateCI;
  readonly sampleSize: number;
  readonly minSample: number;
}): SubstanceVerdict {
  const reasons: string[] = [];
  if (input.threshold === null) reasons.push('no threshold keeps the selection half within the refusal budget');
  if (input.sampleSize < input.minSample) reasons.push(`real sample ${input.sampleSize} < ${input.minSample}`);
  if (input.confirmation.rate > MAX_REAL_REFUSAL_RATE) {
    reasons.push(`confirmation half refuses ${(input.confirmation.rate * 100).toFixed(2)}% > 1%`);
  }
  if (input.whole.rate > MAX_REAL_REFUSAL_RATE) reasons.push(`whole sample refuses ${(input.whole.rate * 100).toFixed(2)}% > 1%`);
  return { threshold: input.threshold, pass: reasons.length === 0, reasons };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const ci = (r: RateCI) => `${r.k}/${r.n} = ${pct(r.rate)} [${pct(r.lo)}, ${pct(r.hi)}]`;

export interface SubstanceReport {
  readonly generatedAt: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly rows: readonly SubstanceRow[];
  readonly selectionIds: readonly string[];
  readonly confirmationIds: readonly string[];
  readonly threshold: number | null;
  readonly verdict: SubstanceVerdict;
  readonly paired: PairedShift | null;
  readonly latency: { readonly p50: number | null; readonly p95: number | null; readonly failures: number };
}

export function percentile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

export function renderSubstanceMarkdown(report: SubstanceReport): string {
  const promoters = report.rows.filter((r) => r.population === 'self-promoter');
  const real = report.rows.filter((r) => r.population === 'real');
  const sel = new Set(report.selectionIds);
  const conf = new Set(report.confirmationIds);
  const selection = real.filter((r) => sel.has(r.id));
  const confirmation = real.filter((r) => conf.has(r.id));
  const lines: string[] = [];
  lines.push(`# Jev save-time substance check — ${report.generatedAt}`, '');
  lines.push('Plan `jev-performance-improvements-2026-09-30` P-010; bar R-3 (at most 1% of real memories refused).', '');
  lines.push('## Parameters', '');
  for (const [k, v] of Object.entries(report.params)) lines.push(`- **${k}:** ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  lines.push('');
  lines.push(`## Verdict: ${report.verdict.pass ? 'PASS' : 'FAIL'} (threshold ${report.threshold ?? 'none'})`, '');
  for (const r of report.verdict.reasons) lines.push(`- ${r}`);
  if (report.threshold !== null) {
    const t = report.threshold;
    lines.push(`- self-promoters caught: ${ci(rateAt(promoters, t))}`);
    lines.push(`- real memories refused, selection half: ${ci(rateAt(selection, t))}`);
    lines.push(`- real memories refused, confirmation half: ${ci(rateAt(confirmation, t))}`);
    lines.push(`- real memories refused, whole sample: ${ci(rateAt(real, t))}`);
  }
  lines.push('');
  lines.push('## Every threshold', '');
  lines.push('| t | self-promoters caught | real refused (selection) | real refused (confirmation) | real refused (whole) |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const t of SUBSTANCE_THRESHOLDS) {
    lines.push(
      `| ${t}${t === report.threshold ? ' ⭐' : ''} | ${ci(rateAt(promoters, t))} | ${ci(rateAt(selection, t))} | ${ci(rateAt(confirmation, t))} | ${ci(rateAt(real, t))} |`,
    );
  }
  lines.push('');
  lines.push('## Operational', '');
  lines.push(
    `Latency p50 ${report.latency.p50 ?? 'n/a'} ms, p95 ${report.latency.p95 ?? 'n/a'} ms; failed calls ${report.latency.failures} (a failed call fails open: the write proceeds).`,
  );
  if (report.paired) {
    lines.push(
      `Asked alongside three conflict questions (the memory:remember request shape): n=${report.paired.n}, mean |ΔP| ${report.paired.meanAbsDelta.toFixed(3)}, max |ΔP| ${report.paired.maxAbsDelta.toFixed(3)}, decision flips at t ${report.paired.flips}.`,
    );
  }
  lines.push('');
  if (report.threshold !== null) {
    const refusedReal = refusedAt(real, report.threshold);
    lines.push(`## Real memories refused at t=${report.threshold} (${refusedReal.length})`, '');
    if (refusedReal.length === 0) lines.push('None.');
    for (const r of refusedReal) {
      const text = r.text.replace(/\s+/g, ' ').slice(0, 400);
      lines.push(`- \`${r.id}\` (${r.pool ?? 'no pool'}, P=${r.pConcrete?.toFixed(3)}): ${text}`);
    }
    lines.push('');
    const missed = promoters.filter((r) => r.pConcrete !== null && r.pConcrete >= report.threshold!);
    lines.push(`## Self-promoters NOT caught at t=${report.threshold} (${missed.length})`, '');
    for (const r of missed.slice(0, 40)) lines.push(`- P=${r.pConcrete?.toFixed(3)}: ${r.text.slice(0, 200)}`);
    if (missed.length > 40) lines.push(`- … ${missed.length - 40} more in the JSON report`);
    lines.push('');
  }
  lines.push('## Caveats', '');
  lines.push(
    '- The 156 self-promoters come from two templates (six generic, one topical per gold question), so the catch rate describes those shapes; a self-promoter worded differently may score otherwise.',
  );
  lines.push(
    '- A refused real memory is counted against the budget even if a reader would agree it is content-free; every one is listed above for review.',
  );
  return lines.join('\n');
}
