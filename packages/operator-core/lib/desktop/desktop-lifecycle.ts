/**
 * desktop-lifecycle — what to do with a desktop session nobody is driving.
 * (agent-virtual-desktops-2026-08-23 P-005 / WI-40868; extends P-003's registry.)
 *
 * ## Why this exists, in one measurement
 *
 * WI-5978 measured three QEMU guests on this box holding **12.8 cores — 11% of a
 * 128-core machine — continuously for 5 to 9 days while idle**. A fourth guest,
 * up LONGER than two of them, cost 0.1 cores. That fourth guest is the control,
 * and it is what makes this a bug rather than "VMs are expensive": a guest that
 * idles correctly costs approximately nothing. The other three were not working,
 * they were SPINNING — the signature of a guest whose idle loop never reaches
 * HLT.
 *
 * You cannot fix that from inside the guest, because the guest does not believe
 * it is idle. The host does. So the fix is a host-side governor that notices a
 * session nobody has driven and FREEZES its cgroup, which stops the spin at the
 * scheduler.
 *
 * ## Freeze, not kill — and why that ordering is the whole design
 *
 * Killing would also stop the spin. It would also destroy a desktop the agent may
 * be about to come back to, and for a guest that means throwing away state that
 * is expensive to rebuild. Freezing is the reversible form of the same fix, so
 * the ladder is:
 *
 *   ready  --idle after N--> idle    (bookkeeping only; nothing is suspended)
 *   idle   --still idle-->    frozen  (cgroup.freeze; the spin stops here)
 *   frozen --still frozen--> reaped  (thaw, kill the subtree, close the row)
 *
 * The middle rung matters: a short gap in an agent's loop costs a state flip
 * rather than a freeze/thaw round trip, and `touchDesktopSession` promotes `idle`
 * straight back to `ready` for free.
 *
 * ## ⚠ THE ORDERING TRAP — thaw before you kill
 *
 * `killTask` does NOT thaw first (verified in task-manager/control.ts: `setFrozen`
 * and `killTask` are independent, and nothing in the kill path touches the
 * freezer). Signals sent to a frozen cgroup are QUEUED, not delivered — the
 * processes are stopped at the scheduler and cannot run a handler. So a
 * SIGTERM into a frozen desktop appears to succeed, the scope never empties, and
 * the reap reports "signalled" against a subtree that is still holding its
 * display. Every reap of a frozen session therefore thaws FIRST. This is the one
 * detail in this file that is genuinely easy to get wrong and impossible to spot
 * from the outside, because the failure looks exactly like a slow shutdown.
 *
 * ## What it refuses to touch
 *
 * Mirrors gc-verify-instances' guard style, because the blast radius is the same
 * class: protected displays (`:0`/`:1`/`:2` — the owner's real desktop and the
 * conventional next seats), `scope: 'workspace'` sessions (D-002/D-005: the
 * product's own desktop, not an agent sandbox), and any session on another host.
 * A refusal is REPORTED, never silent — a permanently-skipped session that says
 * nothing is indistinguishable from a governor that is not running.
 */
import {
  TERMINAL_DESKTOP_STATES,
  type DesktopKind,
  type DesktopSessionRecord,
} from './desktop-session-registry';

/**
 * Displays this governor will never suspend or reap, whatever a row claims.
 * Deliberately the same set (and the same reasoning) as
 * `gc-verify-instances.PROTECTED_DISPLAYS`: `:0` is the owner's real desktop,
 * `:1`/`:2` the conventional next seats. Duplicated rather than imported because
 * the two sweeps are independent and neither should be able to widen the other's
 * refusal set by accident; the drift guard in the tests pins them together.
 */
export const PROTECTED_DISPLAYS: ReadonlySet<string> = new Set([':0', ':1', ':2']);

export type DesktopLifecycleAction = 'keep' | 'idle' | 'freeze' | 'reap';

