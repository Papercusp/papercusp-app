/**
 * workflow-graph-model — the pure, DB-free derivation behind the Workflows topology pane.
 *
 * Plan: external-triggers-gmail-slack-2026-08-22 (P-024), governed by D-013 AS AMENDED BY
 * D-016. D-016 changed the interaction model: the detail view is a READ-ONLY graph plus a
 * workflow agent chat. Structural edits are agent-mediated; the only direct controls are
 * arm / disarm / test. Nothing in this module produces an editable node — by decision.
 *
 * ── EVERY NODE IS DERIVED FROM A REAL BINDING FIELD ─────────────────────────────────────
 * The layout artboard (/tmp/workflows-builder/Editor.dc.html) draws six node kinds:
 * trigger · filter · recipe · plan · tool · outcome. Only four of them have a field in
 * `ExternalTriggerBindingAdminRow` today:
 *
 *   trigger  ← sourceKind + eventPattern
 *   filter   ← eventFilter        (omitted entirely when the filter object is empty)
 *   plan     ← planSlug / planHarnessSlug
 *   tool     ← action.type        (when it is NOT the default 'launch-plan')
 *
 * `recipe` still has NO binding field to read, so this module does not emit it. A distinct
 * `outcome` is emitted only for a blueprint-operation row when the caller supplies the
 * canonical item/plan target joined from `recentRuns[].blueprintOperation`; it is never
 * inferred from action prose. A node drawn from nothing is a claim the UI cannot support,
 * and this pane's whole job is to show the operator what is really wired.
 *
 * ── ABSENCE IS NEVER RENDERED AS ZERO ───────────────────────────────────────────────────
 * An empty graph carries `emptyReason` saying WHY it is empty. A reader must be able to tell
 * "this workflow has no external binding" from "we failed to load it" — the same rule
 * DepGraphPanel states for the work-item dependency graph.
 */

/** Node kinds the topology pane can render. See the header note on `recipe` / `outcome`. */
export type WorkflowNodeKind = 'trigger' | 'filter' | 'recipe' | 'plan' | 'tool' | 'outcome';

/** Health of a node, mapped to the pane's three swatches. */
export type WorkflowNodeState = 'ok' | 'attention' | 'idle';

export interface WorkflowGraphNode {
  id: string;
  kind: WorkflowNodeKind;
  /** Primary line — the human name of the step. */
  label: string;
  /** Secondary line — the machine detail (provider, pattern, slug). */
  detail: string;
  /** Optional third line of cost/latency/shape metadata; null when unknown. */
  meta: string | null;
  state: WorkflowNodeState;
}

export type WorkflowOutcomeTarget =
  | { kind: "work-item"; id: string; status: string | null }
  | {
      kind: "plan";
      runId: number;
      instanceSlug: string;
      status: string | null;
      outcome: string | null;
    };

export interface WorkflowGraphEdge {
  id: string;
  from: string;
  to: string;
  /** Edge annotation (e.g. a storm policy); null when the hop carries no policy. */
  label: string | null;
}

export type WorkflowGraphEmptyReason =
  | 'no-workflow'
  | 'no-binding'
  | 'not-loaded';

export interface WorkflowGraph {
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
  /** Non-null exactly when `nodes` is empty, and says WHY. */
  emptyReason: WorkflowGraphEmptyReason | null;
}

/**
 * The binding fields this model reads — a STRUCTURAL subset of
 * `ExternalTriggerBindingAdminRow` (packages/operator-core/lib/external-triggers/admin.ts).
 *
 * Declared structurally rather than imported so the pure model stays free of the operator-core
 * import graph (and so a test can build one by hand). Widening the real row stays compatible;
 * narrowing it would fail typecheck at the call site, which is where we want to hear about it.
 */
export interface WorkflowBindingInput {
  id: string;
  sourceKind: string;
  eventPattern: string;
  eventFilter: Record<string, unknown>;
  action: Record<string, unknown>;
  stormPolicy: Record<string, unknown>;
  planSlug: string | null;
  planHarnessSlug: string | null;
  armed: boolean;
  lastRun?: { status: string } | null;
}

export interface BuildWorkflowGraphInput {
  /** The workflow's display name, when known (falls back to the plan slug). */
  workflowLabel?: string | null;
  /** The binding that wires this workflow, or null when it has none. */
  binding: WorkflowBindingInput | null;
  /**
   * Whether the binding snapshot has actually been fetched yet. `false` yields
   * `emptyReason: 'not-loaded'`, so a pending read never renders as "nothing wired".
   */
  loaded?: boolean;
  /**
   * From `plans:get-output-schema` (shipped this session under P-026): whether this plan
   * declares outputs a downstream deterministic step may consume (D-015). Drives the plan
   * node's meta line; null when not read.
   */
  planChainable?: boolean | null;
  /** Canonical target joined from the latest blueprint-operation receipt. */
  operationTarget?: WorkflowOutcomeTarget | null;
}

