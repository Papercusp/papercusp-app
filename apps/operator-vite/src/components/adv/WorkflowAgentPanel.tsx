/**
 * WorkflowAgentPanel — the agent half of the Workflows detail view.
 *
 * Plan: external-triggers-gmail-slack-2026-08-22 (P-024), governed by D-016.
 *
 * ── THE DIVISION OF AUTHORITY IS THE WHOLE POINT ────────────────────────────────────────
 * D-016: structural edits to a workflow are AGENT-MEDIATED — you describe the change and the
 * agent rewires it — while arm / disarm / test stay DIRECT operator controls. So this panel
 * has exactly two regions: a chat, and three buttons. Anything that would let the operator
 * restructure the workflow by hand belongs in neither.
 *
 * Arming is deliberately not something you ask the agent to do: it is the control that makes
 * a workflow start acting on the world, and the operator keeps their hand on it.
 *
 * ── THE CHAT IS THE EXISTING ONE, NOT A NEW ONE ─────────────────────────────────────────
 * It creates a harness-scoped agent-chat (POST /api/harness/:slug/agent-chats) and mounts the
 * standard <ChatPanel> — the same audited transcript + streaming send path the dock and the
 * Conversations tab use, reached the same way PlanChat reaches it. No parallel chat store, no
 * second send path: a bespoke transcript here would be a second surface to keep in sync with
 * the real one, and would miss its streaming/archive/cost handling.
 */

import { useEffect, useState } from 'react';
import ChatPanel from '@/app/harness/ChatPanel';
import type { WorkflowBindingInput, WorkflowGraphNode } from './workflow-graph-model';

const WORKFLOW_CONTEXT_MAX_CHARS = 3_500;

/**
 * The workflow chat reuses the canonical agent-chat transport, whose generic
 * row has no workflow foreign key. Carry the current read-model snapshot on
 * each message so the agent knows what the panel means by "this workflow".
 * The server labels this block untrusted and requires canonical re-reads before
 * mutation; this is orientation data, never an authority token.
 */
export function buildWorkflowAgentContext(input: {
  workflowLabel: string;
  harnessSlug: string | null;
  planSlug: string | null;
  binding: WorkflowBindingInput | null;
  selectedNode: WorkflowGraphNode | null;
}): string {
  const { binding, selectedNode } = input;
  const encoded = JSON.stringify({
    surface: 'workflows-detail',
    workflow: {
      label: input.workflowLabel,
      harness: input.harnessSlug,
      planSlug: input.planSlug,
    },
    binding: binding
      ? {
          id: binding.id,
          sourceKind: binding.sourceKind,
          eventPattern: binding.eventPattern,
          eventFilter: binding.eventFilter,
          action: binding.action,
          stormPolicy: binding.stormPolicy,
          armed: binding.armed,
        }
      : null,
    selectedNode: selectedNode
      ? {
          id: selectedNode.id,
          kind: selectedNode.kind,
          label: selectedNode.label,
          detail: selectedNode.detail,
        }
      : null,
  });
  return encoded.length <= WORKFLOW_CONTEXT_MAX_CHARS
    ? encoded
    : `${encoded.slice(0, WORKFLOW_CONTEXT_MAX_CHARS - 1)}…`;
}

export interface WorkflowAgentPanelProps {
  /** Harness the chat is scoped to — agent_chats are per-harness. */
  harnessSlug: string | null;
  /** Workflow display name, used as the chat's context title. */
  workflowLabel: string;
  /** Canonical plan slug even when the workflow has no external binding yet. */
  planSlug: string | null;
  /** Current binding read-model row; null means unwired or not yet loaded. */
  binding: WorkflowBindingInput | null;
  /** Whether the workflow's trigger is currently armed; null when unknown. */
  armed: boolean | null;
  /** The node the operator clicked in the topology pane, so the chat has visible context. */
  selectedNode: WorkflowGraphNode | null;
  /** Immediate acknowledgement for the last test queued from this panel. */
  lastTestRunId?: string | null;
  busy: 'arm' | 'test' | null;
  onToggleArm: () => void;
  onTest: () => void;
}