export interface DesktopLifecyclePolicy {
  /** `ready` → `idle` after this long without activity. */
  idleAfterSec: number;
  /** `idle` → `frozen` after this long without activity (measured from
   *  last_active_at, so it INCLUDES the idle window — not stacked on top). */
  freezeAfterSec: number;
  /** `frozen` → reaped after this long frozen (measured from frozen_at). */
  reapAfterFrozenSec: number;
}

const HOUR = 3600;

/**
 * Per-kind thresholds. The asymmetry between kinds is the point, not an
 * oversight:
 *
 * - A **guest** (`vm-guest`, `microvm`) is frozen AGGRESSIVELY because an idle
 *   one can burn a whole core (WI-5978), and reaped LAZILY because its disk state
 *   is expensive to rebuild. Freeze early, destroy late.
 * - An **xvfb/bwrap sandbox** is frozen lazily because an idle X server costs a
 *   few MB and no CPU, so suspending it buys almost nothing while costing a
 *   thaw round trip on the next use. It is reaped sooner because rebuilding one
 *   is a couple of seconds.
 * - A **frame-slot** display belongs to an agent spawn and follows the sandbox
 *   shape; its real teardown rides the agent's own exit, and this is the backstop
 *   for when that never happens.
 * - A **kasmvnc** sandbox (P-012 / D-020) is an X server like the others, so the
 *   sandbox freeze/reap shape is right — with ONE deliberate difference: a HUMAN may
 *   be watching it through P-013's viewer. Freezing a desktop someone is looking at
 *   turns a live picture into a frozen one with no error anywhere, so the freeze
 *   threshold is raised to 4h to widen the margin for the case where the viewer's
 *   heartbeat is the only thing saying "in use". That is a backstop, not the
 *   mechanism: the real fix is D-008 rule 4 — a connected viewer heartbeats
 *   `last_active_at`, which keeps the session out of `idle` entirely, and P-014
 *   drops this hold back down once that heartbeat is landed and measured.
 *
 *   ⚠ STILL 4h ON PURPOSE, and the reason is worth stating because half of its
 *   retirement condition is now met. P-014 landed the mechanism: both viewer lanes
 *   heartbeat (see `desktopViewerHeartbeatMs` below) and both tear a dead stream
 *   down, which is what let `VIEWER_HOLD_SEC` drop from six hours to twenty
 *   minutes. What has NOT happened is the measurement of THE HEARTBEAT, and the
 *   distinction now matters, because a partial measurement exists that looks like
 *   the missing one:
 *
 *   ⛔ D-035 IS NOT THIS EVIDENCE — do not retire the backstop on it (WI-1267126).
 *   P-014's egress half HAS since run, and KasmVNC viewers did carry real frames
 *   end-to-end against a saturated encoder (~4,400 framebuffer updates, 2.1
 *   Gpixels per 72s session on a GPU-less 4-vCPU VM). But that rig was a MINIMAL
 *   relay that imported only the grant + loopback guard and then raw-piped the
 *   socket; it never went through `workspace-host/hosted-session-host.ts`, which
 *   is where the heartbeat actually lives. ZERO beats were emitted for the whole
 *   matrix, so it observed the ENCODER under load and told us nothing whatsoever
 *   about the heartbeat under load — which is the only thing this 4h margin is
 *   holding for.
 *
 *   What would actually retire it: a viewer driven through the PRODUCTION
 *   hosted-session-host adapter against a live KasmVNC encoder under load,
 *   showing `last_active_at` still advancing at the derived cadence while the
 *   encoder is saturated. The risk being covered is specific — the cadence is the
 *   shortest `idleAfterSec` / 5 (60s), so the documented tolerance is four
 *   consecutive missed beats, and a saturated event loop is exactly what could eat
 *   them. Retiring a backstop on the strength of unit tests, or of a measurement
 *   that bypassed the mechanism, is how a margin gets removed the week before it
 *   was needed. This drops to the 2h sandbox shape when THAT runs, not before.
 */
