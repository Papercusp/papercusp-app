/**
 * P-047 HALF 1 — does agent PROSE add retrieval quality?
 * (context-injection-audit-2026-07-28 P-047 / F-M, bounded by D-052.)
 *
 *   npx tsx packages/operator-core/lib/memory/bench/agent-prose-acceptance-cli.ts \
 *     --doses 150,400,800 --iterations 5000 --seed 47
 *
 * ⚠ THIS CLI ANSWERS ONE HALF OF P-047 AND CANNOT ANSWER THE OTHER (D-052).
 * P-043 excluded agent prose for a stated reason — the self-confirmation loop
 * (assert X → retrieve X → assert more X). That is a FEEDBACK phenomenon; a
 * fixed gold set replayed against a frozen corpus has no feedback path at all,
 * so nothing this run prints bears on it. A favourable result here licenses
 * "prose is retrievally useful", never "prose is safe to ship".
 *
 * WHAT IT RUNS (arms in `agent-prose-arms.ts`):
 *
 *   NULL CONTROL  Both legs set explicitly to the user text. Must be exactly
 *                 zero. It validates the leg-isolation mechanism every other
 *                 arm depends on, not merely harness noise.
 *   ARM C  OFF-TASK prose into the COSINE query, swept over prose LENGTH. The
 *          cost side, and the only leakage-free half of this experiment.
 *   ARM D  ON-TASK prose into the COSINE query. An ORACLE CEILING — it proves
 *          the channel is open (or, if flat, settles P-047 on its own).
 *   ARM E  The same prose into the LEXICAL query — the routing diagnostic.
 *   ARM F  Prose into BOTH legs — the shape a naive implementation takes.
 *
 * WHY THE ADOPTION BAR IS HIGHER THAN P-045's. P-044's split was FREE: query
 * composition on an embed-free leg, so any positive effect was worth keeping.
 * Prose is not free on either axis — it consumes the production query clamp
 * that D-033 measured 70.0% of turn-start queries ALREADY hitting, and it
 * carries P-043's unmeasured risk. So the effect has to be large enough to buy
 * both, and the decision-relevant delta is set accordingly.
 */
import fs from 'node:fs';
import path from 'node:path';

import { HybridBackend, LexicalLegBackend, Mem0Backend } from '@papercusp/memory';
import { reciprocalRank, runGoldSet, seedCorpus } from '@papercusp/memory/bench';
import type { CorpusEntry, QueryOutcome, RetrievalRunResult } from '@papercusp/memory/bench';

import { MEMORY_INJECTION_COSINE_FLOOR, MEMORY_INJECTION_LEX_FLOOR } from '../injection';
import {
  buildAgentProseArm,
  buildProseNullControl,
  proseCoverage,
  PRODUCTION_QUERY_CLAMP,
  type Arm,
  type ArmPair,
  type ProseLeg,
} from './agent-prose-arms';
import { benchPgClient, dropBenchSchema, ensureBenchSchema, setupBenchMemoryHost } from './bench-host';
import { loadCorpusFixture } from './corpus';
import { loadGoldSetFixture } from './gold-set';
import { ALL_ANSWERABLE, classesDisagree, compareLegs, type PerQueryRow } from './paired-leg-report';

const SCOPE = 'bench';
const LIMIT = 10;

/**
 * The effect worth ADOPTING PROSE for, in delta MRR.
 *
 * P-045 used 0.02 because its change was free. This one is not: adding prose to
 * a production query that is already clamped displaces existing content, and
 * P-043's self-confirmation risk stays unmeasured whatever this run shows
 * (D-052). 0.05 MRR over a 40-query class is roughly one query in five gaining
 * a full promotion to rank 1 — a large, visible effect, which is the size a
 * change has to be to justify paying an unquantified risk for it.
 */
const DECISION_RELEVANT_DELTA_MRR = 0.05;

const log = (m: string) => console.log(new Date().toISOString().slice(11, 19), m);

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

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

