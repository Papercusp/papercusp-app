/**
 * Delayed lease cleanup for the authoritative tracked-session end writer.
 *
 * `activity:report` remains the seconds-fast path for a normal SessionEnd hook,
 * but that hook is intentionally best-effort. The psu parent independently
 * records the child exit through `markAdvSessionEnded`; before this hook, an end
 * report that arrived without the lifecycle report left file/resource locks and
 * work-item leases alive until their TTL or the hourly reaper.
 *
 * The settle + liveness check is load-bearing. A carry-respawn can briefly mark
 * the old process ended while a successor starts under the SAME owner id. We
 * release only when the recorded row is still ended, no newer/open adv session
 * exists for the owner, and the shared liveness oracle does not see a live
 * heartbeat, host, wake delivery, armed engine loop, or process. Claims are
 * deliberately excluded
 * from that oracle: a dead owner's own lease cannot prove the owner alive.
 */
import { getOrgPg } from '@papercusp/db-org';
import { isAutoReapExempt, type TaskRow } from './task-manager/types';

export const SESSION_END_LEASE_RELEASE_DELAY_MS = 15_000;
/**
 * A liveness signal can still belong to the ending process when the first
 * settle pass runs. Retry that protected result instead of leaving the lock
 * until the periodic reaper, but keep the retry window bounded.
 */
export const SESSION_END_LEASE_RELEASE_RETRY_DELAY_MS = 15_000;
export const SESSION_END_LEASE_RELEASE_MAX_OWNER_LIVE_RETRIES = 3;
/**
 * The longest resume reservation `acquireAdvSessionResume` will grant (it clamps
 * the requested lease to 300s). A reservation younger than this may still be in
 * flight, so the delayed pass must not treat its row as dead. Kept local so this
 * hook's eager module graph stays leaf-like (adv-sessions imports this hook);
 * pinned to the adv-sessions bound by session-end-lease-release-hook.test.ts.
 */
export const RESUME_RESERVATION_MAX_LEASE_SEC = 300;

export interface SessionEndLeaseRow {
  id: number;
  workspaceId: string;
  coordOwnerId: string | null;
  sessionId: string | null;
  cwd: string | null;
  endedAt: Date | null;
  ownerHasOpenSession: boolean;
  /** The poison marker matches this exact ended adv-session generation. */
  poisoned?: boolean;
  /**
   * A resume reservation is held on this row and has not yet finalized or been
   * released (EI-24355092354007517). The keyed resume path leaves `ended_at` set
   * from acquisition until the new child reaches `beforeReady`, so an ended row
   * with a live reservation is a successor STARTING UP, not a dead session.
   */
  resumeInFlight?: boolean;
}

export interface SessionEndLeaseReleaseDeps {
  loadRow?: (advSessionId: number) => Promise<SessionEndLeaseRow | null>;
  /**
   * Receives the ENDING owner's id so the protection query can ignore that
   * owner's own (still-fresh) presence row — EI-22651749738479868.
   */
  loadProtectedOwners?: (endingOwnerId: string) => Promise<ReadonlySet<string>>;
  releaseLocks?: typeof import('./agent-tools/locks/release-all-owned').releaseAllOwnedLocks;
  releaseWorkItems?: typeof import('./work-item-lease-release').releaseAllWorkItemLeasesForOwner;
  listTasks?: typeof import('./task-manager/store').listTasks;
  killTask?: typeof import('./task-manager/control').killTask;
  closeAdoptedTerminalSessions?: typeof import('./task-manager/adopt-terminal-session').closeAdoptedTerminalSessions;
}

interface SessionEndLeaseReleaseScheduleOptions {
  delayMs?: number;
  retryDelayMs?: number;
  maxOwnerLiveRetries?: number;
  deps?: SessionEndLeaseReleaseDeps;
}

export type SessionEndLeaseReleaseReason =
  | 'row-not-found'
  | 'row-not-ended'
  | 'owner-missing'
  | 'owner-resumed'
  | 'owner-live'
  | 'resume-in-flight'
  | 'partial-failure';

