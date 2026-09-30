import { withWorkspace } from '@papercusp/db-org';
import { seedAcceptanceBarsInTransaction } from './acceptance-bar-seed';
import { rubricTemplateDataAuthoringSchema } from './agent-tools/plans/rubric-template';
import type { SpecClauseSql } from './agent-tools/plans/spec-clauses-store';

/**
 * P-010 acceptance-BAR cohort migration core.
 *
 * The runner is deliberately storage-agnostic.  A caller supplies one page
 * reader and one per-plan transaction callback, so each plan can commit or roll
 * back independently while the cursor remains resumable.  The callback is the
 * seam that invokes the canonical acceptance-bar seed writer; this module owns
 * only cohort policy, ordering, dry-run semantics, and no-fabrication refusals.
 */

export const ACCEPTANCE_BAR_MIGRATION_DEFAULT_BATCH_SIZE = 25;

const TERMINAL_STATUSES = new Set(['shipped', 'superseded', 'retired', 'deprecated', 'closed', 'done']);

export type AcceptanceBarMigrationAction =
  | 'skip-historical-terminal'
  | 'seed-strict'
  | 'legacy-backfill'
  | 'bar-backfill-required';

export interface AcceptanceBarMigrationPlan {
  planSlug: string;
  status: string | null;
  content: string;
  /** PG-canonical fields used by the database adapter to preserve identity. */
  title?: string | null;
  version?: number;
  acceptanceBarEpoch?: number | null;
  acceptanceBarCohort?: 'post-epoch' | 'legacy-backfilled' | null;
  /** A current acceptance criterion may be used only when this explicit input is true. */
  explicitLegacyCriterion?: { model: string; barKey?: string; evidencePlane?: 'tree' | 'deployed' | 'live' } | null;
  /** The migration caller has verified that the legacy map has at least one live P-NNN. */
  hasLiveMapping?: boolean;
  /** Internal adapter data for an explicit legacy criterion's live map. */
  legacyPlanItemIds?: string[];
}

export interface AcceptanceBarMigrationDecision {
  planSlug: string;
  action: AcceptanceBarMigrationAction;
  cohort: 'post-epoch' | 'legacy-backfilled' | null;
  reason: string;
}

export function hasRequirementBars(content: string): boolean {
  return /\*\*R-\d+\s+[—–-]\s+.+?\.\*\*/m.test(content);
}

/** Classify one plan without inventing a BAR source. */
export function classifyAcceptanceBarMigration(plan: AcceptanceBarMigrationPlan): AcceptanceBarMigrationDecision {
  const status = plan.status?.trim().toLowerCase() ?? null;
  if (status && TERMINAL_STATUSES.has(status)) {
    return {
      planSlug: plan.planSlug,
      action: 'skip-historical-terminal',
      cohort: null,
      reason: `terminal status '${status}' remains closed historical validation history`,
    };
  }
  if (status === 'draft') {
    return {
      planSlug: plan.planSlug,
      action: 'seed-strict',
      cohort: 'post-epoch',
      reason: 'drafts receive the durable epoch marker and strict BAR seeding',
    };
  }
  // Enforcement membership and when these BARs were authored are independent.
  // Backfilling a strict plan must not make it disappear from the adoption census.
  const cohort = plan.acceptanceBarCohort === 'post-epoch' ||
    (plan.acceptanceBarEpoch != null && plan.acceptanceBarCohort !== 'legacy-backfilled')
    ? 'post-epoch' : 'legacy-backfilled';
  if (hasRequirementBars(plan.content)) {
    return {
      planSlug: plan.planSlug,
      action: 'legacy-backfill',
      cohort,
      reason: 'Requirements contains explicit R-N source bars',
    };
  }
  if (plan.explicitLegacyCriterion && plan.hasLiveMapping) {
    return {
      planSlug: plan.planSlug,
      action: 'legacy-backfill',
      cohort,
      reason: 'caller supplied an explicit current criterion and verified a live mapping',
    };
  }
  return {
    planSlug: plan.planSlug,
    action: 'bar-backfill-required',
    cohort: null,
    reason: 'no trustworthy R-N source or explicit mapped legacy criterion; fabricated BARs are forbidden',
  };
}

