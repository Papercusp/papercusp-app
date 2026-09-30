/**
 * P-045 ACCEPTANCE — measure P-044's per-leg query split on the retrieval
 * bench, in MRR, with the two arms reported INDEPENDENTLY
 * (context-injection-audit-2026-07-28 P-045, ruled by D-049).
 *
 *   npx tsx packages/operator-core/lib/memory/bench/leg-split-acceptance-cli.ts
 *   … --doses 0,1,2,3 --iterations 5000 --seed 45
 *
 * WHY NOT `top_score`, restated because it is the trap that let this whole
 * defect survive (P-045's own text): the push path's score is post-fusion RRF,
 * a RANK statistic — SOMETHING is always rank 1 — so it reads 97.7% of maximum
 * for a perfect query AND for the literal word "continue". Only a ranked metric
 * against known-relevant keys can tell those apart, which is what the gold set
 * is for.
 *
 * WHAT IT RUNS (arms built in `leg-split-arms.ts` by the production composers):
 *
 *   ARM A  cosine de-dilution — `splitLegQueries`. Swept over a DOSE of agent
 *          path tokens, with dose 0 as a null control that must return exactly
 *          zero delta, and the undiluted gold query as the recovery ceiling.
 *   ARM B  lexical signal injection — `lexicalQueryText`, in both its
 *          optimistic (`ontask`) and pessimistic (`offtask`) bounds, under the
 *          real push-path fusion mode AND under `floored-union` as a DIAGNOSTIC
 *          (see below).
 *
 * Verdicts come from `paired-leg-report.compareLegs`: a paired bootstrap CI
 * resampling QUERIES, so shared per-query difficulty cancels, plus McNemar on
 * hit@1. Its `underpowered` verdict is load-bearing here — the classes are
 * 35/40/45 queries — and means "this class supports no verdict either way",
 * never "no difference".
 *
 * ⚠ READING ARM B ON THE PUSH PATH. `cosine-gated` makes the lexical leg a
 * RE-RANKER: it cannot admit a row the cosine leg missed (D-049 constraint 2).
 * So a flat delta there is the PREDICTED outcome for every query whose target
 * cosine never admitted, and is NOT evidence that identifier routing is
 * worthless. The `floored-union` run separates the two readings; it is
 * diagnostic only, because flipping the push path re-opens D-010.
 */
import fs from 'node:fs';
import path from 'node:path';

import { HybridBackend, LexicalLegBackend, Mem0Backend } from '@papercusp/memory';
import { reciprocalRank, runGoldSet, seedCorpus } from '@papercusp/memory/bench';
import type { CorpusEntry, GoldQuery, QueryOutcome, RetrievalRunResult } from '@papercusp/memory/bench';

import { MEMORY_INJECTION_COSINE_FLOOR, MEMORY_INJECTION_LEX_FLOOR } from '../injection';
import { benchPgClient, dropBenchSchema, ensureBenchSchema, setupBenchMemoryHost } from './bench-host';
import { loadCorpusFixture } from './corpus';
import { loadGoldSetFixture } from './gold-set';
import {
  buildDilutionArm,
  buildInjectionArm,
  cleanArm,
  injectionCoverage,
  lexicalTermSurvival,
  type Arm,
  type ArmPair,
} from './leg-split-arms';
import { ALL_ANSWERABLE, classesDisagree, compareLegs, type PerQueryRow } from './paired-leg-report';

const SCOPE = 'bench';
const LIMIT = 10;

/**
 * The effect worth acting on, in delta MRR.
 *
 * P-044's split costs essentially nothing at runtime — the lexical leg is
 * embed-free and this is query COMPOSITION, not an extra call — so the decision
 * it informs is whether to keep and how to size the caps, not whether to pay
 * for a migration. 0.02 MRR over a 35-query class is roughly one query in
 * fourteen gaining a full promotion to rank 1; at zero marginal cost that is
 * worth keeping, and an interval that rules it out is a genuine null.
 * Deliberately tighter than `paired-leg-report`'s 0.03 default, which was
 * sized for a five-surface vector migration.
 */
