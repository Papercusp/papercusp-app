/**
 * judge-agreement.ts — P-038's PILOT: does an LLM relevance judge agree with
 * ground truth we ALREADY trust, and does it agree with ITSELF?
 * (plan semantic-search-fingerprint-coverage-2026-08-03, D-077 §3 / WI-37638.)
 *
 * WHY THIS EXISTS BEFORE THE LABELLED PASS. P-038 wants LLM-judged relevance
 * labels for real queries. A judge that is not first validated produces labels
 * that LOOK like data and are not — and no downstream metric can detect that,
 * because there is nothing left to check them against. So the judge is measured
 * against gold that is known BY CONSTRUCTION (`ref-expansion-gold.ts`, D-076)
 * BEFORE it is trusted to label anything.
 *
 * WHAT IT MEASURES — three numbers that are deliberately NOT collapsed into one:
 *
 *   1. SENSITIVITY — of pairs gold says are relevant, how many does the judge
 *      call relevant.
 *   2. SPECIFICITY — of pairs gold says are irrelevant, how many does the judge
 *      call irrelevant. ⚠ The negatives here are sampled at RANDOM from the
 *      pool, so they are EASY. Specificity against random negatives is an
 *      UPPER BOUND on discriminative power, not an estimate of it; a real
 *      screening task presents near-misses that rank highly. Do not quote this
 *      number as "the judge is N% accurate".
 *   3. SELF-CONSISTENCY — re-judging the same pair at temperature 0.4 (the
 *      double-scored convention `memory/bench/judged.ts` established). Reported
 *      as mean/max |Δ| AND as the BINARY FLIP RATE, because those answer
 *      different questions: a |Δ| of 1 that never crosses the pass bar changes
 *      no label, while a |Δ| of 1 that crosses it flips one. Only the flip rate
 *      bounds how much label noise the judge injects.
 *
 * ⚠ A DISAGREEMENT ON A POSITIVE PAIR IS AMBIGUOUS, AND THE PILOT MUST SAY SO.
 *   The gold edge is STRUCTURAL (row cites item R), not semantic. A row that
 *   cites R as a sibling ticket or a passing "see also" is gold-relevant while
 *   being topically about something else. So a positive the judge scores low is
 *   EITHER judge error OR a citation that was never a topical relationship. This
 *   module cannot separate those two, and reports the rate rather than assigning
 *   blame. Treat sensitivity as a LOWER bound on judge quality.
 *
 * ⚠ AGREEMENT MEASURED ON DERIVED QUERIES DOES NOT TRANSFER UNEXAMINED TO REAL
 *   ONES. Both arms here are built from item titles, not typed by a user. That
 *   limit is P-038's to report, not to assume away.
 *
 * Pure + dependency-injected: no PG, no argv, no fs. The transport (`llm`) and
 * the pairs come from the caller, so the same core serves a bench CLI or a gate
 * test — the form decision is deliberately still open.
 */

import {
  deriveRubricVersion,
  judgeRun,
  JUDGE_PROMPT_SCAFFOLD_VERSION,
  type JudgeRubric,
  type LlmCallFn,
  type PersonaTraits,
  type RunSummary,
} from '@papercusp/testing-shell/llm';

import { hash32, type GoldQuery, type PoolDoc } from './ref-expansion-gold';

// =============================================================================
// Frozen judging contract — derive RUBRIC_VERSION from the rubric content
// =============================================================================

/** Frozen judge model, mirroring the judged tier's freeze discipline (D-005). */
export const JUDGE_AGREEMENT_MODEL = 'claude-sonnet-4-6';

/** score >= this counts as "the judge called it relevant". */
export const RELEVANCE_PASS_BAR = 3;

/** Temperature of the second (self-consistency) pass — judged.ts's convention. */
export const SELF_CONSISTENCY_TEMPERATURE = 0.4;

const SEARCH_RELEVANCE_RUBRIC_CONTENT: Pick<JudgeRubric, 'axes'> = {
  axes: [
    {
      id: 'relevance',
      description:
        'Would a person who issued this search query be satisfied to find THIS document ' +
        'among the results? Judge the document on its own merits against the query intent: ' +
        'does it carry the subject matter the query is asking about? Judge TOPICAL relevance ' +
        'only — do not reward a document merely for sharing vocabulary with the query, and do ' +
        'not penalise one for using different words for the same subject.',
      anchors: {
        bad: 'The document is about a different subject; finding it would be a wasted result.',
        ideal: 'The document is squarely about what the query asks for.',
      },
    },
  ],
};

