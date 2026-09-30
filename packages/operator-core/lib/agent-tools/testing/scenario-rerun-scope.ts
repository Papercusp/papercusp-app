/**
 * SPEC-P006-FAILED-SCENARIO-RERUN@1 — how wide a failed-scenario rerun has to be.
 *
 * "A failed scenario rerun starts only the failed scenario when applicable evidence for the
 * remaining matrix is still current."
 *
 * A name-filtered rerun executes ONE scenario while the binding it settles claims every id
 * in `scenarioIds`. Vitest reports the unmatched siblings as `skipped`, and those exclusions
 * are deliberately not read as skipped evidence (see `testEvidenceOutcome`) — they are not
 * evidence in either direction. So the narrow run's proof over the remaining matrix is
 * CARRIED from whatever a previous run recorded, never re-measured. That carry is sound only
 * while the previous row's fingerprints still match what is on disk now; once they diverge it
 * is the falsifier's second arm verbatim — "stale remaining evidence is reused".
 *
 * This is deliberately a pure function over already-read values: the decision is the part
 * that has to be falsifiable, and a probe should not have to stand up a ledger to exercise it.
 */

/** Which fingerprint dimension went stale. Named so a refusal says WHAT moved. */
export type SiblingEvidenceDimension = 'source' | 'test';

export type ScenarioRerunScope = {
  /**
   * `failed-scenario` — narrowing is sound; the remaining matrix may be carried.
   * `full-matrix`     — the carry is unsound; the whole matrix has to re-run before this
   *                     binding can count as proof.
   */
  scope: 'failed-scenario' | 'full-matrix';
  reason: 'sibling-evidence-current' | 'stale-sibling-evidence' | 'no-sibling-evidence';
  /**
   * The scenario ids whose proof this narrowed run CARRIES rather than re-measures. Empty
   * whenever the carry was refused — nothing is being leaned on in that case.
   */
  carried: string[];
  /** Non-empty only for `stale-sibling-evidence`; says which dimension diverged. */
  stale: SiblingEvidenceDimension[];
};

type Fingerprints = {
  sourceFingerprint?: string | null | undefined;
  testFingerprint?: string | null | undefined;
};

/**
 * Returns `null` when the question does not arise — NOT a permissive default:
 *  - no active name filter: the whole file ran, so nothing is carried; and
 *  - fewer than two scenario ids: there is no "remaining matrix" to carry.
 * Both are the ordinary cheap rerun R-8 exists to enable, and widening them would cost the
 * saving this plan is about.
 */
export function resolveScenarioRerunScope(opts: {
  scenarioIds?: readonly string[] | null | undefined;
  testNamePattern?: string | null | undefined;
  priorEvidence?: Fingerprints | null | undefined;
  current: Fingerprints;
}): ScenarioRerunScope | null {
  const pattern = typeof opts.testNamePattern === 'string' ? opts.testNamePattern.trim() : '';
  if (pattern.length === 0) return null;

  const scenarioIds = (opts.scenarioIds ?? []).filter(
    (id): id is string => typeof id === 'string' && id.trim().length > 0,
  );
  if (scenarioIds.length < 2) return null;

  const prior = opts.priorEvidence;
  const priorSource = typeof prior?.sourceFingerprint === 'string' ? prior.sourceFingerprint : '';
  if (priorSource.length === 0) {
    // Absence of sibling evidence is not currency. Nothing was ever recorded for the
    // remaining scenarios, so there is no prior measurement to carry and the narrowed run
    // measures strictly less than the binding claims. Reading this as "current" is the
    // same false-negative shape as an empty grep read as proof of absence.
    return { scope: 'full-matrix', reason: 'no-sibling-evidence', carried: [], stale: [] };
  }

  const stale: SiblingEvidenceDimension[] = [];
  if (priorSource !== (opts.current.sourceFingerprint ?? null)) stale.push('source');
  // A missing fingerprint on EITHER side cannot establish currency, so `null !== 'x'` and
  // `'x' !== null` both count as stale rather than being skipped as "not comparable".
  if ((prior?.testFingerprint ?? null) !== (opts.current.testFingerprint ?? null)) stale.push('test');
  if (stale.length > 0) return { scope: 'full-matrix', reason: 'stale-sibling-evidence', carried: [], stale };

  return { scope: 'failed-scenario', reason: 'sibling-evidence-current', carried: scenarioIds, stale: [] };
}
