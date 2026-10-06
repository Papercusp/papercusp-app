/**
 * task-manager/reconcile — the PURE diff between what the kernel is running and
 * what the ledger believes (task-manager-no-escape-2026-07-27, P-004).
 *
 * This is the leg that makes the design inescapable. The chokepoint (P-007) only
 * covers spawns that go through it; a lint guard only covers source we control.
 * Neither can see a process someone started another way. What CAN see it is the
 * kernel — so instead of trying to make every call site honest, we continuously
 * ask the kernel what exists, join it against the ledger, and treat the residue
 * as an ALARM rather than an invisible. "No escape" is that residue being
 * reported, not every spawn being intercepted.
 *
 * Pure by construction — the caller supplies both sides and the clock. All the
 * hard cases (PID recycling, a row too young to judge, a scope that outlived its
 * row) are decided here, in a function that a unit test can drive exhaustively,
 * rather than inside a routine that only reproduces on a live box at 3am.
 */

import {
  isLiveOwnedState,
  taskIdFromScopeUnit,
  type TaskRow,
  type TaskState,
} from './types';
import { isConsoleWindowScope, isVerifierScope } from './scope-class';
import type { ExemptReason, ProcessScope } from './scope-class';

/** One process as the scanner observed it. */
export interface ScannedProcess {
  pid: number;
  /** Full unified-hierarchy path, e.g.
   *  `/user.slice/user-1000.slice/user@1000.service/papercusp.slice/papercusp-bash.slice/pc-abc123.scope` */
  cgroupPath: string;
  /** `linux:<bootId>:<startTicks>`, or null when /proc could not be read. */
  processIdentity: string | null;
  cmdline: string;
  /** true when this process lives inside our root slice. */
  owned: boolean;
  /**
   * `owned`, refined for HUMAN readers (EI-19325095302441792). The reconciler still
   * decides on `owned`; this splits the `owned:false` residue into lifetimes we
   * deliberately do not own (`exempt`) and genuine escapes (`unaccounted`), so a
   * pane cannot present the owner's own terminal windows as a coverage hole.
   * Derived by `classifyScope` — see scope-class.ts for why the rules are
   * structural rather than a list of process names.
   */
  scope: ProcessScope;
  /** Non-null exactly when `scope === 'exempt'`. */
  exemptReason: ExemptReason | null;
  /**
   * Wall-clock process start, when `/proc` and the boot clock could both be read.
   *
   * OPTIONAL on purpose: every fixture and every non-Linux scanner predates it, and
   * a missing value must degrade to "age unknown" rather than strand its caller.
   * Absent/null means the youth grace below cannot apply, which fails toward
   * REPORTING residue — the safe direction for an alarm.
   */
  startedAtMs?: number | null;
}

export interface AliveVerdict {
  taskId: string;
  /** The lowest pid seen in the scope — the best "leader" guess for display. */
  pid: number | null;
  processIdentity: string | null;
  /** How many processes the task's cgroup currently holds. 1 for a simple job,
   *  dozens for an agent session that has forked a test suite. */
  pidsSeen: number;
  /** How we matched. `scope` is the trustworthy one; the others are fallbacks for
   *  unconfined rows and are reported so the pane can show confidence honestly. */
  matchedBy: 'scope' | 'identity' | 'pid';
}

export interface StrandedVerdict {
  taskId: string;
  reason: string;
}

/** Same shape as {@link StrandedVerdict} — a distinct name so call sites read
 *  `endedUnobserved` verdicts as what they are, not as strands. */
export type EndedUnobservedVerdict = StrandedVerdict;

export interface ResidueGroup {
  cgroupPath: string;
  scopeUnit: string | null;
  pids: number[];
  sampleCmdline: string;
}

export interface OverdueVerdict {
  taskId: string;
  deadlineAt: string;
  overdueMs: number;
}

