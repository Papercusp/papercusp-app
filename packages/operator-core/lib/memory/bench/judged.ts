/**
 * T3 — the judged-usefulness tier (memory-backend-benchmark-2026-06-05
 * P-008, D-005/D-010).
 *
 * The deterministic tiers (T1/T2) score retrieval by rank against the
 * frozen gold set; this tier asks the question rank metrics can't:
 * **"was the TOP result actually USEFUL for this intent?"** — judged by
 * a frozen LLM judge over a stratified ~25-query sample of the gold
 * set, per backend, riding the llm-testing framework's `judgeRun()`
 * directly (in-process — no sim-user, no chat loop; D-010).
 *
 * Frozen for run-over-run comparability (D-005 + Risks §judge-variance):
 *   - the judge model (`JUDGED_TIER_JUDGE_MODEL`),
 *   - the rubric (`MEMORY_USEFULNESS_RUBRIC`, versioned),
 *   - the sample (deterministic stratified pick by query id).
 * Judge agreement is reported via a double-scored sub-sample (the
 * second pass at temperature 0.4, mirroring the judge's own
 * second-opinion convention).
 *
 * Hard negatives are EXCLUDED from the sample: "usefulness of the top
 * result" is ill-posed when the correct top result is *nothing* — the
 * deterministic tier's false-positive-rate metric already scores that
 * class (noted in the report, not silently dropped).
 *
 * Isolation: same `makeBackendCtx` contexts as the deterministic
 * runner (mem0 → `bench_memory` schema; claude-file → temp dir; D-009).
 */

import path from 'node:path';
import fs from 'node:fs';

import {
  deriveRubricVersion,
  judgeRun,
  JUDGE_PROMPT_SCAFFOLD_VERSION,
  type JudgeRubric,
  type LlmCallFn,
  type PersonaTraits,
  type RunSummary,
} from '@papercusp/testing-shell/llm';
import { seedCorpus, GOLD_QUERY_CLASSES, type GoldQuery, type GoldQueryClass } from '@papercusp/memory/bench';
import type { MemoryBackend, MemoryEntry } from '@papercusp/memory';

import { loadCorpusFixture } from './corpus';
import { loadGoldSetFixture } from './gold-set';
import { BENCH_SCOPE, makeBackendCtx, type BackendCtx, type BenchBackendName } from './run-bench';

// =============================================================================
// Frozen judging contract (D-005)
// =============================================================================

export const MEMORY_USEFULNESS_RUBRIC_CONTENT: Pick<JudgeRubric, 'axes'> = {
  axes: [
    {
      id: 'usefulness',
      description:
        'Was the TOP memory-search result actually useful for the stated query intent — ' +
        'would an agent acting on that intent be concretely helped by seeing this memory? ' +
        'Judge the result on its own merits: relevance to the intent, specificity, and ' +
        'whether it carries the fact the intent needs. "(no result)" is useful for nothing.',
      anchors: {
        bad: 'Top result is missing, irrelevant, or misleading for the intent.',
        ideal: 'Top result directly carries the specific fact/procedure the intent needs.',
      },
    },
  ],
};

/**
 * Every caller-authored value that reaches the shared judge prompt. Per-query
 * text is represented by placeholders and remains in the run identity; the
 * framing, transcript/telemetry constants, and scenario identity are stable
 * judging inputs and therefore belong in the derived version.
 */
export const JUDGED_INSTRUCTION_CONTRACT = {
  scenarioId: 'memory-judged',
  scenarioTemplate:
    'Memory-retrieval usefulness check (class: {class}). An agent queried its memory ' +
    'store with the intent "{query}". The assistant turn shows the TOP search result ' +
    'the backend returned (verbatim). Score ONLY whether that result is useful for the intent.',
  personaSummary: 'n/a — non-interactive retrieval bench (no sim-user)',
  goalSummary: 'Top-1 retrieval usefulness for the stated intent.',
  transcriptTemplate: 'Top memory result for the intent "{query}":\n\n{topResult}',
  turnFinishReason: 'done' as const,
  turnLatencyMs: 0,
  turnCostUsd: 0,
};

