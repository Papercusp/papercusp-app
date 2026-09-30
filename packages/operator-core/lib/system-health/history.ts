/**
 * system-health/history — persisted status history for the Health tab
 * (health-tab-v2-2026-07-12 P-005 / P-006, decision D-B).
 *
 * The tab was a point-in-time snapshot: "is this red NEW? did it flap
 * overnight?" were unanswerable. The ~30s tick now writes:
 *   - system_health_transitions — one row per panel status CHANGE (powers
 *     "crit since <t>" + the incident timeline);
 *   - system_health_ticks — one compact row per tick (overall + a statuses
 *     jsonb) with 14-day retention (powers the per-panel 24h uptime strips).
 *
 * Volume: ~2.9k tick rows/workspace/day; retention is enforced inline by the
 * writer (probabilistic, ~1 delete per ~50 ticks) — no separate job (D-B).
 * Everything here is fail-soft at the call site: history must never break the
 * health tick itself.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { PanelStatus, SystemHealth } from './types';
import { PANEL_ORDER } from './types';

const RETENTION_DAYS = 14;
/** Run the retention DELETE roughly once per this many ticks (~25 min at 30s). */
const RETENTION_SAMPLE = 50;

export interface HealthTransitionRow {
  panel: string;
  from: PanelStatus;
  to: PanelStatus;
  summary: string | null;
  /** ms epoch. */
  at: number;
}

export interface HealthHistory {
  workspaceId: string;
  windowMs: number;
  bucketMs: number;
  /** panel key → one PanelStatus (worst in bucket) per bucket, oldest first; null = no data. */
  strips: Record<string, Array<PanelStatus | null>>;
  overallStrip: Array<PanelStatus | null>;
  /** panel key → ms epoch when the CURRENT status began (its last transition), or
   *  null = no transition inside the window (stable since before it). */
  since: Record<string, number | null>;
  /** Newest-first transitions in the window (bounded). */
  transitions: HealthTransitionRow[];
}

/** PURE: the per-panel status diff between two snapshots. Exported for tests. */
export function diffHealthTransitions(
  prev: SystemHealth | null,
  next: SystemHealth,
): Array<{ panel: string; from: PanelStatus; to: PanelStatus; summary: string | null }> {
  if (!prev) return [];
  const out: Array<{ panel: string; from: PanelStatus; to: PanelStatus; summary: string | null }> = [];
  for (const key of PANEL_ORDER) {
    const nextPanel = next.panels[key];
    const prevPanel = prev.panels?.[key];
    if (!nextPanel || !prevPanel) continue;
    if (prevPanel.status !== nextPanel.status) {
      out.push({ panel: key, from: prevPanel.status, to: nextPanel.status, summary: nextPanel.summary ?? null });
    }
  }
  return out;
}

/**
 * Persist one tick's history: transition rows for every panel whose status
 * changed since `prev`, plus the compact per-tick statuses row. Retention is
 * sampled. Callers wrap in try/catch (never breaks the tick).
 */
export async function recordHealthHistory(prev: SystemHealth | null, next: SystemHealth): Promise<void> {
  const { sql } = getOrgPg();
  const statuses: Record<string, PanelStatus> = {};
  for (const key of PANEL_ORDER) {
    const p = next.panels[key];
    if (p) statuses[key] = p.status;
  }
  // NB: the org pool rejects Date params ("Received an instance of Date") and
  // sql.json() (same throw for Object) — timestamps go in as .toISOString(),
  // jsonb as ${JSON.stringify(x)}::jsonb, and timestamptz reads come back as ISO
  // strings (loops-panel incident, 2026-07-12; same convention as gym/store.ts).
  const atIso = new Date(next.evaluatedAt).toISOString();
  await sql`
    INSERT INTO harness_shared.system_health_ticks (workspace_id, at, overall, statuses)
    VALUES (${next.workspaceId}, ${atIso}, ${next.overall}, ${JSON.stringify(statuses)}::text::jsonb)
    ON CONFLICT (workspace_id, at) DO NOTHING`;
  const transitions = diffHealthTransitions(prev, next);
  for (const t of transitions) {
    await sql`
      INSERT INTO harness_shared.system_health_transitions
        (workspace_id, panel, from_status, to_status, summary, at)
      VALUES (${next.workspaceId}, ${t.panel}, ${t.from}, ${t.to},
              ${t.summary ? t.summary.slice(0, 500) : null}, ${atIso})`;
  }
  if (Math.random() < 1 / RETENTION_SAMPLE) {
    await sql`DELETE FROM harness_shared.system_health_ticks
               WHERE at < now() - make_interval(days => ${RETENTION_DAYS})`;
    await sql`DELETE FROM harness_shared.system_health_transitions
               WHERE at < now() - make_interval(days => ${RETENTION_DAYS})`;
  }
}

