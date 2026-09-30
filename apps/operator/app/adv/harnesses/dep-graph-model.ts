/**
 * dep-graph-model.ts — the PURE core of the Work-tab dependency graph pane.
 *
 * Plan: dependency-health-pane-2026-08-02 (P-005 scoping/budget, P-007 depth, P-013 budget).
 *
 * ── WHY A PURE MODULE SEPARATE FROM THE COMPONENT ───────────────────────────────────────
 * Everything that decides WHAT the user sees — which subgraph, in what order, what gets
 * hidden when the corpus is too big — lives here, with no React, no elkjs and no DOM. That
 * makes the load-bearing behaviour unit-testable at the fast tier, and it keeps the component
 * to wiring. elkjs in particular must NOT be imported at module scope: D-005 requires it to be
 * lazily loaded (it is a GWT-transpiled ~1MB bundle), so it is dynamically imported inside the
 * component's layout effect and never referenced here.
 *
 * ── THE CENTRAL CONSTRAINT: "VIEW ALL … COULD BE THOUSANDS" ─────────────────────────────
 * The owner asked to be able to view all the plan and work items, "which could be thousands"
 * (D-003). A Sugiyama layered DAG of thousands of nodes is not merely slow — it is unreadable,
 * and React Flow renders a DOM node per node on top of that. D-001 anticipated this and said
 * plainly that rendering the unfiltered graph "and calling it done" implements the decision
 * WRONGLY.
 *
 * The reconciliation this module implements: FILTERS AND SELECTION ARE THE NAVIGATION. The
 * pane always renders a BOUNDED subgraph, and "view all" means every part of the corpus is
 * REACHABLE — never that it is all laid out at once.
 *
 * ── ABSENCE IS REPORTED, NEVER SILENT ───────────────────────────────────────────────────
 * When the budget elides nodes, `hiddenCount` says how many and `truncated` says it happened,
 * so the UI can render "N more — filter to see them". A pane that silently drops nodes is
 * strictly worse than one that refuses: the user cannot tell a sparse graph from a clipped
 * one, which is the same "absence rendered as zero" failure AdvSyncHealthPanel was built to
 * avoid.
 */

import {
  getDependencyPolicy,
  type DependencyPolicyFinding,
} from '@papercusp/operator-core/lib/scheduler/dependency-invariants';

/** A node as the graph needs it. A structural subset of the list's row — same corpus (D-003). */
export interface DepGraphItem {
  id: string;
  kind: string;
  title: string;
  state: string;
  /**
   * The plan this item came from (`work_items.source_plan_slug`, surfaced as
   * `WorkItemRow.planSlug` — see listEnrichedWorkItems, work-items.ts:89), or null
   * for an item that did not originate in a plan.
   *
   * This is what makes a PLAN item distinguishable from any other work item
   * (dependency-health-pane-2026-08-02 P-012 / D-003 req 2: "all the plan and work
   * items"). It is deliberately NOT a separate node kind: a plan item IS a
   * work_items row in this system — `plans:start` mints one per item, and the
   * owner's 2026-07-27 identity decision was to reuse that work-item id rather than
   * give plan items an id space of their own. So both "kinds" are already one
   * corpus, and the graph distinguishes them by PROVENANCE, not by type.
   *
   * ⚠ Do NOT reach for `source_plan_item_ids` to do this instead: it is populated on
   * 1 of 1,178 plan-derived papercusp rows (measured 2026-08-03), so it looks like
   * the precise linkage and is in practice empty.
   */
  planSlug?: string | null;
}

/**
 * An edge as `workItems.depEdges` returns it. `blockerId: null` = dangling (INV-13).
 *
 * ⚠ The endpoint fields are what make an edge DRAWABLE independently of the list's window
 * (WI-36045). `items` is a 500-row `updated_ts DESC` page of a 47,906-row corpus, so requiring
 * both endpoints to appear in it discarded 78 of 79 real papercusp edges and rendered a
 * 122-node graph as 2 nodes. They are optional on this interface only so an older cached
 * payload (or a fixture that predates them) still type-checks; when absent the node falls back
 * to the id as its label rather than vanishing.
 */
