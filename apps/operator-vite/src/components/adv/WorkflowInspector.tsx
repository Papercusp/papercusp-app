/**
 * WorkflowInspector — the one frame's persistent detail pane.
 *
 * Plan: workflows-tab-one-frame-2026-08-28 (P-003), governed by D-002.
 *
 * This is THE detail surface for a workflow. The full topology + agent chat destination
 * (`WorkflowDetailView`, reached by `?wfId=`) is its EXPANSION, not a second, parallel
 * detail view — that duplication is what D-002 removes.
 *
 * ── WHAT THE INSPECTOR MAY ASSERT ───────────────────────────────────────────────────────
 * The ledger deliberately shows a spend CLASSIFICATION rather than dollars (D-005), because
 * per-workflow cost is only measured for the workflow being inspected. THIS pane is where
 * that measurement exists — `plans.runHistory` is fetched for the selected plan — so it is
 * the one place a dollar figure is honest. When the rollup is absent it says so rather than
 * rendering $0.00.
 *
 * Direct controls stay exactly the three D-016 allows — arm/disarm, test, run — plus the
 * plan-level pause. Structural edits go through the agent, which is what the ask entry opens.
 */

import type { PlanInputSchemaInfo } from '@/app/admin/plans/plans-api';
import { Workflow } from 'lucide-react';
import type { AutomationItem, AutomationTrigger } from './workflows-model';
import { relativeTime } from './workflows-model';
import type { LedgerRow } from './workflows-ledger-model';
import { buildWorkflowGraph, type WorkflowBindingInput } from './workflow-graph-model';

export interface RunRow {
  id: number;
  status: string;
  trigger: string | null;
  outcome: string | null;
  launchedAt: number;
  durationMs: number | null;
  costUsd: number;
}

export interface RunHistoryRow {
  runs: RunRow[];
  rollup: {
    total: number;
    successRate: number;
    totalCostUsd: number;
    medianDurationMs: number | null;
    running: number;
    failed: number;
  } | null;
}

