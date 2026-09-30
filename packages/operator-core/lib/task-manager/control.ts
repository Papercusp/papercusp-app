/**
 * task-manager/control — the verbs (task-manager-no-escape-2026-07-27, P-014).
 *
 * Every destructive path in here exists to make ONE class of accident impossible.
 * On this box, killing processes has twice gone wrong the same way: a pattern
 * match (`pkill -f '<binary>'`) treated "looks like mine" as "is mine" and took
 * out the owner's live desktop window plus peer agents' test instances. And PID
 * wrap happens roughly daily under fleet load, so a recorded pid is not an
 * identity either.
 *
 * So there are exactly two ways to signal something here, and neither can hit a
 * stranger:
 *
 *   CONFINED   -> `systemctl --user kill <pc-taskId.scope>`. Addressed by CGROUP.
 *                 It takes the whole subtree (no orphaned grandchildren), and a
 *                 recycled pid is not reachable through it at all.
 *   UNCONFINED -> `process.kill(pid)` ONLY after re-reading the kernel identity
 *                 and confirming it still matches what the row recorded. A
 *                 mismatch REFUSES rather than proceeding.
 *
 * There is deliberately no third way, and no name/pattern matching anywhere.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { linuxProcStateFromStat, readProcessGroupId, readProcessIdentity } from '../process-identity';
import { absCgroupDir, nodeCgroupFs, walkCgroupTree, type CgroupFs } from './cgroup-read';
import { notifyTaskKillRequested } from './kill-notify';
import { closeTask, getSubtree, getTask, reopenStrandedTask, updateTaskLimits } from './store';
import { isLiveOwnedState, taskIdFromScopeUnit, type TaskRow } from './types';

// Lazily promisified (NOT `const execFileAsync = promisify(execFile)` at module
// scope): this module is reachable via a transitive import chain from test files
// that narrowly mock `node:child_process` for their own subprocess assertions —
// under such a mock the `execFile` import binding resolves to `undefined`, and
// eagerly calling `promisify(undefined)` at module-eval time throws for every such
// suite, even ones that never call `systemctl` (lint:no-eager-execfile-promisify /
// EI-10161; same pattern as watchdog.ts's `execFileP`). Deferring the promisify to
// first actual call means a transitive importer that never exercises this function
// never pays the cost. The function form (not a `const`) is also what lets
// `ControlDeps.execFileAsync?: typeof execFileAsync` keep working unchanged below.
type ExecFileAsync = (
  file: string,
  args: string[],
  opts?: Record<string, unknown>,
) => Promise<{ stdout: string; stderr: string }>;
let cachedExecFileAsync: ExecFileAsync | null = null;
function execFileAsync(file: string, args: string[], opts?: Record<string, unknown>): Promise<{ stdout: string; stderr: string }> {
  if (!cachedExecFileAsync) cachedExecFileAsync = promisify(execFile) as unknown as ExecFileAsync;
  return cachedExecFileAsync(file, args, opts);
}

export type ControlOutcome =
  | { ok: true; taskId: string; action: string; detail?: string }
  | { ok: false; taskId: string; action: string; error: ControlError; detail?: string };

export type ControlError =
  | 'task_not_found'
  | 'not_live' // already ended, or a residue classification we do not own
  | 'identity_mismatch' // the pid now belongs to something else — REFUSED
  | 'no_target' // neither a scope nor a verifiable pid
  // The target is verifiably ABSENT, so there is nothing left to signal: a well-formed
  // managed scope systemd no longer knows (a transient unit is collected the moment its
  // payload exits), or a scope that holds zero processes. Split out of `no_target` /
  // `not_live` because those two also cover states where something is WRONG, and a caller
  // cannot tell the cases apart from a detail string. Deliberately still `ok:false`:
  // reconciliation asks "did you signal it?" and the honest answer is no. A caller whose
  // contract is instead "make sure the subtree is DEAD" should read this as the goal state
  // reached — see releaseDesktopProcesses, which stops warning on it and proceeds.
  | 'already_gone'
  | 'unsupported' // e.g. freeze on an unconfined task
  | 'command_failed'
  | 'persistence_failed' // systemd accepted a change, but the ledger did not record it
  | 'incomplete'; // signal(s) sent, but the scope still holds processes after the verification window (EI-19478780721557822) — never `ok:true` on a bare "signalled"

export type ScopeControlOutcome =
  | { ok: true; scopeUnit: string; action: string; detail?: string }
  | { ok: false; scopeUnit: string; action: string; error: ControlError; detail?: string };

export interface ControlDeps {
  execFileAsync?: typeof execFileAsync;
  fs?: CgroupFs;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  readIdentity?: (pid: number) => string | null;
  /** Process-group id of a pid (null = unknown). Lets the verified-pid path take a
   *  detached task's whole subtree instead of only its root. */
  readProcessGroup?: (pid: number) => number | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function deps(d: ControlDeps = {}): Required<Omit<ControlDeps, 'now'>> & { now: () => number } {
  return {
    execFileAsync: d.execFileAsync ?? execFileAsync,
    fs: d.fs ?? nodeCgroupFs,
    kill: d.kill ?? ((pid, signal) => process.kill(pid, signal)),
    readIdentity: d.readIdentity ?? readProcessIdentity,
    readProcessGroup: d.readProcessGroup ?? readProcessGroupId,
    now: d.now ?? Date.now,
    sleep: d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  };
}

