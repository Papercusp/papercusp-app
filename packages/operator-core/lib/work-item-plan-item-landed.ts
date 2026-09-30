/**
 * work-item-plan-item-landed.ts — the claim-time "THE TREE SAYS DONE" hint
 * (EI-18713141708830049).
 *
 * THE ZOMBIE CLASS THIS SURFACES: a plan item still reading `todo` whose work has
 * ALREADY LANDED, so the next agent to pick it up re-investigates — and sometimes
 * re-implements — finished work. Measured on ONE plan in ONE ~1h session
 * (shared-hive-cross-machine-scale-10k-2026-06-29): FOUR of its Phase-0 items
 * misrepresented their real state, including P-020, whose fix was already in the tree
 * with a code comment naming the plan item BY NAME — the reporting agent had started
 * writing the fix before noticing.
 *
 * ── EXACT MIRROR OF work-item-plan-contradiction.ts, AND DELIBERATELY DISJOINT ──────
 * That module (WI-39498) fires when a work-item is OPEN while its plan item is already
 * TERMINAL — "the plan says you're done". This one fires in the opposite direction:
 * the plan item is still NON-TERMINAL while a sibling work-item that implements it has
 * already settled — "the tree says you're done". The two are complementary halves of
 * the same divergence and cannot both fire for one subject, because each requires the
 * plan-item status the other excludes. That disjointness is asserted in the tests, so
 * a future edit cannot quietly turn them into two warnings for one situation.
 *
 * ── WHY THIS CANNOT BE A LINK JOIN, AND WHY IT IS NOT PURE PROSE EITHER ────────────
 * Measured 2026-08-24 over the non-terminal work-items whose title names a plan item
 * (`title ~ 'P-[0-9]{3}'`), excluding the observation lane:
 *
 *     total 119 | payload.plan_item stamp 24 (20.2%) | source_plan_slug 7 (5.9%)
 *     stamp-but-no-slug 17 | NEITHER machine link 95 (79.8%)
 *
 * So a stamp-only or FK-only resolver is silent for four items in five (this is the
 * mechanism EI-19436838692892568 identified), while a prose-only resolver would throw
 * away the 20% that carry a reliable link. Hence the tiered resolver below, which
 * takes the strongest available evidence and STAMPS WHICH TIER IT USED.
 *
 * ⚠ `linkSource` is the load-bearing field, for the reason telemetry-call-origin.ts
 * gives about its own `source`: a wrong classification that renders identically to a
 * right one is what lets a bad inference survive. A 'prose' match is a DERIVED guess
 * and says so; 'stamp'/'column' are recorded links. A consumer that needs certainty
 * filters on the tier rather than trusting the hint wholesale.
 *
 * ⚠ PROSE MATCHING REQUIRES BOTH THE PLAN SLUG AND THE ITEM ID, in the same field.
 * A bare "P-004" is ambiguous across every plan in the workspace, and a false "your
 * work already landed" is strictly WORSE than no hint — it invites an agent to skip
 * work that was never done. Requiring the slug is what makes the derived tier safe
 * enough to ship at all.
 *
 * ⚠ THE OBSERVATION LANE IS EXCLUDED. harness_shared.work_items also stores agents'
 * end-of-turn notes under lane='observation'; they routinely carry "P-0NN" in their
 * titles and are not work. Measured the same day: 1,412 such rows match the title
 * regex against 119 real work-items, i.e. 92% of the naive population. A sweep that
 * forgets this predicate reports ~1,530 and is dismissed as noise on first read.
 *
 * Fail-soft by design, mirroring work-item-prior-work.ts and its sibling: a claim must
 * never fail because an advisory lookup did. A PG error yields `null` — "no hint",
 * never a throw. Saying nothing asserts nothing.
 */
import { getOrgPg } from '@papercusp/db-org';

/**
 * How the sibling was tied to the plan item. Ordered weakest-last on purpose; see
 * {@link STRONGEST_FIRST}.
 *
 * - `stamp`  — `payload.plan_item` (plan_slug + item_id), written by the convert path.
 * - `column` — `source_plan_slug` + `source_plan_item_ids`.
 * - `prose`  — the title or summary names BOTH the plan slug and the item id. DERIVED.
 */
export type PlanItemLinkSource = 'stamp' | 'column' | 'prose';

/** Strongest evidence first — used to pick the tier reported as `strongest`. */
const STRONGEST_FIRST: readonly PlanItemLinkSource[] = ['stamp', 'column', 'prose'];

export interface LandedSibling {
  workItemId: string;
  title: string;
  /** The sibling's settled state, e.g. 'done' | 'resolved' | 'closed'. */
  state: string;
  linkSource: PlanItemLinkSource;
}

