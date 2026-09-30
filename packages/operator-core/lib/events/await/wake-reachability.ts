/**
 * wake-reachability — "if a wake fired RIGHT NOW (or as soon as this turn
 * settles), would it actually reach this owner as a fresh turn?"
 * (loop-reachability-intrinsic WI-655).
 *
 * This is the dry-run mirror of the wake-executor liveness ladder (executeWake)
 * PLUS the standing-await gate that sits in front of it. It exists so loop:arm
 * can make wake-reachability an INTRINSIC, VERIFIED property of arming a loop —
 * rather than the silent decoupling that let a resumed/curl-driven session arm a
 * loop, succeed, and then black-hole every fire as `no-session-now`.
 *
 * Two gates, in order:
 *   1. STANDING AWAIT — a wake emits on `coord:inbox-wake:<owner>`; if NO standing
 *      await is registered there, emitAwaitedEvent matches nothing (woken:0) and the
 *      loop fire records `no-session-now`. This is the root cause WI-655 found: the
 *      always-armed inbox-wake is re-armed at SessionStart, which a resumed/curl
 *      session never re-runs. loop:arm now arms it directly (armInboxWake), so this
 *      gate passes — but the probe still verifies it (and loop:status re-checks it
 *      later, when the SessionStart re-arm may have lapsed).
 *   2. CHANNEL — given a standing await, which executeWake channel WOULD the fire
 *      take: inject into a live psu-host socket / a live managed pty (delivered as a
 *      fresh turn while alive), resume an exited+resumable session (delivered after
 *      the process exits), or park as inbox-only (NOT a fresh turn — the dead zone).
 *
 * The derivation is PURE (unit-tested across every channel); `probeWakeReachability`
 * is the IO seam that gathers the same inputs executeWake reads. Both are
 * fail-soft: a read hiccup degrades a signal conservatively and never throws.
 */

import { captureWakeHandleForOwner } from './handle';
import { listActiveAwaitsForKey } from './store';
import { getAdvSession } from '../../adv-sessions';
import { findPtyByPid } from '../../pty-bridge';
import { getPresence } from '../../agent-tools/coordination/presence';
import { findLiveHost } from './psu-pty-discovery';
import { inboxWakeKey } from '../../agent-tools/coordination/inbox-wake';
import type { WakeHandle } from './types';

/** Which executeWake channel a wake WOULD take for this owner right now. */
export type WakeReachabilityChannel =
  /** Live psu-host control socket — inject in place as a fresh turn (works while alive; the best path). */
  | 'psu-socket'
  /** Live operator-owned managed pty at this pid — inject as a fresh turn. */
  | 'managed-pty'
  /** Exited (or about-to-exit) + resumable — resume as a fresh one-turn after the process exits. */
  | 'resume'
  /** Alive-but-uninjectable, or exited-unresumable-but-present — wakes PARK in the inbox (no fresh turn). */
  | 'inbox-only'
  /** No standing await and/or dead+unresumable — wakes match nothing / drop. */
  | 'none';

/** The raw per-owner signals the verdict consumes — injectable so the boundary unit-tests without PG/PTYs. */
export interface WakeReachabilityInput {
  /** A standing `coord:inbox-wake:<owner>` await exists → emit matches it (woken≥1). The first gate. */
  wakeable: boolean;
  /** Session row ended (adv_sessions.ended_at set). */
  ended: boolean;
  /** Recorded pid (null when none — hook-bootstrapped sessions). */
  pid: number | null;
  /** The recorded pid is alive (process.kill(pid,0)). Meaningless when pid is null. */
  pidAlive: boolean;
  /** A live psu-host control socket for this owner (interactive psu inject — executor channel 1b). */
  hasPsuHost: boolean;
  /** A live operator-owned managed pty at this pid for this owner (executor channel 1). */
  hasManagedPty: boolean;
  /** The captured handle is resumable (claude native id / omp thread id / codex uuid). */
  resumable: boolean;
  /** Presence row fresh (not stale, not revoked). */
  presenceFresh: boolean;
}