export function deriveJudgedTierRubricVersion(scaffoldVersion: string): string {
  return deriveRubricVersion('memory-usefulness', {
    rubric: MEMORY_USEFULNESS_RUBRIC_CONTENT,
    instructions: JUDGED_INSTRUCTION_CONTRACT,
    scaffold: scaffoldVersion,
  });
}

/** Derived from every content layer that contributes to the judge prompt. */
export const JUDGED_TIER_RUBRIC_VERSION = deriveJudgedTierRubricVersion(JUDGE_PROMPT_SCAFFOLD_VERSION);

/** Frozen judge model — changing it is a contract edit and must be versioned by the derived hash. */
export const JUDGED_TIER_JUDGE_MODEL = 'claude-sonnet-4-6';

export const MEMORY_USEFULNESS_RUBRIC: JudgeRubric = {
  version: JUDGED_TIER_RUBRIC_VERSION,
  ...MEMORY_USEFULNESS_RUBRIC_CONTENT,
};

/** Positive classes judged; hard negatives are scored by the deterministic tier. */
export const JUDGED_CLASSES: readonly GoldQueryClass[] = GOLD_QUERY_CLASSES.filter(
  (c) => c !== 'hard-negative',
);

/** usefulness >= this counts as "useful" in the rate aggregate. */
export const USEFULNESS_PASS_BAR = 3;

// =============================================================================
// Shapes
// =============================================================================

export interface JudgedQueryOutcome {
  queryId: string;
  class: GoldQueryClass;
  query: string;
  /** corpus_key of the top hit (null when the backend returned nothing). */
  topResultKey: string | null;
  /** Whether the top hit was one of the gold set's expected keys. */
  topResultExpected: boolean;
  /** Judge score on the usefulness axis, 0..5. */
  usefulness: number;
  searchLatencyMs: number;
  judgeCostUsd: number;
  judgeNotes?: string;
}

export interface JudgedClassAggregate {
  n: number;
  meanUsefulness: number;
  usefulRate: number;
}

export interface JudgedBackendCard {
  backend: string;
  outcomes: JudgedQueryOutcome[];
  meanUsefulness: number;
  usefulRate: number;
  byClass: Partial<Record<GoldQueryClass, JudgedClassAggregate>>;
  judgeCostUsd: number;
}

export interface JudgedTierReport {
  startedAt: string;
  finishedAt: string;
  judgeModel: string;
  rubricVersion: string;
  corpusVersion: string;
  goldVersion: string;
  sampleSize: number;
  sampledQueryIds: string[];
  excludedClasses: string[];
  cards: JudgedBackendCard[];
  /** Judge-agreement probe: the double-scored sub-sample (Risks §judge-variance). */
  doubleScore: { n: number; meanAbsDelta: number; maxAbsDelta: number } | null;
  notes: string[];
  markdown: string;
}

// =============================================================================
// Pure parts (unit-tested without an LLM)
// =============================================================================

/**
 * Deterministic stratified sample: per judged class, sort by query id
 * and take the first `perClass`. Same fixture version → same sample,
 * every run.
 */
export function sampleGoldForJudging(
  queries: readonly GoldQuery[],
  perClass = 8,
  classes: readonly GoldQueryClass[] = JUDGED_CLASSES,
): GoldQuery[] {
  const out: GoldQuery[] = [];
  for (const cls of classes) {
    const pool = queries
      .filter((q) => q.class === cls)
      .sort((a, b) => a.id.localeCompare(b.id));
    out.push(...pool.slice(0, perClass));
  }
  return out;
}

/** Render the top hit the way the judge sees it. */
export function renderTopHit(query: GoldQuery, hit: MemoryEntry | null): string {
  return fillTemplate(JUDGED_INSTRUCTION_CONTRACT.transcriptTemplate, {
    query: query.query,
    topResult: hit ? hit.text : '(no result — the store returned nothing)',
  });
}

/** Substitute per-row values into a hashed contract template without a second copy. */
function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(query|class|topResult)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key]! : whole,
  );
}

