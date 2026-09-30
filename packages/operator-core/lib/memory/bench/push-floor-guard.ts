/**
 * push-floor-guard.ts — the DIRECT push-path precision-floor probe
 * (context-injection-audit-2026-07-28 P-002).
 *
 * P-002 is "the test whose absence let a 0.45 floor run at 0.03 for months". It
 * asserts two things about the PUSH path, against the REAL corpus:
 *
 *   (a) a deliberately off-topic query admits ZERO entries, and
 *   (b) no admitted entry scores below the configured cosine floor.
 *
 * Both are easy to write in a form that passes vacuously, and every trap below
 * has already fired at least once on this plan. This module exists to make the
 * honest version the easy one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TRAP 1 — (b) CANNOT BE ASSERTED ON THE RETURNED SCORE. This is D-001's
 * retracted headline, mechanically: `fuse()` OVERWRITES `entry.score` with the
 * RRF score (hybrid-fusion.ts:158-159), so what `search()` returns is on the
 * `rrf` scale — max ~1/61 ≈ 0.0164 per leg — while the floor is a `cosine`
 * value of 0.45. `entry.score >= 0.45` is therefore not a strict test of the
 * floor; it is a comparison between two different scales that can only ever
 * fail, and its inverse can only ever pass. The plan's original "the floor is
 * absent on every push path" headline WAS this confusion, and D-054 exists
 * because the same conflation reappeared in telemetry.
 *
 * So (b) is evaluated against an INDEPENDENT unfloored probe of the cosine leg:
 * we ask the cosine leg for its own `cosine`-scaled score for each admitted
 * entry and check THAT against the floor. The backends declare their scale
 * (`MemoryBackend.scoreScale`), so {@link assertProbeScales} enforces the
 * pairing structurally rather than by comment — a future wiring that hands this
 * probe an `rrf` backend as the "cosine leg" fails loudly instead of silently
 * measuring nonsense.
 *
 * Independence is the point: the probe does not ask the code under test whether
 * it applied the floor, it re-derives the ground truth and checks the result.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TRAP 2 — (a) PASSES PERFECTLY AGAINST AN EMPTY CORPUS. "Off-topic returns
 * zero" is also what a failed seed, a cold embedder, an unavailable backend and
 * a wrong scope all return. EI-10793 is exactly this: 114/114 seeds failed and
 * three consecutive all-zero runs were recorded as legitimate measurements while
 * nothing alarmed. A guard that cannot tell "the floor rejected it" from
 * "nothing was there to admit" asserts nothing at all.
 *
 * Hence {@link PushFloorProbeResult.positiveControl} and the ordering rule this
 * module enforces on its callers: the ON-TOPIC control is checked FIRST, and the
 * off-topic verdict is only meaningful if the control shows the same path
 * admitting real hits over the same corpus in the same run. This is the
 * discipline that closed P-047 (null control read before any arm) applied to a
 * guard instead of an experiment.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TRAP 3 — A FROZEN COPY OF THE FLOORS TESTS NOTHING. The values come from
 * {@link pushSearchFloors}, the same exported constructor `buildBlockInner`
 * calls — not from re-declared constants. `bench/precision-monitor.ts` shows the
 * cost of the alternative: it hardcodes `fusionMode: 'floored-union'` while
 * calling itself "the EXACT production push floor", and has been measuring a
 * shape production stopped running when D-010 flipped the default to
 * `cosine-gated`.
 *
 * ⚠ Do NOT reformulate any of this against the turn-start zero-hit rate. D-054
 * measured that proxy pinned at its cap (99.6% of recalls return exactly the
 * limit), so a guard built on it passes vacuously — which is the precise failure
 * mode P-002 exists to prevent.
 */
import type { MemoryBackend, MemoryEntry } from '@papercusp/memory';

import type { PushSearchFloors } from '../injection';