export interface WakeReachabilityVerdict {
  /** Will a wake be delivered as a FRESH TURN — now (inject) or once the process exits (resume)? */
  reachable: boolean;
  channel: WakeReachabilityChannel;
  /** True when the channel delivers even while the process stays alive (psu-socket / managed-pty);
   *  false for `resume` (only fires once the process exits) and the non-reachable channels. */
  durableWhileAlive: boolean;
  /** One honest line on the wake path — always present. */
  summary: string;
  /** Loud one-liner when reachability is absent or degraded — surface it in the tool result. */
  warning?: string;
  /**
   * WI-36685 — TRUE when the standing-await gate is the ONLY thing making this owner
   * unreachable: the session is otherwise live/injectable/resumable, so `armInboxWake`
   * alone restores delivery.
   *
   * WHY THIS EXISTS. Gate 1 below returns BEFORE consulting any liveness signal, so
   * `reachable:false, channel:'none'` is emitted identically for two states with opposite
   * remedies — "this session is gone" (channel 4, nothing live, nothing resumable) and
   * "this session is alive and injectable but nobody wired its doorbell". Every caller
   * therefore saw a repairable transport fault as a dead session. Measured on su-4a6e2255
   * (2026-08-08): a live psu-host socket the whole time — the eventual re-arm delivered via
   * `psu-socket-inject` 75s later — yet `wakeable:false` made every surface report it dead,
   * and `stalled-loops-guard` permanently disarmed it on that reading.
   *
   * `reachable` and `channel` are deliberately UNCHANGED: a wake right now genuinely would
   * not land, and the WI-655 contract ("no standing await ⇒ none, regardless of a live
   * resumable session") is asserted on purpose. This adds the distinction the verdict could
   * not previously express; it does not soften the verdict.
   *
   * Always `false` when `wakeable` was true — the gate was never the blocker.
   */
  awaitRepairable: boolean;
  /**
   * The channel a wake WOULD take once the missing await is re-armed. Null unless
   * `awaitRepairable` — an unreachable owner with no repair available has no such channel.
   */
  wouldBeChannel: WakeReachabilityChannel | null;
}

/**
 * PURE: the reachability verdict from the raw signals. Mirrors executeWake's channel
 * order exactly — psu-host socket (channel 1b) → live managed pty (channel 1) → resume
 * an exited session (channel 2) → park (inbox-only) → drop — fronted by the standing-await
 * gate (woken:0 ⇒ no-session-now). Injected inputs so it unit-tests without IO.
 */
