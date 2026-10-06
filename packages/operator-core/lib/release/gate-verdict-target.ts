/**
 * WI-4494 — WHO records a green-checkpoint verdict.
 *
 * The bug this closes, stated verbatim in our own code (release-actions.ts, 2026-07-02):
 * "only ROUTINE-invoked runs write pipeline events / gate_health".
 *
 * `green-checkpoint.ts` (the CLI) is the ONLY thing that produces a verdict, and it runs for BOTH
 * launchers — the hourly routine AND the detached manual run (`release:checkpoint-run`). But the
 * verdict was RECORDED by the routine caller, which parses the CLI's stdout. A manual run therefore
 * executed the full suite, computed a perfectly good green/red, and DISCARDED it. That is what makes
 * run-lock contention lethal instead of harmless:
 *
 *   gate_health frozen on a stale red
 *     → the release-fixer (and peers) fire MANUAL checkpoint runs to get a fresh verdict
 *     → a manual run holds the run-lock for up to 55 min
 *     → the hourly routine fire lands mid-run, records `skipped-locked` (a no-op — correctly, it has
 *       no verdict) while still refreshing `routines.last_fired_at`
 *     → the manual run that DID have the verdict throws it away
 *     → gate_health never updates → the stale red persists → more fixers → more manual runs.
 *
 * Observed live 2026-07-12 (papercusp): three consecutive hourly fires `skipped-locked`, the release
 * pin frozen at 28a3a3d5 for ~10h, and the WI-4486 memory-blackout fix unable to ship on a green pin.
 *
 * THE FIX: the PRODUCER records the verdict. Then a lock collision is harmless — whoever wins the
 * lock is the one producing a verdict, and they record it. `gate_health` becomes "the outcome of the
 * most recent completed suite run, whoever ran it", which is correct BY CONSTRUCTION rather than
 * reconciled after the fact. Two prior attempts (the 2026-07-02 pin-movement inference and WI-4489's
 * `verdictStale` derivation) were both reconciliation layers over a value that can be wrong; this
 * removes the wrongness instead. [owner 2026-07-11] "this looks like just a bandaid, lets just
 * make sure its right the first time so that it doesn't need to get 're-verified' to begin with."
 *
 * WHY AN ENV GATE (and not "the CLI always records"): the CLI is invoked ACROSS VERSIONS. The routine
 * that spawns it runs from the DEPLOYED tree while the CLI itself runs from the INTEGRATION tree, so
 * an older recorder routinely drives a newer CLI (the same skew the result-marker protocol already
 * guards — see green-checkpoint.ts's emitResult). Resolving the record target from env the LAUNCHER
 * stamps makes the change safe in both skew directions:
 *
 *   old routine + new CLI → env absent → CLI does NOT record → the routine records, exactly as today.
 *   new routine + old CLI → CLI ignores the env and never sets `recorded` → the routine records.
 *
 * So the gate can never go blind: the worst case is the pre-WI-4494 behaviour.
 */

/** Env the launcher stamps so the CLI knows WHICH harness's gate_health this run's verdict belongs
 *  to. Deliberately specific names — a generic PAPERCUSP_WORKSPACE_ID could already be set in the
 *  ambient environment of a host process, which would make the CLI record a verdict for a harness it
 *  was never launched on behalf of (and double-count the red streak against the routine's own write). */
export const GATE_VERDICT_WORKSPACE_ENV = 'PAPERCUSP_GATE_VERDICT_WORKSPACE';
export const GATE_VERDICT_HARNESS_ENV = 'PAPERCUSP_GATE_VERDICT_HARNESS';

/** The harness whose `gate_health` + pipeline history a checkpoint run's verdict belongs to. */
export interface GateVerdictTarget {
  workspaceId: string;
  installSlug: string;
}

/** Resolve the operator-home gate identity in the current request/runtime scope. */
export function resolveHomeGateVerdictTarget(): GateVerdictTarget | null {
  try {
    const { activeWorkspaceId } = require('../workspace-registry') as typeof import('../workspace-registry');
    const { operatorHomeHarnessSlug } =
      require('../harness/operator-home-harness') as typeof import('../harness/operator-home-harness');
    const workspaceId = activeWorkspaceId();
    const installSlug = operatorHomeHarnessSlug();
    if (!workspaceId || !installSlug) return null;
    return { workspaceId, installSlug };
  } catch {
    return null;
  }
}

/**
 * Resolve the record target from the environment, or null when this run was not launched with one
 * (⇒ the CLI must NOT record; its caller will, exactly as before WI-4494).
 *
 * Fail-CLOSED on a partial stamp: a target with only one half is not a target. Recording against a
 * blank harness would UPDATE ... WHERE install_slug = '' and silently match no row — a write that
 * looks like it worked and changes nothing, which is precisely the class of silent no-op this whole
 * work item exists to eliminate.
 */
export function gateVerdictTargetFromEnv(env: NodeJS.ProcessEnv = process.env): GateVerdictTarget | null {
  const workspaceId = (env[GATE_VERDICT_WORKSPACE_ENV] ?? '').trim();
  const installSlug = (env[GATE_VERDICT_HARNESS_ENV] ?? '').trim();
  if (!workspaceId || !installSlug) return null;
  return { workspaceId, installSlug };
}

/** The env pair a launcher adds to the checkpoint run's environment. */
export function gateVerdictEnv(target: GateVerdictTarget): Record<string, string> {
  return {
    [GATE_VERDICT_WORKSPACE_ENV]: target.workspaceId,
    [GATE_VERDICT_HARNESS_ENV]: target.installSlug,
  };
}

/**
 * Is this checkpoint outcome an actual VERDICT on the gate — something worth recording?
 *
 * The `skipped-*` outcomes are not verdicts, and recording them is the original sin:
 *  - `skipped-locked`  — another run holds the lock. It proves NOTHING about the gate's health, and
 *    the run that holds the lock is producing the real verdict and (post-WI-4494) records it itself.
 *    This is the whole point: the collision becomes a no-op for BOTH parties, and the verdict still
 *    lands. (Kept consistent with classifyGateStallStatus's 'noop' class / EI-2615.)
 *  - `skipped-disabled` / `skipped-no-tooling` — the suite never ran.
 *
 * Everything else (advanced | advanced-prefix | up-to-date | not-green | not-fast-forward |
 * create-failed | error) IS a statement about the gate and must be recorded by whoever produced it.
 */
export function isRecordableVerdict(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return !reason.startsWith('skipped-');
}
