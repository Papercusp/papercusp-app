/**
 * task-manager/adopt-terminal-session — give a TERMINAL-launched psu session a
 * ledger row (terminal-psu-session-enrolment-2026-08-24, WI-41197).
 *
 * ── THE HOLE THIS FILLS ─────────────────────────────────────────────────────
 *
 * Every enrolment seam we have hangs off a SPAWN: `managedSpawn` for async
 * callers, `beginSyncEnrolment` for sync ones, and `lint:no-unenrolled-spawn`
 * to catch a new `detached: true` site that skipped both. A session the owner
 * starts by typing `psu` into a terminal crosses NONE of them — the launcher is
 * `exec`'d by an interactive shell, so there is no spawn site in our code to
 * enrol at and nothing for the guard to fire on.
 *
 * Measured 2026-08-24T01:37Z: 49 live `vte-spawn-*.scope` groups running
 * `psu-launcher.mjs`, every one reported as `foreign` by `processes:list`,
 * every one with no `taskId`. No taskId means no provenance in the pane, no
 * `processes:kill { taskId }` (the only safe kill path — pattern-killing is
 * forbidden and has twice killed the owner's desktop), and nothing that sees
 * the corpse when the session dies. That last one is the residue mechanism: on
 * 2026-08-23 this class reached 33 scopes / 118 processes of dead residue
 * before anyone noticed. Both confirmed failure modes die BEFORE declaring
 * `coord_presence`, so presence structurally cannot catch them; cgroup
 * enrolment can, because it does not depend on the agent ever taking a turn.
 *
 * ── WHY THE HEARTBEAT, NOT THE LAUNCH (D-002) ───────────────────────────────
 *
 * `startSupervisorBeat` already POSTs `{ ownerId, pid: process.pid, host, tty }`
 * to `/bootstrap-su/heartbeat` every ~60s for the life of every psu session, and
 * that route already parses and validates the pid — it is documented there as
 * "the ONE call site that may legitimately report a real pid, since the launcher
 * genuinely runs as the agent's own parent process". So the operator ALREADY
 * receives everything this module needs, from every live session, once a minute.
 *
 * Adopting on the beat rather than at launch buys three things a launch-time
 * hook cannot:
 *
 *   RETROACTIVE  the sessions already running (some 79h old) enrol within one
 *                beat. A launch-time hook only ever covers sessions started
 *                after the deploy.
 *   ZERO-TOUCH   `psu-launcher.mjs` is not modified at all — no `.mjs`→TS
 *                import, no PG client in the launcher, no `tsx` shell-out.
 *   SELF-HEALING a failed ledger write, an operator restart, or a row closed by
 *                mistake is repaired by the NEXT beat. A launch hook gets one
 *                attempt per session, forever.
 *
 * ── WHY UNCONFINED, ADOPTING THE EXISTING CGROUP (D-003) ────────────────────
 *
 * `beginSyncEnrolment`'s CONFINED branch enrols by shelling out to `systemd-run`
 * to CREATE a transient scope. That is impossible here twice over: the launcher
 * already lives inside a `vte-spawn-*.scope` and cannot relocate itself, and
 * `systemd-run --scope` is refused inside an agent session by the
 * native-scheduler lockout. The UNCONFINED branch needs no new primitive — it
 * never invokes `systemd-run`, and `completeSyncEnrolment` records
 * `readProcessCgroupPath(pid)`, so passing the LAUNCHER'S pid adopts its real
 * cgroup. The reconciler then matches the row by `processIdentity`
 * (pid + start ticks), not by scope name.
 *
 * `confined: false` is the semantically correct claim, not a workaround: we do
 * not own this cgroup's lifetime. The terminal window does — killing the scope
 * would close the owner's window.
 *
 * ── VISIBLE ONLY (D-001, owner ruling) ──────────────────────────────────────
 *
 * Rows are stamped `autoReapExempt: true` and MUST stay exempt from every
 * automated reaper. Enrolment exists so a pileup becomes VISIBLE and so a human
 * or an agent can make a DELIBERATE `processes:kill { taskId }` — never so
 * something kills the owner's terminals on a timer.
 */

import { pinModuleState } from '@papercusp/module-singleton';
import { readProcessIdentity } from '../process-identity';
import { nodeCgroupFs, readProcessCgroupPath, readProcessCmdline, type CgroupFs } from './cgroup-read';
import { taskManagerEnabledSync } from './enabled';
import { beginSyncEnrolment, completeSyncEnrolment } from './enroll-sync';
import { closeTask, listTasks, markSpawned } from './store';
import type { TaskRow, TaskSpec } from './types';