const DECISION_RELEVANT_DELTA_MRR = 0.02;

const log = (m: string) => console.log(new Date().toISOString().slice(11, 19), m);

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

/**
 * `QueryOutcome` → the paired comparator's row shape.
 *
 * `firstRelevantRank` is 0 on a miss (matching `reciprocalRank`'s 0), which is
 * what makes hit@1 a clean boolean.
 */
function toRows(outcomes: readonly QueryOutcome[]): PerQueryRow[] {
  return outcomes.map((o) => {
    const rr = reciprocalRank(o.expected, o.rankedKeys);
    return {
      id: o.queryId,
      class: o.class,
      firstRelevantRank: rr === 0 ? 0 : Math.round(1 / rr),
      reciprocalRank: rr,
      top1Score: o.topScore ?? 0,
    };
  });
}

interface RunOptions {
  fusionMode: 'cosine-gated' | 'floored-union';
}

type Runner = (arm: Arm, opts: RunOptions) => Promise<RetrievalRunResult>;

interface ComparedArm {
  title: string;
  note?: string;
  fusionMode: string;
  baseline: RetrievalRunResult;
  candidate: RetrievalRunResult;
  comparison: ReturnType<typeof compareLegs>;
}

async function comparePair(
  run: Runner,
  pair: ArmPair,
  opts: RunOptions & { title: string; note?: string; seed: number; iterations: number },
  cache: Map<string, RetrievalRunResult>,
): Promise<ComparedArm> {
  const key = (arm: Arm) => `${opts.fusionMode}::${arm.label}`;
  const get = async (arm: Arm): Promise<RetrievalRunResult> => {
    const hit = cache.get(key(arm));
    if (hit) return hit;
    log(`  running ${arm.label} [${opts.fusionMode}]…`);
    const res = await run(arm, opts);
    cache.set(key(arm), res);
    return res;
  };
  const baseline = await get(pair.baseline);
  const candidate = await get(pair.candidate);
  return {
    title: opts.title,
    ...(opts.note ? { note: opts.note } : {}),
    fusionMode: opts.fusionMode,
    baseline,
    candidate,
    comparison: compareLegs(pair.baseline.label, toRows(baseline.perQuery), pair.candidate.label, toRows(candidate.perQuery), {
      seed: opts.seed,
      iterations: opts.iterations,
      decisionRelevantDeltaMrr: DECISION_RELEVANT_DELTA_MRR,
    }),
  };
}

function fp5(res: RetrievalRunResult): string {
  const v = res.byClass['hard-negative']?.fpAt5;
  return v === undefined ? 'n/a' : `${(v * 100).toFixed(0)}%`;
}

