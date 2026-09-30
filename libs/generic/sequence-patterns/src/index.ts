/**
 * @papercusp/sequence-patterns — find the ORDERED action sequences that recur
 * across independent actors, in a timestamped event stream.
 *
 * The question this answers is not "which symbols are frequent" (a counter does
 * that) but "which ORDERED runs of symbols recur across DISTINCT actors" — the
 * difference between a shared pattern worth capturing and one actor's personal
 * habit. Cohort breadth is therefore a first-class gate, not a post-filter.
 *
 * Three properties earn their place, each because the naive version fails on real
 * data:
 *
 *  1. SEGMENTATION. An actor's lifetime stream is not one sequence. Contiguity
 *     across an idle gap is meaningless — the last call before a two-hour pause
 *     and the first one after it never formed a pattern. {@link segmentBursts}
 *     splits on an idle gap so adjacency means something.
 *
 *  2. LIFT, NOT FREQUENCY. In any instrumented system the most frequent
 *     sequences are the ambient ones every actor emits regardless of task
 *     (heartbeats, telemetry, hook probes). They outrank genuine patterns by
 *     orders of magnitude and no amount of support-thresholding demotes them,
 *     because they really are frequent. Lift — observed over what the symbols'
 *     own marginal rates predict — separates them structurally: an ambient
 *     sequence scores ~1 by construction, since its members are everywhere.
 *     This replaces the denylist you would otherwise hand-maintain forever, and
 *     it needs no update when a new ambient emitter appears.
 *
 *     ⚠ Lift alone is NOT a ranking. It is unbounded for rare symbols, so a
 *     one-off run of three rare symbols scores astronomically. That is why the
 *     support and cohort floors are applied BEFORE lift ranking and are not
 *     optional: lift decides *interesting*, the floors decide *real*. Ranking a
 *     lift-sorted list that was not floor-filtered first inverts the result.
 *
 *  3. MAXIMALITY. Every occurrence of `a→b→c→d` is also an occurrence of
 *     `a→b→c`, so a single 4-long pattern reports as four overlapping ones and
 *     buries the finding in its own prefixes. {@link minePatterns} suppresses a
 *     pattern whose support is essentially explained by a longer extension
 *     (closed-sequence style), keeping the longest form that carries the
 *     evidence.
 *
 * Pure: no I/O, no clock, no domain coupling, zero dependencies. Events and
 * policy are injected, so it mines agent tool-calls, user clickstreams, log
 * lines or trace spans identically.
 */

/** One timestamped occurrence of a symbol, attributed to the actor that produced it. */
export interface SequenceEvent {
  /** What happened — the alphabet of the mined sequences (a tool name, a route, an opcode). */
  symbol: string;
  /**
   * WHO produced it. Recurrence across distinct cohorts is the signal that
   * separates a shared pattern from one actor's habit, so this is the
   * discriminating dimension — not merely a grouping convenience.
   */
  cohort: string;
  /** Epoch milliseconds. Used only for ordering and gap segmentation. */
  at: number;
}

/** A contiguous run of one cohort's symbols, with no idle gap inside it. */
export interface Burst {
  cohort: string;
  symbols: string[];
  startedAt: number;
  endedAt: number;
}

export interface SegmentPolicy {
  /**
   * Idle gap that ends a burst, in ms. Two events further apart than this are
   * never treated as adjacent, however close they sit in the row ordering.
   */
  gapMs: number;
  /** Drop bursts shorter than this many events (default 2 — a single event forms no sequence). */
  minBurstLength?: number;
}