export interface SessionEndLeaseReleaseResult {
  ok: boolean;
  reason?: SessionEndLeaseReleaseReason;
  ownerId?: string;
  releasedPaths?: string[];
  resourcesReleased?: number;
  releasedWorkItems?: string[];
  claimsCleared?: number;
  agentSessionTaskIds?: string[];
  reapedTaskIds?: string[];
  failedTaskIds?: string[];
  /** Live rows this session owned that were deliberately NOT reaped because they
   *  are auto-reap exempt (terminal-launched psu sessions — D-001). Reported
   *  rather than silently dropped: "we skipped 3" and "there were none" are
   *  different facts, and only one of them means the exemption is working. */
  exemptTaskIds?: string[];
  /** Live rows under the same native session id that STARTED after the row's
   *  recorded end — a resume successor, deliberately NOT reaped
   *  (EI-24355092354007517). Reported so "skipped a successor" is visible. */
  successorTaskIds?: string[];
  failedEffects?: Array<'locks' | 'work-items' | 'tasks'>;
}

/**
 * Split the session's live agent-session rows into the ones this reaper may
 * signal and the ones it must not.
 *
 * Pulled out as a pure function on purpose. The exemption is an OWNER RULING
 * (plan terminal-psu-session-enrolment-2026-08-24 D-001, avi 2026-08-24:
 * "Visible only — never auto-reap"), and a ruling that lives as an inline
 * `.filter()` inside an async cleanup pass can only be tested through the whole
 * hook, which makes it easy to delete and hard to notice. Here it is one named,
 * directly-testable decision — and the test file keeps a deliberately-wrong
 * partition beside it as a permanent control, so the guard is provably
 * falsifiable without ever mutating this shared tree.
 *
 * `exempt` is RETURNED rather than dropped because "we skipped one" and "there
 * were none" are different facts, and only the first proves the rule ran.
 */
export function partitionReapableTasks(rows: readonly TaskRow[]): {
  reapable: TaskRow[];
  exempt: TaskRow[];
} {
  const reapable: TaskRow[] = [];
  const exempt: TaskRow[] = [];
  for (const row of rows) (isAutoReapExempt(row) ? exempt : reapable).push(row);
  return { reapable, exempt };
}

async function loadSessionEndLeaseRow(advSessionId: number): Promise<SessionEndLeaseRow | null> {
  const { sql } = getOrgPg();
  type Row =
    {
      id: number;
      workspace_id: string;
      coord_owner_id: string | null;
      session_id: string | null;
      cwd: string | null;
      ended_at: Date | string | null;
      owner_has_open_session: boolean;
      poisoned: boolean;
      resume_in_flight: boolean;
    }[];
  let rows: Row;
  try {
    rows = await sql<Row>`
      SELECT s.id, s.workspace_id, s.coord_owner_id, s.session_id, s.cwd, s.ended_at,
             (s.resume_claim_key IS NOT NULL
               AND s.resume_claimed_at > now() - make_interval(secs => ${RESUME_RESERVATION_MAX_LEASE_SEC})
             ) AS resume_in_flight,
             COALESCE(
               b.control_state #>> '{lifecycle,poisoned,advSessionId}' = s.id::text
               AND date_trunc('milliseconds', (b.control_state #>> '{lifecycle,poisoned,startedAt}')::timestamptz)
                     = date_trunc('milliseconds', s.started_at),
               false
             ) AS poisoned,
             EXISTS (
               SELECT 1
                 FROM harness_shared.adv_sessions newer
                WHERE newer.coord_owner_id = s.coord_owner_id
                  AND newer.ended_at IS NULL
             ) AS owner_has_open_session
        FROM harness_shared.adv_sessions s
        LEFT JOIN harness_shared.session_briefs b ON b.owner_id = s.coord_owner_id
       WHERE s.id = ${advSessionId}
       LIMIT 1
    `;
  } catch (error) {
    // session_briefs is an optional older-schema surface. A node without its
    // migration still performs the ordinary liveness-checked cleanup; only the
    // special poison override is unavailable there.
    if ((error as { code?: string } | null)?.code !== '42P01') throw error;
    rows = await sql<Row>`
      SELECT s.id, s.workspace_id, s.coord_owner_id, s.session_id, s.cwd, s.ended_at,
             (s.resume_claim_key IS NOT NULL
               AND s.resume_claimed_at > now() - make_interval(secs => ${RESUME_RESERVATION_MAX_LEASE_SEC})
             ) AS resume_in_flight,
             false AS poisoned,
             EXISTS (
               SELECT 1
                 FROM harness_shared.adv_sessions newer
                WHERE newer.coord_owner_id = s.coord_owner_id
                  AND newer.ended_at IS NULL
             ) AS owner_has_open_session
        FROM harness_shared.adv_sessions s
       WHERE s.id = ${advSessionId}
       LIMIT 1
    `;
  }
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    coordOwnerId: row.coord_owner_id,
    sessionId: row.session_id,
    cwd: row.cwd,
    endedAt: row.ended_at == null ? null : new Date(row.ended_at),
    ownerHasOpenSession: row.owner_has_open_session,
    poisoned: row.poisoned === true,
    resumeInFlight: row.resume_in_flight === true,
  };
}