/**
 * The INSTRUCTION half of the judging contract — everything handed to the judge that
 * is not the rubric object.
 *
 * ⚠ THE MEMBERSHIP RULE, AND WHY IT IS THE WHOLE POINT (EI-21446121743333195).
 *   `judgeRun` builds the model input from exactly FOUR sources — the system prompt
 *   from `opts` (judge.ts:230-303), `formatTranscript(run.turns)` (:325-345),
 *   `formatTelemetry(run)` (:352-363) and the violations block (empty here). Anything
 *   reaching ANY of those four is a judging input, and every judging input must be
 *   either INSIDE this object or inside the six-column cache key
 *   (workspace_id, judge_model, rubric_version, query_hash, doc_id, doc_text_hash).
 *   A value in neither is a silent drift trap: edit it and the judge reads something
 *   different while cached grades produced under the OLD text keep serving.
 *
 *   That trap has now been found three times at three different depths — the axes
 *   (EI-21443136282514038), the instruction fields (EI-21444532129225543), and the
 *   transcript framing below. Each looked covered because its NEIGHBOUR was. So the
 *   fields here are deliberately not just "the instructions": they are the complete
 *   set of prompt-visible values this bench authors.
 *
 * WHY TEMPLATES RATHER THAN INTERPOLATED STRINGS: `scenarioTemplate` and
 * `transcriptTemplate` carry `{query}` / `{docText}` placeholders instead of the
 * pair's own text. The INVARIANT half — what the judge is asked to do, and how the
 * document is framed — stays a hashable constant, while the per-pair halves are
 * already covered by `query_hash` / `doc_text_hash` in the primary key. Interpolating
 * them here would make the version vary per pair and defeat the cache outright,
 * which is the opposite failure and just as wrong.
 *
 * WHY `scenarioId` IS A CONSTANT: judge.ts:232 puts it in the prompt's FIRST LINE, and
 * it is the one prompt-visible value that used to carry per-pair identity
 * (`search-relevance-${pairId}`) while `pair_id` is NOT in the cache key — so two pairs
 * sharing a key could be judged under different prompts. That was safe only while
 * pairId stayed a function of (query, doc), an invariant nothing pinned. Per-pair
 * identity still lives on `runId` / `identityHash`, neither of which reaches the prompt.
 *
 * This object is the single source for BOTH the prompt and the version hash, so the
 * two cannot diverge. Editing any value here moves JUDGE_AGREEMENT_RUBRIC_VERSION and
 * makes prior paid grades unreachable — which is the intended behaviour, never an update.
 */
export const JUDGE_INSTRUCTION_CONTRACT: {
  scenarioId: string;
  scenarioTemplate: string;
  personaSummary: string;
  goalSummary: string;
  transcriptTemplate: string;
  turnFinishReason: RunSummary['turns'][number]['finishReason'];
  turnLatencyMs: number;
  turnCostUsd: number;
  criticality: JudgeRubric['criticality'] | null;
} = {
  scenarioId: 'search-relevance',
  scenarioTemplate:
    'Search-relevance check. A user issued the query "{query}". The assistant turn ' +
    'shows ONE document a retrieval system could return for it, verbatim. Score ONLY ' +
    'whether that document is topically relevant to the query. There is no conversation ' +
    'to evaluate and no tool use — ignore both.',
  personaSummary: 'n/a — non-interactive relevance bench (no sim-user)',
  goalSummary: 'Topical relevance of one document to one query.',
  // Reaches the judge verbatim through formatTranscript (judge.ts:331). It reads as
  // incidental scaffolding, which is exactly why it sat outside the hash: it is free
  // prose in a template literal, the easiest kind of judging input to reword by accident.
  transcriptTemplate: 'Search result document for the query "{query}":\n\n{docText}',
  // Emitted as `**finishReason:** done` (judge.ts:341) and as the telemetry strip
  // (judge.ts:352-363). Constant today — but "constant today" is the assumption this
  // whole defect class is made of, so they are pinned rather than trusted.
  turnFinishReason: 'done',
  turnLatencyMs: 0,
  turnCostUsd: 0,
  // null, not undefined: JSON.stringify DROPS undefined keys, so an undefined
  // criticality would leave this axis outside the hash exactly as before.
  criticality: null,
};