export interface DepGraphEdgeInput {
  blockedId: string;
  blockerId: string | null;
  blockerRef: string;
  blockerStatus: string | null;
  blockedKind?: string | null;
  blockerKind?: string | null;
  blockedTitle?: string | null;
  blockedStatus?: string | null;
  blockedPlanSlug?: string | null;
  blockerTitle?: string | null;
  blockerPlanSlug?: string | null;
  blockedPlanItemId?: string | null;
  blockerPlanItemId?: string | null;
  blockedPhase?: string | null;
  blockerPhase?: string | null;
  blockedPlanBlockedBy?: string[];
}

export interface DepGraphNode extends DepGraphItem {
  /** Longest blocker-chain length above this node. 0 = nothing blocks it. */
  depth: number;
  /** True when this node's ref could not be resolved to a real row — a placeholder. */
  dangling?: boolean;
  /**
   * True when this node's fields came from its EDGE row rather than from `items` — i.e. the
   * row exists but fell outside the list's window (WI-36045). It is a real item, drawn from
   * the same `work_items` row the list would show, just with only the four fields the edge
   * carries. Surfaced so the UI can offer "reveal in list" rather than implying the node is
   * somehow lesser.
   */
  hydrated?: boolean;
}

export interface DepGraphEdge {
  id: string;
  /** The BLOCKER (edges are drawn blocker → blocked, the direction work flows). */
  source: string;
  /** The BLOCKED item. */
  target: string;
  /** A blocker already terminal no longer gates — drawn subdued rather than hidden. */
  satisfied: boolean;
  /** The blocker ref resolved to no row: a finding, not a tidy edge (INV-13). */
  dangling: boolean;
}

export interface DepSubgraph {
  nodes: DepGraphNode[];
  edges: DepGraphEdge[];
  /** Nodes elided by the budget. Rendered as "N more", never silently dropped. */
  hiddenCount: number;
  truncated: boolean;
  /** Nodes in the graph BEFORE the budget — the honest denominator for a count label. */
  totalInScope: number;
  /**
   * Edges excluded because a FILTER removed both endpoints — the only legitimate reason to
   * drop an edge now (WI-36045). Reported so the pane can say "N edges hidden by filters"
   * instead of letting a filter masquerade as a sparse graph.
   *
   * ⚠ This is a DETECTOR, and it exists because its absence is what let the original bug
   * hide for a week: edges were being dropped for a scope mismatch and the pane had no
   * counter that could have shown it, so 2 nodes out of 122 looked like real data. Any
   * future reason an edge is discarded must increment something the UI renders.
   */
  filteredEdgeCount: number;
  /** Nodes drawn from edge-carried fields because they fell outside the list's window. */
  hydratedNodeCount: number;
  findings: DependencyPolicyFinding[];
  topologyRisk: { readyWidth: number; criticalPathDepth: number; maxFanIn: number; maxFanOut: number };
}

function finding(code: string, nodes: string[], edges: Array<{ subject: string; dependency: string }>, evidence: Record<string, unknown>): DependencyPolicyFinding {
  const policy = getDependencyPolicy(code);
  if (!policy || policy.classification === 'healthy') throw new Error(`missing visible dependency policy: ${code}`);
  return { code: policy.code, classification: policy.classification, confidence: policy.confidence, nodes, edges, evidence, provenance: [...policy.provenance], suggestedAction: policy.suggestedAction };
}