/** Friendly provider names for the source kinds we ship adapters for. */
const SOURCE_LABELS: Record<string, string> = {
  'google-calendar': 'Calendar event',
  'google-gmail': 'Gmail message',
  gmail: 'Gmail message',
  'google-workspace': 'Workspace event',
  slack: 'Slack message',
};

function sourceLabel(kind: string): string {
  return SOURCE_LABELS[kind] ?? kind;
}

/**
 * Render one dotted-path predicate as a short human clause.
 *
 * Filters are `{ 'attendees.0': { exists: true } }`-shaped (see google-workspace.ts) — a
 * dotted payload path mapped to a predicate object. We describe the SHAPE, never invent a
 * meaning for a predicate we do not recognise: an unknown predicate renders as the raw path
 * so the operator can still see that a filter is present.
 */
function describePredicate(path: string, predicate: unknown): string {
  if (predicate && typeof predicate === 'object' && !Array.isArray(predicate)) {
    const record = predicate as Record<string, unknown>;
    if (record.exists === true) return `${path} exists`;
    if (record.exists === false) return `${path} missing`;
    if (typeof record.equals === 'string' || typeof record.equals === 'number') {
      return `${path} = ${String(record.equals)}`;
    }
    if (typeof record.contains === 'string') return `${path} contains "${record.contains}"`;
  }
  if (typeof predicate === 'string' || typeof predicate === 'number' || typeof predicate === 'boolean') {
    return `${path} = ${String(predicate)}`;
  }
  return path;
}

/** Describe a whole filter object. Returns null when there is nothing to filter on. */
export function describeEventFilter(eventFilter: Record<string, unknown>): string | null {
  const entries = Object.entries(eventFilter ?? {});
  if (entries.length === 0) return null;
  return entries.map(([path, predicate]) => describePredicate(path, predicate)).join(' · ');
}

/**
 * Describe a storm policy as an edge annotation.
 *
 * Accepts BOTH spellings the engine accepts (`maxRuns`/`max_runs`,
 * `windowSeconds`/`window_seconds`) — see parseStormPolicy in binding-engine.ts. Reading only
 * the camelCase half would silently drop the policy on snake_case rows, which is the quiet
 * kind of wrong: the pane would say "no policy" about a workflow that has one.
 */
export function describeStormPolicy(stormPolicy: Record<string, unknown>): string | null {
  const raw = stormPolicy ?? {};
  const maxRuns = raw.maxRuns ?? raw.max_runs;
  const windowSeconds = raw.windowSeconds ?? raw.window_seconds;
  const max = typeof maxRuns === 'number' && Number.isFinite(maxRuns) ? maxRuns : null;
  const window = typeof windowSeconds === 'number' && Number.isFinite(windowSeconds) ? windowSeconds : null;
  if (max === null && window === null) return null;
  if (max !== null && window !== null) return `max ${max} / ${formatWindow(window)}`;
  if (max !== null) return `max ${max}`;
  return `window ${formatWindow(window as number)}`;
}

