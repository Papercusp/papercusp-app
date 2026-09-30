/**
 * Project list / detail helpers shared between the legacy
 * /api/harness/:slug/projects/* Hono routes and the operator-side MCP
 * tools (projects:list, projects:get). Both consume the same lib so
 * row-shape stays consistent across surfaces.
 */

import { withWorkspaceLegacy, harnessQuery } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';

export interface ProjectRow {
  id: string;
  name: string;
  status: string;
  budget_cents: number | null;
  spent_cents: number;
  owning_dept: string | null;
  vertical: string | null;
  spec: string | null;
  spec_updated_at: string | null;
  spec_manually_edited_at: string | null;
  created_ts: number;
  updated_ts: number;
}

export type FeatureCounts = {
  todo: number;
  in_progress: number;
  validating: number;
  failing: number;
  blocked: number;
  passed: number;
  rejected: number;
  total: number;
};

export interface ProjectWithCounts extends ProjectRow {
  feature_counts: FeatureCounts;
}

export interface SpecRevisionLite {
  id: number | string;
  summary: string;
  author_role: string | null;
  ts: number;
}

export interface ProjectDetail extends ProjectWithCounts {
  last_spec_revision: SpecRevisionLite | null;
}

const num = (v: unknown): number | null =>
  typeof v === 'bigint' ? Number(v) : ((v as number | null) ?? null);

export function rowToProject(r: Record<string, unknown>): ProjectRow {
  return {
    id: r.id as string,
    name: r.name as string,
    status: r.status as string,
    budget_cents: num(r.budget_cents),
    spent_cents: num(r.spent_cents) ?? 0,
    owning_dept: (r.owning_dept as string) ?? null,
    vertical: (r.vertical as string) ?? null,
    spec: (r.spec as string) ?? null,
    spec_updated_at: (r.spec_updated_at as string) ?? null,
    spec_manually_edited_at: (r.spec_manually_edited_at as string) ?? null,
    created_ts: num(r.created_ts) ?? 0,
    updated_ts: num(r.updated_ts) ?? 0,
  };
}

const EMPTY_COUNTS: FeatureCounts = {
  todo: 0,
  in_progress: 0,
  validating: 0,
  failing: 0,
  blocked: 0,
  passed: 0,
  rejected: 0,
  total: 0,
};

export async function projectFeatureCounts(slug: string, projectId: string): Promise<FeatureCounts> {
  try {
    const rows = (await harnessQuery(slug, (sql) => sql.unsafe(
      `SELECT status, COUNT(*)::bigint AS n FROM harness_features WHERE project_id = $1 GROUP BY status`,
      [projectId],
    ))) as Array<{ status: string; n: number | bigint }>;
    const counts: FeatureCounts = { ...EMPTY_COUNTS };
    for (const r of rows) {
      const n = typeof r.n === 'bigint' ? Number(r.n) : r.n;
      if (r.status in counts) (counts as Record<string, number>)[r.status] = n;
      counts.total += n;
    }
    return counts;
  } catch {
    return { ...EMPTY_COUNTS };
  }
}

export async function listProjectsForHarness(slug: string): Promise<ProjectWithCounts[]> {
  const rows = await withWorkspaceLegacy(slug, activeWorkspaceId(), async (db) => {
    return (await db.prepare(`
      SELECT p.* FROM harness_shared.projects p
      WHERE EXISTS (
        SELECT 1 FROM harness_features f
        WHERE f.harness_slug = ? AND f.project_id = p.id
      )
      ORDER BY p.updated_ts DESC
    `).all(slug)) as Array<Record<string, unknown>>;
  });
  return Promise.all(
    rows.map(async (r) => ({
      ...rowToProject(r),
      feature_counts: await projectFeatureCounts(slug, r.id as string),
    })),
  );
}

export interface SpecRevisionListEntry {
  id: number | string;
  summary: string;
  author_role: string | null;
  author: string | null;
  ts: number;
  include_decisions: unknown;
  tokens_in: number;
  tokens_out: number;
  cost_usd_cents: number;
}

