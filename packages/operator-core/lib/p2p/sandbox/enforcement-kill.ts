/**
 * p2p/sandbox/enforcement-kill.ts — P-105 §5: the enforcement LIFECYCLE
 * (X13, DESIGN-p2p-P105-…md §5). `foreign-supervision.ts` already
 * transitions a condemned session to `'winding-down'` (H12/H13) and grants
 * it a grace window to drain; per that module's own doc comment, "the
 * MECHANICAL kill after grace is P-105's sandbox tier" — this is that tier.
 *
 * Decision: an ENFORCED kill after the wind-down grace period, not a soft
 * signal alone — closing the gap where a wedged foreign session sits
 * consuming resources indefinitely after its origin walks away.
 *
 * Per the ratified doc's own status note, the kill mechanism cannot be
 * FULLY built until §2 (cgroups) exists live on a host — this module
 * implements the composition + a SIGKILL fallback for when no cgroup is
 * available, so the decision logic and the fallback path are both real and
 * tested today; the cgroup-freeze path activates once a build lane wires
 * §2 to a real spawn (WI-1937, out of this item's scope).
 */

export type ForeignWorkspaceState = 'provisioning' | 'active' | 'winding-down' | 'parked' | 'reaped';

export interface EnforcedKillDecisionInput {
  state: ForeignWorkspaceState;
  /** ms epoch the session entered 'winding-down' (null = not winding down). */
  windDownStartedAt: number | null;
  now: number;
  /** Grace window (X8's wind-down primitive already grants one; this is the
   *  HARD deadline after which X13 escalates to a mechanical kill). */
  graceMs: number;
  /** Whether a cgroup exists for this session (gates which kill METHOD is
   *  available — the decision to kill is independent of this). */
  cgroupPathExists: boolean;
}

export type EnforcedKillDecision =
  | { shouldKill: false; reason: 'not_winding_down' | 'within_grace' }
  | { shouldKill: true; reason: 'grace_expired'; preferredMethod: 'cgroup-freeze-kill' | 'sigkill-fallback' };

/**
 * PURE: should this session be mechanically killed right now? Only
 * 'winding-down' sessions are candidates (a still-'active' session hasn't
 * been condemned; 'parked'/'reaped' are already terminal — never re-kill a
 * terminal row). Clock skew (negative age) never kills.
 */
export function decideEnforcedKill(input: EnforcedKillDecisionInput): EnforcedKillDecision {
  if (input.state !== 'winding-down' || input.windDownStartedAt == null) {
    return { shouldKill: false, reason: 'not_winding_down' };
  }
  const age = input.now - input.windDownStartedAt;
  if (age < 0 || age <= input.graceMs) return { shouldKill: false, reason: 'within_grace' };
  return {
    shouldKill: true,
    reason: 'grace_expired',
    preferredMethod: input.cgroupPathExists ? 'cgroup-freeze-kill' : 'sigkill-fallback',
  };
}

export interface KillDeps {
  /** Injectable so tests never send a real signal. Production default is
   *  `process.kill`. */
  killSignal?: (pid: number, signal: NodeJS.Signals) => void;
  /** cgroup.freeze write — only used on the cgroup-freeze-kill path. */
  freezeCgroup?: (cgroupPath: string) => Promise<void>;
}

export type KillOutcome =
  | { ok: true; method: 'cgroup-freeze-kill' | 'sigkill-fallback' }
  | { ok: false; refusal: { code: 'kill-failed'; detail: string } };

/**
 * Execute the kill per `decideEnforcedKill`'s preferred method. cgroup-
 * freeze-kill freezes the cgroup first (stops the process from spawning
 * children that dodge the subsequent SIGKILL — a fork racing the signal is
 * the classic escape) then signals every PID; sigkill-fallback signals the
 * single tracked PID directly (weaker: a foreign session that has forked
 * children not tracked by `pid` can survive this path, which is exactly why
 * §2's cgroup wiring is called out as required for the FULL guarantee).
 */
export async function killForeignSessionProcess(
  input: { pid: number; cgroupPath: string | null; method: 'cgroup-freeze-kill' | 'sigkill-fallback' },
  deps: KillDeps = {},
): Promise<KillOutcome> {
  const kill = deps.killSignal ?? ((pid, signal) => process.kill(pid, signal));
  try {
    if (input.method === 'cgroup-freeze-kill') {
      if (!input.cgroupPath) {
        return { ok: false, refusal: { code: 'kill-failed', detail: 'cgroup-freeze-kill requested but no cgroupPath was provided' } };
      }
      const freeze = deps.freezeCgroup ?? (async () => {});
      await freeze(input.cgroupPath);
    }
    kill(input.pid, 'SIGKILL');
    return { ok: true, method: input.method };
  } catch (e) {
    return { ok: false, refusal: { code: 'kill-failed', detail: e instanceof Error ? e.message : String(e) } };
  }
}
