/**
 * contested-key.ts — the dispute detector (agent-epistemics-2026-08-02 P-006, scoped by that
 * plan's D-001).
 *
 * WHAT IT IS FOR: on 2026-08-02 four agents spent ~2 hours independently re-deriving which sha
 * the green gate was judging, each reaching a different answer, several retracting publicly.
 * The answer that would have ended it — "not determinable from these fields" — was reachable in
 * the first ten minutes. The cost was not the disagreement; it was that each agent paid the
 * derivation privately, with no signal that anyone had been here before.
 *
 * WHY IT IS NOT KEYED ON CONTRADICTING CLAIMS (D-001 — read it before "improving" this):
 * P-006 was drafted as ">=3 agents emit contradicting claims on the same key inside N minutes".
 * Measured over 14 days, of 1,236 fact keys exactly ONE had >=3 distinct authors and ZERO had
 * that inside any 60-minute window; `condition_key` on coord messages peaked at one sender per
 * key per hour. That trigger fires never. It is also the precise defect that retired the last
 * contradiction detector — `facts:conflicts` was gated on a `claim` field that 3 of 2,217 facts
 * ever carried (WI-6545 / D-103), and its tombstone is still in `agent-tools/facts/assert.ts`.
 * A detector nobody produces input for is worse than none: it reads as evidence of absence.
 *
 * SO THE PRODUCER IS THE WRITE PATH ITSELF. Every `facts:assert` supersedes the prior version of
 * its key, and the chain is retained (`agent_facts_version_chain`). Re-deriving a settled key is
 * therefore observable with no new field, no opt-in, and no cooperation from the agent doing it.
 *
 * AND IT IS FREE ON THE COMMON PATH: a first assert has no `supersedesId`, so the caller skips
 * the chain read entirely. Only a re-assert pays for it — ~10% of writes on the measured data.
 *
 * The pure assessor lives here (unit-testable without a database, mirroring set_claim_spec's
 * exported advisory helpers); the chain read is `factVersions`, already in the store.
 */
import type { FactKind } from '../agent-facts/store';

/** One prior version of a key, as {@link factVersions} returns it (current-first). */
export interface ContestChainEntry {
  id?: number;
  createdBy: string;
  body: string;
  kind: FactKind | null;
  /** Present only on kind:'undecidable' — the evidence that WOULD settle the question. */
  settledBy?: string | null;
  updatedAt: string;
}

export interface KeyContestAssessment {
  /** The version this assert replaced was declared UNDECIDABLE — the strongest case. */
  settledUndecidable: boolean;
  /** What evidence that undecidable said would settle it (P-002's exit condition). */
  settledBy: string | null;
  /** Distinct authors of prior versions, EXCLUDING the current asserter, newest first. */
  priorAuthors: string[];
  /** How many prior versions the chain carries (bounded by the read's limit). */
  priorVersions: number;
  /** The action-relevance question — the part that actually saves the time. */
  note: string;
}

/**
 * D-001 §3: the threshold is 2 OTHER authors, not the drafted 3. The measurement sets it —
 * >=2 distinct authors on one key is already the ~99th percentile (12 of 1,236 keys over 14
 * days), while >=3 occurs about once a fortnight and would make this silent in practice.
 * Exported so the READ surface (the coord:orient fold) cannot drift from the WRITE surface:
 * a key that warns on assert must be the same key that is marked on orient.
 */
export const CONTEST_MIN_OTHER_AUTHORS = 2;

/** Distinct authors, newest first, excluding `asserter` (the version's own author). */
export function contestAuthors(chain: readonly ContestChainEntry[], asserter: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of chain) {
    if (e.createdBy === asserter || seen.has(e.createdBy)) continue;
    seen.add(e.createdBy);
    out.push(e.createdBy);
  }
  return out;
}

/**
 * Decide whether this re-assert is walking back over contested ground, and what to say about it.
 *
 * `chain` must EXCLUDE the row just written — pass the versions that existed BEFORE this assert,
 * newest first. Returns `null` on the clean case so the caller can omit the field entirely
 * rather than shipping an empty object on every write (the same discipline `truncated` and
 * `dependenciesUnresolved` already follow in facts:assert).
 *
 * ADVISORY ONLY, and deliberately so. Re-asserting over a settled key is sometimes exactly
 * right — it is how an undecidable gets SETTLED once the evidence it named turns up. So this
 * never blocks a write; it hands the asserter the question that distinguishes the two cases,
 * which is a thing they can answer in one sentence and the detector cannot answer at all.
 */
export function assessKeyContest(input: {
  chain: readonly ContestChainEntry[];
  asserter: string;
  /** Kind of the fact just asserted — a NEW undecidable is a settlement, not a re-derivation. */
  assertedKind?: FactKind | null;
}): KeyContestAssessment | null {
  const chain = input.chain;
  if (chain.length === 0) return null;
  const prior = chain[0]!;
  const authors = contestAuthors(chain, input.asserter);
  const settledUndecidable = prior.kind === 'undecidable';
  const multiAuthor = authors.length >= CONTEST_MIN_OTHER_AUTHORS;
  if (!settledUndecidable && !multiAuthor) return null;

  // Re-declaring it undecidable is not a re-derivation — it is agreeing. Say so briefly rather
  // than scolding someone for doing the right thing.
  const reaffirming = settledUndecidable && input.assertedKind === 'undecidable';

  let note: string;
  if (reaffirming) {
    note =
      `This key was ALREADY settled as undecidable by ${prior.createdBy}` +
      (prior.settledBy ? ` (settles when: ${prior.settledBy})` : '') +
      '. You are re-affirming it, which is fine — but nothing downstream changed, so if you ' +
      'reached it by re-deriving the answer rather than by reading the existing fact, that ' +
      'derivation was the cost this record exists to prevent.';
  } else if (settledUndecidable) {
    note =
      `⚠ RE-DERIVING A SETTLED QUESTION. ${prior.createdBy} recorded this key as UNDECIDABLE — ` +
      'meaning "not decidable from available evidence, stop re-deriving". ' +
      (prior.settledBy
        ? `It named exactly what would settle it: ${prior.settledBy}. If you HAVE that, this write is ` +
          'the right one and you are closing the question. If you do not, you are about to spend the ' +
          'time that record exists to save — and to replace a durable "we cannot know" with a ' +
          'confident answer built from the same evidence that was already judged insufficient.'
        : 'It recorded no exit condition, so there is no stated evidence that would settle it. ' +
          'Before overwriting: what do you have that the previous agent did not?');
  } else {
    note =
      `⚠ CONTESTED KEY — ${authors.length} other agents (${authors.slice(0, 4).join(', ')}) have already ` +
      `written a different answer here across ${chain.length} version(s). Before adding another: ` +
      'WHAT WOULD YOU DO DIFFERENTLY under each answer? If the next action is identical whichever is ' +
      'right, the disagreement is not worth resolving — assert it as kind:"undecidable" with a ' +
      '`settledBy` naming the evidence that would decide it, and move on. That is the whole point: ' +
      'a contested key usually costs hours of arbitration to reach a branch nobody would act on.';
  }

  return {
    settledUndecidable,
    settledBy: prior.settledBy ?? null,
    priorAuthors: authors,
    priorVersions: chain.length,
    note,
  };
}