const BENCH_PERSONA_TRAITS: PersonaTraits = {
  verbosity: 'terse',
  politeness: 'neutral',
  clarification: 'never_clarifies',
  goalClarity: 'precise',
  interrupts: false,
  modality: 'text',
};

/** Synthesize the minimal one-turn RunSummary `judgeRun` consumes. */
export function synthesizeRun(
  query: GoldQuery,
  assistantText: string,
  latencyMs: number,
  judgeModel: string,
): RunSummary {
  // Search latency is reported in JudgedQueryOutcome, but it is not a stable
  // judging instruction. Keep the prompt telemetry bound to the contract.
  void latencyMs;
  const now = new Date();
  return {
    runId: `t3-${query.id}`,
    scenarioId: JUDGED_INSTRUCTION_CONTRACT.scenarioId,
    scenarioVersion: 1,
    scenarioTarget: 'memory-bench',
    identityHash: `t3:${JUDGED_TIER_RUBRIC_VERSION}:${query.id}`,
    sutModel: 'memory-backend (non-LLM retrieval)',
    judgeModel,
    personaId: 'memory-bench',
    personaTraits: BENCH_PERSONA_TRAITS,
    workspaceMode: 'isolated',
    transportMode: 'in-process',
    turns: [
      {
        assistantText,
        toolCalls: [],
        toolResults: [],
        cards: [],
        controlTags: [],
        costUsd: JUDGED_INSTRUCTION_CONTRACT.turnCostUsd,
        latencyMs: JUDGED_INSTRUCTION_CONTRACT.turnLatencyMs,
        finishReason: JUDGED_INSTRUCTION_CONTRACT.turnFinishReason,
        rawSseTape: [],
      },
    ],
    toolInvocations: [],
    continueChainRows: [],
    totalCostUsd: JUDGED_INSTRUCTION_CONTRACT.turnCostUsd,
    startedAt: now,
    finishedAt: now,
    finishReason: 'completed',
    capBreaches: [],
  };
}

export function aggregateOutcomes(outcomes: readonly JudgedQueryOutcome[]): {
  meanUsefulness: number;
  usefulRate: number;
  byClass: Partial<Record<GoldQueryClass, JudgedClassAggregate>>;
} {
  const mean = (vals: number[]): number =>
    vals.length === 0 ? 0 : vals.reduce((a, b) => a + b, 0) / vals.length;
  const byClass: Partial<Record<GoldQueryClass, JudgedClassAggregate>> = {};
  for (const cls of new Set(outcomes.map((o) => o.class))) {
    const rows = outcomes.filter((o) => o.class === cls);
    byClass[cls] = {
      n: rows.length,
      meanUsefulness: mean(rows.map((r) => r.usefulness)),
      usefulRate: rows.filter((r) => r.usefulness >= USEFULNESS_PASS_BAR).length / rows.length,
    };
  }
  return {
    meanUsefulness: mean(outcomes.map((o) => o.usefulness)),
    usefulRate:
      outcomes.length === 0
        ? 0
        : outcomes.filter((o) => o.usefulness >= USEFULNESS_PASS_BAR).length / outcomes.length,
    byClass,
  };
}

export function renderJudgedMarkdown(report: Omit<JudgedTierReport, 'markdown'>): string {
  const lines: string[] = [];
  lines.push(`# Memory bench — T3 judged-usefulness tier`);
  lines.push('');
  lines.push(
    `judge: \`${report.judgeModel}\` · rubric: \`${report.rubricVersion}\` · sample: ${report.sampleSize} queries ` +
      `(corpus ${report.corpusVersion}, gold ${report.goldVersion}; excluded: ${report.excludedClasses.join(', ') || 'none'})`,
  );
  lines.push('');
  lines.push('| backend | mean usefulness (0–5) | useful rate (≥3) | ' +
    JUDGED_CLASSES.map((c) => `${c} mean`).join(' | ') + ' | judge cost |');
  lines.push('|---|---|---|' + JUDGED_CLASSES.map(() => '---').join('|') + '|---|');
  for (const card of report.cards) {
    lines.push(
      `| ${card.backend} | ${card.meanUsefulness.toFixed(2)} | ${(card.usefulRate * 100).toFixed(0)}% | ` +
        JUDGED_CLASSES.map((c) => card.byClass[c] ? card.byClass[c]!.meanUsefulness.toFixed(2) : '—').join(' | ') +
        ` | $${card.judgeCostUsd.toFixed(3)} |`,
    );
  }
  if (report.doubleScore) {
    lines.push('');
    lines.push(
      `judge agreement (double-scored n=${report.doubleScore.n}): mean |Δ| ${report.doubleScore.meanAbsDelta.toFixed(2)}, ` +
        `max |Δ| ${report.doubleScore.maxAbsDelta.toFixed(2)} on the 0–5 usefulness axis`,
    );
  }
  for (const n of report.notes) lines.push(`\nnote: ${n}`);
  return lines.join('\n');
}

