/**
 * "This goal ends when" — the section, now with its two values EDITABLE where
 * they are read (goals-tab-improvement-2026-08-09 P-009).
 *
 * WHY THE EDIT LIVES HERE AND NOT IN THE SETTINGS PANE BELOW. The panel's
 * loudest line is this section's own alarm — "No kill criterion was set —
 * nothing can stop this goal" — and until now it attached no remedy: the owner
 * read the alarm and had nowhere to go, while the fix sat behind asking an
 * agent to call `goals:update`. The item's fix is that the warning BECOMES the
 * control that resolves it, so the control is rendered directly beneath the
 * sentence that raises it rather than in the launch-settings section further
 * down (which owns a different question — how much this goal may SPAWN, not
 * when it STOPS).
 *
 * WHY THIS IS A SEPARATE FILE. GoalDetailPanel is past 60KB and the section it
 * used to render inline was a static block; adding two editors to it in place
 * would have grown the panel by a third of a screen of state handling for a
 * region that is now self-contained. The panel keeps computing the display
 * lines (it renders `criterion` and `ceiling` a SECOND time in the vitals band
 * above, so those memos cannot move here) and passes them down, and the
 * tripwire list arrives as a slot so P-012's `TripwireRow` stays where it is.
 *
 * WHY BOTH EDITORS SHARE ONE OPEN-STATE. A single nuqs param rather than two
 * booleans: they are alternatives, not independent toggles, and one param
 * cannot represent the state where both are open over the same section — which
 * would put two Save buttons and two error slots on top of each other.
 *
 * ⚠ THIS EDITOR SETS AND REVISES; IT NEVER CLEARS. Both halves refuse a blank,
 * for two DIFFERENT reasons that are worth keeping straight — a judgement for
 * the criterion (a control sitting under an alarm about absence should not be
 * the way to create that absence) and a measured constraint for the ceiling
 * (`goals:update` has no way to unset one). `goal-ends-edit-model.ts` carries
 * both in full.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryState, parseAsStringEnum } from 'nuqs';
import { toast } from 'sonner';
import { Tooltip } from '@/app/harness/Tooltip';
import type { burnLine, ceilingLine, killCriterionLine } from './goal-detail-model';
import {
  ceilingDirty,
  ceilingToInput,
  criterionDirty,
  criterionSubmitProblem,
  parseCeilingInput,
} from './goal-ends-edit-model';

const EDITORS = ['criterion', 'ceiling'] as const;
type EndsEditor = (typeof EDITORS)[number];

export interface GoalEndsSectionProps {
  goalId: string | null;
  /** The stored criterion — the EDIT seed, distinct from `criterion.text`, which is the alarm prose when none is set. */
  killCriterion: string | null | undefined;
  budgetCents: number | null | undefined;
  criterion: ReturnType<typeof killCriterionLine>;
  ceiling: ReturnType<typeof ceilingLine>;
  burn: ReturnType<typeof burnLine>;
  spendLabel?: string | null;
  spendNote?: string | null;
  /** The tripwire bars, rendered by the panel (P-012's row component lives there). */
  tripwires?: ReactNode;
}

/** The tool result as the admin proxy hands it back — `degraded` rides beside `data`. */
interface GoalUpdateReply {
  data?: unknown;
  degraded?: boolean;
  degradedReasons?: string[];
  error?: { code?: string; message?: string };
}

/**
 * Write one field through the admin proxy.
 *
 * Deliberately the SAME door the status control and the settings pane use:
 * `goals:update` merges partial fields, so saving a criterion cannot clear a
 * ceiling (or the reverse), and the route invalidates `goals.list` +
 * `goals.detail` on any write verb — which is why nothing here re-fetches by
 * hand or holds an optimistic copy of what it just wrote.
 */
