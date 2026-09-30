'use client';

/**
 * GoalStatusControl — the goal's status LEVER (goals-tab-improvement-2026-08-09 P-016).
 *
 * The owner considered making the board lanes writable and reversed it: "lets not allow
 * for drag and dropping forget that, add a start/pause button where appropriate." So the
 * derived lanes stay derived and status becomes an explicit control.
 *
 * ── WHY A BUTTON AND NOT A CLICKABLE STATUS PILL ─────────────────────────────────────
 * A pill reading "active" that flips on click is ambiguous in the one place ambiguity is
 * expensive: it never says whether the word is the CURRENT state or the state you are
 * about to move to. The band keeps the pill as a readout and puts a LABELLED verb beside
 * it, which is also what the established steering gesture does (AdvNowRunning's
 * Start/Stop button sits next to, not on top of, the state it reports).
 *
 * ── SCOPE: WHICH MOVES GO WHERE, AND WHY ─────────────────────────────────────────────
 * active <-> paused is the reversible everyday pair, so it is the one-click control and
 * the only one the CARD carries. `achieved` and `killed` are TERMINAL and sit behind a
 * confirm — never the easiest click on the surface. Reopening a terminal goal is also
 * confirmed: it re-opens placement on every project the goal owns, which is a fleet
 * starting to spend money, not a label change.
 *
 * ── THE PROPERTY THIS FILE EXISTS TO HOLD ────────────────────────────────────────────
 * P-016: "do NOT let an optimistic state outlive a failed write — a goal that looks
 * paused and is not is worse than no button." So there is NO optimistic status here at
 * all. The button reports in-flight, the WRITE lands, `notifySyncInvalidate` re-pulls
 * `goals.list`/`goals.detail`, and the pill moves because the STORE moved. A failed write
 * therefore cannot leave a lying pill behind, because nothing was ever moved locally.
 *
 * And the harder half: a write can SUCCEED and still be materially incomplete. Pausing
 * reports `unattributedActiveLoops` (burn it could not attribute and did not stop);
 * resuming reports `loopsLeftDisarmed` (sessions it deliberately did not re-arm). Those
 * arrive as `degraded` + `degradedReasons` and are surfaced as a WARNING toast that
 * stays until dismissed. Rendering only the new status would recreate the exact defect
 * the whole seam exists to prevent — a steering surface reporting a state that is not
 * the state of the system (EI-19995648221353323).
 */

import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { Tooltip } from '@/app/harness/Tooltip';
import { useConfirmDialog } from '@/app/harness/useConfirmDialog';

/** The writable enum, exactly as `goals:update` accepts it. */
export type GoalStatus = 'active' | 'achieved' | 'killed' | 'paused';

const TERMINAL: ReadonlySet<string> = new Set(['achieved', 'killed']);

export interface GoalStatusControlProps {
  goalId: string;
  /** Current status straight off the store — never a local copy. */
  status: string | null | undefined;
  /**
   * Server-derived status (`dormant` when an active goal that requires a live
   * holder has none). Optional only for cached payloads predating the holder
   * guarantee; absence never means dormant.
   */
  effectiveStatus?: string | null;
  /** held | unheld | lost | unknown. Unknown is never safe to start against. */
  holderLiveness?: string | null;
  /**
   * `card` renders the everyday pause/resume or holderless Start verb (a board card is
   * a glance, and a terminal action does not belong on the easiest click surface).
   * `panel` adds the terminal moves behind a confirm.
   */
  variant: 'card' | 'panel';
  /** Fired after a write lands, so a host holding its own snapshot can re-read. */
  onChanged?: (status: GoalStatus) => void;
}

/**
 * The tool result, as the admin proxy hands it back. `degraded` rides at the top level
 * beside `data` — see `goals:update`'s return shape.
 */
interface GoalUpdateReply {
  data?: unknown;
  degraded?: boolean;
  degradedReasons?: string[];
  error?: { code?: string; message?: string };
}