export interface AcceptanceBarMigrationPage {
  plans: AcceptanceBarMigrationPlan[];
  /** The source returns this when more rows remain after the page. */
  nextCursor: string | null;
}

export interface AcceptanceBarMigrationDatabaseOptions {
  workspaceId: string;
  harnessSlug: string;
  /** Optional single-plan scope for a controlled dogfood/revalidation pass. */
  planSlug?: string;
  actorId: string;
  cursor?: string | null;
  batchSize?: number;
  dryRun?: boolean;
  legacyCriterionMap?: Record<string, string>;
  now?: Date;
}

interface AcceptanceBarMigrationDbRow {
  plan_slug: string;
  status: string | null;
  content: string;
  title: string | null;
  version: number | string;
  acceptance_bar_epoch: number | string | null;
  acceptance_bar_cohort: 'post-epoch' | 'legacy-backfilled' | null;
}

interface LegacyCriterionSource {
  criterion: { model: string; barKey?: string; evidencePlane?: 'tree' | 'deployed' | 'live' };
  planItemIds: string[];
}

function legacyCriterionFromTemplateData(templateData: unknown): LegacyCriterionSource['criterion'] | null {
  const parsed = rubricTemplateDataAuthoringSchema.safeParse(templateData);
  if (!parsed.success || parsed.data.kind !== 'acceptance') return null;
  const criterion = parsed.data.criteria.find((item) => item.role === 'outcome' && item.mandatory);
  if (!criterion || typeof criterion.model !== 'string' || criterion.model.trim().length === 0) return null;
  return {
    model: criterion.model,
    ...(criterion.barKey ? { barKey: criterion.barKey } : {}),
    ...(criterion.evidencePlane ? { evidencePlane: criterion.evidencePlane } : {}),
  };
}

/**
 * EI-23379913422335853 — which bar key the legacy-backfill clause match may filter on.
 *
 * Extracted as a pure function so BOTH arms are guarded by the UNIT lane. That matters
 * specifically here: this decision is only otherwise exercised through SQL, and an
 * `*.integration.test.ts` is excluded by the unit layer's exclude-glob
 * (libs/test-config/src/vitest-config.ts:161-163), so it never runs under the
 * `npm run test:affected` the green-checkpoint gate executes. A drill that cannot run
 * reports the same green as a passing one.
 *
 * `planHasBarKeyAttribution` = does ANY clause revision on this plan carry a non-NULL
 * `source_bar_key`? Returning null makes the caller's predicate
 * `(${key}::text IS NULL OR r.source_bar_key = ${key})` short-circuit to a barKey-AGNOSTIC
 * match. The attribution guard is what keeps that from being a correctness regression:
 * a plan that DOES attribute keeps the strict match, so a clause can never be
 * mis-attributed to the wrong bar.
 */
export function effectiveLegacyBarKey(
  criterionBarKey: string | null | undefined,
  planHasBarKeyAttribution: boolean,
): string | null {
  return planHasBarKeyAttribution ? criterionBarKey ?? null : null;
}

function appendLegacyCriterionSource(content: string, source: LegacyCriterionSource): string {
  const barKey = source.criterion.barKey ?? 'R-1';
  const title = barKey;
  const evidencePlane = source.criterion.evidencePlane ?? 'tree';
  const requirement = `**${barKey} — ${title}.** ${source.criterion.model.trim()}`;
  const requirementHeading = /^##\s+Requirements\s*$/im.exec(content);
  const withRequirements = requirementHeading
    ? `${content.slice(0, requirementHeading.index + requirementHeading[0].length)}\n\n${requirement}${content.slice(requirementHeading.index + requirementHeading[0].length)}`
    : `${content.trimEnd()}\n\n## Requirements\n\n${requirement}\n`;
  const mapping = `| ${barKey} | ${source.planItemIds.join(', ')} | ${evidencePlane} |`;
  const mapSection = `### Bar-to-work map for this plan\n\n| bar | implementing plan items | evidence plane |\n|---|---|---|\n${mapping}\n`;
  const designHeading = /^##\s+Design\s*$/im.exec(withRequirements);
  if (!designHeading) return `${withRequirements.trimEnd()}\n\n## Design\n\n${mapSection}`;
  const designBodyStart = designHeading.index + designHeading[0].length;
  const nextSection = /^##\s+/im.exec(withRequirements.slice(designBodyStart));
  const insertAt = nextSection ? designBodyStart + nextSection.index : withRequirements.length;
  return `${withRequirements.slice(0, insertAt).trimEnd()}\n\n${mapSection}${withRequirements.slice(insertAt)}`;
}