export const DESKTOP_LIFECYCLE_POLICY: Readonly<Record<DesktopKind, DesktopLifecyclePolicy>> = {
  'xvfb-local': { idleAfterSec: 15 * 60, freezeAfterSec: 2 * HOUR, reapAfterFrozenSec: 6 * HOUR },
  bwrap: { idleAfterSec: 15 * 60, freezeAfterSec: 2 * HOUR, reapAfterFrozenSec: 6 * HOUR },
  'frame-slot': { idleAfterSec: 15 * 60, freezeAfterSec: 2 * HOUR, reapAfterFrozenSec: 6 * HOUR },
  kasmvnc: { idleAfterSec: 15 * 60, freezeAfterSec: 4 * HOUR, reapAfterFrozenSec: 6 * HOUR },
  'vm-guest': { idleAfterSec: 5 * 60, freezeAfterSec: 20 * 60, reapAfterFrozenSec: 24 * HOUR },
  microvm: { idleAfterSec: 5 * 60, freezeAfterSec: 20 * 60, reapAfterFrozenSec: 24 * HOUR },
};

/** Fallback for a kind added to the registry without a policy entry — chosen to
 *  be the CONSERVATIVE one (slow to freeze, slow to reap) so a new kind can never
 *  inherit aggressive suspension by forgetting a line here. */
export const DEFAULT_DESKTOP_LIFECYCLE_POLICY: DesktopLifecyclePolicy = {
  idleAfterSec: 30 * 60,
  freezeAfterSec: 4 * HOUR,
  reapAfterFrozenSec: 24 * HOUR,
};

/**
 * A session stuck in `provisioning` for longer than this never came up — the
 * provisioner crashed between the INSERT and `markDesktopReady`. It holds a
 * display in the uniqueness index, so leaving it forever blocks that display for
 * every future lease. Generous relative to the 8s Xvfb ready timeout: a guest
 * boot is legitimately slow, and reaping a desktop that was still coming up is a
 * worse failure than a stale row.
 */
export const PROVISIONING_STUCK_SEC = 30 * 60;

/**
 * How many heartbeats must fit inside the SHORTEST idle window.
 *
 * Five, so a viewer survives four consecutive missed beats — a relay hiccup, a
 * paused event loop, a slow write — without its desktop being classified idle out
 * from under a person who is looking at it.
 */
export const DESKTOP_VIEWER_HEARTBEAT_DIVISOR = 5;

/**
 * The interval at which a connected viewer touches `last_active_at` (D-008 rule 4).
 *
 * DERIVED, never hardcoded. This file owns the idle thresholds, and this value is
 * only correct relative to the SMALLEST of them — so it is computed from that
 * table rather than restated as a constant that silently becomes wrong the day
 * someone lowers a kind's `idleAfterSec`. (Repo convention: a value that describes
 * another module's truth is derived, pinned, or attested — never hand-maintained.)
 *
 * The minimum is taken across EVERY kind plus the conservative default, not just
 * `kasmvnc`, because P-011's microvm desktops idle in 5 minutes and a viewer
 * attached to one of those must heartbeat fast enough for it too.
 *
 * It lives HERE rather than beside either viewer lane because both lanes now beat:
 * the hosted relay adapter (`workspace-host/hosted-session-host.ts`) and the local
 * WS bridge (`deployment/frame-vnc.ts`). A cadence derived from this file's policy
 * table, imported by both, is what keeps the two lanes from drifting apart.
 */
export function desktopViewerHeartbeatMs(
  policy: Readonly<Record<string, DesktopLifecyclePolicy>> = DESKTOP_LIFECYCLE_POLICY,
  fallback: DesktopLifecyclePolicy = DEFAULT_DESKTOP_LIFECYCLE_POLICY,
): number {
  const windows = [...Object.values(policy), fallback].map((entry) => entry.idleAfterSec);
  const shortestIdleSec = Math.min(...windows);
  return Math.floor((shortestIdleSec * 1000) / DESKTOP_VIEWER_HEARTBEAT_DIVISOR);
}

