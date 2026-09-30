/**
 * Phase B: plan context injection for promoted features.
 *
 * When a worker/validator/reviewer agent is invoked for a feature that was
 * promoted from a plan, this module fetches the relevant plan context (Now
 * block, source item text, most-recent decisions) and returns a prompt
 * section the caller appends to the assembled role prompt.
 *
 * Token budget: ≤1,500 tokens ≈ ≤6,000 characters.  Content that exceeds
 * this limit is truncated with a `[truncated]` marker.
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';
import { readPlanBySlug } from './agent-tools/plans/source';
import { planItemProvenanceFromRow } from './plan-item-provenance';

const PLAN_CONTEXT_CHAR_BUDGET = 6_000;
const PLAN_CONTEXT_HEADING = '## Source Plan Context';
const ROLES_RECEIVING_CONTEXT = new Set(['worker', 'validator', 'reviewer']);

export interface PlanContextResult {
  section: string;
  planSlug: string;
  truncated: boolean;
  /** The exact plan snapshot represented by `section`, when the PG row exposed it. */
  revision: number | null;
  contentHash: string | null;
  updatedAt: string | null;
}

interface FeatureProvenanceRow {
  source_plan_slug: string | null;
  source_plan_item_ids: string[] | null;
  /** The live item-level link — see plan-item-provenance (EI-19435123521651527). */
  stamped_plan_slug: string | null;
  stamped_item_id: string | null;
  title: string;
}

async function queryProvenance(
  harnessSlug: string,
  featureId: string,
): Promise<FeatureProvenanceRow | null> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<FeatureProvenanceRow[]>`
      SELECT source_plan_slug,
             source_plan_item_ids,
             payload -> 'plan_item' ->> 'plan_slug' AS stamped_plan_slug,
             payload -> 'plan_item' ->> 'item_id'   AS stamped_item_id,
             title
        FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ${activeWorkspaceId()}
         AND harness_slug = ${harnessSlug}
         AND feature_id   = ${featureId}
       LIMIT 1
    `;
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars) + '\n[truncated]', truncated: true };
}

/**
 * The Now block is a useful launch-time hint, but it is not a live status read.
 * Keep the bounded copy for worker context while making its provenance explicit
 * and giving the successor a deterministic re-read instruction.  Without this
 * marker, a plan edit between prompt assembly and the agent's action makes the
 * copied state look authoritative (the carry-drill failure this guard closes).
 *
 * `row` is optional only for old test seams / callers that provide a parsed plan
 * without the PG envelope.  Real `readPlanBySlug` results always carry it; an
 * unknown marker is safer than silently presenting an unversioned snapshot.
 */
function renderSnapshotNotice(
  planSlug: string,
  row?: { version?: number | null; contentHash?: string | null; updatedAt?: string | null },
): string {
  const revision = Number.isFinite(row?.version) ? String(row!.version) : 'unknown';
  const contentHash = row?.contentHash?.trim() || 'unknown';
  const updatedAt = row?.updatedAt?.trim() || 'unknown';
  return (
    `> PLAN SNAPSHOT (volatile copy, not live status): \`${planSlug}\` revision ${revision}, ` +
    `contentHash \`${contentHash}\`, read at ${updatedAt}. Before acting on any current-state ` +
    `claim below, re-read \`plans:get { slug: '${planSlug}', heading: 'Now' }\` and discard ` +
    'this copy if the revision or content hash changed.'
  );
}

/**
 * Returns a formatted `## Source Plan Context` section for the given
 * feature, or `null` when:
 *   - the feature has no `source_plan_slug` in PG
 *   - the plan file cannot be read
 *   - PG is unavailable (best-effort)
 *
 * Caller must check `role` belongs to ROLES_RECEIVING_CONTEXT before
 * calling; this function does not filter by role.
 */