async function writeGoalField(
  goalId: string,
  patch: Record<string, unknown>,
): Promise<GoalUpdateReply> {
  const res = await fetch('/api/admin/goals/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: goalId, ...patch }),
  });
  // A refusal still carries our JSON body; read it rather than throwing the reason away.
  let body: GoalUpdateReply;
  try {
    body = (await res.json()) as GoalUpdateReply;
  } catch {
    throw new Error(`HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  return body;
}

export default function GoalEndsSection({
  goalId,
  killCriterion,
  budgetCents,
  criterion,
  ceiling,
  burn,
  spendLabel,
  spendNote,
  tripwires,
}: GoalEndsSectionProps) {
  const [open, setOpen] = useQueryState('goalEnds', parseAsStringEnum([...EDITORS]));
  const [criterionDraft, setCriterionDraft] = useState('');
  const [ceilingDraft, setCeilingDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Seed the draft on the OPEN TRANSITION only.
   *
   * Keyed on a ref rather than on the stored values, because this panel
   * re-reads whenever anything invalidates `goals.detail` — including this
   * component's own successful write. An effect that re-seeded on every value
   * change would wipe whatever the owner had typed the moment a peer's update
   * landed, which is exactly when they most need to see their own text.
   */
  const seededFor = useRef<EndsEditor | null>(null);
  useEffect(() => {
    const which = (open as EndsEditor | null) ?? null;
    if (which === seededFor.current) return;
    seededFor.current = which;
    setProblem(null);
    if (which === 'criterion') setCriterionDraft(killCriterion?.trim() ?? '');
    else if (which === 'ceiling') setCeilingDraft(ceilingToInput(budgetCents));
  }, [open, killCriterion, budgetCents]);

  const close = useCallback(() => {
    void setOpen(null);
    setProblem(null);
  }, [setOpen]);

  const save = useCallback(
    async (which: EndsEditor) => {
      if (busy || !goalId) return;

      /* Validate BEFORE the round-trip so the refusal is instant, using the
         SAME rule the server applies — the point is a faster identical answer,
         never a different one. The server still gets the last word below. */
      let patch: Record<string, unknown>;
      let label: string;
      if (which === 'criterion') {
        const p = criterionSubmitProblem(criterionDraft);
        if (p) {
          setProblem(p);
          return;
        }
        patch = { killCriterion: criterionDraft.trim() };
        label = 'Kill criterion saved';
      } else {
        const parsed = parseCeilingInput(ceilingDraft);
        /* `=== undefined`, NOT a falsy check: `null` is the blank-clears write
           (EI-20072247655456262) and `0` is a real ceiling, so both must pass
           this gate. Only an absent `cents` — which `goals:update` would read
           as "leave unchanged" — is the refusal. */
        if (parsed.problem || parsed.cents === undefined) {
          setProblem(parsed.problem ?? 'that is not a dollar amount');
          return;
        }
        patch = { budgetCents: parsed.cents };
        label = parsed.cents === null ? 'Ceiling removed' : 'Ceiling saved';
      }

      setBusy(true);
      try {
        const reply = await writeGoalField(goalId, patch);

        /* ⚠ 200 IS NOT SUCCESS ON ITS OWN. `goals:update` reports a refused
           criterion as `degraded: true` with the reason rather than as an HTTP
           error — that is how the shared rule reaches this door. Flattening it
           to "saved" would render the alarm as fixed while the row still has no
           criterion, so a degraded reply keeps the editor OPEN with the reason
           under the field. */
        if (reply.degraded) {
          const reason = reply.degradedReasons?.join(' · ') || 'the write reported itself degraded';
          setProblem(reason);
          toast.warning('Saved — but not completely', { description: reason, duration: Infinity });
          return;
        }

        toast.success(label);
        void setOpen(null);
        setProblem(null);
      } catch (e) {
        // Nothing to roll back — no local copy of the value was ever moved.
        setProblem(String(e));
        toast.error(which === 'criterion' ? 'Could not save the criterion' : 'Could not save the ceiling', {
          description: String(e),
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, ceilingDraft, criterionDraft, goalId, setOpen],
  );

  const editing = (open as EndsEditor | null) ?? null;
  const canEdit = Boolean(goalId);

  return (
    <section className="hud-goal__section hud-goal__section--ends" data-testid="goal-ends-section">
      <h3 className="pc-zone-title">This goal ends when</h3>

      {editing === 'criterion' ? (
        <form
          className="hud-goal__set"
          data-testid="goal-criterion-editor"
          onSubmit={(e) => {
            e.preventDefault();
            void save('criterion');
          }}
        >
          <label className="hud-goal__set-field" htmlFor={`ge-${goalId}-criterion`}>
            <span className="hud-goal__set-label">Kill criterion</span>
            <textarea
              id={`ge-${goalId}-criterion`}
              className="hud-goal__set-in"
              rows={3}
              autoFocus
              disabled={busy}
              value={criterionDraft}
              onChange={(e) => setCriterionDraft(e.target.value)}
              data-testid="goal-criterion-input"
            />
          </label>
          <p className="hud-goal__note">
            The condition under which this goal is abandoned — concrete enough that the agent can
            tell whether it has been met. This sets or revises the criterion; it does not remove one.
          </p>
          {problem ? (
            <p className="hud-goal__set-alarm" data-testid="goal-criterion-problem">
              {problem}
            </p>
          ) : null}
          <div className="hud-goal__set-actions">
            <button
              type="submit"
              className="hud-goal__addsub-go"
              disabled={busy || !criterionDirty(killCriterion, criterionDraft)}
              data-testid="goal-criterion-save"
            >
              {busy ? 'Saving…' : 'Save criterion'}
            </button>
            <button
              type="button"
              className="hud-goal__set-remove"
              disabled={busy}
              onClick={close}
              data-testid="goal-criterion-cancel"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <p
            className={`hud-goal__criterion${criterion.missing ? ' hud-goal__criterion--missing' : ''}`}
            data-testid="goal-kill-criterion"
          >
            {criterion.text}
          </p>
          {/* The remedy, adjacent to the alarm that asks for it. Prominent when
              the criterion is MISSING — that state is the whole reason this
              control exists — and quiet when one is merely being revised. */}
          {canEdit ? (
            <button
              type="button"
              className={criterion.missing ? 'hud-goal__addsub-go' : 'hud-goal__set-toggle'}
              onClick={() => void setOpen('criterion')}
              data-testid="goal-criterion-edit"
            >
              {criterion.missing ? 'Set a kill criterion' : 'Edit criterion'}
            </button>
          ) : null}
        </>
      )}

      {/* Bars are OPTIONAL. A free-text criterion with none is the normal case
          and renders as prose alone — no empty chart, no "0 tripwires"
          placeholder implying something is missing. */}
      {tripwires}

      {editing === 'ceiling' ? (
        <form
          className="hud-goal__set"
          data-testid="goal-ceiling-editor"
          onSubmit={(e) => {
            e.preventDefault();
            void save('ceiling');
          }}
        >
          <label className="hud-goal__set-field" htmlFor={`ge-${goalId}-ceiling`}>
            <span className="hud-goal__set-label">Spend ceiling (USD)</span>
            <input
              id={`ge-${goalId}-ceiling`}
              className="hud-goal__set-in"
              inputMode="decimal"
              autoFocus
              disabled={busy}
              value={ceilingDraft}
              onChange={(e) => setCeilingDraft(e.target.value)}
              data-testid="goal-ceiling-input"
            />
          </label>
          <p className="hud-goal__note">
            The declared ceiling this goal&apos;s spend is measured against. Leave it blank to
            remove the ceiling entirely; removing it clears its window too.
          </p>
          {problem ? (
            <p className="hud-goal__set-alarm" data-testid="goal-ceiling-problem">
              {problem}
            </p>
          ) : null}
          <div className="hud-goal__set-actions">
            <button
              type="submit"
              className="hud-goal__addsub-go"
              disabled={busy || !ceilingDirty(budgetCents, ceilingDraft)}
              data-testid="goal-ceiling-save"
            >
              {busy
                ? 'Saving…'
                : /* Names the write it will actually make: a blank draft over a
                     stored ceiling REMOVES it, and a button that still said
                     "Save ceiling" would read as the opposite of what happens. */
                  ceilingDraft.trim() === '' && budgetCents != null
                  ? 'Remove ceiling'
                  : 'Save ceiling'}
            </button>
            <button
              type="button"
              className="hud-goal__set-remove"
              disabled={busy}
              onClick={close}
              data-testid="goal-ceiling-cancel"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="hud-goal__ceiling" title={spendNote ?? undefined}>
          <span className="hud-goal__ceiling-label">{spendLabel ?? 'fleet spend'}</span>
          <span
            className={`hud-goal__ceiling-value${ceiling.over ? ' hud-goal__ceiling-value--over' : ''}`}
          >
            {ceiling.text}
          </span>
          {/* The RATE beside the LEVEL (P-003). Absent entirely when the window
              was never measured — never a $0/day we cannot back. */}
          {burn ? (
            <Tooltip label={burn.detail}>
              <span
                className={`hud-goal__ceiling-burn${burn.urgent ? ' hud-goal__ceiling-burn--urgent' : ''}`}
                data-burn-urgent={burn.urgent ? 'true' : 'false'}
              >
                {burn.text}
              </span>
            </Tooltip>
          ) : null}
          {canEdit ? (
            <button
              type="button"
              className="hud-goal__set-toggle"
              onClick={() => void setOpen('ceiling')}
              data-testid="goal-ceiling-edit"
            >
              {budgetCents == null ? 'Set ceiling' : 'Edit'}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
