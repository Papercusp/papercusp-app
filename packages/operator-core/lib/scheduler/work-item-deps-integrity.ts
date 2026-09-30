/**
 * work-item-deps-integrity.ts — endpoint-integrity detector for every relation that stores
 * a work-item endpoint: `work_item_deps`, `coord_links` and `coord_threads`
 * (work-item-dependency-edges-2026-08-02, EI-19325959789634791 / D-017 step 2).
 *
 * ── Why it covers three relations, not one (EI-19376392851673381) ───────────────────────
 * It originally read `work_item_deps` alone while work-item blocks were dual-written from
 * coord_links. A bad ref there was faithfully reproduced into the mirror. Watching only the
 * scheduler table produced
 * the worst possible failure mode: after migration 734's backfill the sweep reported
 * defects=0 while 32 stale qualified refs sat live in coord_links + coord_threads,
 * invisible, under a green verdict.
 *
 * `coord_threads` is not a cosmetic third table. Since the work-item mail surface was
 * retired (WI-6097), durable work-item-scoped direction IS thread posts, so a stale
 * `parent_ref` orphans an item's comments from the item.
 *
 * Measured live 2026-08-02 when the widening landed: work_item_deps 0 defects, the other
 * two 231 (177 dangling + 54 mismatched) — i.e. the mirror was clean and the source was not.
 *
 * D-017's defect: a `work_item_deps` endpoint carries a `*_kind` alongside a ref, and
 * NOTHING checked that the endpoint actually RESOLVES to a row of the declared kind. An
 * edge could be perfectly FORM-valid (D-009 rule 1: feature = harness-qualified, issue =
 * bare) and still gate nothing, because the issue floor matches `d.blocked_ref =
 * wi.feature_id` — BARE — while the writer emitted the feature convention. Measured live
 * 2026-08-02: 6 such rows in papercusp, 3 on genuinely-open items with non-terminal
 * blockers, every one advertised claimable while blocked.
 *
 * The write seam was fixed (`resolveDepEndpoint` now dispatches on the target row's real
 * family), which makes the mismatch INEXPRESSIBLE going forward. This module is the other
 * half: a CONTINUOUS detector, because the one-off audit that found those 6 rows rots the
 * moment it stops being re-run — and rows also arrive from backfills, imports and other
 * harnesses that a single audit never covered.
 *
 * ── Why this is NOT part of reconcileReadiness ──────────────────────────────────────────
 * Deliberate, and load-bearing. `reconcileReadiness` (readiness-reconcile.ts) is:
 *   • FEATURE-ONLY — its oracle CTE filters `item_kind <> ALL ('bug','change','task')`,
 *     i.e. it structurally cannot see the ISSUE-family rows this defect lives in; and
 *   • a different INVARIANT — sidecar (`work_item_blocked`) vs oracle (`work_item_is_blocked`)
 *     drift, over a different table.
 * Folding this in would hide an issue-family detector inside a feature-only function. The
 * seam that IS reused is the ROUTINE: `readiness-drift-monitor` already runs hourly and
 * already separates pure-detect from repair, so this detector rides that same tick.
 *
 * ── Resolution must match the WRITER, which matches the FLOOR ───────────────────────────
 * Family is resolved against `harness_shared.engineer_issues` on the BARE id, with NO
 * harness qualifier and NO workspace scope — identical to `resolveDepEndpoint` and to the
 * issue floor's blocker leg (`bi.issue_id = d.blocker_ref`). Asking a different relation
 * than the floor would just relocate the bug: a first attempt at the D-017 fix resolved
 * family from `work_items.item_kind` and silently returned 'feature' for everything.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import {
  analyzeDependencyGraph,
  type DependencyGraphAnalysis,
  type DependencyGraphEdgeInput,
  type DependencyGraphNodeInput,
  type DependencyIdentity,
} from './dependency-graph-analysis';
import { getDependencyPolicy, type DependencyPolicyFinding } from './dependency-invariants';
import {
  dependencyGraphPerformanceTelemetry,
  type DependencyGraphPerformanceTelemetry,
} from './dependency-performance-budget';

/** The issue-family endpoint kind — the counterpart of FEATURE_KIND for this table. */
const ISSUE_ENDPOINT_KIND = 'issue';
const FEATURE_ENDPOINT_KIND = 'feature';

/**
 * Which relation the endpoint lives in. `work_item_deps` is now canonical for blocking;
 * coord_links is still scanned because it carries non-block relations and because any
 * reintroduced work-item block there is legacy/rogue data worth detecting. coord_threads
 * holds a work-item's comment thread.
 */
