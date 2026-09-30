/**
 * The equivalence harness (plan `bash-to-tool-substitution-2026-07-26`, P-004).
 *
 * THE METHOD, in one sentence: draw REAL commands matching a pattern from the
 * audit corpus, ask the proposed tool's capability envelope whether it can
 * express each one, and DERIVE the verdict from the answers.
 *
 * The verdict is derived, never asserted. That is the whole design. A
 * hand-written verdict rots the moment someone widens the tool; a derived one
 * changes automatically and trips `expectedVerdict` on the pair, forcing the
 * registry row to be re-recorded (see `types.ts`).
 *
 * ── Why the bar is 100% coverage (plan D-008) ────────────────────────────────
 * A partial verdict is tempting — "19 of 20, close enough" — and it is wrong,
 * because the PATTERN is the unit of enforcement. Every command the pattern
 * matches gets the advisory; if one of them has no tool form, that agent is
 * told to use a tool that cannot do the job. The fix for a near-miss is NOT to
 * lower the bar but to NARROW THE PATTERN until the residue falls outside it,
 * or to widen the tool. Both outcomes are good; a 95% threshold produces
 * neither and quietly ships the broken 5%.
 *
 * This is why the file-read family is four patterns rather than one: three of
 * them reach `equivalent` and can teach immediately, and only `tail` is held at
 * `observe` pending a real widening. One blurry family-wide verdict would have
 * stalled all four.
 */

import { compileRegistryPattern, normalizeRegistryFlags } from './match';
import { sqlPairClaimsAtom } from './sql-corpus';
import { assertPolicyTier, corpusOf, isSqlPair, patternFlagsOf, patternSourceOf } from './types';
import type {
  CoverageResult,
  EquivalenceVerdict,
  FailingCase,
  PairAudit,
  SampledCommand,
  SubstitutionPair,
  SubstitutionTier,
} from './types';

/**
 * Minimum sample size for a verdict to count (the plan specifies N=20).
 * Below this, a pattern is too rare — or too narrow — to have earned a verdict,
 * and `auditPair` throws rather than returning a confident-looking result built
 * on three commands.
 */
export const MIN_SAMPLE_SIZE = 20;

/**
 * Population floors for the CENSUS escape hatch below: a pattern backed by at
 * least this many real commands, spread across at least this many independent
 * sessions, has earned a verdict even when its DEDUPED sample is smaller than
 * {@link MIN_SAMPLE_SIZE}.
 *
 * The session floor is what stops this becoming a loophole — 40 commands from
 * one session is one agent's habit, not fleet-wide evidence, and it still throws.
 */
export const MIN_POPULATION_ATOMS = MIN_SAMPLE_SIZE;
export const MIN_POPULATION_SESSIONS = 5;

/**
 * Has this pair earned a verdict at all? True when the deduped sample meets
 * {@link MIN_SAMPLE_SIZE}, or when the population is large and fleet-wide enough
 * to count as a census (see {@link auditPair}'s note on why low spelling-variety
 * must not be punished).
 *
 * Exported and factored out so a CALLER can ask the question before paying for
 * an audit that would throw. `auditPair` itself is the enforcement point and
 * uses this same predicate, so "would it throw" and "does it throw" cannot
 * drift — the alternative, matching on the thrown Error's message text, would
 * silently start swallowing genuine audit failures the day that sentence is
 * reworded.
 */
export function meetsAuditFloor(
  sampleSize: number,
  population?: { totalAtoms: number; totalSessions: number },
): boolean {
  const isCensus =
    population !== undefined &&
    population.totalAtoms >= MIN_POPULATION_ATOMS &&
    population.totalSessions >= MIN_POPULATION_SESSIONS;
  return sampleSize >= MIN_SAMPLE_SIZE || isCensus;
}

/**
 * The real POPULATION a sample was drawn from (`CorpusFixture`'s own counts).
 *
 * Optional, and only ever used to WIDEN the floor, never to narrow it.
 */
