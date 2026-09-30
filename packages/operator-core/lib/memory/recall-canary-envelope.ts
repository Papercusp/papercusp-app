/**
 * recall-canary-envelope.ts — the settings-page read of the live recall
 * canary (EI-10368).
 *
 * The EI-10047 daily canary replays known-item queries against the LIVE
 * store and records every run to harness_shared.memory_live_recall_canary_run
 * — but its only human-reaching output is the transient push notification on
 * the ok→degraded edge. This helper puts the latest verdict on the envelope
 * GET /user/memory/backend already serves, so Settings → Memory can show a
 * persistent "Recall health" line (the purpose recall-canary-read.ts was
 * split out for).
 *
 * Fail-open, deliberately: no runs yet / migration 580 absent / PG down /
 * db-org unimportable all resolve to `null` — a health line must never take
 * the settings page down with it. `@papercusp/db-org` is imported lazily so
 * route unit tests that exercise the envelope don't touch a real PG pool at
 * module load (the same reason recall-canary.ts defers it).
 */
import { readRecallCanary, type RecallCanarySnapshot } from './bench/recall-canary-read';
import { activeWorkspaceId } from '../workspace-registry';

/**
 * The latest recall-canary snapshot for the active workspace, or null when
 * there is nothing to show (never throws). Trend is capped to the single
 * latest run — the settings line renders one verdict, not a chart.
 */
export async function recallCanaryForEnvelope(): Promise<RecallCanarySnapshot | null> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const snap = await readRecallCanary(getOrgPg().sql, activeWorkspaceId(), 1);
    return snap.latest ? snap : null;
  } catch {
    return null;
  }
}