/**
 * Substitute `{query}` / `{docText}` into a contract template.
 *
 * Deliberately ONE pass with a FUNCTION replacer, for two reasons that both bite
 * silently. A string replacement makes `$&`, `` $` ``, `$'` and `$1` special in the
 * REPLACEMENT — so a document containing `$&` would be corrupted into a copy of the
 * matched placeholder — and a function replacer is the documented way to disable that.
 * One pass also stops a substituted value that happens to contain `{docText}` from
 * being re-substituted by a later pass.
 */
function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(query|docText)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key]! : whole,
  );
}

/**
 * Derive the cache key from every input that can change the judged prompt.
 *
 * The key must move whenever the actual judging contract moves. Deriving it from
 * the serialized contract removes the old hand-maintained version/comment
 * binding: changing an axis, anchor, or instruction makes prior paid grades
 * unreachable on its own, with no remembered bump.
 *
 * `scaffoldVersion` is the third and last layer (WI-41675 / D-012). The first
 * two — the rubric content and this file's own instruction contract — are
 * values WE author. The third is text we do not author and cannot see from
 * here: the rules, score-5 anchor, output schema and structural labels that
 * `@papercusp/testing-shell`'s judge wraps around them. Without it, editing a
 * rule line in that package changed every judged prompt while leaving already-
 * paid grades reachable under an unchanged key.
 *
 * Taken as a parameter rather than read from the import so the derivation is
 * falsifiable in a test: two different scaffold versions must produce two
 * different keys.
 *
 * Composed via testing-shell's shared `deriveRubricVersion` (WI-41678) so this
 * file and the nine operator-core rubrics share ONE derivation rather than two
 * hand-rolled shapes that could drift apart. The produced value is byte-identical
 * to the previous inline formula, which the sibling test pins independently by
 * recomputing it from first principles.
 */
export function deriveJudgeAgreementRubricVersion(scaffoldVersion: string): string {
  return deriveRubricVersion('search-relevance', {
    rubric: SEARCH_RELEVANCE_RUBRIC_CONTENT,
    instructions: JUDGE_INSTRUCTION_CONTRACT,
    scaffold: scaffoldVersion,
  });
}

export const JUDGE_AGREEMENT_RUBRIC_VERSION = deriveJudgeAgreementRubricVersion(
  JUDGE_PROMPT_SCAFFOLD_VERSION,
);

export const SEARCH_RELEVANCE_RUBRIC: JudgeRubric = {
  version: JUDGE_AGREEMENT_RUBRIC_VERSION,
  ...SEARCH_RELEVANCE_RUBRIC_CONTENT,
  ...(JUDGE_INSTRUCTION_CONTRACT.criticality
    ? { criticality: JUDGE_INSTRUCTION_CONTRACT.criticality }
    : {}),
};

const BENCH_PERSONA_TRAITS: PersonaTraits = {
  verbosity: 'terse',
  politeness: 'neutral',
  clarification: 'never_clarifies',
  goalClarity: 'precise',
  interrupts: false,
  modality: 'text',
};

// =============================================================================
// Shapes
// =============================================================================

/** Which query arm a pair was built from — they are NOT interchangeable. */
export type QueryArm = 'verbatim' | 'degraded';

/** One (query, document) pair carrying the label gold assigns it. */
export interface JudgedPair {
  /** Stable id — `${ref}:${arm}:${pos|neg}`; also the double-score join key. */
  pairId: string;
  /** The referenced item the query was derived from. */
  ref: string;
  arm: QueryArm;
  query: string;
  docId: string;
  docText: string;
  /** TRUE when gold says this document is relevant to this query. */
  goldRelevant: boolean;
}

export interface PairOutcome extends JudgedPair {
  /** Judge score on the relevance axis, 0..5. */
  relevance: number;
  /** Judge's binary call at the pass bar. */
  judgedRelevant: boolean;
  /** Whether the judge's binary call matches gold. */
  agrees: boolean;
  judgeCostUsd: number;
  judgeNotes?: string;
}