export interface PatternPolicy {
  /** Shortest pattern length to mine (default 2). */
  minLength?: number;
  /** Longest pattern length to mine (default 5). */
  maxLength?: number;
  /**
   * Minimum total occurrences. A REAL floor, not a ranking hint — see the lift
   * warning in the module docstring. Default 3.
   */
  minOccurrences?: number;
  /**
   * Minimum DISTINCT cohorts a pattern must appear in. The "is this ours or
   * mine?" gate; default 2, because 1 admits every personal habit.
   */
  minCohorts?: number;
  /**
   * Minimum lift. Default 2 — i.e. the pattern must occur at least twice as
   * often as its symbols' own rates predict. Ambient sequences sit at ~1.
   */
  minLift?: number;
  /**
   * Suppress a pattern whose support is essentially explained by a longer
   * extension. A shorter pattern survives only if it occurs meaningfully more
   * often than its best extension — `subsumptionRatio` sets "meaningfully"
   * (default 0.9: kept only if the extension explains <90% of its occurrences).
   * Default true.
   */
  maximalOnly?: boolean;
  subsumptionRatio?: number;
  /**
   * Collapse immediately-repeated symbols before mining (`a a a b` → `a b`).
   * Default FALSE, deliberately: a repeated call is usually a real finding (it
   * says the operation wants to accept a batch), and collapsing erases it.
   */
  collapseRuns?: boolean;
  /** Max cohort ids retained per pattern for evidence (default 20). Counting is unaffected. */
  maxCohortSample?: number;
}

export interface MinedPattern {
  /** The ordered symbols. */
  symbols: string[];
  /** Total occurrences across all bursts (overlapping occurrences each count). */
  occurrences: number;
  /** Number of DISTINCT cohorts the pattern occurred in. */
  cohorts: number;
  /** A bounded sample of those cohort ids, for evidence. */
  cohortSample: string[];
  /** Number of distinct bursts it occurred in. */
  bursts: number;
  /**
   * observed / expected-under-independence. ~1 ⇒ fully explained by the symbols'
   * own rates (ambient); >>1 ⇒ the symbols genuinely travel together in this order.
   *
   * ⚠ NOT comparable across lengths — see {@link MinedPattern.strength}. Raw lift
   * compounds one factor per symbol, so it grows super-linearly with length: on
   * live data a 5-symbol pattern scored 4.7e11 against 2.4e5 for a 3-symbol one
   * that was the better finding. Read it as evidence about ONE pattern, and rank
   * with `strength`.
   */
  lift: number;
  /**
   * Length-normalized lift — the mean per-TRANSITION log10 lift,
   * `log10(lift) / (length - 1)`. This is the ranking key, and the reason the
   * list is not simply every 5-gram: it asks "how surprising is each step of
   * this dance", which is the same question regardless of how many steps it has.
   */
  strength: number;
  /** Occurrences ÷ positions of this length — the raw rate, kept for calibration. */
  support: number;
}

export interface MineResult {
  patterns: MinedPattern[];
  /** What the corpus looked like — so a caller can tell "no patterns" from "no data". */
  stats: {
    bursts: number;
    events: number;
    cohorts: number;
    distinctSymbols: number;
    /** Patterns that met the length window before floors were applied. */
    candidatesConsidered: number;
    /** Rejected per floor — a rejection census, so a tuning mistake is visible rather than silent. */
    rejected: { occurrences: number; cohorts: number; lift: number; subsumed: number };
  };
}

const DEFAULTS = {
  minLength: 2,
  maxLength: 5,
  minOccurrences: 3,
  minCohorts: 2,
  minLift: 2,
  maximalOnly: true,
  subsumptionRatio: 0.9,
  collapseRuns: false,
  maxCohortSample: 20,
} as const;

/**
 * Length-normalized lift: the mean per-TRANSITION log10 lift.
 *
 * Raw lift multiplies one marginal per symbol, so it compounds with length and
 * a longer pattern almost always outranks a shorter one on it — which makes a
 * lift-sorted list a length-sorted list wearing a disguise. Dividing the log by
 * the number of TRANSITIONS (length - 1, the count of adjacencies the pattern
 * actually asserts) puts every length on one scale. A 1-symbol "pattern"
 * asserts no adjacency and scores 0.
 */
export function strengthOf(lift: number, length: number): number {
  if (length < 2 || !Number.isFinite(lift) || lift <= 0) return 0;
  return Math.log10(lift) / (length - 1);
}

/** Join symbols into a collision-free key (NUL cannot appear in a symbol). */
const keyOf = (symbols: readonly string[]): string => symbols.join('\x00');

/**
 * Split each cohort's events into bursts, cutting wherever consecutive events are
 * more than `gapMs` apart. Events are sorted by (cohort, at) internally, so the
 * caller may pass them in any order — a caller-side sort is not a precondition.
 */
