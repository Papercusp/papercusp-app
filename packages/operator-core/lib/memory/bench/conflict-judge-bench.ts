/**
 * Scoring for the P-009 conflict-judge validation (plan
 * jev-decision-model-integration-2026-09-29, bar in decision D-015).
 *
 * Pure: the CLI (conflict-judge-bench-cli.ts) collects verdicts from live Jev
 * calls, and everything here turns them into the recorded numbers.
 *
 * Two families of metrics:
 *   - the FLAG, which is what production acts on (a conflict refuses the write):
 *     isConflictVerdict() on the first forward run. An unjudged pair (its call was
 *     inconclusive) counts as NOT flagged, because production fails open.
 *   - per-label precision and recall on the argmax label, which P-009 asks to
 *     record. Unjudged pairs are excluded there, since they have no label.
 */
import { isConflictVerdict, JEV_CONFLICT_LABELS, type ConflictVerdict, type JevConflictLabel } from '../jev-conflict-judge';

export interface ConflictPairResult {
  readonly caseId: string;
  readonly neighbourId: string;
  readonly gold: JevConflictLabel;
  /** First run, retrieval order. The primary verdict. */
  readonly forward: ConflictVerdict | null;
  /** Second run, retrieval order (determinism). */
  readonly repeat: ConflictVerdict | null;
  /** Third run, neighbour order reversed (order robustness). */
  readonly reversed: ConflictVerdict | null;
}

export interface ConflictBenchCalls {
  readonly calls: number;
  readonly inconclusive: number;
  readonly inconclusiveReasons: Readonly<Record<string, number>>;
  readonly models: readonly string[];
}

/** Decision D-015. Changing a number here changes the bar the run was held to. */
export const D015_BAR = {
  minFlagPrecision: 0.9,
  minFlagRecall: 0.6,
  maxOrderFlagFlipRate: 0.05,
  maxInconclusiveRate: 0.05,
} as const;

export interface Ratio {
  readonly num: number;
  readonly den: number;
  /** null when the denominator is 0: undefined, never 0 or 1. */
  readonly value: number | null;
  /** 95% Wilson interval, null when undefined. */
  readonly ci95: readonly [number, number] | null;
}

export function ratio(num: number, den: number): Ratio {
  if (den === 0) return { num, den, value: null, ci95: null };
  const p = num / den;
  const z = 1.96;
  const denom = 1 + (z * z) / den;
  const centre = (p + (z * z) / (2 * den)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / den + (z * z) / (4 * den * den))) / denom;
  return { num, den, value: p, ci95: [Math.max(0, centre - half), Math.min(1, centre + half)] };
}

export interface LabelScore {
  readonly label: JevConflictLabel;
  readonly support: number;
  readonly precision: Ratio;
  readonly recall: Ratio;
}

export interface ConflictBenchMetrics {
  readonly pairs: number;
  readonly unjudgedPairs: number;
  readonly flag: { readonly tp: number; readonly fp: number; readonly fn: number; readonly tn: number; readonly precision: Ratio; readonly recall: Ratio };
  readonly perLabel: readonly LabelScore[];
  /** confusion[gold][predicted], judged forward pairs only. */
  readonly confusion: Readonly<Record<JevConflictLabel, Readonly<Record<JevConflictLabel, number>>>>;
  readonly repeat: { readonly flagFlips: Ratio; readonly labelFlips: Ratio };
  readonly order: { readonly flagFlips: Ratio; readonly labelFlips: Ratio };
  readonly inconclusiveRate: Ratio;
}

const flagged = (v: ConflictVerdict | null): boolean => v !== null && isConflictVerdict(v);

function flips(pairs: readonly ConflictPairResult[], other: (p: ConflictPairResult) => ConflictVerdict | null) {
  let both = 0;
  let flag = 0;
  let label = 0;
  for (const p of pairs) {
    const b = other(p);
    if (!p.forward || !b) continue;
    both += 1;
    if (flagged(p.forward) !== flagged(b)) flag += 1;
    if (p.forward.label !== b.label) label += 1;
  }
  return { flagFlips: ratio(flag, both), labelFlips: ratio(label, both) };
}

export function scoreConflictBench(pairs: readonly ConflictPairResult[], calls: ConflictBenchCalls): ConflictBenchMetrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const p of pairs) {
    const isGold = p.gold === 'contradicts';
    const isFlag = flagged(p.forward);
    if (isGold && isFlag) tp += 1;
    else if (!isGold && isFlag) fp += 1;
    else if (isGold && !isFlag) fn += 1;
    else tn += 1;
  }

  const confusion = Object.fromEntries(
    JEV_CONFLICT_LABELS.map((g) => [g, Object.fromEntries(JEV_CONFLICT_LABELS.map((pr) => [pr, 0]))]),
  ) as Record<JevConflictLabel, Record<JevConflictLabel, number>>;
  const judged = pairs.filter((p) => p.forward !== null);
  for (const p of judged) confusion[p.gold][(p.forward as ConflictVerdict).label] += 1;

  const perLabel: LabelScore[] = JEV_CONFLICT_LABELS.map((label) => {
    const support = judged.filter((p) => p.gold === label).length;
    const predicted = judged.filter((p) => (p.forward as ConflictVerdict).label === label).length;
    const hits = confusion[label][label];
    return { label, support, precision: ratio(hits, predicted), recall: ratio(hits, support) };
  });

  return {
    pairs: pairs.length,
    unjudgedPairs: pairs.length - judged.length,
    flag: { tp, fp, fn, tn, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn) },
    perLabel,
    confusion,
    repeat: flips(pairs, (p) => p.repeat),
    order: flips(pairs, (p) => p.reversed),
    inconclusiveRate: ratio(calls.inconclusive, calls.calls),
  };
}