// =============================================================================
// The live tier
// =============================================================================

export interface JudgedTierOptions {
  backends?: BenchBackendName[];
  perClass?: number;
  corpusVersion?: string;
  goldVersion?: string;
  judgeModel?: string;
  /** Injected LLM transport (tests pass a fake; the CLI passes llm-client's). */
  llm: LlmCallFn;
  /** Injected context factory (tests pass an in-memory backend). */
  makeCtx?: (name: BenchBackendName, keep: boolean) => Promise<BackendCtx>;
  /** Re-judge the first N outcomes of the FIRST backend at temp 0.4. Default 5; 0 disables. */
  doubleScoreN?: number;
  seedConcurrency?: number;
  keep?: boolean;
  log?: (msg: string) => void;
}

async function judgeOne(
  backend: MemoryBackend,
  q: GoldQuery,
  judgeModel: string,
  llm: LlmCallFn,
  temperature?: number,
): Promise<JudgedQueryOutcome> {
  const t0 = Date.now();
  const hits = await backend.search(q.query, { scope: BENCH_SCOPE, limit: 1 });
  const searchLatencyMs = Date.now() - t0;
  const top = hits[0] ?? null;
  const topKey = typeof top?.metadata?.corpus_key === 'string' ? (top.metadata.corpus_key as string) : null;

  const run = synthesizeRun(q, renderTopHit(q, top), searchLatencyMs, judgeModel);
  const judge = await judgeRun(
    {
      model: judgeModel,
      rubric: MEMORY_USEFULNESS_RUBRIC,
      scenarioId: run.scenarioId,
      scenarioDescription: fillTemplate(JUDGED_INSTRUCTION_CONTRACT.scenarioTemplate, {
        class: q.class,
        query: q.query,
      }),
      personaSummary: JUDGED_INSTRUCTION_CONTRACT.personaSummary,
      goalSummary: JUDGED_INSTRUCTION_CONTRACT.goalSummary,
      ...(temperature !== undefined ? { temperature } : {}),
    },
    run,
    [],
    llm,
  );

  return {
    queryId: q.id,
    class: q.class,
    query: q.query,
    topResultKey: topKey,
    topResultExpected: topKey !== null && q.expected.includes(topKey),
    usefulness: judge.scores.usefulness ?? 0,
    searchLatencyMs,
    judgeCostUsd: judge.costUsd,
    ...(judge.notes ? { judgeNotes: judge.notes } : {}),
  };
}

