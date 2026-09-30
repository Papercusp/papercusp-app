/**
 * dependency-graph-edges.ts — the EDGE half of the Work-tab dependency graph pane.
 *
 * Plan: dependency-health-pane-2026-08-02 (P-003, the data seam).
 *
 * ── WHY THIS IS EDGES ONLY (AND WHY EACH EDGE CARRIES ITS ENDPOINTS) ────────────────────
 * The owner's ask was a pane that "shows all the same data as our work items list view but in
 * graph form". Taken literally, that means the graph's NODES are the list's rows — so this
 * module deliberately does NOT re-query work items as a second corpus. The pane reuses the
 * existing `workItems.byHarness` sync query for the rich row fields and adds only the edges
 * the list has no column for. Two things follow, and both are the point:
 *
 *   • ONE node corpus. A second independent node query would drift from the list's (different
 *     limit, different filters, different projection) and the two panes would disagree about
 *     what exists — the precise failure the "same data" phrasing rules out.
 *   • The same trick DetailPanel already uses: it reads the selected row out of the
 *     already-loaded `workItems.byHarness` result rather than firing its own fetch, because
 *     a second multi-MB fetch starves the WebView2 ~6-connection-per-host cap and shows up
 *     as a pane stuck on "Loading".
 *
 * ⚠ BUT "edges only" MUST NOT MEAN "edges whose endpoints happen to be in the list's page"
 * (WI-36045). `workItems.byHarness` is a WINDOW — 500 rows ordered `updated_ts DESC` — while
 * this query is HARNESS-WIDE. Those are different scopes, and pairing them silently discarded
 * almost the entire graph: measured 2026-08-08 on `papercusp` (47,906 items), 79 edges
 * resolved but only **1** had BOTH endpoints inside the 500-row window, so the pane rendered
 * 2 nodes out of a real 122 and looked like honest sparse data.
 *
 * The fix is NOT a second node query (that reintroduces the drift above) and NOT a bigger
 * window (47,906 enriched rows is exactly the multi-MB fetch the cap forbids). It is to make
 * each edge row SELF-SUFFICIENT: the joins below already touch both endpoint rows, so they
 * now also project the four fields a graph NODE needs (title, status, kind, plan provenance).
 * The graph can therefore always draw an edge it was told about, whether or not that endpoint
 * fell inside the list's window — while the values still come from the same `work_items` rows
 * the list reads, so "one corpus" is strengthened rather than weakened. The list's page stays
 * the source of the RICHER row fields and of filter composition; these fields are the floor
 * that guarantees no edge is silently undrawable.
 *
 * ── ENDPOINT RESOLUTION IS FAMILY-AWARE, AND THAT IS THE WHOLE SUBTLETY ─────────────────
 * `work_item_deps` stores each endpoint as a `*_ref` whose FORM depends on the family of the
 * row it points at (D-009 rule 1, and the invariant registry's INV-01):
 *
 *     feature family → '<harness>#<feature_id>'   (harness-qualified)
 *     issue   family → '<feature_id>'             (bare, unqualified)
 *
 * so a join that matches only one form silently drops every edge of the other family. That is
 * not hypothetical: it is exactly the D-017 defect — six live edges that were form-valid,
 * mirrored and acyclic, and gated nothing, because the writer emitted the feature convention
 * while the issue floor matched bare. The join below therefore dispatches on the TARGET ROW'S
 * `item_kind`, mirroring `work_item_is_blocked` (migration 719) rather than re-deciding the
 * convention here.
 *
 * ⚠ `d.workspace_id` is pinned to the COORDINATION workspace ('default'), NOT the caller's
 * workspace. Every edge row lives there by design whatever workspace its items live in
 * (migration 719 says so explicitly and warns against "fixing" it: scoping the edge lookup to
 * the item workspace "would match zero rows and disable blocking entirely"). The ITEM joins
 * are scoped to the caller's workspace; the EDGE table is not. Those are different axes.
 *
 * ── DANGLING EDGES ARE RETURNED, NOT FILTERED ──────────────────────────────────────────
 * The blocker side is a LEFT JOIN on purpose. An edge whose blocker resolves to no row in this
 * harness is a FINDING (INV-13, the stale class) and Phase 3's integrity mode has to render
 * it; an INNER JOIN would make exactly the broken edges invisible in the pane built to show
 * broken edges. `blockerId === null` is how the UI spots one.
 */
import type { Sql } from 'postgres';

/** The coordination workspace `work_item_deps` is keyed in. NOT a tenant knob — see header. */
const COORD_WORKSPACE = 'default';

