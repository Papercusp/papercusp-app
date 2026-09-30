/**
 * P-045 acceptance arms — the two per-leg query splits P-044 landed, built as
 * PAIRED gold-set variants so each can be measured on its own
 * (context-injection-audit-2026-07-28 P-045, ruled by D-049).
 *
 * D-049 binds this item to measuring the two halves INDEPENDENTLY:
 *
 *   ARM A — cosine DE-DILUTION (`mid-turn-context.splitLegQueries`). The agent's
 *           path tokens leave the COSINE query and stay on the lexical one.
 *   ARM B — lexical SIGNAL INJECTION (`recall-query.lexicalQueryText`). The
 *           agent's identifiers are ADDED to the LEXICAL query; the cosine query
 *           is untouched.
 *
 * They act on different legs and D-049's constraint 2 predicts they move
 * different things, so a blended number would hide both.
 *
 * ⚠ EVERY ARM IS BUILT BY THE PRODUCTION FUNCTION IT MEASURES — `deriveQuery` /
 * `deriveBatchQuery` / `splitLegQueries` / `lexicalQueryText` / `extractTrajectory`
 * are imported, never re-implemented. A hand-rolled restatement of the transform
 * would measure the restatement: it can stay green while the shipped composer
 * changes underneath, which is the exact half-guard P-046 was raised to close.
 * What is synthesized here is only the STIMULUS (which paths an agent touched),
 * never the transform.
 *
 * ⚠ WHAT ARM B CAN AND CANNOT SHOW, stated here because the optimistic reading
 * is wrong and cheap to reach for. The push path is `cosine-gated`, so the
 * lexical leg RE-RANKS the cosine candidate set and cannot admit a row the
 * cosine leg missed (D-049 constraint 2). A flat arm-B delta on that mode is
 * therefore the PREDICTED result for any query whose target cosine never
 * admitted — it is not evidence that identifier routing does nothing. Run the
 * same arm under `floored-union` to separate "the signal is worthless" from
 * "admission is closed"; that second number is diagnostic only and decides
 * nothing on its own (flipping the push path re-opens D-010).
 */
import { lexicalTokens } from '@papercusp/memory';
import type { CorpusEntry, GoldQuery } from '@papercusp/memory/bench';

import {
  deriveBatchQuery,
  splitLegQueries,
  type BatchCall,
} from '../../endpoint-route/routes/agent-mcp/mid-turn-context';
import { extractTrajectory } from '../agent-signals';
import { lexicalQueryText, type AgentSignals } from '../recall-query';

/** A paired arm: same query ids, one transform apart. */
export interface Arm {
  label: string;
  queries: GoldQuery[];
}

/** A baseline/candidate pair, ready for `runGoldSet` + `compareLegs`. */
export interface ArmPair {
  baseline: Arm;
  candidate: Arm;
}

/* ────────────────────────── ARM A — cosine de-dilution ───────────────────── */

/**
 * Repo paths used as the agent's trajectory NOISE.
 *
 * These stand in for "the files this agent happened to be touching", which is
 * what a mid-turn batch actually carries. They are deliberately REAL repo paths
 * and deliberately UNRELATED to the corpus: D-041's measured case is an agent
 * reading `apps/operator-vite/src` while asking about something else entirely,
 * and the whole question is what those tokens do to the embedded query.
 *
 * The directory entries are not filler — D-041's batch one carried
 * `apps/operator-vite/src` TWICE, and a bare directory is a different shape for
 * `COSINE_PATH_TOKEN_RE` (≥2 slashes, no extension) than a file path is.
 */
export const DEFAULT_NOISE_PATHS: readonly string[] = [
  'apps/operator-vite/src/components/AgentsRunningPill.tsx',
  'apps/operator-vite/src',
  'packages/operator-core/lib/endpoint-route/routes/agent-mcp/mid-turn-context.ts',
  'apps/operator/app/harness/dock/DockEngine.tsx',
  'libs/papercusp/packages/harness/src/spawn.ts',
  'packages/operator-core/lib/sync-resolver/index.ts',
  'apps/operator-vite/src/routes/adv.tsx',
  'libs/generic/memory/src/hybrid-fusion.ts',
];