/**
 * Database adapter for the storage-agnostic runner. Reads a stable slug-ordered
 * page and applies each plan through the canonical seed writer in its own
 * `withWorkspace` transaction. The marker update is in that same transaction,
 * so a seed refusal rolls the marker back with the rubric/projection writes.
 */
export async function runAcceptanceBarMigrationInDatabase(
  options: AcceptanceBarMigrationDatabaseOptions,
): Promise<AcceptanceBarMigrationRun> {
  const now = options.now ?? new Date();
  const readPage = async ({
    cursor,
    limit,
  }: {
    cursor: string | null;
    limit: number;
  }): Promise<AcceptanceBarMigrationPage> => {
    return withWorkspace(options.workspaceId, async (tx) => {
      const after = cursor ? tx`AND p.plan_slug > ${cursor}` : tx``;
      const rows = await tx<AcceptanceBarMigrationDbRow[]>`
        SELECT p.plan_slug, p.status, p.content, p.title, p.version,
               p.acceptance_bar_epoch, p.acceptance_bar_cohort
          FROM harness_shared.harness_plans p
         WHERE p.workspace_id = ${options.workspaceId}
           AND p.harness_slug = ${options.harnessSlug}
           AND p.archived = false
           AND p.template IS DISTINCT FROM 'rubric'
           AND (${options.planSlug ?? null}::text IS NULL OR p.plan_slug = ${options.planSlug ?? null})
           AND (p.acceptance_bar_set_hash IS NULL OR p.acceptance_bar_epoch IS NULL)
           ${after}
         ORDER BY p.plan_slug ASC
         LIMIT ${limit + 1}`;
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const plans: AcceptanceBarMigrationPlan[] = [];
      for (const row of pageRows) {
        const plan: AcceptanceBarMigrationPlan = {
          planSlug: row.plan_slug,
          status: row.status,
          content: row.content,
          title: row.title,
          version: Number(row.version),
          acceptanceBarEpoch: row.acceptance_bar_epoch == null ? null : Number(row.acceptance_bar_epoch),
          acceptanceBarCohort: row.acceptance_bar_cohort,
        };
        if (!hasRequirementBars(row.content)) {
          const rubricRows = await tx<Array<{ template_data: unknown }>>`
            SELECT template_data
              FROM harness_shared.harness_plans
             WHERE workspace_id = ${options.workspaceId}
               AND harness_slug = ${options.harnessSlug}
               AND template = 'rubric'
               AND template_slug IS NULL
               AND archived = false
               AND status IN ('active', 'ready')
               AND template_data->>'kind' = 'acceptance'
               AND template_data->>'subjectPlan' = ${row.plan_slug}
             ORDER BY updated_at DESC NULLS LAST, plan_slug ASC
             LIMIT 1`;
          const criterion = legacyCriterionFromTemplateData(rubricRows[0]?.template_data);
          if (criterion) {
            // EI-23379913422335853 — the legacy branch exists for a plan with no `**R-N — ...**`
            // source bars, but it used to match clauses against the criterion's barKey. A plan old
            // enough to need legacy backfill is exactly the plan whose clauses predate
            // `source_bar_key`, so every row was excluded, `mapRows` came back empty, and the branch
            // could never satisfy its own precondition — the migration refused `bar-backfill-required`
            // for the cohort it was written for.
            //
            // Bar-key attribution is only meaningful when this plan actually uses bar keys. If NOTHING
            // in it carries one, fall back to the barKey-agnostic match. A plan that DOES attribute
            // keeps the strict match, so this can never mis-attribute a clause to the wrong bar.
            const attributionRows = await tx<Array<{ has_attribution: boolean }>>`
              SELECT EXISTS (
                SELECT 1
                  FROM harness_shared.plan_spec_clause_revisions r
                 WHERE r.workspace_id = ${options.workspaceId}
                   AND r.harness_slug = ${options.harnessSlug}
                   AND r.plan_slug = ${row.plan_slug}
                   AND r.source_bar_key IS NOT NULL
              ) AS has_attribution`;
            const effectiveBarKey = effectiveLegacyBarKey(
              criterion.barKey,
              attributionRows[0]?.has_attribution ?? false,
            );
            const mapRows = await tx<Array<{ plan_item_id: string }>>`
              SELECT DISTINCT r.plan_item_id
                FROM harness_shared.plan_spec_clauses c
                JOIN harness_shared.plan_spec_clause_revisions r
                  ON r.workspace_id = c.workspace_id AND r.harness_slug = c.harness_slug
                 AND r.plan_slug = c.plan_slug AND r.spec_id = c.spec_id
                 AND r.revision = c.current_revision
               WHERE c.workspace_id = ${options.workspaceId}
                 AND c.harness_slug = ${options.harnessSlug}
                 AND c.plan_slug = ${row.plan_slug}
                 AND r.plan_item_id IS NOT NULL
                 AND (${effectiveBarKey}::text IS NULL OR r.source_bar_key = ${effectiveBarKey})
                 AND r.lifecycle_status NOT IN ('retired', 'exempt')
               ORDER BY r.plan_item_id`;
            if (mapRows.length > 0) {
              plan.explicitLegacyCriterion = criterion;
              plan.hasLiveMapping = true;
              plan.legacyPlanItemIds = mapRows.map((item) => item.plan_item_id);
            }
          }
        }
        plans.push(plan);
      }
      return {
        plans,
        nextCursor: hasMore ? (pageRows.at(-1)?.plan_slug ?? null) : null,
      };
    });
  };

  const executePlan = async ({ plan, decision }: { plan: AcceptanceBarMigrationPlan; decision: AcceptanceBarMigrationDecision }, dryRun = false) => {
      return withWorkspace(options.workspaceId, async (tx) => {
        const currentRows = await tx<AcceptanceBarMigrationDbRow[]>`
          SELECT plan_slug, status, content, title, version,
                 acceptance_bar_epoch, acceptance_bar_cohort
            FROM harness_shared.harness_plans
           WHERE workspace_id = ${options.workspaceId}
             AND harness_slug = ${options.harnessSlug}
             AND plan_slug = ${plan.planSlug}
           FOR UPDATE`;
        const current = currentRows[0];
        if (!current) throw new Error(`plan_not_found:${plan.planSlug}`);
        if (current.content !== plan.content || Number(current.version) !== Number(plan.version) ||
            current.acceptance_bar_cohort !== plan.acceptanceBarCohort ||
            Number(current.acceptance_bar_epoch ?? 0) !== Number(plan.acceptanceBarEpoch ?? 0)) {
          throw new Error(`plan_changed_retry:${plan.planSlug}`);
        }
        const cohort = decision.cohort ?? (decision.action === 'seed-strict' ? 'post-epoch' : 'legacy-backfilled');
        if (!dryRun) await tx`
          UPDATE harness_shared.harness_plans
             SET acceptance_bar_epoch = COALESCE(acceptance_bar_epoch, 1),
                 acceptance_bar_cohort = ${cohort}
           WHERE workspace_id = ${options.workspaceId}
             AND harness_slug = ${options.harnessSlug}
             AND plan_slug = ${plan.planSlug}
             AND acceptance_bar_set_hash IS NULL`;

        const seedContent =
          plan.explicitLegacyCriterion && plan.legacyPlanItemIds?.length
            ? appendLegacyCriterionSource(current.content, {
                criterion: plan.explicitLegacyCriterion,
                planItemIds: plan.legacyPlanItemIds,
              })
            : current.content;
        const seeded = await seedAcceptanceBarsInTransaction({
          executor: tx as unknown as SpecClauseSql,
          workspaceId: options.workspaceId,
          harnessSlug: options.harnessSlug,
          planSlug: current.plan_slug,
          planContent: seedContent,
          planTitle: current.title,
          planStatus: current.status,
          planVersion: Number(current.version),
          adoptionEpoch: Number(current.acceptance_bar_epoch ?? 1),
          cohort,
          backfilled: decision.action === 'legacy-backfill',
          legacyCriterionMap: options.legacyCriterionMap,
          actorId: options.actorId,
          now,
          dryRun,
        });
        if (!seeded.ok) {
          throw new Error(`${seeded.error}:${seeded.message}`);
        }
        return dryRun ? JSON.stringify(seeded.preview) : `seeded ${seeded.bars} BAR(s), ${seeded.projectionEdges} projection edge(s), rubric ${seeded.rubricSlug}@${seeded.rubricRevision}`;
      });
    };
  return runAcceptanceBarMigration({
    cursor: options.cursor, batchSize: options.batchSize, dryRun: options.dryRun, readPage,
    applyPlan: (input) => executePlan(input), previewPlan: (input) => executePlan(input, true),
  });
}