async function systemctl(args: string[], d: ReturnType<typeof deps>): Promise<{ ok: boolean; detail?: string }> {
  try {
    await d.execFileAsync('systemctl', ['--user', ...args], { timeout: 15_000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: (e as Error).message.slice(0, 300) };
  }
}

/**
 * Verify a row's pid still IS the process the row describes.
 *
 * Returns the pid when safe to signal, or an error. A row that never captured an
 * identity is allowed through with `weak: true` — that is the honest state of
 * affairs for a pre-existing unconfined process, and the caller surfaces it —
 * but a row that HAS an identity and no longer matches is refused outright.
 */
export function verifyPidStillOurs(
  row: TaskRow,
  d: ReturnType<typeof deps>,
): { ok: true; pid: number; weak: boolean } | { ok: false; error: ControlError; detail?: string } {
  if (!row.pid) return { ok: false, error: 'no_target', detail: 'row has no pid' };
  const current = d.readIdentity(row.pid);
  if (row.processIdentity) {
    if (!current) {
      return { ok: false, error: 'identity_mismatch', detail: `pid ${row.pid} is gone` };
    }
    if (current !== row.processIdentity) {
      return {
        ok: false,
        error: 'identity_mismatch',
        detail: `pid ${row.pid} now holds identity ${current}, row recorded ${row.processIdentity} — refusing to signal a recycled pid`,
      };
    }
    return { ok: true, pid: row.pid, weak: false };
  }
  if (!current) return { ok: false, error: 'identity_mismatch', detail: `pid ${row.pid} is gone` };
  return { ok: true, pid: row.pid, weak: true };
}

export interface KillTaskOptions extends ControlDeps {
  /** Escalate SIGTERM -> SIGKILL after this long. 0 disables escalation. */
  escalateAfterMs?: number;
  signal?: NodeJS.Signals;
  /** Also signal every descendant TASK in the ledger tree. The cgroup kill already
   *  takes OS descendants; this is for logically-nested tasks that got their own
   *  scope (an agent's spawned children are their own scopes, not sub-cgroups). */
  includeSubtree?: boolean;
  /**
   * WI-37521: opt-in escape hatch for a TERMINAL ledger row whose cgroup scope
   * positively still holds live processes (the row closed — e.g. the launching
   * client exited — while its payload kept running; WI-37509 is the confirmed
   * source of this class). Without this flag a terminal row is refused exactly as
   * before (`not_live`) — this never widens the DEFAULT behaviour.
   *
   * Deliberately narrower than the live path in two ways, both load-bearing:
   *   1. Confined (cgroup-scope) rows ONLY. A terminal row's `pid` is not
   *      re-verifiable the way `verifyPidStillOurs` re-verifies a LIVE row's pid
   *      (a terminal row's `processIdentity` describes a process we already know
   *      exited under that scope; trusting a bare `pid` on it is exactly the
   *      recycled-pid hazard this module exists to prevent) — so the unconfined
   *      path stays refused unconditionally, reap or not.
   *   2. The scope must be POSITIVELY re-verified non-empty IN THIS CALL
   *      (`countScopeProcesses`, the same live cgroup walk `processes:list` uses)
   *      before anything is signalled — a terminal row whose scope has already
   *      gone quiet is not residue, it is just a terminal row, and stays refused.
   *
   * The row's OWN state is left untouched on success: `closeTask` is a no-op on
   * an already-`ended_at` row by design, and rewriting a `killed`/`exited`/etc.
   * row's terminal state to describe a LATER reap would misattribute history
   * rather than clarify it. The reap is reported in the outcome's `detail` and
   * (like every `processes:kill` call) in the audit log.
   */
  reapTerminalResidue?: boolean;
}

/** Options for explicitly tearing down a scope that reconciliation discovered
 * without a durable task row. This is deliberately separate from `killTask`:
 * an unaccounted scope has no ledger state to close, so the only safe handle is
 * the validated systemd scope unit plus a fresh cgroup probe. */
export interface KillScopeUnitOptions extends ControlDeps {
  signal?: NodeJS.Signals;
  escalateAfterMs?: number;
}

const MANAGED_SCOPE_UNIT = /^pc-[0-9a-z]{4,64}(?:--[A-Za-z0-9._-]{1,60})?\.(?:scope|service)$/;

function isManagedScopeUnit(scopeUnit: string): boolean {
  return MANAGED_SCOPE_UNIT.test(scopeUnit) && taskIdFromScopeUnit(scopeUnit) !== null;
}

/**
 * Validate the cgroup path returned by systemd for an explicit scope handle.
 * A caller supplies only the unit name; the path must come from systemd and
 * must resolve to the Papercusp slice's exact scope directory before we walk or
 * signal it. This prevents a lookalike unit name from turning into a foreign
 * cgroup kill.
 */
function isManagedScopeCgroupPath(cgroupPath: string, scopeUnit: string): boolean {
  return (
    cgroupPath.startsWith('/') &&
    !cgroupPath.includes('\0') &&
    !cgroupPath.split('/').includes('..') &&
    cgroupPath.includes('/papercusp.slice/') &&
    cgroupPath.endsWith(`/${scopeUnit}`)
  );
}

async function scopeCgroupPath(
  scopeUnit: string,
  d: ReturnType<typeof deps>,
): Promise<{ ok: true; cgroupPath: string } | { ok: false; error: ControlError; detail: string }> {
  if (!isManagedScopeUnit(scopeUnit)) {
    return {
      ok: false,
      error: 'no_target',
      detail: `scope ${scopeUnit} is not a validated Papercusp task scope unit`,
    };
  }
  try {
    const { stdout } = await d.execFileAsync(
      'systemctl',
      ['--user', 'show', '-p', 'ControlGroup', '--value', scopeUnit],
      { timeout: 10_000, maxBuffer: 64 * 1024 },
    );
    const cgroupPath = stdout.trim();
    // EMPTY is a different answer from WRONG, and only one of them is a problem.
    // `systemctl show` exits 0 with an empty value for a unit it does not know, which
    // for a transient scope is the ordinary end of life: the payload exited and systemd
    // collected the unit. No cgroup means no cgroup to hold processes, so the subtree is
    // already gone and there is nothing to signal. Reporting that as `no_target` made a
    // routine teardown indistinguishable from a lookalike-unit refusal (WI-1199802).
    if (!cgroupPath) {
      return {
        ok: false,
        error: 'already_gone',
        detail: `scope ${scopeUnit} is no longer known to systemd — its transient scope was collected, so its process subtree is already gone`,
      };
    }
    // A path that IS present but does not validate is the real refusal this guard exists
    // for: a lookalike unit name resolving outside papercusp.slice. Keep it loud.
    if (!isManagedScopeCgroupPath(cgroupPath, scopeUnit)) {
      return {
        ok: false,
        error: 'no_target',
        detail: `systemd returned no validated Papercusp cgroup for scope ${scopeUnit}`,
      };
    }
    return { ok: true, cgroupPath };
  } catch (e) {
    return {
      ok: false,
      error: 'command_failed',
      detail: `could not resolve cgroup for scope ${scopeUnit}: ${(e as Error).message.slice(0, 300)}`,
    };
  }
}

export async function killTask(taskId: string, opts: KillTaskOptions = {}): Promise<ControlOutcome> {
  const d = deps(opts);
  const row = await getTask(taskId);
  if (!row) return { ok: false, taskId, action: 'kill', error: 'task_not_found' };

  // Terminal row: refused by default (D-010 — residue is report-only unless a
  // caller explicitly asks to reap it AND we can positively re-verify it's real).
  let reapingResidue = false;
  if (!isLiveOwnedState(row.state)) {
    if (!opts.reapTerminalResidue) {
      return {
        ok: false,
        taskId,
        action: 'kill',
        error: 'not_live',
        // EI-21895340816653497: name the unlock right here — a caller who hit
        // this after an `incomplete` reply (the row aged to terminal between
        // calls) has no other way to discover reapTerminalResidue exists.
        detail: `state is ${row.state} — a residue or terminal row is never ours to signal by default. If this scope may still hold live processes (e.g. this row just aged out of an 'incomplete' kill reply), retry with reapTerminalResidue: true — it re-verifies the confined cgroup scope and, if it is not actually empty, signals it anyway.`,
      };
    }
    if (!row.confined || !row.scopeUnit) {
      return {
        ok: false,
        taskId,
        action: 'kill',
        error: 'not_live',
        detail: `state is ${row.state} — reapTerminalResidue only supports a confined (cgroup) scope; this row is unconfined, so its pid cannot be safely re-verified`,
      };
    }
    if ((await countScopeProcesses(row, d)) === 0) {
      return {
        ok: false,
        taskId,
        action: 'kill',
        error: 'not_live',
        detail: `state is ${row.state} — reap requested but scope ${row.scopeUnit} holds no live process right now; nothing to reap`,
      };
    }
    reapingResidue = true;
  }

  const signal = opts.signal ?? 'SIGTERM';

  if (opts.includeSubtree) {
    const tree = await getSubtree(row.rootTaskId);
    // The ledger read returns the WHOLE root tree. A nested task owns only
    // its descendants, never its ancestors or sibling scopes.
    const subtreeIds = new Set([taskId]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const task of tree) {
        if (task.parentTaskId && subtreeIds.has(task.parentTaskId) && !subtreeIds.has(task.taskId)) {
          subtreeIds.add(task.taskId);
          expanded = true;
        }
      }
    }
    const descendants = tree.filter(
      (t) => t.taskId !== taskId && subtreeIds.has(t.taskId)
        && (isLiveOwnedState(t.state) || opts.reapTerminalResidue),
    );
    for (const t of descendants) {
      await killTask(t.taskId, { ...opts, includeSubtree: false });
    }
  }

  // ── the trustworthy path ────────────────────────────────────────────────
  if (row.confined && row.scopeUnit) {
    // EI-21905196224862433: announce kill-intent BEFORE the signal actually goes
    // out. A confined job's Node-side watcher is the `systemd-run --pipe --wait`
    // CLIENT, not the payload — that client exits 0 once the unit is gone
    // regardless of whether it ended normally or was killed here, so a listener
    // (capability:bash's job registry) needs this notice to land before the
    // client can possibly have exited and its close handler run.
    notifyTaskKillRequested(taskId, signal);
    const res = await systemctl(['kill', `--signal=${signal}`, row.scopeUnit], d);
    if (!res.ok) {
      return { ok: false, taskId, action: 'kill', error: 'command_failed', detail: res.detail };
    }
    let escalated = false;
    if (opts.escalateAfterMs && opts.escalateAfterMs > 0) {
      await d.sleep(opts.escalateAfterMs);
      if ((await countScopeProcesses(row, d)) > 0) {
        notifyTaskKillRequested(taskId, 'SIGKILL');
        const escalation = await systemctl(['kill', '--signal=SIGKILL', row.scopeUnit], d);
        // Pending termination is a success only when SIGKILL was delivered.
        // A failed command must not suppress recovery or close a live task.
        if (!escalation.ok) {
          return {
            ok: false, taskId, action: 'kill', error: 'command_failed',
            detail: `SIGKILL escalation failed for scope ${row.scopeUnit}: ${escalation.detail}`,
          };
        }
        escalated = true;
      }
    }
    // EI-19478780721557822: a `systemctl kill` exit code only proves the SIGNAL was
    // delivered, never that the subtree actually died — a re-parented / D-state /
    // otherwise unkillable descendant can survive both SIGTERM and an escalated
    // SIGKILL. Re-probe (bounded, not wall-clock — see waitForScopeEmpty) before
    // reporting anything, and never close the row as `killed` while it is not.
    let verification = await waitForScopeEmpty(row, d);
    let stopFallback: { ok: boolean; detail?: string } | null = null;
    if (!verification.empty && signal === 'SIGTERM' && !escalated) {
      // A transient agent-session scope can accept the signal while systemd
      // still considers the unit active. A unit-scoped stop asks systemd to
      // complete the teardown without widening the target. `systemctl` has a
      // bounded timeout in systemctl(), and the second bounded re-probe keeps
      // the no-false-green contract intact.
      const stop = await systemctl(['stop', row.scopeUnit], d);
      stopFallback = stop;
      verification = await waitForScopeEmpty(row, d);
    }
    const { empty, survivors, residue } = verification;
    if (!empty) {
      if (escalated) {
        // A SIGKILL is terminal even when cgroup teardown/reaping is slower than
        // this bounded response window. Keep the row live so reconciliation can
        // continue to observe the scope, but do not turn a successful kill into
        // a retry instruction (EI-20130774106283501).
        return {
          ok: true,
          taskId,
          action: 'kill',
          detail: `scope ${row.scopeUnit} signalled ${signal} (escalated to SIGKILL) — termination pending; ${survivors} process(es) remained during the verification window, so no retry is required and the task remains tracked until the scope is observed empty${residue ? describeResidue(residue) : ''}`,
        };
      }
      return {
        ok: false,
        taskId,
        action: 'kill',
        error: 'incomplete',
        // EI-21895340816653497: the row can age into a terminal state (e.g.
        // `timed_out`) between this reply and a caller's retry, at which point
        // a plain retry is refused `not_live` — an escalation path that reads
        // as reachable but silently is not. Say so up front: `not_live` on a
        // later retry means re-issue it with `reapTerminalResidue: true`.
        detail: `scope ${row.scopeUnit} signalled ${signal}${escalated ? ' (escalated to SIGKILL)' : ''}${stopFallback ? `; systemd stop fallback ${stopFallback.ok ? 'also left the scope non-empty' : `failed${stopFallback.detail ? `: ${stopFallback.detail}` : ''}`}` : ''} but ${survivors} process(es) still alive after the verification window — task left LIVE (not closed) so a retry or a fresh listing can still find it, UNLESS the row has since aged into a terminal state (e.g. timed_out) — if a retry instead reports \`not_live\`, re-issue it with \`reapTerminalResidue: true\` to keep signalling the confirmed-live scope${residue ? describeResidue(residue) : ''}`,
      };
    }
    if (reapingResidue) {
      // The row was ALREADY terminal (that's what let us reach this branch at
      // all) — `closeTask` no-ops on an `ended_at`-set row by design, and
      // rewriting its terminal state to describe a reap that happened LATER
      // would misattribute history rather than clarify it. Report the reap in
      // `detail` instead; the row's own state/exitReason stay exactly as they
      // were.
      return {
        ok: true,
        taskId,
        action: 'kill',
        detail: `TERMINAL-ROW REAP (WI-37521): scope ${row.scopeUnit} was verified holding live process(es) despite ledger state '${row.state}', signalled ${signal}${escalated ? ' (escalated to SIGKILL)' : ''} — now verified empty. The row's own state is left unchanged (already terminal).`,
      };
    }
    await closeTask(taskId, { state: 'killed', exitReason: `scope kill ${signal}${escalated ? ' (escalated)' : ''}` });
    return {
      ok: true,
      taskId,
      action: 'kill',
      detail: `scope ${row.scopeUnit} signalled ${signal}${escalated ? ' (escalated to SIGKILL)' : ''} — verified empty`,
    };
  }

  // ── the verified-pid path ───────────────────────────────────────────────
  const verdict = verifyPidStillOurs(row, d);
  if (!verdict.ok) {
    // The pid being GONE means the task already ended — close the row honestly
    // rather than reporting a failure the caller can do nothing about.
    if (verdict.error === 'identity_mismatch' && verdict.detail?.includes('is gone')) {
      await closeTask(taskId, { state: 'stranded', exitReason: 'process gone at kill time' });
    }
    return { ok: false, taskId, action: 'kill', error: verdict.error, detail: verdict.detail };
  }
  // EI-24635523980082322: a detached launch leads its own process group and its
  // payload runs BELOW the recorded root. Signalling the root alone reaches a
  // wrapper shell whose TERM trap waits on its foreground child, so the agent
  // survives — measured on macOS, where no cgroup exists to take the subtree.
  // Signal the group only when the verified pid IS its leader; a pid inside
  // someone else's group keeps the single-pid signal, never a widened one.
  const groupLeader = d.readProcessGroup(verdict.pid) === verdict.pid;
  const target = groupLeader ? -verdict.pid : verdict.pid;
  const targetLabel = groupLeader ? `process group ${verdict.pid}` : `pid ${verdict.pid}`;
  try {
    // EI-21905196224862433: same kill-intent notice as the confined path above —
    // an UNCONFINED job's watched child IS the real payload, so its own close
    // handler already sees `code===null, signal===<sig>` correctly, but the
    // notice is cheap to send unconditionally and keeps both paths consistent.
    notifyTaskKillRequested(taskId, signal);
    d.kill(target, signal);
  } catch (e) {
    return { ok: false, taskId, action: 'kill', error: 'command_failed', detail: (e as Error).message };
  }
  let escalated = false;
  if (opts.escalateAfterMs && opts.escalateAfterMs > 0 && signal !== 'SIGKILL') {
    await d.sleep(opts.escalateAfterMs);
    // Re-verify before escalating: the leader still holding the identity we
    // verified is what keeps the group id from naming a recycled pid.
    if (verifyPidStillOurs(row, d).ok) {
      try {
        notifyTaskKillRequested(taskId, 'SIGKILL');
        d.kill(target, 'SIGKILL');
        escalated = true;
      } catch (e) {
        return {
          ok: false, taskId, action: 'kill', error: 'command_failed',
          detail: `SIGKILL escalation failed for ${targetLabel}: ${(e as Error).message}`,
        };
      }
    }
  }
  const how = `${signal}${escalated ? ' (escalated to SIGKILL)' : ''}`;
  await closeTask(taskId, {
    state: 'killed',
    exitReason: `${groupLeader ? 'group' : 'pid'} kill ${signal}${escalated ? ' (escalated)' : ''}`,
  });
  return {
    ok: true,
    taskId,
    action: 'kill',
    detail: verdict.weak
      ? `${targetLabel} signalled ${how} (WEAK: row never captured a kernel identity)`
      : `${targetLabel} signalled ${how}`,
  };
}