export type DepEndpointRelation = 'work_item_deps' | 'coord_links' | 'coord_threads';

/** Which side of the edge an endpoint sits on (per relation). */
export type DepEndpointSide = 'blocked' | 'blocker' | 'src' | 'dst' | 'parent';

/** One offending endpoint, identified precisely enough to repair it. */
export interface DepEndpointDefect {
  /** Which relation this row lives in — the repair differs per relation, so it is not cosmetic. */
  relation: DepEndpointRelation;
  /**
   * The row to repair: `id` for work_item_deps / coord_links, `thread_id` for coord_threads
   * (which is keyed by (workspace_id, thread_id) and has no surrogate id).
   */
  row_id: string;
  workspace_id: string;
  side: DepEndpointSide;
  /** The `*_kind` the row DECLARES. */
  declared_kind: string;
  /** The `*_ref` as stored (qualified or bare, exactly as written). */
  ref: string;
  /**
   * The kind the endpoint SHOULD carry, derived from the row it actually resolves to.
   * Null for a dangling endpoint — it resolves to nothing, so there is no right answer.
   */
  expected_kind: string | null;
  /**
   * DANGLING ONLY — the harness slug(s) where the endpoint's BARE id actually does exist,
   * comma-separated, or null if the id exists nowhere.
   *
   * This distinction decides the REPAIR, so it is not cosmetic. A dangling endpoint has two
   * very different causes that look identical without it:
   *   • id exists nowhere      → a genuinely stale ref (deleted / never-created item) ⇒ DELETE the edge.
   *   • id exists in harness Y → the edge's harness QUALIFIER is wrong ⇒ RE-POINT it; the
   *     dependency is real and deleting it would silently discard a live constraint.
   * Measured live 2026-08-02: 8 edges referenced `papercusp-public-site#WI-54xx` while every
   * one of those items exists under `papercusp-public-site-pot`. Reported as a bare
   * "resolves to nothing" that reads as stale data, it invites exactly the wrong repair.
   */
  bare_id_found_in: string | null;
}

export interface WorkItemDepsIntegrityResult {
  /** mismatched.length + dangling.length — total endpoint-integrity violations. */
  defects: number;
  /**
   * Endpoints whose declared kind (or ref FORM) disagrees with the family of the row they
   * resolve to — the D-017 shape. These are INERT edges: form-valid, mirrored, acyclic,
   * counted by every row-shape check, and invisible to the floor that must honour them.
   */
  mismatched: DepEndpointDefect[];
  /**
   * Endpoints resolving to NO row in either family. Reported SEPARATELY from `mismatched`
   * because they are not the same defect and must not be repaired the same way: the writer
   * deliberately tolerates an absent blocker (`resolveDepEndpoint` falls back to the feature
   * form so an edge naming a not-yet-created item stays writable). A dangling endpoint is
   * therefore a data-hygiene finding, not proof of a writer bug — and never repaired by
   * rewriting its kind. Check each one's `bare_id_found_in` before repairing: it separates a
   * genuinely stale ref (delete the edge) from a wrong harness qualifier (re-point it).
   */
  dangling: DepEndpointDefect[];
}

export interface DependencyGraphPolicyWorkspaceResult {
  workspaceId: string;
  nodes: number;
  edges: number;
  analysis: DependencyGraphAnalysis;
  findings: DependencyPolicyFinding[];
}

export interface DependencyGraphPolicyCensusResult {
  workspaces: DependencyGraphPolicyWorkspaceResult[];
  nodes: number;
  edges: number;
  findings: DependencyPolicyFinding[];
  hardBlocks: number;
  advisories: number;
  strandedNodes: number;
  telemetry: DependencyGraphPerformanceTelemetry;
}

const ISSUE_ITEM_KINDS = new Set(['bug', 'change', 'task']);
const ISSUE_TERMINAL = new Set(['resolved', 'closed', 'done', 'dropped']);
const FEATURE_TERMINAL = new Set(['passed', 'deprecated', 'done', 'dropped']);

const identityLabel = (id: DependencyIdentity): string => `${id.kind}:${id.ref}`;

