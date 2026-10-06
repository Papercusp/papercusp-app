/**
 * P-022 / D-018 (plan `design-to-code-coverage-seam-2026-09-02`): the spec scope that
 * holds clauses for work-items belonging to no plan.
 *
 * ## Why a scope, and not a nullable column
 *
 * The item this implements asked to "make `planSlug` optional end to end" and predicted a
 * migration dropping NOT NULL. Measured 2026-09-02, that is not possible and not needed:
 * `plan_slug` is a PRIMARY KEY column in all four tables of the spec chain
 * (`plan_spec_clauses`, `plan_spec_clause_revisions`, `work_item_spec_revision_edges`,
 * `spec_evidence_bindings`), and PK columns are implicitly NOT NULL — the constraint is a
 * consequence of the key, not an independent decision. The chain also terminates in
 * `plan_spec_clauses_plan_fk → harness_plans(workspace_id, harness_slug, plan_slug)`, so a
 * clause cannot exist without a real plan row at all.
 *
 * The blocker was therefore never the column. It was that the API forced a caller with no
 * plan to invent one. Giving those callers a real, named, shared scope resolves it with no
 * migration and no key surgery on immutable evidence tables — every existing PK, FK, index
 * and freshness invariant keeps working untouched.
 *
 * ## One row per harness, not one per work-item
 *
 * `plan_spec_clauses` is keyed `(workspace_id, harness_slug, plan_slug, spec_id)`, so
 * namespacing `spec_id` by work-item id keeps every ad-hoc item's clauses distinct inside
 * a single shared scope. `work_item_spec_revision_edges` already carries `work_item_id` in
 * its own primary key, so per-item reads are unaffected either way. A plan row per
 * work-item would have added ~4,128 rows/week to `harness_plans` to express a separation
 * the existing keys already make.
 */

import { hashPlanContent } from '@papercusp/plan-parser/content-hash';
import type postgres from 'postgres';

/**
 * The shape `plan_spec_clause_revisions_plan_item_id_check` enforces on the owning item.
 * Mirrored here so this module refuses early rather than letting the database reject the
 * write from a table the caller never mentioned.
 */
const ADHOC_ITEM_ID_SHAPE = /^P-[0-9]{3,}$/;

/** The shared scope slug. Stable — it is written into immutable evidence rows. */
export const ADHOC_WORK_ITEM_SPEC_SCOPE = 'adhoc-work-item-specs';

/**
 * The `planItemId` an ad-hoc clause should be authored under: this work-item's own number,
 * relabelled `P-NNN`.
 *
 * `plans:set-specs` REQUIRES `planItemId` even for a planless item, and nothing in the arg
 * schema says what a caller with no plan should pass — so the value was being invented.
 * Measured 2026-09-20 over the whole ad-hoc scope, 4 of 12 real clauses carried an
 * arbitrary bucket (`P-001` twice, `P-305`, `P-232120`) while 8 used the item's own number.
 * That split is why this is DERIVED here rather than written into prose as a convention:
 * advice that an agent has to instantiate by hand is advice that gets instantiated
 * differently by each agent.
 *
 * The label is only the scope's internal bucket — per-item identity lives in `spec_id`
 * namespacing and `work_item_spec_revision_edges.work_item_id` — so the properties that
 * actually matter are that it is DETERMINISTIC per item and accepted by the database.
 * Returns null when the id yields nothing `plan_spec_clause_revisions_plan_item_id_check`
 * would accept (a short fixture id like `EI-1` → `P-1`), so a caller building advice on
 * this can never name a value the write would then reject.
 */
export function adhocPlanItemIdFor(workItemId: string | null | undefined): string | null {
  const digits = workItemId?.trim().replace(/^[A-Za-z]+-/, '') ?? '';
  const label = `P-${digits}`;
  return ADHOC_ITEM_ID_SHAPE.test(label) ? label : null;
}

/**
 * Body written when the scope row is first materialised.
 *
 * Deliberately a real, self-explaining plan body rather than an empty string: this row DOES
 * appear in `plans:list`, and a bare slug there reads as debris somebody should clean up.
 * Hiding it (archived, or a magic filter) would make the one row that explains where ad-hoc
 * spec evidence lives the hardest one to find.
 */
export const ADHOC_SCOPE_CONTENT = [
  '---',
  `slug: ${ADHOC_WORK_ITEM_SPEC_SCOPE}`,
  'title: Ad-hoc work-item spec scope (system)',
  'status: active',
  '---',
  '',
  '# Ad-hoc work-item spec scope',
  '',
  'System-owned. Not a plan of work — it is the scope that holds spec clauses for work-items',
  'that belong to no plan, so they can carry spec evidence the way plan-bound items do',
  '(P-022 / D-018 of `design-to-code-coverage-seam-2026-09-02`).',
  '',
  'The spec chain is keyed by `plan_slug` all the way down to a foreign key on',
  '`harness_plans`, so a planless work-item had no scope to bind to at all. Clauses here are',
  "namespaced by work-item id in their `spec_id`; per-item identity lives in",
  "`work_item_spec_revision_edges.work_item_id`, already part of that table's key.",
  '',
  'Created lazily on the first ad-hoc clause or binding in this harness. Do not delete: the',
  'spec and evidence tables reference it with ON DELETE RESTRICT.',
].join('\n');