export async function getPlanContextForFeature(
  harnessSlug: string,
  featureId: string,
): Promise<PlanContextResult | null> {
  const provenance = await queryProvenance(harnessSlug, featureId);
  // EI-19435123521651527: resolve through the shared precedence rule — the legacy
  // `source_plan_item_ids` column has been effectively unwritten since the mint path
  // moved to the `payload.plan_item` stamp, so reading it alone dropped the item scope
  // (and, for a stamp-only row, the plan slug) without any error to notice.
  const { planSlug, itemIds } = planItemProvenanceFromRow(provenance);
  if (!planSlug) return null;

  let planResult: Awaited<ReturnType<typeof readPlanBySlug>>;
  try {
    planResult = await readPlanBySlug(planSlug);
  } catch {
    planResult = null;
  }
  if (!planResult) return null;

  const { parsed } = planResult;
  const row = planResult.row;

  const parts: string[] = [PLAN_CONTEXT_HEADING, ''];

  const planTitle = parsed.frontmatter.title ?? planSlug;
  parts.push(`**Plan:** \`${planSlug}\` — ${planTitle}`);
  parts.push(renderSnapshotNotice(planSlug, row));

  // Source item body (first matching from_item id)
  if (itemIds.length > 0) {
    const item = parsed.items.find((i) => itemIds.includes(i.id));
    if (item) {
      const itemPreview = item.text.slice(0, 200);
      parts.push(`**Item ${item.id}:** ${itemPreview}${item.text.length > 200 ? '…' : ''}`);
    }
  }
  parts.push('');

  // Now block
  if (parsed.now) {
    parts.push('### Current State', '', parsed.now.state, '', `**Next:** ${parsed.now.next}`);
  }

  // Last 3 decisions, most-recent first
  const recentDecisions = parsed.decisions.slice(-3).reverse();
  if (recentDecisions.length > 0) {
    parts.push('', '### Recent Decisions', '');
    for (const d of recentDecisions) {
      const body = d.body.slice(0, 300);
      parts.push(`**${d.id} — ${d.title}**\n${body}${d.body.length > 300 ? '…' : ''}`);
    }
  }

  parts.push('');

  const raw = parts.join('\n');
  const { text, truncated } = truncate(raw, PLAN_CONTEXT_CHAR_BUDGET);

  return {
    section: text,
    planSlug,
    truncated,
    revision: Number.isFinite(row?.version) ? Number(row.version) : null,
    contentHash: row?.contentHash ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

/**
 * Returns a combined `## Source Plans Context` section for a batch of
 * feature IDs. Used by PM dispatch, which operates on multiple features.
 *
 * Deduplicates by plan slug; at most 2 plans are included to cap context
 * size. Returns null if no features have source_plan_slug set.
 */
export async function getPlanContextsForFeatures(
  harnessSlug: string,
  featureIds: string[],
): Promise<string | null> {
  if (featureIds.length === 0) return null;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<Array<{ source_plan_slug: string }>>`
      SELECT DISTINCT source_plan_slug
        FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ${activeWorkspaceId()}
         AND harness_slug = ${harnessSlug}
         AND feature_id   = ANY(${featureIds})
         AND source_plan_slug IS NOT NULL
       LIMIT 2
    `;
    if (rows.length === 0) return null;

    const sections: string[] = ['## Source Plans Context', ''];
    for (const { source_plan_slug } of rows) {
      let planResult: Awaited<ReturnType<typeof readPlanBySlug>>;
      try { planResult = await readPlanBySlug(source_plan_slug); } catch { continue; }
      if (!planResult) continue;

      const { parsed, row } = planResult;
      const planTitle = parsed.frontmatter.title ?? source_plan_slug;
      sections.push(`### Plan: \`${source_plan_slug}\` — ${planTitle}`, '');
      sections.push(renderSnapshotNotice(source_plan_slug, row));
      if (parsed.now) {
        sections.push(parsed.now.state, '', `**Next:** ${parsed.now.next}`);
      }
      const recent = parsed.decisions.slice(-2).reverse();
      if (recent.length > 0) {
        sections.push('', '**Recent Decisions:**');
        for (const d of recent) {
          sections.push(`- **${d.id} — ${d.title}**: ${d.body.slice(0, 200)}${d.body.length > 200 ? '…' : ''}`);
        }
      }
      sections.push('');
    }

    const raw = sections.join('\n');
    const { text } = truncate(raw, 4_000);
    return text;
  } catch {
    return null;
  }
}

/**
 * Returns a `## Source Plan Context` section for a plan referenced directly
 * by slug (not via a feature's provenance). Used by interactive role
 * sessions for plan-consuming roles (`scoper`, `reviewer` — `consumes.plan`
 * !== 'none') launched against a chosen plan rather than a feature.
 *
 * Returns null when the plan can't be read. Same Now-block + last-3-decisions
 * shape and char budget as the feature-keyed variant.
 */
export async function getPlanContextBySlug(
  planSlug: string,
): Promise<string | null> {
  if (!planSlug) return null;
  let planResult: Awaited<ReturnType<typeof readPlanBySlug>>;
  try {
    planResult = await readPlanBySlug(planSlug);
  } catch {
    planResult = null;
  }
  if (!planResult) return null;

  const { parsed, row } = planResult;
  const parts: string[] = [PLAN_CONTEXT_HEADING, ''];
  const planTitle = parsed.frontmatter.title ?? planSlug;
  parts.push(`**Plan:** \`${planSlug}\` — ${planTitle}`, '');
  parts.push(renderSnapshotNotice(planSlug, row));

  if (parsed.now) {
    parts.push('### Current State', '', parsed.now.state, '', `**Next:** ${parsed.now.next}`);
  }
  const recentDecisions = parsed.decisions.slice(-3).reverse();
  if (recentDecisions.length > 0) {
    parts.push('', '### Recent Decisions', '');
    for (const d of recentDecisions) {
      const body = d.body.slice(0, 300);
      parts.push(`**${d.id} — ${d.title}**\n${body}${d.body.length > 300 ? '…' : ''}`);
    }
  }
  parts.push('');

  const { text } = truncate(parts.join('\n'), PLAN_CONTEXT_CHAR_BUDGET);
  return text;
}

export { ROLES_RECEIVING_CONTEXT };