/** One probe stimulus. `expectEmpty` marks the off-topic (hard-negative) class. */
export interface FloorProbeQuery {
  id: string;
  query: string;
  /** Gold-set class, carried through for reporting. */
  className: string;
  /** True for the hard-negative class — the off-topic stimulus of assertion (a). */
  expectEmpty: boolean;
}

/** An entry the push path ADMITTED, with the fused (rrf-scale) score it carried. */
export interface AdmittedEntry {
  id: string;
  text: string;
  scope?: string;
  /** The FUSED score — `rrf` scale. Never compare this to a cosine floor. */
  fusedScore: number | undefined;
}

export type FloorViolationKind =
  /** The cosine leg's own score for this entry is below the floor. */
  | 'below-cosine-floor'
  /**
   * The entry is not in the unfloored cosine result at all, so no cosine score
   * exists for it — the signature of a LEXICAL-ONLY admission, which is
   * `floored-union` re-admitting what the cosine floor rejected (D-010).
   */
  | 'no-cosine-score';

export interface FloorViolation {
  queryId: string;
  entryId: string;
  kind: FloorViolationKind;
  /** The cosine-scale score, or null when the entry had none. */
  cosineScore: number | null;
  floor: number;
  /** Truncated, for a readable failure message. */
  text: string;
}

export interface OffTopicOutcome {
  queryId: string;
  query: string;
  admitted: number;
  /** The admitted entries — non-empty here IS the (a) failure, and its evidence. */
  entries: AdmittedEntry[];
}

export interface PositiveControl {
  /** On-topic queries run through the SAME path in the SAME run. */
  queries: number;
  /** How many admitted at least one entry. */
  withHits: number;
  /** Mean admitted count over the on-topic queries. */
  meanAdmitted: number;
}

/**
 * The SEPARATION reading (D-056's decisive follow-up): the distribution of each
 * class's TOP cosine score.
 *
 * Knowing that off-topic queries are admitted does not say whether ANY floor
 * could reject them. That is a property of the corpus + embedder, not of the
 * code — and `score-floor.ts`'s header states the premise D-006 calibrated 0.45
 * on: hard negatives topped ~0.385 while real hits sat ~0.51–0.58, so 0.45 sat
 * in the gap. If the two ranges now OVERLAP, no threshold separates them and
 * P-002's literal "returns ZERO" criterion is unsatisfiable at any floor — which
 * is a re-derivation of the criterion, not a bug to fix.
 *
 * Reported per class so the on-topic floor (what a raise would COST in recall)
 * and the hard-negative ceiling (what it would BUY in precision) are read
 * together. A raise is only sound where the hard-negative ceiling sits below the
 * on-topic floor.
 */
export interface ClassScoreSpread {
  className: string;
  queries: number;
  /** Top cosine score per query, ascending — the raw material for a sweep. */
  topScores: number[];
  min: number;
  median: number;
  max: number;
}

export interface PushFloorProbeResult {
  backend: string;
  /** The LIVE floors, as read from `pushSearchFloors()`. */
  floors: PushSearchFloors;
  corpusSeeded: number;
  /** Per-class top-cosine spread — the separation reading. */
  spread: ClassScoreSpread[];
  /** Assertion (a): off-topic queries and what they admitted. */
  offTopic: OffTopicOutcome[];
  /** Assertion (b): every admitted entry whose cosine score is missing or below floor. */
  violations: FloorViolation[];
  /** TRAP 2: the instrument-validity check, to be read BEFORE the verdict. */
  positiveControl: PositiveControl;
  /** Total entries admitted across every query, off-topic and on-topic. */
  totalAdmitted: number;
}