export interface ReconcileResult {
  alive: AliveVerdict[];
  stranded: StrandedVerdict[];
  /**
   * Rows absent from the scan the SAME way `stranded` rows are, but for which
   * the caller independently confirmed (via `ReconcileOptions.releasedScopes`,
   * systemd's authority — see the header note below) that the task's transient
   * scope was released in good order: every process in it is confirmed gone,
   * not merely unseen by one scan. D-018 (task-manager-no-escape-2026-07-27):
   * an ending nobody observed, whose scope systemd cleanly collected, is *ended,
   * exit code unknown* — never `stranded` (the escape/anomaly class) and never
   * `exited` (that would fabricate an exit code nobody saw).
   */
  endedUnobserved: EndedUnobservedVerdict[];
  /** Inside our slice, no live ledger row. Someone bypassed the chokepoint, or a
   *  scope outlived the row that described it. REPORT-ONLY in v1 (D-010). */
  unaccounted: ResidueGroup[];
  /**
   * A terminal window scope whose window is positively GONE, but whose processes
   * kept running (P-008 / D-018). Its own class because both neighbours mislead:
   * `exempt` claims a human owns this lifetime when the human closed it, and bare
   * `unaccounted` loses the fact that one ever did.
   *
   * REPORT-ONLY, and more firmly than the rest (D-016): 14 of 15 such scopes on
   * this box held live agent sessions or shared infra, so a dead window is NOT
   * evidence of abandonment. It reads "a window closed but these kept running",
   * never "kill these".
   */
  abandonedWindow: ResidueGroup[];
  /**
   * A desktop terminal window WE opened for a human (`papercup-console-*.scope`).
   *
   * Its own class because it is structurally incapable of being anything else:
   * `spawnConsole` hardcodes `taskScope: null`, so the scope can never acquire a
   * ledger row, and `console-spawn.ts` is allowlisted from enrolment BY DESIGN
   * ("the window is the unit of control"). Counted as `unaccounted` it produced a
   * permanent alarm that could never clear no matter what anyone fixed — 7 scopes
   * / 14 processes on this box, re-notified every 30 minutes (EI-20106565311448967).
   *
   * REPORT-ONLY, and it is NOT persisted as residue: `unaccounted`'s contract is
   * "someone bypassed the chokepoint", and a console did the opposite — it took the
   * documented route. Reads "a human has a window open", never "an escape".
   */
  consoleWindow: ResidueGroup[];
  /** Named verifier systemd scopes: visible, but not unaccounted bypass residue. */
  verifierScope: ResidueGroup[];
  /** A papercusp-tree process outside our slice — the owner's own terminal, a
   *  peer's session. Visible, never controlled: visibility != control. */
  foreign: ResidueGroup[];
  overdue: OverdueVerdict[];
  /** Rows skipped as too young to judge — surfaced so a stuck `pending` backlog
   *  is visible rather than silently excluded every tick. */
  tooYoung: string[];
}

export interface ReconcileOptions {
  /** ms since the row was last credibly seen before absence counts as stranded.
   *  Covers the register→fork→cgroup-visible window, plus one scan interval of
   *  slack. Too low strands healthy tasks; too high leaves dead rows "running". */
  graceMs?: number;
  now?: number;
  /**
   * Scope units the CALLER has independently confirmed are released (D-018) —
   * i.e. `systemctl --user show -p ActiveState pc-<taskId>.scope` (or the unit
   * having been garbage-collected entirely) reports something other than
   * active/activating/reloading/deactivating for that unit, meaning systemd's
   * own cgroup-emptiness tracking says every process in that scope is gone.
   *
   * This function stays PURE by construction (see the header) — it never asks
   * systemd itself. The caller (`reconcile-tick.ts`) queries it for exactly the
   * scope units that are about to strand and passes the confirmed-released
   * subset here, which is what turns an otherwise-`stranded` verdict into
   * `endedUnobserved` instead. Omitted or empty ⇒ every candidate strands, the
   * pre-D-018 behavior — this option is additive, never a new way to LOSE a
   * genuine escape.
   */
  releasedScopes?: ReadonlySet<string>;
  /**
   * pid → kernel identity for processes the scan READ but did not list
   * (`ScanResult.unlistedIdentityByPid`, WI-10005782): out-of-slice processes
   * whose argv carries no repo path, such as a wake executor's unconfined
   * `claude -p --resume` turn. Consulted only when an unconfined row's identity
   * is absent from `kernel`. A match needs the row's own pid AND its stored
   * identity, so a recycled pid can never keep a dead row alive. Omitted ⇒ the
   * row strands on absence, as before.
   */
  unlistedIdentityByPid?: ReadonlyMap<number, string>;
}

/**
 * A row is about to strand (absent from the scan, aged past grace). Decide
 * whether it is the escape/anomaly class or an unobserved-but-confirmed-clean
 * end (D-018) and push it to the matching output list.
 */
