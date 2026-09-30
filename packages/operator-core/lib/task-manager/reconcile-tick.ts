/**
 * task-manager/reconcile-tick — the periodic pass that keeps the ledger honest
 * (task-manager-no-escape-2026-07-27, P-011 / P-012).
 *
 * Composition only: `scan` supplies kernel truth, `reconcile` decides, `store`
 * persists. The logic worth reading here is the REFUSAL TO ACT ON A BAD SCAN.
 *
 * Stranding is destructive to information — it closes a row and reports the task
 * as over. A scan that returned nothing because the cgroup root was missing, or
 * that hit its process cap, is indistinguishable ROW-BY-ROW from a box that
 * genuinely went idle. Acting on it would mass-strand every live task and report
 * a fleet-wide outage that did not happen. So a degraded scan updates what it can
 * positively confirm and declines to close anything, saying so in the summary.
 * "I could not tell" is a valid answer; a confident wrong one is not.
 *
 * REPORT-ONLY on residue (D-010): unaccounted processes are recorded and surfaced,
 * never killed. Until the classification has been right for a sustained window, an
 * auto-reaper acting on a false positive is strictly worse than the bypass it is
 * trying to police.
 */

import { absCgroupDir, nodeCgroupFs, sampleCgroup, type CgroupFs } from './cgroup-read';
import {
  reconcile,
  summarizeReconcile,
  scopeUnitOf,
  type ReconcileResult,
  type ResidueGroup,
  type ScannedProcess,
} from './reconcile';
import { scanProcesses, type ScanOptions, type ScanResult } from './scan';
import { inspectTaskUnitTerminals, resetFailedTaskUnit } from './scope-terminal-state';
import {
  clearVanishedUnaccounted,
  listLiveTasks,
  markEndedUnobserved,
  markStranded,
  residueTaskId,
  touchAlive,
  upsertUnaccounted,
} from './store';
import { isLiveOwnedState, taskIdFromScopeUnit, type TaskRow, type TaskState } from './types';

export interface ReconcileTickDeps {
  scan?: (opts: ScanOptions) => ScanResult | Promise<ScanResult>;
  listLive?: (workspaceId?: string) => Promise<TaskRow[]>;
  fs?: CgroupFs;
  now?: () => number;
  notify?: (msg: { summary: string; kind: 'message' | 'escalation' }) => Promise<void>;
  scanOptions?: ScanOptions;
  workspaceId?: string;
  graceMs?: number;
  /** Persist nothing — used by the `processes:list { live: true }` read path, which
   *  wants a fresh verdict without a write on a read. */
  dryRun?: boolean;
  /** D-018 — confirm which of a candidate set of scope units systemd has
   *  released. Injected for tests; defaults to the real systemctl-backed probe. */
  checkScopesReleased?: (units: readonly string[]) => Promise<ReadonlySet<string>>;
  /** P-012 terminal provenance probe. Kept separate from the legacy injected
   * release-only seam so existing tests can still exercise that narrow verdict. */
  inspectTaskUnitTerminals?: typeof inspectTaskUnitTerminals;
  resetFailedTaskUnit?: typeof resetFailedTaskUnit;
}

export interface ReconcileTickResult {
  summary: ReturnType<typeof summarizeReconcile>;
  result: ReconcileResult;
  scan: {
    ownedRootExists: boolean;
    ownedTruncated: boolean;
    foreignTruncated: boolean;
    processes: number;
    userManagerRoot: string | null;
  };
  /**
   * The processes the scan actually SAW, passed through rather than reduced to a
   * count (WI-6475, owner-reported: "the task manager shows no tasks, obviously we
   * have running tasks").
   *
   * The scan already walks every pid under our slice AND every signature-matching
   * process in the user manager, reading each one's cmdline — then the tick threw
   * all of it away and kept `processes: <number>`. So the pane could report "400
   * process(es) scanned · 111 foreign group(s)" while rendering an empty table,
   * which reads as broken however accurate the count is.
   *
   * Cheap: this is a passthrough of an array the scan already built, not a second
   * walk. Callers that only want the count keep reading `scan.processes`.
   */
  scannedProcesses: ScannedProcess[];
  /** True when the scan could not be trusted enough to close rows. */
  degraded: boolean;
  degradedReason?: string;
  touched: number;
  strandedCount: number;
  endedUnobservedCount: number;
  unaccountedPersisted: number;
  residueCleared: number;
  /**
   * Unaccounted groups confirmed across two healthy scans. The task-reconcile
   * action passes these to the exact managed-scope reaper; foreign and
   * unmanaged groups remain report-only there.
   */
  confirmedUnaccounted: ResidueGroup[];
}