function integrityFindings(inputs: readonly DepGraphEdgeInput[], edges: readonly DepGraphEdge[], nodes: readonly DepGraphNode[]) {
  const out: DependencyPolicyFinding[] = [];
  const byPair = new Map(inputs.filter((e) => e.blockerId).map((e) => [`${e.blockerId}->${e.blockedId}`, e]));
  const next = new Map<string, string[]>();
  const prev = new Map<string, string[]>();
  for (const e of edges.filter((edge) => !edge.dangling && !edge.satisfied)) {
    (next.get(e.source) ?? (next.set(e.source, []), next.get(e.source)!)).push(e.target);
    (prev.get(e.target) ?? (prev.set(e.target, []), prev.get(e.target)!)).push(e.source);
  }
  const colour = new Map<string, number>();
  const stack: string[] = [];
  const visit = (id: string) => {
    colour.set(id, 1); stack.push(id);
    for (const child of next.get(id) ?? []) {
      if (!colour.get(child)) visit(child);
      else if (colour.get(child) === 1) {
        const path = [...stack.slice(stack.indexOf(child)), child];
        out.push(finding('cycle', [...new Set(path)], path.slice(1).map((subject, i) => ({ subject, dependency: path[i]! })), { path }));
      }
    }
    stack.pop(); colour.set(id, 2);
  };
  for (const n of nodes) if (!colour.get(n.id)) visit(n.id);
  const terminal = new Set(['passed', 'deprecated', 'done', 'dropped', 'resolved', 'closed']);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  for (const e of edges) {
    if (e.dangling) {
      out.push(finding('executable-endpoint-missing', [e.target, e.source], [{ subject: e.target, dependency: e.source }], { exactEdge: e.id, blockerRef: e.source.replace(/^dangling:/, '') }));
      continue;
    }
    const input = byPair.get(e.id);
    if (e.satisfied) out.push(finding('satisfied-edge-retained', [e.target, e.source], [{ subject: e.target, dependency: e.source }], { lifecycle: { subject: nodeById.get(e.target)?.state, dependency: nodeById.get(e.source)?.state } }));
    if (terminal.has(nodeById.get(e.target)?.state ?? '') && !e.satisfied) out.push(finding('terminal-dependant-live-blocker', [e.target, e.source], [{ subject: e.target, dependency: e.source }], { lifecycle: { subject: nodeById.get(e.target)?.state, dependency: nodeById.get(e.source)?.state } }));
    if (input?.blockedPlanItemId && input.blockerPlanItemId && input.blockedPlanSlug === input.blockerPlanSlug && !input.blockedPlanBlockedBy?.includes(input.blockerPlanItemId)) out.push(finding('promoted-graph-extra-edge', [e.target, e.source], [{ subject: e.target, dependency: e.source }], { planItems: { subject: input.blockedPlanItemId, dependency: input.blockerPlanItemId } }));
    const phaseNumber = (value?: string | null) => Number(value?.match(/\d+/)?.[0] ?? NaN);
    const subjectPhase = phaseNumber(input?.blockedPhase), dependencyPhase = phaseNumber(input?.blockerPhase);
    if (Number.isFinite(subjectPhase) && Number.isFinite(dependencyPhase) && subjectPhase < dependencyPhase) out.push(finding('phase-inversion', [e.target, e.source], [{ subject: e.target, dependency: e.source }], { phases: { subject: input?.blockedPhase, dependency: input?.blockerPhase } }));
    const seen = new Set<string>(); const queue = [...(next.get(e.source) ?? []).filter((id) => id !== e.target)];
    while (queue.length) { const id = queue.shift()!; if (seen.has(id)) continue; seen.add(id); queue.push(...(next.get(id) ?? [])); }
    if (seen.has(e.target)) out.push(finding('transitive-redundancy', [e.target, e.source], [{ subject: e.target, dependency: e.source }], { directEdge: e.id }));
  }
  const roots = nodes.filter((n) => !(prev.get(n.id)?.length));
  const maxFanIn = Math.max(0, ...[...prev.values()].map((v) => v.length));
  const maxFanOut = Math.max(0, ...[...next.values()].map((v) => v.length));
  const criticalPathDepth = Math.max(0, ...nodes.map((n) => n.depth));
  if (nodes.length >= 3 && roots.length <= 1 && criticalPathDepth >= 3) out.push(finding('narrow-or-deep-topology', nodes.map((n) => n.id), [], { topologyMetrics: { readyWidth: roots.length, criticalPathDepth } }));
  if (maxFanIn >= 4 || maxFanOut >= 4) out.push(finding('high-degree-node', nodes.filter((n) => (prev.get(n.id)?.length ?? 0) >= 4 || (next.get(n.id)?.length ?? 0) >= 4).map((n) => n.id), [], { topologyMetrics: { maxFanIn, maxFanOut } }));
  return { findings: out, topologyRisk: { readyWidth: roots.length, criticalPathDepth, maxFanIn, maxFanOut } };
}

