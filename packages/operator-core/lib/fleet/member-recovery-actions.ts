/**
 * member-recovery-actions.ts — P-009's IO half: perform the side effects
 * `decideMemberRecovery` hands back, against the EXISTING task-manager strand model and the
 * EXISTING fleet transition events (D-001: extend the canonical surface, do not add a parallel
 * control plane).
 *
 * The split is the point. `member-recovery.ts` decides and is pure; this module acts and is
 * dependency-injected. That is what makes the six acceptance scenarios unit-testable — the
 * decision needs no fixtures, and the actions need no live cgroup.
 *
 * WHAT "STRAND" MEANS HERE, and why it reuses `markStranded` rather than inventing a state.
 * The task ledger already has exactly the state this needs: `stranded` is its ESCAPE/anomaly
 * class — a row the reconciler could not account for. A member whose kill FAILED is precisely
 * that: a process we asked to end, that did not, and that we can no longer reason about. Adding
 * a `wedged` state beside it would give the same condition two names and split every query that
 * looks for unaccounted work. So the freeze marks it still, and `markStranded` records WHY.
 *
 * ORDERING IS LOAD-BEARING: FREEZE BEFORE MARK. The freeze is what makes the mark true. Marking
 * a row `stranded` while its process keeps running produces a ledger that says the work stopped
 * when it did not — which is worse than the un-marked wedge, because the next reader now has a
 * confident wrong answer instead of an obvious gap. If the freeze fails we say so and still
 * mark, but the record names the failure rather than implying containment we did not achieve.
 */

import type { MemberRecoveryDecision } from './member-recovery';

/** One frozen (or not-frozen) task, reported individually so a partial freeze is visible. */
export interface StrandedTaskRecord {
  taskId: string;
  frozen: boolean;
  /** Present when the freeze did NOT take — an unconfined task, or a control error. */
  freezeError?: string;
}

export interface StrandMemberResult {
  /** True only when EVERY resolved task was actually frozen. */
  contained: boolean;
  tasks: StrandedTaskRecord[];
  /** How many ledger rows were closed as `stranded`. */
  markedStranded: number;
  /** True when the transition edge was emitted with the decision's reason. */
  transitionEmitted: boolean;
  /**
   * Set when we could not find any task row for the member. NOT an error: an unmanaged session
   * has no ledger row by construction, so there is nothing to freeze — but the caller must still
   * be told, because "contained" would otherwise read as vacuously true.
   */
  noTasksFound: boolean;
  /** Verbatim from the decision, so every downstream reader sees one cause string. */
  reason: string;
}

export interface StrandMemberDeps {
  listTasks: (filter: { workspaceId?: string; coordOwnerId: string }) => Promise<readonly { taskId: string }[]>;
  freezeTask: (taskId: string) => Promise<{ ok: boolean; error?: string }>;
  markStranded: (verdicts: readonly { taskId: string; reason: string }[]) => Promise<number>;
  emitTransition: (edge: { kind: string; reason: string; memberOwnerId: string; fleetSlug: string }) => void;
  /** Injected so a failing dependency degrades to a reported failure instead of an exception. */
  onError?: (stage: string, error: unknown) => void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Contain and mark a member the decision stranded.
 *
 * FAIL-SOFT BY DESIGN, in one direction only. Every stage is individually guarded, because this
 * runs on the path where something has ALREADY gone wrong — a recovery helper that throws on its
 * own second failure hands the leader an exception instead of the diagnosis it came for. What it
 * never does is report containment it did not achieve: a stage that fails is recorded as failed
 * and drags `contained` to false.
 */
export async function strandWedgedMember(
  args: { workspaceId?: string; fleetSlug: string; memberOwnerId: string; decision: MemberRecoveryDecision },
  deps: StrandMemberDeps,
): Promise<StrandMemberResult> {
  const { fleetSlug, memberOwnerId, decision } = args;
  const reason = decision.reason;
  const fail = (stage: string, error: unknown) => deps.onError?.(stage, error);

  let rows: readonly { taskId: string }[] = [];
  let listFailed = false;
  try {
    const listed = await deps.listTasks({ workspaceId: args.workspaceId, coordOwnerId: memberOwnerId });
    // A store that RESOLVES a non-array is an enumeration failure exactly like one that throws —
    // and it is the more dangerous shape, because it does not reach the catch below. Iterating it
    // would raise a TypeError from inside the one helper whose contract is that it never adds a
    // second exception to an already-failing path (this is not hypothetical: it fired from
    // fleet:respawn-member's kill_failed path the first time the store was stubbed). Treat it as
    // listFailed so containment is never reported, rather than as "no tasks exist".
    if (Array.isArray(listed)) {
      rows = listed;
    } else {
      listFailed = true;
      fail('listTasks', new Error(`listTasks returned a non-array (${typeof listed})`));
    }
  } catch (error) {
    listFailed = true;
    fail('listTasks', error);
  }

  const tasks: StrandedTaskRecord[] = [];
  for (const row of rows) {
    try {
      const outcome = await deps.freezeTask(row.taskId);
      tasks.push(
        outcome.ok
          ? { taskId: row.taskId, frozen: true }
          : { taskId: row.taskId, frozen: false, freezeError: outcome.error ?? 'freeze_failed' },
      );
    } catch (error) {
      fail('freezeTask', error);
      tasks.push({ taskId: row.taskId, frozen: false, freezeError: message(error) });
    }
  }

  // Mark AFTER the freeze, and mark even a task we failed to freeze: an unaccounted row that is
  // still running is exactly what `stranded` is for. The reason string carries the freeze outcome
  // so the ledger never implies containment the freeze did not deliver.
  let markedStranded = 0;
  if (tasks.length > 0) {
    try {
      markedStranded = await deps.markStranded(
        tasks.map((t) => ({
          taskId: t.taskId,
          reason: t.frozen ? `${reason} [frozen]` : `${reason} [FREEZE FAILED: ${t.freezeError ?? 'unknown'}]`,
        })),
      );
    } catch (error) {
      fail('markStranded', error);
    }
  }

  let transitionEmitted = false;
  if (decision.transition) {
    try {
      deps.emitTransition({
        kind: decision.transition.kind,
        reason: decision.transition.reason,
        memberOwnerId,
        fleetSlug,
      });
      transitionEmitted = true;
    } catch (error) {
      fail('emitTransition', error);
    }
  }

  return {
    // Containment requires that we could ENUMERATE the tasks and froze every one we found. A
    // failed enumeration is explicitly not containment — we do not know what we did not see.
    contained: !listFailed && tasks.length > 0 && tasks.every((t) => t.frozen),
    tasks,
    markedStranded,
    transitionEmitted,
    noTasksFound: !listFailed && rows.length === 0,
    reason,
  };
}
