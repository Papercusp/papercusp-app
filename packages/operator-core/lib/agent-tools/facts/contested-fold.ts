/**
 * contested-fold.ts — surface a CONTESTED fact key to the agent who merely READS it
 * (agent-epistemics-2026-08-02 P-006, read side; WI-7236).
 *
 * THE GAP THIS CLOSES. P-006 shipped its dispute advisory on the WRITE path:
 * `assessKeyContest` fires inside `facts:assert`. That is the right FIRST surface — it
 * lands exactly when the cost is about to be paid. But it fires only when someone WRITES
 * to the key, and the agent who most needs the signal never writes: they READ the fact,
 * find it thin, and go re-derive the answer. A compaction boundary manufactures exactly
 * that agent. So a key that four agents already fought over, or that someone already
 * settled as UNDECIDABLE, reads as an ordinary fact to the fifth — and they pay the
 * derivation privately, which is the entire cost P-006 exists to prevent.
 *
 * WHY ORIENT. The fold runs on every wake, so the mark reaches an agent who did nothing
 * but wake up. It is the same placement that makes P-008's dependency staleness work
 * ("an assumption whose ground moved is flagged to its author without anyone having to
 * think to look"), and the same carrier WI-7222 used for P-004's supersession marker.
 *
 * MARK, NEVER SUPPRESS — the house rule for this whole family (`stale-source.ts`,
 * `dependency-staleness.ts`, migration 732's supersession). A contested key is not a
 * false key: re-asserting over a settled one is sometimes precisely right, and that is
 * how an `undecidable` gets settled when its named evidence turns up. Only the reader can
 * tell those apart, so they get the fact AND the flag.
 *
 * THE THRESHOLD IS NOT REDEFINED HERE. `CONTEST_MIN_OTHER_AUTHORS` is imported from
 * contested-key.ts, where D-001 §3 set it BY MEASUREMENT (>=2 other authors is the ~99th
 * percentile; >=3 fires about once a fortnight and would make this silent). A second copy
 * would drift, and then a key could warn on assert while reading clean on orient — the
 * two surfaces disagreeing about the same key is worse than either being absent.
 *
 * COST IS PROPORTIONATE BY CONSTRUCTION: ONE batched query for the superseded rows of the
 * folded keys, never one per key, and skipped entirely when nothing is folded. Superseded
 * rows are the ~10% tail of writes and are swept at 30d, so the scan is small and bounded.
 */
import type { AgentFact, SupersededVersionRow } from '../../agent-facts/store';
import { supersededVersionsForKeys } from '../../agent-facts/store';
import {
  CONTEST_MIN_OTHER_AUTHORS,
  contestAuthors,
  type ContestChainEntry,
} from '../../facts/contested-key';

/** What the reader is told about a key others have already written to. */
export interface FactContestMark {
  /** The most recent superseded version was declared UNDECIDABLE — the strongest case. */
  settledUndecidable: boolean;
  /** The evidence that version said would settle the question (P-002's exit condition). */
  settledBy: string | null;
  /** Distinct authors of prior versions, excluding this version's own author. */
  priorAuthors: string[];
  /** How many prior versions the chain carries (bounded by the read below). */
  priorVersions: number;
  /** The reader-facing note — deliberately NOT assessKeyContest's write-voiced prose. */
  note: string;
}

/** Cap the superseded-row scan. Well above any real chain; a runaway key cannot blow up orient. */
const MAX_VERSION_ROWS = 400;

/** Identity of a fact row, as the fold groups it. */
function identityOf(f: { scope: string; scopeRef?: string | null; key: string }): string {
  return `${f.scope}\x00${(f.scopeRef ?? '').trim()}\x00${f.key}`;
}

/**
 * PURE: render the reader-facing note. Separate from `assessKeyContest`'s note on purpose —
 * that one addresses someone mid-write ("Before adding another:", "this write is the right
 * one"), which is the wrong voice for an agent who has not written anything and may be
 * about to re-derive rather than re-assert.
 */
