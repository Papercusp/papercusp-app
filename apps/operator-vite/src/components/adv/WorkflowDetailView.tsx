/**
 * WorkflowDetailView — the Workflows detail surface: read-only topology + workflow agent.
 *
 * Plan: external-triggers-gmail-slack-2026-08-22 (P-024), governed by D-013 as amended by
 * D-016. Layout per /tmp/workflows-builder/Editor.dc.html.
 *
 * Composition only: the graph pane derives its own nodes from the pure model, the agent panel
 * owns the chat, and this component owns the header, the selection URL state, and the wiring
 * between the two. Keeping it thin is what lets the Workflows tab mount the whole detail view
 * in one line rather than growing another few hundred lines.
 *
 * ── SELECTION LIVES IN THE URL, AND THAT IS NOT A STYLE CHOICE ──────────────────────────
 * `wfNode` is a nuqs param because the agent control surface (ui:get_state / ui:dispatch)
 * reads the URL. A selected node held in useState would be invisible to agents — which would
 * be a particularly bad joke in the one view whose entire premise is that an agent edits the
 * workflow with you.
 */

import { useCallback, useMemo } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import WorkflowAgentPanel from './WorkflowAgentPanel';
import WorkflowGraphPane from './WorkflowGraphPane';
import { buildWorkflowGraph, type WorkflowBindingInput } from './workflow-graph-model';
import type { AutomationOperationTarget } from "./workflows-model";
import './adv-workflow-detail.css';

export interface WorkflowDetailViewProps {
  /** Display name of the workflow being inspected. */
  workflowLabel: string;
  /** Canonical plan identity; remains available when no binding exists yet. */
  planSlug: string | null;
  /** Harness the workflow's plan belongs to; null when it has none. */
  harnessSlug: string | null;
  /** The binding that wires this workflow, or null when it has none. */
  binding: WorkflowBindingInput | null;
  /** False while the trigger snapshot is still loading — keeps "pending" out of "unwired". */
  bindingLoaded: boolean;
  /** From plans:get-output-schema (P-026); null when not read. */
  planChainable?: boolean | null;
  /** Latest canonical item/plan target reached by an operation binding. */
  operationTarget?: AutomationOperationTarget | null;
  /** Human relative time of the last run, e.g. "last fired 09:30"; null when never fired. */
  lastFiredLabel?: string | null;
  /** The test execution just queued from this surface, before the refreshed activity feed catches up. */
  lastTestRunId?: string | null;
  busy: "arm" | "test" | null;
  onBack: () => void;
  onToggleArm: () => void;
  onTest: () => void;
}

export default function WorkflowDetailView({
  workflowLabel,
  planSlug,
  harnessSlug,
  binding,
  bindingLoaded,
  planChainable = null,
  operationTarget = null,
  lastFiredLabel = null,
  lastTestRunId = null,
  busy,
  onBack,
  onToggleArm,
  onTest,
}: WorkflowDetailViewProps) {
  const [selectedNodeId, setSelectedNodeId] = useQueryState(
    "wfNode",
    parseAsString,
  );

  const graph = useMemo(
    () =>
      buildWorkflowGraph({
        workflowLabel,
        binding,
        loaded: bindingLoaded,
        planChainable,
        operationTarget,
      }),
    [workflowLabel, binding, bindingLoaded, operationTarget, planChainable],
  );

  const selectedNode = useMemo(
    () => graph.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [graph.nodes, selectedNodeId],
  );

  const handleSelectNode = useCallback(
    (nodeId: string | null) => {
      void setSelectedNodeId(nodeId);
    },
    [setSelectedNodeId],
  );

  const armed = binding ? binding.armed : null;

  return (
    <div className="pc-workflow-detail">
      <header className="pc-workflow-detail__head">
        <button
          type="button"
          className="pc-workflow-detail__back"
          onClick={onBack}
        >
          ← Workflows
        </button>
        <div className="pc-workflow-detail__ident">
          <h2 className="pc-workflow-detail__title">{workflowLabel}</h2>
          <div className="pc-workflow-detail__meta">
            <span
              className="pc-workflow-detail__badge"
              data-armed={armed === null ? "unknown" : String(armed)}
            >
              {armed === null ? "Unwired" : armed ? "Armed" : "Disarmed"}
            </span>
            {lastFiredLabel ? (
              <span className="pc-workflow-detail__lastfired">
                {lastFiredLabel}
              </span>
            ) : null}
          </div>
        </div>
      </header>

      <div className="pc-workflow-detail__body">
        <WorkflowGraphPane
          graph={graph}
          selectedNodeId={selectedNodeId}
          onSelectNode={handleSelectNode}
        />
        <WorkflowAgentPanel
          harnessSlug={harnessSlug}
          workflowLabel={workflowLabel}
          planSlug={planSlug}
          binding={binding}
          armed={armed}
          selectedNode={selectedNode}
          lastTestRunId={lastTestRunId}
          busy={busy}
          onToggleArm={onToggleArm}
          onTest={onTest}
        />
      </div>
    </div>
  );
}