/**
 * Kill an orphaned Papercusp scope found by reconciliation, without inventing
 * a ledger row. The scope unit is validated, systemd supplies the authoritative
 * cgroup path, and the cgroup is positively non-empty before signalling. A
 * bounded deep re-probe is required before success, matching `killTask`'s
 * no-false-green contract. Automatic reconciliation remains report-only; this
 * path exists only for an explicit operator `processes:kill { scopeUnit }`.
 */
export async function killScopeUnit(
  scopeUnit: string,
  opts: KillScopeUnitOptions = {},
): Promise<ScopeControlOutcome> {
  const d = deps(opts);
  const action = 'kill';
  const resolved = await scopeCgroupPath(scopeUnit, d);
  if (!resolved.ok) return { ok: false, scopeUnit, action, error: resolved.error, detail: resolved.detail };

  const initial = countCgroupProcesses(resolved.cgroupPath, d);
  if (initial === 0) {
    // The unit still exists but holds nothing — the same "nothing to signal" state as a
    // collected scope, reached one step later. `already_gone` rather than `not_live` so a
    // caller can tell it apart from a terminal-row classification we decline to own.
    return {
      ok: false,
      scopeUnit,
      action,
      error: 'already_gone',
      detail: `scope ${scopeUnit} is empty or already released; refusing to signal a stale handle`,
    };
  }

  const signal = opts.signal ?? 'SIGTERM';
  const res = await systemctl(['kill', `--signal=${signal}`, scopeUnit], d);
  if (!res.ok) {
    return { ok: false, scopeUnit, action, error: 'command_failed', detail: res.detail };
  }

  let escalated = false;
  if (opts.escalateAfterMs && opts.escalateAfterMs > 0) {
    await d.sleep(opts.escalateAfterMs);
    if (countCgroupProcesses(resolved.cgroupPath, d) > 0) {
      const escalation = await systemctl(['kill', '--signal=SIGKILL', scopeUnit], d);
      if (!escalation.ok) {
        return {
          ok: false, scopeUnit, action, error: 'command_failed',
          detail: `SIGKILL escalation failed for scope ${scopeUnit}: ${escalation.detail}`,
        };
      }
      escalated = true;
    }
  }

  const { empty, survivors, residue } = await waitForCgroupEmpty(resolved.cgroupPath, d);
  if (!empty) {
    if (escalated) {
      return {
        ok: true,
        scopeUnit,
        action,
        detail: `scope ${scopeUnit} signalled ${signal} (escalated to SIGKILL) — termination pending; ${survivors} process(es) remained during the verification window, so no retry is required${residue ? describeResidue(residue) : ''}`,
      };
    }
    return {
      ok: false,
      scopeUnit,
      action,
      error: 'incomplete',
      detail: `scope ${scopeUnit} signalled ${signal}${escalated ? ' (escalated to SIGKILL)' : ''} but ${survivors} process(es) still alive after the verification window — no ledger row was changed${residue ? describeResidue(residue) : ''}`,
    };
  }
  return {
    ok: true,
    scopeUnit,
    action,
    detail: `scope ${scopeUnit} signalled ${signal}${escalated ? ' (escalated to SIGKILL)' : ''} — verified empty`,
  };
}

