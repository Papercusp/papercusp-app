/**
 * P-005 — the adversarial novelty + feasibility critics (hive-creative-ideation
 * D-005). Layers LLM judgment on top of the deterministic ./critique-core spine:
 *
 *   1. SEARCH-FIRST novelty vs the corpus (deterministic — corpusNovelty, which
 *      reuses the shipped dedupSignature + titleSimilarity matcher, no second
 *      dedup invented). This is a CEILING.
 *   2. an LLM novelty-skeptic that can only LOWER novelty (spot a conceptual dup
 *      the dedup missed) — it can NEVER raise an already-present idea to novel,
 *      so "already tried" stays caught (b6c3f invariant 3).
 *   3. an LLM feasibility critic (groundable in THIS architecture? cost vs upside).
 *   4. bucket into keep / moonshot / reject, preserving a capped moonshot bucket.
 *
 * The two critics pull against each other (novelty wants weird, feasibility wants
 * buildable) — creativity lives at that boundary (D-005). The `ScoutLlmCall` is
 * injected (the gym:judge pattern) so this unit-tests with a fake call (no
 * network). The cycle (su-cb4b9) calls `critiqueIdeas`; P-009 (su-e8630) asserts
 * over its output.
 */
import type { Idea, ScoutLlmCall, ScoredIdea } from './types';
import {
  bucketByCritique,
  verdictFor,
  type CorpusEntry,
  type CorpusNoveltyOptions,
  type BucketOptions,
} from './critique-core';
import { corpusNoveltyHybrid, type SemanticNoveltyDeps } from './semantic-novelty-leg';
import { parseLlmJson } from './llm-json';
import { DEFAULT_SCOUT_CRITIC_MODEL } from './models';
import { callScoutPhaseLlm, DEFAULT_SCOUT_CRITIC_TIMEOUT_MS } from './llm-deadline';

/**
 * Default critic model — cheap on purpose (the plan: "a handful of ideators +
 * critics per cycle"). Overridable via CriticContext.model; the search-first
 * novelty (the load-bearing dedup) is free + deterministic regardless.
 */
export const DEFAULT_CRITIC_MODEL = DEFAULT_SCOUT_CRITIC_MODEL;

/**
 * The default critic MISSION framing (P-010 scout prompt-overlay seam,
 * domain-generic-hive-architecture-2026-06-18 D-004) — the adversarial-critics
 * intro line naming the domain the idea is judged FOR. Coding/Papercusp-flavored by
 * default; a `work` hive overrides it via the blueprint `scout.framing.criticMission`
 * block. This is the DOMAIN framing only — the two-axis novelty/feasibility critic
 * MECHANISM + the JSON output contract stay hardcoded (P-011).
 *
 * Exported so {@link DEFAULT_SCOUT_FRAMING} (config.ts) is built FROM it (anti-drift).
 */
export const DEFAULT_CRITIC_MISSION =
  'You are TWO adversarial critics judging ONE creative idea proposed for the Papercusp "Hive" (a multi-agent coding platform). You pull against each other on purpose:';

export interface CriticContext {
  /** Project / architecture summary the feasibility critic weighs against. */
  projectContext?: string;
  model?: string;
  thinkingBudgetTokens?: number;
  /**
   * Per-blueprint MISSION framing override (P-010). Replaces the default
   * adversarial-critics intro with the hive's domain framing. Absent ⇒
   * {@link DEFAULT_CRITIC_MISSION} (byte-identical to the pre-seam prompt).
   */
  mission?: string;
  /** Per-call generation cap; <=0 disables the local cap. */
  timeoutMs?: number;
  /** Optional caller cancellation signal (the production runner composes its parent signal). */
  signal?: AbortSignal;
  /** Absolute deadline of the owning Scout cycle. */
  cycleDeadlineMs?: number;
  /** Test seam for the admission backstop grace. */
  admissionBackstopGraceMs?: number;
}

export interface CriticRawScores {
  /** The LLM novelty-skeptic's conceptual-novelty score (0..1). */
  conceptualNovelty: number;
  /** The LLM feasibility critic's score (0..1). */
  feasibility: number;
  rationale: string;
  costUsd: number;
}