function formatWindow(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** The action's declared type, defaulting exactly as binding-engine.ts's actionType() does. */
export function workflowActionType(action: Record<string, unknown>): string {
  const type = typeof action?.type === 'string' ? action.type.trim() : '';
  return type || 'launch-plan';
}

/**
 * Derive the read-only topology for one workflow.
 *
 * Pure: no I/O, no clock, no React. Every node traces to a binding field named in the header.
 */
export function buildWorkflowGraph(input: BuildWorkflowGraphInput): WorkflowGraph {
  const empty = (reason: WorkflowGraphEmptyReason): WorkflowGraph => ({
    nodes: [],
    edges: [],
    emptyReason: reason,
  });

  if (input.loaded === false) return empty('not-loaded');
  const binding = input.binding;
  if (!binding) return empty(input.workflowLabel ? 'no-binding' : 'no-workflow');

  const nodes: WorkflowGraphNode[] = [];
  const edges: WorkflowGraphEdge[] = [];

  // ── trigger ───────────────────────────────────────────────────────────────────────────
  // A disarmed binding is not broken, it is idle — so it gets the idle swatch, not the
  // attention one. Attention is reserved for a last run that actually failed.
  const triggerId = 'trigger';
  nodes.push({
    id: triggerId,
    kind: 'trigger',
    label: sourceLabel(binding.sourceKind),
    detail: `${binding.sourceKind} · ${binding.eventPattern}`,
    meta: binding.armed ? 'armed' : 'disarmed',
    state: binding.armed ? 'ok' : 'idle',
  });

  let previousId = triggerId;

  // ── filter (only when one is actually configured) ─────────────────────────────────────
  const filterText = describeEventFilter(binding.eventFilter);
  if (filterText) {
    const filterId = 'filter';
    nodes.push({
      id: filterId,
      kind: 'filter',
      label: 'Only when',
      detail: filterText,
      meta: null,
      state: 'ok',
    });
    edges.push({ id: `${previousId}->${filterId}`, from: previousId, to: filterId, label: null });
    previousId = filterId;
  }

  const actionType = workflowActionType(binding.action);
  const lastRunFailed = binding.lastRun?.status === 'failed';

  if (actionType === 'blueprint-operation') {
    const operationId = typeof binding.action.operationId === 'string'
      ? binding.action.operationId
      : 'unknown-operation';
    const harnessSlug = typeof binding.action.operationHarnessSlug === 'string'
      ? binding.action.operationHarnessSlug
      : 'unknown-harness';
    const operationNodeId = 'operation';
    nodes.push({
      id: operationNodeId,
      kind: 'tool',
      label: operationId,
      detail: `${harnessSlug} · registered blueprint operation`,
      meta: 'typed operation target',
      state: lastRunFailed ? 'attention' : 'ok',
    });
    edges.push({
      id: `${previousId}->${operationNodeId}`,
      from: previousId,
      to: operationNodeId,
      label: describeStormPolicy(binding.stormPolicy),
    });
    previousId = operationNodeId;
    const target = input.operationTarget ?? null;
    if (target) {
      const outcomeId = "outcome";
      const status = target.status ?? "status unavailable";
      const failed =
        target.kind === "work-item"
          ? ["failed", "dropped", "deprecated", "closed"].includes(status)
          : status === "failed" ||
            (status === "done" &&
              target.outcome != null &&
              target.outcome !== "success");
      nodes.push({
        id: outcomeId,
        kind: "outcome",
        label: target.kind === "work-item" ? target.id : target.instanceSlug,
        detail:
          target.kind === "work-item"
            ? `work item · ${status}`
            : `plan run #${target.runId} · ${status}${target.outcome ? ` · ${target.outcome}` : ""}`,
        meta: "canonical operation target",
        state: failed
          ? "attention"
          : status === "status unavailable"
            ? "idle"
            : "ok",
      });
      edges.push({
        id: `${previousId}->${outcomeId}`,
        from: previousId,
        to: outcomeId,
        label: null,
      });
      previousId = outcomeId;
    }
  } else if (binding.planHarnessSlug && binding.planSlug) {
    // ── plan ────────────────────────────────────────────────────────────────
    const planId = 'plan';
    nodes.push({
      id: planId,
      kind: 'plan',
      label: input.workflowLabel?.trim() || binding.planSlug,
      detail: `${binding.planHarnessSlug} · ${binding.planSlug}`,
      meta: input.planChainable == null ? null : input.planChainable ? 'declares outputs' : 'no declared outputs',
      state: lastRunFailed ? 'attention' : 'ok',
    });
    edges.push({
      id: `${previousId}->${planId}`,
      from: previousId,
      to: planId,
      label: describeStormPolicy(binding.stormPolicy),
    });
    previousId = planId;
  }

  // ── tool (only for a non-default action) ──────────────────────────────────────────────
  // 'launch-plan' IS the plan node already; emitting a second node for it would draw a hop
  // that does not exist.
  if (actionType !== 'launch-plan' && actionType !== 'blueprint-operation') {
    const toolId = 'action';
    nodes.push({
      id: toolId,
      kind: 'tool',
      label: actionType,
      detail: 'binding action',
      meta: null,
      state: 'ok',
    });
    edges.push({ id: `${previousId}->${toolId}`, from: previousId, to: toolId, label: null });
  }

  return { nodes, edges, emptyReason: null };
}

/** Human copy for an empty graph — the pane must say why, never render blank. */
export function workflowGraphEmptyCopy(reason: WorkflowGraphEmptyReason): string {
  switch (reason) {
    case 'not-loaded':
      return 'Loading topology…';
    case 'no-binding':
      return 'This workflow has no external trigger binding yet — ask the agent to wire one.';
    case 'no-workflow':
      return 'Select a workflow to see its topology.';
  }
}