/**
 * EI-24355092354007517: a task that STARTED after the row's recorded end cannot
 * belong to the incarnation that ended. It is a resume successor under the same
 * native session id, spawned between this pass's row read and its task listing
 * (or before a reservation became visible). Reaping it killed exact resumes in
 * their startup window with SIGTERM (exit 143). A missing or unparseable start
 * time stays reapable, so the dead incarnation's own rows are never exempted.
 */
export function partitionSuccessorTasks(
  rows: readonly TaskRow[],
  endedAt: Date,
): { ended: TaskRow[]; successors: TaskRow[] } {
  const endMs = endedAt.getTime();
  const ended: TaskRow[] = [];
  const successors: TaskRow[] = [];
  for (const row of rows) {
    const startedMs = row.startedAt ? Date.parse(row.startedAt) : Number.NaN;
    (Number.isFinite(startedMs) && Number.isFinite(endMs) && startedMs > endMs ? successors : ended).push(row);
  }
  return { ended, successors };
}

async function loadProtectedOwners(endingOwnerId: string): Promise<ReadonlySet<string>> {
  // Dynamic imports avoid turning adv-sessions -> this hook -> idle-session-reaper
  // -> adv-sessions into an eager module cycle. This path runs only after an end.
  const [{ gatherProtectedSessionOwners, liveHostOwnerSet }, { listLiveHostsAsync }] = await Promise.all([
    import('./idle-session-reaper'),
    import('./events/await/psu-pty-discovery'),
  ]);
  let liveHostOwners = new Set<string>();
  try {
    liveHostOwners = liveHostOwnerSet(await listLiveHostsAsync());
  } catch {
    // A missing host signal protects nobody, but the heartbeat/wake/PID legs
    // below still fail closed for any owner they can establish as live.
  }
  return gatherProtectedSessionOwners(getOrgPg().sql, {
    includeClaimHolders: false,
    liveHostOwners,
    confirmDeadPids: true,
    ignoreOwnPresenceFor: endingOwnerId,
  });
}

/**
 * Run one liveness-checked cleanup pass for a tracked session end.
 *
 * Both effects are independently fail-open, matching activity:report: a lock
 * database fault must not strand the work-item cleanup, and vice versa. The
 * ordinary TTL/hourly reaper remains the final backstop for a failed effect.
 */