export interface CritiqueOptions {
  novelty?: CorpusNoveltyOptions;
  /** Injectable query-time implementation corpus/semantic seams (tests and
   * callers already holding a compatible search backend). */
  semanticDeps?: SemanticNoveltyDeps;
  bucket?: BucketOptions;
  critic?: CriticContext;
}

export interface CritiqueResult {
  /** Every idea scored (verdict reflects the post-cap bucket). */
  critiques: ScoredIdea[];
  /** Survivors to build (novel + feasible). */
  kept: ScoredIdea[];
  /** Preserved high-novelty / low-feasibility leaps (capped, D-005). */
  moonshot: ScoredIdea[];
  /** The obvious / already-tried + not-strong-enough leaps + capped-out leaps. */
  rejected: ScoredIdea[];
}

export interface CriticPrior {
  ref: string;
  similarity: number;
  state?: string;
  /** Realized-work narrative recovered from structured completion evidence. */
  evidence?: string;
  /** True means nearest-neighbour candidate only, not an above-floor match. */
  implementationCandidate?: boolean;
}

const MAX_IMPLEMENTATION_CANDIDATES_FOR_CRITIC = 3;
const CRITIC_EVIDENCE_EXCERPT_CHARS = 500;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp01(n: unknown, fallback: number): number {
  const x = typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  return Math.max(0, Math.min(1, x));
}

export function buildCriticPrompt(
  idea: Idea,
  nearestPriors: readonly CriticPrior[],
  ctx: CriticContext,
): { system: string; user: string } {
  const system = [
    // P-010: the domain MISSION framing is blueprint-overridable; the two-critic
    // mechanism + JSON output contract below stay hardcoded.
    ctx.mission ?? DEFAULT_CRITIC_MISSION,
    '',
    '• NOVELTY critic (skeptic): is this genuinely NEW, or the obvious move dressed up / something already tried? Be harsh — penalise ideas close to what already exists. This is a mature, actively-developed platform: a well-known operational category (rate-limit ladders, per-account throttling, egress rotation, circuit breakers, retries, caching, scheduling) is MORE LIKELY to already exist than not, so an idea that confidently asserts such a gap without hedging or evidence should be scored LOW, not taken at face value. Retrieved implementation candidates are evidence to inspect, not automatic duplicate verdicts: an irrelevant candidate or no candidate at all is NEVER proof of novelty. Score conceptualNovelty 0 (obvious / already done) … 1 (a real leap).',
    "• FEASIBILITY critic: could this actually work in THIS architecture, and is the cost worth the upside? Also check the idea's OWN cited evidence (specific incidents/logs/tickets) actually supports the mechanism it claims — e.g. a citation describing a local rate-governor pause is NOT evidence of an upstream HTTP 429, and citing the wrong event class undermines the whole premise. If the citations contradict or fail to support the claim, score feasibility LOW and say so explicitly in the rationale. Score feasibility 0 (impractical / no clear payoff, or premise contradicted by its own evidence) … 1 (clearly buildable, high payoff).",
    '',
    'A great idea is novel AND feasible; a leap may be novel but not-yet-feasible (that is fine — it is preserved separately). Reason briefly, then output ONLY this JSON (no prose, no fences):',
    '{"conceptualNovelty": <0-1 number>, "feasibility": <0-1 number>, "rationale": "<one or two sentences>"}',
  ].join('\n');

  const priorLines = nearestPriors.length
    ? nearestPriors
        .map((p) => {
          const score = p.implementationCandidate
            ? `semantic implementation candidate; retrieval score ${p.similarity}; NOT a duplicate verdict`
            : `similarity ${p.similarity}`;
          const evidence = p.evidence
            ? `\n    Completion evidence: ${p.evidence.replace(/\s+/g, ' ').slice(0, CRITIC_EVIDENCE_EXCERPT_CHARS)}`
            : '';
          return `  - ${p.ref}${p.state ? ` [${p.state}]` : ''} (${score})${evidence}`;
        })
        .join('\n')
    : '  (none — the bounded evidence-backed corpus found no positive match; coverage is incomplete, so absence is not evidence that the mechanism is new)';

  const user = [
    `## Idea (lens: ${idea.lens})`,
    `Title: ${idea.title}`,
    '',
    'What it is:',
    idea.body,
    '',
    'Proposed mechanism:',
    idea.mechanism,
    '',
    '## Closest prior designs and realized work (search-first)',
    priorLines,
    '',
    '## Architecture context',
    ctx.projectContext ?? '(none provided)',
  ].join('\n');

  return { system, user };
}