function renderArm(a: ComparedArm): string {
  const lines: string[] = [];
  lines.push(`### ${a.title}`);
  lines.push('');
  lines.push(`fusion \`${a.fusionMode}\` · baseline \`${a.comparison.baseline}\` → candidate \`${a.comparison.candidate}\``);
  if (a.note) lines.push(`\n${a.note}`);
  lines.push('');
  lines.push('| class | n | baseline MRR | candidate MRR | ΔMRR | 95% CI | hit@1 base→cand | verdict |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  const order = ['exact-identifier', 'lexical-gap', 'session-start-intent', ALL_ANSWERABLE];
  for (const cls of order) {
    const c = a.comparison.byClass[cls];
    if (!c) continue;
    const d = c.deltaMrr;
    lines.push(
      `| ${cls} | ${c.n} | ${c.baselineMrr.toFixed(4)} | ${c.candidateMrr.toFixed(4)} | ` +
        `${d.delta.point >= 0 ? '+' : ''}${d.delta.point.toFixed(4)} | ` +
        `[${d.delta.lower.toFixed(4)}, ${d.delta.upper.toFixed(4)}] | ` +
        `${c.baselineRecallAt1.toFixed(2)}→${c.candidateRecallAt1.toFixed(2)} (p=${c.hitAt1.p.toFixed(3)}) | ` +
        `**${c.verdict}** |`,
    );
  }
  lines.push('');
  lines.push(
    `hard-negative FP@5: ${fp5(a.baseline)} → ${fp5(a.candidate)} · ` +
      `R@10 (positives): ${a.baseline.overall.r10.toFixed(3)} → ${a.candidate.overall.r10.toFixed(3)} · ` +
      `search p50: ${a.baseline.latency.p50.toFixed(0)}ms → ${a.candidate.latency.p50.toFixed(0)}ms`,
  );
  lines.push('');
  if (classesDisagree(a.comparison)) {
    // P-045's own hypothesis: an identifier-heavy signal should move
    // exact-identifier and paraphrase recall in OPPOSITE directions. When it
    // does, the pooled row is a weighted average of a trade-off and quoting it
    // as "the" result hides exactly the thing this item was raised to expose.
    lines.push(
      `> ⚠ THE CLASSES DISAGREE IN SIGN — \`${ALL_ANSWERABLE}\` is uninterpretable for this arm and must not be ` +
        `quoted as the result. Read the per-class rows: this is the identifier-vs-paraphrase trade the item predicted.`,
    );
    lines.push('');
  }
  for (const cls of order) {
    const c = a.comparison.byClass[cls];
    if (c) lines.push(`- ${c.statement}`);
  }
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const doses = (argValue('--doses') ?? '0,1,2,3').split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
  const iterations = Number(argValue('--iterations') ?? 5000);
  const seed = Number(argValue('--seed') ?? 45);

  setupBenchMemoryHost();
  const pg = await benchPgClient();
  await ensureBenchSchema(pg);

  const corpus = loadCorpusFixture();
  const gold = loadGoldSetFixture().queries;
  const byKey = new Map<string, CorpusEntry>(corpus.map((e) => [e.key, e]));
  const keys = corpus.map((e) => e.key);

  // The PRODUCTION wiring (backend-selection.DEFAULT_MEMORY_BACKEND): both legs
  // over the one canonical store, lexical as a different RANKING of the same
  // rows. Measuring the older claude-file hybrid would measure a backend the
  // push path does not use.
  const mem0 = new Mem0Backend();
  const backend = new HybridBackend(new LexicalLegBackend(mem0), mem0, { name: 'hybrid-pg' });

  const arms: ComparedArm[] = [];
  const cache = new Map<string, RetrievalRunResult>();

  const run: Runner = (arm, opts) =>
    runGoldSet(backend, arm.queries, {
      scope: SCOPE,
      limit: LIMIT,
      // The real push-path floors (injection.ts), not the bench defaults.
      minScore: MEMORY_INJECTION_COSINE_FLOOR,
      minLexScore: MEMORY_INJECTION_LEX_FLOOR,
      fusionMode: opts.fusionMode,
      concurrency: 4,
    });

  try {
    log(`seeding ${corpus.length} corpus entries into ${backend.name}…`);
    await seedCorpus(backend, corpus, { scope: SCOPE, verbatim: true, concurrency: 8 });

    // ── ARM A: cosine de-dilution, dose-response ────────────────────────────
    for (const dose of doses) {
      const pair = buildDilutionArm(gold, { dose });
      arms.push(
        await comparePair(
          run,
          pair,
          {
            fusionMode: 'cosine-gated',
            title: `ARM A — cosine de-dilution, dose ${dose}${dose === 0 ? ' (NULL CONTROL — must be exactly 0)' : ''}`,
            ...(dose === 0
              ? { note: 'Both arms are byte-identical at dose 0. A non-zero delta here invalidates the whole report.' }
              : {}),
            seed,
            iterations,
          },
          cache,
        ),
      );
    }

    // The recovery ceiling: the gold query with no agent trajectory at all.
    log('  running the undiluted ceiling…');
    const ceiling = await run(cleanArm(gold), { fusionMode: 'cosine-gated' });

    // How much of the injected signal survives the lexical tokenizer's cap.
    // Pure — no search needed — and it is the one way the shipped caps can
    // fail silently, so it is reported whatever the rank deltas do.
    const survival = (['ontask', 'offtask'] as const).map((mode) => ({
      mode,
      ...lexicalTermSurvival(buildInjectionArm(gold, { mode, corpus: byKey, corpusKeys: keys })),
    }));

    // ── ARM B: lexical signal injection, both bounds, both fusion modes ─────
    for (const fusionMode of ['cosine-gated', 'floored-union'] as const) {
      for (const mode of ['ontask', 'offtask'] as const) {
        const pair = buildInjectionArm(gold, { mode, corpus: byKey, corpusKeys: keys });
        const cov = injectionCoverage(pair);
        arms.push(
          await comparePair(
            run,
            pair,
            {
              fusionMode,
              title: `ARM B — lexical signal injection, ${mode}, ${fusionMode}`,
              note:
                `${cov.withSignals}/${cov.total} queries received a composed lexical query.` +
                (fusionMode === 'floored-union'
                  ? ' ⚠ DIAGNOSTIC ONLY — this is not the push path (D-010); it exists to separate "the signal is worthless" from "admission is closed".'
                  : ' This is the real push-path mode: the lexical leg RE-RANKS and cannot admit a row cosine missed (D-049 constraint 2).'),
              seed,
              iterations,
            },
            cache,
          ),
        );
      }
    }

    const stamp = new Date().toISOString();
    const md =
      `# P-045 acceptance — P-044's per-leg query split on the retrieval bench\n\n` +
      `${stamp} · corpus ${corpus.length} (frozen real memory, corpus.v1) · gold ${gold.length} (gold-set.v1) · ` +
      `backend \`${backend.name}\` · floors minScore=${MEMORY_INJECTION_COSINE_FLOOR} minLexScore=${MEMORY_INJECTION_LEX_FLOOR} · ` +
      `paired bootstrap ${iterations} iters, seed ${seed}, decision-relevant |ΔMRR| ≥ ${DECISION_RELEVANT_DELTA_MRR}\n\n` +
      `**Undiluted ceiling** (gold query, no agent trajectory, cosine-gated): ` +
      `overall MRR ${ceiling.overall.mrr.toFixed(4)} · R@10 ${ceiling.overall.r10.toFixed(3)} · ` +
      `exact-id MRR ${(ceiling.byClass['exact-identifier']?.mrr ?? 0).toFixed(4)} · ` +
      `lexical-gap MRR ${(ceiling.byClass['lexical-gap']?.mrr ?? 0).toFixed(4)} · ` +
      `FP@5 ${fp5(ceiling)}\n\n` +
      `> A verdict of \`underpowered\` means this class supports NO conclusion in either direction — ` +
      `never "no difference". Class sizes here are 35/40/45.\n\n` +
      `## Does the injected signal reach the scorer?\n\n` +
      `\`lexicalQueryText\` appends the agent's terms AFTER the user text and \`lexicalTokens\` keeps the ` +
      `HEAD of the token list, so a long utterance evicts exactly the identifiers the split exists to add. ` +
      `Measured with the real tokenizer:\n\n` +
      `| mode | with signals | all terms heard | none heard | median tokens | max tokens (cap 32) | user text alone at cap |\n` +
      `| --- | --- | --- | --- | --- | --- | --- |\n` +
      survival
        .map(
          (s) =>
            `| ${s.mode} | ${s.withSignals}/${gold.length} | ${s.fullySurvived} | ${s.fullyDropped} | ` +
            `${s.medianTokens} | ${s.maxTokens} | ${s.userTextAtCap} |`,
        )
        .join('\n') +
      `\n\n` +
      arms.map(renderArm).join('\n');

    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..', '..');
    const outDir = path.join(repoRoot, '.papercusp', 'bench-reports');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `p045-leg-split-${stamp.replace(/[:.]/g, '-')}.md`);
    fs.writeFileSync(outPath, md, 'utf8');
    console.log('\n' + md + '\nwrote ' + outPath);
  } finally {
    await dropBenchSchema(pg);
    await pg.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
  });