function pushAbsent(
  row: TaskRow,
  reason: string,
  releasedScopes: ReadonlySet<string> | undefined,
  stranded: StrandedVerdict[],
  endedUnobserved: EndedUnobservedVerdict[],
): void {
  if (row.scopeUnit && releasedScopes?.has(row.scopeUnit)) {
    endedUnobserved.push({
      taskId: row.taskId,
      reason: `${reason} — but systemd confirms scope ${row.scopeUnit} was released in good order (all its processes exited); the owning process most likely died before recording the exit`,
    });
  } else {
    stranded.push({ taskId: row.taskId, reason });
  }
}

const DEFAULT_GRACE_MS = 60_000;

/**
 * The nearest managed scope a scanned process sits in, if it is one of ours.
 *
 * A task may create child cgroups for its own cleanup or resource accounting.
 * The kernel reports the leaf path, so inspecting only the last segment turns
 * every such child into apparent residue even though a `pc-*.scope` ancestor
 * still owns it. Search leaf-to-root so the nearest managed ancestor wins.
 */
export function scopeUnitOf(proc: ScannedProcess): string | null {
  const parts = proc.cgroupPath.split('/').filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const segment = parts[i]!;
    if (taskIdFromScopeUnit(segment)) return segment;
  }
  return null;
}

/**
 * Is this process new enough to still be inside the enrolment window?
 *
 * Answers "could its ledger row simply not have committed yet", NOT "is it
 * healthy". Unknown age is deliberately NOT within grace: an alarm that cannot
 * measure age must report, never assume innocence (EI-20185455308799001).
 */
export function isWithinEnrolmentGrace(
  proc: ScannedProcess,
  now: number,
  graceMs: number,
): boolean {
  return typeof proc.startedAtMs === 'number' && now - proc.startedAtMs < graceMs;
}

function groupResidue(procs: ScannedProcess[]): ResidueGroup[] {
  const byPath = new Map<string, ScannedProcess[]>();
  for (const p of procs) {
    const list = byPath.get(p.cgroupPath);
    if (list) list.push(p);
    else byPath.set(p.cgroupPath, [p]);
  }
  return [...byPath.entries()]
    .map(([cgroupPath, list]) => ({
      cgroupPath,
      scopeUnit: scopeUnitOf(list[0]!),
      pids: list.map((p) => p.pid).sort((a, b) => a - b),
      sampleCmdline: list[0]!.cmdline,
    }))
    .sort((a, b) => a.cgroupPath.localeCompare(b.cgroupPath));
}

function ageMs(row: TaskRow, now: number): number {
  const seen = Date.parse(row.lastSeenAt || row.startedAt);
  const started = Date.parse(row.startedAt);
  const newest = Math.max(Number.isFinite(seen) ? seen : 0, Number.isFinite(started) ? started : 0);
  return newest > 0 ? now - newest : Number.POSITIVE_INFINITY;
}

/**
 * Diff kernel reality against the ledger.
 *
 * `ledger` should carry every row in a live-owned state (`pending` | `running`);
 * terminal rows are ignored if passed, so a caller may hand over a wider slice
 * without pre-filtering.
 */
