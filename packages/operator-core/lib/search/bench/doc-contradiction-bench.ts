/**
 * Scoring for the doc-contradiction judge comparison (plan
 * jev-decision-model-integration-2026-09-29, P-010, decision D-017).
 *
 * Pure: the CLI (doc-contradiction-bench-cli.ts) makes the calls and hands this
 * module one row per labelled pair. Jev is asked three times per pair (forward,
 * a repeat, and with A and B swapped); the incumbent Anthropic judge twice
 * (forward and swapped).
 *
 * A null verdict is a judge that did not answer. It is scored as "not flagged" for
 * precision and recall (the scan cannot file what the judge never said), and it is
 * also counted, so a judge cannot pass the bar by staying silent: Jev's
 * inconclusive rate is a gating criterion, and the incumbent's error count is in
 * the report.
 */
import { ratio, type Ratio } from '../../memory/bench/conflict-judge-bench';
import {
  isContradictionJudgement,
  JEV_CONTRADICTION_LABELS,
  type ContradictionJudgement,
  type JevContradictionLabel,
} from '../jev-contradiction-judge';
import type { DocPairNote } from './doc-contradiction-sample';

export interface DocContradictionPairResult {
  readonly id: string;
  readonly gold: JevContradictionLabel;
  readonly note: DocPairNote;
  readonly jevForward: ContradictionJudgement | null;
  readonly jevRepeat: ContradictionJudgement | null;
  readonly jevSwapped: ContradictionJudgement | null;
  /** The incumbent's `contradicts`, or null when it errored. */
  readonly incumbentForward: boolean | null;
  readonly incumbentSwapped: boolean | null;
}

export interface DocContradictionCalls {
  readonly jevCalls: number;
  readonly jevInconclusive: number;
  readonly jevInconclusiveReasons: Readonly<Record<string, number>>;
  readonly jevModels: readonly string[];
  readonly incumbentCalls: number;
  readonly incumbentErrors: number;
  readonly incumbentModel: string;
}

/** The D-017 adoption bar. Fixed before measuring; do not tune it on the sample. */
export const D017_BAR = {
  minFlagPrecision: 0.9,
  minFlagRecall: 0.6,
  /** Jev F1 may trail the incumbent's F1 by at most this much. */
  maxF1Deficit: 0.05,
  maxSwapFlagFlipRate: 0.05,
  maxInconclusiveRate: 0.05,
} as const;

export interface FlagScore {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly tn: number;
  readonly precision: Ratio;
  readonly recall: Ratio;
  readonly f1: number | null;
}

export function flagScore(pairs: readonly { gold: JevContradictionLabel; flagged: boolean }[]): FlagScore {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const p of pairs) {
    const isGold = p.gold === 'opposite-instructions';
    if (isGold && p.flagged) tp += 1;
    else if (!isGold && p.flagged) fp += 1;
    else if (isGold) fn += 1;
    else tn += 1;
  }
  const f1Den = 2 * tp + fp + fn;
  return {
    tp,
    fp,
    fn,
    tn,
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
    f1: f1Den === 0 ? null : (2 * tp) / f1Den,
  };
}

/**
 * Cohen's kappa for two binary raters over the pairs both answered. `null` when no
 * pair was answered by both, or when chance agreement is total (kappa undefined).
 */
export function binaryKappa(rows: readonly (readonly [boolean, boolean])[]): { readonly kappa: number | null; readonly n: number } {
  const n = rows.length;
  if (n === 0) return { kappa: null, n };
  let agree = 0;
  let x1 = 0;
  let y1 = 0;
  for (const [x, y] of rows) {
    if (x === y) agree += 1;
    if (x) x1 += 1;
    if (y) y1 += 1;
  }
  const po = agree / n;
  const pe = (x1 / n) * (y1 / n) + (1 - x1 / n) * (1 - y1 / n);
  if (pe === 1) return { kappa: null, n };
  return { kappa: (po - pe) / (1 - pe), n };
}

const jevFlag = (j: ContradictionJudgement | null): boolean => j !== null && isContradictionJudgement(j);

