/**
 * Pure policy helpers for the mug/kettle entry-point baseline.
 *
 * The guard treats baseline entries as a set, so duplicate rows from a census
 * run must not hide a shrinking population. Keeping the comparison here makes
 * the write-side policy easy to test without running the whole repository scan.
 */

export function normalizeBaselineEntries(entries) {
  return [...new Set(
    (Array.isArray(entries) ? entries : [])
      .filter((entry) => typeof entry === 'string' && entry.length > 0),
  )].sort();
}

/**
 * Compare the measured population with the outgoing baseline.
 *
 * A reason is required only when the measured set shrinks. Additions and
 * replacements remain visible in the returned diff so callers can record the
 * complete reseed decision, even when the count did not fall.
 */
export function evaluateBaselineReseed({
  previousEntries = [],
  currentEntries = [],
  reason = '',
} = {}) {
  const previous = normalizeBaselineEntries(previousEntries);
  const current = normalizeBaselineEntries(currentEntries);
  const previousSet = new Set(previous);
  const currentSet = new Set(current);
  const removedEntries = previous.filter((entry) => !currentSet.has(entry));
  const addedEntries = current.filter((entry) => !previousSet.has(entry));
  const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
  const shrunk = current.length < previous.length;

  return {
    previousEntries: previous,
    currentEntries: current,
    previousEntryCount: previous.length,
    nextEntryCount: current.length,
    removedEntries,
    addedEntries,
    shrunk,
    reason: normalizedReason || null,
    reasonRequired: shrunk,
    accepted: !shrunk || normalizedReason.length > 0,
  };
}

/**
 * Build the next baseline document without performing I/O.
 *
 * Existing policy/provenance fields are preserved. `lastReseed` is deliberately
 * a structured audit record rather than a prose-only timestamp: a later reader
 * can see what changed and why the population was allowed to shrink.
 */
export function buildBaselineDocument({
  baseline = {},
  currentEntries = [],
  reason = '',
  generatedAt = new Date().toISOString(),
} = {}) {
  const evaluation = evaluateBaselineReseed({
    previousEntries: baseline?.entries,
    currentEntries,
    reason,
  });

  if (!evaluation.accepted) {
    const error = new Error(
      `baseline reseed would shrink from ${evaluation.previousEntryCount} to ` +
        `${evaluation.nextEntryCount} entries; pass --reason to justify the drop`,
    );
    error.code = 'RESEED_REASON_REQUIRED';
    error.evaluation = evaluation;
    throw error;
  }

  return {
    ...baseline,
    generatedAt,
    entries: evaluation.currentEntries,
    lastReseed: {
      at: generatedAt,
      reason: evaluation.reason,
      previousEntryCount: evaluation.previousEntryCount,
      nextEntryCount: evaluation.nextEntryCount,
      removedEntries: evaluation.removedEntries,
      addedEntries: evaluation.addedEntries,
    },
  };
}
