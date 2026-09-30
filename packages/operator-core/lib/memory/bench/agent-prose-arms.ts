/**
 * P-047 arms — does the agent's own PROSE earn a place in the recall query?
 * (context-injection-audit-2026-07-28 P-047 / F-M, bounded by D-052.)
 *
 * ⚠ READ D-052 BEFORE REPORTING ANYTHING BUILT HERE. P-047 has two halves and
 * this file measures ONE of them:
 *
 *   HALF 1 (measurable here)  Does prose ADD retrieval quality?
 *   HALF 2 (NOT measurable here) Does prose create the self-confirmation loop
 *                             P-043 excluded it for — assert X → retrieve X →
 *                             assert more X? A static gold set over a frozen
 *                             corpus has NO feedback path, so it can only ever
 *                             observe the CHANNEL, never the LOOP. A green
 *                             result below therefore CANNOT close P-047.
 *
 * ## Why these arms differ in shape from `leg-split-arms.ts`
 *
 * Every ARM in that file is built by the production composer it measures
 * (`splitLegQueries`, `lexicalQueryText`). Here there is deliberately NO such
 * composer: P-043 excluded prose from `AgentSignals` on purpose, and P-047 is
 * the item that decides whether one should exist. So this file SYNTHESIZES the
 * composition it measures, and that is stated rather than hidden. The
 * composition chosen is the minimal one — append the prose to the user text,
 * the same `${user} ${extra}` shape `lexicalQueryText` already uses — because a
 * cleverer composer would confound "prose helps" with "my composer is clever".
 *
 * ## Both arms are BOUNDS. Neither is an uplift estimate.
 *
 * Same discipline D-051 fixed for ARM B, and it matters more here because the
 * on-task construction is closer to pasting the answer into the question:
 *
 *   ON-TASK (optimistic / ORACLE)   The simulated agent's narration is a gloss
 *     of the very memory the query is looking for. Its job is to prove the
 *     CHANNEL IS OPEN — a flat result here settles P-047 negatively on its own,
 *     because if an oracle-grade prose signal cannot move retrieval then no
 *     realistic one will. It is NOT evidence of production uplift.
 *   OFF-TASK (pessimistic)   The agent is narrating unrelated work, which is
 *     the D-041 dilution mechanism verbatim. No leakage, so this half IS a
 *     real measurement — of the COST.
 *
 * Production sits between, at a mixture this bench cannot observe. Never quote
 * either number as "the" effect of prose.
 *
 * ## The leg matters, so it is a variable rather than an assumption
 *
 * P-044 routed identifiers to the LEXICAL leg because that is the leg that wins
 * on identifiers. Prose is the opposite kind of text, so the COSINE leg is
 * where it could plausibly help — and the lexical leg is where it is predicted
 * to be actively harmful by mechanism, not by measurement: `lexicalSearch`
 * scores `Σ(field weight) / (tokens × 3)`, so every prose token lowers every
 * real hit's normalized score, and `lexicalTokens` caps at 32 keeping the HEAD,
 * so appended prose is discarded after the cap anyway. Both legs are run so the
 * routing question is settled by evidence instead of by that argument alone.
 */
import type { CorpusEntry, GoldQuery } from '@papercusp/memory/bench';

import type { Arm, ArmPair } from './leg-split-arms';

/** Which leg receives the prose. */
export type ProseLeg =
  /** Prose joins the embedded query; the lexical leg keeps the user text. */
  | 'cosine'
  /** Prose joins the token-scored query; the embedded query keeps user text. */
  | 'lexical'
  /** Prose goes to BOTH — the shape a naive implementation would take. */
  | 'both';

export type ProseMode =
  /** Narration glossing the very memory sought. ORACLE — an upper bound. */
  | 'ontask'
  /** Narration of unrelated work — the cost side, and leakage-free. */
  | 'offtask';