/**
 * A GRADED hard-negative statistic, because the binary one is inert.
 *
 * `fpAt5` is the fraction of hard negatives returning ≥1 POST-FLOOR hit, and it
 * reads 100% in every arm of the P-045 report INCLUDING the undiluted ceiling —
 * a constant, not an effect (WI-7020). A metric identical in every arm and in
 * the control is measuring a floor, so it cannot answer "did prose admit more
 * noise?". These three can: how MANY rows come back, how strongly they score,
 * and how often the negative comes back saturated.
 */
interface NegativePressure {
  n: number;
  meanRawHits: number;
  medianTopScore: number;
  saturatedFraction: number;
}

function negativePressure(res: RetrievalRunResult): NegativePressure {
  const negs = res.perQuery.filter((o) => o.expected.length === 0);
  if (negs.length === 0) return { n: 0, meanRawHits: 0, medianTopScore: 0, saturatedFraction: 0 };
  const scores = negs.map((o) => o.topScore ?? 0).sort((a, b) => a - b);
  return {
    n: negs.length,
    meanRawHits: negs.reduce((s, o) => s + o.rawHits, 0) / negs.length,
    medianTopScore: scores[Math.floor(scores.length / 2)],
    saturatedFraction: negs.filter((o) => o.rawHits >= 5).length / negs.length,
  };
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
    comparison: compareLegs(
      pair.baseline.label,
      toRows(baseline.perQuery),
      pair.candidate.label,
      toRows(candidate.perQuery),
      { seed: opts.seed, iterations: opts.iterations, decisionRelevantDeltaMrr: DECISION_RELEVANT_DELTA_MRR },
    ),
  };
}