function policyFinding(
  code: string,
  nodes: readonly DependencyIdentity[],
  edges: readonly { blocked: DependencyIdentity; blocker: DependencyIdentity }[],
  evidence: Record<string, unknown>,
): DependencyPolicyFinding {
  const policy = getDependencyPolicy(code);
  if (!policy || policy.classification === 'healthy') throw new Error(`missing visible dependency policy: ${code}`);
  return {
    code: policy.code,
    classification: policy.classification,
    confidence: policy.confidence,
    nodes: nodes.map(identityLabel),
    edges: edges.map((edge) => ({ subject: identityLabel(edge.blocked), dependency: identityLabel(edge.blocker) })),
    evidence,
    provenance: [...policy.provenance],
    suggestedAction: policy.suggestedAction,
  };
}

function findingsForAnalysis(
  analysis: DependencyGraphAnalysis,
  edges: readonly DependencyGraphEdgeInput[],
): DependencyPolicyFinding[] {
  const findings: DependencyPolicyFinding[] = [];
  for (const component of analysis.stronglyConnectedComponents) {
    const cycleEdges = component.cyclePath.slice(1).map((blocked, index) => ({
      blocked: component.cyclePath[index]!,
      blocker: blocked,
    }));
    findings.push(
      policyFinding('cycle', component.members, cycleEdges, {
        path: component.cyclePath.map(identityLabel),
        exactNodes: component.members.map(identityLabel),
      }),
    );
  }
  for (const defect of analysis.endpointDefects) {
    const edge = edges[defect.edgeIndex];
    const code = defect.code === 'missing' ? 'executable-endpoint-missing' : 'endpoint-identity-mismatch';
    findings.push(
      policyFinding(code, defect.resolvedAs ? [defect.resolvedAs] : [], edge ? [edge] : [], {
        edgeIndex: defect.edgeIndex,
        exactEdge: edge
          ? {
              blocked: identityLabel(edge.blocked),
              blocker: identityLabel(edge.blocker),
              provenance: edge.provenance ?? null,
            }
          : null,
        endpoint: {
          role: defect.role,
          declared: identityLabel(defect.declared),
          resolvedAs: defect.resolvedAs ? identityLabel(defect.resolvedAs) : null,
          candidates: defect.candidates?.map(identityLabel) ?? [],
        },
      }),
    );
  }
  return findings;
}

/**
 * Run the canonical graph analyser over the complete supported graph.
 *
 * Detect-only: monitor findings never rewrite an edge or lifecycle state (D-009).
 * Identity resolution is global by family (D-003), matching the writer and claim
 * floors: issue refs are bare and feature refs are harness-qualified. Splitting by
 * workspace would manufacture missing endpoints for legacy/default-scoped edges and,
 * more dangerously, could hide a real cross-scope cycle. The full graph is classified
 * before any reporting sample is narrowed,
 * so cycles and stranded closure cannot disappear behind a display budget.
 */
export async function reconcileDependencyGraphPolicy(
  sql: Sql = getOrgPg().sql,
): Promise<DependencyGraphPolicyCensusResult> {
  const startedAt = performance.now();
  const nodeRows = await sql<
    Array<{ workspace_id: string; harness_slug: string; feature_id: string; item_kind: string; status: string | null }>
  >`
    SELECT workspace_id, harness_slug, feature_id, item_kind, status
      FROM harness_shared.work_items
     ORDER BY workspace_id, harness_slug, feature_id, item_kind`;
  const edgeRows = await sql<
    Array<{
      workspace_id: string;
      blocked_kind: string;
      blocked_ref: string;
      blocker_kind: string;
      blocker_ref: string;
      id: string;
      created_by: string | null;
    }>
  >`
    SELECT id::text, workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, created_by
      FROM harness_shared.work_item_deps
     WHERE dep_type = 'blocks'
     ORDER BY workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref`;

  const nodes: DependencyGraphNodeInput[] = nodeRows.map((row) => {
    const issue = ISSUE_ITEM_KINDS.has(row.item_kind);
    const qualified = `${row.harness_slug}#${row.feature_id}`;
    return {
      id: issue ? { kind: ISSUE_ENDPOINT_KIND, ref: row.feature_id } : { kind: FEATURE_ENDPOINT_KIND, ref: qualified },
      aliases: issue
        ? [
            { kind: FEATURE_ENDPOINT_KIND, ref: qualified },
            { kind: ISSUE_ENDPOINT_KIND, ref: qualified },
          ]
        : [
            { kind: ISSUE_ENDPOINT_KIND, ref: row.feature_id },
            { kind: FEATURE_ENDPOINT_KIND, ref: row.feature_id },
          ],
      terminal: (issue ? ISSUE_TERMINAL : FEATURE_TERMINAL).has(row.status ?? ''),
      scope: `${row.workspace_id}/${row.harness_slug}`,
    };
  });
  const edges: DependencyGraphEdgeInput[] = edgeRows.map((row) => ({
    blocked: { kind: row.blocked_kind, ref: row.blocked_ref },
    blocker: { kind: row.blocker_kind, ref: row.blocker_ref },
    provenance: `${row.workspace_id}:work_item_deps#${row.id}:${row.created_by ?? 'unknown'}`,
  }));
  const analysis = analyzeDependencyGraph({ nodes, edges });
  const workspaces: DependencyGraphPolicyWorkspaceResult[] = [
    {
      workspaceId: 'global',
      nodes: nodes.length,
      edges: edges.length,
      analysis,
      findings: findingsForAnalysis(analysis, edges),
    },
  ];
  const findings = workspaces.flatMap((workspace) => workspace.findings);
  const nodesCount = workspaces.reduce((sum, workspace) => sum + workspace.nodes, 0);
  const edgesCount = workspaces.reduce((sum, workspace) => sum + workspace.edges, 0);
  return {
    workspaces,
    nodes: nodesCount,
    edges: edgesCount,
    findings,
    hardBlocks: findings.filter((finding) => finding.classification === 'hard-block').length,
    advisories: findings.filter((finding) => finding.classification === 'advisory').length,
    strandedNodes: workspaces.reduce((sum, workspace) => sum + workspace.analysis.stranded.length, 0),
    telemetry: dependencyGraphPerformanceTelemetry({
      operation: 'census',
      durationMs: performance.now() - startedAt,
      nodes: nodesCount,
      edges: edgesCount,
    }),
  };
}