export interface SpecRevisionFull extends SpecRevisionListEntry {
  spec: string;
}

const numOrNull = (v: unknown): number =>
  typeof v === 'bigint' ? Number(v) : (v as number) ?? 0;

const parseJsonOrPass = (v: unknown): unknown =>
  typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return null; } })() : (v ?? null);

export async function listProjectSpecRevisions(
  slug: string,
  projectId: string,
  limitRaw = 20,
): Promise<SpecRevisionListEntry[]> {
  const limit = Math.min(Math.max(1, limitRaw), 100);
  const rows = await withWorkspaceLegacy(slug, activeWorkspaceId(), async (db) => {
    return (await db.prepare(
      `SELECT id, summary, author_role, author, ts, include_decisions, tokens_in, tokens_out, cost_usd_cents
         FROM harness_shared.project_spec_revisions
        WHERE project_id = ?
        ORDER BY ts DESC
        LIMIT ?`,
    ).all(projectId, limit)) as Array<Record<string, unknown>>;
  });
  return rows.map((r) => ({
    id: typeof r.id === 'bigint' ? Number(r.id) : (r.id as number | string),
    summary: r.summary as string,
    author_role: (r.author_role as string) ?? null,
    author: (r.author as string) ?? null,
    ts: numOrNull(r.ts),
    include_decisions: parseJsonOrPass(r.include_decisions),
    tokens_in: numOrNull(r.tokens_in),
    tokens_out: numOrNull(r.tokens_out),
    cost_usd_cents: numOrNull(r.cost_usd_cents),
  }));
}

export async function getProjectSpecRevision(
  slug: string,
  projectId: string,
  revId: number,
): Promise<SpecRevisionFull | null> {
  const row = await withWorkspaceLegacy(slug, activeWorkspaceId(), async (db) => {
    return (await db.prepare(
      'SELECT * FROM harness_shared.project_spec_revisions WHERE project_id = ? AND id = ?',
    ).get(projectId, revId)) as Record<string, unknown> | null;
  });
  if (!row) return null;
  return {
    id: typeof row.id === 'bigint' ? Number(row.id) : (row.id as number | string),
    spec: row.spec as string,
    summary: row.summary as string,
    author_role: (row.author_role as string) ?? null,
    author: (row.author as string) ?? null,
    ts: numOrNull(row.ts),
    include_decisions: parseJsonOrPass(row.include_decisions),
    tokens_in: numOrNull(row.tokens_in),
    tokens_out: numOrNull(row.tokens_out),
    cost_usd_cents: numOrNull(row.cost_usd_cents),
  };
}

export async function getProjectDetail(slug: string, id: string): Promise<ProjectDetail | null> {
  const result = await withWorkspaceLegacy(slug, activeWorkspaceId(), async (db) => {
    const row = (await db.prepare('SELECT * FROM harness_shared.projects WHERE id = ?').get(id)) as Record<string, unknown> | null;
    if (!row) return null;
    const lastRev = (await db.prepare(
      'SELECT id, summary, author_role, ts FROM harness_shared.project_spec_revisions WHERE project_id = ? ORDER BY ts DESC LIMIT 1',
    ).get(id)) as Record<string, unknown> | null;
    return { row, lastRev };
  });
  if (!result) return null;
  const project = rowToProject(result.row);
  const counts = await projectFeatureCounts(slug, id);
  const lastRev = result.lastRev;
  return {
    ...project,
    feature_counts: counts,
    last_spec_revision: lastRev
      ? {
          id: typeof lastRev.id === 'bigint' ? Number(lastRev.id) : (lastRev.id as number | string),
          summary: lastRev.summary as string,
          author_role: (lastRev.author_role as string) ?? null,
          ts: typeof lastRev.ts === 'bigint' ? Number(lastRev.ts) : (lastRev.ts as number),
        }
      : null,
  };
}
