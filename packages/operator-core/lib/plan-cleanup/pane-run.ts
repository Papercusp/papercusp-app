/**
 * Which plan-cleanup run the Plans pane shows when no run is deep-linked
 * (`?opcln=` absent) — WI-10004730.
 *
 * The pane used to show `getLatestRun`: the newest run of ANY phase. A newer
 * terminal run (a failed single-plan run, say) then hid an older run still in
 * `review` with recommendations waiting on the owner, so the work that needed a
 * human vanished from the only surface that offers it. The pane's question is
 * "what needs me", so an open run (pending / running / review — the
 * `getActiveRun` set) wins; only when none is open does it fall back to the
 * newest run, so a just-finished or just-failed run still reports itself.
 *
 * Deps are injected so the ordering rule is testable without Postgres.
 */
import type { BulkRunRow } from '../attention/bulk-run-store';

export interface PaneRunDeps {
  /** Newest pending/running/review plan-cleanup run, or null. */
  getActive: () => Promise<BulkRunRow | null>;
  /** Newest plan-cleanup run of any phase, or null. */
  getLatest: () => Promise<BulkRunRow | null>;
}

export async function selectPlanCleanupPaneRun(deps: PaneRunDeps): Promise<BulkRunRow | null> {
  const active = await deps.getActive();
  if (active) return active;
  return deps.getLatest();
}
