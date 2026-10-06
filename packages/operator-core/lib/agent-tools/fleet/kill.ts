/**
 * fleet:kill — the UNIFIED agent-termination endpoint (WI-3728, owner-directed
 * 2026-07-10): kill a DESKTOP agent (interactive psu session in a visible
 * terminal) or a HEADLESS agent (nursery cup/bee) through ONE verb, with
 * `close_terminal` controlling whether an interactive agent's terminal WINDOW
 * is also closed. A managed headless psu host shares the same termination
 * substrate but reports `kind:'headless'` / `terminal:'none'` and never touches
 * terminal ancestry.
 *
 * Why one endpoint (owner design call): "killing is similar to close" — the
 * split surfaces before this were fleet:cancel (headless nursery subtrees
 * ONLY — it REFUSES interactive sessions) and NOTHING for desktop terminals
 * (stale fleet windows accumulated on the owner's desktop forever). fleet:kill
 * resolves each target's kind and routes:
 *
 *   - nursery spawn (spawn_id or session_owner match in
 *     harness_shared.spawned_agents) → the EXISTING cancelSubtree path
 *     (transitive cancel + claim/lock release + local process abort) — reuse,
 *     not a parallel system. `close_terminal` is meaningless here (headless)
 *     and reported as terminal:'none'.
 *
 *   - desktop psu session (live psu-pty host discovered by coord ownerId) →
 *     graceful SIGTERM to the session host process (escalating to SIGKILL if
 *     it lingers), and when `close_terminal` (default true) ALSO closes the
 *     enclosing terminal window. The window does NOT close on its own: the
 *     launch command ends with `exec $SHELL -l`, so after psu exits the tab
 *     drops to an interactive shell and sits there forever — closing means
 *     killing the tab's shell process, which we resolve by walking the psu
 *     host's ancestry BEFORE killing it (afterwards the link is gone).
 *
 *   - bare terminal window (`terminal_pids`) → close an ORPHANED/stale fleet
 *     window whose agent already exited (the post-`exec` shell). Validated:
 *     the pid must carry the papercusp console env marker
 *     (PAPERCUSP_HARNESS_SLUG in /proc/<pid>/environ) so this can never be
 *     aimed at an arbitrary host process.
 *
 * Safety (mirrors turn:interrupt D-008/D-009 + process-kill.ts): self-kill
 * refused; a REQUIRED reason; every kill audited (who → whom / kind / outcome)
 * to harness_shared.audit_log; bulk capped. Same-UID is the OS boundary — the
 * authorization/attribution layer is HERE, operator-mediated.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { readFileSync } from 'node:fs';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  findLiveHost,
  sessionClassForHost,
  type PsuPtyHost,
} from '../../events/await/psu-pty-discovery';
import { clearPresence, getPresence, PRESENCE_STALE_MS } from '../coordination/presence';
import { mergeIds, runBulk, bulkContent } from '@papercusp/agent-mcp/_bulk';
import { softText, clampText } from '../limits';
import { readProcessIdentity } from '../../process-identity';
import {
  hasAdvSessionTerminalEvidence,
  latestAdvSessionByCoordOwner,
  markAdvSessionEnded,
  repairStaleAdvSessionTerminalMarkers,
} from '../../adv-sessions';
import { deactivateLoop } from '../../harness/routines/loop';
import { resolveSessionStates } from '../coordination/liveness-oracle';
import type { RefusalContract } from '../../capability-envelope/identity-refusal-contract';
import type { SessionState } from '../coordination/presence-wakeability';

/** Console-marker substring stamped into every fleet/desktop launch command
 *  (capability:terminal / fleet:launch-on-plan) — identifies a papercusp tab
 *  shell's cmdline while psu is still running. */
const CONSOLE_MARKER = '.papercup-console-active';

const CONSOLE_IDENTITY_ENV = 'PAPERCUSP_CONSOLE_IDENTITY';

const KILL_WAIT_POLLS = 6;
const KILL_WAIT_MS = 250;