export function reconcile(
  ledger: readonly TaskRow[],
  kernel: readonly ScannedProcess[],
  opts: ReconcileOptions = {},
): ReconcileResult {
  const now = opts.now ?? Date.now();
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;

  // ── index the kernel side ────────────────────────────────────────────────
  const byScope = new Map<string, ScannedProcess[]>();
  const byIdentity = new Map<string, ScannedProcess>();
  const byPid = new Map<number, ScannedProcess>();
  for (const p of kernel) {
    const scope = scopeUnitOf(p);
    if (scope) {
      const list = byScope.get(scope);
      if (list) list.push(p);
      else byScope.set(scope, [p]);
    }
    if (p.processIdentity && !byIdentity.has(p.processIdentity)) byIdentity.set(p.processIdentity, p);
    if (!byPid.has(p.pid)) byPid.set(p.pid, p);
  }

  const alive: AliveVerdict[] = [];
  const stranded: StrandedVerdict[] = [];
  const endedUnobserved: EndedUnobservedVerdict[] = [];
  const overdue: OverdueVerdict[] = [];
  const tooYoung: string[] = [];
  /** Scopes and pids claimed by a live ledger row — everything left over is residue. */
  const claimedScopes = new Set<string>();
  const claimedPids = new Set<number>();

  for (const row of ledger) {
    if (!isLiveOwnedState(row.state as TaskState)) continue;

    // 1. the trustworthy match: our scope unit is present in the kernel.
    const scopeProcs = row.scopeUnit ? byScope.get(row.scopeUnit) : undefined;
    if (scopeProcs && scopeProcs.length > 0) {
      claimedScopes.add(row.scopeUnit!);
      for (const p of scopeProcs) claimedPids.add(p.pid);
      const leader = scopeProcs.reduce((a, b) => (a.pid <= b.pid ? a : b));
      alive.push({
        taskId: row.taskId,
        pid: leader.pid,
        processIdentity: leader.processIdentity,
        pidsSeen: scopeProcs.length,
        matchedBy: 'scope',
      });
      pushOverdue(row, now, overdue);
      continue;
    }

    // 2. unconfined fallback: the kernel-backed identity is still present.
    //    Safe across PID wrap by construction — the identity embeds start time.
    if (row.processIdentity) {
      const hit = byIdentity.get(row.processIdentity);
      if (hit) {
        claimedPids.add(hit.pid);
        alive.push({
          taskId: row.taskId,
          pid: hit.pid,
          processIdentity: hit.processIdentity,
          pidsSeen: 1,
          matchedBy: 'identity',
        });
        pushOverdue(row, now, overdue);
        continue;
      }
      // Present in the kernel but unlisted by the scan's display filter: still
      // alive. Same pid AND same start time, so this cannot be a recycled pid.
      if (row.pid != null && opts.unlistedIdentityByPid?.get(row.pid) === row.processIdentity) {
        alive.push({
          taskId: row.taskId,
          pid: row.pid,
          processIdentity: row.processIdentity,
          pidsSeen: 1,
          matchedBy: 'identity',
        });
        pushOverdue(row, now, overdue);
        continue;
      }
      // The row HAS an identity and the kernel does not have it. A pid match now
      // would be a recycled pid belonging to something else — refuse it outright
      // rather than "helpfully" keeping the row alive against a stranger.
      if (ageMs(row, now) < graceMs) {
        tooYoung.push(row.taskId);
      } else {
        pushAbsent(
          row,
          `process identity ${row.processIdentity} is gone from the kernel`,
          opts.releasedScopes,
          stranded,
          endedUnobserved,
        );
      }
      continue;
    }

    // 3. last resort: a bare pid, only trusted while the row has no identity at
    //    all (i.e. we never managed to read one). Still the weakest evidence we
    //    accept, and it is reported as such.
    if (row.pid) {
      const hit = byPid.get(row.pid);
      if (hit) {
        claimedPids.add(hit.pid);
        alive.push({
          taskId: row.taskId,
          pid: hit.pid,
          processIdentity: hit.processIdentity,
          pidsSeen: 1,
          matchedBy: 'pid',
        });
        pushOverdue(row, now, overdue);
        continue;
      }
    }

    if (ageMs(row, now) < graceMs) {
      tooYoung.push(row.taskId);
    } else {
      pushAbsent(
        row,
        row.scopeUnit
          ? `scope ${row.scopeUnit} holds no processes`
          : 'no scope, identity or pid match in the kernel scan',
        opts.releasedScopes,
        stranded,
        endedUnobserved,
      );
    }
  }

  // ── residue ──────────────────────────────────────────────────────────────
  //
  // D-018: the classifier's verdict WINS for `abandoned-window`. This split is
  // otherwise a pure owned/scopeUnit heuristic that never reads `p.scope`, and a
  // dead terminal window is neither owned nor in one of our `pc-*.scope` units —
  // so it used to fall through to `foreign` ("someone else's process we merely
  // display") even though `classifyScope` had already declared it residue. That
  // silent re-filing is a second, independent blind spot: fixing only the scan's
  // cmdline filter would have moved these into the scan and STILL reported zero.
  const unaccountedProcs: ScannedProcess[] = [];
  const abandonedWindowProcs: ScannedProcess[] = [];
  const consoleWindowProcs: ScannedProcess[] = [];
  const verifierScopeProcs: ScannedProcess[] = [];
  const foreignProcs: ScannedProcess[] = [];
  for (const p of kernel) {
    if (claimedPids.has(p.pid)) continue;
    const scope = scopeUnitOf(p);
    if (scope && claimedScopes.has(scope)) continue;
    if (isVerifierScope(p.cgroupPath)) verifierScopeProcs.push(p);
    else if (p.scope === 'abandoned-window') abandonedWindowProcs.push(p);
    // Before the `owned` test, because a console scope IS owned — that is exactly why
    // it fell through to `unaccounted` and stuck there. Checked by scope NAME, which
    // only our own builder mints; `scopeUnitOf` cannot see it (it resolves `pc-*` only).
    else if (isConsoleWindowScope(p.cgroupPath)) consoleWindowProcs.push(p);
    // EI-20185455308799001 — the enrolment race, given the same youth grace the ROW
    // paths above already get. A managed `pc-*` scope is minted BEFORE its
    // fire-and-forget enrolment insert commits, so a tick landing inside that window
    // sees a scope no live row claims and used to alarm on a process that is
    // enrolling perfectly normally. That grace could not reach here, because it is
    // written as `ageMs(row, now)` and this case has NO ROW to age — hence the
    // process's own start time.
    //
    // Deliberately narrow, so this stays a grace and not a mute:
    //  - `scope` only. Owned residue with no managed scope is a genuine escape and
    //    is still reported immediately, at any age.
    //  - Age must be KNOWN. An absent `startedAtMs` falls through and reports.
    //  - A real orphan — a scope whose row genuinely ended — is OLD, so it ages out
    //    of the grace within `graceMs` and alarms exactly as before.
    else if (scope && isWithinEnrolmentGrace(p, now, graceMs)) {
      const youngTaskId = taskIdFromScopeUnit(scope);
      if (youngTaskId) tooYoung.push(youngTaskId);
    } else if (p.owned || scope) unaccountedProcs.push(p);
    else foreignProcs.push(p);
  }

  return {
    alive,
    stranded,
    endedUnobserved,
    unaccounted: groupResidue(unaccountedProcs),
    abandonedWindow: groupResidue(abandonedWindowProcs),
    consoleWindow: groupResidue(consoleWindowProcs),
    verifierScope: groupResidue(verifierScopeProcs),
    foreign: groupResidue(foreignProcs),
    overdue,
    tooYoung,
  };
}

