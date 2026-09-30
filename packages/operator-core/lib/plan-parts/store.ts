/**
 * plan-parts/store — the federated per-part state store for the plan-federation
 * re-grain (plan-federation-regrain-2026-06-13 P-002).
 *
 * DARK: not wired into the live plan capture/projection. The live whole-document
 * federation (CDC mig 125 → projections/harness-plans.ts) is untouched; this path
 * activates only behind `papercusp-plan-part-federation` at cutover (P-005/006).
 *
 * The store is a per-plan key→part map with an LWW upsert (by `fedTs`, ties broken
 * by `author`). Two impls behind one seam:
 *   - InMemoryPlanPartsStore — for the deterministic two-peer gate (P-004) + tests.
 *   - PgPlanPartsStore       — over `harness_shared.harness_plan_parts` (the new
 *                              additive table; the LWW guard lives in SQL so it is
 *                              atomic under concurrent applies). Exercised against
 *                              real PG only after the migration applies (cutover).
 */
import { mergeFederatedPart, type FederatedPart } from '@papercusp/plan-parser';
import type postgres from 'postgres';

export interface PlanPartsStore {
  /** Every part for a plan (INCLUDING tombstones), keyed by `part.key`. */
  getParts(planSlug: string): Promise<Map<string, FederatedPart>>;
  /**
   * LWW upsert: applies `part` iff it is not strictly-older than the stored part
   * for that key (higher `fedTs` wins; equal `fedTs` → higher `author` wins). A
   * `tombstone` part removes the key (still LWW-guarded). Idempotent + commutative.
   *
   * `origin` is the echo-guard tag persisted to PG: applied REMOTE ops pass
   * 'remote' so the capture trigger (mig 271) skips re-federating them; local
   * writes default 'local' and DO federate. The in-memory impl ignores it.
   */
  upsertPart(planSlug: string, part: FederatedPart, origin?: 'local' | 'remote'): Promise<void>;
}

/** In-process store — reuses the pure `mergeFederatedPart` LWW from plan-parser. */
export class InMemoryPlanPartsStore implements PlanPartsStore {
  private readonly byPlan = new Map<string, Map<string, FederatedPart>>();

  async getParts(planSlug: string): Promise<Map<string, FederatedPart>> {
    return new Map(this.byPlan.get(planSlug) ?? new Map());
  }

  async upsertPart(planSlug: string, part: FederatedPart, _origin: 'local' | 'remote' = 'local'): Promise<void> {
    const cur = this.byPlan.get(planSlug) ?? new Map<string, FederatedPart>();
    this.byPlan.set(planSlug, mergeFederatedPart(cur, part)); // origin is a PG echo-guard concern; n/a in-memory
  }
}

interface PartRow {
  part_key: string;
  kind: FederatedPart['kind'];
  body: string;
  ordinal: number;
  fed_ts: string | number; // bigint comes back as string from postgres.js
  author: string | null;
  tombstone: boolean;
}

/**
 * Postgres-backed store over `harness_plan_parts`. The LWW decision is in the
 * `ON CONFLICT … WHERE` guard so concurrent applies are atomic (no read-modify-
 * write race). Tombstones are SOFT (a flag, not a DELETE) so a late op for a
 * removed key is still LWW-ordered correctly.
 */
export class PgPlanPartsStore implements PlanPartsStore {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly workspaceId: string,
    private readonly harnessSlug: string,
  ) {}

  async getParts(planSlug: string): Promise<Map<string, FederatedPart>> {
    const rows = (await this.sql`
      SELECT part_key, kind, body, ordinal, fed_ts, author, tombstone
        FROM harness_shared.harness_plan_parts
       WHERE workspace_id = ${this.workspaceId}
         AND harness_slug = ${this.harnessSlug}
         AND plan_slug = ${planSlug}
    `) as unknown as PartRow[];
    const out = new Map<string, FederatedPart>();
    for (const r of rows) {
      out.set(r.part_key, {
        key: r.part_key,
        kind: r.kind,
        text: r.body,
        order: r.ordinal,
        fedTs: Number(r.fed_ts),
        ...(r.author != null ? { author: r.author } : {}),
        ...(r.tombstone ? { tombstone: true as const } : {}),
      });
    }
    return out;
  }

  async upsertPart(planSlug: string, part: FederatedPart, origin: 'local' | 'remote' = 'local'): Promise<void> {
    await this.sql`
      INSERT INTO harness_shared.harness_plan_parts
        (workspace_id, harness_slug, plan_slug, part_key, kind, body, ordinal, fed_ts, author, tombstone, origin)
      VALUES
        (${this.workspaceId}, ${this.harnessSlug}, ${planSlug}, ${part.key}, ${part.kind},
         ${part.text}, ${part.order}, ${part.fedTs}, ${part.author ?? null}, ${part.tombstone ?? false}, ${origin})
      ON CONFLICT (workspace_id, harness_slug, plan_slug, part_key) DO UPDATE SET
        kind      = EXCLUDED.kind,
        body      = EXCLUDED.body,
        ordinal   = EXCLUDED.ordinal,
        fed_ts    = EXCLUDED.fed_ts,
        author    = EXCLUDED.author,
        tombstone = EXCLUDED.tombstone,
        origin    = EXCLUDED.origin
      WHERE EXCLUDED.fed_ts > harness_shared.harness_plan_parts.fed_ts
         OR (EXCLUDED.fed_ts = harness_shared.harness_plan_parts.fed_ts
             AND COALESCE(EXCLUDED.author, '') > COALESCE(harness_shared.harness_plan_parts.author, ''))
    `;
  }
}
