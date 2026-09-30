/**
 * Completion-time `for_each` expansion (P-043 / D-019).
 *
 * A generative wave declared `for_each: { from_feature: <id> }` is NOT expanded
 * at promote time — its item-set isn't known until the producing feature does
 * its discovery work. That feature's worker PUBLISHES its items (the
 * `generators:publish` tool → `harness_generator_items`), and this module then
 * mints one child feature per item, each `blocked_by` the producing feature.
 * The P-042 frontier already enforces that a `blocked_by` feature can't dispatch
 * until its blocker is terminal, so the children naturally wait for the producer
 * to finish — no DBOS-finalizer-replay machinery, no `jq`, no opaque artifact.
 *
 * Idempotent: each child's id is DETERMINISTIC from (plan, wave, item), so a
 * re-publish / re-expand upserts the same rows via /features/import rather than
 * double-minting.
 */
import { getOrgPg } from '@papercusp/db-org';
import { shortHash, expandFanout } from '@papercusp/fanout-resolver';
import { readPlanBySlug } from './source';
import { parsePromotePolicy, buildWaveFeatures, type PromoteWave, type ParsePromoteResult } from './promote-policy';
import { loopbackFetch } from '../../loopback-fetch';

/** The org-PG tagged-template client type — for the optional test seam below. */
type OrgSql = ReturnType<typeof getOrgPg>['sql'];

function operatorBase(): string {
  const port = process.env.PORT ?? '3055';
  return process.env.INTERNAL_API_BASE ?? `http://127.0.0.1:${port}`;
}

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * Pure: the completion-time generative waves whose `for_each.from_feature`
 * resolves to this feature (by id or, failing that, by title).
 */
export function selectCompletionTimeWaves(
  policy: { waves: PromoteWave[] },
  featureId: string,
  featureTitle?: string | null,
): PromoteWave[] {
  return policy.waves.filter((w) => {
    const fe = w.generate?.for_each;
    if (!fe || typeof fe !== 'object' || !('from_feature' in fe)) return false;
    const ref = norm(fe.from_feature);
    return ref === norm(featureId) || (!!featureTitle && ref === norm(featureTitle));
  });
}

/** A child feature in the shape `/features/import` accepts. */
export interface GeneratedChild {
  id: string;
  title: string;
  summary?: string;
  metadata: Record<string, unknown>;
  source_plan_slug: string;
  blocked_by: string[];
}

/**
 * Pure: build the import payload for one generative wave's children from its
 * published items. Each child gets a DETERMINISTIC id (idempotent re-expansion),
 * `blocked_by` the producing feature (the P-042 frontier gates it), and
 * `metadata.generated_by` provenance. Throws `FanoutCapError` over the cap.
 */
export function planGeneratorChildren(
  wave: PromoteWave,
  items: readonly string[],
  opts: { planSlug: string; sourceFeatureId: string; cap?: number },
): GeneratedChild[] {
  // The generic `expandFanout` dedupes/trims/caps the items (throwing
  // FanoutCapError over the cap); this builder shapes one wave-feature child per
  // item, with a deterministic id (idempotent re-expansion via `shortHash`).
  return expandFanout<GeneratedChild>(
    items,
    (item) => {
      const f = buildWaveFeatures(wave, { generateItems: [item] }).features.find((x) => x.generated)!;
      const id = `F-GEN-${shortHash(`${opts.planSlug}:${wave.id}:${f.title}`)}`;
      const summaryParts = [f.body, ...(f.acceptance ?? []).map((a) => `- ${a}`)].filter(Boolean) as string[];
      return {
        id,
        title: f.title,
        ...(summaryParts.length > 0 && { summary: summaryParts.join('\n') }),
        metadata: {
          source_plan: opts.planSlug,
          generated_by: { plan: opts.planSlug, wave: wave.id, source: opts.sourceFeatureId },
        },
        source_plan_slug: opts.planSlug,
        // Edge-rewrite into the P-042 frontier: a child waits for its producer.
        blocked_by: [opts.sourceFeatureId],
      };
    },
    { cap: opts.cap },
  );
}

export interface ExpandResult {
  /** Total child features minted across all sourced waves. */
  expanded: number;
  /** How many completion-time waves this feature sources. */
  waves: number;
  /** The minted child feature ids. */
  childIds: string[];
  /** Escalation reasons (fan-out over cap, import failure, sourced-but-empty). */
  escalations: string[];
}

