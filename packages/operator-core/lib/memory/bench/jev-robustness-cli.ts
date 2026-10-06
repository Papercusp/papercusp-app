/**
 * Jev robustness battery CLI (plan jev-decision-model-integration-2026-09-29, P-005).
 *
 *   npx tsx packages/operator-core/lib/memory/bench/jev-robustness-cli.ts \
 *     [--threshold-b 0.4] [--threshold-c 0.35] [--floor-c 0.52] [--repeats 3] \
 *     [--llm-pairs 400] [--no-llm] [--concurrency 4] [--keep] [--encoding state|instructions] \
 *     [--variant v1|v2-content|substance|score|pair]
 *
 * `--encoding` picks the PRIMARY encoding: the one the repeats, the order probe,
 * the adversarial step and the agreement step all run. Step 2 compares it with
 * the other encoding. It defaults to `state`; P-015 runs `instructions`
 * (decision D-012), with thresholds taken from a P-004 run on the same encoding.
 *
 * Runs on arms B (production floor + Jev) and C (lower floor + Jev), each at ONE
 * fixed admission threshold: by default the one P-004 run 5 selected
 * (.papercusp/bench-reports/jev-admission-2026-09-30T03-42-38-294Z.md). Every Jev
 * call is LIVE: a cached grade would make repeats identical by construction and
 * the self-consistency number meaningless.
 *
 *   1. order        the same candidates reversed, scores mapped back
 *   2. encoding     memory text in the question instead of the state
 *   3. adversarial  self-promoting memories seeded into the same store, replayed
 *   4. consistency  `--repeats` identical calls; also re-runs P-004's verdict per repeat
 *   5. agreement    Jev vs the existing LLM relevance judge (search/bench/judge-agreement.ts,
 *                   grades cached in search_judge_grades) and vs the gold labels
 *
 * Needs what P-004 needs (PG, an embedder, the Jev key) plus, for step 5, the
 * llm-testing judge credential. A failed step 5 is reported, not fatal.
 * On a sidecar host export PAPERCUSP_EMBED_SIDECAR_URL (the systemd units' value,
 * e.g. http://127.0.0.1:3384): without it this process loads the embedder in-process,
 * and when CUDA allocation fails it seeds on CPU (measured 2026-09-30: 7.7 GB RSS,
 * 15 CPU-minutes, corpus seed still unfinished after 4 minutes).
 * Artifacts land under .papercusp/bench-reports/jev-robustness-<stamp>.{json,md}.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getOrgPg } from '@papercusp/db-org';
import { JEV_PINNED_MODEL } from '@papercusp/decision-model';
import { runGoldSet, seedCorpus, seedFailureReason, type CandidateHit, type QueryOutcome } from '@papercusp/memory/bench';

import { llmCall } from '../../llm-testing/llm-client';
import { DOC_CHARS, JUDGE_AGREEMENT_MODEL, JUDGE_AGREEMENT_RUBRIC_VERSION, judgeRelevance, RELEVANCE_PASS_BAR } from '../../search/bench/judge-agreement';
import { createCachedJudge } from '../../search/bench/judge-cache';
import { decisionModelLedgerStats } from '../../decision-model-ledger';
import { activeWorkspaceId } from '../../workspace-registry';
import { pushSearchFloors } from '../injection';
import { ensureJevDecisionClient, JEV_MEMORY_TIMEOUT_MS, readJevApiKey } from '../jev-settings';
import { loadCorpusFixture } from './corpus';
import { loadGoldSetFixture } from './gold-set';
import {
  alternateEncoding,
  ARM_C_FLOOR,
  evaluateFilterArm,
  gradeDocId,
  judgeAdmission,
  parseAdmissionEncoding,
  parseAdmissionVariant,
  scoresFromJudgement,
  type AdmissionEncoding,
  type QueryScores,
} from './jev-admission';
import {
  adversarialStats,
  agreementStats,
  buildAdversarialCorpus,
  compareAdversarial,
  consistencyStats,
  contaminationStats,
  flipStats,
  permute,
  renderRobustnessMarkdown,
  reversedOrder,
  robustnessVerdict,
  selectAgreementPairs,
  unpermuteScores,
  type AgreementPair,
  type RepeatVerdict,
  type RobustnessArm,
  type RobustnessReport,
  type ScoreRow,
} from './jev-robustness';
import { BENCH_SCOPE, makeBackendCtx } from './run-bench';

const REPLAY_LIMIT = 10;

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
function numArg(flag: string, fallback: number): number {
  const v = argValue(flag);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${flag} must be a number, got ${v}`);
  return n;
}

const thresholdB = numArg('--threshold-b', 0.4);
const thresholdC = numArg('--threshold-c', 0.35);
const floorC = numArg('--floor-c', ARM_C_FLOOR);
const repeats = Math.max(2, Math.floor(numArg('--repeats', 3)));
const llmPairs = Math.max(0, Math.floor(numArg('--llm-pairs', 400)));
const withLlm = !process.argv.includes('--no-llm');
const concurrency = Math.max(1, Math.floor(numArg('--concurrency', 4)));
const keep = process.argv.includes('--keep');
const primaryEncoding = parseAdmissionEncoding(argValue('--encoding'));
const otherEncoding = alternateEncoding(primaryEncoding);
const variant = parseAdmissionVariant(argValue('--variant'));
const log =(m: string) => console.log(new Date().toISOString().slice(11, 19), m);

/** Bounded-concurrency map that preserves index alignment. */
async function mapPool<T, R>(items: readonly T[], width: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length || 1) }, worker));
  return out;
}