export interface ArmAggregate {
  arm: QueryArm;
  positives: { n: number; meanScore: number; sensitivity: number };
  negatives: { n: number; meanScore: number; specificity: number };
  /**
   * Raw agreement over both classes. ⚠ Dominated by the easy random negatives —
   * always read the two class rates above instead of this one.
   */
  rawAgreement: number;
  /** Mean score gap positives − negatives: the judge's separation on this arm. */
  separation: number;
}

export interface SelfConsistency {
  n: number;
  meanAbsDelta: number;
  maxAbsDelta: number;
  /** Fraction of re-judged pairs whose BINARY call changed — the label-noise floor. */
  flipRate: number;
  temperature: number;
}

export interface JudgeAgreementReport {
  startedAt: string;
  finishedAt: string;
  judgeModel: string;
  rubricVersion: string;
  passBar: number;
  outcomes: PairOutcome[];
  byArm: ArmAggregate[];
  selfConsistency: SelfConsistency | null;
  judgeCostUsd: number;
  /** Limits that must travel WITH the numbers, never as a footnote elsewhere. */
  caveats: string[];
}

// =============================================================================
// Pair construction
// =============================================================================

/** Documents are truncated so one judged pair stays a bounded prompt. */
export const DOC_CHARS = 1200;

/**
 * Build the judged pairs for one query: one gold-relevant document and one
 * gold-irrelevant one, per arm.
 *
 * The negative is picked by a SEEDED hash rather than at random so a re-run
 * judges the same pairs — an agreement number that moves because the sample
 * moved is not a measurement of the judge.
 *
 * The referenced item itself is EXCLUDED from the negative pool: its presence
 * there is an artifact of sampling (it does not CITE itself, so gold never
 * labels it relevant), and it is the one document guaranteed to be topically
 * identical to the query. Drawing it as a "negative" would manufacture a
 * disagreement the gold never claimed and charge it to the judge.
 */
export function buildPairsForQuery(q: GoldQuery, pool: readonly PoolDoc[]): JudgedPair[] {
  const relevant = new Set(q.relevantIds);
  const posDoc = pool.find((d) => relevant.has(d.id));
  const negCandidates = pool.filter((d) => !relevant.has(d.id) && d.id !== q.ref);
  if (!posDoc || negCandidates.length === 0) return [];
  const negDoc = negCandidates[hash32(`neg:${q.ref}`) % negCandidates.length]!;

  const arms: Array<{ arm: QueryArm; query: string }> = [
    { arm: 'verbatim', query: q.text },
    { arm: 'degraded', query: q.degraded },
  ];
  return arms.flatMap(({ arm, query }) => [
    {
      pairId: `${q.ref}:${arm}:pos`,
      ref: q.ref,
      arm,
      query,
      docId: posDoc.id,
      docText: posDoc.v1Text.slice(0, DOC_CHARS),
      goldRelevant: true,
    },
    {
      pairId: `${q.ref}:${arm}:neg`,
      ref: q.ref,
      arm,
      query,
      docId: negDoc.id,
      docText: negDoc.v1Text.slice(0, DOC_CHARS),
      goldRelevant: false,
    },
  ]);
}

// =============================================================================
// Judging
// =============================================================================

/**
 * The minimal shape judging needs: an id, a query, and one document.
 *
 * Deliberately WITHOUT `goldRelevant`. The judged-pair path (this file) has a
 * gold label to agree or disagree with; the labelled-relevance pass
 * (`labelled-relevance.ts`) is PRODUCING the labels and has none. Both call the
 * same judge through this shape, so the frozen contract — model, rubric,
 * prompt, pass bar — is one definition rather than two that drift.
 */
export interface JudgeableDoc {
  /** Stable id for this (query, document) judgement. */
  pairId: string;
  query: string;
  docId: string;
  docText: string;
}

/** What the judge returned, with no reference to any gold label. */
export interface JudgeVerdict {
  /** Judge score on the relevance axis, 0..5. */
  relevance: number;
  /** Judge's binary call at {@link RELEVANCE_PASS_BAR}. */
  judgedRelevant: boolean;
  judgeCostUsd: number;
  judgeNotes?: string;
}