export async function reconcileTick(deps: ReconcileTickDeps = {}): Promise<ReconcileTickResult> {
  const fs = deps.fs ?? nodeCgroupFs;
  const now = deps.now ?? Date.now;
  const scanFn = deps.scan ?? scanProcesses;
  const listLive = deps.listLive ?? listLiveTasks;

  const scan = await scanFn({ fs, ...(deps.scanOptions ?? {}) });
  const live = await listLive(deps.workspaceId);

  // D-018: for a live row whose scope is NOT visible in this scan — i.e. about to
  // strand — ask systemd whether that scope has actually been released before
  // `reconcile` decides between `stranded` (escape/anomaly) and
  // `endedUnobserved` (a routine end nobody happened to observe). Only query the
  // candidates that need it, never every live row.
  const seenScopes = new Set<string>();
  for (const p of scan.processes) {
    const unit = scopeUnitOf(p);
    if (unit) seenScopes.add(unit);
  }
  const candidateUnits = [
    ...new Set(
      live
        .filter((r) => isLiveOwnedState(r.state as TaskState) && r.scopeUnit && !seenScopes.has(r.scopeUnit))
        .map((r) => r.scopeUnit as string),
    ),
  ];
  const terminalByUnit = deps.checkScopesReleased
    ? new Map()
    : candidateUnits.length
      ? await (deps.inspectTaskUnitTerminals ?? inspectTaskUnitTerminals)(candidateUnits)
      : new Map();
  const releasedScopes = deps.checkScopesReleased
    ? candidateUnits.length
      ? await deps.checkScopesReleased(candidateUnits)
      : new Set<string>()
    : new Set(
        [...terminalByUnit.entries()]
          .filter(([, terminal]) => {
            const state = terminal.activeState;
            return Boolean(state && !['active', 'activating', 'reloading', 'deactivating'].includes(state));
          })
          .map(([unit]) => unit),
      );

  const result = reconcile(live, scan.processes, { now: now(), graceMs: deps.graceMs, releasedScopes });
  const summary = summarizeReconcile(result);

  // ── is this scan trustworthy enough to CLOSE rows? ───────────────────────
  let degradedReason: string | undefined;
  if (!scan.ownedRootExists && live.length > 0) {
    degradedReason =
      'our cgroup slice does not exist on this host — every row would strand, which is a scan fault, not an outage';
  } else if (scan.ownedTruncated) {
    // Only the OWNED cap degrades the verdict. A truncated FOREIGN pass means the
    // courtesy view is partial — it says nothing about whether our own tasks are
    // alive, and letting it disable stranding put the reconciler into permanent
    // degraded mode on this box (found by the P-021 live run).
    degradedReason = 'the owned-slice scan hit its process cap, so absence does not prove absence';
  }
  const degraded = Boolean(degradedReason);

  if (deps.dryRun) {
    return {
      summary,
      result,
      scan: {
        ownedRootExists: scan.ownedRootExists,
        ownedTruncated: scan.ownedTruncated,
        foreignTruncated: scan.foreignTruncated,
        processes: scan.processes.length,
        userManagerRoot: scan.userManagerRoot,
      },
      scannedProcesses: scan.processes,
      degraded,
      degradedReason,
      touched: 0,
      strandedCount: 0,
      endedUnobservedCount: 0,
      unaccountedPersisted: 0,
      residueCleared: 0,
      confirmedUnaccounted: [],
    };
  }

  // This confirmation is deliberately computed once per healthy tick and shared
  // by notification plus enforcement. Calling the debounce helper separately for
  // each consumer would make the second consumer observe scan three instead of
  // scan two and would silently delay the reaper by one full pass.
  const confirmedUnaccounted = confirmedResidueGroups(result);

  // ── positive confirmations are always safe to write ──────────────────────
  const scopeDirByUnit = new Map<string, string>();
  for (const p of scan.processes) {
    const unit = scopeUnitOf(p);
    if (unit && !scopeDirByUnit.has(unit)) scopeDirByUnit.set(unit, p.cgroupPath);
  }
  const byTaskId = new Map(live.map((r) => [r.taskId, r]));

  const touched = await touchAlive(
    result.alive.map((a) => {
      const row = byTaskId.get(a.taskId);
      const dir = row?.scopeUnit ? scopeDirByUnit.get(row.scopeUnit) : undefined;
      const sample = dir ? sampleCgroup(absCgroupDir(dir), fs) : null;
      return {
        taskId: a.taskId,
        pid: a.pid,
        processIdentity: a.processIdentity,
        metrics: sample
          ? {
              lastMemoryBytes: sample.memoryBytes,
              peakMemoryBytes: sample.peakMemoryBytes,
              cpuUsec: sample.cpuUsec,
              pidsCurrent: sample.pidsCurrent ?? a.pidsSeen,
              pidsEventsMax: sample.pidsEventsMax,
            }
          : { pidsCurrent: a.pidsSeen },
      };
    }),
  );

  // ── destructive writes only on a trustworthy scan ────────────────────────
  let strandedCount = 0;
  let endedUnobservedCount = 0;
  let unaccountedPersisted = 0;
  let residueCleared = 0;
  if (!degraded) {
    strandedCount = await markStranded(result.stranded);
    const endedWithTerminal = result.endedUnobserved.map((verdict) => {
      const scopeUnit = byTaskId.get(verdict.taskId)?.scopeUnit;
      const terminalProvenance = scopeUnit ? (terminalByUnit.get(scopeUnit) ?? null) : null;
      return terminalProvenance ? { ...verdict, terminalProvenance } : verdict;
    });
    endedUnobservedCount = await markEndedUnobserved(endedWithTerminal);
    // The failed unit was deliberately retained at spawn so its Result/exit
    // status/MemoryPeak could reach the ledger. Release it only after the writer
    // returns; a failed persistence throws before this point and leaves the unit
    // available for the next reconciler tick.
    const resetFailure = deps.resetFailedTaskUnit ?? resetFailedTaskUnit;
    for (const verdict of endedWithTerminal) {
      // `endedWithTerminal` is a union: a bare StrandedVerdict for units with no
      // terminal record, or that verdict widened with `terminalProvenance`. Narrow
      // with `in` before reading it — the runtime condition is unchanged, since the
      // property is present exactly when the spread above added it.
      if ('terminalProvenance' in verdict && verdict.terminalProvenance) {
        await resetFailure(verdict.terminalProvenance);
      }
    }

    const groups = result.unaccounted.map((g) => ({
      // A scope of OURS whose row already closed keeps its own id, so the history
      // stays attached to the real task instead of forking a phantom one.
      taskId: (g.scopeUnit && taskIdFromScopeUnit(g.scopeUnit)) || residueTaskId(g.cgroupPath),
      cgroupPath: g.cgroupPath,
      scopeUnit: g.scopeUnit,
      pids: g.pids,
      sampleCmdline: g.sampleCmdline,
    }));
    const persisted = await upsertUnaccounted(groups, { workspaceId: deps.workspaceId });
    unaccountedPersisted = persisted.length;
    residueCleared = await clearVanishedUnaccounted(persisted, { workspaceId: deps.workspaceId });
  }

  await maybeNotify(deps, { summary, result, degraded, degradedReason, confirmedUnaccounted });

  return {
    summary,
    result,
    scan: {
      ownedRootExists: scan.ownedRootExists,
      ownedTruncated: scan.ownedTruncated,
      foreignTruncated: scan.foreignTruncated,
      processes: scan.processes.length,
      userManagerRoot: scan.userManagerRoot,
    },
    scannedProcesses: scan.processes,
    degraded,
    degradedReason,
    touched,
    strandedCount,
    endedUnobservedCount,
    unaccountedPersisted,
    residueCleared,
    confirmedUnaccounted,
  };
}