/** Families, as the ENGINE decides them: by the VALUE of item_kind, never by a family name. */
const ISSUE_KINDS = ['bug', 'change', 'task'] as const;

export interface DependencyGraphEdge {
  /** feature_id of the BLOCKED item (the dependant). Always resolves — it is an inner join. */
  blockedId: string;
  /** feature_id of the BLOCKER, or null when the ref resolves to no row here (INV-13). */
  blockerId: string | null;
  /** The blocker's raw ref as stored — the only handle a dangling edge has. */
  blockerRef: string;
  blockedKind: string;
  blockerKind: string | null;
  /** Blocker lifecycle status — lets the UI grey out an edge whose blocker is already terminal. */
  blockerStatus: string | null;
  satisfaction: 'settled' | 'success';

  // ── ENDPOINT HYDRATION (WI-36045) ──────────────────────────────────────────────────────
  // The minimum a graph NODE needs, carried on the edge so an endpoint outside the list's
  // 500-row window is still drawable. See the header: without these, 78 of 79 papercusp
  // edges were fetched and then discarded client-side. Nullable on the blocker side only,
  // where the LEFT JOIN may not resolve (a dangling edge has no row to project).
  /** The BLOCKED row's title. */
  blockedTitle: string | null;
  /** The BLOCKED row's lifecycle status. Its own status, not the blocker's. */
  blockedStatus: string | null;
  /** The BLOCKED row's originating plan, or null if it did not come from one. */
  blockedPlanSlug: string | null;
  /** The BLOCKER row's title, or null when the ref resolves to no row (dangling). */
  blockerTitle: string | null;
  /** The BLOCKER row's originating plan, or null (no row, or no plan). */
  blockerPlanSlug: string | null;
  blockedPlanItemId: string | null;
  blockerPlanItemId: string | null;
  blockedPhase: string | null;
  blockerPhase: string | null;
  blockedPlanBlockedBy: string[];
}

/** Bound the payload. The pane renders a filtered subgraph (D-003), never the whole corpus. */
export const DEP_EDGES_MAX_LIMIT = 5000;

/**
 * Every `blocks` edge with at least its BLOCKED endpoint resolving into (workspace, harness).
 *
 * @param sql org admin postgres handle.
 * @param opts workspaceId + harnessSlug scope the ITEM joins (never the edge table); `limit` is
 *   CLAMPED, never rejected — a client asking for more than the cap must degrade gracefully
 *   rather than error the panel (the same reason `workItems.byHarness` clamps instead of
 *   `.max()`-ing its schema: a newer client against an older resolver would otherwise turn a
 *   version skew into a panel-breaking failure).
 */
