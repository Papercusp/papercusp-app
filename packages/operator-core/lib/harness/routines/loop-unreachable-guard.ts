/**
 * Loop unreachable-owner terminal guard (WI-1399 — "auto-terminate loops whose owner
 * session is permanently gone").
 *
 * The gap: a loop:arm loop whose owner session dies PERMANENTLY is re-armed forever by the
 * stuck-park backstop in `reconcile-loop-routines.ts` — NOTHING existing auto-pauses it:
 *   - the fire-gate circuit (`autoloop.ts` evaluateFireGate) only THROTTLES, and its own
 *     recovery-debounce (F3) auto-CLOSES a stalled-open circuit and RESUMES cadence;
 *   - the cost-cap (`loop-cost-cap.ts`) only fires when `costCapCents` is configured;
 *   - the dead-man guard (`loop-dead-man.ts`) only fires when `maxFires`/`maxDurationSec`
 *     is configured.
 * A loop armed with none of those (the common case for an interactive su loop) re-fires
 * forever, wasting a resume spawn per cycle and re-emitting `loop-stalled` watchdog EIs.
 *
 * This adds the missing UNCONDITIONAL guard: using the SAME reachability signal
 * `loop:status` already surfaces to a human (`probeWakeReachability` —
 * events/await/wake-reachability.ts), a stuck-park cycle whose owner is genuinely
 * unreachable (no injectable channel, not resumable — `reachable === false`) — AND has
 * stayed that way across a generous terminal window and a minimum run of consecutive
 * stuck-backstop fires (so a merely slow/long-turn or transiently-uninjectable session is
 * never mistaken for permanently dead) — is auto-paused instead of re-armed.
 *
 * A healthy loop between fires still has a standing inbox-wake await and (once its process
 * exits or the psu-host reconnects) a live channel, so it stays reachable; only a truly-gone
 * session (relaunched terminal never reconnected, dead pid, no resumable handle) trips this.
 *
 * Fail-soft throughout: a probe error or read failure is treated as "still reachable" — an
 * uncertain read must never terminate a loop; the existing backoff/circuit guards remain the
 * fallback defense in that case.
 */
import type { Sql } from 'postgres';
import { probeWakeReachability, type WakeReachabilityVerdict } from '../../events/await/wake-reachability';
import { autoPauseLoopRoutine } from './loop-cost-cap';

/** Terminal window floor: an unreachable owner must stay that way for at least this long
 *  (env-overridable) before termination is even considered. */
export const DEFAULT_TERMINAL_UNREACHABLE_MS = 2 * 3600_000; // 2h

/** Minimum consecutive stuck-backstop fires (autoloop_state.consecutive_errors, +1 for the
 *  fire under evaluation) before termination — so a single blip never terminates a loop. */
export const DEFAULT_MIN_STUCK_FIRES = 3;

/** The terminal window for a given loop interval: env override, floored at 8× the loop's own
 *  interval so a very short-interval loop still gets several real retry cycles first (mirrors
 *  `stuckParkMs`'s own 4×-interval floor in reconcile-loop-routines.ts, doubled since this is
 *  the STRICTLY LATER guard in the chain — it must never fire before the stuck-park backstop
 *  itself would have had multiple chances to recover). */
export function terminalUnreachableMs(intervalMs: number): number {
  const env = Number(process.env.PAPERCUSP_LOOP_TERMINAL_UNREACHABLE_MS);
  const base = Number.isFinite(env) && env > 0 ? env : DEFAULT_TERMINAL_UNREACHABLE_MS;
  return Math.max(base, intervalMs * 8);
}

/** Minimum consecutive stuck-backstop fires required, env-overridable. */
export function minStuckFiresForTermination(): number {
  const env = Number(process.env.PAPERCUSP_LOOP_TERMINAL_MIN_STUCK_FIRES);
  return Number.isFinite(env) && env >= 1 ? Math.floor(env) : DEFAULT_MIN_STUCK_FIRES;
}

/** The stuck-park dwell floor — how often a parked loop can accrue ONE stuck-backstop fire.
 *  Single source of truth: `stuckParkMs` in reconcile-loop-routines.ts delegates here, so the
 *  guard's arithmetic below can never drift from the cadence that actually feeds it. */