// ── injectable process primitives (the DI seam, mirrors turn/interrupt) ──

export interface ProcInfo {
  ppid: number | null;
  cmdline: string | null;
  /** Current kernel-backed boot + process-start identity. */
  processIdentity: string | null;
  environmentValue: (name: string) => string | null;
}

export interface KillDeps {
  /** Live psu-pty host for a coord ownerId (null = no live interactive session). */
  findHost?: (ownerId: string) => PsuPtyHost | null;
  /** Fresh presence for a session that is alive but has no operator-managed
   *  host handle (currently OMP hook sessions). */
  findLiveUnmanaged?: (
    ownerId: string,
  ) => Promise<LiveUnmanagedSession | null> | LiveUnmanagedSession | null;
  /** Read a pid's ppid/cmdline/environ; null when the pid is gone. */
  readProc?: (pid: number) => ProcInfo | null;
  /** Send a signal; true when delivered. */
  kill?: (pid: number, signal: NodeJS.Signals) => boolean;
  /** Is the pid alive? */
  alive?: (pid: number) => boolean;
  /** Resolve+cancel a nursery target (spawn_id or session_owner). Returns null
   *  when the target is not a nursery spawn. */
  cancelNursery?: (
    target: string,
    reason: string,
  ) => Promise<{ spawn_id: string; cancelled: string[]; processes_aborted: number } | null>;
  /** Purge stale presence after the psu-host authority proves a target is gone. */
  clearPresence?: (ownerId: string) => Promise<void>;
  /** Stop the owner's recurring wake before presence is removed. Without this,
   *  the compaction watchdog treats the missing row as a dark-presence gap and
   *  recreates it from the still-active loop routine. */
  deactivateLoop?: (ownerId: string, reason: string) => Promise<boolean>;
  /** Postcondition read for the dead-owner presence reap. */
  presenceExists?: (ownerId: string) => Promise<boolean>;
  /** Free delegated-seat consumption after the same authoritative death proof. */
  releaseSeatConsumptions?: (ownerIds: string[]) => Promise<void>;
  /** Append an audit row. */
  audit?: (action: string, subject: string, details: Record<string, unknown>) => Promise<void>;
  /** Atomically stamp the terminal tuple after this endpoint confirms the host died. */
  markSessionEnded?: (id: string, signal: 'SIGTERM' | 'SIGKILL') => Promise<void>;
  /** Repair an observer-written terminal marker before unmanaged liveness is read. */
  repairStaleAdvSessionTerminalMarkers?: (ownerId: string) => Promise<number>;
  sleep?: (ms: number) => Promise<void>;
}

export interface KillOneInput {
  actor: string;
  target: string;
  closeTerminal: boolean;
  reason: string;
}

export interface LiveUnmanagedSession {
  source: string;
  heartbeatAt: string | null;
}

const POSITIVE_UNMANAGED_SESSION_STATES: ReadonlySet<SessionState> = new Set([
  'live',
  'parked',
  'draining',
  'recorded',
]);

/** A fresh OMP heartbeat is only a candidate for preservation. The shared
 * liveness oracle must positively establish a live turn, wakeable session, or
 * recorded live session before fleet:kill refuses to reap it. */
export function isPositiveUnmanagedSessionState(
  sessionState: SessionState | null | undefined,
): boolean {
  return sessionState != null && POSITIVE_UNMANAGED_SESSION_STATES.has(sessionState);
}

export interface KillOneResult {
  ok: boolean;
  target: string;
  kind?: 'desktop' | 'headless' | 'nursery' | 'unmanaged';
  killed?: boolean;
  signal?: 'SIGTERM' | 'SIGKILL';
  /** 'closed' | 'left-open' (close_terminal:false) | 'none' (headless) | 'not-found'. */
  terminal?: 'closed' | 'left-open' | 'none' | 'not-found';
  cancelled?: string[];
  processes_aborted?: number;
  code?: 'self_kill_refused' | 'not_found' | 'live_unmanaged' | 'cleanup_failed';
  error?: string;
  /** WI-10005197: what would LIFT a refusal. Present on `self_kill_refused` (the authority refusal). */
  refusal?: RefusalContract;
}