/** Stamped on every row this module writes. The reaper exemption and the
 *  `processes:list` pane both key off it, so it is a contract, not a label. */
export const TERMINAL_LAUNCH_SURFACE = 'terminal';

/**
 * Why an adoption attempt ended the way it did. Every non-`adopted` value is a
 * legitimate steady state, not an error — the beat runs once a minute per
 * session and `cached` is what almost every call returns.
 */
export type AdoptTerminalSessionReason =
  | 'adopted' // a new ledger row was written
  | 'cached' // this operator already adopted this owner+pid
  | 'existing-row' // a live row already covers it (another operator, or a restart)
  | 'flag-off' // task manager disabled — byte-identical-to-pre-feature
  | 'no-owner' // beat carried no ownerId
  | 'no-pid' // beat carried no usable pid (an older launcher, or headless)
  | 'pid-not-alive' // the reported pid is gone or unreadable
  | 'error'; // the ledger write failed; the NEXT beat retries

export interface AdoptTerminalSessionInput {
  /** The psu session's stable coord owner id, as the beat reports it. */
  ownerId: string;
  /** The LAUNCHER'S own pid — the supervisor that parents the agent CLI. */
  pid?: number | null;
  host?: string | null;
  /** The terminal device this launch owns, when the launcher knows it. */
  tty?: string | null;
  workspaceId?: string;
}

export interface AdoptTerminalSessionResult {
  adopted: boolean;
  taskId: string | null;
  reason: AdoptTerminalSessionReason;
}

export interface AdoptTerminalSessionDeps {
  fs?: CgroupFs;
  listTasks?: typeof listTasks;
  begin?: typeof beginSyncEnrolment;
  complete?: typeof completeSyncEnrolment;
  enabled?: typeof taskManagerEnabledSync;
  readIdentity?: typeof readProcessIdentity;
  markSpawned?: typeof markSpawned;
}

/**
 * Owner → the adoption this operator already performed.
 *
 * Pinned per the shared-lib singleton rule: a second module record (tsx's CJS
 * preflight, a bare vs relative specifier, a bundled copy beside source) would
 * give one caller a private cache while another wrote to a different one, and
 * the symptom would be a duplicate ledger row per beat — 1,440 rows a day per
 * session — rather than anything that throws.
 *
 * This is a NEGATIVE cache only: it exists so the steady-state beat costs no
 * database read at all. It is never consulted to decide that a row is healthy,
 * and an operator restart correctly empties it, costing exactly one `listTasks`
 * read per owner before it warms again.
 */
const state = pinModuleState('@papercusp/operator-core.task-manager.adopt-terminal-session', () => ({
  byOwner: new Map<string, { pid: number; taskId: string }>(),
}));

/** True for a row this module wrote (or an equivalent one from another operator). */
export function isAdoptedTerminalSessionRow(row: Pick<TaskRow, 'detail'>): boolean {
  const detail = row.detail as Record<string, unknown> | null | undefined;
  return detail?.launchSurface === TERMINAL_LAUNCH_SURFACE;
}

/**
 * Adopt one live terminal-launched psu session into the task ledger.
 *
 * Best-effort by contract and NEVER throws: the caller is a liveness heartbeat,
 * and a ledger fault must not break the liveness signal for a live agent. Every
 * failure path leaves the cache cold so the next beat retries.
 */
