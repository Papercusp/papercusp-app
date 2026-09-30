/**
 * Boot guard: every DECLARED learning singleton must actually have a routine row (EI-10625).
 *
 * THE FAILURE THIS CATCHES — and why nothing else could:
 *
 * Adding a loop to `LEARNING_SINGLETONS` did not schedule it. The materializer had exactly
 * one caller (a one-shot platform-mode enablement), so a loop registered afterwards got no
 * routine row and never fired. Registering a loop *looked* complete — the list entry, the
 * blueprint, the flag, the tables, the health line all existed — and the one step that makes
 * it RUN was a CLI somebody had to remember to re-run. `memory-precision` has a row only
 * because someone did, on 2026-06-30. The memory recall canary (EI-10047) was added after
 * that; nobody re-ran anything; it was DEAD ON ARRIVAL and stayed dark for its entire life —
 * 0 routine rows, 0 runs — on the 10,491-memory store it was built to watch. No error, no
 * warning, nothing to look at.
 *
 * ITS SIBLING GUARD CANNOT SEE THIS. `validateActiveRoutines` scans the routines that EXIST
 * and checks each one resolves. A loop that was never materialized HAS NO ROW, so it is
 * invisible to any check that iterates rows: YOU CANNOT FIND A MISSING ROW BY LOOKING AT THE
 * ROWS YOU HAVE. The only way to see an absence is to diff against the DECLARATION — which is
 * what this does.
 *
 * PURE-READ AND NON-BLOCKING, like `validateActiveRoutines`: it reports, never writes, and
 * never breaks boot. Healing is an explicit, human-run act:
 *
 *   tsx packages/operator-core/lib/blueprint/seed-learning-singletons.ts --reconcile --execute
 *
 * (Deliberately NOT auto-healed at boot: silently re-creating routine rows would resurrect a
 * loop an operator had deliberately deleted. Loud detection is the recurrence guard; the write
 * stays a decision.)
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { reconcileLearningSingletons } from '../blueprint/seed-learning-singletons';

export interface DeclaredSingletonValidation {
  ok: boolean;
  /** Declared loops that are EXPECTED to have a routine row and have none — they will never run. */
  missing: string[];
  /** How many declared singletons were checked. */
  checked: number;
}

/**
 * Diff the DECLARED learning singletons against the routine rows that exist. Loops that are
 * absent by design (a Class-C platform loop while `PLATFORM_IMPROVEMENT_LOOPS` is off) are
 * excluded — their absence is intended, and alarming on them every release would be its own
 * cry-wolf failure.
 */
export async function validateDeclaredSingletons(workspaceId?: string): Promise<DeclaredSingletonValidation> {
  const ws = workspaceId ?? activeWorkspaceId();
  const { sql } = getOrgPg();

  const result = await reconcileLearningSingletons(sql, ws, { execute: false });
  const missing = result.missing;

  if (missing.length > 0) {
    // FATAL-class: each of these is a loop that was built, registered, and will never run —
    // and whose silence is indistinguishable from health. That is exactly how EI-10047 rotted.
    console.error(
      `[declared-singletons] FATAL: ${missing.length} learning loop(s) are DECLARED but have no ` +
        `routine row — they have never run and never will: ${missing.join(', ')}. ` +
        `Heal with: seed-learning-singletons.ts --reconcile --execute`,
    );
  }

  return { ok: missing.length === 0, missing, checked: result.entries.length };
}