export async function resolveDependencyGraphEdges(
  sql: Sql,
  opts: { workspaceId: string; harnessSlug: string; limit?: number },
): Promise<DependencyGraphEdge[]> {
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? DEP_EDGES_MAX_LIMIT)), DEP_EDGES_MAX_LIMIT);
  const qualifiedPrefix = `${opts.harnessSlug}#`;
  const rows = await sql<
    Array<{
      blocked_id: string;
      blocker_id: string | null;
      blocker_ref: string;
      blocked_kind: string;
      blocker_kind: string | null;
      blocker_status: string | null;
      satisfaction: 'settled' | 'success';
      blocked_title: string | null;
      blocked_status: string | null;
      blocked_plan_slug: string | null;
      blocker_title: string | null;
      blocker_plan_slug: string | null;
      blocked_plan_item_id: string | null;
      blocker_plan_item_id: string | null;
      blocked_phase: string | null;
      blocker_phase: string | null;
      blocked_plan_blocked_by: string[] | null;
    }>
  >`
    SELECT bd.feature_id  AS blocked_id,
           bk.feature_id  AS blocker_id,
           d.blocker_ref  AS blocker_ref,
           bd.item_kind   AS blocked_kind,
           bk.item_kind   AS blocker_kind,
           bk.status      AS blocker_status,
           d.satisfaction AS satisfaction,
           -- Endpoint hydration (WI-36045). Free: both rows are already joined below, so
           -- this adds columns to an existing scan rather than a second query.
           bd.title            AS blocked_title,
           bd.status           AS blocked_status,
           bd.source_plan_slug AS blocked_plan_slug,
           bk.title            AS blocker_title,
           bk.source_plan_slug AS blocker_plan_slug,
           bpi.item_id         AS blocked_plan_item_id,
           kpi.item_id         AS blocker_plan_item_id,
           bpi.phase           AS blocked_phase,
           kpi.phase           AS blocker_phase,
           bpi.blocked_by      AS blocked_plan_blocked_by
      FROM harness_shared.work_item_deps d
      -- BLOCKED side: inner. An edge whose dependant is not in this harness is not ours.
      JOIN harness_shared.work_items bd
        ON bd.workspace_id = ${opts.workspaceId}
       AND bd.harness_slug = ${opts.harnessSlug}
       -- Give Postgres an equality on the indexed endpoint identity BEFORE the
       -- family-aware exact-ref check below. Without this anchor the blocker-side
       -- LEFT JOIN becomes a join filter: for every edge Postgres materializes and
       -- scans the harness's entire work-item corpus (114k rows in papercusp), which
       -- exceeded the named-query resolver's 10s deadline and left the pane loading.
       --
       -- This is only a candidate-id extraction, not a second ref convention. The
       -- predicate below remains authoritative and rejects a bare feature ref or a
       -- qualified issue ref exactly as before.
       AND bd.feature_id = CASE
         WHEN starts_with(d.blocked_ref, ${qualifiedPrefix})
           THEN substr(d.blocked_ref, char_length(${qualifiedPrefix}) + 1)
         ELSE d.blocked_ref
       END
       AND (
         (bd.item_kind = ANY (${ISSUE_KINDS as unknown as string[]}) AND d.blocked_ref = bd.feature_id)
         OR
         (bd.item_kind <> ALL (${ISSUE_KINDS as unknown as string[]})
           AND d.blocked_ref = bd.harness_slug || '#' || bd.feature_id)
       )
      -- BLOCKER side: LEFT. A blocker resolving to nothing is a dangling edge — a finding the
      -- integrity mode must render, not a row to drop (see header).
      LEFT JOIN harness_shared.work_items bk
        ON bk.workspace_id = ${opts.workspaceId}
       AND bk.harness_slug = ${opts.harnessSlug}
       AND bk.feature_id = CASE
         WHEN starts_with(d.blocker_ref, ${qualifiedPrefix})
           THEN substr(d.blocker_ref, char_length(${qualifiedPrefix}) + 1)
         ELSE d.blocker_ref
       END
       AND (
         (bk.item_kind = ANY (${ISSUE_KINDS as unknown as string[]}) AND d.blocker_ref = bk.feature_id)
         OR
         (bk.item_kind <> ALL (${ISSUE_KINDS as unknown as string[]})
           AND d.blocker_ref = bk.harness_slug || '#' || bk.feature_id)
       )
      LEFT JOIN LATERAL (
        SELECT pi.item_id, pi.phase, pi.blocked_by
          FROM harness_shared.plan_items pi
         WHERE pi.workspace_id = bd.workspace_id
           AND pi.harness_slug = bd.harness_slug
           AND pi.plan_slug = bd.source_plan_slug
           AND pi.item_id = COALESCE(bd.source_plan_item_ids[1], bd.payload -> 'plan_item' ->> 'item_id')
         LIMIT 1
      ) bpi ON true
      LEFT JOIN LATERAL (
        SELECT pi.item_id, pi.phase
          FROM harness_shared.plan_items pi
         WHERE pi.workspace_id = bk.workspace_id
           AND pi.harness_slug = bk.harness_slug
           AND pi.plan_slug = bk.source_plan_slug
           AND pi.item_id = COALESCE(bk.source_plan_item_ids[1], bk.payload -> 'plan_item' ->> 'item_id')
         LIMIT 1
      ) kpi ON true
     WHERE d.dep_type = 'blocks'
       AND d.workspace_id = ${COORD_WORKSPACE}
     ORDER BY bd.feature_id, d.blocker_ref
     LIMIT ${limit}`;

  return rows.map((r) => ({
    blockedId: r.blocked_id,
    blockerId: r.blocker_id,
    blockerRef: r.blocker_ref,
    blockedKind: r.blocked_kind,
    blockerKind: r.blocker_kind,
    blockerStatus: r.blocker_status,
    satisfaction: r.satisfaction,
    blockedTitle: r.blocked_title,
    blockedStatus: r.blocked_status,
    blockedPlanSlug: r.blocked_plan_slug,
    blockerTitle: r.blocker_title,
    blockerPlanSlug: r.blocker_plan_slug,
    blockedPlanItemId: r.blocked_plan_item_id,
    blockerPlanItemId: r.blocker_plan_item_id,
    blockedPhase: r.blocked_phase,
    blockerPhase: r.blocker_phase,
    blockedPlanBlockedBy: r.blocked_plan_blocked_by ?? [],
  }));
}