export async function adoptTerminalSession(
  input: AdoptTerminalSessionInput,
  deps: AdoptTerminalSessionDeps = {},
): Promise<AdoptTerminalSessionResult> {
  const miss = (reason: AdoptTerminalSessionReason): AdoptTerminalSessionResult => ({
    adopted: false,
    taskId: null,
    reason,
  });

  const ownerId = input.ownerId?.trim() ?? '';
  if (!ownerId) return miss('no-owner');

  const pid = input.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return miss('no-pid');

  // Checked before the cache so flipping the flag OFF stops new rows immediately
  // rather than after the cache happens to evict.
  const enabled = deps.enabled ?? taskManagerEnabledSync;
  if (!enabled()) return miss('flag-off');

  // The steady state: ~50 sessions beating once a minute cost nothing here.
  const cached = state.byOwner.get(ownerId);
  if (cached && cached.pid === pid) return { adopted: false, taskId: cached.taskId, reason: 'cached' };

  const fs = deps.fs ?? nodeCgroupFs;
  const readIdentity = deps.readIdentity ?? readProcessIdentity;

  // A pid we cannot read is a pid we must not enrol: `markSpawned` would write a
  // row with no identity, which the reconciler can only ever strand. The beat
  // arriving at all is not proof the sender is still alive by the time we act.
  const identity = readIdentity(pid);
  if (!identity) return miss('pid-not-alive');

  try {
    const list = deps.listTasks ?? listTasks;
    const live = await list({
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      launchedBy: ownerId,
      classes: ['agent-session'],
      states: ['pending', 'running'],
      limit: 50,
    });
    const existing = live.find(
      (row) => isAdoptedTerminalSessionRow(row) && (row.detail as Record<string, unknown>)?.supervisorPid === pid,
    );
    if (existing) {
      // A row can be HALF-WRITTEN: `registerTask` commits, then the
      // fire-and-forget `markSpawned` does not (an operator restart or a crash
      // inside that window). The result is a `pending` row with no pid and no
      // cgroup — which the reconciler can never match, so it ages into a strand.
      //
      // Repairing it here is not optional, because this branch is a TRAP without
      // it: the broken row IS found by the query above, so every later beat
      // would return `existing-row`, cache it, and never fix it. Observed for
      // real during live verification (WI-41197), where the row sat `pending`
      // with `pid=null` and the session stayed `foreign` despite being enrolled.
      if (existing.pid == null || !existing.processIdentity) {
        await (deps.markSpawned ?? markSpawned)(existing.taskId, {
          pid,
          processIdentity: identity,
          scopeUnit: null,
          cgroupPath: readProcessCgroupPath(pid, fs),
          confined: false,
          unconfinedReason: 'caller-veto',
        });
      }
      state.byOwner.set(ownerId, { pid, taskId: existing.taskId });
      return { adopted: false, taskId: existing.taskId, reason: 'existing-row' };
    }

    const begin = deps.begin ?? beginSyncEnrolment;
    const complete = deps.complete ?? completeSyncEnrolment;

    // confine:false is the whole point — see the header. This branch never
    // shells out to systemd-run, so it works inside the agent-session lockout.
    const enrolment = begin({ class: 'agent-session' }, { confine: false });
    if (!enrolment.enrolled) return miss('flag-off');

    const cmdline = readProcessCmdline(pid, fs);
    const spec: TaskSpec = {
      class: 'agent-session',
      title: cmdline ? cmdline.slice(0, 400) : `psu terminal session (${ownerId})`,
      argv: [],
      launchedBy: ownerId,
      detail: {
        launchSurface: TERMINAL_LAUNCH_SURFACE,
        // D-001, owner ruling: visible only. The automated reaper must skip this.
        autoReapExempt: true,
        // The hand-off key `bindLiveAgentSessionTasksToNativeSession` matches on,
        // which is how this row later gains its native session id.
        coordOwnerId: ownerId,
        supervisorPid: pid,
        ...(input.host ? { host: input.host } : {}),
        ...(input.tty ? { tty: input.tty } : {}),
      },
    };

    complete(enrolment, spec, pid, {
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      fs,
    });

    // completeSyncEnrolment is fire-and-forget for spawn callers, but we are not
    // on a spawn path and we must not cache a write that failed — that would
    // suppress the retry the next beat would otherwise perform.
    if (enrolment.registrationReady) await enrolment.registrationReady;

    // Then CLOSE THE PENDING WINDOW deterministically.
    //
    // `registrationReady` covers the INSERT only; the identity/pid/cgroup update
    // rides a separate fire-and-forget chain. A row observed between the two has
    // no pid and no identity, so the reconciler cannot match it and strands it —
    // measured on WI-41197's live verification, where exactly that happened
    // (`0mt6m1lxf1wf75pejcl` → `stranded` inside one reconcile tick).
    //
    // Re-issuing the same update here is idempotent (it is an UPDATE with fixed
    // values, and `markSpawned`'s own pending-state guard tolerates the double
    // write), and it means the row is COMPLETE by the time this returns rather
    // than "complete shortly, if the process lives long enough".
    await (deps.markSpawned ?? markSpawned)(enrolment.taskId, {
      pid,
      processIdentity: identity,
      scopeUnit: null,
      cgroupPath: readProcessCgroupPath(pid, fs),
      confined: false,
      unconfinedReason: 'caller-veto',
    });

    state.byOwner.set(ownerId, { pid, taskId: enrolment.taskId });
    return { adopted: true, taskId: enrolment.taskId, reason: 'adopted' };
  } catch (error) {
    // Loud but never fatal, and deliberately NOT cached: the next beat retries.
    const detail = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    console.warn(`[task-manager] terminal session adoption failed for ${ownerId.slice(0, 120)}: ${detail}`);
    return miss('error');
  }
}