/** Run the LLM critic for one idea (injected llmCall — testable with a fake). */
export async function runCritic(
  idea: Idea,
  nearestPriors: readonly CriticPrior[],
  ctx: CriticContext,
  deps: { llmCall: ScoutLlmCall },
): Promise<CriticRawScores> {
  const { system, user } = buildCriticPrompt(idea, nearestPriors, ctx);
  const thinkingBudgetTokens = ctx.thinkingBudgetTokens ?? 1024;
  let res: Awaited<ReturnType<ScoutLlmCall>>;
  try {
    res = await callScoutPhaseLlm({
      llmCall: deps.llmCall,
      phase: 'critic',
      timeoutMs: ctx.timeoutMs ?? DEFAULT_SCOUT_CRITIC_TIMEOUT_MS,
      signal: ctx.signal,
      cycleDeadlineMs: ctx.cycleDeadlineMs,
      admissionBackstopGraceMs: ctx.admissionBackstopGraceMs,
      input: {
        model: ctx.model ?? DEFAULT_CRITIC_MODEL,
        system,
        messages: [{ role: 'user', content: user }],
        responseFormat: 'json',
        thinkingBudgetTokens,
        // Headroom for SERVER-SIDE thinking (claude-5-family models emit it against
        // this budget even though thinkingBudgetTokens is client-side fiction — see
        // ideators.ts): a tight cap truncates the JSON mid-object → parseLlmJson null
        // → feasibility 0 → every idea silently REVIEWED, never kept (EI-13119 class).
        maxTokens: thinkingBudgetTokens + 8192,
      },
    });
  } catch (err) {
    // WI-4475: critiqueIdeas now fans every idea's critic call out CONCURRENTLY
    // (see below) instead of one-at-a-time, so a single rate-limited/failed call
    // must never abort the whole batch — it did before this catch existed, which
    // is what made one bad critic call throw the entire cycle (recorded as
    // "Scout cycle timed out ... phase critique" even though healthy accounts
    // existed — the failure was a THROWN batch, not a stuck account). Same
    // fail-safe shape as the unparseable-JSON path below: feasibility 0 forbids
    // 'keep', novelty ceiling stays intact, the idea surfaces as
    // reviewed/rejected instead of silently vanishing or nuking its siblings.
    return {
      conceptualNovelty: 1,
      feasibility: 0,
      rationale: `critic call failed: ${err instanceof Error ? err.message : String(err)}`,
      costUsd: 0,
    };
  }
  const parsed = parseLlmJson(res) as Record<string, unknown> | null;
  if (parsed == null) {
    // Fail safe: an unparseable critic cannot smuggle an idea through to KEEP —
    // feasibility 0 forbids 'keep'; novelty 1 leaves the search-first ceiling intact.
    return {
      conceptualNovelty: 1,
      feasibility: 0,
      rationale: 'critic produced no parseable JSON',
      costUsd: res.costUsd,
    };
  }
  return {
    conceptualNovelty: clamp01(parsed.conceptualNovelty, 1),
    feasibility: clamp01(parsed.feasibility, 0),
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
    costUsd: res.costUsd,
  };
}

/**
 * Critique one idea: deterministic search-first novelty (the CEILING) blended via
 * `min` with the LLM novelty-skeptic, plus the LLM feasibility critic, then a
 * PRE-CAP verdict. The batch moonshot-cap is applied in `critiqueIdeas`.
 */
