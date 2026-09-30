/**
 * Postgres `ArchiveStore` for the gym QD archive (P-010) — over
 * `harness_shared.gym_qd_archive` in the LIVE operator DB (migration 193). Durable,
 * cross-run, scoped by (workspace_id, harness_slug); mirrors the control-plane store
 * (control-plane.ts / migration 110): an injected `Sql`, JSONB written as
 * `${JSON.stringify(x)}::text::jsonb` (NOT sql.json(), which throws under postgres-js
 * v3.4 on this stack), bigint epoch-ms timestamps.
 *
 * `put` is a plain set-this-cell upsert; the insert-if-better policy lives in `QdArchive`
 * (archive.ts), which reads the incumbent first — so this store stays behaviorally
 * identical to `InMemoryArchiveStore` (the unit-test fake) and the same QdArchive logic is
 * exercised by both.
 */
import type { Sql } from 'postgres';
import type { ArchiveStore } from './archive';
import type { ArchiveElite, ArchiveSource, BehaviorDescriptor, NicheCoords, RiskBand, ScopeBand } from './niche';

type Row = Record<string, unknown>;

function mapElite(r: Row): ArchiveElite {
  // postgres-js returns jsonb as a parsed object; guard for a string just in case.
  const raw = r.descriptor;
  const descriptor = (typeof raw === 'string' ? JSON.parse(raw) : raw) as BehaviorDescriptor;
  const coords: NicheCoords = {
    scope: String(r.scope) as ScopeBand,
    domain: String(r.domain),
    risk: String(r.risk) as RiskBand,
  };
  return {
    nicheKey: String(r.niche_key),
    coords,
    candidateId: String(r.candidate_id),
    fitness: Number(r.fitness),
    descriptor,
    source: String(r.source) as ArchiveSource,
    rationale: r.rationale == null ? null : String(r.rationale),
    updatedAt: Number(r.updated_at),
  };
}

export class PgArchiveStore implements ArchiveStore {
  constructor(
    private readonly sql: Sql,
    private readonly scope: { workspaceId: string; harnessSlug: string },
  ) {}

  async get(nicheKey: string): Promise<ArchiveElite | null> {
    const rows = (await this.sql`
      SELECT * FROM harness_shared.gym_qd_archive
       WHERE workspace_id = ${this.scope.workspaceId}
         AND harness_slug = ${this.scope.harnessSlug}
         AND niche_key = ${nicheKey}
       LIMIT 1`) as Row[];
    return rows.length ? mapElite(rows[0]) : null;
  }

  async put(elite: ArchiveElite): Promise<void> {
    await this.sql`
      INSERT INTO harness_shared.gym_qd_archive
        (workspace_id, harness_slug, niche_key, candidate_id, scope, domain, risk, fitness, descriptor, source, rationale, updated_at)
      VALUES (${this.scope.workspaceId}, ${this.scope.harnessSlug}, ${elite.nicheKey}, ${elite.candidateId},
              ${elite.coords.scope}, ${elite.coords.domain}, ${elite.coords.risk}, ${elite.fitness},
              ${JSON.stringify(elite.descriptor)}::text::jsonb, ${elite.source}, ${elite.rationale ?? null}, ${elite.updatedAt})
      ON CONFLICT (workspace_id, harness_slug, niche_key) DO UPDATE SET
        candidate_id = EXCLUDED.candidate_id,
        scope = EXCLUDED.scope, domain = EXCLUDED.domain, risk = EXCLUDED.risk,
        fitness = EXCLUDED.fitness, descriptor = EXCLUDED.descriptor,
        source = EXCLUDED.source, rationale = EXCLUDED.rationale, updated_at = EXCLUDED.updated_at`;
  }

  async list(opts?: { source?: ArchiveSource; limit?: number }): Promise<ArchiveElite[]> {
    const rows = (await this.sql`
      SELECT * FROM harness_shared.gym_qd_archive
       WHERE workspace_id = ${this.scope.workspaceId}
         AND harness_slug = ${this.scope.harnessSlug}
         ${opts?.source ? this.sql`AND source = ${opts.source}` : this.sql``}
       ORDER BY fitness DESC, niche_key ASC
       ${opts?.limit != null ? this.sql`LIMIT ${opts.limit}` : this.sql``}`) as Row[];
    return rows.map(mapElite);
  }
}