/** Normalized-text alias, mirroring `fuse()`'s cross-leg identity rule. */
function norm(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** Summarize per-class top-cosine scores. Pure — unit-tested. */
export function summarizeSpread(byClass: ReadonlyMap<string, number[]>): ClassScoreSpread[] {
  const out: ClassScoreSpread[] = [];
  for (const [className, raw] of byClass) {
    const topScores = [...raw].sort((a, b) => a - b);
    if (topScores.length === 0) continue;
    const mid = Math.floor(topScores.length / 2);
    out.push({
      className,
      queries: topScores.length,
      topScores,
      min: topScores[0]!,
      median:
        topScores.length % 2 === 0 ? (topScores[mid - 1]! + topScores[mid]!) / 2 : topScores[mid]!,
      max: topScores[topScores.length - 1]!,
    });
  }
  return out.sort((a, b) => a.className.localeCompare(b.className));
}

/**
 * Structural enforcement of TRAP 1: the floor is a COSINE value, so the leg we
 * re-derive ground truth from must be on the cosine scale, and the fused path
 * must NOT be (if it were, the two would be the same measurement and the probe
 * would be circular).
 *
 * A comment cannot prevent a future wiring from passing the hybrid in as the
 * "cosine leg" — it would return plausible small numbers, every one of them
 * below 0.45, and the guard would report a catastrophic floor breach that is
 * purely an artifact. Fail loudly at the boundary instead.
 */
export function assertProbeScales(pushBackend: MemoryBackend, cosineLeg: MemoryBackend): void {
  const cosineScale = cosineLeg.scoreScale;
  if (cosineScale !== 'cosine') {
    throw new Error(
      `push-floor-guard: the ground-truth leg must be on the 'cosine' scale, got ` +
        `'${cosineScale ?? 'undefined'}' (backend '${cosineLeg.name}'). The floor is a cosine ` +
        `value; scoring it against another scale measures nothing (D-001).`,
    );
  }
  const pushScale = pushBackend.scoreScale;
  if (pushScale === 'cosine') {
    throw new Error(
      `push-floor-guard: the push backend reports the 'cosine' scale, so it is not a fused ` +
        `path — the probe would be comparing a leg against itself. Wire the production hybrid.`,
    );
  }
}

/**
 * Assertion (b) for ONE query, given the admitted set and an independently
 * derived cosine-score map. Pure, so the violation logic is unit-testable
 * without PG or an embedder.
 *
 * Entry identity follows `fuse()`: an admitted entry is matched to its cosine
 * score by id first, then by normalized text. Both are needed because the legs
 * assign DIFFERENT native ids to the same memory, and the fused entry may carry
 * either leg's id (hybrid-fusion.ts §CROSS-LEG IDENTITY). Matching by id alone
 * would report every lexical-origin entry as `no-cosine-score` — a false
 * violation that reads exactly like the real bug.
 */
export function evaluateFloorViolations(
  queryId: string,
  admitted: readonly AdmittedEntry[],
  cosineScores: ReadonlyMap<string, number>,
  floor: number | undefined,
): FloorViolation[] {
  // No floor configured is a legitimate state (env `<= 0` disables it) and it
  // makes (b) inapplicable rather than passing — the caller asserts on the
  // floors themselves.
  if (floor === undefined) return [];
  const violations: FloorViolation[] = [];
  for (const entry of admitted) {
    const byId = cosineScores.get(entry.id);
    const byText = entry.text ? cosineScores.get(norm(entry.text)) : undefined;
    const cosine = byId ?? byText;
    if (cosine === undefined) {
      violations.push({
        queryId,
        entryId: entry.id,
        kind: 'no-cosine-score',
        cosineScore: null,
        floor,
        text: entry.text.slice(0, 120),
      });
    } else if (cosine < floor) {
      violations.push({
        queryId,
        entryId: entry.id,
        kind: 'below-cosine-floor',
        cosineScore: cosine,
        floor,
        text: entry.text.slice(0, 120),
      });
    }
  }
  return violations;
}

/** Build the id+text → cosine-score map from an UNFLOORED cosine-leg result. */
export function cosineScoreMap(hits: readonly MemoryEntry[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const hit of hits) {
    if (typeof hit.score !== 'number') continue;
    // First (best) score per alias wins, matching fuse()'s first-rank rule.
    if (hit.id && !map.has(hit.id)) map.set(hit.id, hit.score);
    const text = hit.text ? norm(hit.text) : '';
    if (text && !map.has(text)) map.set(text, hit.score);
  }
  return map;
}

export interface ProbeDeps {
  /** The production fused push backend (hybrid-pg). */
  backend: MemoryBackend;
  /** The SAME cosine leg, probed unfloored for independent ground truth. */
  cosineLeg: MemoryBackend;
  scope: string;
  queries: readonly FloorProbeQuery[];
  /** The live push floors — pass `pushSearchFloors()`. */
  floors: PushSearchFloors;
  /** The push path's own `INJECTION_TOTAL_LIMIT`. */
  limit: number;
  /** How deep to pull the unfloored cosine probe (>= corpus size is safest). */
  cosineProbeLimit: number;
  corpusSeeded: number;
}

/**
 * Run the probe: every query through the REAL push admission contract, plus an
 * unfloored cosine probe per query for the (b) ground truth.
 *
 * Note what is NOT abstracted away: the push search is `backend.search()` with
 * exactly the options `buildBlockInner` passes — same floors, same fusion mode,
 * same total limit. `runGoldSet` is deliberately not reused; it discards the
 * individual hits (keeping only `rawHits`/`topScore`), and the per-entry scores
 * are the whole substance of assertion (b).
 */
export async function probePushFloor(deps: ProbeDeps): Promise<PushFloorProbeResult> {
  assertProbeScales(deps.backend, deps.cosineLeg);

  const offTopic: OffTopicOutcome[] = [];
  const violations: FloorViolation[] = [];
  const spreadByClass = new Map<string, number[]>();
  let onTopicQueries = 0;
  let onTopicWithHits = 0;
  let onTopicAdmitted = 0;
  let totalAdmitted = 0;

  for (const q of deps.queries) {
    const hits = await deps.backend.search(q.query, {
      scope: deps.scope,
      limit: deps.limit,
      ...(deps.floors.minScore !== undefined ? { minScore: deps.floors.minScore } : {}),
      ...(deps.floors.minLexScore !== undefined ? { minLexScore: deps.floors.minLexScore } : {}),
      fusionMode: deps.floors.fusionMode,
    });
    const admitted: AdmittedEntry[] = hits.map((h) => ({
      id: h.id,
      text: h.text ?? '',
      ...(h.scope !== undefined ? { scope: h.scope } : {}),
      fusedScore: typeof h.score === 'number' ? h.score : undefined,
    }));
    totalAdmitted += admitted.length;

    // The independent ground truth for (b). Pulled UNFLOORED (no minScore) and
    // deep, so an admitted entry is absent from this map only when the cosine
    // leg genuinely did not return it — i.e. a lexical-only admission — rather
    // than because the probe truncated the tail.
    // Run UNCONDITIONALLY, not just when something was admitted: the separation
    // reading needs the top cosine score for EVERY query, and a query that
    // admitted nothing is exactly the one whose score says why.
    const cosineHits = await deps.cosineLeg.search(q.query, {
      scope: deps.scope,
      limit: deps.cosineProbeLimit,
    });
    const top = cosineHits.find((h) => typeof h.score === 'number')?.score;
    if (typeof top === 'number') {
      const bucket = spreadByClass.get(q.className) ?? [];
      bucket.push(top);
      spreadByClass.set(q.className, bucket);
    }
    if (admitted.length > 0) {
      violations.push(
        ...evaluateFloorViolations(q.id, admitted, cosineScoreMap(cosineHits), deps.floors.minScore),
      );
    }

    if (q.expectEmpty) {
      offTopic.push({ queryId: q.id, query: q.query, admitted: admitted.length, entries: admitted });
    } else {
      onTopicQueries += 1;
      onTopicAdmitted += admitted.length;
      if (admitted.length > 0) onTopicWithHits += 1;
    }
  }

  return {
    backend: deps.backend.name,
    floors: deps.floors,
    corpusSeeded: deps.corpusSeeded,
    spread: summarizeSpread(spreadByClass),
    offTopic,
    violations,
    positiveControl: {
      queries: onTopicQueries,
      withHits: onTopicWithHits,
      meanAdmitted: onTopicQueries === 0 ? 0 : onTopicAdmitted / onTopicQueries,
    },
    totalAdmitted,
  };
}

/**
 * The instrument-validity verdict (TRAP 2), to be asserted BEFORE the floor
 * verdict. Returns a reason when the run cannot support any conclusion.
 *
 * The bar is deliberately low — this is not a recall measurement, it only
 * establishes that the path retrieves SOMETHING over this corpus, so that a
 * zero from an off-topic query is attributable to the floor.
 */
export function positiveControlFailure(
  result: PushFloorProbeResult,
  minWithHitsRatio = 0.5,
): string | null {
  if (result.corpusSeeded === 0) {
    return 'corpus seeded 0 entries — an empty corpus satisfies assertion (a) vacuously (EI-10793)';
  }
  if (result.positiveControl.queries === 0) {
    return 'no on-topic queries in the probe set — assertion (a) has no validity control';
  }
  const ratio = result.positiveControl.withHits / result.positiveControl.queries;
  if (ratio < minWithHitsRatio) {
    return (
      `positive control FAILED: only ${result.positiveControl.withHits}/${result.positiveControl.queries} ` +
      `on-topic queries admitted anything (${(ratio * 100).toFixed(1)}% < ${(minWithHitsRatio * 100).toFixed(0)}%). ` +
      `The push path is not retrieving over this corpus, so a zero on an off-topic query measures ` +
      `the instrument, not the floor.`
    );
  }
  return null;
}

/** Human-readable one-line summary for a report or a failure message. */
export function summarizeProbe(result: PushFloorProbeResult): string {
  const nonEmpty = result.offTopic.filter((o) => o.admitted > 0);
  return (
    `backend=${result.backend} floors=cos:${result.floors.minScore ?? 'off'}/` +
    `lex:${result.floors.minLexScore ?? 'off'}/${result.floors.fusionMode} ` +
    `corpus=${result.corpusSeeded} · off-topic ${result.offTopic.length} queries, ` +
    `${nonEmpty.length} admitted something · violations=${result.violations.length} · ` +
    `positive control ${result.positiveControl.withHits}/${result.positiveControl.queries} ` +
    `(mean ${result.positiveControl.meanAdmitted.toFixed(2)} admitted)`
  );
}

/**
 * The separation verdict, in the form the next decision needs: does the
 * hard-negative CEILING sit below the on-topic FLOOR? Only then does a floor
 * raise separate the classes rather than just trading recall for precision.
 */
export function summarizeSeparation(
  result: PushFloorProbeResult,
  offTopicClass = 'hard-negative',
): string {
  const neg = result.spread.find((s) => s.className === offTopicClass);
  const pos = result.spread.filter((s) => s.className !== offTopicClass);
  const lines = result.spread.map(
    (s) => `    ${s.className.padEnd(20)} n=${String(s.queries).padStart(3)} ` +
      `min=${s.min.toFixed(4)} median=${s.median.toFixed(4)} max=${s.max.toFixed(4)}`,
  );
  let verdict = '    (no hard-negative class in this probe set)';
  if (neg && pos.length > 0) {
    const posFloor = Math.min(...pos.map((s) => s.min));
    verdict =
      neg.max < posFloor
        ? `    SEPARABLE: hard-negative max ${neg.max.toFixed(4)} < on-topic min ${posFloor.toFixed(4)} ` +
          `— a floor in that gap rejects every hard negative at zero recall cost.`
        : `    NOT SEPARABLE BY ANY FLOOR: hard-negative max ${neg.max.toFixed(4)} >= on-topic min ` +
          `${posFloor.toFixed(4)}. The classes OVERLAP, so no single cosine threshold admits every ` +
          `real hit while rejecting every hard negative — "off-topic admits ZERO" is unsatisfiable ` +
          `at any floor, and the honest target is a bounded FP rate.`;
  }
  return `top-cosine spread by class:\n${lines.join('\n')}\n${verdict}`;
}