/**
 * The production turn-start query clamp (`turn-start-memory.ts`, module-private
 * so not importable). Restated ONLY to keep the dose sweep below it, so the
 * sweep measures prose LENGTH rather than truncation; nothing here re-derives
 * the clamp's behaviour.
 *
 * ⚠ It is also the headline cost of prose that needs no bench at all: D-033
 * measured 70.0% of live turn-start queries ALREADY truncated at exactly this
 * clamp. Prose in production does not arrive in empty space — it DISPLACES
 * query content that is already competing for the same 1,000 characters.
 */
export const PRODUCTION_QUERY_CLAMP = 1_000;

/**
 * The prose the simulated agent is "thinking" about `entry`.
 *
 * ON-TASK uses the entry's one-line `description` rather than its `text`, and
 * that is the least-leaky on-task stimulus available rather than a stylistic
 * choice: `text` is the indexed body, so injecting it would be pasting the
 * stored bytes into the query. The description is a separate authored gloss —
 * still an oracle (it is ABOUT the target), but a paraphrase-grade one, which
 * is the closest this corpus gets to "an agent narrating the right topic".
 *
 * ⚠ `description` IS lexically indexed (`canonical-store` scores
 * `payload->>'description'` at field weight ×2), so the on-task lexical arm
 * carries MORE leakage than the on-task cosine arm. That asymmetry is why the
 * lexical leg is reported as a routing diagnostic and never as an uplift.
 */
export function onTaskProse(entry: CorpusEntry): string {
  return (entry.description ?? entry.text).trim();
}

/**
 * Off-task prose: an unrelated entry's body, truncated to `chars`.
 *
 * Truncation is on a WORD boundary — a half-word tail is a token the embedder
 * never sees in real text, and it would make the shortest doses noisier than
 * the longest ones for a reason that has nothing to do with prose length.
 */