export interface ClaimTimePlanItemLandedHint {
  planSlug: string;
  itemId: string;
  /** The plan item's CURRENT stored status — only ever a NON-terminal one here. */
  planItemStatus: string;
  /** Settled work-items implementing the same plan item. Never empty. */
  siblings: LandedSibling[];
  /** The strongest tier present across {@link siblings}. */
  strongest: PlanItemLinkSource;
}

/**
 * Pure: does this text name BOTH the plan slug and the plan item id?
 *
 * Exported so the predicate the population query counts and the predicate the claimant
 * is warned about are literally the same function — the discipline
 * planItemTextNamesCompleted established, and for the same reason: a detector and a
 * warning that drift apart produce a count nobody can act on.
 *
 * Both operands are required. See the module note on why a bare item id is unsafe.
 */
export function proseNamesPlanItem(text: string, planSlug: string, itemId: string): boolean {
  if (!text || !planSlug || !itemId) return false;
  const t = text.toLowerCase();
  return t.includes(planSlug.toLowerCase()) && t.includes(itemId.toLowerCase());
}

/** A plan item is "still open" for our purposes unless it has reached a terminal status. */
const TERMINAL_PLAN_ITEM_STATUSES: readonly string[] = ['done', 'dropped'];

export function isTerminalPlanItemStatus(status: string): boolean {
  return TERMINAL_PLAN_ITEM_STATUSES.includes(status.trim().toLowerCase());
}

interface PlanItemStatusRow {
  status: string | null;
}

interface SiblingRow {
  feature_id: string | null;
  title: string | null;
  status: string | null;
  by_stamp: boolean | null;
  by_column: boolean | null;
}

/** Pick the tier for one row; prose is the fallback because the SQL already matched. */
function tierFor(row: SiblingRow): PlanItemLinkSource {
  if (row.by_stamp) return 'stamp';
  if (row.by_column) return 'column';
  return 'prose';
}

/**
 * Resolve the plan item this subject implements, preferring a recorded link.
 *
 * Returns null when nothing identifies a plan item — which is the correct, common
 * answer, not a failure: a claim on an item with no plan reference at all is
 * completely unaffected by this leg.
 */
export function resolvePlanItemRef(ref: {
  payload?: unknown;
  planSlug?: string | null;
  planItemId?: string | null;
  sourcePlanSlug?: string | null;
  sourcePlanItemIds?: string[] | null;
}): { planSlug: string; itemId: string } | null {
  const stamp = (
    ref.payload as { plan_item?: { plan_slug?: string; item_id?: string } } | null | undefined
  )?.plan_item;
  // The COLUMN tier, and the reason it is LAST and guarded. `source_plan_item_ids` is a
  // LIST: a row implementing several plan items gives no principled way to pick one, and
  // picking arbitrarily would emit a confident "already landed" about the wrong item —
  // strictly worse than staying silent (a false hint costs the claimant more than no hint).
  // So it contributes only when it identifies EXACTLY ONE item. This lives here rather than
  // at the four call sites so the rule cannot drift into four divergent copies.
  const columnItemIds = (ref.sourcePlanItemIds ?? []).filter((id) => typeof id === 'string' && id.trim());
  const columnItemId = columnItemIds.length === 1 ? columnItemIds[0] : null;
  const planSlug = (stamp?.plan_slug ?? ref.planSlug ?? ref.sourcePlanSlug ?? '').trim();
  const itemId = (stamp?.item_id ?? ref.planItemId ?? columnItemId ?? '').trim();
  if (!planSlug || !itemId) return null;
  return { planSlug, itemId };
}

/**
 * Read whether the claimed subject's plan item is still open while a SETTLED sibling
 * already implements it. Null on: no resolvable plan item (the common case), a plan
 * item that no longer resolves, a TERMINAL plan item (that is planContradiction's
 * direction, not ours), no settled sibling, or any read error (fail-soft).
 */