function flips<T>(rows: readonly (readonly [T | null, T | null])[], same: (x: T, y: T) => boolean): Ratio {
  let both = 0;
  let flipped = 0;
  for (const [x, y] of rows) {
    if (x === null || y === null) continue;
    both += 1;
    if (!same(x, y)) flipped += 1;
  }
  return ratio(flipped, both);
}

export interface DocContradictionMetrics {
  readonly pairs: number;
  readonly jev: {
    readonly flag: FlagScore;
    readonly unanswered: number;
    readonly perLabel: readonly { readonly label: JevContradictionLabel; readonly support: number; readonly precision: Ratio; readonly recall: Ratio }[];
    readonly confusion: Readonly<Record<JevContradictionLabel, Readonly<Record<JevContradictionLabel, number>>>>;
    readonly swapFlagFlips: Ratio;
    readonly swapLabelFlips: Ratio;
    readonly repeatFlagFlips: Ratio;
    readonly repeatLabelFlips: Ratio;
    readonly inconclusiveRate: Ratio;
  };
  readonly incumbent: {
    readonly flag: FlagScore;
    readonly unanswered: number;
    readonly swapFlagFlips: Ratio;
    readonly errorRate: Ratio;
  };
  /** Jev flag vs incumbent flag on the forward pairs both answered. */
  readonly agreement: { readonly kappa: number | null; readonly n: number; readonly raw: Ratio };
  /** Per gold note: how many pairs each judge flagged. */
  readonly byNote: readonly { readonly note: DocPairNote; readonly gold: JevContradictionLabel; readonly pairs: number; readonly jevFlagged: number; readonly incumbentFlagged: number }[];
}

export function scoreDocContradictionBench(
  pairs: readonly DocContradictionPairResult[],
  calls: DocContradictionCalls,
): DocContradictionMetrics {
  const jevAnswered = pairs.filter((p) => p.jevForward !== null);
  const confusion = Object.fromEntries(
    JEV_CONTRADICTION_LABELS.map((g) => [g, Object.fromEntries(JEV_CONTRADICTION_LABELS.map((pr) => [pr, 0]))]),
  ) as Record<JevContradictionLabel, Record<JevContradictionLabel, number>>;
  for (const p of jevAnswered) confusion[p.gold][(p.jevForward as ContradictionJudgement).label] += 1;
  const perLabel = JEV_CONTRADICTION_LABELS.map((label) => {
    const support = jevAnswered.filter((p) => p.gold === label).length;
    const predicted = jevAnswered.filter((p) => (p.jevForward as ContradictionJudgement).label === label).length;
    const hits = confusion[label][label];
    return { label, support, precision: ratio(hits, predicted), recall: ratio(hits, support) };
  });

  const bothAnswered = pairs.filter((p) => p.jevForward !== null && p.incumbentForward !== null);
  const kappaRows = bothAnswered.map((p) => [jevFlag(p.jevForward), p.incumbentForward as boolean] as const);
  const agreeCount = kappaRows.filter(([x, y]) => x === y).length;

  const notes = [...new Set(pairs.map((p) => `${p.gold}|${p.note}`))];
  const byNote = notes.map((key) => {
    const [gold, note] = key.split('|') as [JevContradictionLabel, DocPairNote];
    const rows = pairs.filter((p) => p.gold === gold && p.note === note);
    return {
      note,
      gold,
      pairs: rows.length,
      jevFlagged: rows.filter((p) => jevFlag(p.jevForward)).length,
      incumbentFlagged: rows.filter((p) => p.incumbentForward === true).length,
    };
  });

  const sameLabel = (x: ContradictionJudgement, y: ContradictionJudgement) => x.label === y.label;
  const sameFlag = (x: ContradictionJudgement, y: ContradictionJudgement) => jevFlag(x) === jevFlag(y);

  return {
    pairs: pairs.length,
    jev: {
      flag: flagScore(pairs.map((p) => ({ gold: p.gold, flagged: jevFlag(p.jevForward) }))),
      unanswered: pairs.length - jevAnswered.length,
      perLabel,
      confusion,
      swapFlagFlips: flips(pairs.map((p) => [p.jevForward, p.jevSwapped] as const), sameFlag),
      swapLabelFlips: flips(pairs.map((p) => [p.jevForward, p.jevSwapped] as const), sameLabel),
      repeatFlagFlips: flips(pairs.map((p) => [p.jevForward, p.jevRepeat] as const), sameFlag),
      repeatLabelFlips: flips(pairs.map((p) => [p.jevForward, p.jevRepeat] as const), sameLabel),
      inconclusiveRate: ratio(calls.jevInconclusive, calls.jevCalls),
    },
    incumbent: {
      flag: flagScore(pairs.map((p) => ({ gold: p.gold, flagged: p.incumbentForward === true }))),
      unanswered: pairs.filter((p) => p.incumbentForward === null).length,
      swapFlagFlips: flips(pairs.map((p) => [p.incumbentForward, p.incumbentSwapped] as const), (x, y) => x === y),
      errorRate: ratio(calls.incumbentErrors, calls.incumbentCalls),
    },
    agreement: { ...binaryKappa(kappaRows), raw: ratio(agreeCount, kappaRows.length) },
    byNote,
  };
}