const pushFloors = pushSearchFloors();
const floorA = pushFloors.minScore;
if (floorA === undefined) throw new Error('the live push path has no cosine floor — arm A is undefined, nothing to compare against');

const jevKey = await readJevApiKey();
if (!jevKey) {
  console.error('No Jev key stored (TYPESAFE_API_KEY). Save one in Settings > Memory, then re-run.');
  process.exit(2);
}

const corpus = loadCorpusFixture();
const gold = loadGoldSetFixture().queries;
const goldById = new Map(gold.map((q) => [q.id, q]));
const workspaceId = activeWorkspaceId();
const runId = `jev-robustness-${randomUUID()}`;
const client = ensureJevDecisionClient();
let liveJevCalls = 0;

/**
 * One LIVE Jev call per query with candidates. `order` permutes what Jev sees;
 * the returned scores are always in the ORIGINAL candidate order.
 */
async function judge(
  outcomes: readonly QueryOutcome[],
  encoding: AdmissionEncoding,
  order: 'as-retrieved' | 'reversed' = 'as-retrieved',
): Promise<(QueryScores | undefined)[]> {
  return mapPool(outcomes, concurrency, async (o) => {
    const cands = o.candidates ?? [];
    if (cands.length === 0) return undefined;
    const q = goldById.get(o.queryId);
    if (!q) throw new Error(`replayed query ${o.queryId} is not in the gold set`);
    const perm = order === 'reversed' ? reversedOrder(cands.length) : cands.map((_, i) => i);
    const shown: CandidateHit[] = permute(cands, perm);
    const s = scoresFromJudgement(
      await judgeAdmission(q.query, shown, encoding, variant, (request, call) => {
        liveJevCalls += 1; // per request: a `pair` query sends one per candidate
        return client.decide(request, { consumer: 'memory-bench', subjectIds: call.candidates.map((ci) => gradeDocId(shown[ci])) });
      }),
    );
    return { ...s, scores: unpermuteScores(s.scores, perm) };
  });
}

const rows = (xs: readonly (QueryScores | undefined)[]): ScoreRow[] => xs.map((x) => (x === undefined ? undefined : x.scores));

