/**
 * task-manager/enabled — the ONE authority on whether the task manager is live
 * (WI-6499, owner directive 2026-07-27: "put the task manager behind a testing
 * flag it isn't ready yet").
 *
 * Before this module the `papercusp-task-manager` flag was largely decorative: it
 * gated the PANE's two read surfaces and nothing else, while its own doc comment
 * claimed it gated "cgroup confinement at the spawn chokepoints, the 30s
 * reconcile, and the Task Manager pane". Turning it off still confined every
 * spawn, still wrote the ledger, still ran the reconciler, and still fired a
 * `systemd-run` probe at module import — the pane just went blank. A kill-switch
 * that only blanks the dashboard is worse than none, because it reads as safe.
 *
 * Two readers, because the spawn seams need two shapes:
 *
 *   ASYNC   `isTaskManagerEnabled()` — the real read. Anything that can await.
 *   SYNC    `taskManagerEnabledSync()` — a cached snapshot for `beginSyncEnrolment`,
 *           which is synchronous by design (see enroll-sync.ts's header) and cannot
 *           grow an await without changing every spawn seam on the box.
 *
 * FAILS OPEN. This bias flipped on 2026-08-02 (WI-6844, owner-directed: "we put
 * it behind a testing flag. Remove that flag, we'll make it part of our standard
 * release"). The flag graduated out of DARK_FLAGS and now derives default-ON, so
 * the subsystem is shipped, not unready — and for a shipped subsystem it is the
 * ABSENCE that is the outage: an unreachable flag backend must not silently
 * un-confine and un-ledger every process on the box, leaving the reconciler with
 * nothing to reconcile and `processes:list` reporting disabled. Unknown ⇒ on,
 * which is what the two original call sites did (`.catch(() => true)`) before
 * WI-6499 inverted them for the testing window.
 *
 * The flag KEY deliberately survives as a runtime kill-switch: this subsystem
 * intercepts every spawn seam on the box, so an explicit OFF at /admin/features
 * must still restore the pre-feature behaviour byte-for-byte without a revert.
 * An explicit `false` from the backend is always honoured — only the UNKNOWN
 * case changed.
 */

import { FLAGS } from '@papercusp/flags';
import { getFlag, onFlagChange } from '@papercusp/flags/server';

/** null = "not resolved yet", which reads as ON for sync callers (fail-open). */
let cached: boolean | null = null;
let inflight: Promise<boolean> | null = null;

/**
 * Resolve the flag, refreshing the sync cache as a side effect.
 *
 * `distinctId` is the call site, matching the convention at the other getFlag
 * call sites in this tree — it is what makes a PostHog evaluation attributable
 * to the surface that asked.
 */
export async function isTaskManagerEnabled(distinctId = 'task-manager'): Promise<boolean> {
  ensureFlagSubscriptionArmed();
  const on = await getFlag(FLAGS.TASK_MANAGER, distinctId).catch(() => true);
  cached = on;
  return on;
}

/**
 * The last resolved answer, or `true` if none has landed yet (fail-open).
 *
 * A spawn in the window before the first resolve is ENROLLED. That is the
 * correct bias now that the subsystem ships default-ON: an unenrolled spawn is
 * invisible to the ledger FOREVER (enrolment binds at spawn and cannot be
 * applied retroactively), so a boot-window miss permanently punches a hole in
 * the no-escape property — whereas a spawn enrolled a moment before an explicit
 * OFF resolves is merely confined into a cgroup we then stop reconciling, which
 * the next reconcile tick closes out cleanly.
 */
export function taskManagerEnabledSync(): boolean {
  ensureFlagSubscriptionArmed();
  return cached !== false;
}

/**
 * Kick off a resolve without awaiting it, for the sync seams' module-load path.
 * Coalesced — three separate spawn modules import this and warm it at load.
 */
export function warmTaskManagerFlag(): void {
  ensureFlagSubscriptionArmed();
  if (inflight) return;
  inflight = isTaskManagerEnabled('task-manager:warm').finally(() => {
    inflight = null;
  });
  void inflight.catch(() => {});
}

/**
 * Live-flip wiring, armed on FIRST USE rather than at import (EI-19416650993725684).
 *
 * A flip must not require an operator restart to take effect at the sync seams —
 * otherwise "turn it off" is only true for the surfaces that re-read per request.
 * That property is preserved because all three readers arm.
 *
 * ⚠ CORRECTED 2026-08-03 (EI-19448574704459898). This paragraph used to add "and the
 * three spawn modules that import this already call `warmTaskManagerFlag()` at their
 * own module load". They do not: `warmTaskManagerFlag` has ZERO production call sites
 * — only this file's own post-flip re-warm below and enabled.test.ts. managed-spawn
 * imports `isTaskManagerEnabled`, enroll-sync imports `taskManagerEnabledSync`, and
 * neither imports the warm. The claim mattered because two other files cited it as
 * THE remedy for an unsafe unpopulated state ("give that module an explicit warm call
 * on a boot path, the way task-manager/enabled.ts does"), sending an agent looking for
 * a pattern that was never implemented. What actually makes THIS module safe before
 * its first resolve is the deliberate fail-OPEN default (`cached !== false`), i.e. a
 * CHOSEN safe fallback — not early warming. `warmTaskManagerFlag` remains exported and
 * is genuinely used to re-populate after a flip; it is simply not a boot warm.
 *
 * WHY LAZY, and why this is not merely a style choice: an `import { onFlagChange }`
 * whose binding is READ at module scope makes this module unimportable under a
 * PARTIAL vitest mock of `@papercusp/flags/server`. Vitest's mocked-module proxy
 * throws on binding ACCESS (not on invocation), so the whole test FILE dies at
 * collection with
 *   No "onFlagChange" export is defined on the "@papercusp/flags/server" mock
 * contributing ZERO tests — a failure that names this module while pointing at a
 * file that never mentions it. This module is imported by managed-spawn,
 * enroll-sync, processes/list and sync-resolver/index, so its reach is wide.
 *
 * ⚠ MEASURED, do not "simplify" this back: defensive forms do NOT work, because
 * they are still binding accesses — `onFlagChange?.(...)`, `typeof onFlagChange`,
 * try/catch around the call, and `import * as ns` + `ns.onFlagChange?.()` all throw
 * identically. Moving the access inside a function body is the only fix that keeps
 * the import pure.
 */
let flagSubscriptionArmed = false;
function ensureFlagSubscriptionArmed(): void {
  if (flagSubscriptionArmed) return;
  flagSubscriptionArmed = true;
  onFlagChange((key) => {
    if (key === null || key === FLAGS.TASK_MANAGER) {
      cached = null;
      warmTaskManagerFlag();
    }
  });
}

/** Test seam — set the cached answer directly, or clear it with no argument. */
export function setTaskManagerEnabledForTest(value: boolean | null = null): void {
  cached = value;
  inflight = null;
}
