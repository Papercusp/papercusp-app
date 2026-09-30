'use client';

/**
 * GoalComposer — the product's only path to STARTING a goal
 * (goals-tab-improvement-2026-08-09 P-015, D-008).
 *
 * D-008 [owner pick]: "+ Start a goal" IS the spawn. Submitting this form does
 * not draft a message for an agent to consider — it calls `goals:start`, which
 * writes the goal, stamps the GOAL-mode marker, and launches the agent that
 * owns it, atomically. This deliberately overrides goal-mode-2026-08-07 P-022's
 * conversational kickoff (a prompt template seeded into the chat composer),
 * which the rail deletion took with it.
 *
 * ONE REQUIRED FIELD: the outcome. Kill criterion and ceiling are OPTIONAL
 * [owner 2026-08-09, interactive]: "when creating a new goal the 'kill this if'
 * and 'ceiling' should not be required properties". An earlier version of this
 * form made both mandatory — see goal-composer-model.ts's header for why that
 * was reversed and what the client/server now agree on.
 *
 * They are still ASKED, and still first, because a goal that carries them is a
 * better goal. The change is that an owner who has not decided yet can start
 * anyway instead of being blocked at the door. Blank means "not declared" and
 * is carried as an ABSENT field, never as $0 or "".
 *
 * The agent-proposes-a-goal flow (`goals:propose` → GoalProposalCard) is a
 * SEPARATE, still-live path and is not replaced by this.
 */
import { useEffect, useState } from 'react';
import { Modal } from '@/app/harness/Modal';
import './hud.css';
import {
  postGoalStart,
  validateGoalDraft,
  type GoalComposerDraft,
} from './goal-composer-model';

const EMPTY: GoalComposerDraft = { title: '', killCriterion: '', ceiling: '', body: '' };

export default function GoalComposer({
  open,
  workspaceId,
  harnessSlug,
  onClose,
  onStarted,
}: {
  open: boolean;
  /** The REAL workspace id — same non-null discipline as GoalDetailPanel: an
   *  absent workspace would file the goal against the 'default' tenant. */
  workspaceId: string;
  /**
   * The harness the goal is filed against — NULLABLE on purpose, and handled
   * rather than defaulted.
   *
   * `useResolvedHarnessSlug()` genuinely returns null (a deep link with no
   * `slug`, a fresh profile with no localStorage), and a goal is filed against
   * an `install_slug`. Substituting a fallback would file it — and spawn its
   * agent — against a harness the owner never chose, which is the WI-5125
   * shape: a healthy-looking success pointed at the wrong place. So a null
   * harness renders as a refusal with the fix, not as a form that misfiles.
   */
  harnessSlug: string | null;
  onClose: () => void;
  /**
   * Called once the agent is actually running, with the new goal id AND the
   * ownerId of the agent that was spawned for it.
   *
   * EI-20049126246088530: the SECOND argument is load-bearing, not decoration.
   * `goals:start` already returns the new agent's ownerId (start.ts:353
   * `agent_owner_id`, parsed into `GoalStartResult.agentOwnerId`), and dropping
   * it here is what left a goal's agent showing "No recent Claude session found
   * for this agent" for its whole boot window: the caller could not seed
   * `pendingLaunch`, so SessionChatModal's `launchedByThisView` was always
   * false. Null when the response omitted it — callers must handle that.
   */
  onStarted: (goalId: string, agentOwnerId: string | null) => void;
}) {
  const [draft, setDraft] = useState<GoalComposerDraft>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof GoalComposerDraft, string>>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Reopening starts clean. A half-typed goal surviving a close reads as a
  // draft the surface has no way to save, and the previous attempt's error
  // banner would sit above an unrelated new attempt.
  useEffect(() => {
    if (!open) {
      setDraft(EMPTY);
      setErrors({});
      setFailure(null);
      setBusy(false);
    }
  }, [open]);

  const submit = async () => {
    if (busy || !harnessSlug) return;
    setFailure(null);
    const validated = validateGoalDraft(draft);
    if (!validated.ok) {
      setErrors(validated.errors);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const res = await postGoalStart(validated.args, { workspaceId, harnessSlug });
      if (res.ok) {
        onStarted(res.goalId, res.agentOwnerId);
        onClose();
      } else {
        setFailure(res.error);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Start a goal"
      description="An agent takes this on and owns it end to end."
      contentClassName="hud-goal-composer"
    >
      {!harnessSlug ? (
        <p className="hud-goal-composer__failure" role="alert" data-testid="goal-composer-no-harness">
          Pick a harness first — a goal is filed against one, and its agent is
          bootstrapped into it. Nothing was started.
        </p>
      ) : (
      <form
        className="hud-goal-composer__form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="hud-goal-composer__field">
          <span className="hud-goal-composer__label">Outcome</span>
          <input
            className="hud-goal-composer__input"
            data-testid="goal-composer-title"
            autoFocus
            value={draft.title}
            placeholder="Ship a paid app"
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
          />
          {errors.title ? <span className="hud-goal-composer__err">{errors.title}</span> : null}
        </label>

        <label className="hud-goal-composer__field">
          <span className="hud-goal-composer__label">Kill this if (optional)</span>
          <input
            className="hud-goal-composer__input"
            data-testid="goal-composer-kill"
            value={draft.killCriterion}
            placeholder="no paying user by day 30"
            onChange={(e) => setDraft((d) => ({ ...d, killCriterion: e.target.value }))}
          />
          {errors.killCriterion ? (
            <span className="hud-goal-composer__err">{errors.killCriterion}</span>
          ) : null}
        </label>

        <label className="hud-goal-composer__field">
          <span className="hud-goal-composer__label">Ceiling (USD, optional)</span>
          <input
            className="hud-goal-composer__input"
            data-testid="goal-composer-ceiling"
            inputMode="decimal"
            value={draft.ceiling}
            placeholder="500"
            onChange={(e) => setDraft((d) => ({ ...d, ceiling: e.target.value }))}
          />
          {errors.ceiling ? <span className="hud-goal-composer__err">{errors.ceiling}</span> : null}
        </label>

        <label className="hud-goal-composer__field">
          <span className="hud-goal-composer__label">Detail (optional)</span>
          <textarea
            className="hud-goal-composer__input hud-goal-composer__input--area"
            data-testid="goal-composer-body"
            rows={3}
            value={draft.body ?? ''}
            placeholder="What winning looks like, scope, constraints…"
            onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
          />
        </label>

        {failure ? (
          <p className="hud-goal-composer__failure" role="alert" data-testid="goal-composer-failure">
            {failure}
          </p>
        ) : null}

        <div className="hud-goal-composer__actions">
          <button type="button" className="hud-goal-composer__btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className="hud-goal-composer__btn hud-goal-composer__btn--primary"
            data-testid="goal-composer-submit"
            disabled={busy}
          >
            {/* Names the real consequence. "Create" would understate it: this
                spawns an autonomous agent against a declared budget. */}
            {busy ? 'Starting the agent…' : 'Start goal + agent'}
          </button>
        </div>
      </form>
      )}
    </Modal>
  );
}