export interface DilutionArmOptions {
  /** Path tokens per query — the DOSE. 0 must produce two identical arms. */
  dose: number;
  /** Noise pool (default `DEFAULT_NOISE_PATHS`). */
  noisePaths?: readonly string[];
}

/**
 * Simulate the tool batch a mid-turn hook would ship for `query`.
 *
 * The agent is searching for the user's words (a `Grep` pattern — prose) while
 * reading files (paths). `deriveBatchQuery` reverses the array, so the LAST
 * call is the freshest and leads the derived text; the search goes last so the
 * prose leads, which is the ordering D-041 observed.
 */
function batchFor(query: string, paths: readonly string[]): BatchCall[] {
  const reads: BatchCall[] = paths.map((p) => ({
    tool: 'Read',
    toolInput: { file_path: p },
    toolResponse: 'ok',
  }));
  return [...reads, { tool: 'Grep', toolInput: { pattern: query }, toolResponse: '' }];
}

/**
 * Deterministic noise slice for query `i` — rotates through the pool so the
 * dilution is not one fixed pair of paths repeated 150 times, and is stable
 * across runs so the two arms see byte-identical noise.
 */
function noiseFor(pool: readonly string[], i: number, dose: number): string[] {
  const out: string[] = [];
  for (let k = 0; k < dose && pool.length > 0; k++) out.push(pool[(i + k) % pool.length]);
  return out;
}

/**
 * ARM A. Baseline = today's pre-P-044 behaviour (the diluted derived text goes
 * to BOTH legs). Candidate = `splitLegQueries` (paths leave the cosine query,
 * lexical keeps the full text).
 *
 * At `dose: 0` the two arms differ ONLY by `splitLegQueries`' dose-independent
 * residue sweep (WI-6857 — the `(no result)` marker leaves the cosine leg; this
 * fixture's Grep returns '', so every derived text carries one). That is the
 * built-in null control: a dose-0 delta BEYOND the sweep means the harness is
 * wrong and nothing else in the report can be trusted.
 */
export function buildDilutionArm(
  gold: readonly GoldQuery[],
  opts: DilutionArmOptions,
): ArmPair {
  const pool = opts.noisePaths ?? DEFAULT_NOISE_PATHS;
  const baseline: GoldQuery[] = [];
  const candidate: GoldQuery[] = [];

  gold.forEach((q, i) => {
    const derived = deriveBatchQuery(batchFor(q.query, noiseFor(pool, i, opts.dose)));
    const split = splitLegQueries(derived);
    baseline.push({ ...q, query: derived });
    candidate.push({ ...q, query: split.cosine, lexicalQuery: split.lexical });
  });

  return {
    baseline: { label: `diluted(dose=${opts.dose})`, queries: baseline },
    candidate: { label: `split(dose=${opts.dose})`, queries: candidate },
  };
}

/**
 * The UNDILUTED reference — the gold query as written, no agent trajectory at
 * all. Not an arm: it is the ceiling the de-dilution is trying to recover, and
 * without it "candidate beats baseline" cannot distinguish a full repair from a
 * marginal one.
 */
export function cleanArm(gold: readonly GoldQuery[]): Arm {
  return { label: 'clean(no trajectory)', queries: gold.map((q) => ({ ...q })) };
}

/* ────────────────────── ARM B — lexical signal injection ─────────────────── */

/** PascalCase / camelCase tokens — what an agent actually greps for. */
const SYMBOLISH_RE = /\b(?:[a-z]+[A-Z]|[A-Z][a-z]+[A-Z])[A-Za-z0-9_$]*\b/g;