export async function runSessionEndLeaseRelease(
  advSessionId: number,
  deps: SessionEndLeaseReleaseDeps = {},
): Promise<SessionEndLeaseReleaseResult> {
  const row = await (deps.loadRow ?? loadSessionEndLeaseRow)(advSessionId);
  if (!row) return { ok: false, reason: 'row-not-found' };
  if (!row.endedAt) return { ok: false, reason: 'row-not-ended' };
  const ownerId = row.coordOwnerId?.trim() ?? '';
  if (!ownerId) return { ok: false, reason: 'owner-missing' };
  if (row.ownerHasOpenSession) return { ok: false, reason: 'owner-resumed', ownerId };
  // A held resume reservation means a successor is starting on THIS row. It
  // either finalizes (row reopens → row-not-ended) or releases (row stays ended
  // → a later retry cleans up). Acting now would reap the starting child.
  if (row.resumeInFlight) return { ok: false, reason: 'resume-in-flight', ownerId };

  const protectedOwners = await (deps.loadProtectedOwners ?? loadProtectedOwners)(ownerId);
  // A transcript-confirmed poison marker is an explicit verdict that this exact
  // ended incarnation cannot take more work. Its still-open host/heartbeat must
  // not hold the old leases forever. The newer-open-session guard above remains
  // authoritative for a fresh successor under the same owner id.
  if (protectedOwners.has(ownerId) && !row.poisoned) return { ok: false, reason: 'owner-live', ownerId };

  // Keep the delayed hook's eager graph leaf-like. These modules eventually
  // reach adv-sessions through coordination/work-item infrastructure, while
  // adv-sessions dynamically imports this hook after recording an end. The
  // defaults are needed only after the delayed pass has established that the
  // owner is really gone, so resolve them here rather than at module load.
  const [coordinationDomainModule, lockModule, terminalModule, taskControlModule, taskStoreModule] =
    await Promise.all([
      import('./agent-tools/locks/coordination-domain'),
      deps.releaseLocks ? undefined : import('./agent-tools/locks/release-all-owned'),
      deps.closeAdoptedTerminalSessions ? undefined : import('./task-manager/adopt-terminal-session'),
      deps.killTask ? undefined : import('./task-manager/control'),
      deps.listTasks ? undefined : import('./task-manager/store'),
    ]);
  const releaseLocks = deps.releaseLocks ?? lockModule!.releaseAllOwnedLocks;
  const listTasks = deps.listTasks ?? taskStoreModule!.listTasks;
  const killTask = deps.killTask ?? taskControlModule!.killTask;
  const closeAdoptedTerminalSessions =
    deps.closeAdoptedTerminalSessions ?? terminalModule!.closeAdoptedTerminalSessions;

  const reapAgentSessionTasks = async () => {
    const sessionId = row.sessionId?.trim() ?? '';
    if (!sessionId) {
      return {
        taskIds: [] as string[],
        reapedTaskIds: [] as string[],
        failedTaskIds: [] as string[],
        exemptTaskIds: [] as string[],
      };
    }
    const listed = await listTasks({
      workspaceId: row.workspaceId,
      sessionId,
      states: ['pending', 'running'],
      classes: ['agent-session'],
      limit: 2_000,
    });
    // ⛔ OWNER RULING (terminal-psu-session-enrolment-2026-08-24 D-001, avi
    // 2026-08-24): a TERMINAL-launched session enrolled by
    // `adopt-terminal-session` is VISIBLE ONLY and must never be auto-reaped.
    //
    // This is the ONE automated killer of live `agent-session` rows, so it is
    // where the exemption has to live. It deliberately does NOT live inside
    // `killTask`: a DELIBERATE `processes:kill { taskId }` by an agent or the
    // owner must keep working, and that kill path is the entire reason those
    // sessions are enrolled in the first place.
    //
    // The stakes are asymmetric and physical. We do not own a `vte-spawn`
    // scope's lifetime — the terminal window does — so reaping one of these
    // rows closes the owner's terminal window and takes the live agent inside
    // it with it. Auto-reaping was put to the owner in two forms
    // (reap-when-provably-dead, reap-fleet-spawned-only) and both were
    // declined. Do not widen this without a fresh owner ruling.
    const { ended: endedIncarnation, successors } = partitionSuccessorTasks(listed, row.endedAt!);
    const { reapable: tasks, exempt } = partitionReapableTasks(endedIncarnation);
    const outcomes = await Promise.allSettled(
      tasks.map((task) => killTask(task.taskId, { reapTerminalResidue: true })),
    );
    // Exempt rows are never SIGNALLED, but a row whose supervisor is provably
    // gone is still CLOSED — closing a ledger row touches no process, so the
    // exemption is intact. Without this every ordinary psu exit would reach the
    // reconciler as a `stranded` row, and a steady drip of routine shutdowns
    // filed as strands is exactly what buries the one real escape. A row whose
    // launcher is STILL ALIVE after its session ended is deliberately left open:
    // that is the zombie this feature exists to make visible.
    await closeAdoptedTerminalSessions(exempt).catch(() => ({
      closedTaskIds: [],
      stillLiveTaskIds: [],
    }));
    const reapedTaskIds: string[] = [];
    const failedTaskIds: string[] = [];
    for (let index = 0; index < tasks.length; index += 1) {
      const outcome = outcomes[index];
      if (outcome?.status === 'fulfilled' && outcome.value.ok) reapedTaskIds.push(tasks[index].taskId);
      else failedTaskIds.push(tasks[index].taskId);
    }
    return {
      taskIds: tasks.map((task) => task.taskId),
      reapedTaskIds,
      failedTaskIds,
      exemptTaskIds: exempt.map((task) => task.taskId),
      successorTaskIds: successors.map((task) => task.taskId),
    };
  };

  const primaryCoordinationDomain = row.cwd?.trim()
    ? coordinationDomainModule.lockDomainForProjectDir(row.cwd.trim())
    : coordinationDomainModule.fileLockCoordinationDomain();
  // Keep the work-item lease implementation out of this module's eager graph:
  // work-item-lease-release -> work-items -> … -> adv-sessions, while
  // adv-sessions dynamically imports this hook after recording an end. The
  // dependency is needed only once the delayed cleanup actually runs, so load
  // it here and keep a failed import scoped to the independent work-item leg.
  const workItemsPromise = deps.releaseWorkItems
    ? deps.releaseWorkItems(ownerId)
    : import('./work-item-lease-release').then(({ releaseAllWorkItemLeasesForOwner }) =>
        releaseAllWorkItemLeasesForOwner(ownerId),
      );
  const [locks, workItems, tasks] = await Promise.allSettled([
    releaseLocks({ ownerId, primaryCoordinationDomain }),
    workItemsPromise,
    reapAgentSessionTasks(),
  ]);

  const failedEffects: Array<'locks' | 'work-items' | 'tasks'> = [];
  if (locks.status === 'rejected') failedEffects.push('locks');
  if (workItems.status === 'rejected') failedEffects.push('work-items');
  if (tasks.status === 'rejected' || tasks.value.failedTaskIds.length > 0) failedEffects.push('tasks');

  return {
    ok: failedEffects.length === 0,
    ...(failedEffects.length ? { reason: 'partial-failure' as const, failedEffects } : {}),
    ownerId,
    releasedPaths: locks.status === 'fulfilled' ? locks.value.released : [],
    resourcesReleased: locks.status === 'fulfilled' ? locks.value.resourcesReleased : 0,
    releasedWorkItems: workItems.status === 'fulfilled' ? workItems.value.releasedIds : [],
    claimsCleared: workItems.status === 'fulfilled' ? workItems.value.claimsCleared : 0,
    agentSessionTaskIds: tasks.status === 'fulfilled' ? tasks.value.taskIds : [],
    reapedTaskIds: tasks.status === 'fulfilled' ? tasks.value.reapedTaskIds : [],
    failedTaskIds: tasks.status === 'fulfilled' ? tasks.value.failedTaskIds : [],
    exemptTaskIds: tasks.status === 'fulfilled' ? tasks.value.exemptTaskIds : [],
    successorTaskIds: tasks.status === 'fulfilled' ? tasks.value.successorTaskIds : [],
  };
}

