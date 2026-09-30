/**
 * Subdirectives, in the goal detail popup (goals-tab-improvement-2026-08-09 P-017).
 *
 * WHY THE ADD AFFORDANCE LIVES HERE AND NOT ON THE BOARD CARD. P-017 asks for "an
 * add sub-goal affordance on a goal", and the card looked like the obvious host —
 * it already carries P-016's status pill in `renderCardAction`. D-001 rules the
 * other way: the board is a GLANCE and this panel is where DETAIL lives, and a
 * create form is detail. The 300px card would also have to grow a text input
 * inside a `<button>`, which is the invalid nesting P-016 already hit. So the card
 * renders subdirectives READ-ONLY (HudEntityColumns' `hud__subs`) and authoring
 * happens here, next to the parent/child relationship it edits.
 *
 * WHY `goals:create` AND NOT `goals:start`. `goals:start` accepts `parentId` and is
 * the tool the composer uses, so it reads like the natural choice — and it is the
 * wrong one. It spawns an agent in the same transaction, and D-006 says a child
 * "does NOT get an agent, a session, or an independent life on the board", calling
 * out that "an implementation that gives a child its own agent … breaks this
 * decision". `goals:create` writes the row and nothing else, which is exactly the
 * whole of a subdirective. The admin route enforces the same rule from its side by
 * refusing a parentless `create`.
 *
 * NO CEILING, NO KILL CRITERION, NO SPEND — and their absence is the design, not an
 * unfinished form. One goal is one agent is one bill (D-006), so a child has no
 * separable spend to cap or report. A ceiling field here would imply a budget that
 * cannot be enforced separately, and a spend figure would invite the parent+children
 * addition D-002 forbids.
 */

import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import type { GoalDetailSubGoalInput } from './goal-detail-model';

const TERMINAL: ReadonlySet<string> = new Set(['achieved', 'killed']);

/** Same shape the sibling controls post with — see the file docblock for why `create`. */
async function createSubGoal(parentId: string, title: string): Promise<void> {
  const res = await fetch('/api/admin/goals/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, parentId }),
  });
  if (!res.ok) {
    // The refusal carries our JSON body (including the route's `parent_required`
    // explanation); surface it rather than throwing the reason away.
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = body.error.message;
    } catch {
      /* non-JSON body — the status alone is what we have */
    }
    throw new Error(detail);
  }
}

export default function SubGoalsSection({
  goalId,
  subGoals,
  parent,
  onOpenGoal,
}: {
  goalId: string;
  /** Absent/null distinguishes "payload predates P-017" from "none" — see the type. */
  subGoals: GoalDetailSubGoalInput[] | null | undefined;
  parent: { id: string; title: string } | null | undefined;
  /** Re-targets this popup at another goal. Optional: a host that cannot re-target
   *  passes nothing and the parent renders as text rather than as a dead control. */
  onOpenGoal?: (goalId: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    const title = draft.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      await createSubGoal(goalId, title);
      // The route invalidates goals.list + goals.detail server-side on success, so
      // the list below and the board card both re-pull without a local cache write.
      setDraft('');
      toast.success('Subdirective added');
    } catch (e) {
      toast.error('Could not add the subdirective', { description: String(e) });
    } finally {
      setBusy(false);
    }
  }, [busy, draft, goalId]);

  const children = subGoals ?? [];

  return (
    <section className="hud-goal__section">
      <h3 className="pc-zone-title">
        Subdirectives
        {children.length > 0 ? <span className="hud__chip">{children.length}</span> : null}
      </h3>

      {/* Stated as a sentence rather than left to the section title, because "one
          agent, many directives" is the whole object model here and a reader
          arriving from a flat board will otherwise assume these are goals. */}
      <p className="hud-goal__note">
        Directions for this goal’s agent. A subdirective steers the same agent — it does not get one
        of its own, and has no separate spend. Want a second agent? Start a second goal.
      </p>

      {parent ? (
        <p className="hud-goal__note" data-testid="goal-parent">
          Subdirective of{' '}
          {onOpenGoal ? (
            <button type="button" className="hud-goal__link" onClick={() => onOpenGoal(parent.id)}>
              {parent.title}
            </button>
          ) : (
            <strong>{parent.title}</strong>
          )}
        </p>
      ) : null}

      {children.length === 0 ? (
        <p className="hud-goal__empty">No subdirectives — this goal’s agent has one direction.</p>
      ) : (
        <ul className="hud-goal__rows" data-testid="goal-subgoals">
          {children.map((c) => (
            <li key={c.id} className="hud-goal__row">
              {/* Struck through rather than dropped when finished: what steered the
                  agent is part of how the goal got here. */}
              <span className={TERMINAL.has(c.status) ? 'hud-goal__row-done' : undefined}>
                {c.title}
              </span>
              <span className="hud-goal__row-meta">{c.status || 'unknown'}</span>
            </li>
          ))}
        </ul>
      )}

      <form
        className="hud-goal__addsub"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          className="hud-goal__addsub-in"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="New direction for this agent…"
          aria-label="New subdirective"
          disabled={busy}
          maxLength={200}
        />
        <button
          type="submit"
          className="hud-goal__addsub-go"
          disabled={busy || draft.trim() === ''}
        >
          {busy ? 'Adding…' : 'Add'}
        </button>
      </form>
    </section>
  );
}
