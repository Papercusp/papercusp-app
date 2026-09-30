/**
 * Learning POT GATE — the PURE half of the per-pot learning gate
 * (plan learning-pot-scope-gate-2026-08-30, P-001 / D-001).
 *
 * ⚠ NOT `../pot-scope.ts`, despite the table being named learning_pot_scope.
 * That sibling answers "which pot does this learning row BELONG to" (a writer's
 * attribution resolver, plan pot-scope-all-learnings-2026-07-26). This module
 * answers "may learning RUN for this pot at all" — a gate, not an attribution.
 * The two are used together: a lane resolves its pot with pot-scope.ts, then
 * asks this module whether that pot is switched on.
 *
 * One row per (workspace_id, pot_slug) says whether learning may run for that
 * pot AT ALL. Every learning lane's preflight ANDs this with its own arming:
 *
 *     lane runs  ⟺  potLearningEnabled(pot)  AND  <the lane's existing gate>
 *
 * It never writes a lane's own row, which is what makes switching a pot off and
 * back on lossless: each lane keeps its arming, so the restore revives exactly
 * the lanes that were armed before and nothing that was deliberately parked.
 *
 * ## ABSENT ROW MEANS ENABLED
 *
 * The table ships EMPTY and every reader treats a missing row as enabled
 * (plan R-5), so the gate is inert until someone explicitly switches a pot off.
 * This is the OPPOSITE posture from `learningGovernorPreflight`, which fails
 * CLOSED — that one protects spend against a broken ledger, whereas an
 * unreadable pot row must not become a fleet-wide learning outage. The
 * asymmetry is intentional; do not "fix" it into symmetry.
 *
 * SQL lives in ./store.ts; this module is dependency-free so the fail-open
 * default is unit-testable without a database.
 */

/** One stored gate row. `enabled:false` is the only state the table records. */
export interface PotLearningScope {
  workspaceId: string;
  potSlug: string;
  /** false = no learning lane may run for this pot, whatever its own arming says. */
  enabled: boolean;
  /** Who last flipped it — an ownerId, or a human identity. */
  setBy: string | null;
  /** Epoch ms. */
  setAt: number;
}

/**
 * The refusal reason every lane reports when the pot gate is off. P-002 adds it
 * to the governor's refusal union; gym (P-003) and scout (P-004) gate natively
 * and use this same string so one vocabulary covers all three lanes.
 */
export const POT_DISABLED_REASON = 'pot-disabled' as const;
export type PotDisabledReason = typeof POT_DISABLED_REASON;

/**
 * THE fail-open default, in one place: a pot is enabled unless a row explicitly
 * says otherwise. Null/undefined (no row) and a row with `enabled:true` are both
 * enabled; only a stored `enabled:false` gates.
 */
export function potScopeEnabled(row: { enabled: boolean } | null | undefined): boolean {
  return row?.enabled !== false;
}

/**
 * Collapse stored rows into the set of pots that are switched OFF. The enabled
 * set is answered by ABSENCE, so this is the only set worth materializing — it
 * is what the rail's count and the picker's summary render, and it matches the
 * partial index the migration ships.
 */
export function disabledPotSet(rows: readonly PotLearningScope[]): Set<string> {
  const off = new Set<string>();
  for (const r of rows) if (r.enabled === false) off.add(r.potSlug);
  return off;
}

/**
 * Resolve a whole batch of pots against stored rows without a per-pot query —
 * the shape the UI read (P-005) and the gym pool filter (P-003) both want.
 * Every requested slug appears in the result; unknown slugs resolve to enabled.
 */
export function potScopeLookup(rows: readonly PotLearningScope[]): (potSlug: string) => boolean {
  const off = disabledPotSet(rows);
  return (potSlug: string) => !off.has(potSlug);
}
