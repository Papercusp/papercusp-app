/**
 * The Queen decision-ledger READ SURFACE — queen-autonomy-policy-2026-06-13 B-13 /
 * P-113. The one queryable view over BOTH capture layers (action-chokepoint B-06 /
 * P-110 + decider-disposition P-111), filterable by layer / category / posture /
 * disposition / time. Backs the `decision_ledger:list` + `decision_ledger:summary`
 * tools, the `decision.ledger` sync query, and the settings recent-auto-decisions
 * feed (P-031). Read-only; the write side is ./emit.ts (actions) + ./disposition.ts
 * (dispositions).
 *
 * harness_shared.decision_ledger has no RLS (mirrors 260's design + the
 * change_ledger reader) — every query scopes by workspace_id explicitly.
 */

import { getOrgPg } from '@papercusp/db-org';

export type DecisionLayer = 'action' | 'disposition';

export interface DecisionLedgerFilters {
  /** 'action' (governed actions) or 'disposition' (the Queen's per-item choices). */
  layer?: DecisionLayer;
  category?: string;
  /** auto | proposed | gated | rejected */
  posture?: string;
  /** act | defer | reject | route-to-research | no-op (disposition rows only). */
  disposition?: string;
  /** Only rows newer than this epoch-ms. */
  sinceMs?: number;
  limit?: number;
}

export interface DecisionLedgerEntry {
  id: number;
  ts: string;
  layer: string;
  harnessSlug: string | null;
  action: string | null;
  capability: string | null;
  tier: string | null;
  category: string | null;
  riskTier: string | null;
  reversibility: string | null;
  authority: string | null;
  posture: string;
  outcome: string;
  outcomeCode: string | null;
  disposition: string | null;
  revisitAt: string | null;
  revertHandle: string | null;
  /**
   * The id of the still-ARMED tripwire correlated to this decision (B-16, via
   * `autonomy_tripwires.decision_id = decision_ledger.id`), or null. Non-null only
   * while an undo is actually possible (status='armed'), so the settings feed's
   * one-click UNDO (B-15 / P-031) renders exactly when it can act. Empty-until-armed:
   * the execution layer mints + threads the shared decisionId onto both rows only
   * when the Queen auto-takes a reversible action, so this is null until autonomy is
   * armed AND a reversible ceiling is lowered.
   */
  tripwireId: string | null;
  why: string | null;
  links: Record<string, unknown> | null;
  actorRole: string | null;
  actorSpawnId: string | null;
  actorPrincipal: string | null;
  transport: string | null;
  durationMs: number | null;
  metadata: Record<string, unknown> | null;
}

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

/**
 * Normalize a jsonb column to a plain object. The org pool parses jsonb → object,
 * but a differently-configured client (or a text-typed read) can hand back the raw
 * JSON string — coerce both so the surface always gets an object (or null).
 */