/**
 * Synthesize the minimal one-turn RunSummary `judgeRun` consumes.
 *
 * Every field below that REACHES THE PROMPT is read from JUDGE_INSTRUCTION_CONTRACT, so
 * editing the framing necessarily moves the cache namespace. The fields that do NOT
 * reach the prompt — runId, identityHash, sutModel, personaTraits, workspaceMode,
 * transportMode, scenarioVersion, timestamps — stay per-pair for debuggability at zero
 * cache cost. That split is the whole design; see the contract's membership rule.
 */
export function synthesizePairRun(pair: JudgeableDoc, judgeModel: string): RunSummary {
  const now = new Date();
  return {
    runId: `p038-${pair.pairId}`,
    scenarioId: JUDGE_INSTRUCTION_CONTRACT.scenarioId,
    scenarioVersion: 1,
    scenarioTarget: 'search-bench',
    identityHash: `p038:${JUDGE_AGREEMENT_RUBRIC_VERSION}:${pair.pairId}`,
    sutModel: 'derived-gold pair (no retrieval system in the loop)',
    judgeModel,
    personaId: 'search-bench',
    personaTraits: BENCH_PERSONA_TRAITS,
    workspaceMode: 'isolated',
    transportMode: 'in-process',
    turns: [
      {
        assistantText: fillTemplate(JUDGE_INSTRUCTION_CONTRACT.transcriptTemplate, {
          query: pair.query,
          docText: pair.docText,
        }),
        toolCalls: [],
        toolResults: [],
        cards: [],
        controlTags: [],
        costUsd: JUDGE_INSTRUCTION_CONTRACT.turnCostUsd,
        latencyMs: JUDGE_INSTRUCTION_CONTRACT.turnLatencyMs,
        finishReason: JUDGE_INSTRUCTION_CONTRACT.turnFinishReason,
        rawSseTape: [],
      },
    ],
    toolInvocations: [],
    continueChainRows: [],
    // Also prompt-visible: formatTelemetry emits `Total: N USD` (judge.ts:358).
    totalCostUsd: JUDGE_INSTRUCTION_CONTRACT.turnCostUsd,
    startedAt: now,
    finishedAt: now,
    finishReason: 'completed',
    capBreaches: [],
  };
}

/**
 * Judge ONE (query, document) pair on the frozen, content-versioned search rubric.
 *
 * This is the whole judging primitive: everything above it in this file is
 * gold-comparison arithmetic, and everything the labelled pass adds is
 * retrieval and scoring. Nothing here knows what "correct" is.
 */
export async function judgeRelevance(
  pair: JudgeableDoc,
  llm: LlmCallFn,
  judgeModel: string = JUDGE_AGREEMENT_MODEL,
  temperature?: number,
): Promise<JudgeVerdict> {
  const run = synthesizePairRun(pair, judgeModel);
  const judge = await judgeRun(
    {
      model: judgeModel,
      rubric: SEARCH_RELEVANCE_RUBRIC,
      scenarioId: run.scenarioId,
      // Built FROM the hashed contract, never restated here — a second copy of this
      // text is exactly what would let the prompt drift away from the cache key.
      scenarioDescription: fillTemplate(JUDGE_INSTRUCTION_CONTRACT.scenarioTemplate, {
        query: pair.query,
      }),
      personaSummary: JUDGE_INSTRUCTION_CONTRACT.personaSummary,
      goalSummary: JUDGE_INSTRUCTION_CONTRACT.goalSummary,
      ...(temperature !== undefined ? { temperature } : {}),
    },
    run,
    [],
    llm,
  );

  const relevance = judge.scores.relevance ?? 0;
  return {
    relevance,
    judgedRelevant: relevance >= RELEVANCE_PASS_BAR,
    judgeCostUsd: judge.costUsd,
    ...(judge.notes ? { judgeNotes: judge.notes } : {}),
  };
}