/**
 * Build `AgentSignals` as if the agent had been working on `source`.
 *
 * Faithful by construction: the identifiers are harvested from the source text
 * by the PRODUCTION extractor (`extractTrajectory`) through the same argument
 * shapes real tools use — a `Bash.command` is token-scanned for paths and ids,
 * a `Grep.pattern` is the allowlisted symbol slot. Nothing here reproduces the
 * harvesting regexes.
 *
 * `workItem` is deliberately left unset: its TITLE and BODY are prose and are
 * excluded from the lexical query on mechanical grounds (D-049), and inventing
 * an id would inject a token that appears nowhere in the corpus.
 */
export function signalsFromEntry(source: CorpusEntry): AgentSignals | undefined {
  const symbols = [...new Set(source.text.match(SYMBOLISH_RE) ?? [])].slice(0, 4);
  const invocations = [
    // Newest first, as `extractTrajectory` requires.
    ...symbols.map((s) => ({ toolName: 'Grep', args: { pattern: s } })),
    { toolName: 'Bash', args: { command: source.text } },
  ];
  const { trajectory, activeFile } = extractTrajectory(invocations);
  if (!trajectory && !activeFile) return undefined;
  return { ...(trajectory ? { trajectory } : {}), ...(activeFile ? { activeFile } : {}) };
}

export type InjectionMode =
  /** The agent's trajectory names the very memory the query is looking for. */
  | 'ontask'
  /** The agent is working on something else entirely — the cost side. */
  | 'offtask';

export interface InjectionArmOptions {
  mode: InjectionMode;
  /** Corpus, keyed as the gold set's `expected` refers to it. */
  corpus: ReadonlyMap<string, CorpusEntry>;
  /** Stable ordering used to pick the off-task source. */
  corpusKeys: readonly string[];
}

/**
 * ARM B. Baseline = one query to both legs (pre-P-044). Candidate = the SAME
 * cosine query — P-044 deliberately keeps signals out of it — plus the composed
 * lexical query.
 *
 * A query whose signals resolve to nothing carries no `lexicalQuery`, so it
 * contributes an exact tie to the paired comparison rather than dropping out:
 * "the composer had nothing to add" is a real outcome of the shipped code and
 * excluding it would inflate the effect.
 *
 * ⚠ THE TWO MODES ARE BOUNDS, NOT AN AVERAGE. `ontask` is the optimistic
 * bound (the agent is touching exactly what the user is asking about) and
 * `offtask` the pessimistic one (unrelated work). Production sits somewhere
 * between, at a mixture this bench cannot observe — so report both and never
 * quote either as "the" uplift.
 */
export function buildInjectionArm(
  gold: readonly GoldQuery[],
  opts: InjectionArmOptions,
): ArmPair {
  const baseline: GoldQuery[] = [];
  const candidate: GoldQuery[] = [];

  gold.forEach((q, i) => {
    const expected = new Set(q.expected);
    // Hard negatives have no target, so `ontask` is undefined for them — they
    // take the off-task source in both modes. Dropping them instead would
    // remove the only class that can show injection ADMITTING noise.
    const wantOnTask = opts.mode === 'ontask' && q.expected.length > 0;
    let source: CorpusEntry | undefined;
    if (wantOnTask) {
      source = opts.corpus.get(q.expected[0]);
    } else {
      // Deterministic, and never a key this query expects.
      for (let k = 0; k < opts.corpusKeys.length; k++) {
        const key = opts.corpusKeys[(i * 7 + k) % opts.corpusKeys.length];
        if (!expected.has(key)) {
          source = opts.corpus.get(key);
          break;
        }
      }
    }
    const signals = source ? signalsFromEntry(source) : undefined;
    const lexical = lexicalQueryText({ userText: q.query, ...(signals ? { agentSignals: signals } : {}) });

    baseline.push({ ...q });
    candidate.push({ ...q, ...(lexical ? { lexicalQuery: lexical } : {}) });
  });

  return {
    baseline: { label: 'user-text-only', queries: baseline },
    candidate: { label: `+signals(${opts.mode})`, queries: candidate },
  };
}