export function durationLabel(ms: number | null): string {
  if (ms == null) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

/** A run the producers actually marked as failed — not merely "not successful yet". */
function isFailedRun(run: RunRow | undefined): boolean {
  if (!run) return false;
  const outcome = (run.outcome ?? run.status).toLocaleLowerCase();
  return outcome.includes('fail') || outcome.includes('error');
}

export interface WorkflowInspectorProps {
  item: AutomationItem | null;
  row: LedgerRow | null;
  inputs: PlanInputSchemaInfo | null;
  runs: RunHistoryRow | null;
  binding: WorkflowBindingInput | null;
  /** False while the trigger snapshot is still loading — keeps "pending" out of "unwired". */
  bindingLoaded: boolean;
  /** The frame's core inventory is still loading; absence must not read as no selection. */
  loading: boolean;
  /** Why a loaded frame has no row to inspect. */
  emptyReason: 'filtered' | 'selection';
  busy: string | null;
  nowMs?: number;
  onRun: () => void;
  onToggleSchedule: (armed: boolean) => void;
  onToggleBinding: (bindingId: string, armed: boolean) => void;
  onToggleRoutine: () => void;
  onPauseAll: () => void;
  onEditSchedule: () => void;
  onExpand: () => void;
  onAsk: () => void;
}

export default function WorkflowInspector({
  item,
  row,
  inputs,
  runs,
  binding,
  bindingLoaded,
  loading,
  emptyReason,
  busy,
  nowMs,
  onRun,
  onToggleSchedule,
  onToggleBinding,
  onToggleRoutine,
  onPauseAll,
  onEditSchedule,
  onExpand,
  onAsk,
}: WorkflowInspectorProps) {
  if (loading) {
    return (
      <aside className="pc-wf__panel pc-wf__insp" aria-label="Workflow inspector" aria-busy="true">
        <div className="pc-wf__loading pc-wf__loading--inspector" role="status" aria-label="Loading workflow details">
          <div className="pc-wf__loading-copy">
            <strong>Preparing the inspector</strong>
            <span>Waiting for a workflow selection and its latest run details…</span>
          </div>
          <div className="pc-wf__loading-inspector" aria-hidden>
            <i className="pc-wf__skeleton pc-wf__skeleton--heading" />
            <i className="pc-wf__skeleton pc-wf__skeleton--line" />
            <i className="pc-wf__skeleton pc-wf__skeleton--block" />
            <i className="pc-wf__skeleton pc-wf__skeleton--block" />
          </div>
        </div>
      </aside>
    );
  }

  if (!item || !row) {
    const filtered = emptyReason === 'filtered';
    return (
      <aside className="pc-wf__panel pc-wf__insp pc-wf__insp--empty" aria-label="Workflow inspector">
        <div className="pc-wf__empty-state pc-wf__empty-state--inspector" role="status">
          <span className="pc-wf__empty-icon" aria-hidden><Workflow size={19} /></span>
          <div>
            <strong>{filtered ? 'No workflow in this view' : 'Choose a workflow'}</strong>
            <p>{filtered ? 'Adjust the filters to bring a workflow back into view.' : 'Select a row to see triggers, topology, controls, and recent runs.'}</p>
          </div>
        </div>
      </aside>
    );
  }

  const graph = buildWorkflowGraph({
    workflowLabel: item.label,
    binding,
    loaded: bindingLoaded,
    planChainable: null,
    operationTarget: item.operation?.target ?? null,
  });
  const runRows = runs?.runs.slice(0, 5) ?? [];
  const lastRun = runs?.runs[0];
  const inputsIncomplete = inputs != null && inputs.ready === false;
  const failed = isFailedRun(lastRun);
  const automaticArmed = item.triggers.filter((trigger) => trigger.armed === true);

  return (
    <aside className="pc-wf__panel pc-wf__insp" aria-label="Workflow inspector">
      <div className="pc-wf__insp-sec">
        <div className="pc-wf__insp-ident">
          <h2 className="pc-wf__insp-title">{item.label}</h2>
          <button
            type="button"
            className="pc-wf__btn pc-wf__btn--ghost"
            onClick={onExpand}
            aria-label={`Expand ${item.label} into the topology and agent view`}
          >
            <span className="pc-wf__btn-inner">Expand</span>
          </button>
        </div>
        <p className="pc-wf__insp-desc">{item.description}</p>
        <div className="pc-wf__insp-state">
          <span className="pc-wf__pill" data-state={row.state}>{stateWord(row)}</span>
          {row.armed !== null ? (
            <span className="pc-wf__pill" data-armed={String(row.armed)}>
              {row.triggerCount > 1 ? `${row.armedCount}/${row.triggerCount} armed` : row.armed ? 'Armed' : 'Disarmed'}
            </span>
          ) : null}
          <span className="pc-wf__insp-meta">
            {row.lastLabel ? `last fired ${row.lastLabel}` : 'never fired'}
          </span>
        </div>
      </div>

      <div className="pc-wf__insp-sec">
        <div className="pc-wf__insp-actions">
          {item.planSlug ? (
            <button
              type="button"
              className="pc-wf__btn pc-wf__btn--primary"
              disabled={busy != null || inputs?.ready === false}
              onClick={onRun}
            >
              <span className="pc-wf__btn-inner">Run manually</span>
            </button>
          ) : null}
          {item.planSlug ? (
            <button type="button" className="pc-wf__btn" disabled={busy != null} onClick={onEditSchedule}>
              <span className="pc-wf__btn-inner">Edit schedule</span>
            </button>
          ) : null}
          {item.routine?.controllable ? (
            <button type="button" className="pc-wf__btn" disabled={busy != null} onClick={onToggleRoutine}>
              <span className="pc-wf__btn-inner">{item.routine.active ? 'Pause' : 'Resume'}</span>
            </button>
          ) : null}
          {automaticArmed.length > 0 ? (
            <button type="button" className="pc-wf__btn pc-wf__btn--warn" disabled={busy != null} onClick={onPauseAll}>
              <span className="pc-wf__btn-inner">Pause automatic triggers</span>
            </button>
          ) : null}
        </div>
      </div>

      <div className="pc-wf__insp-sec">
        <h3 className="pc-wf__insp-h">Topology</h3>
        {graph.nodes.length > 0 ? (
          <ol className="pc-wf__topo">
            {graph.nodes.map((node) => (
              <li key={node.id} className={`pc-wf__topo-node pc-wf-kind--${node.kind}`} data-state={node.state}>
                <strong className="pc-wf__topo-label">{node.label}</strong>
                <span className="pc-wf__topo-kind">{node.kind}</span>
              </li>
            ))}
          </ol>
        ) : (
          // No binding means no derived topology — fall back to the row's own chain rather
          // than an empty box, which would read as "this workflow does nothing".
          <p className="pc-wf__chain-text">
            {row.chain.trigger} → {row.chain.plan}{row.chain.outcome ? ` → ${row.chain.outcome}` : ''}
          </p>
        )}
      </div>

      {(failed || inputsIncomplete) && (
        <div className="pc-wf__insp-sec">
          <h3 className="pc-wf__insp-h">
            {failed ? `Last run · failed ${lastRun ? relativeTime(lastRun.launchedAt, nowMs) : ''}` : 'Blocked before it can run'}
          </h3>
          <div className="pc-wf__fail">
            <p className="pc-wf__fail-copy">
              {inputsIncomplete
                ? `Plan inputs are incomplete — ${inputs.missing.join(', ')} ${inputs.missing.length === 1 ? 'is' : 'are'} required and not supplied, so a run stops before the plan starts.`
                : 'The last run failed. Open it with the agent to see the step that stopped and why.'}
            </p>
            <div className="pc-wf__insp-actions">
              <button type="button" className="pc-wf__btn pc-wf__btn--tint" onClick={onAsk}>
                <span className="pc-wf__btn-inner">Fix with the agent</span>
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="pc-wf__insp-sec">
        <h3 className="pc-wf__insp-h">Triggers</h3>
        {item.triggers.length === 0 ? (
          <p className="pc-wf__chain-text">No automatic trigger is installed.</p>
        ) : (
          <ul className="pc-wf__trigs">
            {item.triggers.map((trigger) => (
              <li key={trigger.id} className="pc-wf__trig">
                <span className="pc-wf__trig-body">
                  <strong className="pc-wf__trig-label">{trigger.label}</strong>
                  <small className="pc-wf__trig-detail">{trigger.provider} · {trigger.detail}</small>
                </span>
                <TriggerArm
                  trigger={trigger}
                  busy={busy != null}
                  onToggle={() => {
                    if (trigger.kind === 'schedule') onToggleSchedule(trigger.armed !== true);
                    else if (trigger.bindingId) onToggleBinding(trigger.bindingId, trigger.armed !== true);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="pc-wf__insp-sec pc-wf__insp-sec--grow">
        <div className="pc-wf__insp-head">
          <h3 className="pc-wf__insp-h">Recent runs</h3>
          <span className="pc-wf__insp-meta">{spendSummary(item, runs)}</span>
        </div>
        {runRows.length === 0 ? (
          <p className="pc-wf__chain-text">
            {item.planSlug ? 'No plan-run history yet.' : 'Run history is recorded for triggered plans only.'}
          </p>
        ) : (
          <ul className="pc-wf__runs">
            {runRows.map((run) => (
              <li key={run.id} className="pc-wf__run">
                <i className="pc-wf__dot" data-state={isFailedRun(run) ? 'attention' : run.status === 'running' ? 'running' : 'ready'} aria-hidden />
                <span className="pc-wf__run-when">{relativeTime(run.launchedAt, nowMs)}</span>
                <span className="pc-wf__run-what">{run.outcome ?? run.status} · {durationLabel(run.durationMs)}</span>
                <span className="pc-wf__run-cost">{run.costUsd > 0 ? `$${run.costUsd.toFixed(2)}` : '—'}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="pc-wf__insp-ask">
        <button type="button" className="pc-wf__btn pc-wf__btn--tint pc-wf__btn--wide" onClick={onAsk}>
          <span className="pc-wf__btn-inner">Ask the agent about this workflow</span>
        </button>
      </div>
    </aside>
  );
}

/**
 * The verified-dollars line.
 *
 * Only ever rendered from `plans.runHistory`'s own rollup. Without one, this says what is
 * true — that no run cost has been recorded — rather than formatting an absent number as
 * $0.00, which reads as "this is free".
 */
function spendSummary(item: AutomationItem, runs: RunHistoryRow | null): string {
  if (runs?.rollup) {
    const { totalCostUsd, total } = runs.rollup;
    return `$${totalCostUsd.toFixed(2)} · ${total} ${total === 1 ? 'run' : 'runs'}`;
  }
  if (item.kind === 'triggered-plan') return 'No verified run cost';
  return item.spendLabel;
}

function stateWord(row: LedgerRow): string {
  if (row.state === 'attention') return 'Needs attention';
  if (row.state === 'running') return 'Running';
  if (row.state === 'paused') return 'Paused';
  return 'Ready';
}

/**
 * One trigger's arm control.
 *
 * `armed === null` is unknown, not off: the producers could not report a state, so the
 * control is disabled rather than offering a toggle whose result nobody can predict. An
 * external trigger with no binding id likewise cannot be toggled through the audited route.
 */
function TriggerArm({
  trigger,
  busy,
  onToggle,
}: {
  trigger: AutomationTrigger;
  busy: boolean;
  onToggle: () => void;
}) {
  const unknown = trigger.armed == null;
  const unroutable = trigger.kind === 'external' && !trigger.bindingId;
  return (
    <button
      type="button"
      className="pc-wf__arm"
      data-armed={unknown ? 'unknown' : String(trigger.armed)}
      disabled={busy || unknown || unroutable}
      aria-pressed={unknown ? undefined : trigger.armed === true}
      aria-label={`${trigger.armed === true ? 'Disarm' : 'Arm'} ${trigger.label}`}
      onClick={onToggle}
    >
      <span className="pc-wf__btn-inner">
        <i className="pc-wf__switch" data-armed={unknown ? 'unknown' : String(trigger.armed)} aria-hidden />
        <span className="pc-wf__armed-label">{unknown ? 'Unknown' : trigger.armed ? 'Armed' : 'Paused'}</span>
      </span>
    </button>
  );
}