export interface BarCriterion {
  readonly name: string;
  readonly value: number | null;
  readonly bar: string;
  readonly pass: boolean;
}

/** Holds the metrics to D-015. An undefined value (empty denominator) fails its criterion. */
export function evaluateD015(m: ConflictBenchMetrics): { readonly pass: boolean; readonly criteria: readonly BarCriterion[] } {
  const atLeast = (v: number | null, min: number) => v !== null && v >= min;
  const atMost = (v: number | null, max: number) => v !== null && v <= max;
  const criteria: BarCriterion[] = [
    { name: 'contradicts-flag precision', value: m.flag.precision.value, bar: `>= ${D015_BAR.minFlagPrecision}`, pass: atLeast(m.flag.precision.value, D015_BAR.minFlagPrecision) },
    { name: 'contradicts-flag recall', value: m.flag.recall.value, bar: `>= ${D015_BAR.minFlagRecall}`, pass: atLeast(m.flag.recall.value, D015_BAR.minFlagRecall) },
    { name: 'flag flips under neighbour-order reversal', value: m.order.flagFlips.value, bar: `<= ${D015_BAR.maxOrderFlagFlipRate}`, pass: atMost(m.order.flagFlips.value, D015_BAR.maxOrderFlagFlipRate) },
    { name: 'inconclusive calls', value: m.inconclusiveRate.value, bar: `<= ${D015_BAR.maxInconclusiveRate}`, pass: atMost(m.inconclusiveRate.value, D015_BAR.maxInconclusiveRate) },
  ];
  return { pass: criteria.every((c) => c.pass), criteria };
}

const pct = (r: Ratio): string =>
  r.value === null ? 'n/a' : `${(r.value * 100).toFixed(1)}% (${r.num}/${r.den}; 95% CI ${(r.ci95![0] * 100).toFixed(1)}–${(r.ci95![1] * 100).toFixed(1)}%)`;

export function renderConflictBenchReport(input: {
  readonly generatedAt: string;
  /** The judge wording measured (plan jev-performance-improvements-2026-09-30, D-007); omitted on older runs. */
  readonly wording?: string;
  readonly calls: ConflictBenchCalls;
  readonly metrics: ConflictBenchMetrics;
  readonly verdict: ReturnType<typeof evaluateD015>;
  readonly pairs: readonly ConflictPairResult[];
}): string {
  const { metrics: m, verdict, calls } = input;
  const lines: string[] = [];
  lines.push(`# Jev memory conflict judge — P-009 validation (${input.generatedAt})`, '');
  if (input.wording) lines.push(`Wording: ${input.wording}.`, '');
  lines.push(`Model(s) answering: ${calls.models.join(', ') || 'none'}. Calls: ${calls.calls}, inconclusive ${calls.inconclusive}${calls.inconclusive ? ` (${Object.entries(calls.inconclusiveReasons).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}.`);
  lines.push(`Pairs: ${m.pairs} (unjudged on the primary run: ${m.unjudgedPairs}). Rule: flag when P(contradicts) >= 0.5 (D-015).`, '');
  lines.push(`## D-015 verdict: ${verdict.pass ? 'MEETS the bar' : 'does NOT meet the bar'}`, '');
  lines.push('| criterion | value | bar | result |', '|---|---|---|---|');
  for (const c of verdict.criteria) lines.push(`| ${c.name} | ${c.value === null ? 'n/a' : c.value.toFixed(3)} | ${c.bar} | ${c.pass ? 'pass' : 'FAIL'} |`);
  lines.push('', '## The flag (what refuses a write)', '');
  lines.push(`TP ${m.flag.tp} · FP ${m.flag.fp} · FN ${m.flag.fn} · TN ${m.flag.tn}`);
  lines.push(`Precision ${pct(m.flag.precision)}; recall ${pct(m.flag.recall)}.`, '');
  lines.push('## Per-label precision and recall (argmax label, primary run)', '');
  lines.push('| label | support | precision | recall |', '|---|---|---|---|');
  for (const s of m.perLabel) lines.push(`| ${s.label} | ${s.support} | ${pct(s.precision)} | ${pct(s.recall)} |`);
  lines.push('', '## Confusion (rows gold, columns predicted)', '');
  lines.push(`| gold \\ predicted | ${JEV_CONFLICT_LABELS.join(' | ')} |`, `|---|${JEV_CONFLICT_LABELS.map(() => '---').join('|')}|`);
  for (const g of JEV_CONFLICT_LABELS) lines.push(`| ${g} | ${JEV_CONFLICT_LABELS.map((pr) => m.confusion[g][pr]).join(' | ')} |`);
  lines.push('', '## Stability', '');
  lines.push(`Repeat run (same order): flag flips ${pct(m.repeat.flagFlips)}; label flips ${pct(m.repeat.labelFlips)}.`);
  lines.push(`Reversed neighbour order: flag flips ${pct(m.order.flagFlips)}; label flips ${pct(m.order.labelFlips)}.`, '');
  const wrong = input.pairs.filter((p) => (p.gold === 'contradicts') !== flagged(p.forward));
  lines.push('## Flag errors (primary run)', '');
  if (wrong.length === 0) lines.push('None.');
  for (const p of wrong) {
    const v = p.forward;
    lines.push(`- ${p.neighbourId} gold=${p.gold} → ${v ? `${v.label} P(contradicts)=${v.pContradicts.toFixed(2)}` : 'unjudged'}`);
  }
  lines.push('', 'Limitation: the sample was labelled by the implementer, before any judge saw it (D-015).');
  return lines.join('\n');
}