/**
 * The node budget. Chosen for READABILITY first: past a few hundred nodes a layered DAG is a
 * crossing-dominated hairball whatever renders it, so a bigger budget would buy an unusable
 * picture and a slow one. Exported so a test can pin behaviour without hardcoding the number.
 */
export const DEP_GRAPH_NODE_BUDGET = 300;

/** Blocker statuses that no longer gate. PER FAMILY — the two lists genuinely differ. */
const FEATURE_TERMINAL = new Set(['passed', 'deprecated', 'done', 'dropped']);
const ISSUE_TERMINAL = new Set(['resolved', 'closed', 'done', 'dropped']);
const ISSUE_KINDS = new Set(['bug', 'change', 'task']);

/**
 * Is this blocker satisfied (terminal)?
 *
 * ⚠ Terminality is PER FAMILY and the two vocabularies are NOT the same set — `closed` is
 * terminal for an issue and NOT for a feature. Collapsing them into one union list is a real,
 * already-made mistake: it is exactly what `dependency-fixture.ts` did until property-based
 * tests caught it disagreeing with the shipped oracle on four of six states (D-019). Kind is
 * passed rather than family so the caller never has to re-derive the mapping.
 */
export function isBlockerSatisfied(kind: string | null | undefined, status: string | null): boolean {
  if (!status) return false;
  const terminal = kind && ISSUE_KINDS.has(kind) ? ISSUE_TERMINAL : FEATURE_TERMINAL;
  return terminal.has(status);
}

/**
 * Longest-path depth per node, over blocker → blocked edges.
 *
 * Depth is the signal this pane exists to surface: the subsystem's worst escape (EI-9108) was a
 * SEVEN-DEEP blockedBy chain served as claimable, which a flat list cannot show and a layered
 * DAG shows at a glance (D-001).
 *
 * Iterative (explicit stack), not recursive: a deep chain in a corpus of thousands would blow
 * the JS stack, and this runs in the render path. Cycles cannot hang it — a node already on the
 * active path is skipped, so a cycle contributes no depth rather than looping forever. The edge
 * writer enforces acyclicity, but this module must not DEPEND on that: it renders whatever is
 * in the database, including data that predates the guard.
 */
export function computeDepths(
  nodeIds: Iterable<string>,
  edges: ReadonlyArray<{ source: string; target: string }>,
): Map<string, number> {
  const blockersOf = new Map<string, string[]>();
  for (const e of edges) {
    const list = blockersOf.get(e.target);
    if (list) list.push(e.source);
    else blockersOf.set(e.target, [e.source]);
  }

  const depth = new Map<string, number>();
  const onPath = new Set<string>();

  for (const start of nodeIds) {
    if (depth.has(start)) continue;
    // Post-order iterative DFS: visit children, then resolve the parent from them.
    const stack: Array<{ id: string; expanded: boolean }> = [{ id: start, expanded: false }];
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      if (depth.has(frame.id)) {
        stack.pop();
        onPath.delete(frame.id);
        continue;
      }
      if (!frame.expanded) {
        frame.expanded = true;
        onPath.add(frame.id);
        for (const b of blockersOf.get(frame.id) ?? []) {
          // Skip a node already on the active path — that is a cycle.
          if (!onPath.has(b) && !depth.has(b)) stack.push({ id: b, expanded: false });
        }
        continue;
      }
      let best = 0;
      for (const b of blockersOf.get(frame.id) ?? []) {
        const d = depth.get(b);
        if (d !== undefined) best = Math.max(best, d + 1);
      }
      depth.set(frame.id, best);
      onPath.delete(frame.id);
      stack.pop();
    }
  }
  return depth;
}

