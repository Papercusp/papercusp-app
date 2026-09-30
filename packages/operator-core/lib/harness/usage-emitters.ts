/**
 * usage-emitters — the 8 lifecycle → P-070 usage-event mapping helpers.
 *
 * Each function maps one lifecycle event to its `(kind, ref_id, payload)` per
 * `USAGE_EVENT_REF_CONVENTION` + `UsageEventPayloadByKind`
 * (contributor-usage-event-types.ts) and forwards to the best-effort seam. Call
 * sites stay trivial one-liners — `void emitFeatureAuthored(slug, id, { title })` —
 * so the only per-site risk is passing the right slug/id var (tsc-checked), while
 * the kind/ref_id/payload mapping (the part that's easy to get wrong) lives here,
 * unit-tested in one place.
 *
 * All are fire-and-forget + never-throw via the seam — a usage failure must not
 * break the action it rides on. Callers `void` the returned promise.
 */
import { emitUsageEventBestEffort } from './emit-usage';

/** Drop keys whose value is undefined so the ledger payload stays minimal
 *  (an explicit `undefined` would serialize as a present-but-null JSONB key). */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export function emitFeatureAuthored(
  harnessSlug: string,
  featureId: string,
  opts: { title?: string } = {},
): Promise<void> {
  return emitUsageEventBestEffort(harnessSlug, 'feature_authored', {
    ref_id: featureId,
    payload: compact({ title: opts.title }),
  });
}

export function emitFeatureQueued(
  harnessSlug: string,
  featureId: string,
  opts: { fromStatus?: string } = {},
): Promise<void> {
  return emitUsageEventBestEffort(harnessSlug, 'feature_queued', {
    ref_id: featureId,
    payload: compact({ from_status: opts.fromStatus }),
  });
}

export function emitFeatureWorkedStart(
  harnessSlug: string,
  runId: string,
  opts: { role?: string } = {},
): Promise<void> {
  return emitUsageEventBestEffort(harnessSlug, 'feature_worked_start', {
    ref_id: runId,
    payload: compact({ run_id: runId, role: opts.role }),
  });
}

export function emitFeatureWorkedEnd(
  harnessSlug: string,
  runId: string,
  opts: { outcome?: 'completed' | 'failed' | 'cancelled' | 'timed_out' } = {},
): Promise<void> {
  return emitUsageEventBestEffort(harnessSlug, 'feature_worked_end', {
    ref_id: runId,
    payload: compact({ run_id: runId, outcome: opts.outcome }),
  });
}

export function emitPrOpened(
  harnessSlug: string,
  prNumber: number,
  opts: { headRef?: string; baseRef?: string } = {},
): Promise<void> {
  return emitUsageEventBestEffort(harnessSlug, 'pr_opened', {
    ref_id: String(prNumber),
    payload: compact({
      pr_number: prNumber,
      head_ref: opts.headRef,
      base_ref: opts.baseRef,
    }),
  });
}

export function emitDecisionAdded(
  harnessSlug: string,
  decisionId: string,
): Promise<void> {
  return emitUsageEventBestEffort(harnessSlug, 'decision_added', {
    ref_id: decisionId,
    payload: { decision_id: decisionId },
  });
}

export function emitPlanAuthored(
  harnessSlug: string,
  planSlug: string,
): Promise<void> {
  return emitUsageEventBestEffort(harnessSlug, 'plan_authored', {
    ref_id: planSlug,
    payload: { plan_slug: planSlug },
  });
}

export function emitAgentRunCompleted(
  harnessSlug: string,
  runId: string,
  opts: { role?: string; durationMs?: number } = {},
): Promise<void> {
  return emitUsageEventBestEffort(harnessSlug, 'agent_run_completed', {
    ref_id: runId,
    payload: compact({
      run_id: runId,
      role: opts.role,
      duration_ms: opts.durationMs,
    }),
  });
}