export function deriveWakeReachability(i: WakeReachabilityInput): WakeReachabilityVerdict {
  // Gate 1 — the standing await. Without it, emitAwaitedEvent matches nothing (woken:0) and
  // the loop fire records `no-session-now` — the exact black-hole WI-655 found. Even a live,
  // injectable session is unreachable-by-wake if no inbox-wake await is registered for it.
  if (!i.wakeable) {
    // WI-36685 — ask what the ladder WOULD have said had the await been armed, by re-running
    // it once with the gate satisfied. Recursion rather than a duplicated ladder on purpose:
    // a second copy of the channel order is exactly the kind of thing that drifts from the
    // original, and this verdict's whole value is that it mirrors executeWake exactly.
    // Terminates trivially — the recursive call passes `wakeable: true`, so it can never
    // re-enter this branch.
    const asIfArmed = deriveWakeReachability({ ...i, wakeable: true });
    const repairable = asIfArmed.reachable;
    return {
      reachable: false,
      channel: 'none',
      durableWhileAlive: false,
      awaitRepairable: repairable,
      // Only a channel that delivers a FRESH TURN counts as a repair. `inbox-only` is
      // reachable:false for a reason — arming the await there would create a standing
      // subscription that still never produces a loop turn, while making the session read as
      // `wakeable` to every surface that checks (and pinning it against the idle-session
      // reaper, which counts a standing await as alive). A repair that only changes how the
      // problem LOOKS is worse than none.
      wouldBeChannel: repairable ? asIfArmed.channel : null,
      summary: repairable
        ? `no standing coord:inbox-wake await — a wake emit matches nothing (woken:0 → no-session-now), ` +
          `but the session is otherwise live and would be reachable via ${asIfArmed.channel} once re-armed`
        : 'no standing coord:inbox-wake await — a wake emit matches nothing (woken:0 → no-session-now)',
      // Both variants keep the original WI-655 phrasing ("no inbox-wake watch is armed" +
      // "no-session-now") — that is the diagnosis, and it is true in both cases. Repairability
      // ADDS the remedy; it does not replace the finding.
      warning: repairable
        ? `NOT wake-reachable: no inbox-wake watch is armed for this session, so loop fires black-hole ` +
          `as no-session-now — but this is REPAIRABLE, not a dead session: the process is alive and ` +
          `injectable and would take the ${asIfArmed.channel} channel the moment the watch is re-armed ` +
          `(armInboxWake / loop:arm). Do NOT read it as gone (WI-36685).`
        : 'NOT wake-reachable: no inbox-wake watch is armed for this session, so loop fires black-hole as no-session-now. (loop:arm now arms it directly; if you see this from loop:status, re-arm the loop.)',
    };
  }

  // Channel 1b — a live psu-host control socket injects in place regardless of alive/ended; the best path.
  if (i.hasPsuHost) {
    return {
      reachable: true,
      channel: 'psu-socket',
      durableWhileAlive: true,
      awaitRepairable: false,
      wouldBeChannel: null,
      summary: 'live psu-host control socket — wakes inject in place as a fresh turn',
    };
  }

  // Liveness exactly as executeWake: a recorded pid is authoritative; with no pid, fresh presence is the evidence.
  const alive = i.ended ? false : i.pid != null && i.pid > 0 ? i.pidAlive : i.presenceFresh;

  // Channel 1 — a live operator-owned managed pty at this pid injects as a fresh turn.
  if (alive && i.pid != null && i.pid > 0 && i.hasManagedPty) {
    return {
      reachable: true,
      channel: 'managed-pty',
      durableWhileAlive: true,
      awaitRepairable: false,
      wouldBeChannel: null,
      summary: 'live operator-owned managed pty — wakes inject as a fresh turn',
    };
  }

  // Channel 2 — resume. The executor resumes an EXITED session as a fresh one-turn; it never
  // concurrent-resumes a live one. For a loop (the wake arrives after the turn settles) a session
  // that exits between turns is reachable. The DEAD ZONE: a session that stays ALIVE in a terminal
  // we cannot inject (raw interactive TUI / curl-driven) — the executor parks it until the pid dies,
  // so a persistent process never receives the wake as a turn even though it is "resumable".
  if (i.resumable) {
    const persistentRisk = alive && !i.hasPsuHost && !i.hasManagedPty;
    return {
      reachable: true,
      channel: 'resume',
      durableWhileAlive: false,
      awaitRepairable: false,
      wouldBeChannel: null,
      summary:
        'resumable session — wakes resume it as a fresh one-turn after the current process exits',
      warning: persistentRisk
        ? 'Degraded wake path: this process is alive in a terminal we cannot inject (interactive TUI / curl-driven). Wakes PARK as inbox-only until it exits — a persistent process never receives the wake as a fresh loop turn. Arm the loop from a managed/console session, or ensure your process exits between turns.'
        : undefined,
    };
  }

  // Channel 3 — alive-but-uninjectable, or exited-unresumable but present: park as inbox-only (no fresh turn).
  if (alive || i.presenceFresh) {
    return {
      reachable: false,
      channel: 'inbox-only',
      durableWhileAlive: false,
      awaitRepairable: false,
      wouldBeChannel: null,
      summary:
        'alive but not injectable and not resumable — wakes PARK in your inbox (seen on your next natural turn), not delivered as a fresh loop turn',
      warning:
        'NOT wake-reachable as a fresh turn: no injectable channel and no resumable handle. Loop wakes sit in your inbox until something else wakes you — arm the loop from a managed/console/psu-hosted session.',
    };
  }

  // Channel 4 — nothing live, nothing resumable: drop.
  return {
    reachable: false,
    channel: 'none',
    durableWhileAlive: false,
    awaitRepairable: false,
    wouldBeChannel: null,
    summary: 'no live session and not resumable — wakes drop; relaunch required',
    warning: 'NOT wake-reachable: dead session, not resumable. Loop fires drop until you relaunch.',
  };
}