async function writeGoalStatus(goalId: string, status: GoalStatus): Promise<GoalUpdateReply> {
  const res = await fetch('/api/admin/goals/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: goalId, status }),
  });
  // A refusal still carries our JSON body; read it rather than throwing the reason away.
  let body: GoalUpdateReply;
  try {
    body = (await res.json()) as GoalUpdateReply;
  } catch {
    throw new Error(`HTTP ${res.status}`);
  }
  if (!res.ok) {
    throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  }
  return body;
}

async function startExistingGoal(goalId: string): Promise<GoalUpdateReply> {
  const res = await fetch('/api/admin/goals/start-existing', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: goalId }),
  });
  let body: GoalUpdateReply;
  try {
    body = (await res.json()) as GoalUpdateReply;
  } catch {
    throw new Error(`HTTP ${res.status}`);
  }
  if (!res.ok) {
    throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  }
  return body;
}

export default function GoalStatusControl({
  goalId,
  status,
  effectiveStatus,
  holderLiveness,
  variant,
  onChanged,
}: GoalStatusControlProps) {
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  const [pending, setPending] = useState<GoalStatus | null>(null);

  const current = (status ?? '').toLowerCase();
  const effective = (effectiveStatus ?? current).toLowerCase();
  const liveness = (holderLiveness ?? '').toLowerCase();
  const isPaused = current === 'paused';
  const isTerminal = TERMINAL.has(current);
  const isHolderless =
    current === 'active' &&
    liveness !== 'unknown' &&
    (effective === 'dormant' || liveness === 'unheld' || liveness === 'lost');

  const run = useCallback(
    async (next: GoalStatus, verb: string, write: 'status' | 'start' = 'status') => {
      if (pending) return;
      setPending(next);
      try {
        const reply =
          write === 'start'
            ? await startExistingGoal(goalId)
            : await writeGoalStatus(goalId, next);

        // A degraded write is a SUCCESS that did less than its label implies. It gets a
        // warning that does not auto-dismiss, because the whole point is that the reader
        // must not walk away believing the goal is fully stopped (or fully running).
        if (reply.degraded && reply.degradedReasons?.length) {
          toast.warning(`Goal ${verb} — but not completely`, {
            description: reply.degradedReasons.join(' · '),
            duration: Infinity,
          });
        } else {
          toast.success(`Goal ${verb}`);
        }
        onChanged?.(next);
      } catch (e) {
        // Nothing to roll back — no local status was ever moved (see the docblock).
        toast.error(`Could not ${verb} this goal`, { description: String(e) });
      } finally {
        setPending(null);
      }
    },
    [goalId, onChanged, pending],
  );

  /**
   * Move a goal back to `active`. Paused Resume is a status transition only;
   * terminal Reopen and holderless Start use the composed activation route so
   * the status and fresh holder cannot drift apart. Keeping their framing in one
   * callback prevents the older bug where Reopen fell through to Pause.
   */
  const reactivate = useCallback(
    async (from: 'paused' | 'terminal' | 'holderless') => {
      const ok = await askConfirm({
        title:
          from === 'paused'
            ? 'Resume this goal?'
            : from === 'terminal'
              ? 'Reopen this goal?'
              : 'Start this goal?',
        body:
          from === 'paused'
            ? 'Placement re-opens on the projects this goal owns. Sessions paused earlier are NOT re-armed — new work re-forms from placement.'
            : 'Placement re-opens and a fresh owning agent is launched and attached to this goal. Its conversation will appear here once the session registers.',
        confirmLabel:
          from === 'paused'
            ? 'Resume goal'
            : from === 'terminal'
              ? 'Reopen goal'
              : 'Start goal',
      });
      if (!ok) return;
      await run(
        'active',
        from === 'paused' ? 'resumed' : from === 'terminal' ? 'reopened' : 'started',
        from === 'paused' ? 'status' : 'start',
      );
    },
    [askConfirm, run],
  );

  const togglePause = useCallback(async () => {
    if (isPaused) {
      // Resuming re-opens placement on every project this goal owns — a fleet starting
      // to spend, so it is named plainly rather than sold as a harmless undo.
      await reactivate('paused');
      return;
    }
    const ok = await askConfirm({
      title: 'Pause this goal?',
      body: 'Placement is gated on the projects this goal owns and the engine loops of sessions attributed to it are disarmed. Anything already running that cannot be attributed to this goal keeps going — you will be told if so.',
      confirmLabel: 'Pause goal',
      destructive: true,
    });
    if (!ok) return;
    await run('paused', 'paused');
  }, [askConfirm, isPaused, reactivate, run]);

  const close = useCallback(
    async (next: 'achieved' | 'killed') => {
      const ok = await askConfirm({
        title: next === 'achieved' ? 'Mark this goal achieved?' : 'Kill this goal?',
        body:
          next === 'achieved'
            ? 'The goal closes and its projects stop being placed. Use this when the outcome it names is actually met.'
            : 'The goal closes and its projects stop being placed. Use this when its written kill criterion has tripped.',
        confirmLabel: next === 'achieved' ? 'Mark achieved' : 'Kill goal',
        destructive: true,
      });
      if (!ok) return;
      await run(next, next === 'achieved' ? 'marked achieved' : 'killed');
    },
    [askConfirm, run],
  );

  const busy = pending !== null;

  return (
    <>
      {/* A terminal goal has no everyday verb — nothing to pause, nothing to resume.
          Reopening it is a panel-only move (below), never a card click. */}
      {!isTerminal && isHolderless ? (
        <Tooltip label="Launch and attach a fresh owning agent for this goal">
          <button
            type="button"
            className="pc-ctl-act"
            data-testid="goal-start"
            disabled={busy}
            aria-label="Start this goal"
            onClick={(e) => {
              e.stopPropagation();
              void reactivate('holderless');
            }}
          >
            {busy ? '…' : 'Start'}
          </button>
        </Tooltip>
      ) : !isTerminal ? (
        <Tooltip
          label={
            isPaused
              ? 'Re-open placement on this goal’s projects'
              : 'Gate placement on this goal’s projects and disarm its sessions’ loops'
          }
        >
          <button
            type="button"
            className="pc-ctl-act"
            data-testid="goal-pause-resume"
            disabled={busy}
            aria-label={isPaused ? 'Resume this goal' : 'Pause this goal'}
            onClick={(e) => {
              // The card is itself a button; without this the click also opens the popup.
              e.stopPropagation();
              void togglePause();
            }}
          >
            {busy ? '…' : isPaused ? 'Resume' : 'Pause'}
          </button>
        </Tooltip>
      ) : null}

      {variant === 'panel' && !isTerminal ? (
        <>
          <button
            type="button"
            className="pc-ctl-act"
            data-testid="goal-achieved"
            disabled={busy}
            onClick={() => void close('achieved')}
          >
            Achieved
          </button>
          <button
            type="button"
            /* No bespoke "danger" variant: `.pc-ctl-act` ships only --ghost/--primary, and
               a class with no CSS behind it is a silent no-op that READS like styling.
               The confirm dialog carries `destructive`, which is where the weight belongs. */
            className="pc-ctl-act"
            data-testid="goal-kill"
            disabled={busy}
            onClick={() => void close('killed')}
          >
            Kill
          </button>
        </>
      ) : null}

      {variant === 'panel' && isTerminal ? (
        <Tooltip label="Re-open placement and put this goal back in play">
          <button
            type="button"
            className="pc-ctl-act"
            data-testid="goal-reopen"
            disabled={busy}
            onClick={() => void reactivate('terminal')}
          >
            {busy ? '…' : 'Reopen'}
          </button>
        </Tooltip>
      ) : null}

      {confirmEl}
    </>
  );
}