const DEFAULT_STUCK_PARK_MS = 30 * 60_000;

/** The interval-scaled stuck-backstop cadence: env override, floored at 4× the loop's own
 *  interval (a loop cannot be reconciled faster than it fires). */
export function stuckBackstopCadenceMs(intervalMs: number): number {
  const env = Number(process.env.PAPERCUSP_LOOP_STUCK_PARK_MS);
  const base = Number.isFinite(env) && env > 0 ? env : DEFAULT_STUCK_PARK_MS;
  return Math.max(base, intervalMs * 4);
}

/** WI-6639 (comatose-host): the WALL-CLOCK budget after which even a LIVE INJECTABLE channel
 *  stops vetoing termination — 12h in which the loop settled NO turn and its owner emitted NO
 *  presence beat. A healthy live session cannot do that (it settles turns → recordFire('ok') →
 *  the streak resets to 0). */
export const DEFAULT_COMATOSE_WINDOW_MS = 12 * 3600_000; // 12h

/** The comatose wall-clock window, env-overridable. */
export function comatoseWindowMs(): number {
  const env = Number(process.env.PAPERCUSP_LOOP_COMATOSE_WINDOW_MS);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_COMATOSE_WINDOW_MS;
}

/** The comatose streak expressed as a FIRE COUNT at the 30-min cadence floor — i.e. the value
 *  `comatoseStuckFiresForTermination()` yields for a short-interval loop. Kept as a named
 *  constant because it is the number the reason-string and the docs talk about. */
export const DEFAULT_COMATOSE_STUCK_FIRES = Math.ceil(DEFAULT_COMATOSE_WINDOW_MS / DEFAULT_STUCK_PARK_MS); // 24

/**
 * The comatose-host streak for a loop of THIS interval.
 *
 * WI-6660: this used to be a flat count of 24, described in its own comment as "~12h at the
 * ~30min stuck-park cadence". But the streak advances once per `stuckBackstopCadenceMs`, which
 * is `max(30min, interval*4)` — so a fixed count means the wall-clock scales with the loop's
 * interval, and the real range across the LIVE stranded population was 12h (180s loops) to 88h
 * (3300s loops). A 3.7-day wait is not what "~12h" promised, and the mismatch is actively
 * misleading: anyone measuring "did the stranded set clear?" on the documented horizon sees a
 * non-zero count and concludes the fix failed.
 *
 * So the budget is now the WALL CLOCK, and the count is DERIVED from it per interval. The
 * result is uniform (~12h everywhere) instead of interval-dependent.
 *
 * Two floors keep this conservative, so shortening the long tail cannot make it a hair-trigger:
 *  - `minStuckFiresForTermination()` — never terminate on fewer than a few real observations;
 *  - the caller's `circuitOpen` requirement (≥`circuitThreshold()`, default 8, consecutive
 *    failures), which for a long-interval loop is the BINDING constraint anyway: at a 220min
 *    cadence 8 fires is ~29h, so that population still gets far more than the 12h window.
 *
 * `PAPERCUSP_LOOP_COMATOSE_STUCK_FIRES` is preserved as an explicit fire-count override (it
 * still wins, and is still clamped to 3× the min-fires floor) so existing tuning keeps working.
 */
export function comatoseStuckFiresForTermination(intervalMs = 0): number {
  const envFires = Number(process.env.PAPERCUSP_LOOP_COMATOSE_STUCK_FIRES);
  if (Number.isFinite(envFires) && envFires >= 1) {
    return Math.max(Math.floor(envFires), minStuckFiresForTermination() * 3);
  }
  const fires = Math.ceil(comatoseWindowMs() / stuckBackstopCadenceMs(intervalMs));
  return Math.max(fires, minStuckFiresForTermination());
}

/**
 * Pure decision: breach only when the owner is unreachable, has been parked past the
 * terminal window, AND this fire is at least the configured minimum consecutive
 * stuck-backstop count. Each condition independently guards against a false positive
 * (a reachable owner, a not-yet-stale park, or a single blip never breaches).
 */