function asObject(v: unknown): Record<string, unknown> | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Recent decision-ledger rows for a workspace, newest first, filtered. */
export async function readDecisionLedger(
  workspaceId: string,
  filters: DecisionLedgerFilters = {},
): Promise<DecisionLedgerEntry[]> {
  if (!workspaceId) return [];
  const { sql } = getOrgPg();
  const limit = Math.min(Math.max(1, filters.limit ?? 100), 1000);
  const rows = await sql<
    {
      id: number | string;
      ts: Date | string;
      layer: string;
      harness_slug: string | null;
      action: string | null;
      capability: string | null;
      tier: string | null;
      category: string | null;
      risk_tier: string | null;
      reversibility: string | null;
      authority: string | null;
      posture: string;
      outcome: string;
      outcome_code: string | null;
      disposition: string | null;
      revisit_at: Date | string | null;
      revert_handle: string | null;
      tripwire_id: string | null;
      why: string | null;
      links: Record<string, unknown> | null;
      actor_role: string | null;
      actor_spawn_id: string | null;
      actor_principal: string | null;
      transport: string | null;
      duration_ms: number | null;
      metadata: Record<string, unknown> | null;
    }[]
  >`
    SELECT id, ts, layer, harness_slug, action, capability, tier, category,
           risk_tier, reversibility, authority, posture, outcome, outcome_code,
           disposition, revisit_at, revert_handle, why, links,
           actor_role, actor_spawn_id, actor_principal, transport, duration_ms, metadata,
           -- B-16 undo seam: the still-armed tripwire correlated to this decision, if
           -- any. Correlated subselect (not a JOIN) keeps every existing column
           -- reference unqualified + guarantees one row; the partial index
           -- autonomy_tripwires_decision_id_idx (workspace_id, decision_id) serves it.
           -- Gated to status='armed' so the feed's Undo shows only when it can act.
           (SELECT t.id
              FROM harness_shared.autonomy_tripwires t
             WHERE t.decision_id = decision_ledger.id::text
               AND t.workspace_id = decision_ledger.workspace_id
               AND t.status = 'armed'
             LIMIT 1) AS tripwire_id
      FROM harness_shared.decision_ledger
     WHERE workspace_id = ${workspaceId}
       ${filters.layer ? sql`AND layer = ${filters.layer}` : sql``}
       ${filters.category ? sql`AND category = ${filters.category}` : sql``}
       ${filters.posture ? sql`AND posture = ${filters.posture}` : sql``}
       ${filters.disposition ? sql`AND disposition = ${filters.disposition}` : sql``}
       ${filters.sinceMs != null ? sql`AND ts >= ${new Date(filters.sinceMs).toISOString()}` : sql``}
     ORDER BY ts DESC
     LIMIT ${limit}`;
  return rows.map((r) => ({
    id: Number(r.id),
    ts: iso(r.ts),
    layer: r.layer,
    harnessSlug: r.harness_slug,
    action: r.action,
    capability: r.capability,
    tier: r.tier,
    category: r.category,
    riskTier: r.risk_tier,
    reversibility: r.reversibility,
    authority: r.authority,
    posture: r.posture,
    outcome: r.outcome,
    outcomeCode: r.outcome_code,
    disposition: r.disposition,
    revisitAt: r.revisit_at != null ? iso(r.revisit_at) : null,
    revertHandle: r.revert_handle,
    tripwireId: r.tripwire_id ?? null,
    why: r.why,
    links: asObject(r.links),
    actorRole: r.actor_role,
    actorSpawnId: r.actor_spawn_id,
    actorPrincipal: r.actor_principal,
    transport: r.transport,
    durationMs: r.duration_ms,
    metadata: asObject(r.metadata),
  }));
}

export interface DecisionLedgerSummary {
  total: number;
  byLayer: Record<string, number>;
  byPosture: Record<string, number>;
  byCategory: Record<string, number>;
  byDisposition: Record<string, number>;
  /** Most-recent row timestamp in the window, ISO; null when empty. */
  latestTs: string | null;
}

/**
 * Aggregate counts over the decision ledger (a compressed activity-log rollup) —
 * by layer / posture / category / disposition — within an optional time window +
 * filters. One pass; the JS rollup keeps the SQL simple + the filter logic shared
 * with the row reader.
 */
export async function summarizeDecisionLedger(
  workspaceId: string,
  filters: DecisionLedgerFilters = {},
): Promise<DecisionLedgerSummary> {
  const empty: DecisionLedgerSummary = {
    total: 0,
    byLayer: {},
    byPosture: {},
    byCategory: {},
    byDisposition: {},
    latestTs: null,
  };
  if (!workspaceId) return empty;
  // Summarize over a generous window cap so the rollup is bounded but representative.
  const rows = await readDecisionLedger(workspaceId, { ...filters, limit: filters.limit ?? 1000 });
  if (rows.length === 0) return empty;
  const bump = (m: Record<string, number>, k: string | null | undefined) => {
    const key = k ?? 'unknown';
    m[key] = (m[key] ?? 0) + 1;
  };
  const out: DecisionLedgerSummary = { ...empty, byLayer: {}, byPosture: {}, byCategory: {}, byDisposition: {} };
  for (const r of rows) {
    out.total += 1;
    bump(out.byLayer, r.layer);
    bump(out.byPosture, r.posture);
    bump(out.byCategory, r.category);
    if (r.disposition) bump(out.byDisposition, r.disposition);
  }
  out.latestTs = rows[0]?.ts ?? null; // rows are ts DESC
  return out;
}