interface ScheduledLeaseCleanup {
  stopped: boolean;
  timer?: ReturnType<typeof setTimeout>;
  running?: Promise<void>;
}

function scheduleSessionEndLeaseReleaseAttempt(
  advSessionId: number,
  opts: SessionEndLeaseReleaseScheduleOptions,
  ownerLiveRetries: number,
  job: ScheduledLeaseCleanup,
): void {
  if (job.stopped) return;
  const delayMs =
    ownerLiveRetries === 0
      ? (opts.delayMs ?? SESSION_END_LEASE_RELEASE_DELAY_MS)
      : (opts.retryDelayMs ?? SESSION_END_LEASE_RELEASE_RETRY_DELAY_MS);
  job.timer = setTimeout(() => {
    job.timer = undefined;
    job.running = runSessionEndLeaseRelease(advSessionId, opts.deps)
      .then((result) => {
        // Resume can reopen the SAME row before this delayed pass, or create
        // a successor row. Both are successful continuation, not cleanup
        // failures, and neither should schedule another attempt or warn.
        if (result.reason === 'owner-resumed' || result.reason === 'row-not-ended') return;
        // A starting resume resolves within its reservation lease, so retry it
        // on the same bounded budget as a still-live owner signal.
        if (result.reason === 'owner-live' || result.reason === 'resume-in-flight') {
          const maxRetries = Math.max(
            0,
            opts.maxOwnerLiveRetries ?? SESSION_END_LEASE_RELEASE_MAX_OWNER_LIVE_RETRIES,
          );
          if (ownerLiveRetries < maxRetries) {
            scheduleSessionEndLeaseReleaseAttempt(advSessionId, opts, ownerLiveRetries + 1, job);
          } else {
            console.warn(
              `[session-end-lease-release] adv ${advSessionId} owner ${result.ownerId ?? 'unknown'} ` +
                `remained live after ${maxRetries} retry(ies); periodic lease reaper remains the backstop`,
            );
          }
          return;
        }
        if (!result.ok) {
          console.warn(
            `[session-end-lease-release] adv ${advSessionId} cleanup did not fully apply: ${result.reason ?? 'unknown'}`,
          );
          return;
        }
        const released =
          (result.releasedPaths?.length ?? 0) +
          (result.resourcesReleased ?? 0) +
          (result.releasedWorkItems?.length ?? 0) +
          (result.claimsCleared ?? 0) +
          (result.reapedTaskIds?.length ?? 0);
        if (released > 0) {
          console.log(
            `[session-end-lease-release] adv ${advSessionId} / ${result.ownerId}: released ` +
              `${result.releasedPaths?.length ?? 0} file path(s), ${result.resourcesReleased ?? 0} resource lock(s), ` +
              `${result.releasedWorkItems?.length ?? 0} work-item lease(s), ${result.claimsCleared ?? 0} claim row(s), ` +
              `${result.reapedTaskIds?.length ?? 0} agent-session task(s)`,
          );
        }
      })
      .catch((error) => {
        console.warn(
          `[session-end-lease-release] adv ${advSessionId} pass failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }, delayMs);
  job.timer.unref?.();
}

/** Schedule the post-end pass without delaying the exiting parent/report. */
export function scheduleSessionEndLeaseRelease(
  advSessionId: number,
  opts: SessionEndLeaseReleaseScheduleOptions = {},
): { stop(): Promise<void> } {
  const job: ScheduledLeaseCleanup = { stopped: false };
  scheduleSessionEndLeaseReleaseAttempt(advSessionId, opts, 0, job);
  return {
    async stop() {
      job.stopped = true;
      clearTimeout(job.timer);
      await job.running;
    },
  };
}
