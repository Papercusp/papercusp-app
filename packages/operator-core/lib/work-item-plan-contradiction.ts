/**
 * work-item-plan-contradiction.ts — the claim-time "PLAN SAYS DONE" hint (WI-39498).
 *
 * THE ZOMBIE CLASS THIS SURFACES: a work-item row that is still OPEN while its linked
 * plan item is already terminal ('done'/'dropped') — often with the plan item's own
 * text carrying the reflection annotation "← WI-NNN completed (done)" naming this very
 * id. Measured 2026-08-16: 77 such rows in the papercusp harness; WI-36047 alone was
 * claimed by 9 successive agents, each of whom read it as never-started and set out to
 * rebuild work that was already fixed, tested and deployed.
 *
 * WHY THE ROWS STAY OPEN, BY DESIGN: the reverse reconciler
 * (plan-items/reconcile-linked-work-items.ts) deliberately refuses to terminal-close an
 * issue-family work-item reached only via the `payload.plan_item` stamp with no
 * `implements` edge (EI-19460536530145188) — a bare stamp is not evidence of
 * implementation, and a silent close destroys real work. Its stated recovery path is:
 * "an agent claims it, SEES the work already landed, and closes it with evidence."
 * This module is the missing half of that sentence — nothing previously SHOWED the
 * claimant that the plan item asserts completion (priorWorkWarning keys on prior-holder
 * history, not on this contradiction), so the recovery path silently degraded into the
 * rebuild loop it was designed to prevent.
 *
 * Fail-soft by design, mirroring work-item-prior-work.ts: a claim must never fail
 * because an advisory lookup did. A PG error yields `null` — "no hint", never a throw.
 */
import { getOrgPg } from '@papercusp/db-org';

export interface ClaimTimePlanItemContradictionHint {
  planSlug: string;
  itemId: string;
  /** The linked plan item's CURRENT stored status — only ever a terminal one here. */
  planItemStatus: 'done' | 'dropped';
  /** The plan item's own text names this work-item id together with a completion
   *  annotation (the reflect-rules "← WI-NNN completed (…)" note) — the strongest
   *  form of the contradiction: the plan explicitly claims THIS item finished. */
  annotatedCompleted: boolean;
}

/**
 * Pure: does the plan item's text carry a completion claim naming this work-item id?
 * Deliberately the SAME predicate WI-39498's population query measures
 * (`item_text ILIKE '%<id>%' AND (ILIKE '%completed%' OR ILIKE '%(done)%')`), so what
 * the detector counts and what the claimant is warned about cannot drift apart.
 */
export function planItemTextNamesCompleted(itemText: string, workItemId: string): boolean {
  if (!itemText || !workItemId) return false;
  const t = itemText.toLowerCase();
  if (!t.includes(workItemId.toLowerCase())) return false;
  return t.includes('completed') || t.includes('(done)');
}

interface PlanItemRow {
  status: string | null;
  item_text: string | null;
}

/**
 * Read the linked plan item for one work-item and report the contradiction, or null.
 * Null on: no/partial `payload.plan_item` stamp (the overwhelmingly common case — a
 * normal claim's response is completely unaffected), a plan item that no longer
 * resolves, a NON-terminal plan item (no contradiction), or any read error (fail-soft).
 *
 * Workspace-agnostic on the stamp, exactly like findAllLinkedWorkItems: the stamp's
 * (plan_slug, item_id, harness_slug) is already the join identity on plan_items.
 */
export async function getClaimTimePlanItemContradiction(ref: {
  workItemId: string;
  payload: unknown;
}): Promise<ClaimTimePlanItemContradictionHint | null> {
  const stamp = (
    ref.payload as { plan_item?: { plan_slug?: string; item_id?: string; harness_slug?: string } } | null | undefined
  )?.plan_item;
  if (!ref.workItemId || !stamp?.plan_slug || !stamp.item_id || !stamp.harness_slug) return null;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<PlanItemRow[]>`
      SELECT status, item_text
        FROM harness_shared.plan_items
       WHERE plan_slug = ${stamp.plan_slug}
         AND item_id = ${stamp.item_id}
         AND harness_slug = ${stamp.harness_slug}
       LIMIT 1`;
    const row = rows[0];
    if (!row) return null;
    const status = String(row.status ?? '')
      .trim()
      .toLowerCase();
    if (status !== 'done' && status !== 'dropped') return null;
    return {
      planSlug: stamp.plan_slug,
      itemId: stamp.item_id,
      planItemStatus: status,
      annotatedCompleted: planItemTextNamesCompleted(String(row.item_text ?? ''), ref.workItemId),
    };
  } catch {
    return null;
  }
}

/**
 * Render the hint as the warning an agent reads at claim time. Pure + exported so the
 * guarantee is directly testable and a future edit cannot silently weaken it — the same
 * shape priorWorkWarning chose, and for the same reason.
 *
 * The message prescribes the VERIFY-then-close recipe rather than a bare "beware":
 * the contradiction has exactly two resolutions (close this row with evidence, or state
 * why the plan item is wrong), and naming them is what turns the 9-agents-rebuilding
 * loop into a single verify-and-close.
 */
export function planItemContradictionWarning(
  hint: ClaimTimePlanItemContradictionHint | null,
  workItemId: string,
): string | null {
  if (!hint) return null;
  const ref = `${hint.planSlug}#${hint.itemId}`;
  const annotated = hint.annotatedCompleted
    ? ` — and its text carries a completion annotation naming ${workItemId} ("← ${workItemId} completed …")`
    : '';
  return (
    `⚠ PLAN SAYS ${hint.planItemStatus.toUpperCase()}: this work-item's linked plan item ${ref} is already ` +
    `'${hint.planItemStatus}'${annotated}, while this row is still non-terminal. The work may ALREADY BE ` +
    `FINISHED (WI-39498: 77 such rows measured 2026-08-16; one burned 9 successive agents rebuilding shipped ` +
    `code). Before building ANYTHING: grep the source for '${workItemId}', run the relevant suites, and check ` +
    `dev:pipeline_position for the touched paths. If the work already landed, close THIS item with that ` +
    `evidence (work_items:complete) instead of re-implementing; if it genuinely did not, record why in a ` +
    `comment and proceed. The reverse reconciler deliberately leaves issue-family stamp-only rows OPEN for ` +
    `exactly this judgement (EI-19460536530145188). [WI-39498]`
  );
}