const defaultReadProc = (pid: number): ProcInfo | null => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // stat: "pid (comm) state ppid …" — comm may contain spaces/parens; parse after the LAST ')'.
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(after[1]);
    let cmdline: string | null = null;
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    } catch {
      cmdline = null;
    }
    let environ: string | null = null;
    const readEnviron = (): string | null => {
      if (environ !== null) return environ;
      try {
        environ = readFileSync(`/proc/${pid}/environ`, 'utf8').replace(/\0/g, '\n');
        return environ;
      } catch {
        return null;
      }
    };
    return {
      ppid: Number.isFinite(ppid) ? ppid : null,
      cmdline,
      processIdentity: readProcessIdentity(pid),
      environmentValue: (name: string) => {
        const prefix = `${name}=`;
        const entry = readEnviron()
          ?.split('\n')
          .find((line) => line.startsWith(prefix));
        return entry ? entry.slice(prefix.length) : null;
      },
    };
  } catch {
    return null;
  }
};

const defaultKill = (pid: number, signal: NodeJS.Signals): boolean => {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
};

const defaultAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Walk UP from the psu host pid to the terminal TAB SHELL — the topmost
 * ancestor whose cmdline carries the papercusp console marker. Must run
 * BEFORE the host is killed (afterwards the chain is gone). Bounded walk;
 * null when no marked ancestor exists (e.g. psu launched from the user's own
 * shell — then there is NO fleet-owned window and we must NOT close anything).
 */
export function findTabShellPid(hostPid: number, readProc: (pid: number) => ProcInfo | null): number | null {
  let pid = hostPid;
  let found: number | null = null;
  for (let hop = 0; hop < 12; hop++) {
    const info = readProc(pid);
    if (!info || !info.ppid || info.ppid <= 1) break;
    const parent = readProc(info.ppid);
    if (parent?.cmdline?.includes(CONSOLE_MARKER)) found = info.ppid; // keep climbing — topmost marked wins
    pid = info.ppid;
  }
  return found;
}

/** Graceful-then-forceful process stop: SIGTERM, poll, SIGKILL if lingering. */
async function stopPid(
  pid: number,
  deps: Required<Pick<KillDeps, 'kill' | 'alive' | 'sleep'>>,
): Promise<'SIGTERM' | 'SIGKILL' | null> {
  if (!deps.alive(pid)) return null;
  deps.kill(pid, 'SIGTERM');
  for (let i = 0; i < KILL_WAIT_POLLS; i++) {
    if (!deps.alive(pid)) return 'SIGTERM';
    await deps.sleep(KILL_WAIT_MS);
  }
  deps.kill(pid, 'SIGKILL');
  return 'SIGKILL';
}

/**
 * Reconcile the durable wake + ephemeral roster state for an owner whose
 * process is proven dead. The order is load-bearing: an active loop routine is
 * the compaction watchdog's authority to recreate a missing coord_presence row,
 * so the loop must be deactivated before the row is deleted. The final read
 * keeps fleet:kill from reporting `not_found`/success while the roster still
 * contains the supposedly-dead owner.
 */