/**
 * The longest either viewer lane may take to notice its stream is dead and clear
 * the binding. It is a CEILING this file declares, not a window either lane owns:
 * each lane pins its own real constant against it in its own test, so a lane that
 * lengthens its teardown fails there instead of silently widening the hold below.
 *
 * Current lanes: `frame-vnc.VNC_STREAM_IDLE_MS` (local WS bridge) and
 * `hosted-session-host.HOSTED_HOST_SESSION_IDLE_MS` (hosted relay adapter).
 */
export const VIEWER_STREAM_TEARDOWN_CEILING_SEC = 15 * 60;

/**
 * Slack above the teardown ceiling, so the hold does not expire in the same beat
 * the lane is already tearing the stream down. Sized well above the heartbeat
 * cadence rather than at it: the point is that a hold never lapses on a viewer a
 * lane is about to clear anyway.
 */
export const VIEWER_HOLD_MARGIN_SEC = 5 * 60;

/**
 * How long a viewer binding defers governance. An active viewer (`watch` /
 * `takeover`) means a human is looking at this desktop, and freezing it under
 * them would be indistinguishable from a crash — so a bound viewer holds the
 * governor off.
 *
 * ⚠ WHY THIS IS DERIVED, AND WHY IT USED TO BE SIX HOURS. The sizing follows from
 * what the binding MEANS, and for most of this file's life the binding meant very
 * little: `frame-vnc` bound the viewer when the stream opened and cleared it on
 * teardown, and nothing wrote the row in between. The activity clock therefore
 * marked the START of a viewing session, not its liveness, so a bound viewer quiet
 * for 40 minutes was overwhelmingly a person still watching rather than a stale
 * flag. A short bound would have frozen a desktop out from under a live 31-minute
 * VNC session — the exact "indistinguishable from a crash" failure this hold
 * exists to prevent, and a real defect in the first cut of this file (caught by a
 * test; the bound was 30 minutes). Six hours was the correct backstop for a
 * binding nobody could trust.
 *
 * P-014 changed the premise rather than the number. BOTH lanes now heartbeat
 * `last_active_at` every `desktopViewerHeartbeatMs()` while a viewer is attached
 * (D-008 rule 4), and BOTH tear the stream down — and so clear the binding — when
 * it stops carrying viewer traffic. A bound viewer is therefore a LIVE viewer, and
 * what remains to be covered is only the residue: the window in which a lane has
 * not yet noticed its stream died. So the hold is that ceiling plus a margin, not
 * a guess at how long a person watches. It is derived from the two constants above
 * so it cannot drift away from the lanes it is protecting.
 *
 * Still bounded, for the same reason as before: teardown can be skipped outright
 * if the operator process dies mid-session, and an unbounded hold would let one
 * stuck flag leak a desktop forever. The difference is that the leak now costs
 * twenty minutes instead of an evening.
 */
export const VIEWER_HOLD_SEC = VIEWER_STREAM_TEARDOWN_CEILING_SEC + VIEWER_HOLD_MARGIN_SEC;

export interface DesktopVerdict {
  id: string;
  action: DesktopLifecycleAction;
  /** Human-readable, and written to be read in a log line at 3am. */
  reason: string;
  /** True when the verdict is a REFUSAL — a protected or out-of-scope session the
   *  governor declines to act on, as opposed to one that is simply still busy.
   *  Reported separately so a permanently-skipped session stays visible. */
  refused?: boolean;
}

export function policyFor(kind: DesktopKind): DesktopLifecyclePolicy {
  return DESKTOP_LIFECYCLE_POLICY[kind] ?? DEFAULT_DESKTOP_LIFECYCLE_POLICY;
}

function ageSec(from: Date | null | undefined, nowMs: number): number {
  if (!from) return 0;
  return Math.max(0, (nowMs - new Date(from).getTime()) / 1000);
}

/**
 * The whole decision, as a pure function of the row and the clock.
 *
 * Pure so the ladder can be tested exhaustively without a database, a cgroup or a
 * VM — and so the thresholds above are falsifiable rather than asserted. The
 * ORDER of the checks is load-bearing and is the reason this is one function
 * rather than a chain of predicates: refusals must win over expiry, and expiry
 * must win over the idle ladder.
 */