export interface AcceptanceBarMigrationOutcome {
  planSlug: string;
  decision: AcceptanceBarMigrationDecision;
  status: 'skipped' | 'dry-run' | 'applied' | 'refused' | 'failed';
  detail: string;
}

export interface AcceptanceBarMigrationRun {
  dryRun: boolean;
  startCursor: string | null;
  nextCursor: string | null;
  complete: boolean;
  outcomes: AcceptanceBarMigrationOutcome[];
}

export interface AcceptanceBarMigrationRunnerOptions {
  cursor?: string | null;
  batchSize?: number;
  dryRun?: boolean;
  readPage: (input: { cursor: string | null; limit: number }) => Promise<AcceptanceBarMigrationPage>;
  /** Apply one plan in its own transaction. Throwing marks only that plan failed. */
  applyPlan: (input: { plan: AcceptanceBarMigrationPlan; decision: AcceptanceBarMigrationDecision }) => Promise<string>;
  previewPlan?: AcceptanceBarMigrationRunnerOptions['applyPlan'];
}

/** Run one bounded page. Repeating with `nextCursor` is safe and resumable. */
export async function runAcceptanceBarMigration(
  options: AcceptanceBarMigrationRunnerOptions,
): Promise<AcceptanceBarMigrationRun> {
  const startCursor = options.cursor ?? null;
  const limit = Math.max(
    1,
    Math.min(500, Math.floor(options.batchSize ?? ACCEPTANCE_BAR_MIGRATION_DEFAULT_BATCH_SIZE)),
  );
  const dryRun = options.dryRun === true;
  const page = await options.readPage({ cursor: startCursor, limit });
  const outcomes: AcceptanceBarMigrationOutcome[] = [];

  for (const plan of page.plans) {
    const decision = classifyAcceptanceBarMigration(plan);
    if (decision.action === 'skip-historical-terminal') {
      outcomes.push({ planSlug: plan.planSlug, decision, status: 'skipped', detail: decision.reason });
      continue;
    }
    if (decision.action === 'bar-backfill-required') {
      outcomes.push({ planSlug: plan.planSlug, decision, status: 'refused', detail: decision.reason });
      continue;
    }
    if (dryRun) {
      try {
        const detail = options.previewPlan ? await options.previewPlan({ plan, decision }) : decision.reason;
        outcomes.push({ planSlug: plan.planSlug, decision, status: 'dry-run', detail });
      } catch (error) {
        outcomes.push({ planSlug: plan.planSlug, decision, status: 'refused',
          detail: error instanceof Error ? error.message : String(error) });
      }
      continue;
    }
    try {
      const detail = await options.applyPlan({ plan, decision });
      outcomes.push({ planSlug: plan.planSlug, decision, status: 'applied', detail });
    } catch (error) {
      outcomes.push({
        planSlug: plan.planSlug,
        decision,
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    dryRun,
    startCursor,
    nextCursor: page.nextCursor,
    complete: page.nextCursor === null,
    outcomes,
  };
}
