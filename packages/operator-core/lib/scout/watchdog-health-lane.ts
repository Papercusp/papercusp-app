/**
 * watchdog-health-lane.ts — the WATCHDOG-HEALTH digest lane
 * (blender-self-learning-2026-07-12 P-007).
 *
 * The system watchdog runs ~33 deterministic collectors every 15 minutes and
 * persists each tick to harness_shared.watchdog_ticks — a continuously-refreshed
 * map of what is CHRONICALLY wrong (red tests, repeated tool errors, service
 * flaps, routine failures, standing open conditions). None of that reached the
 * Blender: the ideators saw friction only after someone FILED something. This
 * lane feeds the raw watchdog measurements straight into the corpus digest as
 * grounded, citable patterns (`ref` = `watchdog:<collector>` /
 * `watchdog:open:<condition-key>`), so ideation can target the chronic
 * infrastructure pain directly (owner ask, 2026-07-12: "what about more
 * metrics from the watchdog?").
 *
 * Deterministic + fail-soft, populated by the cycle seam (cycle-deps
 * readCorpus) exactly like standingFacts / nicheMap: an outage here never
 * disturbs the digest or the cycle.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import type { MetaPattern } from './types';

/** One collector's 24h aggregate (the pure builder's input). */
export interface CollectorAggregate {
  name: string;
  /** Σ signalCount across the window's ticks. */
  totalSignals: number;
  /** Ticks in the window where this collector had ≥1 signal. */
  activeTicks: number;
  /** Ticks in the window where the collector itself FAILED (ok=false). */
  brokenTicks: number;
}

/**
 * PURE: aggregates → digest patterns. A collector surfaces when it signalled on
 * ≥ `minActiveTicks` ticks (chronic, not a blip) or was itself broken; standing
 * open condition keys surface individually. Sorted by chronic-ness
 * (activeTicks desc, then totalSignals), capped at `limit`.
 */
export function buildWatchdogHealthPatterns(
  aggregates: readonly CollectorAggregate[],
  openKeys: readonly string[],
  opts: { minActiveTicks?: number; limit?: number } = {},
): MetaPattern[] {
  const minActive = opts.minActiveTicks ?? 3;
  const limit = opts.limit ?? 10;
  const out: MetaPattern[] = [];
  const chronic = aggregates
    .filter((a) => a.activeTicks >= minActive || a.brokenTicks > 0)
    .sort((a, b) => b.activeTicks - a.activeTicks || b.totalSignals - a.totalSignals);
  for (const a of chronic) {
    out.push({
      ref: `watchdog:${a.name}`,
      summary:
        a.brokenTicks > 0
          ? `watchdog collector ${a.name} is itself FAILING (${a.brokenTicks} broken tick(s)/24h)`
          : `${a.name}: signalling on ${a.activeTicks} of the last 24h's watchdog ticks`,
      detail: `${a.totalSignals} signal(s) across ${a.activeTicks} active tick(s) in 24h — chronic, not a blip`,
    });
  }
  for (const key of openKeys) {
    out.push({
      ref: `watchdog:open:${key}`,
      summary: `standing OPEN watchdog condition: ${key}`,
      detail: 'open across consecutive watchdog ticks — nobody has resolved the underlying cause',
    });
  }
  return out.slice(0, Math.max(1, limit));
}

/**
 * The PG edge: 24h collector aggregates + the newest tick's standing open keys
 * for the active workspace. Returns [] on any failure (fail-soft lane).
 */
export async function buildWatchdogHealthLane(opts: { workspaceId?: string } = {}): Promise<MetaPattern[]> {
  try {
    const ws = opts.workspaceId ?? activeWorkspaceId();
    const { sql } = getOrgPg();
    const agg = await sql<Array<{ name: string; total: number; active: number; broken: number }>>`
      SELECT c->>'name' AS name,
             coalesce(sum((c->>'signalCount')::int), 0)::int AS total,
             count(*) FILTER (WHERE (c->>'signalCount')::int > 0)::int AS active,
             count(*) FILTER (WHERE (c->>'ok')::boolean IS DISTINCT FROM true)::int AS broken
        FROM harness_shared.watchdog_ticks, jsonb_array_elements(collectors) c
       WHERE workspace_id = ${ws} AND tick_at > now() - interval '24 hours'
       GROUP BY 1`;
    const open = await sql<Array<{ known_open_keys: string[] | null }>>`
      SELECT known_open_keys
        FROM harness_shared.watchdog_ticks
       WHERE workspace_id = ${ws}
       ORDER BY tick_at DESC
       LIMIT 1`;
    return buildWatchdogHealthPatterns(
      agg.map((r) => ({
        name: r.name,
        totalSignals: Number(r.total) || 0,
        activeTicks: Number(r.active) || 0,
        brokenTicks: Number(r.broken) || 0,
      })),
      open[0]?.known_open_keys ?? [],
    );
  } catch {
    return [];
  }
}