function pushOverdue(row: TaskRow, now: number, out: OverdueVerdict[]): void {
  if (!row.deadlineAt) return;
  const deadline = Date.parse(row.deadlineAt);
  if (Number.isFinite(deadline) && deadline < now) {
    out.push({ taskId: row.taskId, deadlineAt: row.deadlineAt, overdueMs: now - deadline });
  }
}

/** Convenience for the routine's summary line + the pane's header. */
export function summarizeReconcile(r: ReconcileResult): {
  alive: number;
  stranded: number;
  /** D-018: unobserved-but-systemd-confirmed-clean endings. Counted separately
   *  from `stranded` so the escape/anomaly count is never inflated by routine
   *  shutdowns nobody happened to observe. */
  endedUnobserved: number;
  unaccounted: number;
  unaccountedPids: number;
  /** Dead-window scopes + the processes they still hold (P-008 / D-018). Counted
   *  separately so it can never be read as either "exempt" or a bypass. */
  abandonedWindow: number;
  abandonedWindowPids: number;
  /** Human-owned desktop terminal windows + the processes they hold. Counted so the
   *  class stays VISIBLE (visibility != alarm) without re-entering `unaccounted`,
   *  whose nonzero count is what the 30-minute notifier fires on. */
  consoleWindow: number;
  consoleWindowPids: number;
  verifierScope: number;
  verifierScopePids: number;
  foreign: number;
  overdue: number;
  tooYoung: number;
} {
  return {
    alive: r.alive.length,
    stranded: r.stranded.length,
    endedUnobserved: r.endedUnobserved.length,
    unaccounted: r.unaccounted.length,
    unaccountedPids: r.unaccounted.reduce((n, g) => n + g.pids.length, 0),
    abandonedWindow: r.abandonedWindow.length,
    abandonedWindowPids: r.abandonedWindow.reduce((n, g) => n + g.pids.length, 0),
    consoleWindow: r.consoleWindow.length,
    consoleWindowPids: r.consoleWindow.reduce((n, g) => n + g.pids.length, 0),
    verifierScope: r.verifierScope.length,
    verifierScopePids: r.verifierScope.reduce((n, g) => n + g.pids.length, 0),
    foreign: r.foreign.length,
    overdue: r.overdue.length,
    tooYoung: r.tooYoung.length,
  };
}
