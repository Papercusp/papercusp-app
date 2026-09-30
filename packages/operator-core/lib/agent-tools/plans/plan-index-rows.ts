/**
 * Writes the DERIVED plan index rows (`harness_shared.plan_items` /
 * `harness_shared.plan_decisions`, migration 675) for one plan.
 *
 * `harness_plans.content` (markdown) is canonical. These rows are recomputed
 * from it by `deriveIndexFromContent` on every write, exactly like the
 * `items`/`decisions` jsonb columns they replace — so they are a queryable
 * index, never a source of truth, and are rebuildable from `content` at any
 * time (see migration 675's header for the full rationale).
 *
 * ONE writer, three callers: the plan write path (with-plan-lock), the
 * federation projection (a remote plan row lands without going through the
 * write path), and the backfill. They must not drift, which is why this is a
 * module and not three inline SQL blocks.
 *
 * Always call this INSIDE the caller's transaction, while it holds the plan's
 * advisory lock — the delete+insert must be atomic with the harness_plans
 * upsert or a concurrent reader can observe a plan with no items.
 */
import type { PlanIndexDecision, PlanIndexItem } from './source';
import { PLAN_ADVISORY_LOCK_NAMESPACE, planAdvisoryLockKey } from './plan-lock-key';

/** Minimal transaction shape — a postgres-js tagged-template executor. */
type Tx = <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;

export interface PlanIndexRowScope {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
}

/**
 * Defensive de-duplication by id, keeping the LAST occurrence.
 *
 * Live data has zero duplicate ids across all 1060 plans (verified before
 * migration 675 was designed), which is what makes the natural PRIMARY KEY
 * safe. But `content` is hand-editable markdown, so a future malformed plan
 * COULD produce two `P-003`s — and without this, the resulting PK violation
 * would abort the whole plan write, making the plan permanently unsavable.
 * Degrading to "last one wins" matches how the jsonb array behaved when a
 * consumer indexed it by id, and keeps a bad edit recoverable.
 */
function dedupeById<T extends { id: string }>(rows: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const r of rows) {
    if (!r || typeof r.id !== 'string' || r.id === '') continue;
    byId.set(r.id, r);
  }
  return [...byId.values()];
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Replace the derived index rows for exactly one plan.
 *
 * Delete-then-insert rather than a diff: an item can be renamed, reordered or
 * removed by a single markdown edit, so a diff would have to reconcile all
 * three anyway. The row counts here are tiny (median ~10 items per plan).
 */
export async function writePlanIndexRows(
  tx: Tx,
  scope: PlanIndexRowScope,
  idx: { items?: readonly PlanIndexItem[]; decisions?: readonly PlanIndexDecision[] },
): Promise<{ items: number; decisions: number }> {
  const { workspaceId, harnessSlug, planSlug } = scope;

  const items = dedupeById(idx.items ?? []).map((it, i) => ({
    id: it.id,
    seq: i,
    itemText: typeof it.text === 'string' ? it.text : '',
    status: typeof it.status === 'string' && it.status !== '' ? it.status : 'todo',
    importance: typeof it.importance === 'string' ? it.importance : null,
    phase: typeof it.phase === 'string' ? it.phase : null,
    ownerGateMarker: typeof it.ownerGateMarker === 'string' ? it.ownerGateMarker : null,
    blockedBy: asStringArray(it.blockedBy),
    decisionRefs: asStringArray(it.decisionRefs),
  }));

  const decisions = dedupeById(idx.decisions ?? []).map((d, i) => ({
    id: d.id,
    seq: i,
    title: typeof d.title === 'string' ? d.title : '',
    body: typeof d.body === 'string' ? d.body : '',
    decisionDate: typeof d.date === 'string' ? d.date : null,
    itemRefs: asStringArray(d.itemRefs),
    affects: asStringArray(d.affects),
  }));

  // WI-10003498: take the plan's advisory lock HERE, not only in the caller. Under
  // READ COMMITTED two unserialized delete+insert rewrites of one plan collide: the
  // second DELETE waits on the first's old rows, then cannot see its new ones, and
  // its INSERT fails `plan_items_pkey` (measured: concurrent work_items:complete of
  // two fork items stranded one plan item at `todo`). Not every caller of this
  // writer holds the lock; xact advisory locks are re-entrant, so this costs a
  // caller that already holds it nothing and serializes every one that does not.
  await tx`
    SELECT pg_advisory_xact_lock(hashtext(${PLAN_ADVISORY_LOCK_NAMESPACE}),
                                 hashtext(${planAdvisoryLockKey(workspaceId, harnessSlug, planSlug)}))
  `;

  // Unconditional delete: an edit that removes the last item must clear the
  // rows, so this cannot be skipped when the arrays are empty.
  await tx`
    DELETE FROM harness_shared.plan_items
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
       AND plan_slug = ${planSlug}
  `;
  await tx`
    DELETE FROM harness_shared.plan_decisions
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
       AND plan_slug = ${planSlug}
  `;

  // jsonb_to_recordset rather than unnest(): blocked_by/decision_refs are
  // text[] PER ROW, and unnest cannot carry an array-of-arrays column.
  // Bound as `${json}::text::jsonb` — the operator's postgres-js client throws
  // on sql.json / bare-object jsonb params (agent-insights/postgres-js-jsonb-binding).
  if (items.length > 0) {
    await tx`
      INSERT INTO harness_shared.plan_items (
        workspace_id, harness_slug, plan_slug,
        item_id, seq, item_text, status, importance, phase, owner_gate_marker, blocked_by, decision_refs
      )
      SELECT ${workspaceId}, ${harnessSlug}, ${planSlug},
             e.id, e.seq, e."itemText", e.status, e.importance, e.phase,
             e."ownerGateMarker",
             COALESCE(e."blockedBy", '{}'), COALESCE(e."decisionRefs", '{}')
        FROM jsonb_to_recordset(${JSON.stringify(items)}::text::jsonb) AS e(
               id text, seq integer, "itemText" text, status text,
               importance text, phase text, "ownerGateMarker" text,
               "blockedBy" text[], "decisionRefs" text[]
             )
    `;
  }

  if (decisions.length > 0) {
    await tx`
      INSERT INTO harness_shared.plan_decisions (
        workspace_id, harness_slug, plan_slug,
        decision_id, seq, title, body, decision_date, item_refs, affects
      )
      SELECT ${workspaceId}, ${harnessSlug}, ${planSlug},
             e.id, e.seq, e.title, e.body, e."decisionDate",
             COALESCE(e."itemRefs", '{}'), COALESCE(e.affects, '{}')
        FROM jsonb_to_recordset(${JSON.stringify(decisions)}::text::jsonb) AS e(
               id text, seq integer, title text, body text,
               "decisionDate" text, "itemRefs" text[], affects text[]
             )
    `;
  }

  return { items: items.length, decisions: decisions.length };
}