/** How many bounded re-probe retries to give a scope to actually empty after the
 *  final signal, and how long to wait between them. Retry-COUNT bounded, not
 *  wall-clock bounded, so a mocked `sleep` in tests resolves this instantly
 *  instead of busy-spinning against real `Date.now()`. 5×100ms = 500ms of real
 *  grace in production — SIGKILL reaping is normally sub-millisecond; this is
 *  slack for a loaded box, not an expectation of slow exits. */
const REPROBE_RETRIES = 5;
const REPROBE_POLL_MS = 100;

/** Deep pid SET under a task's cgroup — walks nested child cgroups too (unlike a
 *  bare `readCgroupProcs`, which only reads the ONE directory named by
 *  `cgroupPath` and would miss anything a descendant delegated into a sub-cgroup
 *  of its own). This is the same walk `processes:list` uses to enumerate what is
 *  actually alive, so "did the kill work" and "what's running" can't disagree. */
function collectCgroupPids(cgroupPath: string | null, d: ReturnType<typeof deps>): Set<number> {
  const pids = new Set<number>();
  if (!cgroupPath) return pids;
  for (const node of walkCgroupTree(absCgroupDir(cgroupPath), d.fs)) {
    for (const pid of node.pids) pids.add(pid);
  }
  return pids;
}