export interface BarCriterion {
  readonly name: string;
  readonly value: number | null;
  readonly bar: string;
  readonly pass: boolean;
}

export function evaluateD017(m: DocContradictionMetrics): { readonly pass: boolean; readonly criteria: readonly BarCriterion[] } {
  const atLeast = (v: number | null, min: number) => v !== null && v >= min;
  const atMost = (v: number | null, max: number) => v !== null && v <= max;
  const incumbentF1 = m.incumbent.flag.f1 ?? 0;
  const f1Floor = incumbentF1 - D017_BAR.maxF1Deficit;
  const criteria: BarCriterion[] = [
    {
      name: 'Jev flag precision',
      value: m.jev.flag.precision.value,
      bar: `>= ${D017_BAR.minFlagPrecision}`,
      pass: atLeast(m.jev.flag.precision.value, D017_BAR.minFlagPrecision),
    },
    {
      name: 'Jev flag recall',
      value: m.jev.flag.recall.value,
      bar: `>= ${D017_BAR.minFlagRecall}`,
      pass: atLeast(m.jev.flag.recall.value, D017_BAR.minFlagRecall),
    },
    {
      name: 'Jev flag F1 vs incumbent F1',
      value: m.jev.flag.f1,
      bar: `>= ${f1Floor.toFixed(3)} (incumbent ${incumbentF1.toFixed(3)} - ${D017_BAR.maxF1Deficit})`,
      pass: atLeast(m.jev.flag.f1, f1Floor),
    },
    {
      name: 'Jev flag flips under A/B swap',
      value: m.jev.swapFlagFlips.value,
      bar: `<= ${D017_BAR.maxSwapFlagFlipRate}`,
      pass: atMost(m.jev.swapFlagFlips.value, D017_BAR.maxSwapFlagFlipRate),
    },
    {
      name: 'Jev inconclusive calls',
      value: m.jev.inconclusiveRate.value,
      bar: `<= ${D017_BAR.maxInconclusiveRate}`,
      pass: atMost(m.jev.inconclusiveRate.value, D017_BAR.maxInconclusiveRate),
    },
  ];
  return { pass: criteria.every((c) => c.pass), criteria };
}

const pct = (r: Ratio): string =>
  r.value === null
    ? 'n/a'
    : `${(r.value * 100).toFixed(1)}% (${r.num}/${r.den}; 95% CI ${(r.ci95![0] * 100).toFixed(1)}–${(r.ci95![1] * 100).toFixed(1)}%)`;
const num = (v: number | null, digits = 3): string => (v === null ? 'n/a' : v.toFixed(digits));