export interface SamplePopulation {
  totalAtoms: number;
  totalSessions: number;
}

/** Cap on stored failing cases: enough to act on, small enough for a jsonb column. */
const MAX_FAILING_CASES = 25;

/**
 * Select the atoms from a corpus that a pair claims.
 *
 * Dispatches on the pair's CORPUS (P-007), because "does this pair claim this
 * atom" is a different question in each: a shell atom is claimed by a regex over
 * its text, a SQL atom by the relation it plainly reads. Both routes go through
 * the same shared judgement their enforcement path uses — see below and
 * {@link sqlPairClaimsAtom} — so neither can earn a verdict under one rule and be
 * enforced under another.
 */
export function matchingAtoms(pair: SubstitutionPair, corpus: SampledCommand[]): SampledCommand[] {
  if (isSqlPair(pair)) {
    return corpus.filter((entry) => sqlPairClaimsAtom(pair, entry.atom));
  }
  // Compiled through the SAME helper every enforcement consumer uses, so a
  // verdict can never be earned under one regex and enforced under another
  // (WI-5998: the flags used to be dropped on the way into the registry, which
  // silently made the audited pattern and the enforced pattern different
  // regexes — `operator-db-select` matched `SELECT` here and missed it there).
  const pattern = compileRegistryPattern(pair.bashPattern.source, pair.bashPattern.flags);
  if (!pattern) return [];
  return corpus.filter((entry) => pattern.test(entry.atom));
}

/**
 * Run the harness for one pair against a corpus of real sampled commands.
 *
 * @param population - the counts of the REAL population `corpus` was sampled
 *   from (pass the `CorpusFixture` itself). Optional; supplying it can only
 *   ADMIT a pair the raw sample floor would have rejected, never reject one it
 *   would have admitted.
 *
 * @throws if the pattern has not earned a verdict — an under-sampled verdict is
 *   worse than no verdict, because it looks equally authoritative in the
 *   registry. See the CENSUS note below for what "under-sampled" means.
 */
export function auditPair(
  pair: SubstitutionPair,
  corpus: SampledCommand[],
  population?: SamplePopulation,
): PairAudit {
  const sample = matchingAtoms(pair, corpus);

  // ── The floor, and the CENSUS escape hatch (P-026/P-027) ──────────────────
  // Fixtures are built with `sampleDistinct`, so `sample.length` counts distinct
  // SPELLINGS, not commands. Read literally, the floor therefore rejects any
  // intent expressed in fewer than 20 different ways — which is a statement
  // about vocabulary, not about evidence, and it inverts the guard's own
  // purpose: a pattern with 24 spellings across 30 commands passes, while
  // `^uptime` (116 real commands across 36 independent sessions, spelled 4 ways)
  // fails as "too rare to enforce".
  //
  // Worse, low spelling-variety is precisely the property that makes a family
  // worth acting on: an intent everyone expresses IDENTICALLY is the one a
  // single fixed answer can serve. P-026/P-027 are entirely made of those.
  //
  // So when the sample EXHAUSTS a population that is itself large and
  // fleet-wide, it is a census rather than a thin sample — there is no more
  // evidence to be had, and demanding it would be demanding variety that does
  // not exist. A genuinely rare intent still throws: the population floors are
  // checked against real commands AND distinct sessions.
  if (!meetsAuditFloor(sample.length, population)) {
    const pop = population
      ? ` The population it was drawn from is ${population.totalAtoms} atoms across ` +
        `${population.totalSessions} sessions, which does not meet the census floor ` +
        `(>= ${MIN_POPULATION_ATOMS} atoms across >= ${MIN_POPULATION_SESSIONS} sessions).`
      : '';
    throw new Error(
      `[equivalence] pair "${pair.id}" matched only ${sample.length} of ${corpus.length} corpus atoms ` +
        `(need >= ${MIN_SAMPLE_SIZE}). Either the pattern is wrong, or this intent is too rare to enforce — ` +
        `do not record a verdict from this sample.${pop}`,
    );
  }

  const failing: FailingCase[] = [];
  const seenReasons = new Set<string>();
  let coveredCount = 0;

  for (const entry of sample) {
    let result: CoverageResult;
    try {
      result = pair.cover(entry.atom);
    } catch (e: unknown) {
      // An envelope that throws is treated as "cannot express" rather than
      // failing the whole audit: a crash on one weird atom is itself evidence
      // the tool does not cover it.
      result = { covered: false, reason: `envelope error: ${e instanceof Error ? e.message : String(e)}` };
    }

    if (result.covered) {
      coveredCount += 1;
      continue;
    }

    const reason = result.reason ?? 'no reason recorded';
    // Deduplicate by REASON, not by command: twenty `tail -f` atoms are one
    // finding, and the registry row should say so once.
    if (!seenReasons.has(reason) && failing.length < MAX_FAILING_CASES) {
      seenReasons.add(reason);
      failing.push({ atom: entry.atom, reason, sid: entry.sid });
    }
  }

  const verdict = deriveVerdict(coveredCount, sample.length);

  return {
    pairId: pair.id,
    intentLabel: pair.intentLabel,
    corpus: corpusOf(pair),
    bashPattern: patternSourceOf(pair),
    bashPatternFlags: normalizeRegistryFlags(patternFlagsOf(pair)),
    toolName: pair.toolName,
    verdict,
    sampleSize: sample.length,
    coveredCount,
    failingCases: failing,
    sessionCount: new Set(sample.map((entry) => entry.sid)).size,
    maxTier: maxTierFor(verdict),
  };
}

