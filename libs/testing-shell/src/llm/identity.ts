/**
 * Identity hash — composite fingerprint that determines run comparability.
 *
 * Runs with the same identity_hash are directly comparable (e.g. two
 * nightly runs of S01-status-quick over different commits). Changing
 * the scenario, persona traits, rubric version, SUT model, judge model,
 * or the judge prompt's own scaffolding produces a new identity → a new
 * trend line.
 *
 * Plan §7.1 / §10; scaffold input added by WI-41685 under D-013/D-014.
 */

import { createHash } from 'node:crypto';

import type { PersonaTraits } from './types';

export function computeIdentityHash(input: {
  scenarioId: string;
  scenarioVersion: number;
  scenarioHash: string;
  personaId: string;
  personaTraits: PersonaTraits;
  rubricVersion: string;
  sutModel: string;
  judgeModel: string;
  /**
   * `JUDGE_PROMPT_SCAFFOLD_VERSION` from ./judge — the derived identity of the
   * judge prompt's STATIC text (rules, output schema, transcript/telemetry
   * labels) that this package wraps around every rubric.
   *
   * REQUIRED, not optional, and that is the whole point (D-013). Without it,
   * editing a rule line in judge.ts changed every judged prompt while leaving
   * stored runs comparable under an unchanged identity — a trend line that looks
   * continuous exactly where it stopped being meaningful. An optional field would
   * reinstate that silently for every caller who omitted it, which is the failure
   * this exists to prevent; make callers pass it and let the compiler find them.
   *
   * Passed IN rather than imported because identity.ts cannot import judge.ts:
   * judge.ts already imports `computeFindingShape` from here, so the reverse edge
   * would close a cycle. `runner.ts` imports both and supplies it.
   */
  judgeScaffoldVersion: string;
}): string {
  const canonical = JSON.stringify({
    s: input.scenarioId,
    sv: input.scenarioVersion,
    sh: input.scenarioHash,
    p: input.personaId,
    pt: input.personaTraits,
    rv: input.rubricVersion,
    sm: input.sutModel,
    jm: input.judgeModel,
    jsv: input.judgeScaffoldVersion,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function computeScenarioHash(scenarioFileContents: string): string {
  return createHash('sha256').update(scenarioFileContents).digest('hex');
}

/** Compute the finding `shape` (§6.6) for novel-failure grouping. */
export function computeFindingShape(axis: string, summary: string): string {
  const normalized = summary
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(`${axis}::${normalized}`).digest('hex');
}

/*
 * REMOVED by WI-41685: `identityFor(scenario, scenarioHash, personaId, traits,
 * rubricVersion, sutModel, judgeModel)`.
 *
 * It was a positional wrapper around computeIdentityHash with ZERO importers in
 * the tree (measured, not assumed — the apparent hits were an unrelated local
 * function of the same name in green-checkpoint-repair-cache-recurrence.test.ts).
 *
 * It is deleted rather than extended because keeping it meant one of two bad
 * outcomes: a NINTH positional parameter on a function nothing calls, or — far
 * worse — a dead-but-exported identity path that omits `judgeScaffoldVersion`
 * and is therefore scaffold-BLIND. That second option is a trap: the next caller
 * finds a convenient helper and silently gets the weaker identity this very
 * change exists to remove. Call computeIdentityHash with its named object.
 */