export async function critiqueIdea(
  idea: Idea,
  corpus: readonly CorpusEntry[],
  deps: { llmCall: ScoutLlmCall },
  opts: CritiqueOptions = {},
): Promise<ScoredIdea> {
  // P-017: the deterministic search-first novelty, now blended with the hybrid
  // embedding leg (fail-open to pure lexical). Still a CEILING the LLM may only lower.
  const cn = await corpusNoveltyHybrid(`${idea.title} ${idea.body}`, corpus, opts.novelty, opts.semanticDeps);
  const corpusByRef = new Map(cn.evaluatedCorpus.map((entry) => [entry.ref, entry]));
  const matchedRefs = new Set(cn.matches.map((match) => match.ref));
  const criticPriors: CriticPrior[] = cn.matches.map((match) => ({
    ref: match.ref,
    similarity: match.similarity,
    ...(match.state ? { state: match.state } : {}),
    ...(corpusByRef.get(match.ref)?.kind === 'implementation' ? { evidence: corpusByRef.get(match.ref)?.text } : {}),
  }));
  for (const candidate of cn.implementationCandidates.slice(0, MAX_IMPLEMENTATION_CANDIDATES_FOR_CRITIC)) {
    if (matchedRefs.has(candidate.entry.ref)) continue;
    criticPriors.push({
      ref: candidate.entry.ref,
      similarity: candidate.similarity,
      state: 'shipped',
      evidence: candidate.entry.text,
      implementationCandidate: true,
    });
  }
  const raw = await runCritic(idea, criticPriors, opts.critic ?? {}, deps);
  // Search-first novelty is the CEILING: the LLM may only LOWER it.
  const novelty = round2(Math.min(cn.novelty, raw.conceptualNovelty));
  const feasibility = round2(raw.feasibility);
  const { verdict } = verdictFor({ id: idea.id, novelty, feasibility }, opts.bucket);
  return {
    idea,
    novelty,
    feasibility,
    noveltyMatches: cn.matches,
    verdict,
    notes: raw.rationale,
  };
}

/**
 * Critique a batch of ideas: score each, then partition with the capped moonshot
 * bucket (D-005) and stamp the FINAL (post-cap) verdict + reason back onto each
 * ScoredIdea. Returns the full set plus the keep / moonshot / reject lanes.
 */
export async function critiqueIdeas(
  ideas: readonly Idea[],
  corpus: readonly CorpusEntry[],
  deps: { llmCall: ScoutLlmCall },
  opts: CritiqueOptions = {},
): Promise<CritiqueResult> {
  // WI-4475 (bug-drain-200k): this used to be a plain `for...of` loop with an
  // `await` per idea — N ideas meant N SEQUENTIAL LLM round-trips summed into the
  // SAME 600s scout-cycle deadline. That serialization, not a broken account
  // failover, is what produced "Scout cycle timed out after 600000ms during
  // phase critique" on ticks whose poolSnapshotAtFire (WI-5436) showed healthy
  // accounts available — the failover mechanism was never the defect; the phase
  // just never gave it the chance to matter. Fan the calls out concurrently
  // instead (mirrors runIdeators' Promise.all roster fan-out): wall time is now
  // bounded by the SLOWEST single critique, not their sum. runCritic's catch
  // above keeps one failed call from crashing the batch.
  const critiques: ScoredIdea[] = await Promise.all(ideas.map((idea) => critiqueIdea(idea, corpus, deps, opts)));
  const buckets = bucketByCritique(
    critiques.map((c) => ({ id: c.idea.id, novelty: c.novelty, feasibility: c.feasibility })),
    opts.bucket,
  );
  for (const c of critiques) {
    const v = buckets.verdicts[c.idea.id];
    if (v) {
      c.verdict = v.verdict;
      c.notes = c.notes ? `${v.reason} — ${c.notes}` : v.reason;
    }
  }
  const byId = new Map(critiques.map((c) => [c.idea.id, c]));
  const pick = (rows: ReadonlyArray<{ id: string }>): ScoredIdea[] =>
    rows.map((r) => byId.get(r.id)).filter((c): c is ScoredIdea => c != null);
  return {
    critiques,
    kept: pick(buckets.kept),
    moonshot: pick(buckets.moonshot),
    rejected: pick(buckets.rejected),
  };
}
