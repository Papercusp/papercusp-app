/**
 * Gather layer — loads the "why" sources into `RationaleSource` records the pure
 * projector can shred (docs-and-memory-as-projections-2026-06-05 D-003).
 *
 * This is the I/O boundary: read a plan's decisions + its topic tags, a work-item +
 * its tags, the insights tree. The projector stays pure; everything that touches PG
 * or the filesystem lives here.
 */

import * as path from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { parsePlan } from '@papercusp/plan-parser';
import { listObjectTags } from '../topics-feed';
import { getWorkItem, workItemObjectRef, type WorkItem } from '../work-items';
import { readInsightsDir } from '../memory/insights-index';
import { DOCS_CONTENT_ROOT } from '../agent-tools/docs/_repo-paths';
import type { RationaleSource } from './types';

const INSIGHTS_DIR = path.join(DOCS_CONTENT_ROOT, 'agent-insights');

type PlanRow = {
  plan_slug: string;
  harness_slug: string;
  content: string;
  title: string | null;
  status: string | null;
};

/** The 'plan' branch of the {@link RationaleSource} union — narrowed so callers of
 *  {@link gatherPlanSource}/{@link gatherAllPlanSources} (which always build a plan
 *  record) get `decisions`/`planTitle` etc. without re-narrowing on `kind` themselves. */
type PlanRationaleSource = Extract<RationaleSource, { kind: 'plan' }>;

function planSourceFrom(row: PlanRow, topics: string[]): PlanRationaleSource {
  const parsed = parsePlan(row.content, { filePath: `${row.plan_slug}.md` });
  return {
    kind: 'plan',
    slug: row.plan_slug,
    planTitle: parsed.frontmatter.title ?? row.title ?? undefined,
    planStatus: row.status ?? parsed.frontmatter.status ?? null,
    topics,
    decisions: parsed.decisions.map((d) => ({
      id: d.id,
      title: d.title,
      body: d.body,
      date: d.date,
    })),
  };
}

/**
 * Load one plan as a `RationaleSource`. Queries `harness_plans` directly by slug
 * (the tag edge keys on the slug, harness-agnostic) so it works for managed AND
 * operator-level plans without resolving harness scope. Returns null if no such
 * plan, or if the plan has no decisions AND no topic tags (nothing to project).
 */
export async function gatherPlanSource(
  slug: string,
  harness?: string,
): Promise<PlanRationaleSource | null> {
  const { sql } = getOrgPg();
  const rows = harness
    ? await sql<PlanRow[]>`
        SELECT plan_slug, harness_slug, content, title, status
        FROM harness_shared.harness_plans
        WHERE plan_slug = ${slug} AND harness_slug = ${harness}
        LIMIT 1`
    : await sql<PlanRow[]>`
        SELECT plan_slug, harness_slug, content, title, status
        FROM harness_shared.harness_plans
        WHERE plan_slug = ${slug}
        ORDER BY updated_at DESC
        LIMIT 1`;
  const row = rows[0];
  if (!row) return null;
  const topics = await listObjectTags('plan', slug);
  return planSourceFrom(row, topics);
}

/** Every plan in the workspace as a `RationaleSource` — the backfill source. */
export async function gatherAllPlanSources(): Promise<RationaleSource[]> {
  const { sql } = getOrgPg();
  const rows = await sql<PlanRow[]>`
    SELECT plan_slug, harness_slug, content, title, status
    FROM harness_shared.harness_plans
    WHERE archived = false`;
  const out: RationaleSource[] = [];
  for (const row of rows) {
    const topics = await listObjectTags('plan', row.plan_slug);
    out.push(planSourceFrom(row, topics));
  }
  return out;
}

function workItemSourceFrom(wi: WorkItem, topics: string[]): RationaleSource {
  return {
    kind: 'work_item',
    id: wi.id,
    title: wi.title,
    summary: wi.summary,
    state: wi.state,
    topics,
    createdAt: wi.createdAt,
  };
}

/** Load one work-item as a `RationaleSource`, including its topic tags. */
export async function gatherWorkItemSource(
  id: string,
  harness?: string,
): Promise<RationaleSource | null> {
  const wi = await getWorkItem(id, harness);
  if (!wi) return null;
  const ref = workItemObjectRef(wi);
  // workItemObjectRef yields kind 'issue' | 'feature' — both TaggableKinds.
  const topics = await listObjectTags(ref.kind as 'issue' | 'feature', ref.ref);
  return workItemSourceFrom(wi, topics);
}

/**
 * Every work-item that carries at least one topic tag, as a `RationaleSource`.
 * Bounded by the tag edges (an untagged item contributes nothing), so this is the
 * efficient backfill path — we never scan the full work-item table. Best-effort
 * per item: a ref that no longer resolves is skipped, not fatal.
 */
export async function gatherTaggedWorkItemSources(): Promise<RationaleSource[]> {
  const { sql } = getOrgPg();
  const rows = await sql<{ src_kind: string; src_ref: string }[]>`
    SELECT DISTINCT src_kind, src_ref
    FROM harness_shared.coord_links
    WHERE rel = 'tagged' AND src_kind IN ('feature', 'issue')`;
  const out: RationaleSource[] = [];
  for (const r of rows) {
    // feature-family refs are harness-qualified `<harness>#<id>`; issue refs are bare.
    let id = r.src_ref;
    let harness: string | undefined;
    const hash = r.src_ref.indexOf('#');
    if (hash >= 0) {
      harness = r.src_ref.slice(0, hash);
      id = r.src_ref.slice(hash + 1);
    }
    try {
      const src = await gatherWorkItemSource(id, harness);
      if (src) out.push(src);
    } catch {
      /* unresolvable ref — skip, never fatal during backfill */
    }
  }
  return out;
}

/** Every insight under agent-insights/ as a `RationaleSource`. */
export async function gatherAllInsightSources(
  dir: string = INSIGHTS_DIR,
): Promise<RationaleSource[]> {
  const entries = await readInsightsDir(dir);
  return entries.map((e) => ({
    kind: 'insight' as const,
    slug: e.slug,
    title: e.title,
    description: e.description,
    tags: e.tags,
  }));
}