export function segmentBursts(events: readonly SequenceEvent[], policy: SegmentPolicy): Burst[] {
  const minBurstLength = policy.minBurstLength ?? 2;
  const gapMs = policy.gapMs;

  const byCohort = new Map<string, SequenceEvent[]>();
  for (const e of events) {
    const list = byCohort.get(e.cohort);
    if (list) list.push(e);
    else byCohort.set(e.cohort, [e]);
  }

  const bursts: Burst[] = [];
  for (const [cohort, list] of byCohort) {
    list.sort((a, b) => a.at - b.at);
    let current: SequenceEvent[] = [];
    for (const e of list) {
      const prev = current[current.length - 1];
      if (prev && e.at - prev.at > gapMs) {
        if (current.length >= minBurstLength) {
          bursts.push({
            cohort,
            symbols: current.map((c) => c.symbol),
            startedAt: current[0]!.at,
            endedAt: prev.at,
          });
        }
        current = [];
      }
      current.push(e);
    }
    if (current.length >= minBurstLength) {
      bursts.push({
        cohort,
        symbols: current.map((c) => c.symbol),
        startedAt: current[0]!.at,
        endedAt: current[current.length - 1]!.at,
      });
    }
  }
  bursts.sort((a, b) => a.startedAt - b.startedAt || a.cohort.localeCompare(b.cohort));
  return bursts;
}

interface Tally {
  symbols: string[];
  occurrences: number;
  cohorts: Set<string>;
  bursts: Set<number>;
}

/**
 * Mine the ordered patterns that recur across cohorts.
 *
 * Deterministic end to end: the same bursts and policy always produce the same
 * ranked list, and ties break on the symbol key so ordering never depends on Map
 * iteration.
 */