export function offTaskProse(entry: CorpusEntry, chars: number): string {
  const text = entry.text.trim();
  if (chars <= 0) return '';
  if (text.length <= chars) return text;
  const cut = text.slice(0, chars);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > chars * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * The composition under test: user text first, prose appended.
 *
 * Mirrors `lexicalQueryText`'s `${user} ${extra}` shape deliberately — if prose
 * ever ships, that is the composer it would extend, and measuring a different
 * shape would measure something the plan cannot act on.
 */
export function composeProseQuery(userText: string, prose: string): string {
  const user = userText.trim();
  const p = prose.trim();
  if (!p) return user;
  return user ? `${user} ${p}` : p;
}

export interface ProseArmOptions {
  mode: ProseMode;
  leg: ProseLeg;
  /** Corpus, keyed as the gold set's `expected` refers to it. */
  corpus: ReadonlyMap<string, CorpusEntry>;
  /** Stable ordering used to pick the off-task source. */
  corpusKeys: readonly string[];
  /**
   * Off-task prose length in characters — the DOSE. Ignored by `ontask`, whose
   * stimulus is the description at its natural length.
   *
   * Keep every dose + the gold query under `PRODUCTION_QUERY_CLAMP`, or the
   * sweep measures the clamp rather than prose.
   */
  chars?: number;
}

/**
 * Pick the entry whose prose the simulated agent is narrating.
 *
 * Hard negatives have no target, so `ontask` is undefined for them and they
 * take the off-task source in BOTH modes — same rule as ARM B, and for the same
 * reason: they are the only class that can show prose ADMITTING noise, so
 * dropping them would remove the measurement's cost side.
 */
function sourceFor(
  q: GoldQuery,
  i: number,
  opts: ProseArmOptions,
): CorpusEntry | undefined {
  if (opts.mode === 'ontask' && q.expected.length > 0) return opts.corpus.get(q.expected[0]);
  const expected = new Set(q.expected);
  for (let k = 0; k < opts.corpusKeys.length; k++) {
    const key = opts.corpusKeys[(i * 7 + k) % opts.corpusKeys.length];
    if (!expected.has(key)) return opts.corpus.get(key);
  }
  return undefined;
}

/**
 * Build the paired arm. Baseline is always the gold query untouched, so every
 * sub-arm shares ONE baseline run.
 *
 * The candidate sets BOTH legs explicitly, including the leg that is supposed
 * to be unchanged. That is what makes the leg isolation real: a `GoldQuery`
 * with no `lexicalQuery` hands the SAME string to both legs, so a "cosine-only"
 * arm that left `lexicalQuery` unset would silently be a both-legs arm.
 */
export function buildAgentProseArm(
  gold: readonly GoldQuery[],
  opts: ProseArmOptions,
): ArmPair {
  const baseline: GoldQuery[] = [];
  const candidate: GoldQuery[] = [];

  gold.forEach((q, i) => {
    const source = sourceFor(q, i, opts);
    const prose = source
      ? opts.mode === 'ontask'
        ? onTaskProse(source)
        : offTaskProse(source, opts.chars ?? 0)
      : '';
    const composed = composeProseQuery(q.query, prose);

    baseline.push({ ...q });
    candidate.push({
      ...q,
      query: opts.leg === 'lexical' ? q.query : composed,
      lexicalQuery: opts.leg === 'cosine' ? q.query : composed,
    });
  });

  const dose = opts.mode === 'offtask' ? `,${opts.chars ?? 0}c` : '';
  return {
    baseline: { label: 'user-text-only', queries: baseline },
    candidate: { label: `+prose(${opts.mode},${opts.leg}${dose})`, queries: candidate },
  };
}

/**
 * The NULL CONTROL, and it is a stronger one than "inject empty prose".
 *
 * The candidate carries no prose at all but DOES set both legs explicitly to
 * the user text — exercising the exact leg-isolation mechanism every arm above
 * depends on. So a non-zero delta here does not merely mean "the harness is
 * noisy": it means passing an explicit `lexicalQuery` identical to `query`
 * changes retrieval, which would invalidate every per-leg number in the report.
 *
 * ⚠ Its label differs from the baseline's, so it is genuinely re-run rather
 * than served from the run cache. A cached null control returns exactly zero by
 * construction and proves nothing.
 */
export function buildProseNullControl(gold: readonly GoldQuery[]): ArmPair {
  return {
    baseline: { label: 'user-text-only', queries: gold.map((q) => ({ ...q })) },
    candidate: {
      label: 'null-control(legs-set-explicitly)',
      queries: gold.map((q) => ({ ...q, query: q.query, lexicalQuery: q.query })),
    },
  };
}

export interface ProseCoverage {
  /** Candidate queries that actually received prose. */
  withProse: number;
  total: number;
  /** Median composed-query length, in characters. */
  medianQueryChars: number;
  /** Longest composed query — the headroom against the production clamp. */
  maxQueryChars: number;
  /** Composed queries that WOULD be truncated on the production path. */
  overProductionClamp: number;
}

/**
 * How much prose actually reached the query, and whether the production clamp
 * would have cut it.
 *
 * ⚠ NOT bookkeeping. `overProductionClamp > 0` means the arm is partly
 * measuring truncation rather than prose, and the dose sweep is sized to keep
 * it at zero — so a non-zero here is a reason to distrust that row.
 */
export function proseCoverage(pair: ArmPair, leg: ProseLeg): ProseCoverage {
  const textOf = (q: GoldQuery) => (leg === 'lexical' ? (q.lexicalQuery ?? q.query) : q.query);
  const lengths: number[] = [];
  let withProse = 0;
  let over = 0;

  pair.candidate.queries.forEach((q, i) => {
    const text = textOf(q);
    if (text !== pair.baseline.queries[i].query) withProse += 1;
    lengths.push(text.length);
    if (text.length > PRODUCTION_QUERY_CLAMP) over += 1;
  });

  const sorted = [...lengths].sort((a, b) => a - b);
  return {
    withProse,
    total: pair.candidate.queries.length,
    medianQueryChars: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
    maxQueryChars: sorted.length ? sorted[sorted.length - 1] : 0,
    overProductionClamp: over,
  };
}

/** Re-export for callers that only import this module. */
export type { Arm, ArmPair };