export async function getClaimTimePlanItemLanded(ref: {
  workItemId: string;
  payload?: unknown;
  planSlug?: string | null;
  planItemId?: string | null;
  sourcePlanSlug?: string | null;
  sourcePlanItemIds?: string[] | null;
  workspaceId?: string | null;
}): Promise<ClaimTimePlanItemLandedHint | null> {
  const resolved = resolvePlanItemRef(ref);
  if (!ref.workItemId || !resolved) return null;
  const { planSlug, itemId } = resolved;

  try {
    const { sql } = getOrgPg();
    // Loaded here rather than at module scope so the pure predicates above stay
    // dependency-free and cheap to unit-test, while the settled-state vocabulary is
    // still DERIVED from work-items.ts instead of copied (a second hand-maintained
    // copy of a state list is exactly the drift the repo's derived-truth rule bans).
    const { SETTLED_WORK_ITEM_STATES } = await import('./work-items');

    const statusRows = await sql<PlanItemStatusRow[]>`
      SELECT status
        FROM harness_shared.plan_items
       WHERE plan_slug = ${planSlug}
         AND item_id = ${itemId}
       LIMIT 1`;
    const statusRow = statusRows[0];
    if (!statusRow) return null;
    const planItemStatus = String(statusRow.status ?? '').trim().toLowerCase();
    // A terminal plan item is the OTHER module's subject. Staying silent here is what
    // keeps the two halves disjoint (see the module note).
    if (!planItemStatus || isTerminalPlanItemStatus(planItemStatus)) return null;

    const like = `%${itemId}%`;
    const slugLike = `%${planSlug}%`;
    const rows = await sql<SiblingRow[]>`
      SELECT feature_id,
             title,
             status,
             (payload->'plan_item'->>'plan_slug' = ${planSlug}
              AND payload->'plan_item'->>'item_id' = ${itemId}) AS by_stamp,
             (source_plan_slug = ${planSlug}
              AND ${itemId} = ANY(coalesce(source_plan_item_ids, '{}'))) AS by_column
        FROM harness_shared.work_items
       WHERE feature_id IS DISTINCT FROM ${ref.workItemId}
         -- End-of-turn notes are not work; see the module note (92% of the naive population).
         AND lane IS DISTINCT FROM 'observation'
         AND status = ANY(${SETTLED_WORK_ITEM_STATES as string[]})
         ${ref.workspaceId ? sql`AND workspace_id = ${ref.workspaceId}` : sql``}
         AND (
              (payload->'plan_item'->>'plan_slug' = ${planSlug}
               AND payload->'plan_item'->>'item_id' = ${itemId})
           OR (source_plan_slug = ${planSlug}
               AND ${itemId} = ANY(coalesce(source_plan_item_ids, '{}')))
           -- DERIVED tier: both operands required, in the SAME field.
           OR (title ILIKE ${slugLike} AND title ILIKE ${like})
           OR (summary ILIKE ${slugLike} AND summary ILIKE ${like})
         )
       ORDER BY by_stamp DESC NULLS LAST, by_column DESC NULLS LAST
       LIMIT 5`;

    const siblings: LandedSibling[] = rows
      .filter((r) => r.feature_id)
      .map((r) => ({
        workItemId: String(r.feature_id),
        title: String(r.title ?? ''),
        state: String(r.status ?? '').trim().toLowerCase(),
        linkSource: tierFor(r),
      }));
    if (siblings.length === 0) return null;

    const strongest =
      STRONGEST_FIRST.find((tier) => siblings.some((s) => s.linkSource === tier)) ?? 'prose';

    return { planSlug, itemId, planItemStatus, siblings, strongest };
  } catch {
    return null;
  }
}

/**
 * Render the hint as the warning an agent reads at claim time. Pure + exported so the
 * guarantee is directly testable and a future edit cannot silently weaken it — the
 * shape priorWorkWarning chose, and for the same reason.
 *
 * The message prescribes VERIFY-then-reconcile rather than a bare "beware", because the
 * divergence has exactly two honest resolutions (flip the plan item and close this row
 * with evidence, or record why the sibling did not in fact cover it). Naming them is
 * what turns a re-investigation into a one-step reconcile.
 *
 * ⚠ A `prose`-only match is announced AS derived. The agent is told to confirm the
 * sibling really implements this item before trusting it, because that tier is an
 * inference from text, not a recorded link.
 */
export function planItemLandedWarning(
  hint: ClaimTimePlanItemLandedHint | null,
  workItemId: string,
): string | null {
  if (!hint) return null;
  const ref = `${hint.planSlug}#${hint.itemId}`;
  const list = hint.siblings
    .map((s) => `${s.workItemId} (${s.state}, matched by ${s.linkSource})`)
    .join('; ');
  const derivedCaveat =
    hint.strongest === 'prose'
      ? ` ⚠ The strongest match here is DERIVED FROM PROSE (title/summary naming both ` +
        `'${hint.planSlug}' and '${hint.itemId}'), not a recorded link — CONFIRM the sibling ` +
        `actually implements this item before acting on it.`
      : '';
  return (
    `⚠ THE TREE MAY SAY DONE: plan item ${ref} is still '${hint.planItemStatus}', but ` +
    `${hint.siblings.length} already-settled work-item(s) implement it: ${list}.${derivedCaveat} ` +
    `Plan items are NOT flipped when a sibling lands the work, so a 'todo' here is not evidence ` +
    `the work is outstanding (EI-18713141708830049: four of one plan's Phase-0 items ` +
    `misrepresented their state in a single session; one had the fix in the tree with a code ` +
    `comment naming the item). Before building ANYTHING: read the sibling's completion evidence, ` +
    `grep the source for '${hint.itemId}' and '${hint.planSlug}', and check dev:pipeline_position ` +
    `for the touched paths. If the work already landed, flip the plan item (plans:set-status) and ` +
    `close ${workItemId} with that evidence instead of re-implementing; if it genuinely did not, ` +
    `record why in a comment and proceed. [EI-18713141708830049]`
  );
}