/**
 * The derivation rule (D-008). Total coverage or it is not equivalent.
 */
export function deriveVerdict(coveredCount: number, sampleSize: number): EquivalenceVerdict {
  if (sampleSize === 0) return 'unaudited';
  if (coveredCount === sampleSize) return 'equivalent';
  if (coveredCount === 0) return 'not-a-substitute';
  return 'needs-widening';
}

/**
 * The ceiling a verdict permits — the code-side mirror of migration 665's
 * `tier_requires_equivalence` CHECK constraint.
 *
 * Note `deny` is never returned. Per D-003 the registry teaches by default and
 * blocks only where the rule already existed independently (the shared-tree git
 * guard, the systemd scheduler lockout), so `deny` is a deliberate policy entry
 * a human writes — never something an equivalence score unlocks.
 */
export function maxTierFor(verdict: EquivalenceVerdict): SubstitutionTier {
  return verdict === 'equivalent' ? 'advise' : 'observe';
}

/**
 * Render an audit as the registry row it becomes. Keeps the field mapping in
 * ONE place so P-018's seeding cannot drift from what the harness measured.
 */
export function auditToRegistryRow(
  audit: PairAudit,
  pair: SubstitutionPair,
  evidenceRef: string,
): {
  intent_label: string;
  bash_pattern: string;
  tool_name: string;
  equivalence_verdict: EquivalenceVerdict;
  sample_size: number;
  failing_cases: FailingCase[];
  evidence_ref: string;
  tier: SubstitutionTier;
  advisory_text: string;
  baseline_sessions: number;
} {
  return {
    intent_label: audit.intentLabel,
    bash_pattern: audit.bashPattern,
    tool_name: audit.toolName,
    equivalence_verdict: audit.verdict,
    sample_size: audit.sampleSize,
    failing_cases: audit.failingCases,
    evidence_ref: evidenceRef,
    // Enter at `observe` unless the pair carries an authorized `policyTier`:
    // promotion to `advise` is P-020's staged decision after a real observation
    // window, never automatic on a green verdict (`maxTier` states what the
    // verdict PERMITS, not what it does). `assertPolicyTier` is what makes the
    // exception narrow — it refuses any pair that is not a `policy-violation:`.
    tier: assertPolicyTier(pair),
    advisory_text: pair.advisoryText,
    baseline_sessions: audit.sessionCount,
  };
}