/** Mirror of handle.ts's resumability test (claude native id / omp thread / codex uuid). */
function isResumableHandle(h: Extract<WakeHandle, { kind: 'adv-session' }>): boolean {
  return Boolean(
    (h.agent === 'claude' && h.sessionId) ||
      (h.agent === 'omp' && h.ompThreadId) ||
      (h.agent === 'codex' && h.sessionId),
  );
}

function pidAliveDefault(pid: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface ProbeWakeReachabilityDeps {
  captureHandle?: typeof captureWakeHandleForOwner;
  getSession?: typeof getAdvSession;
  findPsuHost?: typeof findLiveHost;
  findPty?: typeof findPtyByPid;
  presence?: typeof getPresence;
  listAwaits?: typeof listActiveAwaitsForKey;
  alive?: (pid: number | null) => boolean;
}

/**
 * IO seam: gather the same signals executeWake reads for `ownerId` and return the
 * reachability verdict. Fully fail-soft — every read is independently guarded and a
 * failure degrades that one signal conservatively (a missing channel reads as absent),
 * so this never throws into the arm/status path.
 */
export async function probeWakeReachability(
  ownerId: string,
  deps: ProbeWakeReachabilityDeps = {},
): Promise<WakeReachabilityVerdict> {
  const captureHandle = deps.captureHandle ?? captureWakeHandleForOwner;
  const getSession = deps.getSession ?? getAdvSession;
  const findPsuHost = deps.findPsuHost ?? findLiveHost;
  const findPty = deps.findPty ?? findPtyByPid;
  const presence = deps.presence ?? getPresence;
  const listAwaits = deps.listAwaits ?? listActiveAwaitsForKey;
  const alive = deps.alive ?? pidAliveDefault;

  const [captured, awaits, pres] = await Promise.all([
    captureHandle(ownerId).catch(() => ({ handle: null, note: 'handle capture failed' })),
    listAwaits(inboxWakeKey(ownerId)).catch(() => [] as unknown[]),
    presence(ownerId).catch(() => null),
  ]);

  let hasPsuHost = false;
  try {
    hasPsuHost = !!findPsuHost(ownerId);
  } catch {
    hasPsuHost = false;
  }

  const handle =
    captured.handle && captured.handle.kind === 'adv-session'
      ? (captured.handle as Extract<WakeHandle, { kind: 'adv-session' }>)
      : null;
  const fresh = handle?.advSessionId != null ? await getSession(handle.advSessionId).catch(() => null) : null;
  const ended = fresh?.endedAt != null;
  const pid = fresh?.pid ?? handle?.pid ?? null;

  let hasManagedPty = false;
  if (pid != null && pid > 0) {
    try {
      hasManagedPty = !!findPty(pid, ownerId);
    } catch {
      hasManagedPty = false;
    }
  }

  const resumable = !!handle && !!handle.cwd && isResumableHandle(handle);
  const presenceFresh = !!pres && !pres.stale && !pres.revoked;
  const wakeable = Array.isArray(awaits) && awaits.length > 0;

  return deriveWakeReachability({
    wakeable,
    ended,
    pid,
    pidAlive: alive(pid),
    hasPsuHost,
    hasManagedPty,
    resumable,
    presenceFresh,
  });
}
