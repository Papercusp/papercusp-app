'use client';

/**
 * DepGraphPanel — the Work-tab dependency graph pane.
 *
 * Plan: dependency-health-pane-2026-08-02 (P-002/P-004/P-005/P-006/P-013/P-014).
 *
 * Owner's ask (2026-08-01 23:56, verbatim): "adding a graph view panel to our work tab that
 * shows all the same data as our work items list view but in graph form, modeling the work
 * items and blockedbys as their dependency[…]" — plus, next day: "…view all the plan and work
 * items which could be thousands. like other tabs this should also have a pot selector to
 * filter, and all the filters from the work item list pane should also be brought over."
 *
 * ── IT SHARES THE LIST PREDICATE + SUMMARY ───────────────────────────────────────────────
 * Nodes use the same bounded `workItems.byHarness` page and the filter bar consumes the same
 * exact `workItems.summary` companion as the grid. Edges remain graph-scoped and hydrate
 * out-of-page endpoints; dependency metrics therefore never masquerade as corpus counts.
 *
 * ── SELECTION IS URL STATE, AND THAT IS NOT A STYLE CHOICE ──────────────────────────────
 * Selection lives in the `sel` nuqs param — the very param WorkItemsPanel's row-click writes
 * and DetailPanel reads. So clicking a node drives the Detail pane, clicking a row re-scopes
 * the graph, and all three stay in lockstep for free. Per the repo rule, user-meaningful state
 * goes in the URL because `ui:get_state`/`ui:dispatch` read the URL: selection held in
 * useState would be invisible to agents.
 *
 * ── elkjs IS LAZY, BY DECISION ──────────────────────────────────────────────────────────
 * D-005 (owner: "lets use elkjs") requires it never enter the initial chunk — it is a
 * GWT-transpiled ~1MB bundle shipping in a DESKTOP app. It is therefore `import()`ed inside
 * the layout effect, on first render of a non-empty graph, and cached across re-layouts.
 *
 * The worker entry (elk-worker) is deliberately NOT used yet: layout runs on a subgraph
 * bounded by DEP_GRAPH_NODE_BUDGET (300 nodes), where ELK is a few tens of ms — while a worker
 * would need a bundled worker URL that survives the strict desktop CSP, which is real risk for
 * no measured gain. If the budget ever rises enough for layout to block the frame, the worker
 * is the next step and the seam is one import.
 *
 * ── ABSENCE IS NEVER RENDERED AS ZERO ───────────────────────────────────────────────────
 * A graph clipped by the node budget says so ("N more — filter to see them"). An empty graph
 * says WHY it is empty (no items / no dependencies / filtered away). A reader must always be
 * able to tell "nothing to show" from "too much to show".
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import type { CompanionListSummary } from '@papercusp/facets';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';
import { ELK_LAYERED_LR_OPTIONS, getElk } from '../elk-layout';
import { Button } from '../../harness/Button';
import {
  useColumnFilterState,
  useColumnFiltersFromState,
  ColumnFilterBar,
  type CountEvidence,
} from '../../harness/filters';
import { WORK_ITEMS_PAGE, type WorkItemRow } from './WorkItemsPanel';
import { workItemFilterColumns, WORK_ITEM_FILTER_NS } from './work-item-columns';
import { workItemFacetOptions, workItemServerFilters } from './work-item-list-query';
import {
  buildDepSubgraph,
  DEP_GRAPH_NODE_BUDGET,
  type DepGraphEdge,
  type DepGraphNode,
} from './dep-graph-model';

/** One row of `workItems.depEdges` (see lib/sync-resolver/dependency-graph-edges.ts). */
interface DepEdgeRow {
  blockedId: string;
  blockerId: string | null;
  blockerRef: string;
  blockedKind: string;
  blockerKind: string | null;
  blockerStatus: string | null;
  // Endpoint hydration (WI-36045) — what makes an edge drawable when its endpoint fell
  // outside the list's 500-row window. Optional here so an in-flight cached payload from
  // before this shipped degrades to id-labelled nodes rather than erroring the panel.
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

const NODE_W = 210;
const NODE_H = 46;

/**
 * Filter columns promoted to a visible axis on this pane's bar (P-002).
 *
 * Only Plan. On a dependency graph "which plan is this" is the organising question, and
 * the owner asked for a plan filter against a pane that already had one — which is what a
 * control reachable only by opening a `+Add filter…` dropdown earns. Promoting more would
 * re-create the crowded bar that `layout='facets'` was rejected for.
 */
const PROMOTED_FILTERS = ['plan'] as const;

/**
 * The row fields an EDGE carries for its endpoints (WI-36045), and therefore the only
 * columns a filter can judge for a node outside the list's 500-row page.
 *
 * Everything else on a synthesised row is null, so a filter on it would exclude every
 * out-of-page node — silently, and on the basis of a field that was never fetched rather
 * than a value that failed to match. The pane counts the active filters in that position
 * and SAYS SO instead (see `filterScopeGap`): this is the one place the filter's corpus is
 * still narrower than the graph's, and the last bug here cost a week precisely because a
 * scope mismatch had no counter to make it visible.
 */
const EDGE_CARRIED_FILTER_KEYS = new Set(['id', 'title', 'kind', 'state', 'plan']);

/**
 * How many title characters fit on one node line, at the node's width and the 11px
 * title size. Deliberately DERIVED from NODE_W rather than a second hardcoded number
 * (the pair went out of sync at 190px/28ch, which is why titles truncated so hard —
 * P-006): ~5.6px per character at 11px in the UI face, less the 10px gutters.
 */
const TITLE_CHARS = Math.floor((NODE_W - 20) / 5.6);

/**
 * State → a coarse bucket the node's status dot is coloured by (P-006).
 *
 * ⚠ Terminality here is intentionally NOT `isBlockerSatisfied`: that oracle answers a
 * different question (does this blocker still GATE, per family) and depends on the row's
 * kind. This is a display bucket for a node's own state across both vocabularies, so it
 * folds every terminal token from either family into one 'done' bucket and never claims
 * to be the gating oracle. Anything unrecognised falls to 'open' rather than being
 * silently coloured as something it is not.
 */
const STATE_DONE = new Set(['done', 'passed', 'resolved', 'closed', 'deprecated', 'dropped']);
const STATE_BAD = new Set(['blocked', 'failing', 'needs_human', 'needs-human']);
const STATE_ACTIVE = new Set(['in_progress', 'in-progress', 'wip', 'validating']);
function stateBucket(state: string): 'done' | 'bad' | 'active' | 'open' {
  if (STATE_DONE.has(state)) return 'done';
  if (STATE_BAD.has(state)) return 'bad';
  if (STATE_ACTIVE.has(state)) return 'active';
  return 'open';
}

/**
 * THE LEGEND (P-005) — the key for the pane's six visual encodings.
 *
 * The previous pass ADDED two of these marks (arrowheads, state dots) and made a third
 * legible again (satisfied edges) without adding a key for any of them. Encodings without
 * a key is a legibility regression dressed as an improvement, and is the leading candidate
 * for the owner's "still looks glitchy": a reader who cannot decode a mark does not
 * conclude "I lack the key", they conclude the picture is broken.
 *
 * ⚠ EVERY SWATCH REUSES THE REAL MARK'S OWN CLASS — never a hardcoded colour or a
 * look-alike shape. A legend that restates the encoding in its own styling is a SECOND
 * source of truth for it, and the two drift the first time a token moves; then the legend
 * is not merely stale but actively lying, which is worse than having none. Drawing the
 * real classes at small size makes drift structurally impossible, and it satisfies
 * `lint:design-primitives` / the css-tokens test for free.
 */
function LegendSwatch({ children }: { children: React.ReactNode }) {
  return (
    <svg width={26} height={12} aria-hidden className="pc-depgraph__legendswatch">
      {children}
    </svg>
  );
}

function DepGraphLegend() {
  /**
   * One edge swatch: the stroke in its real class, plus the arrowhead drawn INLINE in its
   * real class.
   *
   * The arrowhead is drawn rather than referenced through `markerEnd`. The live markers
   * live in the canvas SVG's own `<defs>` under pane-scoped ids, and a cross-`<svg>`
   * `url(#…)` reference is exactly the kind of thing WebKit resolves unevenly — the same
   * reasoning that made the canvas use three explicit markers instead of one SVG2
   * `context-stroke` marker. An arrowhead that silently fails to render in the KEY would
   * be self-defeating. Same classes either way, so the swatch still cannot drift.
   */
  const edge = (variant: 'default' | 'satisfied' | 'dangling') => (
    <LegendSwatch>
      <path
        d="M 1 6 L 17 6"
        className={variant === 'default' ? 'pc-depgraph__edge' : `pc-depgraph__edge pc-depgraph__edge--${variant}`}
      />
      <path
        d="M 17 3 L 23 6 L 17 9 z"
        className={`pc-depgraph__arrowhead pc-depgraph__arrowhead--${variant}`}
      />
    </LegendSwatch>
  );
  return (
    <ul className="pc-depgraph__legend" aria-label="Key to the dependency graph's marks">
      <li>
        {edge('default')}
        <span>blocks (arrow points to the blocked item)</span>
      </li>
      <li>
        {edge('satisfied')}
        <span>blocker already done — gates nothing</span>
      </li>
      <li>
        {edge('dangling')}
        <span>broken — blocker resolves to no item</span>
      </li>
      {/*
        ⚠ The node marks are wrapped in a <g class="pc-depgraph__node"> with the <rect> as
        a CHILD — matching the canvas exactly. The node styles are DESCENDANT selectors
        (`.pc-depgraph__node rect`, and `.pc-depgraph__node rect.pc-depgraph__node-planmark`
        which is deliberately over-specific to beat the dangling rule), so putting the class
        ON the rect would match nothing and render an unstyled outline. Same-class reuse only
        buys drift-immunity if the STRUCTURE matches too.
      */}
      <li>
        <LegendSwatch>
          <g className="pc-depgraph__node pc-depgraph__node--dangling">
            <rect x={1} y={1} width={24} height={10} rx={3} />
          </g>
        </LegendSwatch>
        <span>placeholder for that missing blocker</span>
      </li>
      <li>
        <LegendSwatch>
          <g className="pc-depgraph__node">
            <rect x={1} y={1} width={24} height={10} rx={3} />
            <rect x={1} y={1} width={3} height={10} rx={1.5} className="pc-depgraph__node-planmark" />
          </g>
        </LegendSwatch>
        <span>came from a plan</span>
      </li>
      <li>
        <LegendSwatch>
          {(['done', 'active', 'bad', 'open'] as const).map((b, i) => (
            <circle key={b} cx={4 + i * 6} cy={6} r={2.5} className={`pc-depgraph__node-state pc-depgraph__node-state--${b}`} />
          ))}
        </LegendSwatch>
        <span>item state: done · active · blocked · open</span>
      </li>
    </ul>
  );
}

interface Positioned {
  nodes: Array<DepGraphNode & { x: number; y: number }>;
  edges: DepGraphEdge[];
  width: number;
  height: number;
}

/**
 * The elk loader and its layered-LR options moved to `../elk-layout` when the Workflows
 * topology pane (external-triggers-gmail-slack-2026-08-22 P-024) became elkjs's second
 * consumer. Sharing the module-scoped promise is what keeps "imported once per session at
 * most" true ACROSS panes — a private copy here would instantiate the ~1MB bundle a second
 * time. Behaviour is unchanged: same lazy import, same options.
 */
const ELK_OPTIONS = ELK_LAYERED_LR_OPTIONS;

/**
 * The zoom ladder's numeric rungs, ascending — the `dgz` enum minus `fit`, which is not a
 * fixed ratio. Module scope so stepping does not rebuild it per render, and ONE array so
 * the nuqs enum, the stepper and the label cannot drift into disagreeing about what a
 * valid zoom is.
 */
const ZOOM_RUNGS = ['50', '67', '75', '100', '125', '150'] as const;

export default function DepGraphPanel({ params }: PanelComponentProps) {
  const slug = typeof params.harnessSlug === 'string' ? params.harnessSlug : '';
  const [selectedId, setSelectedId] = useQueryState('sel', parseAsString.withDefault(''));

  // INTEGRITY MODE (P-008) — a FILTER MODE on this pane, not a separate surface. In nuqs
  // like every other user-meaningful axis here, so the view is linkable and agent-drivable
  // (`ui:get_state` / `ui:dispatch` read the URL; useState would be invisible to them).
  // Its own param, deliberately: it is orthogonal to the `wif` column filters and composes
  // with them (health ∧ filters), so folding it into `wif` would make "show me the broken
  // edges" mutually exclusive with "show me this plan's items".
  const [health, setHealth] = useQueryState(
    'dgh',
    parseAsStringEnum(['all', 'issues']).withDefault('all'),
  );
  const healthOnly = health === 'issues';

  // LEGEND VISIBILITY (P-005). nuqs, not useState: it is user-meaningful (it changes what
  // the pane shows), so it must be linkable and readable by `ui:get_state` like every
  // other axis here. Default ON — a key the reader has to discover and open explains
  // nothing, and "the marks are unexplained" is the complaint this item exists to answer.
  const [legend, setLegend] = useQueryState(
    'dgk',
    parseAsStringEnum(['on', 'off']).withDefault('on'),
  );
  const legendOpen = legend === 'on';

  /**
   * ZOOM (P-008). The canvas is routinely several times wider than the pane — the live
   * papercusp graph lays out at ~4600px against a ~900px pane — so "where am I in this
   * thing" was answerable only by scrolling, and the SHAPE of a dependency graph (how many
   * chains, how deep, how they braid) is exactly what a scroll window destroys.
   *
   * A DISCRETE LADDER, in nuqs as `parseAsStringEnum`, rather than a free number: it is the
   * house preference order for URL state, it validates (a hand-typed `dgz=9999` falls back
   * to the default instead of rendering a 1px graph an agent then reports as blank), and
   * seven rungs are all a reader ever wants. `fit` is a rung rather than a button that
   * writes a number, because a shared link saying "fit" should fit the RECIPIENT's pane —
   * baking my viewport's ratio into the URL would be the wrong semantic and would silently
   * mis-fit on any other window size.
   */
  const [zoom, setZoom] = useQueryState(
    'dgz',
    parseAsStringEnum(['fit', '50', '67', '75', '100', '125', '150']).withDefault('100'),
  );

  // FULL FILTER PARITY with the list pane. Read the shared URL state before the
  // queries so rows and the authoritative companion summary use one predicate.
  const filterColumns = useMemo(() => workItemFilterColumns(), []);
  const filterBinding = useColumnFilterState(filterColumns, WORK_ITEM_FILTER_NS);
  const serverFilters = useMemo(
    () => workItemServerFilters(filterBinding.state),
    [filterBinding.state],
  );
  const serverPredicateActive = Object.keys(serverFilters).length > 0;
  const sharedArgs = useMemo(
    () => ({ harnessSlug: slug, filters: serverFilters }),
    [slug, serverFilters],
  );
  const itemsQuery = useSyncQuery<WorkItemRow>({
    queryName: 'workItems.byHarness',
    args: { ...sharedArgs, limit: WORK_ITEMS_PAGE },
    enabled: Boolean(slug),
  });
  const summaryQuery = useSyncQuery<CompanionListSummary>({
    queryName: 'workItems.summary',
    args: sharedArgs,
    enabled: Boolean(slug),
  });
  const edgesQuery = useSyncQuery<DepEdgeRow>({
    queryName: 'workItems.depEdges',
    args: { harnessSlug: slug },
    enabled: Boolean(slug),
  });

  // `loading ? null : data` — NOT `data ?? null`. A defined-but-EMPTY array is a real answer
  // ("no dependencies") and must not be confused with "not loaded yet"; conflating them is a
  // bug this codebase has already shipped once.
  const items = itemsQuery.loading ? null : itemsQuery.data;
  const edgeRows = edgesQuery.loading ? null : edgesQuery.data;
  const error = itemsQuery.error?.message ?? summaryQuery.error?.message ?? edgesQuery.error?.message ?? null;

  // FULL FILTER PARITY with the list pane (P-010 / D-003 req 4). The columns come
  // from the SHARED definition module, and the `ns` is the SAME one WorkItemsPanel
  // uses — so both panes read and write ONE `wif` nuqs param. Filtering the grid
  // narrows the graph and vice versa, with no cross-pane wiring: the URL is the bus.
  //
  // Declared BEFORE the early returns below — hooks must run unconditionally.

  // ── THE FILTER'S CORPUS MUST BE THE GRAPH'S CORPUS, NOT THE LIST'S WINDOW ──────────
  // This plan's D-001/D-002. `items` is the list's 500-row `updated_ts DESC` page; the
  // graph draws a strictly LARGER set, because WI-36045 made every edge carry its
  // endpoints so an out-of-window node is still drawable. Filtering — and, just as badly,
  // DERIVING THE FILTER'S OPTIONS — from `items` alone therefore judges the graph by a
  // corpus it does not draw from.
  //
  // Measured live on `papercusp` 2026-08-09, and this is not a rounding error: 129 graph
  // nodes spanning 12 plans, of which only **14** nodes and **5** plans were inside the
  // window. So 9 of 12 plans were absent from the Plan dropdown ENTIRELY — not buried in
  // it — and filtering to any of the 8 plans with no in-window item dropped 84 of 84
  // edges and rendered "No work items match the active filters" for a plan with 11 nodes
  // and 8 edges genuinely on screen a moment earlier. The one plan that worked was simply
  // the most recently touched, which is exactly the shape that lets a defect survive
  // casual testing: you check the plan you just worked on, and it is fine.
  //
  // The fix is to filter over `items` ∪ the endpoint rows the edges already carry. It
  // costs no fetch (that payload is loaded), needs no resolver change, and keeps ONE
  // shared `wif` param — the list pane and this pane still read and write the same
  // filters; this pane just applies them to everything it actually draws.
  const listIds = useMemo(() => new Set((items ?? []).map((i) => i.id)), [items]);
  const filterCorpus = useMemo<WorkItemRow[]>(() => {
    if (!items) return [];
    if (!edgeRows) return items;
    // Only the fields an edge carries are populated; the rest are null. That is the
    // honest shape — see the `filterScopeGap` note below, which SAYS SO in the pane
    // rather than letting a filter on an unpopulated column silently exclude nodes.
    const extra = new Map<string, WorkItemRow>();
    const add = (
      id: string | null,
      kind: string | null | undefined,
      title: string | null | undefined,
      state: string | null | undefined,
      planSlug: string | null | undefined,
    ) => {
      if (!id || listIds.has(id) || extra.has(id)) return;
      extra.set(id, {
        id,
        kind: kind ?? 'unknown',
        family: '',
        title: title ?? id,
        summary: null,
        state: state ?? 'unknown',
        assignee: null,
        assignedBy: null,
        severity: null,
        priority: null,
        rank: null,
        planSlug: planSlug ?? null,
        spineRole: null,
        spineStatus: null,
        updatedAt: '',
        origin: null,
        auditVerdict: null,
        verifiedAuthorGithubUserId: null,
      });
    };
    for (const e of edgeRows) {
      add(e.blockedId, e.blockedKind, e.blockedTitle, e.blockedStatus, e.blockedPlanSlug);
      add(e.blockerId, e.blockerKind, e.blockerTitle, e.blockerStatus, e.blockerPlanSlug);
    }
    return extra.size === 0 ? items : [...items, ...extra.values()];
  }, [items, edgeRows, listIds]);

  const summary = summaryQuery.data?.[0] ?? null;
  const pairedFetching = Boolean(itemsQuery.fetching || summaryQuery.fetching);
  const filterCountEvidence = useMemo<CountEvidence>(() => {
    if (!summary) return { kind: 'unknown', reason: summaryQuery.error ? 'failed' : 'loading' };
    if (pairedFetching) return { kind: 'unknown', reason: 'updating' };
    return {
      kind: 'corpus',
      count: summary.matched,
      ...(serverPredicateActive ? { total: summary.total } : {}),
      population: 'the selected harness work-item corpus',
    };
  }, [summary, summaryQuery.error, pairedFetching, serverPredicateActive]);
  const facetOptions = useMemo(() => workItemFacetOptions(summary), [summary]);
  const cf = useColumnFiltersFromState(filterColumns, filterCorpus, {
    ns: WORK_ITEM_FILTER_NS,
    countEvidence: filterCountEvidence,
    serverEnumOptions: facetOptions,
  }, filterBinding);

  /**
   * Every id that survived the filter, across the WHOLE graph corpus — what the model
   * tests its edge-drop rule against (`filteredIds`). Distinct from `visibleItems`
   * below, and deliberately so.
   */
  const filteredIds = useMemo(() => new Set(cf.rows.map((r) => r.id)), [cf.rows]);

  /**
   * How many ACTIVE filters sit on a column an edge-carried row cannot populate — i.e.
   * how many of the user's filters are currently unable to judge an out-of-page node.
   * Zero in the common case (Plan, State, Kind are all carried); non-zero is disclosed
   * on the bar rather than silently narrowing the graph.
   */
  const filterScopeGap = useMemo(
    () => cf.activeChips.filter((c) => !EDGE_CARRIED_FILTER_KEYS.has(c.colKey)).length,
    [cf.activeChips],
  );

  // The graph is built from the FILTERED rows, so a filter genuinely shrinks the
  // node set the budget is measured against — filtering is the primary way a reader
  // gets a clipped graph back under budget (see the truncation chip below).
  //
  // ⚠ Narrowed back to rows the LIST actually returned, on purpose. Handing the model the
  // widened corpus would work — and would silently disable its endpoint-hydration path,
  // collapsing `hydratedNodeCount` to 0 and taking the honest "N outside the list's
  // current page" chip off screen with it. That chip is how a reader learns why a node
  // they can see is not in the list beside it; deleting the disclosure that made the last
  // bug findable, in the course of fixing that same bug, is not a trade worth making.
  //
  // ⚠ MEMOIZED, and that is load-bearing rather than a micro-optimisation (WI-39552).
  // This feeds `graph`, `graph` feeds the ELK layout effect below, and that effect calls
  // `setPositioned`. As a bare `cf.rows.filter(...)` this was a fresh array literal on
  // EVERY render, so `graph` was a new object on every render, so the effect re-ran on
  // every render and set state again — React's textbook "one of the dependencies changes
  // on every render" runaway. It cost ~145 aborted update loops per dock mount
  // ("Maximum update depth exceeded"), invisibly: the pane still renders, so no test
  // verdict caught it. Guard: adv-work-items-render-loop.spec.ts, whose oracle is the
  // console-error COUNT.
  const visibleItems = useMemo(
    () => (items == null ? null : cf.rows.filter((r) => listIds.has(r.id))),
    [items, cf.rows, listIds],
  );

  const graph = useMemo(() => {
    if (!visibleItems || !edgeRows) return null;
    return buildDepSubgraph({
      items: visibleItems.map((i) => ({
        id: i.id,
        kind: i.kind,
        title: i.title,
        state: i.state,
        // P-012: carries the plan provenance so the renderer can mark plan items.
        planSlug: i.planSlug,
      })),
      edges: edgeRows,
      selectedId: selectedId || null,
      healthOnly,
      // WI-36045: the model must not guess why `items` is a subset of the corpus. Only the
      // caller knows whether the user filtered, or whether this is just the list's window.
      filterActive: cf.hasActive,
      // …and only the caller can say WHICH nodes survived that filter, because only it can
      // build a filterable row for an edge-carried endpoint (see `filterCorpus` above).
      filteredIds,
    });
  }, [visibleItems, edgeRows, selectedId, healthOnly, cf.hasActive, filteredIds]);

  // FOCUS (P-006). Hover is render-only, transient, and not user-meaningful state, so it
  // is the documented `useState` case rather than nuqs — unlike `sel`, nobody wants to
  // link someone to "the node I was hovering". Selection is still the URL's job.
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const [positioned, setPositioned] = useState<Positioned | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  /** Guards against an out-of-order layout resolving after a newer one (async race). */
  const layoutSeq = useRef(0);

  useEffect(() => {
    if (!graph || graph.nodes.length === 0) {
      setPositioned(null);
      return;
    }
    const seq = ++layoutSeq.current;
    let cancelled = false;

    (async () => {
      try {
        const elk = await getElk();
        const laid = (await elk.layout({
          id: 'root',
          layoutOptions: ELK_OPTIONS,
          children: graph.nodes.map((n) => ({ id: n.id, width: NODE_W, height: NODE_H })),
          edges: graph.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
        })) as { children?: Array<{ id: string; x?: number; y?: number }>; width?: number; height?: number };

        if (cancelled || seq !== layoutSeq.current) return;
        const pos = new Map((laid.children ?? []).map((c) => [c.id, c]));
        const nodes = graph.nodes.map((n) => ({
          ...n,
          x: pos.get(n.id)?.x ?? 0,
          y: pos.get(n.id)?.y ?? 0,
        }));
        // P-005 — SIZE THE CANVAS FROM THE NODES, not from ELK's reported extent alone.
        // The rightmost column was rendering sliced mid-card. `laid.width` is whatever the
        // layouter chose to report, and taking it as the SVG width means any disagreement
        // between it and where the nodes actually ended up gets resolved by clipping — the
        // one resolution a reader cannot detect, because a half-drawn card looks like a
        // scroll boundary. Measuring max(x + NODE_W) is the definition of "no node is cut",
        // is independent of ELK's bookkeeping, and can only ever grow the canvas. EDGE_PAD
        // leaves room for the arrowhead + the selected node's 2px stroke, which sit OUTSIDE
        // the node box and would otherwise clip at the exact extent.
        const EDGE_PAD = 8;
        const extentW = nodes.reduce((m, n) => Math.max(m, n.x + NODE_W), 0) + EDGE_PAD;
        const extentH = nodes.reduce((m, n) => Math.max(m, n.y + NODE_H), 0) + EDGE_PAD;
        setPositioned({
          nodes,
          edges: graph.edges,
          width: Math.max(laid.width ?? 0, extentW),
          height: Math.max(laid.height ?? 0, extentH),
        });
        setLayoutError(null);
      } catch (err) {
        if (cancelled || seq !== layoutSeq.current) return;
        // Surface it. A silently blank graph is indistinguishable from "no dependencies",
        // which is the one thing this pane must never do.
        setLayoutError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [graph]);

  /**
   * The ONE way selection is cleared. The button and the Esc key both call this, so the
   * two can never drift apart — which is the whole reason it is a callback rather than
   * two `setSelectedId('')` call sites (P-007/P-008).
   */
  const clearSelection = useCallback(() => {
    void setSelectedId('');
  }, [setSelectedId]);

  // P-008 — Esc deselects. [owner 2026-08-08 verbatim] "pressing esc should also
  // automatically deselect".
  //
  // Document-level, because selection is a PANE-WIDE mode: the user may have clicked an
  // SVG node (not focusable), so a handler bound to the pane's DOM subtree would only fire
  // for the a11y list. The guards are what make a document listener acceptable rather than
  // a key-stealer, and each one is a case Esc already means something else:
  //   • nothing selected      → do nothing AND do not preventDefault, so Esc still reaches
  //                             whatever else would have handled it (the item's own test).
  //   • already handled       → a dialog/menu that called preventDefault wins.
  //   • a Radix layer is open → its popper wrapper is in the DOM; Esc closes THAT first.
  //   • focus is in a field   → Esc is the editor's own cancel.
  useEffect(() => {
    if (!selectedId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // ⚠ `e.target` is NOT always an Element — a keydown with nothing focused targets the
      // Document, which has no `closest`/`tagName`. Reading it as an HTMLElement throws
      // INSIDE a document-level listener, i.e. an unhandled exception on a keypress. The
      // instanceof narrowing is the guard, not decoration.
      const t = e.target;
      if (t instanceof Element) {
        const tag = t.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          (t instanceof HTMLElement && t.isContentEditable) ||
          t.closest('[role="dialog"], [role="menu"], [role="listbox"]')
        ) {
          return;
        }
      }
      if (document.querySelector('[data-radix-popper-content-wrapper], [role="dialog"]')) return;
      e.preventDefault();
      clearSelection();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selectedId, clearSelection]);

  /**
   * P-007 — SCROLL THE SELECTION INTO VIEW when `sel` changes from OUTSIDE this pane.
   *
   * Clicking a row in the list pane writes `sel`, which re-scopes this graph to that
   * item's connected component. But the canvas is far wider than the viewport, so if the
   * node lands off-screen the visible region does not change at all — and the honest
   * reading of an unchanged view is "nothing happened". The pane was working; it just had
   * no way to say so.
   *
   * Runs off `positioned` as well as `selectedId` because the coordinates do not exist
   * until ELK resolves: on a selection that triggers a re-layout, the effect fires once
   * with no position and again with one. `block/inline: 'center'` rather than 'nearest'
   * so the node arrives with its neighbours around it — the point is the lineage, not the
   * card. Guarded by `scrollWidth > clientWidth` so it can never steal scroll on a canvas
   * that already fits.
   */
  const canvasRef = useRef<HTMLDivElement | null>(null);

  /**
   * The canvas's own width, measured — needed ONLY by the `fit` rung, which is a ratio
   * against the viewport and therefore cannot be computed from the layout alone.
   *
   * A ResizeObserver rather than a one-shot read: this pane lives in a dockview split the
   * user drags, so a width captured once is wrong the moment the pane is resized, and a
   * `fit` that silently stops fitting is the same class of quiet-wrongness this whole pass
   * is about. Initialised to 0 and treated as "not yet measured" (see `scale`) so the first
   * paint never divides by a width that does not exist.
   */
  const [canvasW, setCanvasW] = useState(0);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    setCanvasW(el.clientWidth);
    const ro = new ResizeObserver(() => setCanvasW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /**
   * The effective scale factor. `fit` resolves against the measured canvas; every other
   * rung is a literal percentage.
   *
   * Clamped to ≤1 for `fit` deliberately: "fit" means "get the whole thing on screen", and
   * blowing a small graph up to fill the pane is a different request (that is what the 125
   * and 150 rungs are for). Falls back to 1 while unmeasured or when the layout has no
   * width, so an unresolved measurement can never render a zero-size canvas.
   */
  const scale = useMemo(() => {
    if (zoom !== 'fit') return Number(zoom) / 100;
    if (!positioned || positioned.width <= 0 || canvasW <= 0) return 1;
    return Math.min(1, canvasW / positioned.width);
  }, [zoom, positioned, canvasW]);

  /**
   * Below this, the 11px node titles stop being readable — so the pane SAYS SO rather than
   * letting the reader conclude the labels failed to render. Stated as a threshold on the
   * effective scale, which is what `fit` makes unpredictable: on a wide graph `fit` can land
   * at 0.2, and that is a legitimate view of the SHAPE with no legible text in it.
   */
  const textLegible = scale >= 0.67;

  /**
   * Step one rung. Stepping OUT of `fit` starts from the rung nearest the fitted scale
   * rather than from 100% — after fitting a wide graph to 22%, a `+` that jumped to 125%
   * would read as the button having done something else entirely.
   */
  const stepZoom = useCallback(
    (dir: 1 | -1) => {
      const from =
        zoom === 'fit'
          ? ZOOM_RUNGS.reduce((best, r) =>
              Math.abs(Number(r) / 100 - scale) < Math.abs(Number(best) / 100 - scale) ? r : best,
            )
          : zoom;
      const i = ZOOM_RUNGS.indexOf(from as (typeof ZOOM_RUNGS)[number]);
      const next = ZOOM_RUNGS[Math.min(ZOOM_RUNGS.length - 1, Math.max(0, i + dir))];
      void setZoom(next);
    },
    [zoom, scale, setZoom],
  );

  useEffect(() => {
    if (!selectedId || !positioned) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (canvas.scrollWidth <= canvas.clientWidth && canvas.scrollHeight <= canvas.clientHeight) {
      return;
    }
    const node = canvas.querySelector(`[data-node-id="${CSS.escape(selectedId)}"]`);
    node?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  }, [selectedId, positioned]);

  /**
   * FOCUS SETS (P-006) — the node under focus, its immediate neighbours, and the edges
   * incident to it. Everything else is de-emphasised in CSS.
   *
   * At 84 edges crossing a 129-node layered DAG, tracing one item's lineage by eye is the
   * pane's hardest task and the biggest reason it reads as a grid of cards rather than a
   * graph. Hover leads selection: hovering is a question ("what does THIS touch?") and
   * answering it must not require committing to a click that also re-scopes the graph and
   * drives two other panes.
   *
   * ⚠ Emphasis is bought with CONTRAST and OPACITY only — never stroke weight. That is
   * the predecessor plan's D-001, from the owner's "the edges are much too big"; a focus
   * mode that thickens the focused edges would re-introduce the exact complaint that
   * decision settled, one interaction later.
   */
  const focusId = hoveredId ?? (selectedId || null);
  const focus = useMemo(() => {
    if (!focusId || !positioned) return null;
    const neighbours = new Set<string>([focusId]);
    const edgeIds = new Set<string>();
    for (const e of positioned.edges) {
      if (e.source === focusId) {
        neighbours.add(e.target);
        edgeIds.add(e.id);
      } else if (e.target === focusId) {
        neighbours.add(e.source);
        edgeIds.add(e.id);
      }
    }
    // A node with no edges at all would dim the ENTIRE graph to highlight one card —
    // strictly worse than not focusing. Only engage when there is a relationship to show.
    if (edgeIds.size === 0) return null;
    return { neighbours, edgeIds };
  }, [focusId, positioned]);

  /**
   * The deepest blocker chain on screen (P-009). The model documents depth as "the signal
   * this pane exists to surface" — a seven-deep chain served as claimable was the
   * subsystem's worst escape (EI-9108) — yet nothing on screen has ever STATED it, so the
   * one number the pane was built to reveal had to be counted by eye off the layout.
   */
  const maxDepth = useMemo(
    () => (positioned?.nodes ?? []).reduce((m, n) => Math.max(m, n.depth), 0),
    [positioned],
  );

  /** Unique per mounted pane — two panes in one dock must not share arrowhead marker ids. */
  const rawUid = useId();
  const uid = rawUid.replace(/[^a-zA-Z0-9_-]/g, '');

  if (!slug) return <div className="pc-advpanel__empty">No harness selected.</div>;
  if (error) return <div className="pc-advpanel__empty">Could not load the dependency graph: {error}</div>;
  if (!graph) return <div className="pc-advpanel__empty">Loading dependency graph…</div>;

  // The bar is rendered in BOTH the empty and populated states, and that is load-bearing
  // rather than tidy: filtering is now the primary navigation, so a filter that happens to
  // match nothing must NOT take its own "Clear" affordance off screen with it. Hiding the
  // bar on empty strands the user in a graph they cannot un-filter without editing the URL.
  // P-001 — ANSWER "why 18,647 items but only 122 nodes?" IN THE PANE.
  //
  // The count is only sayable when the graph is UNSCOPED. `totalInScope` means "nodes before
  // the budget", which equals "items that participate in an edge" ONLY when no selection, no
  // health mode and no column filter have narrowed the edge set first; under any of those it
  // is a scoped subset and the sentence "N of TOTAL items have dependencies" becomes false.
  // So the claim is gated on the scoping being absent rather than reworded to survive it — a
  // number that is right in the common case and quietly wrong in the others is worse than no
  // number, and this pane has already paid for one of those (WI-36045).
  //
  // The denominator is the companion aggregate, never the 500-row node page.
  // If the summary is absent/updating the corpus claim is withheld.
  const corpusTotal = !pairedFetching && summary ? summary.total : 0;
  const unscoped = !selectedId && !healthOnly && !cf.hasActive;
  const canStateCorpus = unscoped && corpusTotal > 0 && graph.totalInScope > 0;

  const bar = (
    <div className="pc-advpanel__bar pc-advpanel__bar--wrap">
      {selectedId && (
        // P-007 — the exit from a filtered state, given real emphasis and placed FIRST.
        // [owner 2026-08-08 verbatim] "when you have a ndoe selected the clear selection
        // button should be more visible". It used to be a .pc-advpanel__iconbtn — a fixed
        // 28×28 icon box — sitting last in a crowded row, so it read as chrome AND had its
        // text label wrapped by the 28px width. Accent variant, first position: when
        // something IS selected, the way out is the first thing the eye reaches, and with
        // the bar now wrapping it can never be pushed off screen.
        <Button
          variant="accent"
          className="pc-depgraph__clearsel"
          onClick={clearSelection}
          aria-label={`Clear selection (${selectedId}) and show the whole dependency graph. Escape also clears it.`}
        >
          Clear selection
        </Button>
      )}
      <span className="pc-advpanel__chip">
        {canStateCorpus
          ? `${graph.totalInScope.toLocaleString()} of ${corpusTotal.toLocaleString()} items have dependencies`
          : `${graph.nodes.length} node${graph.nodes.length === 1 ? '' : 's'}`}{' '}
        · {graph.edges.length} edge{graph.edges.length === 1 ? '' : 's'}
      </span>
      {canStateCorpus && (
        // The RULE, not just the number — a reader who wonders "where are the other 18,525?"
        // gets the answer without leaving the pane, which is the item's acceptance test.
        <span className="pc-depgraph__note">Items with no dependency are not drawn</span>
      )}
      {graph.truncated && (
        // Absence is reported, never silent (D-003 / the budget contract).
        <span className="pc-advpanel__chip pc-depgraph__chip--warn" role="status">
          {graph.hiddenCount} more hidden of {graph.totalInScope} — filter or select to narrow
        </span>
      )}
      {graph.filteredEdgeCount > 0 && (
        // WI-36045's detector. The original bug was invisible precisely because dropped edges
        // had no counter — 2 nodes out of 122 read as real data. A filter narrowing the graph
        // is legitimate; a filter narrowing it SILENTLY is what cost a week.
        <span className="pc-advpanel__chip" role="status">
          {graph.filteredEdgeCount} edge{graph.filteredEdgeCount === 1 ? '' : 's'} hidden by
          filters
        </span>
      )}
      {maxDepth > 0 && (
        // P-009 — STATE THE DEPTH. This is the number the pane exists to surface, and
        // until now the only way to get it was to count layers by eye across a canvas
        // wider than the viewport. It is deliberately a WORDED chip, not a seventh visual
        // encoding on the node: the pane's legibility problem is already six unexplained
        // marks (P-005), and adding a mark to fix "depth is invisible" would trade one
        // instance of that problem for another.
        <span className="pc-advpanel__chip">
          deepest chain: {maxDepth} blocker{maxDepth === 1 ? '' : 's'}
        </span>
      )}
      {graph.hydratedNodeCount > 0 && (
        // Not a warning: these are real rows, drawn from the same work_items rows the list
        // reads, that simply fall outside its recency window. Stated so a reader is never
        // puzzled by a node they cannot find in the list pane beside it.
        <span className="pc-advpanel__chip" role="status">
          {graph.hydratedNodeCount} outside the list&rsquo;s current page
        </span>
      )}
      {/*
        The integrity view, as a MODE on this pane rather than a second surface
        (dependency-health-pane-2026-08-02 P-008).

        ⚠ THE CLASS IS THE FIX (this pass's P-002). This was `.pc-advpanel__iconbtn`, which
        is a fixed `width:28px; height:28px; flex-shrink:0` ICON box — so a TEXT label inside
        it had 28px to lay out in and wrapped into three fragments: a detached state glyph on
        one line, then "Issues", then "only". That is precisely the artefact in the owner's
        screenshot, and no amount of `nowrap` on a 28px box would have fixed it. `.pc-advpanel__chip`
        is the house toggle recipe (/internal/docs/design#buttons: native button + aria-pressed,
        tinted fill when pressed), it sizes to its label, and it carries the pressed state as a
        FILL rather than as a wrappable text node — so the state can no longer come apart from
        the word it describes. The glyph is gone for the same reason. (design-phase:search_registry
        has no toggle primitive to reuse — checked, empty.)
      */}
      <button
        type="button"
        className="pc-advpanel__chip"
        aria-pressed={healthOnly}
        /* aria-label, not title: `lint:design-primitives` blocks title-only
           tooltips on buttons because a title is invisible to keyboard and
           touch — and this one carried the button's ONLY explanation of what
           "Issues only" means. It was red-pinning the fleet's green gate on
           committed code. The visible text stays; aria-label supersedes it as
           the accessible name and carries the explanation with it. */
        aria-label={
          healthOnly
            ? 'Issues only — showing only edges that gate nothing: broken (blocker missing) or already satisfied. Activate to show all edges.'
            : 'Issues only — show only edges that gate nothing: broken (blocker missing) or already satisfied.'
        }
        onClick={() => void setHealth(healthOnly ? 'all' : 'issues')}
      >
        Issues only
      </button>
      <button
        type="button"
        className="pc-advpanel__chip"
        aria-pressed={legendOpen}
        aria-label={
          legendOpen
            ? 'Key — showing what each line and mark in the graph means. Activate to hide it.'
            : 'Key — show what each line and mark in the graph means.'
        }
        onClick={() => void setLegend(legendOpen ? 'off' : 'on')}
      >
        Key
      </button>
      {/*
        ZOOM (P-008). Four small controls, not seven rungs: the bar is already dense and
        this file's own P-005 note is that crowding it is how the previous layout was lost.
        `Fit` is a toggle (aria-pressed) because it is a MODE — it keeps fitting as the pane
        is resized — while −/+ write a fixed rung, so pressing either necessarily leaves fit.
        The percentage between them is a button, not a label: it is the reset-to-100% target,
        which is the one zoom action a reader wants without hunting for a rung.
      */}
      <span className="pc-depgraph__zoom" role="group" aria-label="Graph zoom">
        <button
          type="button"
          className="pc-advpanel__chip"
          aria-pressed={zoom === 'fit'}
          aria-label={
            zoom === 'fit'
              ? 'Fit to width — the whole graph is scaled to fit the pane, and re-fits when the pane is resized. Activate to return to 100%.'
              : 'Fit to width — scale the whole graph down until it fits the pane.'
          }
          onClick={() => void setZoom(zoom === 'fit' ? '100' : 'fit')}
        >
          Fit
        </button>
        <button
          type="button"
          className="pc-advpanel__chip"
          aria-label="Zoom out"
          disabled={zoom !== 'fit' && zoom === ZOOM_RUNGS[0]}
          onClick={() => stepZoom(-1)}
        >
          &minus;
        </button>
        <button
          type="button"
          className="pc-advpanel__chip"
          // The accessible name carries the number because the visible text is a bare "%"
          // reading that says nothing about what activating it does.
          aria-label={`Zoom is ${Math.round(scale * 100)} percent. Activate to reset to 100 percent.`}
          onClick={() => void setZoom('100')}
        >
          {Math.round(scale * 100)}%
        </button>
        <button
          type="button"
          className="pc-advpanel__chip"
          aria-label="Zoom in"
          disabled={zoom !== 'fit' && zoom === ZOOM_RUNGS[ZOOM_RUNGS.length - 1]}
          onClick={() => stepZoom(1)}
        >
          +
        </button>
      </span>
      {!textLegible && (
        // SAY IT (P-008). At a small `fit` the node titles are present in the DOM and
        // genuinely unreadable on screen. Unstated, that reads as "the labels failed to
        // render" — the same absence-as-defect misreading the rest of this pane is built to
        // prevent — so the pane names the trade and points at the two surfaces that still
        // carry the text: the a11y list, and the list pane beside it.
        <span className="pc-advpanel__chip pc-depgraph__chip--warn" role="status">
          labels unreadable at this scale — shape only
        </span>
      )}
      {/* Same control, same `wif` param, same columns as the list pane (P-010).
          `promote={['plan']}` (P-002) lifts Plan out of the `+Add filter…` dropdown into a
          visible labelled axis — the owner asked for "a plan filter" against a pane that
          already had one, which is what an invisible control earns. Only Plan is promoted:
          on a dependency graph, "which plan is this" is the question the pane is for. */}
      <ColumnFilterBar
        controller={cf.controller}
        activeChips={cf.activeChips}
        hasActive={cf.hasActive}
        clearAll={cf.clearAll}
        promote={PROMOTED_FILTERS}
      />
      {cf.hasActive && (
        // P-004 — SAY WHAT THE FILTER DID, the way the corpus rule is stated above.
        // With a filter active an edge survives if EITHER endpoint matches, so filtering
        // to a plan shows that plan's items PLUS whatever gates them from outside it.
        // That is the right semantic for a dependency view — "this plan, and what blocks
        // it" — but it is not guessable from the picture, and a reader who assumes strict
        // membership will read those extra nodes as a bug.
        <span className="pc-depgraph__note">
          Showing matching items and whatever blocks them
        </span>
      )}
      {filterScopeGap && (
        // The ONE place the filter's corpus is still narrower than the graph's, stated
        // rather than left to be discovered (D-002). Edge-carried rows have only
        // title/kind/state/plan, so filtering on a column they lack cannot judge them —
        // and silently excluding a node because a field was never fetched is precisely
        // the "absence rendered as zero" failure this pane is built to avoid.
        <span className="pc-advpanel__chip pc-depgraph__chip--warn" role="status">
          {filterScopeGap} filter{filterScopeGap === 1 ? '' : 's'} cannot judge items outside
          the list&rsquo;s page — those are excluded
        </span>
      )}
    </div>
  );

  if (graph.nodes.length === 0) {
    // Say WHICH empty this is — the filters are the navigation, so "you filtered it away" and
    // "nothing depends on anything" need different next actions from the user. Filters are
    // checked FIRST: when a filter is active it is the most likely cause and the one the
    // reader can act on immediately.
    // Integrity mode reports a CLEAN result as a finding in its own right — "no broken or
    // inert edges" is the good outcome, and must not read like the pane failed to load.
    const why = healthOnly
      ? 'No broken or already-satisfied edges — nothing here gates nothing.'
      : cf.hasActive
        ? // WI-36234: "No work items match the active filters" was a FALSE statement whenever
          // the filters matched plenty — the grid beside it said "432 of 18601 match" — and
          // it is the EDGE set that came up empty. Name the empty thing, because the two
          // cases need different next actions: widen the filter vs. there is no dependency
          // story here to tell.
          // ⚠ COUNT OVER `cf.rows`, NOT `visibleItems`. `visibleItems` is narrowed to rows
          // the LIST returned, so before D-002 this branch reported "No work items match"
          // whenever the matches all fell outside the list's 500-row window — measured
          // live: a plan with 11 nodes and 8 edges on screen produced exactly that
          // sentence. It is the WRONG diagnosis, not merely an unhelpful one: it sends the
          // reader to widen a filter that was never too narrow.
          cf.rows.length > 0
          ? `None of the ${cf.rows.length.toLocaleString()} items matching the active filters have dependencies.`
          : 'No work items match the active filters.'
        : items && items.length === 0
          ? 'No work items for this harness.'
          : selectedId
            ? `${selectedId} has no dependencies.`
            // NOT "among the visible work items" any more (WI-36045): the graph is no longer
            // limited to the list's window, so an empty graph here really does mean the
            // harness records no dependency edges — a stronger, more useful statement.
            : 'No dependency edges recorded for this harness.';
    return (
      <div className="pc-advpanel pc-depgraph">
        {bar}
        <div className="pc-advpanel__empty">{why}</div>
      </div>
    );
  }

  return (
    <div className="pc-advpanel pc-depgraph">
      {bar}
      {legendOpen && <DepGraphLegend />}

      {healthOnly && (
        <aside className="pc-depgraph__integrity" aria-label="Dependency integrity findings">
          <strong>{graph.findings.length} integrity finding{graph.findings.length === 1 ? '' : 's'}</strong>
          <span>
            Width {graph.topologyRisk.readyWidth} · depth {graph.topologyRisk.criticalPathDepth} · max fan-in {graph.topologyRisk.maxFanIn} · max fan-out {graph.topologyRisk.maxFanOut}
          </span>
          {graph.findings.map((f, index) => (
            <details key={`${f.code}:${index}`}>
              <summary>{f.classification}: {f.code} ({f.confidence})</summary>
              <p>{f.nodes.join(' → ')}</p>
              {f.suggestedAction && <p>Suggested review: {f.suggestedAction}</p>}
              <small>Advisory only — no dependency is changed automatically.</small>
            </details>
          ))}
        </aside>
      )}

      {layoutError && <div className="pc-advpanel__empty">Layout failed: {layoutError}</div>}

      {/*
        ACCESSIBILITY (P-006). D-001 flagged that a node-edge SVG is the least accessible of the
        five treatments and that its weakness is STRUCTURAL. So the graph is not the only
        representation: this is a real list, in dependency-depth order, keyboard reachable and
        readable by a screen reader, carrying the SAME depth/lineage information. It drives the
        same selection, so it is an equivalent control surface and not a consolation prize.
      */}
      <ul className="pc-depgraph__a11y" aria-label="Dependency graph, as a list ordered by depth">
        {positioned?.nodes.map((n) => (
          <li key={n.id}>
            <button
              type="button"
              aria-current={n.id === selectedId}
              onClick={() => void setSelectedId(n.id)}
            >
              {n.dangling
                ? `Unresolved blocker ${n.title}`
                : `${n.id} — ${n.title} (depth ${n.depth}, ${n.state})`}
            </button>
          </li>
        ))}
      </ul>

      <div className="pc-depgraph__canvas" ref={canvasRef}>
        {positioned && (
          <svg
            // The pane now renders SEVERAL <svg> elements — this canvas plus one small
            // swatch per legend row — so "the svg" is no longer an identifying query.
            // Named explicitly rather than left to DOM order, which would silently make
            // any selector depend on whether the key happens to be open.
            className="pc-depgraph__svg"
            // P-008 — ZOOM. The rendered box scales; the COORDINATE SPACE does not. Every
            // x/y below (and the layout that produced them) stays in unscaled layout units
            // because `viewBox` maps them onto whatever box we ask for — so zoom touches
            // exactly these three attributes and nothing downstream has to know about it.
            // Scaling by rewriting node coordinates instead would have meant scaling stroke
            // widths, font sizes and the arrowhead markers by hand, each an opportunity to
            // get one of them wrong.
            width={Math.max(positioned.width * scale, 1)}
            height={Math.max(positioned.height * scale, 1)}
            viewBox={`0 0 ${Math.max(positioned.width, 1)} ${Math.max(positioned.height, 1)}`}
            role="img"
            aria-label={
              // The scale belongs in the accessible name: at a small `fit` the labels are
              // genuinely unreadable, and a screen-reader user has no other way to know the
              // picture they are being described is a shape-level view.
              `Dependency graph: ${positioned.nodes.length} items` +
              (scale === 1 ? '' : `, shown at ${Math.round(scale * 100)}% scale`)
            }
          >
            {/*
              ARROWHEADS (P-004). One marker per edge class, rather than one marker inheriting
              the stroke: `context-stroke` is SVG2 and its support is uneven across the engines
              this ships on, and an arrowhead that silently renders black on a dark panel is
              worse than none. Three explicit markers cost three <defs> children and cannot
              degrade. Marker ids are pane-scoped (`uid`) so two panes in one dock do not
              collide — a duplicate id would make one pane's arrows adopt the other's colour.
            */}
            <defs>
              {(['default', 'satisfied', 'dangling'] as const).map((variant) => (
                <marker
                  key={variant}
                  id={`pc-dg-arrow-${variant}-${uid}`}
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto"
                >
                  <path
                    d="M 0.5 1 L 7 4 L 0.5 7 z"
                    className={`pc-depgraph__arrowhead pc-depgraph__arrowhead--${variant}`}
                  />
                </marker>
              ))}
            </defs>
            {/*
              EDGES ARE STILL THE SECONDARY MARK (D-003 req 1 — the owner's "the edges are much
              too big"). This pass raises CONTRAST and adds DIRECTION; it does NOT raise weight.
              Those are different complaints and both owner-sourced: the stroke stays hairline,
              the opacity comes up off the floor, and an arrowhead says which end blocks which —
              the one thing a dependency graph exists to convey, and the thing 79 undirected
              hairlines could not. Colours stay in CSS custom properties so the tokens govern.
            */}
            <g className="pc-depgraph__edges" fill="none">
              {positioned.edges.map((e) => {
                const a = positioned.nodes.find((n) => n.id === e.source);
                const b = positioned.nodes.find((n) => n.id === e.target);
                if (!a || !b) return null;
                const x1 = a.x + NODE_W;
                const y1 = a.y + NODE_H / 2;
                // Stop 2px short of the target so the arrowhead sits BESIDE the node border
                // rather than under it — an arrow drawn onto the card reads as a fleck.
                const x2 = b.x - 2;
                const y2 = b.y + NODE_H / 2;
                const mid = (x1 + x2) / 2;
                const variant = e.dangling ? 'dangling' : e.satisfied ? 'satisfied' : 'default';
                // P-006: emphasis by CONTRAST, never weight (D-001). The focused edges
                // keep their hairline stroke and gain opacity; the rest recede.
                const focusClass = !focus
                  ? ''
                  : focus.edgeIds.has(e.id)
                    ? ' pc-depgraph__edge--focus'
                    : ' pc-depgraph__edge--dim';
                return (
                  <path
                    key={e.id}
                    d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                    markerEnd={`url(#pc-dg-arrow-${variant}-${uid})`}
                    className={
                      (variant === 'default'
                        ? 'pc-depgraph__edge'
                        : `pc-depgraph__edge pc-depgraph__edge--${variant}`) + focusClass
                    }
                  />
                );
              })}
            </g>
            <g className="pc-depgraph__nodes">
              {positioned.nodes.map((n) => (
                <g
                  key={n.id}
                  // P-007's scroll target. A data attribute rather than an `id`: two panes
                  // can hold the same node in one dock, and duplicate DOM ids would make
                  // the query resolve into whichever pane happened to mount first.
                  data-node-id={n.id}
                  transform={`translate(${n.x}, ${n.y})`}
                  className={`pc-depgraph__node${n.dangling ? ' pc-depgraph__node--dangling' : ''}${
                    n.planSlug ? ' pc-depgraph__node--plan' : ''
                  }${n.id === selectedId ? ' pc-depgraph__node--selected' : ''}${
                    // P-006 — a node is emphasised when it is the focus or a neighbour of
                    // it, and receded otherwise. No class at all when nothing is focused,
                    // so the default picture is untouched.
                    !focus
                      ? ''
                      : focus.neighbours.has(n.id)
                        ? ' pc-depgraph__node--focus'
                        : ' pc-depgraph__node--dim'
                  }`}
                  onClick={() => void setSelectedId(n.id)}
                  onMouseEnter={() => setHoveredId(n.id)}
                  onMouseLeave={() => setHoveredId((cur) => (cur === n.id ? null : cur))}
                >
                  {/* The full title, unabridged, for the truncated card below. An SVG <title>
                      CHILD is not the `title=` ATTRIBUTE the design-primitives lint blocks on
                      action elements — it is the standard accessible name for an SVG group,
                      and the planmark already uses it the same way. */}
                  <title>
                    {n.dangling
                      ? `${n.id} — unresolved blocker`
                      : `${n.id} — ${n.title} (${n.state}, depth ${n.depth})`}
                  </title>
                  <rect width={NODE_W} height={NODE_H} rx={6} />
                  {/* P-012: plan provenance as a left edge-marker rather than a fill or
                      border change. Fill is already spoken for by state and the border by
                      selection/dangling, so distinguishing plan items by either would
                      collide with a signal that is already load-bearing. A separate marker
                      composes with all of them, and stays legible on a small node. */}
                  {n.planSlug && (
                    <rect
                      className="pc-depgraph__node-planmark"
                      width={3}
                      height={NODE_H}
                      rx={1.5}
                    >
                      <title>{`from plan: ${n.planSlug}`}</title>
                    </rect>
                  )}
                  {/* P-006 — STATE ON THE NODE, as a dot rather than a fill or a border.
                      Both of those are already load-bearing here (fill = dangling, border =
                      selection), so colouring either by state would overwrite a signal that
                      is already carrying meaning. A dot composes with all of them and stays
                      legible at this size. Dangling nodes get none: a placeholder for a row
                      that does not exist has no state to report, and inventing one would be
                      asserting data we do not have. */}
                  {!n.dangling && (
                    <circle
                      className={`pc-depgraph__node-state pc-depgraph__node-state--${stateBucket(n.state)}`}
                      cx={NODE_W - 11}
                      cy={13}
                      r={3.5}
                    />
                  )}
                  {/* HIERARCHY (P-006): the TITLE is what a reader recognises, so it is the
                      prominent line; the id is the reference you look up, so it is the small
                      muted label above it. It was the other way round, which is part of why
                      the pane read as a grid of ids. */}
                  <text x={10} y={17} className="pc-depgraph__node-id">
                    {n.id}
                  </text>
                  <text x={10} y={34} className="pc-depgraph__node-title">
                    {n.title.length > TITLE_CHARS ? `${n.title.slice(0, TITLE_CHARS - 1)}…` : n.title}
                  </text>
                </g>
              ))}
            </g>
          </svg>
        )}
      </div>
    </div>
  );
}

export { DEP_GRAPH_NODE_BUDGET };