function countCgroupProcesses(cgroupPath: string | null, d: ReturnType<typeof deps>): number {
  return collectCgroupPids(cgroupPath, d).size;
}

/**
 * The cgroup to VERIFY a task's scope against — never the stored path on trust.
 *
 * 🚨 EI-22074929140199832. `task_ledger.cgroup_path` is written at enrolment and is
 * frequently NOT this task's scope: measured 2026-09-03, 522 of 726 confined rows
 * started in 24h stored a path that does not end in their own `scope_unit`, and a
 * `capability:bash` background task stored the OPERATOR'S OWN cgroup
 * (`/user.slice/…/app.slice/papercusp-dev-api.service`). Walking that answers a
 * question about the operator, not about the payload — and it is permanently
 * non-empty, so the scope can never be observed empty.
 *
 * Every consequence points the same way, toward a false SURVIVOR:
 *  - the escalation probe always sees >0, so a kill SIGKILLs after a SIGTERM that
 *    already worked;
 *  - the reply reports a fabricated survivor count with a residue breakdown of the
 *    operator's own processes (measured: a 3-process scope, fully dead, its unit
 *    `inactive/dead`, reported as "15 process(es) remained … 13 sleeping, 2 running");
 *  - the un-escalated branch returns `ok:false, error:'incomplete'` — a false FAILURE
 *    on a complete kill, telling the caller to retry;
 *  - `reapTerminalResidue` sees phantom residue in an empty scope.
 * That is how this item was filed: its author read a phantom count as survivors and
 * built a process-escape theory on it.
 *
 * So resolve the scope the way the scopeUnit-mode path already does — ask systemd,
 * and require `isManagedScopeCgroupPath` — and accept the stored path ONLY when it
 * validates against this row's own unit. `null` means "no cgroup to walk", which is
 * the honest reading of a collected transient scope: no cgroup, no processes.
 */
