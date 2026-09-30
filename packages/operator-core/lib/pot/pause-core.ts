/**
 * The pot pause STATE TRANSITION, extracted from the `pot:pause` tool so the goal
 * stop fan-out (EI-20013729460455061) performs the identical transition instead of
 * re-implementing it.
 *
 * Re-implementing it was the alternative, and it would have drifted on the two
 * things that are easy to omit and silent when omitted:
 *   - the P-013 ORDERING — the per-pot placement bit is cleared FIRST so no
 *     watchdog seam re-arms between the wake clear and the state flip;
 *   - the `deliberate: true` markers (WI-3261 / WI-3309) — without them the
 *     paused-pot recovery sweep reads the pause as a silent outage and AUTO-RESUMES
 *     it. A goal stop that got quietly undone by a watchdog minutes later would be
 *     the same class of bug the goal stop exists to fix.
 *
 * The graceful cup-drain cue stays in the tool: it needs the caller's agent
 * identity, and it is a policy choice (the harder stop), not part of the transition.
 * Coordination wake staging is also opt-in (`stageAllWakes`): pausing the Mug
 * must not silently mute the workspace's agent-to-agent delivery plane.
 */

import type { Sql } from 'postgres';
import { clearPotTimeWake } from './wake';
import { setPotStarted, setPotPlacementStarted, anyPotPlacementStarted } from './started';
import { getDefaultWakeMode, setDefaultWakeMode } from '../agent-tools/coordination/wake-mode';

export interface PausePotResult {
  harness: string;
  started: false;
  /** The global wake mode after the pause; pause preserves it unless staging was requested. */
  wakeMode: 'manual' | 'auto';
  /** True when NO pot remained started, so the workspace Mug loop was idled too. */
  workspaceLoopIdle: boolean;
  timeWakeCleared: boolean;
}

/**
 * Clear a pot's placement bit and, when it was the last started pot, idle the
 * workspace Mug loop. Idempotent: pausing an already-paused pot is a no-op write.
 */
export async function pausePotState(
  sql: Sql,
  workspaceId: string,
  installSlug: string,
  opts: { stageAllWakes?: boolean } = {},
): Promise<PausePotResult> {
  // Per-pot Stop: clear THIS pot's placement bit FIRST (P-013 ordering). This is
  // what stops the workspace Mug placing THIS pot's work.
  await setPotPlacementStarted(workspaceId, installSlug, false, { deliberate: true });

  // Idle the workspace Mug LOOP only when NO pot remains started — otherwise the
  // single workspace Mug keeps running for the other started hives.
  const loopIdle = !(await anyPotPlacementStarted(workspaceId, installSlug));
  if (loopIdle) {
    await setPotStarted(workspaceId, installSlug, false, { deliberate: true });
  }

  // Pausing the Mug is not permission to mute the coordination plane. A caller that
  // explicitly wants every autonomous wake staged can opt in; the default preserves
  // the current global mode, including an owner-selected `coord:wake-mode` setting.
  if (opts.stageAllWakes) {
    await setDefaultWakeMode('manual');
  }

  if (loopIdle) {
    await clearPotTimeWake(sql, installSlug, { workspaceId });
  }

  const wakeMode = await getDefaultWakeMode();
  return {
    harness: installSlug,
    started: false,
    wakeMode,
    workspaceLoopIdle: loopIdle,
    timeWakeCleared: loopIdle,
  };
}

export interface ResumePotResult {
  harness: string;
  started: true;
  wakeMode: 'auto';
  /**
   * ⚠ ALWAYS FALSE, and present so a caller cannot read this result as a full
   * inverse. `pausePotState` DELETES the pot's declared time-wake routine row
   * (`clearPotTimeWake`) when it idles the workspace loop, and a deleted row takes
   * its cadence with it — there is nothing left to restore it from. `pot:start`
   * does not restore it either (it fires a one-shot urgent wake instead), so this
   * is a property of the existing pause/start pair, not of the goal resume.
   *
   * Deliberately NOT measured per-call: `getPotTimeWake` returns null both for
   * "the pause cleared it" and for "one was never declared", so a measured claim
   * here would be a guess wearing a number.
   */
  timeWakeRestored: false;
}

/**
 * The INVERSE of `pausePotState` — restore a pot's placement bit and make sure the
 * workspace Mug loop is running to service it (WI-37615, plan D-013).
 *
 * It exists because the pause is deliberately UNRECOVERABLE by watchdog: the
 * `deliberate: true` markers above tell the paused-pot recovery sweep to leave the
 * pause alone (WI-3261 / WI-3309). That is correct for a pause and is exactly what
 * made the missing resume permanent — a goal moved back to `active` gated placement
 * forever while its row read "active".
 *
 * ORDERING IS THE MIRROR of the pause, and for the same P-013 reason. The pause
 * clears the per-pot placement bit FIRST so no watchdog seam re-arms between the
 * wake clear and the state flip; the resume arms the workspace Mug loop FIRST, so
 * that at the instant placement is re-enabled there is already a Mug running to
 * service it. Reversed, there is a window where work is placeable and nothing is
 * awake to place it — which reads to an owner as "I resumed it and nothing happened".
 *
 * NOT a `pot:start`. That tool additionally fires `requestUrgentPotWake` with a
 * caller-supplied kickoff and ensures default wake subscriptions. The kickoff is a
 * policy choice belonging to the person starting a pot, not to a goal-level status
 * write — firing one urgent wake per owned project off a single goal resume would be
 * a surprise. This is the state transition only.
 */
export async function resumePotState(
  workspaceId: string,
  installSlug: string,
): Promise<ResumePotResult> {
  // Arm the workspace Mug loop FIRST (see ORDERING above), then re-open placement.
  //
  // No `deliberate` on either write, and that is not an omission: BOTH setters
  // IGNORE the option when `started` is true and unconditionally CLEAR the
  // paused-deliberate bit (started.ts:131-135, :172-178). Passing it would read to
  // the next person as though it did something.
  await setPotStarted(workspaceId, installSlug, true);
  await setPotPlacementStarted(workspaceId, installSlug, true);
  await setDefaultWakeMode('auto');

  return { harness: installSlug, started: true, wakeMode: 'auto', timeWakeRestored: false };
}