const EMPTY: ExpandResult = { expanded: 0, waves: 0, childIds: [], escalations: [] };

/**
 * Expand every completion-time generative wave sourced by `featureId`, using the
 * items it has published. Mints children via /features/import (deterministic ids
 * → idempotent). Best-effort per wave: a fan-out/import failure is collected as
 * an escalation, never thrown, so one bad wave doesn't sink the others.
 *
 * `requireItems`: when true (a DONE-finalizer safety check), a wave that sources
 * from this feature but has NO published items is recorded as an escalation
 * (never silently yields zero children — D-012a). When false (the publish-time
 * call, where empty just means "nothing to expand yet"), it's a quiet skip.
 */
export async function expandGeneratorsForFeature(input: {
  harnessSlug: string;
  featureId: string;
  workspaceId: string;
  requireItems?: boolean;
  /**
   * Test seam (DI): inject the org-PG client, the plan reader, and the
   * /features/import fetch. All default to the real ones — production callers
   * (the publish-time call + the DONE-finalizer) pass none. Lets the driver
   * glue (source-plan + items lookup, the D-012a "never silently yields zero"
   * escalation, import success/failure, per-wave isolation) be unit-tested
   * without PG or a live loopback endpoint.
   */
  deps?: {
    sql?: OrgSql;
    // v2 P-001: `row.promotePolicy` carries the structured policy (parsed at write-time); `row` is
    // OPTIONAL so existing test stubs (which omit it) still typecheck + fall back to parsing the raw.
    readPlan?: (slug: string) => Promise<{ parsed: { raw: string }; row?: { promotePolicy: ParsePromoteResult | null } } | null>;
    fetchImport?: (
      url: string,
      init: { method: string; headers: Record<string, string>; body: string },
    ) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  };
}): Promise<ExpandResult> {
  const { harnessSlug, featureId, workspaceId } = input;
  const sql = input.deps?.sql ?? getOrgPg().sql;
  const readPlan = input.deps?.readPlan ?? readPlanBySlug;
  const fetchImport = input.deps?.fetchImport ?? loopbackFetch;

  const frows = await sql<Array<{ title: string | null; source_plan: string | null }>>`
    SELECT title, metadata->>'source_plan' AS source_plan
      FROM harness_shared.harness_features_consolidated
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND feature_id = ${featureId}
     LIMIT 1
  `;
  const sourcePlan = frows[0]?.source_plan;
  if (!sourcePlan) return EMPTY;

  const planFile = await readPlan(sourcePlan);
  if (!planFile) return EMPTY;
  // v2 P-001: read the structured promote-policy from the row; fall back to parsing the raw when the
  // row is absent (a minimal test stub) or its column is null (a not-yet-repopulated pre-mig-331 plan).
  const { policy } = planFile.row?.promotePolicy ?? parsePromotePolicy(planFile.parsed.raw);
  if (!policy) return EMPTY;

  const waves = selectCompletionTimeWaves(policy, featureId, frows[0]?.title ?? null);
  if (waves.length === 0) return EMPTY;

  const irows = await sql<Array<{ items: unknown }>>`
    SELECT items FROM harness_shared.harness_generator_items
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND feature_id = ${featureId}
     LIMIT 1
  `;
  const items = Array.isArray(irows[0]?.items) ? (irows[0]!.items as string[]) : [];

  const result: ExpandResult = { expanded: 0, waves: waves.length, childIds: [], escalations: [] };
  for (const wave of waves) {
    if (items.length === 0) {
      if (input.requireItems) {
        result.escalations.push(
          `wave "${wave.id}" sources from ${featureId}, which finished but published no items — ` +
            `the generative wave can't expand (escalate; never silently yields zero)`,
        );
      }
      continue;
    }
    let children: GeneratedChild[];
    try {
      children = planGeneratorChildren(wave, items, { planSlug: sourcePlan, sourceFeatureId: featureId });
    } catch (e) {
      result.escalations.push(e instanceof Error ? e.message : String(e));
      continue;
    }
    try {
      const r = await fetchImport(
        `${operatorBase()}/api/harness/${encodeURIComponent(harnessSlug)}/features/import`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ features: children }) },
      );
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        result.escalations.push(`wave "${wave.id}" import failed: ${r.status} ${t.slice(0, 160)}`);
        continue;
      }
      result.expanded += children.length;
      result.childIds.push(...children.map((c) => c.id));
    } catch (e) {
      result.escalations.push(`wave "${wave.id}" import error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}