async function resolveRowScopeCgroup(
  row: TaskRow,
  d: ReturnType<typeof deps>,
): Promise<string | null> {
  const stored = row.cgroupPath ?? null;
  if (!row.scopeUnit) return stored;
  if (stored && isManagedScopeCgroupPath(stored, row.scopeUnit)) return stored;
  const resolved = await scopeCgroupPath(row.scopeUnit, d);
  if (resolved.ok) return resolved.cgroupPath;
  // A COLLECTED transient scope is POSITIVELY empty: systemd no longer knows the
  // unit, so there is no cgroup and therefore nothing alive in it.
  if (resolved.error === 'already_gone') return null;
  // Anything else means we FAILED TO RESOLVE — which is not the same as "empty",
  // and must never be rendered as one. An unreachable/erroring `systemctl` turned
  // into `null` here would report `verified empty` for a scope nobody looked at:
  // the instrument-failure-reads-as-clean class this subsystem exists to refuse.
  // Fall back to the stored path — the pre-fix behaviour, which can only ever
  // OVER-report survivors, never invent a clean kill.
  return stored;
}

async function countScopeProcesses(row: TaskRow, d: ReturnType<typeof deps>): Promise<number> {
  return countCgroupProcesses(await resolveRowScopeCgroup(row, d), d);
}

/**
 * Resolve a task scope for the stranded-thaw recovery path. Unlike kill's
 * diagnostic fallback, recovery must never walk the stored path after systemd
 * failed to resolve the row's own scope: thawing a lookalike or operator cgroup
 * would turn a terminal ledger row into live work for the wrong process tree.
 */
async function resolveVerifiedRowScopeCgroup(
  row: TaskRow,
  d: ReturnType<typeof deps>,
): Promise<{ ok: true; cgroupPath: string } | { ok: false; error: ControlError; detail: string }> {
  if (!row.scopeUnit) {
    return { ok: false, error: 'no_target', detail: 'task has no scope unit to recover' };
  }
  if (row.cgroupPath && isManagedScopeCgroupPath(row.cgroupPath, row.scopeUnit)) {
    return { ok: true, cgroupPath: row.cgroupPath };
  }
  const resolved = await scopeCgroupPath(row.scopeUnit, d);
  return resolved.ok
    ? resolved
    : { ok: false, error: resolved.error, detail: resolved.detail };
}

function cgroupIsFrozen(cgroupPath: string, d: ReturnType<typeof deps>): boolean {
  return d.fs.readFile(`${absCgroupDir(cgroupPath)}/cgroup.freeze`)?.trim() === '1';
}