async function reapDeadOwner(input: KillOneInput, deps: KillDeps): Promise<string | null> {
  try {
    await deps.deactivateLoop?.(input.target, input.reason);
  } catch (error) {
    return `could not deactivate the owner's loop before presence cleanup: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }

  try {
    await deps.clearPresence?.(input.target);
  } catch (error) {
    return `could not delete the owner's presence row: ${error instanceof Error ? error.message : String(error)}`;
  }

  try {
    if (await deps.presenceExists?.(input.target)) {
      return 'presence cleanup postcondition failed: the owner still has a coord_presence row';
    }
  } catch (error) {
    return `could not verify the presence cleanup postcondition: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }

  // EI-20348469225868168: fleet:kill is an explicit reap for this dead
  // owner. Mirror presence-reaper's delegated-seat cleanup after the
  // load-bearing loop/presence reconciliation succeeds.
  await deps.releaseSeatConsumptions?.([input.target]).catch(() => {});
  return null;
}

/** The testable core — never throws; every failure is a structured result. */
export async function killOne(input: KillOneInput, deps: KillDeps): Promise<KillOneResult> {
  const audit = deps.audit ?? (async () => {});
  const readProc = deps.readProc ?? defaultReadProc;
  const prims = {
    kill: deps.kill ?? defaultKill,
    alive: deps.alive ?? defaultAlive,
    sleep: deps.sleep ?? defaultSleep,
  };

  if (input.target === input.actor) {
    return {
      ok: false,
      target: input.target,
      code: 'self_kill_refused',
      error: 'refusing to kill your own session — end your turn / loop:end instead',
      refusal: {
        observed: { target: input.target, actor: input.actor },
        liftsWhen:
          'the target is a session other than the caller (target !== actor). To stop yourself, end your turn or call ' +
          'loop:end (an armed loop is what keeps a session waking) — fleet:kill cannot tear down the session that is ' +
          'issuing it; another agent or the owner can kill this session if it must be force-stopped',
        whoCanMakeItTrue: ['another-agent', 'owner'],
      },
    };
  }

  // ── leg 1: nursery (headless) — the existing cancel machinery, reused ──
  const nursery = await (deps.cancelNursery?.(input.target, input.reason).catch(() => null) ?? Promise.resolve(null));
  if (nursery) {
    await audit('fleet.kill_nursery', input.target, {
      reason: input.reason,
      spawn_id: nursery.spawn_id,
      cancelled: nursery.cancelled.length,
    });
    return {
      ok: true,
      target: input.target,
      kind: 'nursery',
      killed: true,
      cancelled: nursery.cancelled,
      processes_aborted: nursery.processes_aborted,
      terminal: 'none',
    };
  }

  // ── leg 2: desktop interactive psu session ──
  const host = deps.findHost?.(input.target) ?? null;
  if (!host) {
    // `ended_by` is terminal evidence even when a crash/reconciler left
    // `ended_at` unset. Heal that split-brain tuple before presence can classify
    // an already-dead OMP session as live unmanaged.
    try {
      await deps.repairStaleAdvSessionTerminalMarkers?.(input.target);
    } catch {
      /* fail-soft: the authoritative adv-session read below still wins */
    }

    // OMP-hook sessions declare presence directly but do not have a psu-pty
    // discovery socket for fleet:kill to own. Do not mistake that missing
    // process handle for death: preserving the fresh presence row is safer
    // than clearing a live, wakeable peer. The current-turn stop primitive is
    // turn:interrupt; a peer cannot safely SIGTERM an unmanaged OMP process.
    const unmanaged = await Promise.resolve(deps.findLiveUnmanaged?.(input.target) ?? null).catch(() => null);
    if (unmanaged) {
      await audit('fleet.kill_unmanaged', input.target, {
        reason: input.reason,
        source: unmanaged.source,
        heartbeat_at: unmanaged.heartbeatAt ?? undefined,
      });
      return {
        ok: false,
        target: input.target,
        kind: 'unmanaged',
        killed: false,
        terminal: 'not-found',
        code: 'live_unmanaged',
        error:
          `live ${unmanaged.source} session has no managed psu-pty host; no signal was sent and ` +
          'its presence was preserved. Safe stop for its current turn: `turn:interrupt` ' +
          '`{ owner, mode: "force", reason }` (the session remains resumable).',
      };
    }

    // A dead host can leave both an active loop routine and a fresh roster row
    // behind. Quiesce the durable wake source first, then remove and verify the
    // ephemeral presence row. Reporting `not_found` while this cleanup failed
    // would let fleet:respawn-member launch into a still-live roster identity.
    const cleanupError = await reapDeadOwner(input, deps);
    if (cleanupError) {
      await audit('fleet.kill_cleanup_failed', input.target, {
        reason: input.reason,
        stage: 'already-dead-reap',
        error: cleanupError,
      });
      return {
        ok: false,
        target: input.target,
        code: 'cleanup_failed',
        error: cleanupError,
      };
    }
    return {
      ok: false,
      target: input.target,
      code: 'not_found',
      error:
        'no live session: not a nursery spawn and no live psu-pty host for this ownerId — already dead/exited. ' +
        'A leftover WINDOW from an exited agent can be closed via `terminal_pids` (see the launch report or .papercup-console-active.<pid> marker files for the pid).',
    };
  }

  // bridgeTty:false is the canonical, host-authored proof that this managed psu
  // session has no human terminal. Older hosts omit the field and therefore
  // retain the safe interactive fallback supplied by sessionClassForHost.
  const sessionClass = sessionClassForHost(host);
  const headless = sessionClass === 'claude-headless';
  const kind: NonNullable<KillOneResult['kind']> = headless ? 'headless' : 'desktop';

  // Resolve a window BEFORE killing only when one can exist (the ancestry link
  // dies with the host). A headless member must never inherit desktop residue
  // semantics merely because it uses the same managed psu-pty host substrate.
  const tabShellPid = !headless && input.closeTerminal ? findTabShellPid(host.pid, readProc) : null;
  const discoveryTerminalPid =
    !headless && input.closeTerminal && Number.isSafeInteger(host.terminalPid) && (host.terminalPid ?? 0) > 1
      ? host.terminalPid!
      : null;

  const signal = (await stopPid(host.pid, prims)) ?? 'SIGTERM';
  if (host.ptyPid && host.ptyPid !== host.pid && prims.alive(host.ptyPid)) {
    prims.kill(host.ptyPid, 'SIGTERM');
  }

  // The launcher normally reports its own exit, but killing its host can sever that
  // best-effort callback before it reaches the operator. The kill endpoint already has
  // authoritative proof that the process is gone, so stamp the complete terminal tuple
  // here instead of leaving an internally contradictory ended_by-only row behind.
  if (host.advSessionId != null) {
    await deps.markSessionEnded?.(host.advSessionId, signal).catch(() => {});
  }

  // The process is now authoritatively dead. Stop its recurring wake before
  // deleting presence so the compaction watchdog cannot heal the row back.
  const cleanupError = await reapDeadOwner(input, deps);

  let terminal: KillOneResult['terminal'] = headless ? 'none' : 'left-open';
  let terminalPidSource: 'ancestry' | 'discovery' | null = null;
  let terminalCloseError: string | null = null;
  if (!headless && input.closeTerminal) {
    if (tabShellPid) {
      // SIGHUP first (the "window closed" signal a shell expects), then TERM.
      prims.kill(tabShellPid, 'SIGHUP');
      await prims.sleep(KILL_WAIT_MS);
      if (prims.alive(tabShellPid)) prims.kill(tabShellPid, 'SIGTERM');
      terminal = 'closed';
      terminalPidSource = 'ancestry';
    } else if (discoveryTerminalPid) {
      const closed = await closeTerminalPid(discoveryTerminalPid, {
        readProc,
        kill: prims.kill,
        alive: prims.alive,
        sleep: prims.sleep,
      });
      terminal = closed.ok ? 'closed' : 'not-found';
      terminalPidSource = 'discovery';
      terminalCloseError = closed.error ?? null;
    } else {
      terminal = 'not-found';
    }
  }

  await audit(headless ? 'fleet.kill_headless' : 'fleet.kill_desktop', input.target, {
    reason: input.reason,
    host_pid: host.pid,
    signal,
    session_class: sessionClass,
    terminal,
    tab_shell_pid: tabShellPid ?? discoveryTerminalPid ?? undefined,
    terminal_pid_source: terminalPidSource ?? undefined,
    terminal_close_error: terminalCloseError ?? undefined,
    cleanup_error: cleanupError ?? undefined,
  });
  if (cleanupError) {
    return {
      ok: false,
      target: input.target,
      kind,
      killed: true,
      signal,
      terminal,
      code: 'cleanup_failed',
      error: `session process was killed, but durable cleanup is incomplete: ${cleanupError}`,
    };
  }
  return { ok: true, target: input.target, kind, killed: true, signal, terminal };
}

/** Close a bare (agent-already-exited) fleet terminal window by tab-shell pid.
 *  Gate: the pid MUST carry the papercusp console env marker — never a lever
 *  against arbitrary host processes. Exported for tests. */
export async function closeTerminalPid(
  pid: number,
  deps: Pick<KillDeps, 'readProc' | 'kill' | 'alive' | 'sleep'>,
): Promise<{ ok: boolean; pid: number; closed?: boolean; error?: string }> {
  const readProc = deps.readProc ?? defaultReadProc;
  const prims = {
    kill: deps.kill ?? defaultKill,
    alive: deps.alive ?? defaultAlive,
    sleep: deps.sleep ?? defaultSleep,
  };
  const info = readProc(pid);
  if (!info) return { ok: false, pid, error: 'pid not found' };
  const recordedIdentity = info.environmentValue(CONSOLE_IDENTITY_ENV);
  const marked = Boolean(info.environmentValue('PAPERCUSP_HARNESS_SLUG')) && Boolean(recordedIdentity);
  if (!marked || !info.processIdentity || recordedIdentity !== info.processIdentity) {
    return {
      ok: false,
      pid,
      error:
        'refused: pid does not carry a matching papercusp console birth identity ' +
        '(harness marker + boot id + process start time are all required)',
    };
  }
  const cmdline = (info.cmdline ?? '').toLowerCase();
  if (/\b(systemd|gnome-shell|gdm|plasmashell|login|launchd|windowserver)\b/.test(cmdline)) {
    return { ok: false, pid, error: 'refused: protected desktop/session process' };
  }

  // Re-read immediately before each signal. If the shell exits and its pid is
  // recycled during the grace interval, the replacement never receives TERM.
  const stillSameConsole = (): boolean => {
    const current = readProc(pid);
    return Boolean(
      current &&
      current.processIdentity === recordedIdentity &&
      Boolean(current.environmentValue('PAPERCUSP_HARNESS_SLUG')) &&
      current.environmentValue(CONSOLE_IDENTITY_ENV) === recordedIdentity,
    );
  };
  if (!stillSameConsole()) return { ok: false, pid, error: 'refused: process identity changed before signal delivery' };
  prims.kill(pid, 'SIGHUP');
  await prims.sleep(KILL_WAIT_MS);
  if (prims.alive(pid) && stillSameConsole()) prims.kill(pid, 'SIGTERM');
  return { ok: true, pid, closed: true };
}

// ── production wiring ──

async function writeKillAudit(
  action: string,
  subject: string,
  details: Record<string, unknown>,
  workspaceId: string,
  actor: string,
): Promise<void> {
  // Mirror process-kill.ts / turn:interrupt — inline INSERT into the table
  // audit:list reads; audit failures never block the operation.
  try {
    const { sql } = getOrgPg();
    const id = `fleetkill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await sql.unsafe(
      `INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [id, Date.now(), actor, action, subject, JSON.stringify(details), workspaceId],
    );
  } catch (err) {
    console.warn('[fleet:kill] audit write failed:', err);
  }
}

async function cancelNurseryTarget(
  target: string,
  reason: string,
  workspaceId: string,
  actor: ReturnType<typeof resolveAgentIdentity>,
): Promise<{ spawn_id: string; cancelled: string[]; processes_aborted: number } | null> {
  const { sql } = getOrgPg();
  const rows = await sql<{ spawn_id: string }[]>`
    SELECT spawn_id
      FROM harness_shared.spawned_agents
     WHERE workspace_id = ${workspaceId}
       AND (spawn_id = ${target} OR session_owner = ${target})
     ORDER BY started_at DESC
     LIMIT 1
  `;
  if (!rows[0]) return null;
  const { cancelSubtree } = await import('../../fleet/nursery');
  const res = await cancelSubtree(sql, {
    workspaceId,
    rootSpawnId: rows[0].spawn_id,
    reason,
    actor,
  });
  let processes_aborted = 0;
  try {
    const { abortLocalSpawn } = await import('../../fleet/operator-spawn');
    for (const c of res.cancelled) if (abortLocalSpawn(c.spawnId)) processes_aborted++;
  } catch {
    /* best-effort local abort, mirrors fleet:cancel */
  }
  return { spawn_id: res.rootSpawnId, cancelled: res.cancelled.map((c) => c.spawnId), processes_aborted };
}

/**
 * OMP hook sessions run in the caller's process rather than behind the
 * operator's psu-pty host. Their coord_presence row is only a candidate signal
 * fleet:kill can inspect, not proof that an interruptible session still exists.
 * The shared liveness oracle supplies the positive live/wake/recorded verdict;
 * this endpoint never treats a heartbeat-only row as permission to preserve a
 * dead session or signal a pid owned by an unrelated process.
 */
export async function findLiveUnmanagedSession(
  ownerId: string,
  workspaceId: string,
  resolveStates: typeof resolveSessionStates = resolveSessionStates,
): Promise<LiveUnmanagedSession | null> {
  try {
    // Presence is a heartbeat, not terminal authority. If the newest recorded
    // adv session has an end marker, preserve that positive death evidence even
    // when the OMP hook heartbeat is still fresh.
    const advSession = await latestAdvSessionByCoordOwner(ownerId);
    if (hasAdvSessionTerminalEvidence(advSession)) return null;

    const { sql } = getOrgPg();
    const cutoff = new Date(Date.now() - PRESENCE_STALE_MS).toISOString();
    const rows = await sql<Array<{ source: string; heartbeat_at: Date | string | null }>>`
      SELECT source, heartbeat_at
        FROM harness_shared.coord_presence
       WHERE owner_id = ${ownerId}
         AND workspace_id = ${workspaceId}
         AND source = 'omp-hook-session'
         AND heartbeat_at >= ${cutoff}
       LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    const heartbeatAt = row.heartbeat_at == null
      ? null
      : row.heartbeat_at instanceof Date
        ? row.heartbeat_at.toISOString()
        : new Date(row.heartbeat_at).toISOString();

    // A fresh presence row is the exact stale-presence race this path must
    // reconcile. Reuse the same batched liveness assembly as coord:presence,
    // fleet:assignments, and respawn-member instead of rebuilding wake/activity
    // predicates here. `heartbeatAt` and `source` are supplied from the
    // workspace-scoped row above so the oracle does not hydrate a different
    // workspace's presence record.
    const verdict = (await resolveStates([
      { ownerId, heartbeatAt, source: row.source },
    ])).get(ownerId);
    if (!isPositiveUnmanagedSessionState(verdict?.sessionState)) return null;

    return { source: row.source, heartbeatAt };
  } catch {
    // A failed liveness read must not block the existing not-found cleanup
    // path; the next fleet:kill/roster read can retry it.
    return null;
  }
}

export default defineTool({
  name: 'fleet:kill',
  profile: 'engineer',
  description:
    'KILL an agent — desktop OR headless — through one verb. Interactive psu member: graceful SIGTERM (→SIGKILL) to its session, and close_terminal (default true) ALSO closes its terminal window (windows never close on their own — the tab drops to a shell after the agent exits). Managed headless psu member: the same session termination with kind:headless + terminal:none and no window ancestry. Headless nursery cup: delegates to the transitive cancel path (claims + locks released). `terminal_pids` closes ORPHANED windows whose agent already exited. Self-kill refused; reason required; every kill audited.',
  guidance: {
    when: 'Winding down a fleet member for real (not just ending its turn — that is turn:interrupt), removing a dead member\'s stale window, or stopping a headless cup. "Close that agent\'s terminal" / "kill that cup" both land here.',
    notWhen:
      'To END A TURN but keep the agent alive — turn:interrupt. To cancel a whole nursery subtree by spawn id with full bulk semantics — fleet:cancel (fleet:kill delegates to the same machinery for a single headless target).',
    chaining:
      'coord:presence / fleet:assignments (find the ownerId) → fleet:kill { owner, reason } . Stale windows: fleet:kill { terminal_pids:[…], reason }.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      owner: z
        .string()
        .min(1)
      .optional()
      .describe(
          'One agent to kill, by coord ownerId (n=1 shorthand for owners:[id]). Interactive/headless psu member or headless nursery spawn — the tool resolves which.',
        ),
      owners: z.array(z.string().min(1)).min(1).max(20).optional().describe('Many agents to kill (1–20).'),
      terminal_pids: z
        .array(z.number().int().positive())
        .min(1)
        .max(20)
        .optional()
        .describe(
          'Close ORPHANED fleet terminal windows by tab-shell pid (the agent already exited; the window sits at a shell). Validated against the papercusp console marker — arbitrary host pids are refused.',
        ),
      close_terminal: z
        .boolean()
        .optional()
        .describe(
          'Desktop targets: also close the terminal window (default true). false = kill the agent, leave its window open at a shell for inspection. Ignored for headless targets (no terminal).',
        ),
      reason: softText(4000).describe('Why — REQUIRED; goes to the audit row (who → whom / kind / outcome).'),
      workspace: z.string().max(120).optional(),
    })
    .refine((a) => Boolean(a.owner) || (a.owners?.length ?? 0) > 0 || (a.terminal_pids?.length ?? 0) > 0, {
      message: 'pass `owner`/`owners` (agents) and/or `terminal_pids` (orphaned windows)',
    }),
  async handler(args, ctx) {
    const actor = resolveAgentIdentity(ctx);
    const workspaceId = args.workspace ?? actor.workspaceId ?? activeWorkspaceId();
    const reason = clampText(args.reason, 4000) ?? 'fleet:kill';
    const closeTerminal = args.close_terminal !== false;
    const deps: KillDeps = {
      findHost: (ownerId) => findLiveHost(ownerId),
      findLiveUnmanaged: (ownerId) => findLiveUnmanagedSession(ownerId, workspaceId),
      cancelNursery: (target, why) => cancelNurseryTarget(target, why, workspaceId, actor),
      deactivateLoop: (ownerId, why) =>
        deactivateLoop(ownerId, {
          reason: `fleet:kill — ${why}`,
          actor: actor.ownerId,
        }),
      clearPresence: (ownerId) => clearPresence(ownerId),
      presenceExists: async (ownerId) => (await getPresence(ownerId)) != null,
      releaseSeatConsumptions: async (ownerIds) => {
        const { releaseSeatConsumptions } = await import('../../fleet/seat-accounting');
        await releaseSeatConsumptions(ownerIds);
      },
      repairStaleAdvSessionTerminalMarkers,
      markSessionEnded: async (id, signal) => {
        await markAdvSessionEnded(Number(id), null, 'signal', { signal });
      },
      audit: (action, subject, details) => writeKillAudit(action, subject, details, workspaceId, actor.ownerId),
    };

    const ownerIds = mergeIds(args.owner, args.owners);
    const env = await runBulk(
      ownerIds,
      async (target) => ({ ...await killOne({ actor: actor.ownerId, target, closeTerminal, reason }, deps) }),
      { keyOf: (target) => ({ target }) },
    );

    // Orphaned-window leg (separate keyspace: pids, not ownerIds).
    const windows: Array<{ ok: boolean; pid: number; closed?: boolean; error?: string }> = [];
    for (const pid of args.terminal_pids ?? []) {
      const r = await closeTerminalPid(pid, {});
      if (r.ok) await writeKillAudit('fleet.kill_window', String(pid), { reason }, workspaceId, actor.ownerId);
      windows.push(r);
    }

    // One envelope: the ownerId results + (when requested) the window results,
    // both self-describing. bulkContent wraps in the canonical { data } shape.
    return bulkContent(windows.length === 0 ? env : { ...env, windows });
  },
});