export function renderDocContradictionReport(input: {
  readonly generatedAt: string;
  readonly calls: DocContradictionCalls;
  readonly metrics: DocContradictionMetrics;
  readonly verdict: ReturnType<typeof evaluateD017>;
  readonly pairs: readonly DocContradictionPairResult[];
}): string {
  const { calls, metrics: m, verdict } = input;
  const lines: string[] = [
    `# Jev doc-contradiction judge vs incumbent (D-017) — ${input.generatedAt}`,
    '',
    `Pairs: ${m.pairs}. Jev models: ${calls.jevModels.join(', ') || 'none'}; incumbent: ${calls.incumbentModel}.`,
    `Jev calls ${calls.jevCalls}, inconclusive ${calls.jevInconclusive} ${JSON.stringify(calls.jevInconclusiveReasons)}. Incumbent calls ${calls.incumbentCalls}, errors ${calls.incumbentErrors}.`,
    '',
    `## Verdict: ${verdict.pass ? 'MEETS the D-017 bar' : 'does NOT meet the D-017 bar'}`,
    '',
    '| criterion | value | bar | pass |',
    '|---|---|---|---|',
    ...verdict.criteria.map((c) => `| ${c.name} | ${num(c.value)} | ${c.bar} | ${c.pass ? 'yes' : 'NO'} |`),
    '',
    '## Flag scores (forward order)',
    '',
    '| judge | tp | fp | fn | tn | precision | recall | F1 | unanswered |',
    '|---|---|---|---|---|---|---|---|---|',
    `| Jev | ${m.jev.flag.tp} | ${m.jev.flag.fp} | ${m.jev.flag.fn} | ${m.jev.flag.tn} | ${pct(m.jev.flag.precision)} | ${pct(m.jev.flag.recall)} | ${num(m.jev.flag.f1)} | ${m.jev.unanswered} |`,
    `| incumbent | ${m.incumbent.flag.tp} | ${m.incumbent.flag.fp} | ${m.incumbent.flag.fn} | ${m.incumbent.flag.tn} | ${pct(m.incumbent.flag.precision)} | ${pct(m.incumbent.flag.recall)} | ${num(m.incumbent.flag.f1)} | ${m.incumbent.unanswered} |`,
    '',
    `Agreement on the flag (pairs both answered): kappa ${num(m.agreement.kappa)} over ${m.agreement.n}; raw ${pct(m.agreement.raw)}.`,
    `Stability: Jev swap flag flips ${pct(m.jev.swapFlagFlips)}, swap label flips ${pct(m.jev.swapLabelFlips)}, repeat flag flips ${pct(m.jev.repeatFlagFlips)}, repeat label flips ${pct(m.jev.repeatLabelFlips)}; incumbent swap flag flips ${pct(m.incumbent.swapFlagFlips)}.`,
    '',
    '## Jev per label',
    '',
    '| label | support | precision | recall |',
    '|---|---|---|---|',
    ...m.jev.perLabel.map((l) => `| ${l.label} | ${l.support} | ${pct(l.precision)} | ${pct(l.recall)} |`),
    '',
    `Confusion (gold row → Jev column): ${JSON.stringify(m.jev.confusion)}`,
    '',
    '## Flagged per pair kind',
    '',
    '| gold | note | pairs | Jev flagged | incumbent flagged |',
    '|---|---|---|---|---|',
    ...m.byNote.map((r) => `| ${r.gold} | ${r.note} | ${r.pairs} | ${r.jevFlagged} | ${r.incumbentFlagged} |`),
    '',
    '## Pairs where a judge missed gold',
    '',
    '| pair | gold | Jev label (P opposite) | incumbent |',
    '|---|---|---|---|',
  ];
  for (const p of input.pairs) {
    const gold = p.gold === 'opposite-instructions';
    const jevMiss = jevFlag(p.jevForward) !== gold;
    const incMiss = (p.incumbentForward === true) !== gold;
    if (!jevMiss && !incMiss) continue;
    const jev = p.jevForward ? `${p.jevForward.label} (${p.jevForward.pOpposite.toFixed(2)})` : 'no answer';
    const inc = p.incumbentForward === null ? 'error' : p.incumbentForward ? 'contradicts' : 'no';
    lines.push(`| ${p.id} | ${p.gold} | ${jev}${jevMiss ? ' ✗' : ''} | ${inc}${incMiss ? ' ✗' : ''} |`);
  }
  return lines.join('\n');
}