/** Human label for a `/proc/<pid>/stat` state letter (`man proc`, `/proc/pid/stat`).
 *  Unrecognised/unreadable states fall through to `residueLabel`'s own default —
 *  never invented here. */
const PROC_STATE_LABEL: Record<string, string> = {
  R: 'running',
  S: 'sleeping',
  D: 'uninterruptible-sleep',
  Z: 'zombie',
  T: 'stopped',
  t: 'trace-stopped',
  X: 'dead',
  x: 'dead',
  I: 'idle',
  W: 'paging',
};

function residueLabel(state: string | null): string {
  if (state === null) return 'unknown';
  return PROC_STATE_LABEL[state] ?? `state-${state}`;
}

/** EI-21065795494500135: a cgroup that survives verification must never be
 *  reported as a bare, unexplained survivor count — that leaves an agent unable
 *  to tell "still finishing up, retry" from "this can NEVER drain, stop asking".
 *  Reads each survivor's kernel state and buckets it into an actionable summary.
 *  Diagnostic-only: a state that fails to read is `null` -> "unknown", never
 *  treated as gone (cgroup membership remains the sole liveness signal). */
export interface ResidueBreakdown {
  survivors: number;
  byLabel: Record<string, number>;
  /** Every survivor is a zombie: SIGKILL cannot reach an already-dead process —
   *  further escalation is pointless; something must wait() on its parent. */
  allZombie: boolean;
  /** At least one survivor is blocked in the kernel (usually I/O); the signal is
   *  queued and only delivered once that syscall returns. */
  anyUninterruptible: boolean;
}

function summarizeResidue(pids: ReadonlySet<number>, d: ReturnType<typeof deps>): ResidueBreakdown {
  const byLabel: Record<string, number> = {};
  let zombieCount = 0;
  let uninterruptibleCount = 0;
  for (const pid of pids) {
    const stat = d.fs.readFile(`/proc/${pid}/stat`);
    const state = stat == null ? null : linuxProcStateFromStat(stat);
    const label = residueLabel(state);
    byLabel[label] = (byLabel[label] ?? 0) + 1;
    if (state === 'Z') zombieCount++;
    if (state === 'D') uninterruptibleCount++;
  }
  return {
    survivors: pids.size,
    byLabel,
    allZombie: pids.size > 0 && zombieCount === pids.size,
    anyUninterruptible: uninterruptibleCount > 0,
  };
}

/** Renders a `ResidueBreakdown` as the trailing clause of an `incomplete` detail
 *  string — the breakdown plus, where it changes what the caller should DO next,
 *  one line of guidance. */
function describeResidue(r: ResidueBreakdown): string {
  const breakdown = Object.entries(r.byLabel)
    .sort((a, b) => b[1] - a[1])
    .map(([label, n]) => `${n} ${label}`)
    .join(', ');
  const advice = r.allZombie
    ? ' — ALL zombie: a signal cannot reach an already-dead process; this scope will not drain until something reaps its parent (its own leader, or systemd once it notices) — re-escalating will not help'
    : r.anyUninterruptible
      ? ' — includes uninterruptible-sleep process(es): blocked inside the kernel (usually I/O); the signal is queued and is delivered only once that syscall returns'
      : '';
  return ` [residue: ${breakdown}${advice}]`;
}

async function waitForCgroupEmpty(
  cgroupPath: string,
  d: ReturnType<typeof deps>,
): Promise<{ empty: boolean; survivors: number; residue?: ResidueBreakdown }> {
  let pids = collectCgroupPids(cgroupPath, d);
  for (let i = 0; i < REPROBE_RETRIES && pids.size > 0; i++) {
    await d.sleep(REPROBE_POLL_MS);
    pids = collectCgroupPids(cgroupPath, d);
  }
  if (pids.size === 0) return { empty: true, survivors: 0 };
  return { empty: false, survivors: pids.size, residue: summarizeResidue(pids, d) };
}

/** Re-probe up to REPROBE_RETRIES times (REPROBE_POLL_MS apart) for the scope to
 *  actually empty. Returns the LAST observed survivor count (plus a residue
 *  diagnostic when non-empty) so a non-empty outcome can be reported honestly
 *  instead of as a bare "signalled". */
async function waitForScopeEmpty(
  row: TaskRow,
  d: ReturnType<typeof deps>,
): Promise<{ empty: boolean; survivors: number; residue?: ResidueBreakdown }> {
  // Scope-validated, not the stored path — see `resolveRowScopeCgroup`.
  return waitForCgroupEmpty((await resolveRowScopeCgroup(row, d)) ?? '', d);
}

/**
 * Pause / resume — the verb a process table cannot offer and a cgroup gives away
 * free. Under memory pressure, freezing the three fattest test runs beats killing
 * them: the work is not lost, and the box stops thrashing immediately.
 */
export async function freezeTask(taskId: string, opts: ControlDeps = {}): Promise<ControlOutcome> {
  return setFrozen(taskId, true, opts);
}

export async function thawTask(taskId: string, opts: ControlDeps = {}): Promise<ControlOutcome> {
  return setFrozen(taskId, false, opts);
}