export function classifyDesktopSession(
  session: DesktopSessionRecord,
  nowMs: number,
  policyOverride?: Partial<DesktopLifecyclePolicy>,
): DesktopVerdict {
  const { id } = session;

  // 0. Terminal rows are not the governor's business. Callers filter these out,
  //    but a defensive branch beats a governor that "freezes" a released session.
  if (TERMINAL_DESKTOP_STATES.includes(session.state)) {
    return { id, action: 'keep', reason: `already ${session.state}` };
  }

  // 1. REFUSALS FIRST — these outrank every clock, including an expired TTL.
  //    A protected display with a stale TTL is still the owner's real desktop.
  if (PROTECTED_DISPLAYS.has(session.display)) {
    return {
      id,
      action: 'keep',
      reason: `refusing to govern protected display ${session.display}`,
      refused: true,
    };
  }
  if (session.scope === 'workspace') {
    return {
      id,
      action: 'keep',
      reason:
        "refusing to govern a scope='workspace' desktop — that is the product's own " +
        'desktop (D-002/D-005), not an agent sandbox',
      refused: true,
    };
  }

  const policy = { ...policyFor(session.kind), ...policyOverride };
  const idleAfterSec = session.idleAfterSec ?? policy.idleAfterSec;
  const inactiveSec = ageSec(session.lastActiveAt, nowMs);

  // 2. A session that never finished provisioning holds a display in the
  //    uniqueness index and will never come up. Ahead of the viewer hold: nothing
  //    can be watching a desktop that never started.
  if (session.state === 'provisioning') {
    return ageSec(session.createdAt, nowMs) > PROVISIONING_STUCK_SEC
      ? {
          id,
          action: 'reap',
          reason: `stuck in provisioning for ${Math.round(ageSec(session.createdAt, nowMs) / 60)}m — it never came up`,
        }
      : { id, action: 'keep', reason: 'still provisioning' };
  }

  // 3. A bound viewer holds everything off — but only while the binding is being
  //    refreshed. See VIEWER_HOLD_SEC for why this is not unbounded.
  const viewerHolds = session.viewerMode !== 'none' && inactiveSec <= VIEWER_HOLD_SEC;
  if (viewerHolds) {
    return {
      id,
      action: 'keep',
      reason: `viewer bound (${session.viewerMode}${session.viewerActor ? ` by ${session.viewerActor}` : ''})`,
    };
  }

  // 4. An expired lease is reaped regardless of where it sits on the idle ladder.
  //    The TTL is the holder's own declaration of how long it wanted the desktop;
  //    honouring it is not a judgement call about business.
  if (session.ttlSec !== null && inactiveSec > session.ttlSec) {
    return {
      id,
      action: 'reap',
      reason: `lease expired — ttl ${session.ttlSec}s, unrenewed for ${Math.round(inactiveSec)}s`,
    };
  }

  // 5. Frozen sessions age out of the freezer into a reap.
  if (session.state === 'frozen') {
    const frozenSec = ageSec(session.frozenAt, nowMs);
    return frozenSec > policy.reapAfterFrozenSec
      ? {
          id,
          action: 'reap',
          reason: `frozen and untouched for ${Math.round(frozenSec / 60)}m (> ${Math.round(policy.reapAfterFrozenSec / 60)}m)`,
        }
      : { id, action: 'keep', reason: `frozen ${Math.round(frozenSec / 60)}m ago` };
  }

  // 6. The idle ladder.
  if (inactiveSec > policy.freezeAfterSec) {
    return {
      id,
      action: 'freeze',
      reason: `idle ${Math.round(inactiveSec / 60)}m (> ${Math.round(policy.freezeAfterSec / 60)}m) — suspending to stop it burning CPU`,
    };
  }
  if (session.state === 'ready' && inactiveSec > idleAfterSec) {
    return {
      id,
      action: 'idle',
      reason: `no activity for ${Math.round(inactiveSec / 60)}m (> ${Math.round(idleAfterSec / 60)}m)`,
    };
  }
  return { id, action: 'keep', reason: `active ${Math.round(inactiveSec)}s ago` };
}