/** Every node reachable from `seed` following edges in BOTH directions (its component). */
function connectedComponent(
  seed: string,
  edges: ReadonlyArray<{ source: string; target: string }>,
): Set<string> {
  const neighbours = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const l = neighbours.get(a);
    if (l) l.push(b);
    else neighbours.set(a, [b]);
  };
  for (const e of edges) {
    link(e.source, e.target);
    link(e.target, e.source);
  }
  const seen = new Set<string>([seed]);
  const queue = [seed];
  while (queue.length) {
    const cur = queue.pop()!;
    for (const n of neighbours.get(cur) ?? []) {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return seen;
}

/**
 * Build the bounded subgraph to render.
 *
 * SCOPING, in order of precedence:
 *   1. A SELECTION scopes to that node's connected component — D-001's first mitigation, and
 *      the interaction that makes a huge graph usable: pick a row, see its lineage.
 *   2. Otherwise, only nodes that PARTICIPATE IN AN EDGE are shown. An isolated work item has
 *      no dependency story to tell, and including thousands of them is what makes the picture
 *      unreadable. This is the default that keeps the pane meaningful at corpus scale.
 *
 * `items` is expected to be the caller's ALREADY-FILTERED row set (the shared `wif`/`wq`
 * filters — P-010), so the user's filters compose with this scoping rather than fighting it.
 * It is NOT the node corpus, and treating it as one is WI-36045: it is a 500-row window of a
 * ~48k corpus, so every edge endpoint outside it is HYDRATED from the edge row instead of
 * being dropped. Pass `filterActive` so the model can tell a deliberate filter from that
 * window — see the option's own note.
 *
 * BUDGET: if the scoped set still exceeds `budget`, keep the DEEPEST nodes — depth is the
 * signal (P-007), so eliding shallow leaves loses least. The count of what was elided is
 * returned, never swallowed.
 */
export function buildDepSubgraph(opts: {
  items: readonly DepGraphItem[];
  edges: readonly DepGraphEdgeInput[];
  selectedId?: string | null;
  budget?: number;
  /**
   * INTEGRITY MODE (P-008). When true, narrow the graph to the UNHEALTHY edges and their
   * endpoints — the "written but gates nothing" set this plan is named for.
   *
   * An edge qualifies when it is `dangling` (its blockerRef resolves to no row — INV-13's
   * stale class, and also how a wrong-FORM ref surfaces now that the resolver's join is
   * family-aware) or `satisfied` (the blocker is already terminal, so the edge is recorded
   * but gates nothing). Those two ARE the health findings; there is no third detector
   * hiding here, and inventing one would be asserting a signal the data does not carry.
   *
   * It is a MODE ON THIS PANE, never a separate surface (the plan's ## Now: "Do not
   * re-narrow this to a diagnostics pane"), and it composes with — rather than replaces —
   * the caller's `wif` column filters and the `selectedId` scoping, because it narrows the
   * same edge set those already produced.
   *
   * Applied BEFORE the budget on purpose: switching to health mode must genuinely shrink
   * what the budget measures, so a corpus too big to draw becomes drawable by asking the
   * narrower question. Filtering after the budget would elide findings to make room for
   * healthy nodes — exactly backwards for a health view.
   */
  healthOnly?: boolean;
  /**
   * Whether the caller has any column filter active (WI-36045).
   *
   * The model cannot infer this, and the distinction is load-bearing. `items` being a strict
   * subset of the corpus means one of two completely different things:
   *   • no filter active → `items` is just the list's 500-row WINDOW, and an endpoint missing
   *     from it is an accident of recency. Dropping its edge is the bug this flag fixes.
   *   • filter active    → `items` is the user's deliberate selection, and an edge with
   *     NEITHER endpoint in it is genuinely out of scope. Dropping it is correct — and it is
   *     counted in `filteredEdgeCount` so the pane can say so.
   * Guessing "subset ⇒ filtered" is exactly how the original defect read as intended
   * behaviour, so the caller must state it.
   */
  filterActive?: boolean;
  /**
   * The ids that SURVIVED the caller's filter — the whole filtered node set, INCLUDING
   * endpoints that exist only in the edge payload. Ignored unless `filterActive`.
   *
   * ⚠ WHY THIS IS NOT INFERRABLE FROM `items`, AND WHY GETTING IT WRONG EMPTIES THE PANE.
   * `items` is the list's 500-row `updated_ts DESC` window; the GRAPH's node corpus is
   * strictly larger, because WI-36045 made every edge carry its endpoints so an
   * out-of-window node is still drawable. Testing the drop rule against `items` therefore
   * filters the graph by a corpus it does not draw from — and the two disagree by an
   * order of magnitude in practice. Measured live on `papercusp` 2026-08-09: 129 nodes,
   * of which only **14** were in the window. Filtering to a plan whose items all fall
   * outside it dropped **84 of 84** edges and rendered "No work items match the active
   * filters" — for a plan with 11 nodes and 8 edges genuinely present in the graph. Eight
   * of the harness's twelve plans behaved that way; the one that worked was simply the
   * most recently touched.
   *
   * The caller is the ONLY party that can compute this: it alone knows the filter specs,
   * and it alone can synthesise a filterable row for an edge-carried endpoint. So it is
   * stated, not guessed — the same contract, and for the same reason, as `filterActive`
   * directly above.
   *
   * Omitted ⇒ falls back to `items` membership, i.e. the pre-fix behaviour. That fallback
   * exists so a caller that has not opted in still type-checks, NOT because it is safe:
   * any caller whose edges hydrate endpoints must pass this.
   */
  filteredIds?: ReadonlySet<string>;
}): DepSubgraph {
  const budget = opts.budget ?? DEP_GRAPH_NODE_BUDGET;
  const byId = new Map(opts.items.map((i) => [i.id, i]));

  // Endpoint rows recovered from the EDGE payload for items outside the list's window. Keyed
  // by id so a node appearing on many edges is hydrated once, and always LOSES to a real
  // `items` row (which carries more fields) — `byId` is consulted first everywhere below.
  const hydrated = new Map<string, DepGraphItem>();
  const hydrate = (
    id: string,
    kind: string | null | undefined,
    title: string | null | undefined,
    state: string | null | undefined,
    planSlug: string | null | undefined,
  ) => {
    if (byId.has(id) || hydrated.has(id)) return;
    hydrated.set(id, {
      id,
      kind: kind ?? 'unknown',
      // Fall back to the id rather than '' so a node from a payload predating the endpoint
      // fields is still identifiable in the picture instead of rendering as a blank box.
      title: title ?? id,
      state: state ?? 'unknown',
      planSlug: planSlug ?? null,
    });
  };
  /** An item row by id, from the list's page first, then the edge-carried fallback. */
  const itemFor = (id: string): DepGraphItem | undefined => byId.get(id) ?? hydrated.get(id);

  /** Membership oracle for the edge-drop rule below. See `filteredIds`. */
  const survivors: { has: (id: string) => boolean } = opts.filteredIds ?? byId;

  // Edges first: they define which nodes are interesting. A dangling blocker becomes a
  // PLACEHOLDER node so the break is visible in the picture rather than an edge to nowhere.
  const allEdges: DepGraphEdge[] = [];
  const danglingRefs = new Map<string, string>();
  let filteredEdgeCount = 0;
  for (const e of opts.edges) {
    const sourceId = e.blockerId ?? `dangling:${e.blockerRef}`;

    // A filter is the ONE legitimate reason to drop an edge: keep it when either endpoint
    // survived the user's filter, so a filtered view still shows what blocks the rows it
    // selected (a dependency view that hides the blockers is not a dependency view).
    //
    // `survivors` is the caller's stated filtered set when it supplied one, and `byId`
    // (the list's window) only as the documented fallback — see `filteredIds`. Both a Set
    // and a Map answer `.has(id)`, so the two shapes unify with no copying.
    if (opts.filterActive && !survivors.has(e.blockedId) && !survivors.has(sourceId)) {
      filteredEdgeCount++;
      continue;
    }

    // Both endpoints are now guaranteed drawable: from `items` if the window happened to
    // include them, otherwise from the fields this edge carries.
    hydrate(e.blockedId, e.blockedKind, e.blockedTitle, e.blockedStatus, e.blockedPlanSlug);
    if (e.blockerId) {
      hydrate(e.blockerId, e.blockerKind, e.blockerTitle, e.blockerStatus, e.blockerPlanSlug);
    } else {
      danglingRefs.set(sourceId, e.blockerRef);
    }

    allEdges.push({
      id: `${sourceId}->${e.blockedId}`,
      source: sourceId,
      target: e.blockedId,
      // Resolve the kind through the same fallback: reading it only from `items` made
      // terminality silently default to the FEATURE vocabulary for every out-of-window
      // blocker, which mis-greys issue edges (`closed` is terminal for an issue, not a
      // feature — D-019).
      satisfied: isBlockerSatisfied(
        e.blockerId ? (itemFor(e.blockerId)?.kind ?? e.blockerKind) : null,
        e.blockerStatus,
      ),
      dangling: !e.blockerId,
    });
  }

  const allIds = new Set<string>();
  for (const e of allEdges) { allIds.add(e.source); allIds.add(e.target); }
  const allDepths = computeDepths(allIds, allEdges);
  const allNodes: DepGraphNode[] = [...allIds].map((id) => {
    const row = itemFor(id);
    if (row) return { ...row, depth: allDepths.get(id) ?? 0, ...(byId.has(id) ? {} : { hydrated: true }) };
    return { id, kind: 'unknown', title: danglingRefs.get(id) ?? id, state: 'missing', depth: allDepths.get(id) ?? 0, dangling: true };
  });
  const completeIntegrity = integrityFindings(opts.edges, allEdges, allNodes);
  const findingEdgeIds = new Set(completeIntegrity.findings.flatMap((row) => row.edges.map((edge) => `${edge.dependency}->${edge.subject}`)));
  const rawEdges = opts.healthOnly
    ? allEdges.filter((e) => e.dangling || e.satisfied || findingEdgeIds.has(e.id))
    : allEdges;

  // Which nodes are in scope, before the budget.
  let scopeIds: Set<string>;
  if (
    opts.selectedId &&
    (itemFor(opts.selectedId) !== undefined || danglingRefs.has(opts.selectedId))
  ) {
    scopeIds = connectedComponent(opts.selectedId, rawEdges);
  } else {
    scopeIds = new Set<string>();
    for (const e of rawEdges) {
      scopeIds.add(e.source);
      scopeIds.add(e.target);
    }
  }

  const depths = computeDepths(scopeIds, rawEdges);

  let nodes: DepGraphNode[] = [...scopeIds].map((id) => {
    const item = byId.get(id);
    if (item) return { ...item, depth: depths.get(id) ?? 0 };
    // Outside the list's window but a REAL row — its fields came off the edge (WI-36045).
    // Flagged `hydrated`, never `dangling`: conflating the two would report a healthy item
    // as a broken reference, which is the integrity mode's whole signal.
    const carried = hydrated.get(id);
    if (carried) return { ...carried, depth: depths.get(id) ?? 0, hydrated: true };
    // A dangling placeholder — it has no row, so it carries the ref as its label and is
    // flagged so the UI can draw it as a break rather than a work item.
    return {
      id,
      kind: 'unknown',
      title: danglingRefs.get(id) ?? id,
      state: 'missing',
      depth: depths.get(id) ?? 0,
      dangling: true,
    };
  });

  const totalInScope = nodes.length;
  let hiddenCount = 0;
  if (nodes.length > budget) {
    // Deepest first — shallow leaves are the cheapest thing to lose (see P-007).
    nodes = [...nodes].sort((a, b) => b.depth - a.depth || a.id.localeCompare(b.id)).slice(0, budget);
    hiddenCount = totalInScope - nodes.length;
  }

  const kept = new Set(nodes.map((n) => n.id));
  const edges = rawEdges.filter((e) => kept.has(e.source) && kept.has(e.target));

  // Stable order so React Flow keys and the a11y tree do not churn between renders.
  nodes.sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
  edges.sort((a, b) => a.id.localeCompare(b.id));

  return {
    nodes,
    edges,
    hiddenCount,
    truncated: hiddenCount > 0,
    totalInScope,
    filteredEdgeCount,
    // Counted over the nodes actually RETURNED, not over the hydration map: a node the budget
    // elided is reported by `hiddenCount`, and counting it here too would double-report it.
    hydratedNodeCount: nodes.reduce((n, node) => n + (node.hydrated ? 1 : 0), 0),
    findings: completeIntegrity.findings.filter((row) => row.nodes.some((id) => kept.has(id))),
    topologyRisk: completeIntegrity.topologyRisk,
  };
}