/**
 * Detect `work_item_deps` endpoints whose declared kind disagrees with the target row's
 * real family, plus endpoints that resolve to nothing, in ONE round-trip.
 *
 * Pure detector — it reports, it never repairs. Same seam as `reconcileReadiness`: the
 * routine action owns repair so detection stays independently testable and safe to run
 * anywhere.
 *
 * @param sql org admin postgres handle; defaults to `getOrgPg().sql`. Pass an explicit
 *   handle in tests (the integration test points it at a testcontainer DB).
 */
export async function reconcileWorkItemDepEndpoints(sql: Sql = getOrgPg().sql): Promise<WorkItemDepsIntegrityResult> {
  const rows = await sql<
    Array<{
      defect: 'mismatched' | 'dangling';
      row_id: string;
      relation: DepEndpointRelation;
      workspace_id: string;
      side: DepEndpointSide;
      declared_kind: string;
      ref: string;
      expected_kind: string | null;
      bare_id_found_in: string | null;
    }>
  >`
    WITH endpoints AS (
      -- Every relation that stores a work-item endpoint, flattened. The blocked side is
      -- where D-017's live rows were wrong, but every other side carries the identical
      -- invariant and is checked the same way.
      SELECT id::text AS row_id, workspace_id, 'work_item_deps'::text AS relation,
             'blocked'::text AS side, blocked_kind AS declared_kind, blocked_ref AS ref
        FROM harness_shared.work_item_deps
       WHERE dep_type = 'blocks'
      UNION ALL
      SELECT id::text, workspace_id, 'work_item_deps', 'blocker', blocker_kind, blocker_ref
        FROM harness_shared.work_item_deps
       WHERE dep_type = 'blocks'
      -- coord_links is NOT a blocking source after migration 935, but it remains a
      -- polymorphic endpoint store and a detector surface for rogue legacy work-item blocks.
      -- Both sides are filtered to the two work-item families ON PURPOSE: coord_links also
      -- carries plan_item / topic endpoints, whose refs use a DIFFERENT grammar
      -- ('<planSlug>#P-NNN'), and feeding those to a work-item oracle would report every
      -- one of them as dangling. The work_item_deps arms above are deliberately NOT
      -- kind-filtered, so this widening cannot narrow what that table already reported.
      UNION ALL
      SELECT id::text, workspace_id, 'coord_links', 'src', src_kind, src_ref
        FROM harness_shared.coord_links
       WHERE src_kind IN (${ISSUE_ENDPOINT_KIND}, ${FEATURE_ENDPOINT_KIND})
      UNION ALL
      SELECT id::text, workspace_id, 'coord_links', 'dst', dst_kind, dst_ref
        FROM harness_shared.coord_links
       WHERE dst_kind IN (${ISSUE_ENDPOINT_KIND}, ${FEATURE_ENDPOINT_KIND})
      -- coord_threads holds a work item's comment thread. Since the work-item mail surface
      -- was retired (WI-6097) durable work-item-scoped direction IS thread posts, so a
      -- stale parent_ref orphans comments from the item they belong to. Keyed by
      -- (workspace_id, thread_id) with no surrogate id, hence thread_id as the row id.
      UNION ALL
      SELECT thread_id, workspace_id, 'coord_threads', 'parent', parent_kind, parent_ref
        FROM harness_shared.coord_threads
       WHERE parent_kind IN (${ISSUE_ENDPOINT_KIND}, ${FEATURE_ENDPOINT_KIND})
    ),
    split AS (
      -- D-009 rule 1: a feature ref is '<harness>#<id>', an issue ref is bare. Split on the
      -- LAST '#' so a harness slug containing one cannot truncate the id.
      SELECT e.*,
             CASE WHEN strpos(e.ref, '#') > 0
                  THEN substring(e.ref from length(e.ref) - strpos(reverse(e.ref), '#') + 2)
                  ELSE e.ref END AS bare_id,
             CASE WHEN strpos(e.ref, '#') > 0
                  THEN substring(e.ref from 1 for length(e.ref) - strpos(reverse(e.ref), '#'))
                  ELSE NULL END AS ref_harness
        FROM endpoints e
    ),
    resolved AS (
      SELECT s.*,
             -- The FLOOR's own relation, matched the FLOOR's own way: bare id, no harness
             -- qualifier, no workspace scope. Must not drift from resolveDepEndpoint.
             EXISTS (
               SELECT 1 FROM harness_shared.engineer_issues i WHERE i.issue_id = s.bare_id
             ) AS is_issue,
             EXISTS (
               SELECT 1 FROM harness_shared.work_items f
                WHERE f.item_kind <> ALL (ARRAY['bug','change','task'])
                  AND f.feature_id = s.bare_id
                  AND (s.ref_harness IS NULL OR f.harness_slug = s.ref_harness)
             ) AS is_feature
        FROM split s
    ),
    judged AS (
      SELECT r.*,
             CASE WHEN r.is_issue THEN ${ISSUE_ENDPOINT_KIND}
                  WHEN r.is_feature THEN ${FEATURE_ENDPOINT_KIND}
                  ELSE NULL END AS expected_kind,
             -- The ref FORM is half the invariant: an issue endpoint must be BARE and a
             -- feature endpoint QUALIFIED. A row can declare the right kind in the wrong
             -- form and still be invisible to the floor, so both are checked.
             CASE WHEN r.is_issue THEN (strpos(r.ref, '#') = 0)
                  WHEN r.is_feature THEN (strpos(r.ref, '#') > 0)
                  ELSE TRUE END AS form_ok
        FROM resolved r
    )
    SELECT
      CASE WHEN j.expected_kind IS NULL THEN 'dangling' ELSE 'mismatched' END AS defect,
      j.row_id, j.relation, j.workspace_id, j.side, j.declared_kind, j.ref, j.expected_kind,
      -- Only computed for a dangling endpoint (the correlated scan is pointless otherwise,
      -- and this keeps the common all-clean case a single pass over the edges).
      CASE WHEN j.expected_kind IS NULL THEN (
        SELECT string_agg(DISTINCT w.harness_slug, ',' ORDER BY w.harness_slug)
          FROM harness_shared.work_items w
         WHERE w.feature_id = j.bare_id
      ) END AS bare_id_found_in
      FROM judged j
     WHERE j.expected_kind IS NULL
        OR j.declared_kind IS DISTINCT FROM j.expected_kind
        OR NOT j.form_ok
     ORDER BY defect, j.relation, j.workspace_id, j.ref, j.side
  `;

  const mismatched: DepEndpointDefect[] = [];
  const dangling: DepEndpointDefect[] = [];
  for (const r of rows) {
    const defect: DepEndpointDefect = {
      relation: r.relation,
      row_id: r.row_id,
      workspace_id: r.workspace_id,
      side: r.side,
      declared_kind: r.declared_kind,
      ref: r.ref,
      expected_kind: r.expected_kind,
      bare_id_found_in: r.bare_id_found_in ?? null,
    };
    if (r.defect === 'mismatched') mismatched.push(defect);
    else dangling.push(defect);
  }

  return { defects: mismatched.length + dangling.length, mismatched, dangling };
}