/**
 * Close adopted rows whose supervisor is CONFIRMED gone, at session end.
 *
 * ── WHY THIS IS NOT OPTIONAL ────────────────────────────────────────────────
 *
 * An unconfined row is matched by `processIdentity`, so when the launcher exits
 * the reconciler finds no match and files the row `stranded` — "the ledger said
 * running, the kernel disagreed". That verdict is correct for an escape and
 * badly wrong for the ~50 psu sessions that end normally every day. Left alone,
 * every routine Ctrl-D would manufacture a strand, and as `TERMINAL_TASK_STATES`
 * puts it, "a continuous stream of routine shutdowns filed as `stranded` buries
 * the one real escape that state exists to surface". Closing the row here is
 * what keeps the residue channel meaningful after this feature lands.
 *
 * ── WHY IT CLOSES RATHER THAN KILLS, AND ONLY WHEN PROVEN DEAD ──────────────
 *
 * Closing a LEDGER ROW is not signalling a process, so the auto-reap exemption
 * (D-001) is untouched: nothing here can reach the owner's terminal.
 *
 * A row is closed only when the supervisor pid is positively gone. If the
 * session's adv row ended while the launcher process is STILL ALIVE, the row
 * stays live and visible on purpose — that is precisely the zombie class this
 * whole item exists to expose (a launcher whose session reached a terminal state
 * while the node process lived on, holding a fleet slot and a cgroup with
 * nothing in it). Closing it there would re-hide the exact corpse we are
 * hunting.
 *
 * The identity re-check is what makes "gone" trustworthy: pid wrap happens
 * roughly daily under fleet load here, so a live pid that no longer matches the
 * recorded `processIdentity` is someone else's process, not ours.
 */
export async function closeAdoptedTerminalSessions(
  rows: readonly TaskRow[],
  deps: { readIdentity?: typeof readProcessIdentity; close?: typeof closeTask } = {},
): Promise<{ closedTaskIds: string[]; stillLiveTaskIds: string[] }> {
  const readIdentity = deps.readIdentity ?? readProcessIdentity;
  const close = deps.close ?? closeTask;
  const closedTaskIds: string[] = [];
  const stillLiveTaskIds: string[] = [];

  for (const row of rows) {
    if (!isAdoptedTerminalSessionRow(row)) continue;
    const pid = row.detail?.supervisorPid;
    const alive =
      typeof pid === 'number' && pid > 0
        ? // Same pid AND same start time. An identity we cannot read is "gone";
          // a mismatch is pid reuse, which is also "our process is gone".
          readIdentity(pid) !== null && (!row.processIdentity || readIdentity(pid) === row.processIdentity)
        : false;
    if (alive) {
      stillLiveTaskIds.push(row.taskId);
      continue;
    }
    try {
      await close(row.taskId, { state: 'exited', exitReason: 'terminal session ended' });
      closedTaskIds.push(row.taskId);
      const ownerId = row.detail?.coordOwnerId;
      if (typeof ownerId === 'string') forgetAdoptedTerminalSession(ownerId);
    } catch {
      // Best-effort: the reconciler still resolves the row, just later and as a
      // strand. Never let bookkeeping fail a session-end cleanup pass.
    }
  }
  return { closedTaskIds, stillLiveTaskIds };
}

/**
 * Forget one owner's cached adoption so the next beat re-reads the ledger.
 *
 * Called when a session ends: the row is closed, so a LATER beat from a new
 * launcher under the same owner id must not be silenced by a stale cache entry.
 */
export function forgetAdoptedTerminalSession(ownerId: string): void {
  state.byOwner.delete(ownerId.trim());
}

/** Test seam: drop every cached adoption. */
export function resetAdoptedTerminalSessionsForTest(): void {
  state.byOwner.clear();
}