/**
 * Notify only on a state CHANGE, never on every tick.
 *
 * A 30s cadence that broadcasts its summary is 2,880 messages a day for a healthy
 * box, which is how a signal becomes noise and then becomes muted — the exact
 * failure the `live-federation-gate` entry in SUPERVISED_PROCESSES had to be
 * flap-damped out of (~48 broadcasts/day for one healthy unit).
 */
const lastNotified = { key: '', at: 0 };
const RENOTIFY_MS = 30 * 60_000;
const RESIDUE_CONFIRMATION_SCANS = 2;
const residueObservations = new Map<string, number>();

/**
 * A cgroup that exists for only one scan can be a short-lived command which is
 * already gone by the time an operator follows the alert with the authoritative
 * live inventory. Keep recording those rows, but require the same cgroup identity
 * to survive two healthy scans before broadcasting it as an actionable residue.
 * A managed scope is the stable identity even when its leaf child cgroup changes;
 * an unmanaged group has only its cgroup path to identify it.
 */
function residueObservationKey(group: ResidueGroup): string {
  return group.scopeUnit ? `scope:${group.scopeUnit}` : `cgroup:${group.cgroupPath}`;
}

function confirmedResidueGroups(result: ReconcileResult): ResidueGroup[] {
  const currentKeys = new Set(result.unaccounted.map(residueObservationKey));
  for (const key of residueObservations.keys()) {
    if (!currentKeys.has(key)) residueObservations.delete(key);
  }

  return result.unaccounted.filter((group) => {
    const key = residueObservationKey(group);
    const observations = (residueObservations.get(key) ?? 0) + 1;
    residueObservations.set(key, observations);
    return observations >= RESIDUE_CONFIRMATION_SCANS;
  });
}