const SEVERITY: Record<PanelStatus, number> = { unknown: 0, ok: 1, warn: 2, crit: 3 };

/**
 * PURE: fold tick rows + transition rows into the render-ready history
 * (strips + since + timeline). Exported for unit tests; readSystemHealthHistory
 * is the IO wrapper.
 */
export function buildHealthHistory(args: {
  workspaceId: string;
  now: number;
  windowMs: number;
  bucketMs: number;
  ticks: Array<{ at: number; overall: PanelStatus; statuses: Record<string, PanelStatus> }>;
  transitions: HealthTransitionRow[];
}): HealthHistory {
  const { workspaceId, now, windowMs, bucketMs, ticks, transitions } = args;
  const buckets = Math.max(1, Math.round(windowMs / bucketMs));
  const start = now - windowMs;
  const strips: Record<string, Array<PanelStatus | null>> = {};
  const overallStrip: Array<PanelStatus | null> = new Array(buckets).fill(null);
  const worse = (a: PanelStatus | null, b: PanelStatus): PanelStatus =>
    a === null || SEVERITY[b] > SEVERITY[a] ? b : a;
  for (const t of ticks) {
    const idx = Math.floor((t.at - start) / bucketMs);
    if (idx < 0 || idx >= buckets) continue;
    overallStrip[idx] = worse(overallStrip[idx], t.overall);
    for (const [panel, status] of Object.entries(t.statuses)) {
      const strip = (strips[panel] ??= new Array(buckets).fill(null));
      strip[idx] = worse(strip[idx], status);
    }
  }
  // The newest transition per panel = when its CURRENT status began.
  const since: Record<string, number | null> = {};
  for (const t of transitions) {
    if (since[t.panel] === undefined) since[t.panel] = t.at; // transitions arrive newest-first
  }
  return { workspaceId, windowMs, bucketMs, strips, overallStrip, since, transitions };
}

/** IO wrapper: read the last `windowMs` of history for a workspace. */
export async function readSystemHealthHistory(
  workspaceId: string,
  windowMs = 24 * 60 * 60_000,
  bucketMs = 30 * 60_000,
): Promise<HealthHistory> {
  const { sql } = getOrgPg();
  const now = Date.now();
  const fromIso = new Date(now - windowMs).toISOString();
  const [tickRows, transitionRows] = await Promise.all([
    sql<Array<{ at: string; overall: string; statuses: Record<string, PanelStatus> }>>`
      SELECT at, overall, statuses
        FROM harness_shared.system_health_ticks
       WHERE workspace_id = ${workspaceId} AND at >= ${fromIso}
       ORDER BY at ASC`,
    sql<Array<{ panel: string; from_status: string; to_status: string; summary: string | null; at: string }>>`
      SELECT panel, from_status, to_status, summary, at
        FROM harness_shared.system_health_transitions
       WHERE workspace_id = ${workspaceId} AND at >= ${fromIso}
       ORDER BY at DESC
       LIMIT 300`,
  ]);
  return buildHealthHistory({
    workspaceId,
    now,
    windowMs,
    bucketMs,
    ticks: tickRows.map((r) => ({
      at: new Date(r.at).getTime(),
      overall: r.overall as PanelStatus,
      statuses: r.statuses ?? {},
    })),
    transitions: transitionRows.map((r) => ({
      panel: r.panel,
      from: r.from_status as PanelStatus,
      to: r.to_status as PanelStatus,
      summary: r.summary,
      at: new Date(r.at).getTime(),
    })),
  });
}
