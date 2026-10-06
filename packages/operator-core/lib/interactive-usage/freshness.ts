import type { Sql } from 'postgres';

/** Interactive transcript ingestion runs every 10 minutes; three missed passes
 *  make a spend reading too old to use as a control. */
export const INTERACTIVE_USAGE_FRESHNESS_WINDOW_MS = 30 * 60_000;
/** A recent event timestamp more than 15 minutes behind receipt is stale. */
export const INTERACTIVE_USAGE_INGEST_LAG_THRESHOLD_MS = 15 * 60_000;

export type InteractiveUsageUnmeasuredReason = 'interactive-usage-stale' | 'interactive-usage-unavailable';

export interface InteractiveUsageFreshness {
  status: 'fresh' | 'stale' | 'unavailable';
  /** Unix milliseconds from agent_usage_samples.ingested_at, not source event ts. */
  lastIngestedAtMs: number | null;
  ageMs: number | null;
  windowMs: number;
  /** Maximum ingested_at - ts for rows received during the watermark window. */
  maxRecentIngestLagMs: number | null;
  lagThresholdMs: number;
  lagWindowMs: number;
  reason: string;
}

export function isInteractiveUsageUnmeasuredReason(
  reason: unknown,
): reason is InteractiveUsageUnmeasuredReason {
  return reason === 'interactive-usage-stale' || reason === 'interactive-usage-unavailable';
}

/** Compare the most recent ingestion stamp with the shared recent window. */
export function evaluateInteractiveUsageFreshness(
  latestIngestedAt: unknown,
  nowMs: number = Date.now(),
  windowMs: number = INTERACTIVE_USAGE_FRESHNESS_WINDOW_MS,
  maxRecentIngestLagValue: unknown = null,
  lagThresholdMs: number = INTERACTIVE_USAGE_INGEST_LAG_THRESHOLD_MS,
): InteractiveUsageFreshness {
  const unavailable = (
    reason: string,
    lastIngestedAtMs: number | null = null,
    maxRecentIngestLagMs: number | null = null,
  ): InteractiveUsageFreshness => ({
    status: 'unavailable', lastIngestedAtMs, ageMs: null, windowMs,
    maxRecentIngestLagMs, lagThresholdMs, lagWindowMs: windowMs, reason,
  });
  if (!Number.isFinite(nowMs) || !Number.isFinite(windowMs) || windowMs <= 0 ||
      !Number.isFinite(lagThresholdMs) || lagThresholdMs <= 0) {
    return unavailable('freshness clock or window is invalid');
  }
  if (latestIngestedAt == null) {
    return unavailable('no source=interactive usage samples are available to establish freshness');
  }
  const lastIngestedAtMs = typeof latestIngestedAt === 'number' ? latestIngestedAt : Number(latestIngestedAt);
  if (!Number.isFinite(lastIngestedAtMs) || lastIngestedAtMs < 0) {
    return unavailable('latest interactive usage ingested_at is invalid');
  }
  const maxRecentIngestLagMs = maxRecentIngestLagValue == null
    ? null
    : typeof maxRecentIngestLagValue === 'number'
      ? maxRecentIngestLagValue
      : Number(maxRecentIngestLagValue);
  if (maxRecentIngestLagMs !== null &&
      (!Number.isFinite(maxRecentIngestLagMs) || maxRecentIngestLagMs < 0)) {
    return unavailable('maximum recent interactive usage ingest lag is invalid', lastIngestedAtMs);
  }
  // Future timestamps can result from small clock skew and are not evidence of
  // stale usage. Clamp their age to zero while retaining the measured stamp.
  const ageMs = Math.max(0, nowMs - lastIngestedAtMs);
  const reasons: string[] = [];
  if (ageMs > windowMs) {
    reasons.push(`newest interactive usage sample was ingested ${ageMs} ms ago, outside the ${windowMs} ms freshness window`);
  }
  if (maxRecentIngestLagMs !== null && maxRecentIngestLagMs > lagThresholdMs) {
    reasons.push(
      `maximum recent interactive usage ingest lag was ${maxRecentIngestLagMs} ms, above the ${lagThresholdMs} ms threshold`,
    );
  }
  const lagReason = maxRecentIngestLagMs === null
    ? `no interactive usage row was available for lag measurement in the ${windowMs} ms watermark window`
    : `maximum recent interactive usage ingest lag was ${maxRecentIngestLagMs} ms`;
  return {
    status: reasons.length === 0 ? 'fresh' : 'stale',
    lastIngestedAtMs, ageMs, windowMs, maxRecentIngestLagMs,
    lagThresholdMs, lagWindowMs: windowMs,
    reason: reasons.length > 0
      ? reasons.join('; ')
      : `newest interactive usage sample was ingested ${ageMs} ms ago, within the ${windowMs} ms freshness window; ${lagReason}`,
  };
}

/** Read the ingestion watermark and recent event-to-receipt lag. Failure is
 *  data: callers must treat spend as unmeasured instead of reusing an old floor. */
export async function readInteractiveUsageFreshness(
  sql: Sql,
  opts: { workspaceId: string; goalId?: string; nowMs?: number; windowMs?: number },
): Promise<InteractiveUsageFreshness> {
  const nowMs = opts.nowMs ?? Date.now();
  const windowMs = opts.windowMs ?? INTERACTIVE_USAGE_FRESHNESS_WINDOW_MS;
  const watermarkWindowStartMs = nowMs - windowMs;
  try {
    const rows = opts.goalId == null
      ? await sql<Array<{
          latest_ingested_at: string | number | null;
          max_recent_ingest_lag_ms: string | number | null;
        }>>`
          SELECT MAX(ingested_at) AS latest_ingested_at,
                 MAX(GREATEST(ingested_at - COALESCE(ts, ingested_at), 0))
                   FILTER (WHERE ingested_at >= ${watermarkWindowStartMs}) AS max_recent_ingest_lag_ms
            FROM harness_shared.agent_usage_samples
           WHERE workspace_id = ${opts.workspaceId}
             AND source = 'interactive'
        `
      : await sql<Array<{
          latest_ingested_at: string | number | null;
          max_recent_ingest_lag_ms: string | number | null;
        }>>`
          SELECT MAX(ingested_at) AS latest_ingested_at,
                 MAX(GREATEST(ingested_at - COALESCE(ts, ingested_at), 0))
                   FILTER (WHERE ingested_at >= ${watermarkWindowStartMs}) AS max_recent_ingest_lag_ms
            FROM harness_shared.agent_usage_samples
           WHERE workspace_id = ${opts.workspaceId}
             AND source = 'interactive'
             AND goal_id = ${opts.goalId}
        `;
    return evaluateInteractiveUsageFreshness(
      rows[0]?.latest_ingested_at, nowMs, windowMs, rows[0]?.max_recent_ingest_lag_ms,
    );
  } catch (error) {
    return {
      status: 'unavailable', lastIngestedAtMs: null, ageMs: null, windowMs,
      maxRecentIngestLagMs: null,
      lagThresholdMs: INTERACTIVE_USAGE_INGEST_LAG_THRESHOLD_MS,
      lagWindowMs: windowMs,
      reason: `interactive usage freshness read failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