function renderArm(a: ComparedArm): string {
  const lines: string[] = [];
  lines.push(`### ${a.title}`);
  lines.push('');
  lines.push(
    `fusion \`${a.fusionMode}\` · baseline \`${a.comparison.baseline}\` → candidate \`${a.comparison.candidate}\``,
  );
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

  const nb = negativePressure(a.baseline);
  const nc = negativePressure(a.candidate);
  lines.push(
    `hard-negative pressure (n=${nb.n}, GRADED — \`fpAt5\` is pinned at 100% in every arm and is inert, WI-7020): ` +
      `mean raw hits ${nb.meanRawHits.toFixed(2)} → ${nc.meanRawHits.toFixed(2)} · ` +
      `median top score ${nb.medianTopScore.toFixed(4)} → ${nc.medianTopScore.toFixed(4)} · ` +
      `saturated (≥5 hits) ${(nb.saturatedFraction * 100).toFixed(0)}% → ${(nc.saturatedFraction * 100).toFixed(0)}%`,
  );
  lines.push('');
  lines.push(
    `R@10 (positives): ${a.baseline.overall.r10.toFixed(3)} → ${a.candidate.overall.r10.toFixed(3)} · ` +
      `search p50: ${a.baseline.latency.p50.toFixed(0)}ms → ${a.candidate.latency.p50.toFixed(0)}ms`,
  );
  lines.push('');
  if (classesDisagree(a.comparison)) {
    lines.push(
      `> ⚠ THE CLASSES DISAGREE IN SIGN — \`${ALL_ANSWERABLE}\` is uninterpretable for this arm and must not be ` +
        `quoted as the result. Read the per-class rows.`,
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

function coverageNote(pair: ArmPair, leg: ProseLeg): string {
  const cov = proseCoverage(pair, leg);
  const clamp =
    cov.overProductionClamp > 0
      ? ` ⚠ ${cov.overProductionClamp} composed queries exceed the ${PRODUCTION_QUERY_CLAMP}-char production clamp — ` +
        `this row is partly measuring truncation, not prose.`
      : '';
  return (
    `${cov.withProse}/${cov.total} queries received prose · ` +
    `composed query chars: median ${cov.medianQueryChars}, max ${cov.maxQueryChars} ` +
    `(production clamp ${PRODUCTION_QUERY_CLAMP}).${clamp}`
  );
}

async function main(): Promise<void> {
  const doses = (argValue('--doses') ?? '150,400,800')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const iterations = Number(argValue('--iterations') ?? 5000);
  const seed = Number(argValue('--seed') ?? 47);

  setupBenchMemoryHost();
  const pg = await benchPgClient();
  await ensureBenchSchema(pg);

  const corpus = loadCorpusFixture();
  const gold = loadGoldSetFixture().queries;
  const byKey = new Map<string, CorpusEntry>(corpus.map((e) => [e.key, e]));
  const keys = corpus.map((e) => e.key);

  // The PRODUCTION wiring (backend-selection.DEFAULT_MEMORY_BACKEND).
  const mem0 = new Mem0Backend();
  const backend = new HybridBackend(new LexicalLegBackend(mem0), mem0, { name: 'hybrid-pg' });

  const arms: ComparedArm[] = [];
  const cache = new Map<string, RetrievalRunResult>();

  const run: Runner = (arm, opts) =>
    runGoldSet(backend, arm.queries, {
      scope: SCOPE,
      limit: LIMIT,
      minScore: MEMORY_INJECTION_COSINE_FLOOR,
      minLexScore: MEMORY_INJECTION_LEX_FLOOR,
      fusionMode: opts.fusionMode,
      concurrency: 4,
    });

  try {
    log(`seeding ${corpus.length} corpus entries into ${backend.name}…`);
    await seedCorpus(backend, corpus, { scope: SCOPE, verbatim: true, concurrency: 8 });

    // ── NULL CONTROL — read this before anything else ───────────────────────
    arms.push(
      await comparePair(
        run,
        buildProseNullControl(gold),
        {
          fusionMode: 'cosine-gated',
          title: 'NULL CONTROL — no prose, both legs set explicitly (MUST be exactly 0)',
          note:
            'The candidate carries no prose but sets `lexicalQuery` explicitly to the user text — the leg-isolation ' +
            'mechanism every arm below depends on. A non-zero delta here invalidates the whole report.',
          seed,
          iterations,
        },
        cache,
      ),
    );

    // ── ARM C — off-task prose into the cosine query, by length ─────────────
    for (const chars of doses) {
      const opts = { mode: 'offtask' as const, leg: 'cosine' as const, corpus: byKey, corpusKeys: keys, chars };
      const pair = buildAgentProseArm(gold, opts);
      arms.push(
        await comparePair(
          run,
          pair,
          {
            fusionMode: 'cosine-gated',
            title: `ARM C — OFF-TASK prose → cosine leg, ${chars} chars (the COST side; leakage-free)`,
            note:
              `${coverageNote(pair, 'cosine')} The simulated agent is narrating unrelated work, which is D-041's ` +
              `dilution mechanism verbatim. This is a real measurement, not a bound artefact.`,
            seed,
            iterations,
          },
          cache,
        ),
      );
    }

    // ── ARM D — on-task prose into the cosine query (ORACLE) ────────────────
    {
      const opts = { mode: 'ontask' as const, leg: 'cosine' as const, corpus: byKey, corpusKeys: keys };
      const pair = buildAgentProseArm(gold, opts);
      arms.push(
        await comparePair(
          run,
          pair,
          {
            fusionMode: 'cosine-gated',
            title: 'ARM D — ON-TASK prose → cosine leg (ORACLE CEILING, not an uplift estimate)',
            note:
              `${coverageNote(pair, 'cosine')} The prose is the TARGET entry's own description, so the simulated ` +
              `agent is narrating exactly the right topic. Read it as "is the channel open at all" — a flat result ` +
              `here settles P-047 negatively on its own; a large one says nothing about production.`,
            seed,
            iterations,
          },
          cache,
        ),
      );
    }

    // ── ARM E — the routing diagnostic: the same prose into the lexical leg ─
    const lexDose = doses[Math.floor(doses.length / 2)] ?? 400;
    for (const mode of ['ontask', 'offtask'] as const) {
      const opts = {
        mode,
        leg: 'lexical' as const,
        corpus: byKey,
        corpusKeys: keys,
        ...(mode === 'offtask' ? { chars: lexDose } : {}),
      };
      const pair = buildAgentProseArm(gold, opts);
      arms.push(
        await comparePair(
          run,
          pair,
          {
            fusionMode: 'cosine-gated',
            title: `ARM E — ${mode} prose → LEXICAL leg (routing diagnostic)`,
            note:
              `${coverageNote(pair, 'lexical')} Predicted harmful by mechanism: \`lexicalSearch\` normalizes by ` +
              `query token count, so prose tokens lower every real hit's score, and \`lexicalTokens\` caps at 32 ` +
              `keeping the HEAD, so the appended prose is largely discarded anyway.`,
            seed,
            iterations,
          },
          cache,
        ),
      );
    }

    // ── ARM F — prose into BOTH legs: the naive implementation ──────────────
    {
      const opts = {
        mode: 'offtask' as const,
        leg: 'both' as const,
        corpus: byKey,
        corpusKeys: keys,
        chars: lexDose,
      };
      const pair = buildAgentProseArm(gold, opts);
      arms.push(
        await comparePair(
          run,
          pair,
          {
            fusionMode: 'cosine-gated',
            title: `ARM F — OFF-TASK prose → BOTH legs, ${lexDose} chars (the naive implementation)`,
            note:
              `${coverageNote(pair, 'both')} One string to both legs is what a "just add the thinking summary to ` +
              `the query" change produces, and it is the pre-P-044 shape D-041 measured.`,
            seed,
            iterations,
          },
          cache,
        ),
      );
    }

    const stamp = new Date().toISOString();
    const md =
      `# P-047 HALF 1 — does agent PROSE add retrieval quality?\n\n` +
      `${stamp} · corpus ${corpus.length} (frozen real memory, corpus.v1) · gold ${gold.length} (gold-set.v1) · ` +
      `backend \`${backend.name}\` · floors minScore=${MEMORY_INJECTION_COSINE_FLOOR} ` +
      `minLexScore=${MEMORY_INJECTION_LEX_FLOOR} · paired bootstrap ${iterations} iters, seed ${seed}, ` +
      `decision-relevant |ΔMRR| ≥ ${DECISION_RELEVANT_DELTA_MRR}\n\n` +
      `> ⚠ **THIS REPORT ANSWERS ONE HALF OF P-047 AND CANNOT ANSWER THE OTHER (D-052).** P-043 excluded agent ` +
      `prose because of the SELF-CONFIRMATION LOOP — assert X → retrieve X → assert more X. That is a feedback ` +
      `phenomenon; a fixed gold set replayed against a frozen corpus has no feedback path, so nothing below bears ` +
      `on it. A favourable result licenses "prose is retrievally useful", never "prose is safe to ship".\n\n` +
      `> **Both halves of the stimulus are BOUNDS, never an uplift estimate.** ON-TASK prose is an ORACLE (the ` +
      `simulated agent narrates exactly the right topic); OFF-TASK prose is the pessimistic bound and the only ` +
      `leakage-free half. Production sits between, at a mixture this bench cannot observe.\n\n` +
      `> A verdict of \`underpowered\` means the class supports NO conclusion in either direction — never ` +
      `"no difference". Class sizes are 35/40/45.\n\n` +
      `> The adoption bar is ${DECISION_RELEVANT_DELTA_MRR} ΔMRR, higher than P-045's 0.02, because prose is not ` +
      `free: it consumes the ${PRODUCTION_QUERY_CLAMP}-char production query clamp that D-033 measured 70.0% of ` +
      `live turn-start queries ALREADY hitting, so in production it DISPLACES query content rather than adding to ` +
      `empty space.\n\n` +
      arms.map(renderArm).join('\n');

    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..', '..');
    const outDir = path.join(repoRoot, '.papercusp', 'bench-reports');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `p047-agent-prose-${stamp.replace(/[:.]/g, '-')}.md`);
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