export async function runJudgedTier(opts: JudgedTierOptions): Promise<JudgedTierReport> {
  const startedAt = new Date().toISOString();
  const log = opts.log ?? (() => {});
  const corpusVersion = opts.corpusVersion ?? 'v1';
  const goldVersion = opts.goldVersion ?? 'v1';
  const judgeModel = opts.judgeModel ?? JUDGED_TIER_JUDGE_MODEL;
  const makeCtx = opts.makeCtx ?? makeBackendCtx;
  const backends = opts.backends ?? (['mem0', 'claude-file', 'hybrid', 'hybrid-pg', 'noop'] as BenchBackendName[]);
  const doubleScoreN = opts.doubleScoreN ?? 5;

  const corpus = loadCorpusFixture(corpusVersion);
  const gold = loadGoldSetFixture(goldVersion);
  const sample = sampleGoldForJudging(gold.queries, opts.perClass ?? 8);
  const notes: string[] = [
    `hard-negative class excluded from judging (ill-posed for "top-result usefulness"); ` +
      `the deterministic tier's false-positive rate covers it.`,
  ];

  const cards: JudgedBackendCard[] = [];
  let doubleScore: JudgedTierReport['doubleScore'] = null;

  for (const name of backends) {
    log(`[${name}] seeding ${corpus.length} entries…`);
    const ctx = await makeCtx(name, opts.keep ?? false);
    try {
      const manifest = await seedCorpus(ctx.backend, corpus, {
        scope: BENCH_SCOPE,
        verbatim: true,
        concurrency: opts.seedConcurrency ?? 8,
      });
      if (manifest.failed.length > 0) {
        notes.push(`[${name}] seed failures: ${manifest.failed.length}/${corpus.length}`);
      }

      log(`[${name}] judging ${sample.length} sampled queries…`);
      const outcomes: JudgedQueryOutcome[] = [];
      for (const q of sample) {
        outcomes.push(await judgeOne(ctx.backend, q, judgeModel, opts.llm));
      }

      // Judge-agreement probe on the first backend only (cost control).
      if (doubleScore === null && doubleScoreN > 0 && name !== 'noop') {
        const probeRows = outcomes.slice(0, doubleScoreN);
        log(`[${name}] double-scoring ${probeRows.length} queries for judge agreement…`);
        const deltas: number[] = [];
        for (const row of probeRows) {
          const q = sample.find((s) => s.id === row.queryId)!;
          const second = await judgeOne(ctx.backend, q, judgeModel, opts.llm, 0.4);
          deltas.push(Math.abs(second.usefulness - row.usefulness));
        }
        if (deltas.length > 0) {
          doubleScore = {
            n: deltas.length,
            meanAbsDelta: deltas.reduce((a, b) => a + b, 0) / deltas.length,
            maxAbsDelta: Math.max(...deltas),
          };
        }
      }

      const agg = aggregateOutcomes(outcomes);
      cards.push({
        backend: ctx.backend.name,
        outcomes,
        ...agg,
        judgeCostUsd: outcomes.reduce((a, o) => a + o.judgeCostUsd, 0),
      });
    } finally {
      log(`[${name}] cleanup…`);
      // Non-fatal: a cleanup failure (e.g. a 55P03 lock timeout on the schema
      // drop) must never destroy the judged outcomes — a full 18-query run's
      // report was once lost to exactly that.
      try {
        await ctx.cleanup();
      } catch (e) {
        const msg = (e as Error).message.slice(0, 120);
        notes.push(`[${name}] cleanup failed (non-fatal): ${msg}`);
        log(`[${name}] cleanup FAILED (non-fatal): ${msg}`);
      }
    }
  }

  const base: Omit<JudgedTierReport, 'markdown'> = {
    startedAt,
    finishedAt: new Date().toISOString(),
    judgeModel,
    rubricVersion: JUDGED_TIER_RUBRIC_VERSION,
    corpusVersion,
    goldVersion,
    sampleSize: sample.length,
    sampledQueryIds: sample.map((q) => q.id),
    excludedClasses: ['hard-negative'],
    cards,
    doubleScore,
    notes,
  };
  return { ...base, markdown: renderJudgedMarkdown(base) };
}

/** Persist under .papercusp/bench-reports/ alongside the T1/T2 artifacts. */
export function writeJudgedReport(report: JudgedTierReport, repoRoot: string): { json: string; md: string } {
  const dir = path.join(repoRoot, '.papercusp', 'bench-reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = report.startedAt.replace(/[:.]/g, '-');
  const json = path.join(dir, `memory-judged-${stamp}.json`);
  const md = path.join(dir, `memory-judged-${stamp}.md`);
  fs.writeFileSync(json, JSON.stringify(report, null, 2));
  fs.writeFileSync(md, report.markdown);
  return { json, md };
}