export function evaluateUnreachableTerminalGuard(input: {
  /** `probeWakeReachability(...).reachable` for the loop's target owner. */
  reachable: boolean;
  /** `probeWakeReachability(...).durableWhileAlive` — TRUE only for a genuinely live INJECTABLE
   *  channel (psu-socket / managed-pty). FALSE for the `resume` channel and for the non-reachable
   *  channels. WI-2339 (resumable-dead): distinguishes a live-injectable owner (always protected)
   *  from a resumable-but-DEAD owner — a dry-run `reachable:true` via `claude --resume` that the
   *  failing fire-circuit contradicts. Absent/undefined is treated as durable (protected) so an
   *  older caller that omits it keeps the pre-WI-2339 veto behavior. */
  durableWhileAlive?: boolean;
  /** How long the owner has been unreachable / the loop parked with no signal (ms). */
  parkedForMs: number;
  /** The loop's configured interval (ms) — used to floor the terminal window. */
  intervalMs: number;
  /** Consecutive stuck-backstop fires, INCLUDING the one under evaluation. */
  stuckFireCount: number;
  /** EI-7006 (Route A/C): the loop's fire-circuit is already OPEN (≥circuitThreshold consecutive
   *  failures). When set, the dwell-time terminal window is DECOUPLED — the accumulated failure
   *  streak is a stronger dead-owner signal than any wall-clock dwell, and (the bug this fixes) the
   *  circuit's ~hourly probe keeps `parkedForMs` pinned below the 2h window floor forever, so a
   *  window-gated guard would never breach and the dead loop climbs to 55→∞ fire-circuit-open EIs.
   *  Reachability (checked first) + the min-fires floor still gate it, so a healthy long turn —
   *  reachable, and never accruing a consecutive-error streak — is still never terminated. */
  circuitOpen?: boolean;
}): { breach: boolean; reason?: string } {
  // Reachability veto — with ONE exception (WI-2339, resumable-dead). A genuinely live INJECTABLE
  // channel (psu-socket / managed-pty; durableWhileAlive:true) ALWAYS protects the loop. But a
  // `resume`-channel reachability (durableWhileAlive:false) is only DRY-RUN optimism:
  // probeWakeReachability reports an ended+resumable session as reachable via `claude --resume`,
  // yet cannot see that those resume turns keep FAILING to produce a settled turn. When the
  // fire-circuit is OPEN (≥circuitThreshold REAL consecutive failures, fed by the reconcile
  // completion-signal), that failure streak is the AUTHORITATIVE dead-owner signal — so a
  // resume-only reachability no longer vetoes termination. A HEALTHY resumable loop between turns
  // keeps a CLOSED circuit (its resume turns settle → recordFire('ok')), so it never reaches here.
  const resumableDead = input.reachable && input.durableWhileAlive === false && input.circuitOpen === true;
  // WI-6639 (comatose-host) — the ONE case where a live INJECTABLE channel stops vetoing.
  // "A live host is not a dead session" was the stated rationale for the unconditional veto, and
  // MEASURED LIVE 2026-07-28 it is false: 12 loops whose psu-pty-host AND its `claude` child were
  // both genuinely alive (6-11d uptime, real listening socket — NOT the WI-2339 recycled-pid false
  // positive) had settled ZERO turns in 7d across 157 fires, with stale presence throughout. The
  // host is up; the AGENT inside it is wedged. Those loops re-armed and re-fired every ~30min
  // FOREVER because `reachable` short-circuits every death signal below.
  // This is deliberately NOT a weakening of the veto into a dwell/parked-time test — the
  // stuck-backstop re-arm RESETS last_fired_at, so `parkedForMs` can never accumulate past one
  // cycle for exactly this population. The consecutive stuck-backstop streak is the only monotone
  // evidence, and it only reaches this floor after ~12h of no settled turn and no presence beat,
  // which a healthy live session (it settles turns → recordFire('ok') → streak resets to 0) cannot
  // do. A merely SLOW live turn is excluded far earlier: the caller only counts a stuck-backstop
  // fire when presence has not moved at all since the fire.
  const comatoseHost =
    input.reachable &&
    input.circuitOpen === true &&
    input.stuckFireCount >= comatoseStuckFiresForTermination(input.intervalMs);
  if (input.reachable && !resumableDead && !comatoseHost) return { breach: false };
  // Classic (circuit-closed) path: require the full dwell window before terminating. Circuit-open
  // path (EI-7006): the dwell window is DECOUPLED — see the `circuitOpen` field doc above.
  if (!input.circuitOpen) {
    const window = terminalUnreachableMs(input.intervalMs);
    if (input.parkedForMs < window) return { breach: false };
  }
  const minFires = minStuckFiresForTermination();
  if (input.stuckFireCount < minFires) return { breach: false };
  const channelPhrase = resumableDead
    ? 'RESUMABLE-DEAD (probe reports reachable via `claude --resume`, but the resume turns never settle)'
    : comatoseHost
      ? 'COMATOSE-HOST (WI-6639: the injectable channel is genuinely live, but the agent behind it ' +
        `has settled no turn across ${input.stuckFireCount} consecutive stuck-backstop fires)`
      : 'unreachable (no injectable/resumable wake channel)';
  return {
    breach: true,
    reason: input.circuitOpen
      ? `dead-owner: ${channelPhrase} with fire-circuit OPEN across ` +
        `${input.stuckFireCount} consecutive failures — auto-paused (WI-1399 / EI-7006 circuit-open fast path, dwell window decoupled` +
        `${resumableDead ? '; WI-2339 resumable-dead' : ''}${comatoseHost ? '; WI-6639 comatose-host' : ''})`
      : `dead-owner: ${channelPhrase}, parked ${Math.round(input.parkedForMs / 1000)}s ` +
        `(≥${Math.round(terminalUnreachableMs(input.intervalMs) / 1000)}s terminal window) across ${input.stuckFireCount} consecutive stuck-backstop fires ` +
        `— auto-paused (WI-1399, dead-owner loop terminal guard)`,
  };
}