export async function judgePair(
  pair: JudgedPair,
  llm: LlmCallFn,
  judgeModel: string = JUDGE_AGREEMENT_MODEL,
  temperature?: number,
): Promise<PairOutcome> {
  const verdict = await judgeRelevance(pair, llm, judgeModel, temperature);
  return {
    ...pair,
    relevance: verdict.relevance,
    judgedRelevant: verdict.judgedRelevant,
    agrees: verdict.judgedRelevant === pair.goldRelevant,
    judgeCostUsd: verdict.judgeCostUsd,
    ...(verdict.judgeNotes ? { judgeNotes: verdict.judgeNotes } : {}),
  };
}

// =============================================================================
// Aggregation
// =============================================================================

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function aggregateByArm(outcomes: readonly PairOutcome[]): ArmAggregate[] {
  const arms = [...new Set(outcomes.map((o) => o.arm))];
  return arms.map((arm) => {
    const rows = outcomes.filter((o) => o.arm === arm);
    const pos = rows.filter((r) => r.goldRelevant);
    const neg = rows.filter((r) => !r.goldRelevant);
    const posMean = mean(pos.map((r) => r.relevance));
    const negMean = mean(neg.map((r) => r.relevance));
    return {
      arm,
      positives: {
        n: pos.length,
        meanScore: posMean,
        sensitivity: pos.length === 0 ? 0 : pos.filter((r) => r.judgedRelevant).length / pos.length,
      },
      negatives: {
        n: neg.length,
        meanScore: negMean,
        specificity: neg.length === 0 ? 0 : neg.filter((r) => !r.judgedRelevant).length / neg.length,
      },
      rawAgreement: rows.length === 0 ? 0 : rows.filter((r) => r.agrees).length / rows.length,
      separation: posMean - negMean,
    };
  });
}

export interface RunJudgeAgreementOptions {
  pairs: readonly JudgedPair[];
  llm: LlmCallFn;
  judgeModel?: string;
  /** Re-judge the first N pairs at temp 0.4 for self-consistency. Default 8; 0 disables. */
  selfConsistencyN?: number;
  log?: (msg: string) => void;
}

export async function runJudgeAgreement(
  opts: RunJudgeAgreementOptions,
): Promise<JudgeAgreementReport> {
  const startedAt = new Date().toISOString();
  const log = opts.log ?? (() => {});
  const judgeModel = opts.judgeModel ?? JUDGE_AGREEMENT_MODEL;
  const selfConsistencyN = opts.selfConsistencyN ?? 8;

  const outcomes: PairOutcome[] = [];
  for (const [i, pair] of opts.pairs.entries()) {
    outcomes.push(await judgePair(pair, opts.llm, judgeModel));
    if ((i + 1) % 10 === 0) log(`judged ${i + 1}/${opts.pairs.length} pairs`);
  }

  let selfConsistency: SelfConsistency | null = null;
  if (selfConsistencyN > 0 && outcomes.length > 0) {
    // Sample ACROSS the outcome list rather than taking a prefix: the pairs are
    // emitted grouped by arm and class, so a prefix would re-judge only one
    // corner of the space and report its stability as the judge's.
    const stride = Math.max(1, Math.floor(outcomes.length / selfConsistencyN));
    const probes = outcomes.filter((_, i) => i % stride === 0).slice(0, selfConsistencyN);
    log(`re-judging ${probes.length} pairs at temp ${SELF_CONSISTENCY_TEMPERATURE}…`);
    const deltas: number[] = [];
    let flips = 0;
    for (const row of probes) {
      const second = await judgePair(row, opts.llm, judgeModel, SELF_CONSISTENCY_TEMPERATURE);
      deltas.push(Math.abs(second.relevance - row.relevance));
      if (second.judgedRelevant !== row.judgedRelevant) flips++;
      outcomes.push({ ...second, pairId: `${second.pairId}#rejudge` });
    }
    if (deltas.length > 0) {
      selfConsistency = {
        n: deltas.length,
        meanAbsDelta: mean(deltas),
        maxAbsDelta: Math.max(...deltas),
        flipRate: flips / deltas.length,
        temperature: SELF_CONSISTENCY_TEMPERATURE,
      };
    }
  }

  // The re-judge rows exist for the delta only; they would double-count a pair
  // in the arm aggregates, so aggregate over the first pass alone.
  const firstPass = outcomes.filter((o) => !o.pairId.endsWith('#rejudge'));

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    judgeModel,
    rubricVersion: JUDGE_AGREEMENT_RUBRIC_VERSION,
    passBar: RELEVANCE_PASS_BAR,
    outcomes,
    byArm: aggregateByArm(firstPass),
    selfConsistency,
    judgeCostUsd: outcomes.reduce((a, o) => a + o.judgeCostUsd, 0),
    caveats: [
      'Negatives are sampled at RANDOM from the pool, so they are easy. Specificity here is ' +
        'an UPPER BOUND on discriminative power, not an estimate of it — a real screening task ' +
        'presents near-misses that rank highly.',
      'Gold is STRUCTURAL (the document cites the referenced item), not semantic. A positive ' +
        'the judge scores low is ambiguous between judge error and a citation that was never a ' +
        'topical relationship, so sensitivity is a LOWER bound on judge quality.',
      'Both query arms are derived from item titles, not typed by a user. Agreement measured ' +
        'here does not transfer unexamined to real queries.',
      'rawAgreement blends both classes and is dominated by the easy negatives — read ' +
        'sensitivity and specificity separately.',
    ],
  };
}