export function describeContestForReader(input: {
  settledUndecidable: boolean;
  settledBy: string | null;
  priorAuthors: readonly string[];
  priorVersions: number;
}): string {
  if (input.settledUndecidable) {
    return (
      '⚠ ALREADY SETTLED AS UNDECIDABLE — someone recorded this key as "not decidable from ' +
      'available evidence, stop re-deriving". ' +
      (input.settledBy
        ? `It named what WOULD settle it: ${input.settledBy}. If you have that, settle it. If you do ` +
          'not, do not go re-derive an answer from the same evidence already judged insufficient — ' +
          'that derivation is the cost this record exists to save.'
        : 'It recorded no exit condition, so no stated evidence would settle it. Re-deriving it will ' +
          'not produce one.')
    );
  }
  return (
    `⚠ CONTESTED KEY — ${input.priorAuthors.length} other agent(s) ` +
    `(${input.priorAuthors.slice(0, 4).join(', ')}) have written a different answer here across ` +
    `${input.priorVersions} prior version(s). Read this one as one party's answer, not settled fact. ` +
    'Before spending a turn arbitrating it: WHAT WOULD YOU DO DIFFERENTLY under each answer? If the ' +
    'next action is identical whichever is right, the disagreement is not worth resolving — assert ' +
    'kind:"undecidable" with a `settledBy` naming the evidence that would decide it, and move on.'
  );
}

/**
 * Mark folded facts whose key is contested or already settled-undecidable.
 *
 * FAIL-SOFT BY CONTRACT, like every sibling marker: any failure returns the facts UNMARKED
 * rather than throwing. A dispute advisory is a nicety; orientation is not, and a facts
 * outage must never break a wake.
 */
export async function markContestedFacts<T extends AgentFact>(
  facts: readonly T[],
  readVersions: (keys: string[]) => Promise<SupersededVersionRow[]> = (keys) =>
    supersededVersionsForKeys({ keys, limit: MAX_VERSION_ROWS }),
): Promise<Array<T & { contested?: FactContestMark }>> {
  if (facts.length === 0) return facts as Array<T & { contested?: FactContestMark }>;
  try {
    const rows = await readVersions([...new Set(facts.map((f) => f.key))]);
    if (rows.length === 0) return facts as Array<T & { contested?: FactContestMark }>;

    const byIdentity = new Map<string, ContestChainEntry[]>();
    for (const r of rows) {
      // Group on the FULL identity, not the bare key: the same key under a different scope
      // (owner vs harness vs workspace) is a different fact, and merging them would invent
      // a dispute between agents who never addressed the same question.
      const id = identityOf(r);
      const entry: ContestChainEntry = {
        createdBy: r.createdBy,
        body: r.body,
        kind: r.kind,
        settledBy: r.settledBy,
        updatedAt: r.updatedAt,
      };
      const list = byIdentity.get(id);
      if (list) list.push(entry);
      else byIdentity.set(id, [entry]);
    }

    return facts.map((f) => {
      const chain = byIdentity.get(identityOf(f));
      if (!chain || chain.length === 0) return f;
      const prior = chain[0]!;
      const settledUndecidable = prior.kind === 'undecidable';
      const priorAuthors = contestAuthors(chain, f.createdBy);
      if (!settledUndecidable && priorAuthors.length < CONTEST_MIN_OTHER_AUTHORS) return f;
      return {
        ...f,
        contested: {
          settledUndecidable,
          settledBy: prior.settledBy ?? null,
          priorAuthors,
          priorVersions: chain.length,
          note: describeContestForReader({
            settledUndecidable,
            settledBy: prior.settledBy ?? null,
            priorAuthors,
            priorVersions: chain.length,
          }),
        },
      };
    });
  } catch {
    return facts as Array<T & { contested?: FactContestMark }>;
  }
}