async function setFrozen(taskId: string, frozen: boolean, opts: ControlDeps): Promise<ControlOutcome> {
  const d = deps(opts);
  const action = frozen ? 'freeze' : 'thaw';
  const row = await getTask(taskId);
  if (!row) return { ok: false, taskId, action, error: 'task_not_found' };

  // Member recovery freezes a still-running task before markStranded() closes
  // its ledger row. The cgroup, not the terminal row, is therefore the only
  // backward-compatible marker that this particular stranded task can resume.
  // Require all three facts in this call: exact confined scope, non-empty
  // subtree, and the freezer's positive state. A stranded row that is empty or
  // already thawed remains a terminal refusal, never a resurrection guess.
  const recoverStranded = !frozen && row.state === 'stranded';
  if (!isLiveOwnedState(row.state) && !recoverStranded) {
    return { ok: false, taskId, action, error: 'not_live', detail: `state is ${row.state}` };
  }
  if (recoverStranded) {
    if (!row.confined || !row.scopeUnit) {
      return {
        ok: false,
        taskId,
        action,
        error: 'not_live',
        detail: `state is stranded — recovery requires a confined task scope; this task is unconfined or has no scope unit`,
      };
    }
    const resolved = await resolveVerifiedRowScopeCgroup(row, d);
    if (!resolved.ok) {
      return {
        ok: false,
        taskId,
        action,
        error: 'not_live',
        detail: `state is stranded — could not verify its managed scope: ${resolved.detail}`,
      };
    }
    const processCount = countCgroupProcesses(resolved.cgroupPath, d);
    if (processCount === 0) {
      return {
        ok: false,
        taskId,
        action,
        error: 'not_live',
        detail: `state is stranded — scope ${row.scopeUnit} holds no live process; refusing to resurrect an empty row`,
      };
    }
    if (!cgroupIsFrozen(resolved.cgroupPath, d)) {
      return {
        ok: false,
        taskId,
        action,
        error: 'not_live',
        detail: `state is stranded — scope ${row.scopeUnit} is not positively frozen; refusing to thaw a terminal row`,
      };
    }
    // Restore the ledger BEFORE the thaw actuation. That closes the dangerous
    // window in which a successfully thawed process is running but remains
    // invisible to listLiveTasks/reconciliation as a terminal row. The helper's
    // guarded UPDATE turns a concurrent recovery/close into a refusal.
    if (!(await reopenStrandedTask(taskId))) {
      return {
        ok: false,
        taskId,
        action,
        error: 'not_live',
        detail: 'state is stranded — recovery lost the ledger transition race; refusing to thaw',
      };
    }
  }
  if (!row.confined || !row.scopeUnit) {
    return {
      ok: false,
      taskId,
      action,
      error: 'unsupported',
      // SIGSTOP would "work" on the leader and leave every child running — a
      // half-frozen subtree is worse than an honest refusal.
      detail: 'freeze requires a cgroup scope; this task is unconfined',
    };
  }
  const res = await systemctl([action, row.scopeUnit], d);
  return res.ok
    ? { ok: true, taskId, action, detail: `scope ${row.scopeUnit} ${frozen ? 'frozen' : 'thawed'}` }
    : { ok: false, taskId, action, error: 'command_failed', detail: res.detail };
}

export interface LimitInput {
  memoryMaxBytes?: number | null;
  cpuWeight?: number | null;
  tasksMax?: number | null;
}

/** Change a live task's budget without restarting it. */
export async function limitTask(
  taskId: string,
  limits: LimitInput,
  opts: ControlDeps = {},
): Promise<ControlOutcome> {
  const d = deps(opts);
  const row = await getTask(taskId);
  if (!row) return { ok: false, taskId, action: 'limit', error: 'task_not_found' };
  if (!isLiveOwnedState(row.state)) {
    return { ok: false, taskId, action: 'limit', error: 'not_live', detail: `state is ${row.state}` };
  }
  if (!row.confined || !row.scopeUnit) {
    return {
      ok: false,
      taskId,
      action: 'limit',
      error: 'unsupported',
      detail: 'budgets are systemd scope properties; this task is unconfined',
    };
  }
  const props: string[] = [];
  const appliedLimits: {
    memoryMaxBytes?: number;
    cpuWeight?: number;
    tasksMax?: number;
  } = {};
  if (limits.memoryMaxBytes != null) {
    appliedLimits.memoryMaxBytes = Math.floor(limits.memoryMaxBytes);
    props.push(`MemoryMax=${appliedLimits.memoryMaxBytes}`);
  }
  if (limits.cpuWeight != null) {
    appliedLimits.cpuWeight = Math.floor(limits.cpuWeight);
    props.push(`CPUWeight=${appliedLimits.cpuWeight}`);
  }
  if (limits.tasksMax != null) {
    appliedLimits.tasksMax = Math.floor(limits.tasksMax);
    props.push(`TasksMax=${appliedLimits.tasksMax}`);
  }
  if (props.length === 0) {
    return { ok: false, taskId, action: 'limit', error: 'no_target', detail: 'no limits supplied' };
  }
  const res = await systemctl(['set-property', '--runtime', row.scopeUnit, ...props], d);
  if (!res.ok) {
    return { ok: false, taskId, action: 'limit', error: 'command_failed', detail: res.detail };
  }

  try {
    const persisted = await updateTaskLimits(taskId, appliedLimits);
    if (!persisted) {
      return {
        ok: false,
        taskId,
        action: 'limit',
        error: 'persistence_failed',
        detail: `systemd accepted ${props.join(' ')}, but the live task ledger did not record the change`,
      };
    }
  } catch (error) {
    return {
      ok: false,
      taskId,
      action: 'limit',
      error: 'persistence_failed',
      detail: `systemd accepted ${props.join(' ')}, but persisting the live task ledger failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return { ok: true, taskId, action: 'limit', detail: props.join(' ') };
}