/** How many candidate queries actually received a composed lexical query. */
export function injectionCoverage(pair: ArmPair): { withSignals: number; total: number } {
  return {
    withSignals: pair.candidate.queries.filter((q) => q.lexicalQuery !== undefined).length,
    total: pair.candidate.queries.length,
  };
}

export interface TermSurvival {
  /** Candidate queries that carry a composed lexical query. */
  withSignals: number;
  /** Of those, how many had EVERY appended term survive the tokenizer's cap. */
  fullySurvived: number;
  /** Of those, how many had NO appended term survive at all. */
  fullyDropped: number;
  /** Mean fraction of appended terms that survived. */
  meanSurvivingFraction: number;
  /** Queries whose USER TEXT alone already fills the 32-token cap. */
  userTextAtCap: number;
  /** Largest tokenized lexical query seen — the headroom against the cap. */
  maxTokens: number;
  /** Median tokenized lexical query length. */
  medianTokens: number;
}

/**
 * How much of the injected signal actually reaches the scorer.
 *
 * ⚠ THIS IS NOT BOOKKEEPING — it is the one place the composer's caps can fail
 * silently. `lexicalQueryText` appends the agent's terms AFTER the user text,
 * and `lexicalTokens` keeps the HEAD of the token list, so a long user utterance
 * evicts the identifiers from the tail — the very tokens the split exists to
 * add, dropped first, with no error and no change to any rank metric's shape.
 * `recall-query`'s own caps (4/4/2) bound how many terms are OFFERED; only this
 * measures how many are HEARD.
 *
 * Uses the real `lexicalTokens`, not a restatement of it.
 */
export function lexicalTermSurvival(pair: ArmPair): TermSurvival {
  let withSignals = 0;
  let fullySurvived = 0;
  let fullyDropped = 0;
  let userTextAtCap = 0;
  let fractionSum = 0;
  const tokenCounts: number[] = [];

  pair.candidate.queries.forEach((q, i) => {
    const lex = q.lexicalQuery;
    if (!lex) return;
    const userText = pair.baseline.queries[i].query;
    const appended = lex.startsWith(userText) ? lex.slice(userText.length).trim() : lex;
    const terms = appended.split(/\s+/).filter(Boolean);
    if (terms.length === 0) return;
    withSignals += 1;

    const keptTokens = lexicalTokens(lex);
    tokenCounts.push(keptTokens.length);
    const kept = new Set(keptTokens);
    // A term counts as heard if ANY token it contributes survived the cap —
    // the scorer matches on tokens, so one surviving whole token still scores.
    const survived = terms.filter((t) => lexicalTokens(t).some((tok) => kept.has(tok))).length;
    fractionSum += survived / terms.length;
    if (survived === terms.length) fullySurvived += 1;
    if (survived === 0) fullyDropped += 1;
    if (lexicalTokens(userText).length >= LEXICAL_TOKEN_CAP) userTextAtCap += 1;
  });

  const sorted = [...tokenCounts].sort((a, b) => a - b);
  return {
    withSignals,
    fullySurvived,
    fullyDropped,
    meanSurvivingFraction: withSignals === 0 ? 0 : fractionSum / withSignals,
    userTextAtCap,
    maxTokens: sorted.length ? sorted[sorted.length - 1] : 0,
    medianTokens: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
  };
}

/**
 * `canonical-store`'s LEXICAL_MAX_TOKENS. Not importable (it is a private
 * constant there) and deliberately NOT re-derived — this is only used to
 * report "the user text alone already fills the cap", and `lexicalTokens`
 * itself enforces the real value, so a drift here mis-labels one diagnostic
 * counter and cannot change a measurement.
 */
const LEXICAL_TOKEN_CAP = 32;