async function maybeNotify(
  deps: ReconcileTickDeps,
  ctx: {
    summary: ReturnType<typeof summarizeReconcile>;
    result: ReconcileResult;
    degraded: boolean;
    degradedReason?: string;
    confirmedUnaccounted: readonly ResidueGroup[];
  },
): Promise<void> {
  if (!deps.notify) return;
  const now = (deps.now ?? Date.now)();
  // A degraded scan cannot confirm either presence or absence, so preserve the
  // prior residue observations until the next healthy scan. Degraded state itself
  // remains immediately actionable.
  const confirmedUnaccounted = ctx.degraded ? [] : ctx.confirmedUnaccounted;
  const confirmedUnaccountedPids = confirmedUnaccounted.reduce((n, group) => n + group.pids.length, 0);
  const noteworthy = ctx.degraded || confirmedUnaccounted.length > 0 || ctx.summary.overdue > 0;
  // EI-20108913085212631: the key must identify the CONDITION, never its MAGNITUDE.
  // This used to interpolate the raw counts, so ordinary churn in residue cgroups
  // (6 -> 5 -> 6 as processes come and go — the healthy case, not an event) minted a
  // NEW key every tick, `key === lastNotified.key` never matched, and the 30-minute
  // debounce above was defeated outright: measured at 5 messages in 7 minutes.
  //
  // Presence booleans change only when a category actually OPENS or CLOSES, which is
  // what "state CHANGE" in this function's docblock always meant. A count that grows
  // while the condition persists is still reported — at the next RENOTIFY_MS tick,
  // carrying the current numbers, which is the designed cadence rather than a
  // per-tick broadcast.
  const key = ctx.degraded
    ? `degraded:${ctx.degradedReason}`
    : `unaccounted:${confirmedUnaccounted.length > 0}/overdue:${ctx.summary.overdue > 0}`;

  if (!noteworthy) {
    lastNotified.key = '';
    return;
  }
  if (key === lastNotified.key && now - lastNotified.at < RENOTIFY_MS) return;
  lastNotified.key = key;
  lastNotified.at = now;

  const parts: string[] = [];
  if (ctx.degraded) parts.push(`scan DEGRADED — ${ctx.degradedReason}`);
  if (confirmedUnaccounted.length > 0) {
    // A `pc-<taskId>.scope` proves managed provenance, but not ledger history:
    // synchronous spawn seams mint the scope before their fire-and-forget insert.
    // Describe only what this scan proves — whether residue is under a managed
    // scope and whether that scope currently has a live ledger row.
    const managedScopesWithoutLiveRow = confirmedUnaccounted.filter(
      (g) => g.scopeUnit && taskIdFromScopeUnit(g.scopeUnit),
    ).length;
    const outsideManagedScope = confirmedUnaccounted.length - managedScopesWithoutLiveRow;
    const why: string[] = [];
    if (outsideManagedScope > 0) why.push(`${outsideManagedScope} outside any managed task scope`);
    if (managedScopesWithoutLiveRow > 0) {
      why.push(`${managedScopesWithoutLiveRow} in managed scope(s) with no live ledger row`);
    }
    const evidence = confirmedUnaccounted
      .slice(0, 8)
      .map((group) => {
        const pids = group.pids.slice(0, 12).join(',') || 'none';
        const morePids = group.pids.length > 12 ? `,+${group.pids.length - 12} more` : '';
        const scope = group.scopeUnit ? ` scope=${group.scopeUnit}` : '';
        return `cgroup=${group.cgroupPath}${scope} pids=${pids}${morePids}`;
      })
      .join('; ');
    const moreGroups = confirmedUnaccounted.length > 8 ? `; +${confirmedUnaccounted.length - 8} more cgroup(s)` : '';
    parts.push(
      `${confirmedUnaccounted.length} unaccounted cgroup(s) holding ${confirmedUnaccountedPids} process(es) ` +
        `(confirmed across ${RESIDUE_CONFIRMATION_SCANS} consecutive healthy scans) — ` +
        `${why.join('; ')}; evidence: ${evidence}${moreGroups}`,
    );
  }
  if (ctx.summary.overdue > 0) parts.push(`${ctx.summary.overdue} task(s) past deadline`);
  await deps.notify({
    summary: `[task-manager] ${parts.join('; ')}`,
    kind: ctx.degraded ? 'escalation' : 'message',
  });
}

/** Test seam — clear the notify debounce. */
export function resetNotifyDebounce(): void {
  lastNotified.key = '';
  lastNotified.at = 0;
  residueObservations.clear();
}