export function formatReport(report: JudgeAgreementReport): string {
  const pctf = (x: number): string => `${(x * 100).toFixed(1)}%`;
  const lines: string[] = [
    `# P-038 judge-agreement pilot`,
    ``,
    `judge=${report.judgeModel} rubric=${report.rubricVersion} passBar=${report.passBar}`,
    `pairs=${report.outcomes.length} cost=$${report.judgeCostUsd.toFixed(4)}`,
    ``,
  ];
  for (const a of report.byArm) {
    lines.push(
      `## arm: ${a.arm}`,
      `  positives n=${a.positives.n} meanScore=${a.positives.meanScore.toFixed(2)} ` +
        `sensitivity=${pctf(a.positives.sensitivity)}`,
      `  negatives n=${a.negatives.n} meanScore=${a.negatives.meanScore.toFixed(2)} ` +
        `specificity=${pctf(a.negatives.specificity)}  (random negatives — upper bound)`,
      `  separation=${a.separation.toFixed(2)} rawAgreement=${pctf(a.rawAgreement)} (blended — do not quote alone)`,
      ``,
    );
  }
  if (report.selfConsistency) {
    const s = report.selfConsistency;
    lines.push(
      `## self-consistency (re-judged at temp ${s.temperature})`,
      `  n=${s.n} mean|Δ|=${s.meanAbsDelta.toFixed(2)} max|Δ|=${s.maxAbsDelta.toFixed(2)} ` +
        `binaryFlipRate=${pctf(s.flipRate)}`,
      ``,
    );
  } else {
    lines.push(`## self-consistency: NOT MEASURED (disabled)`, ``);
  }
  // The POSITIVE score distribution is the one thing the aggregates cannot
  // stand in for. Sensitivity is a count of pairs over the bar; it cannot say
  // whether the misses landed just under it (a bar-calibration problem) or at
  // the floor (a genuine judge/gold disagreement worth reading individually).
  const positives = report.outcomes.filter((o) => o.goldRelevant && !o.pairId.endsWith('#rejudge'));
  if (positives.length > 0) {
    const hist = new Map<number, number>();
    for (const p of positives) hist.set(p.relevance, (hist.get(p.relevance) ?? 0) + 1);
    lines.push(
      `## positive score distribution (n=${positives.length}, bar=${report.passBar})`,
      '  ' +
        [...hist.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([score, n]) => `${score}:${n}`)
          .join('  '),
      ``,
      `## gold positives the judge scored BELOW the bar`,
      `   (ambiguous by construction — judge error OR a citation that was never topical)`,
    );
    const misses = positives
      .filter((p) => !p.judgedRelevant)
      .sort((a, b) => a.relevance - b.relevance);
    if (misses.length === 0) lines.push(`   (none)`);
    for (const m of misses) {
      lines.push(
        `  - ${m.pairId} score=${m.relevance} doc=${m.docId}`,
        `    query: ${m.query.slice(0, 160)}`,
        `    judge: ${(m.judgeNotes ?? '(no notes)').slice(0, 400)}`,
      );
    }
    lines.push(``);
  }

  lines.push(`## limits (these travel with the numbers)`);
  for (const c of report.caveats) lines.push(`  - ${c}`);
  return lines.join('\n');
}