export default function WorkflowAgentPanel({
  harnessSlug,
  workflowLabel,
  planSlug,
  binding,
  armed,
  selectedNode,
  lastTestRunId = null,
  busy,
  onToggleArm,
  onTest,
}: WorkflowAgentPanelProps) {
  const [chatId, setChatId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workflowContext = buildWorkflowAgentContext({
    workflowLabel,
    harnessSlug,
    planSlug,
    binding,
    selectedNode,
  });

  // Create the chat once per (harness, workflow). Re-create when either changes, so opening
  // a different workflow does not continue the previous workflow's conversation.
  useEffect(() => {
    setChatId(null);
    setError(null);
    if (!harnessSlug) return;
    let cancelled = false;
    setCreating(true);
    fetch(`/api/harness/${encodeURIComponent(harnessSlug)}/agent-chats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'worker', title: `Workflow · ${workflowLabel}` }),
    })
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string; detail?: string };
          throw new Error(body.error ?? body.detail ?? `HTTP ${response.status}`);
        }
        return response.json() as Promise<{ id: string }>;
      })
      .then((chat) => {
        if (!cancelled) setChatId(chat.id);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setCreating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [harnessSlug, workflowLabel]);

  return (
    <section className="pc-workflow-agent" aria-label="Workflow agent">
      <header className="pc-workflow-agent__head">
        <h3 className="pc-workflow-agent__title">Workflow agent</h3>
        <p className="pc-workflow-agent__sub">builds and edits this workflow for you</p>
      </header>

      {selectedNode ? (
        <p className="pc-workflow-agent__context" data-testid="workflow-agent-context">
          Asking about <strong>{selectedNode.label}</strong>
          <span className="pc-workflow-agent__context-kind">{selectedNode.kind}</span>
        </p>
      ) : null}

      <div className="pc-workflow-agent__chat">
        {!harnessSlug ? (
          <p className="pc-workflow-agent__notice">
            This workflow has no harness, so it has no agent chat. Open it from a harness-scoped plan.
          </p>
        ) : error ? (
          <p className="pc-workflow-agent__notice pc-workflow-agent__notice--error" role="alert">
            Could not start the workflow agent: {error}
          </p>
        ) : creating || !chatId ? (
          <p className="pc-workflow-agent__notice">Starting the workflow agent…</p>
        ) : (
          <ChatPanel slug={harnessSlug} chatId={chatId} context={workflowContext} />
        )}
      </div>

      <footer className="pc-workflow-agent__controls">
        <div className="pc-workflow-agent__armrow">
          <span className="pc-workflow-agent__armstate" data-armed={armed === null ? 'unknown' : String(armed)}>
            {armed === null ? 'Arm state unknown' : armed ? 'Armed' : 'Installed but disarmed'}
          </span>
          <span className="pc-workflow-agent__spacer" />
          <button
            type="button"
            className="pc-workflow-agent__btn pc-workflow-agent__btn--primary"
            onClick={onToggleArm}
            disabled={armed === null || busy !== null}
          >
            {busy === 'arm' ? 'Working…' : armed ? 'Disarm workflow' : 'Arm workflow'}
          </button>
          <button
            type="button"
            className="pc-workflow-agent__btn"
            onClick={onTest}
            disabled={binding === null || busy !== null}
          >
            {busy === 'test' ? 'Testing…' : 'Test with last event'}
          </button>
        </div>
        {lastTestRunId ? (
          <p className="pc-workflow-agent__note" role="status">
            Test run {lastTestRunId.slice(0, 8)} queued from the last provider event. Activity will show its live outcome.
          </p>
        ) : null}
        <p className="pc-workflow-agent__note">Structural edits go through the agent · arm/disarm stays yours</p>
      </footer>
    </section>
  );
}
