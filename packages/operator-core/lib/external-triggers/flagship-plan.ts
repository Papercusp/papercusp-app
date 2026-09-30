/**
 * flagship-plan — install AND KEEP CURRENT the built-in external-trigger plan
 * templates (Gmail respond-with-draft, Slack respond-in-thread).
 *
 * ── WHY THE REFRESH PATH EXISTS (WI-2143575) ──
 * Both flagship modules previously carried a byte-identical `ensure…Plan` that
 * INSERTed the template when absent and, for an already-installed row, only
 * backfilled `input_schema` WHEN IT WAS NULL. It never refreshed content or
 * schema. That is a silent-breakage trap the moment the ENGINE's emitted shape
 * changes: the installed `input_schema` keeps requiring a field the engine no
 * longer sends, every launch fails schema validation, and the failure has no
 * error surface — a refused launch just means no run appears.
 *
 * So the contract is now: an installed flagship row is brought up to the current
 * template. Two different things are kept current for two different reasons.
 *
 *   input_schema — the ENGINE'S CONTRACT. It describes what the binding engine
 *     actually puts in `inputs`, so it is machine-owned and is refreshed
 *     whenever it differs. Letting it drift is what breaks launches.
 *
 *   content — the agent-facing prose, refreshed when its hash differs from the
 *     template's. These are system-installed built-ins ("Ready built-in
 *     template"); an owner who wants different behaviour authors their own plan
 *     and binding rather than editing one the installer owns. Measured before
 *     choosing this (2026-09-04): the live `email` row differed from the
 *     template in exactly one byte-range — a bumped `updated:` front-matter date
 *     — i.e. installer drift, not a customization. Refreshing content also has
 *     to happen for correctness here, because the P-001 instruction tells the
 *     agent HOW to reach the message; leaving it stale strands the agent just as
 *     surely as a stale schema refuses the launch.
 */

import type postgres from 'postgres';
import { hashPlanContent } from '@papercusp/plan-parser/content-hash';
import { deriveIndexFromContent } from '../agent-tools/plans/source';
import { writePlanIndexRows } from '../agent-tools/plans/plan-index-rows';

export interface FlagshipPlanSpec {
  harnessSlug: string;
  planSlug: string;
  content: string;
  inputSchema: unknown;
}

export interface FlagshipPlanEnsureResult {
  /** The plan row did not exist and was installed by this call. */
  created: boolean;
  /** `input_schema` was written by this call (it was absent or had drifted). */
  schemaAdded: boolean;
  /** An already-installed row's content was brought up to the current template. */
  refreshed: boolean;
}

interface ExistingPlanRow {
  contentHash: string | null;
  schemaStale: boolean;
}

export async function ensureFlagshipPlan(
  sql: postgres.Sql,
  workspaceId: string,
  spec: FlagshipPlanSpec,
): Promise<FlagshipPlanEnsureResult> {
  const idx = deriveIndexFromContent(spec.content);
  const itemsJson = JSON.stringify(idx.items);
  const decisionsJson = JSON.stringify(idx.decisions);
  const inputSchemaJson = JSON.stringify(spec.inputSchema);
  const contentHash = hashPlanContent(spec.content);

  return sql.begin(async (tx) => {
    const lockKey = [workspaceId, spec.harnessSlug, spec.planSlug].join(':');
    await tx`SELECT pg_advisory_xact_lock(hashtext('harness_plans'), hashtext(${lockKey}))`;
    const existing = await tx<ExistingPlanRow[]>`
      SELECT content_hash AS "contentHash",
             (input_schema IS DISTINCT FROM ${inputSchemaJson}::text::jsonb) AS "schemaStale"
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${spec.harnessSlug}
         AND plan_slug = ${spec.planSlug}`;

    if (existing[0]) {
      const contentStale = existing[0].contentHash !== contentHash;
      const schemaStale = existing[0].schemaStale;
      if (!contentStale && !schemaStale) return { created: false, schemaAdded: false, refreshed: false };

      if (contentStale) {
        // Full refresh: the index columns are all derived from content, so they
        // must move with it or the plan's items/decisions describe the old text.
        await tx`
          UPDATE harness_shared.harness_plans
             SET content = ${spec.content},
                 content_hash = ${contentHash},
                 title = ${idx.title},
                 status = ${idx.status},
                 items = ${itemsJson}::text::jsonb,
                 decisions = ${decisionsJson}::text::jsonb,
                 now_state = ${idx.nowState},
                 now_next = ${idx.nowNext},
                 updated = ${idx.updated},
                 input_schema = ${inputSchemaJson}::text::jsonb,
                 version = version + 1,
                 updated_at = now()
           WHERE workspace_id = ${workspaceId}
             AND harness_slug = ${spec.harnessSlug}
             AND plan_slug = ${spec.planSlug}`;
        await writePlanIndexRows(
          tx as unknown as Parameters<typeof writePlanIndexRows>[0],
          { workspaceId, harnessSlug: spec.harnessSlug, planSlug: spec.planSlug },
          idx,
        );
        return { created: false, schemaAdded: true, refreshed: true };
      }

      await tx`
        UPDATE harness_shared.harness_plans
           SET input_schema = ${inputSchemaJson}::text::jsonb,
               version = version + 1, updated_at = now()
         WHERE workspace_id = ${workspaceId}
           AND harness_slug = ${spec.harnessSlug}
           AND plan_slug = ${spec.planSlug}`;
      return { created: false, schemaAdded: true, refreshed: false };
    }

    await tx`
      INSERT INTO harness_shared.harness_plans (
        workspace_id, harness_slug, plan_slug, title, status, content, content_hash,
        version, created, updated, is_legacy, items, decisions, now_state, now_next,
        input_schema, origin
      ) VALUES (
        ${workspaceId}, ${spec.harnessSlug}, ${spec.planSlug},
        ${idx.title}, ${idx.status}, ${spec.content},
        ${contentHash}, 1,
        ${idx.created}, ${idx.updated}, ${idx.isLegacy}, ${itemsJson}::text::jsonb,
        ${decisionsJson}::text::jsonb, ${idx.nowState}, ${idx.nowNext},
        ${inputSchemaJson}::text::jsonb, 'local'
      )`;
    await writePlanIndexRows(
      tx as unknown as Parameters<typeof writePlanIndexRows>[0],
      { workspaceId, harnessSlug: spec.harnessSlug, planSlug: spec.planSlug },
      idx,
    );
    return { created: true, schemaAdded: true, refreshed: false };
  });
}