/**
 * The `postgres` client both stores already hold inside their transaction.
 *
 * Deliberately the library's own type rather than a hand-rolled tagged-template shape: a
 * structural stand-in looks equivalent and is not (`Sql<{}>` carries call signatures a
 * minimal `(strings, ...values) => Promise<unknown>` cannot satisfy), so the narrower type
 * compiles here and rejects every real caller.
 */
type TaggedSql = postgres.Sql;

/**
 * Resolve the scope a write belongs to: the caller's plan when they named one, otherwise
 * the shared ad-hoc scope — materialising that scope row on first use.
 *
 * LAZY, so a harness that never binds ad-hoc spec evidence never grows the row, and
 * IDEMPOTENT (`ON CONFLICT DO NOTHING`), so concurrent writers cannot race it. Callers must
 * invoke this INSIDE their transaction and BEFORE any plan-existence check, or the
 * composite FK to `harness_plans` rejects the first ad-hoc clause.
 */
export async function resolveSpecScopeSlug(
  tx: TaggedSql,
  workspaceId: string,
  harnessSlug: string,
  planSlug: string | null | undefined,
  /**
   * The clause's owning item. Supplied by the CLAUSE writer, which requires a matching
   * `plan_items` row; the evidence writer omits it, because by then the clause (and so the
   * item) already exists.
   *
   * MUST be a `P-NNN` label even here: `plan_spec_clause_revisions_plan_item_id_check`
   * enforces `^P-[0-9]{3,}$` at the database, so a work-item id cannot stand in as the
   * owning item however natural that reads. Per-work-item identity is carried by
   * `spec_id` namespacing and by `work_item_spec_revision_edges.work_item_id`, which is
   * where it belongs anyway — this label is just the scope's internal bucket.
   */
  planItemId?: string | null,
): Promise<string> {
  const named = planSlug?.trim();
  if (named) return named;
  // content_hash is written with the body: the column defaults to '' and the plan-parts
  // reconcile joins plan_revisions on it, so a body left at the default hash never
  // matches its own revision (WI-10006321, measured on the live adhoc-work-item-specs row).
  const contentHash = hashPlanContent(ADHOC_SCOPE_CONTENT);
  const materialised = await tx<Array<{ plan_slug: string }>>`
    INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, content, content_hash)
    VALUES (${workspaceId}, ${harnessSlug}, ${ADHOC_WORK_ITEM_SPEC_SCOPE}, ${ADHOC_SCOPE_CONTENT}, ${contentHash})
    ON CONFLICT (workspace_id, harness_slug, plan_slug) DO NOTHING
    RETURNING plan_slug`;
  if (materialised.length > 0) {
    // WI-10006321: a raw content write outside withPlanLock records its own revision in the
    // caller's transaction, so every live plan body has one. Lazy: this module is a leaf
    // the spec stores import, and revisions.ts reaches back into the plan-source graph.
    const { recordSystemPlanRevisionInTransaction, ADHOC_SPEC_SCOPE_REVISION_AUTHOR } = await import('./revisions');
    await recordSystemPlanRevisionInTransaction(tx, {
      workspaceId,
      harnessSlug,
      planSlug: ADHOC_WORK_ITEM_SPEC_SCOPE,
      content: ADHOC_SCOPE_CONTENT,
      contentHash,
      rationale: 'ad-hoc spec scope materialised on first use',
      authorId: ADHOC_SPEC_SCOPE_REVISION_AUTHOR,
    });
  }
  const itemId = planItemId?.trim();
  // Refuse to materialise an item the revisions CHECK would later reject. Creating the row
  // anyway would trade a clear `plan_item_not_found` for a raw 23514 constraint violation
  // thrown three statements later, from a table the caller never named.
  if (itemId && ADHOC_ITEM_ID_SHAPE.test(itemId)) {
    // `plan_spec_clauses` writes require an owning `plan_items` row, so the scope alone is
    // not enough for the first ad-hoc clause. `seq` is NOT NULL with no default, hence the
    // computed next value rather than a literal.
    await tx`
      INSERT INTO harness_shared.plan_items (workspace_id, harness_slug, plan_slug, item_id, seq)
      SELECT ${workspaceId}, ${harnessSlug}, ${ADHOC_WORK_ITEM_SPEC_SCOPE}, ${itemId},
             COALESCE(MAX(seq), 0) + 1
        FROM harness_shared.plan_items
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${harnessSlug}
         AND plan_slug = ${ADHOC_WORK_ITEM_SPEC_SCOPE}
      ON CONFLICT (workspace_id, harness_slug, plan_slug, item_id) DO NOTHING`;
  }
  return ADHOC_WORK_ITEM_SPEC_SCOPE;
}