const ctx = await makeBackendCtx('hybrid-pg', keep);
let exitCode = 0;
try {
  log(`[hybrid-pg] seeding ${corpus.length} corpus entries…`);
  const seeded = await seedCorpus(ctx.backend, corpus, { scope: BENCH_SCOPE, verbatim: true, concurrency: 8 });
  const seedFailure = seedFailureReason(seeded, corpus.length);
  if (seedFailure) throw new Error(`${seedFailure} — refusing to report over a partially seeded store`);

  const replay = (floor: number) =>
    runGoldSet(ctx.backend, gold, {
      scope: BENCH_SCOPE,
      limit: REPLAY_LIMIT,
      concurrency,
      minScore: floor,
      fusionMode: pushFloors.fusionMode,
      ...(pushFloors.minLexScore !== undefined ? { minLexScore: pushFloors.minLexScore } : {}),
      captureCandidates: true,
    });

  log(`replaying ${gold.length} gold queries at floor A=${floorA} and C=${floorC}…`);
  const cleanA = (await replay(floorA)).perQuery;
  const cleanC = (await replay(floorC)).perQuery;
  if (!cleanA.some((o) => o.expected.length > 0 && o.rawHits > 0)) {
    throw new Error('arm A retrieved nothing for every positive query — the replay is broken, refusing to report');
  }

  interface ArmRun {
    arm: 'B' | 'C';
    label: string;
    floor: number;
    threshold: number;
    clean: QueryOutcome[];
    runs: (QueryScores | undefined)[][];
    reversed: (QueryScores | undefined)[];
    /** The same candidates judged under `otherEncoding` (step 2). */
    alternate: (QueryScores | undefined)[];
    adversarial?: QueryOutcome[];
    adversarialScores?: (QueryScores | undefined)[];
  }
  const arms: ArmRun[] = [
    { arm: 'B', label: `floor ${floorA} + Jev P(yes)`, floor: floorA, threshold: thresholdB, clean: cleanA, runs: [], reversed: [], alternate: [] },
    { arm: 'C', label: `floor ${floorC} + Jev P(yes)`, floor: floorC, threshold: thresholdC, clean: cleanC, runs: [], reversed: [], alternate: [] },
  ];

  for (const a of arms) {
    for (let r = 1; r <= repeats; r++) {
      log(`arm ${a.arm}: identical call ${r}/${repeats} (${primaryEncoding} encoding)…`);
      a.runs.push(await judge(a.clean, primaryEncoding));
    }
    log(`arm ${a.arm}: reversed candidate order…`);
    a.reversed = await judge(a.clean, primaryEncoding, 'reversed');
    log(`arm ${a.arm}: ${otherEncoding} encoding…`);
    a.alternate = await judge(a.clean, otherEncoding);
  }

  // ── Adversarial: seed self-promoters into the SAME store, then replay again.
  const advCorpus = buildAdversarialCorpus(gold);
  log(`seeding ${advCorpus.length} self-promoting memories…`);
  const advSeeded = await seedCorpus(ctx.backend, advCorpus, { scope: BENCH_SCOPE, verbatim: true, concurrency: 8 });
  const advFailure = seedFailureReason(advSeeded, advCorpus.length);
  if (advFailure) throw new Error(`adversarial ${advFailure} — refusing to report an adversarial rate over a store missing them`);
  const advA = (await replay(floorA)).perQuery;
  const advC = (await replay(floorC)).perQuery;
  arms[0].adversarial = advA;
  arms[1].adversarial = advC;
  for (const a of arms) {
    log(`arm ${a.arm}: judging candidates with self-promoters present…`);
    a.adversarialScores = await judge(a.adversarial!, primaryEncoding);
  }
  const advBaseline = adversarialStats(advA, null, thresholdB);

  // ── Agreement with the existing LLM relevance judge.
  const agreementByArm = new Map<string, AgreementPair[]>();
  let llmSummary = 'skipped (--no-llm)';
  if (withLlm && llmPairs > 0) {
    interface Candidate {
      queryId: string;
      key: string;
      gold: boolean;
      query: string;
      text: string;
    }
    const union = new Map<string, Candidate>();
    for (const a of arms) {
      a.clean.forEach((o) => {
        const q = goldById.get(o.queryId)!;
        for (const c of o.candidates ?? []) {
          const key = gradeDocId(c);
          union.set(`${o.queryId}|${key}`, { queryId: o.queryId, key, gold: c.key !== null && o.expected.includes(c.key), query: q.query, text: c.text });
        }
      });
    }
    const picked = selectAgreementPairs([...union.values()], llmPairs);
    const cache = createCachedJudge({
      sql: getOrgPg().sql as unknown as Parameters<typeof createCachedJudge>[0]['sql'],
      workspaceId,
      judgeModel: JUDGE_AGREEMENT_MODEL,
      rubricVersion: JUDGE_AGREEMENT_RUBRIC_VERSION,
      runId,
      inner: (input) => judgeRelevance(input, llmCall, JUDGE_AGREEMENT_MODEL),
      onWarn: (m) => console.warn(`[jev-robustness] ${m}`),
    });
    log(`LLM judge (${JUDGE_AGREEMENT_MODEL}) over ${picked.length} of ${union.size} (query, memory) pairs…`);
    const grades = new Map<string, number>();
    let llmErrors = 0;
    let firstError: string | null = null;
    await mapPool(picked, concurrency, async (p) => {
      try {
        const v = await cache.judge({ pairId: `${p.queryId}|${p.key}`, query: p.query, docId: p.key, docText: p.text.slice(0, DOC_CHARS) });
        grades.set(`${p.queryId}|${p.key}`, v.relevance);
      } catch (e) {
        llmErrors += 1;
        firstError ??= e instanceof Error ? e.message : String(e);
      }
    });
    llmSummary = `${cache.summary()}; ${grades.size}/${picked.length} graded` + (llmErrors > 0 ? `; ${llmErrors} FAILED (first: ${firstError})` : '');
    for (const a of arms) {
      const base = a.runs[0];
      const pairs: AgreementPair[] = [];
      a.clean.forEach((o, i) => {
        const s = base[i]?.scores;
        if (!s) return;
        (o.candidates ?? []).forEach((c, j) => {
          const key = gradeDocId(c);
          const llm = grades.get(`${o.queryId}|${key}`);
          if (llm !== undefined) pairs.push({ queryId: o.queryId, key, gold: c.key !== null && o.expected.includes(c.key), jev: s[j], llm });
        });
      });
      agreementByArm.set(a.arm, pairs);
    }
  }

  // ── Verdicts.
  const verdicts: RobustnessArm[] = arms.map((a) => {
    const evalAt = (scores: (QueryScores | undefined)[]) =>
      evaluateFilterArm(cleanA, { arm: a.arm, label: a.label, floor: a.floor, outcomes: a.clean, scores });
    const atT = (v: ReturnType<typeof evalAt>) => v.thresholds.find((t) => Math.abs(t.threshold - a.threshold) < 1e-9);
    const repeatVerdicts: RepeatVerdict[] = a.runs.map((scores, i) => {
      const v = evalAt(scores);
      const t = atT(v);
      return {
        run: i + 1,
        status: v.status,
        selectedThreshold: v.selectedThreshold,
        hardNegAdmittedAtT: t?.point.hardNegAdmitted ?? -1,
        r10AtT: t?.point.r10 ?? Number.NaN,
      };
    });
    // The comparison is keyed by encoding NAME, whichever of the two is primary.
    const byEncoding: Record<AdmissionEncoding, ReturnType<typeof evalAt>> =
      primaryEncoding === 'state'
        ? { state: evalAt(a.runs[0]), instructions: evalAt(a.alternate) }
        : { state: evalAt(a.alternate), instructions: evalAt(a.runs[0]) };
    const vState = byEncoding.state;
    const vInstr = byEncoding.instructions;
    const advStats = adversarialStats(a.adversarial!, rows(a.adversarialScores!), a.threshold);
    const pairs = agreementByArm.get(a.arm);
    return robustnessVerdict({
      arm: a.arm,
      label: a.label,
      floor: a.floor,
      threshold: a.threshold,
      order: flipStats(rows(a.runs[0]), rows(a.reversed), a.threshold, { minCandidates: 2 }),
      consistency: consistencyStats(a.runs.map(rows), a.threshold),
      repeats: repeatVerdicts,
      encoding: {
        flips: flipStats(rows(a.runs[0]), rows(a.alternate), a.threshold),
        stateStatus: vState.status,
        instructionsStatus: vInstr.status,
        stateHardNegAdmitted: atT(vState)?.point.hardNegAdmitted ?? -1,
        instructionsHardNegAdmitted: atT(vInstr)?.point.hardNegAdmitted ?? -1,
      },
      adversarial: compareAdversarial(advA, advBaseline, a.adversarial!, advStats),
      contamination: contaminationStats(a.clean, rows(a.runs[0]), a.adversarial!, rows(a.adversarialScores!), a.threshold),
      agreement: pairs && pairs.length > 0 ? agreementStats(pairs, a.threshold, RELEVANCE_PASS_BAR) : null,
    });
  });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const st = decisionModelLedgerStats();
    if (st.written + st.failed >= liveJevCalls) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const ledger = decisionModelLedgerStats();

  const generatedAt = new Date().toISOString();
  const report: RobustnessReport = {
    generatedAt,
    params: {
      runId,
      backend: 'hybrid-pg (isolated bench schema)',
      corpus: corpus.length,
      adversarialCorpus: `${advCorpus.length} (6 generic + one topical per gold query)`,
      gold: gold.length,
      pushContract: `fusion ${pushFloors.fusionMode}, lexical bar ${pushFloors.minLexScore ?? 'backend default'}`,
      floors: `A/B ${floorA}, C ${floorC}`,
      encoding: `${primaryEncoding} (primary: repeats, order, adversarial, agreement); compared with ${otherEncoding} in step 2`,
      variant,
      thresholds: `B t=${thresholdB}, C t=${thresholdC} (P-004 run 5 selections unless overridden)`,
      jevModel: JEV_PINNED_MODEL,
      filterTimeoutMs: JEV_MEMORY_TIMEOUT_MS,
      repeats,
      cache: 'no Jev cache reads or writes: every call is live',
      llmJudge: `${JUDGE_AGREEMENT_MODEL}, rubric ${JUDGE_AGREEMENT_RUBRIC_VERSION}, pass bar ${RELEVANCE_PASS_BAR}; ${llmSummary}`,
      decisionLedger: `${ledger.written} rows written, ${ledger.failed} failed${ledger.lastError ? ` (last error: ${ledger.lastError})` : ''}; ${liveJevCalls} live Jev calls`,
    },
    arms: verdicts,
    caveats: [
      'The fixed thresholds were selected by P-004 on this same gold set; the robustness numbers describe those operating points, not a tuned optimum.',
      'Order is probed with ONE permutation (reversal). Read the order flip rate against the repeat-call flip rate: the part of it the repeats also show is noise, not position bias.',
      'Topical self-promoters quote their query verbatim, the worst case for a cosine floor. Real self-promoting memories would clear the floor less often, so arm A\'s adversarial rate here is an upper bound.',
      'Gold labels count only the keys the gold set lists as expected; a non-expected candidate may still be useful, so any "vs gold" specificity is a lower bound.',
      'The LLM judge answers the search-relevance rubric ("would a searcher be satisfied"), not the admission question Jev is asked; Jev-vs-LLM agreement compares two framings of relevance, neither of which is ground truth.',
      'All repeats ran minutes apart on one day; drift across days or model versions is not covered.',
    ],
  };

  const md = renderRobustnessMarkdown(report);
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..', '..');
  const dir = path.join(repoRoot, '.papercusp', 'bench-reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = generatedAt.replace(/[:.]/g, '-');
  const jsonPath = path.join(dir, `jev-robustness-${stamp}.json`);
  const mdPath = path.join(dir, `jev-robustness-${stamp}.md`);
  const perQuery = arms.flatMap((a) =>
    a.clean.map((o, i) => ({
      arm: a.arm,
      queryId: o.queryId,
      class: o.class,
      keys: (o.candidates ?? []).map(gradeDocId),
      runs: a.runs.map((r) => r[i]?.scores ?? r[i]?.failure ?? null),
      reversed: a.reversed[i]?.scores ?? a.reversed[i]?.failure ?? null,
      [otherEncoding]: a.alternate[i]?.scores ?? a.alternate[i]?.failure ?? null,
    })),
  );
  const adversarialPerQuery = arms.flatMap((a) =>
    a.adversarial!.map((o, i) => ({
      arm: a.arm,
      queryId: o.queryId,
      keys: (o.candidates ?? []).map(gradeDocId),
      scores: a.adversarialScores![i]?.scores ?? a.adversarialScores![i]?.failure ?? null,
    })),
  );
  fs.writeFileSync(jsonPath, JSON.stringify({ report, perQuery, adversarialPerQuery }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(mdPath, md + '\n', 'utf8');
  console.log('\n' + md + '\n');
  console.log('wrote', jsonPath);
  console.log('wrote', mdPath);
} catch (e) {
  console.error(e);
  exitCode = 1;
} finally {
  await ctx.cleanup();
}
process.exit(exitCode);
