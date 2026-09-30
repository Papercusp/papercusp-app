/**
 * Composite release-profile schema — types.
 *
 * A "release profile" aggregates named COMPONENTS (each a rubric verdict, a hard
 * operational gate, or any other pass/fail/unknown check) into ONE go/no-go verdict,
 * with per-component evidence provenance. The evaluator (./evaluate.ts) enforces two
 * policies UNIFORMLY across every component, so no individual checker has to
 * reimplement them:
 *
 *   - STALENESS — a component whose evidence is older than its configured `maxAgeMs`
 *     stops counting as a pass, however green the checker's own read was.
 *   - LINEAGE   — a component that stamps its evidence with a lineage identity (e.g. a
 *     candidate sha / running generation) is checked against the profile's
 *     `expectedLineage`; a mismatch means the evidence graded a DIFFERENT candidate
 *     than the one being judged, and can never authorize GO.
 *
 * Zero I/O, zero domain coupling: the caller supplies `check()` functions that do the
 * actual measuring (querying a rubric store, running a gate, …) and injects them as
 * `ComponentSpec`s; this module only combines the results. See ../README.md for the
 * seam and a worked example.
 */

/** What a component's own checker can report. The evaluator may additionally derive
 *  'stale' or 'lineage-mismatch' from policy — a checker never emits those itself. */
export type ComponentRawVerdict = 'pass' | 'fail' | 'unknown';

/** The full verdict vocabulary a profile's evaluated component can carry. */
export type ComponentVerdict = ComponentRawVerdict | 'stale' | 'lineage-mismatch';

/** One piece of evidence backing a component's verdict — the exact provenance a
 *  GO/NO-GO reader can drill back into (never just "trust me"). */
export interface EvidenceRef {
  /** Stable pointer into the source-of-truth (an issue id, a run id, a commit sha, …). */
  ref: string;
  /** Free-form provenance kind, e.g. 'scorecard' | 'gate-run' | 'git-commit'. */
  kind?: string;
  /** Bounded structured detail (counts, thresholds, …) — kept JSON-shaped for diversity. */
  detail?: Record<string, unknown>;
}

/**
 * A lineage identity a component's evidence was measured against. Compared
 * field-by-field (see `lineageMismatches`): a field present on BOTH sides must match; a
 * field missing (null/undefined) on EITHER side is not judged — an evaluator lacking an
 * opinion about a field must never manufacture a mismatch from its absence.
 */
export interface LineageStamp {
  sha?: string | null;
  generation?: string | null;
  [key: string]: string | null | undefined;
}

/** What ONE component's checker reports — the raw measurement, before the evaluator
 *  applies the staleness/lineage policy. */
export interface ComponentCheckResult {
  verdict: ComponentRawVerdict;
  reason: string;
  /** ISO timestamp the measurement was taken. Required — staleness can't be judged
   *  without it; a checker that genuinely doesn't know "when" should report 'unknown'
   *  with `measuredAt` set to the read time instead of omitting it. */
  measuredAt: string;
  evidence: EvidenceRef[];
  /** The lineage this evidence was measured against, when the component tracks one.
   *  Omit/null when the component carries no lineage identity. */
  lineage?: LineageStamp | null;
}

/** One component's declaration: identity + policy + how to measure it. */
export interface ComponentSpec {
  key: string;
  title: string;
  /** true ⇒ a non-'pass' verdict on this component refuses profile GO. false ⇒
   *  advisory: always reported, never blocks GO. */
  mandatory: boolean;
  /** Evidence older than this (vs the evaluator's `now`) fails the component as
   *  'stale', regardless of its raw verdict. Omit for no staleness policy on this
   *  component (rare — most release-gating evidence ages). */
  maxAgeMs?: number;
  check(): Promise<ComponentCheckResult>;
}

export interface ReleaseProfileSpec {
  /** Stable id for this profile (e.g. 'public-release-readiness'). */
  profileRef: string;
  components: ComponentSpec[];
  /** The lineage the WHOLE profile is being judged against (e.g. the candidate sha /
   *  running generation). Omit to skip lineage checking entirely — every component
   *  then evaluates on raw verdict + staleness only. */
  expectedLineage?: LineageStamp;
}

/** One component's evaluated outcome — the policy-applied verdict + the evidence that
 *  produced it, kept alongside for audit. */
export interface ComponentEvaluation {
  key: string;
  title: string;
  mandatory: boolean;
  verdict: ComponentVerdict;
  reason: string;
  measuredAt: string;
  evidence: EvidenceRef[];
  lineage?: LineageStamp | null;
}

export interface ReleaseProfileVerdict {
  profileRef: string;
  evaluatedAt: string;
  /** true only when EVERY mandatory component evaluated to 'pass'. A profile with zero
   *  components, or zero MANDATORY components, is refused by construction (see
   *  evaluateReleaseProfile) — nothing to check can never authorize GO. */
  go: boolean;
  /** Human-readable rollup: why GO, or exactly which mandatory component(s) blocked it. */
  reason: string;
  components: ComponentEvaluation[];
}