export function minePatterns(bursts: readonly Burst[], policy: PatternPolicy = {}): MineResult {
  const minLength = Math.max(1, policy.minLength ?? DEFAULTS.minLength);
  const maxLength = Math.max(minLength, policy.maxLength ?? DEFAULTS.maxLength);
  const minOccurrences = policy.minOccurrences ?? DEFAULTS.minOccurrences;
  const minCohorts = policy.minCohorts ?? DEFAULTS.minCohorts;
  const minLift = policy.minLift ?? DEFAULTS.minLift;
  const maximalOnly = policy.maximalOnly ?? DEFAULTS.maximalOnly;
  const subsumptionRatio = policy.subsumptionRatio ?? DEFAULTS.subsumptionRatio;
  const collapseRuns = policy.collapseRuns ?? DEFAULTS.collapseRuns;
  const maxCohortSample = policy.maxCohortSample ?? DEFAULTS.maxCohortSample;

  // Normalize the bursts once (optional run-collapsing), keeping the cohort.
  const seqs: { cohort: string; symbols: string[] }[] = [];
  for (const b of bursts) {
    let symbols = b.symbols;
    if (collapseRuns) {
      const out: string[] = [];
      for (const s of symbols) if (out[out.length - 1] !== s) out.push(s);
      symbols = out;
    }
    if (symbols.length >= 1) seqs.push({ cohort: b.cohort, symbols });
  }

  // Marginals for the independence null.
  const symbolCounts = new Map<string, number>();
  let totalSymbols = 0;
  const cohortSet = new Set<string>();
  for (const s of seqs) {
    cohortSet.add(s.cohort);
    for (const sym of s.symbols) {
      symbolCounts.set(sym, (symbolCounts.get(sym) ?? 0) + 1);
      totalSymbols++;
    }
  }

  // Positions available per length — the denominator of the null.
  const positionsFor = (len: number): number => {
    let n = 0;
    for (const s of seqs) n += Math.max(0, s.symbols.length - len + 1);
    return n;
  };

  // Tally every n-gram in the length window.
  const tallies = new Map<string, Tally>();
  for (let bi = 0; bi < seqs.length; bi++) {
    const { cohort, symbols } = seqs[bi]!;
    for (let len = minLength; len <= maxLength; len++) {
      for (let i = 0; i + len <= symbols.length; i++) {
        const gram = symbols.slice(i, i + len);
        const k = keyOf(gram);
        let t = tallies.get(k);
        if (!t) {
          t = { symbols: gram, occurrences: 0, cohorts: new Set(), bursts: new Set() };
          tallies.set(k, t);
        }
        t.occurrences++;
        t.cohorts.add(cohort);
        t.bursts.add(bi);
      }
    }
  }

  const rejected = { occurrences: 0, cohorts: 0, lift: 0, subsumed: 0 };
  const candidatesConsidered = tallies.size;

  // Apply the floors. Order matters only for the census; a pattern is counted
  // against the FIRST floor it fails, so the rejection tally reads as a funnel.
  const positionsCache = new Map<number, number>();
  const survivors: MinedPattern[] = [];
  for (const [, t] of tallies) {
    if (t.occurrences < minOccurrences) {
      rejected.occurrences++;
      continue;
    }
    if (t.cohorts.size < minCohorts) {
      rejected.cohorts++;
      continue;
    }
    const len = t.symbols.length;
    let positions = positionsCache.get(len);
    if (positions === undefined) {
      positions = positionsFor(len);
      positionsCache.set(len, positions);
    }
    // Expected occurrences under i.i.d. draws from the marginal distribution.
    let expected = positions;
    for (const sym of t.symbols) expected *= (symbolCounts.get(sym) ?? 0) / (totalSymbols || 1);
    const lift = expected > 0 ? t.occurrences / expected : Infinity;
    if (lift < minLift) {
      rejected.lift++;
      continue;
    }
    const cohortSample = [...t.cohorts].sort().slice(0, maxCohortSample);
    survivors.push({
      symbols: t.symbols,
      occurrences: t.occurrences,
      cohorts: t.cohorts.size,
      cohortSample,
      bursts: t.bursts.size,
      lift,
      strength: strengthOf(lift, len),
      support: positions > 0 ? t.occurrences / positions : 0,
    });
  }

  // Maximality: drop a pattern whose occurrences are essentially all accounted
  // for by a longer surviving pattern that CONTAINS it as a contiguous run.
  let patterns = survivors;
  if (maximalOnly && survivors.length > 1) {
    const byLength = new Map<number, MinedPattern[]>();
    for (const p of survivors) {
      const list = byLength.get(p.symbols.length);
      if (list) list.push(p);
      else byLength.set(p.symbols.length, [p]);
    }
    const kept: MinedPattern[] = [];
    for (const p of survivors) {
      let bestExtensionOccurrences = 0;
      for (let len = p.symbols.length + 1; len <= maxLength; len++) {
        for (const longer of byLength.get(len) ?? []) {
          if (containsRun(longer.symbols, p.symbols)) {
            bestExtensionOccurrences = Math.max(bestExtensionOccurrences, longer.occurrences);
          }
        }
      }
      if (bestExtensionOccurrences >= p.occurrences * subsumptionRatio) {
        rejected.subsumed++;
        continue;
      }
      kept.push(p);
    }
    patterns = kept;
  }

  // Rank by STRENGTH (length-normalized lift), not raw lift: raw lift compounds
  // with length, so sorting on it returns the longest patterns rather than the
  // most surprising ones. Cohort breadth then occurrences break ties, and the
  // key makes the order total and reproducible.
  patterns.sort(
    (a, b) =>
      b.strength - a.strength ||
      b.cohorts - a.cohorts ||
      b.occurrences - a.occurrences ||
      keyOf(a.symbols).localeCompare(keyOf(b.symbols)),
  );

  return {
    patterns,
    stats: {
      bursts: seqs.length,
      events: totalSymbols,
      cohorts: cohortSet.size,
      distinctSymbols: symbolCounts.size,
      candidatesConsidered,
      rejected,
    },
  };
}

/** True iff `needle` appears as a CONTIGUOUS run inside `haystack`. */
export function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length > haystack.length) return false;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Convenience: segment then mine in one call, for the common case where the
 * caller holds a flat event stream.
 */
export function minePatternsFromEvents(
  events: readonly SequenceEvent[],
  segment: SegmentPolicy,
  pattern: PatternPolicy = {},
): MineResult {
  return minePatterns(segmentBursts(events, segment), pattern);
}