export interface UnreachableTerminalGuardDeps {
  /** Injected for tests; defaults to the real reachability probe. */
  probeReachability?: typeof probeWakeReachability;
  /** Injected for tests; defaults to the real auto-pause write. */
  autoPause?: typeof autoPauseLoopRoutine;
}

export interface UnreachableTerminalGuardResult {
  breach: boolean;
  reason?: string;
  /** The reachability verdict the decision was based on (diagnostics). Absent on a fail-soft probe error. */
  reachability?: WakeReachabilityVerdict;
}

/**
 * The IO wrapper the stuck-backstop branch consults: probe the owner's wake reachability,
 * evaluate the pure decision, and on breach auto-pause the routine. Fail-soft — a probe
 * error never throws and is treated as "still reachable" (no termination on an uncertain
 * read).
 */
export async function checkUnreachableTerminalGuard(
  input: {
    sql: Sql;
    routineId: string;
    targetOwnerId: string;
    parkedForMs: number;
    intervalMs: number;
    stuckFireCount: number;
    /** EI-7006: route a circuit-open loop past the dwell window (see evaluateUnreachableTerminalGuard). */
    circuitOpen?: boolean;
  },
  deps: UnreachableTerminalGuardDeps = {},
): Promise<UnreachableTerminalGuardResult> {
  const probeReachability = deps.probeReachability ?? probeWakeReachability;
  const autoPause = deps.autoPause ?? autoPauseLoopRoutine;

  let reachability: WakeReachabilityVerdict;
  try {
    reachability = await probeReachability(input.targetOwnerId);
  } catch {
    return { breach: false }; // fail-soft: an uncertain reachability read never terminates a loop
  }

  const verdict = evaluateUnreachableTerminalGuard({
    reachable: reachability.reachable,
    // WI-2339: pass the channel durability so a resumable-DEAD owner (reachable via `resume` but
    // whose fire-circuit is open) can be terminated, while a live-injectable owner stays protected.
    durableWhileAlive: reachability.durableWhileAlive,
    parkedForMs: input.parkedForMs,
    intervalMs: input.intervalMs,
    stuckFireCount: input.stuckFireCount,
    circuitOpen: input.circuitOpen,
  });
  if (verdict.breach) {
    await autoPause(input.sql, input.routineId, verdict.reason!);
  }
  return { ...verdict, reachability };
}
