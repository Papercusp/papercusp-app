/**
 * task-manager/scan — ask the KERNEL what is running
 * (task-manager-no-escape-2026-07-27, P-010).
 *
 * Two passes, and the difference between them is the whole ethic of this
 * subsystem:
 *
 *   1. OUR SLICE, walked recursively. Cgroup membership is inherited, so this
 *      pass sees every descendant of everything we launched — an agent CLI, the
 *      Bash tool it drove, the `npm test` that started, the vitest workers that
 *      forked, and a grandchild that double-forked and reparented to init. That
 *      is why the design does not need to intercept 813 spawn sites: it needs the
 *      ROOTS confined, and this walk does the rest.
 *
 *   2. THE REST OF THE USER MANAGER, filtered to processes that look like they
 *      belong to this project. These are FOREIGN: the owner's own terminal, a
 *      peer agent's session. They are reported so the pane can show them, and they
 *      are never controlled. Visibility is not control — the same principle the
 *      scheduled-registry states for timers, and the direct lesson of the
 *      `pkill -f '<binary>'` incidents that killed the owner's live desktop window
 *      by treating "matches a pattern" as "mine to kill".
 *
 * Bounded by construction: depth-capped walk, a process cap, and every read
 * failure degrading to null. The reconciler runs this on a 30s cadence, so a scan
 * that can hang is a scan that piles up.
 */

import { linuxProcessIdentityFromStat, linuxStartTicksFromProcStat } from '../process-identity';
import { readFile, readdir, stat } from 'node:fs/promises';
import {
  CGROUP_ROOT,
  absCgroupDir,
  nodeCgroupFs,
  parseCgroupProcs,
  parseProcCgroup,
  parseProcCmdline,
  relCgroupPath,
  walkCgroupTree,
  type CgroupFs,
} from './cgroup-read';
import { TASK_ROOT_SLICE, deriveUserManagerRoot } from './types';
import { classifyScope, isTerminalWindowScope } from './scope-class';
import { readTerminalAppPids, terminalWindowAlive } from './terminal-window';
import type { ScannedProcess } from './reconcile';
import { mapWithConcurrency } from '../gym/concurrency';

export interface ScanOptions {
  fs?: CgroupFs;
  /** Test seam for the nonblocking inventory scan; omitted in production. */
  asyncFs?: AsyncCgroupFs;
  cgroupRoot?: string;
  /** Kernel-relative path of the systemd user manager root. Derived from our own
   *  cgroup when omitted. */
  userManagerRoot?: string;
  /** What makes an out-of-slice process "one of ours to display". Deliberately a
   *  caller-supplied signature: a hardcoded one would silently stop matching the
   *  day the tree moves, and would be untestable. */
  foreignSignature?: RegExp;
  /**
   * Cap on the OWNED pass — processes inside our slice. Truncating this one is
   * serious: it makes absence unprovable, so the reconciler must stop closing rows.
   */
  maxOwnedProcesses?: number;
  /**
   * Separate cap on the FOREIGN pass.
   *
   * Separate BECAUSE they are not the same kind of budget, which a live run on
   * this box proved the hard way: with one shared cap of 4000, the foreign pass
   * (124 groups, 500+ matching processes on a busy fleet host) consumed the entire
   * allowance before the owned pass had finished, set `truncated`, and thereby put
   * the reconciler into permanent DEGRADED mode — where it never closes a stranded
   * row again. A display-only view must never be able to disable the ledger's
   * correctness path.
   *
   * It is SEPARATENESS that made that safe, not lowness — a distinction the
   * original 400 blurred, and it cost the owner a wrong answer (2026-08-02): with
   * ~400 foreign processes on this box the pane reported exactly "UNENROLLED (400)"
   * and "Scan capped", i.e. the cap WAS the number. A reader cannot tell a real 400
   * from a truncated 400, so the courtesy view was quietly answering "how many
   * Papercusp processes are running?" with its own limit.
   *
   * Now that the two budgets cannot starve each other, the foreign cap only has to
   * bound the PAYLOAD, so it is sized to actually cover a busy fleet host instead.
   * The owned pass keeps its own 4000 and its own truncation flag; nothing here can
   * put the reconciler into degraded mode.
   */
  maxForeignProcesses?: number;
  /** Our own pid, excluded from the foreign pass (we are not foreign to ourselves). */
  selfPid?: number;
}

/** Same failure semantics as CgroupFs, but no kernel IO on the request thread. */
export interface AsyncCgroupFs {
  readFile(path: string): Promise<string | null>;
  readDir(path: string): Promise<string[]>;
  isDir(path: string): Promise<boolean>;
}

const nodeAsyncCgroupFs: AsyncCgroupFs = {
  readFile: (path) => readFile(path, 'utf8').catch(() => null),
  readDir: (path) => readdir(path).catch(() => []),
  isDir: (path) => stat(path).then((s) => s.isDirectory(), () => false),
};

/**
 * Inventory's kernel snapshot. Reuse the SAME scanner and classification rules
 * against an in-memory CgroupFs; only the IO changes. Prefetch both cgroup
 * passes and procfs facts with bounded concurrency, including the terminal
 * window's application pid set. A failed read stays null/unknown as in the
 * synchronous reconciler. `reconcileTick` uses this scan by default too
 * (jev-memory-timeouts-to-zero-2026-10-01 P-004).
 */
export async function scanProcessesAsync(opts: ScanOptions = {}): Promise<ScanResult> {
  if (opts.fs && opts.fs !== nodeCgroupFs && !opts.asyncFs) return scanProcesses(opts);
  const source = opts.asyncFs ?? nodeAsyncCgroupFs;
  const root = opts.cgroupRoot ?? CGROUP_ROOT;
  const selfPid = opts.selfPid ?? process.pid;
  const files = new Map<string, string | null>();
  const directories = new Map<string, string[]>();
  const file = async (path: string): Promise<string | null> => {
    const value = await source.readFile(path);
    files.set(path, value);
    return value;
  };
  const selfCgroup = await file(`/proc/${selfPid}/cgroup`);
  const manager = opts.userManagerRoot ?? deriveUserManagerRoot(parseProcCgroup(selfCgroup ?? ''));
  const owned = absCgroupDir(manager ? `${manager}/${TASK_ROOT_SLICE}` : `/${TASK_ROOT_SLICE}`, root);
  const roots = manager ? [owned, absCgroupDir(manager, root)] : [owned];
  const pending = roots.map((dir) => ({ dir, depth: 0 }));
  const visited = new Set<string>();
  const pids = new Set<number>();
  while (pending.length) {
    const batch = pending.splice(0, 32).filter(({ dir }) => !visited.has(dir));
    for (const { dir } of batch) visited.add(dir);
    const nodes = await mapWithConcurrency(batch, 16, async ({ dir, depth }) => {
      if (!(await source.isDir(dir))) return { dir, depth, children: [] as string[] };
      const [names, content] = await Promise.all([source.readDir(dir), file(`${dir}/cgroup.procs`)]);
      directories.set(dir, names);
      for (const pid of parseCgroupProcs(content ?? '')) pids.add(pid);
      if (depth >= 32) return { dir, depth, children: [] as string[] };
      const children = await mapWithConcurrency(names, 16, async (name) => {
        const child = `${dir}/${name}`;
        return (await source.isDir(child)) ? child : null;
      });
      return { dir, depth, children: children.filter((x): x is string => x !== null) };
    });
    for (const node of nodes) {
      for (const child of node.children) pending.push({ dir: child, depth: node.depth + 1 });
    }
  }
  await Promise.all([file('/proc/sys/kernel/random/boot_id'), file('/proc/uptime')]);
  await mapWithConcurrency([...pids], 32, async (pid) => {
    await Promise.all([file(`/proc/${pid}/stat`), file(`/proc/${pid}/cmdline`)]);
  });
  const snapshot: CgroupFs = {
    readFile: (path) => files.get(path) ?? null,
    readDir: (path) => directories.get(path) ?? [],
    isDir: (path) => directories.has(path),
  };
  return scanProcesses({ ...opts, fs: snapshot });
}

const DEFAULT_MAX_OWNED = 4000;
// Raised 400 → 4000 (owner-directed 2026-08-02: the task manager must show EVERY
// active Papercusp process, and at 400 it was reporting its own cap as the answer).
// Safe because the owned/foreign budgets are separate — see maxForeignProcesses.
const DEFAULT_MAX_FOREIGN = 4000;

/**
 * The systemd user-manager cgroup that owns our slice, derived from our OWN
 * cgroup path rather than assumed. On this box the operator runs as
 * `…/user@1000.service/papercup-dev-api.service`, so the manager root is the
 * prefix through `user@1000.service`. Returns null when the shape is unrecognised
 * (a container, a system-slice deployment) — the caller then scans only our slice,
 * which is the honest degradation: we lose the foreign VIEW, never the ownership.
 *
 * Now implemented in `types` (WI-37509) so the spawn chokepoint can derive a scope's
 * cgroup path without importing this module's kernel-walk graph. Re-exported here
 * because this is where every existing caller and its tests look for it.
 */
export { deriveUserManagerRoot };

/** USER_HZ — the unit `/proc/<pid>/stat`'s `starttime` is expressed in. 100 on
 *  every platform we run on; the same constant `residue-liveness-probe.ts` uses. */
const CLOCK_TICKS_PER_SEC = 100;

/** Seconds since boot. Read ONCE per scan, not once per pid. */
function readUptimeSec(fs: CgroupFs): number | null {
  const raw = fs.readFile('/proc/uptime');
  if (!raw) return null;
  const secs = Number.parseFloat(raw.trim().split(/\s+/)[0] ?? '');
  return Number.isFinite(secs) ? secs : null;
}

interface ProcFacts {
  identity: string | null;
  /** Wall-clock start, or null when /proc could not be read or uptime is unknown. */
  startedAtMs: number | null;
}

/**
 * Both facts we need from `/proc/<pid>/stat`, off a SINGLE read.
 *
 * `startedAtMs` exists so the reconciler can age a cgroup that has no ledger row
 * to age (EI-20185455308799001): the managed scope is minted BEFORE the
 * fire-and-forget enrolment insert commits, so a scan landing inside that window
 * sees a `pc-*.scope` no live row claims and would otherwise alarm on a process
 * that is enrolling normally.
 *
 * Start time is used rather than a scope mtime because the process is created
 * WITH the scope, and because the tick parse is already solved here — `comm`
 * (field 2) is parenthesised and may itself contain spaces and parens, so the
 * fields after it can only be located from the LAST ')'. Re-deriving that by hand
 * is how the field index silently shifts for such a process.
 */
function readProcFacts(
  pid: number,
  bootId: string | null,
  uptimeSec: number | null,
  nowMs: number,
  fs: CgroupFs,
): ProcFacts {
  const stat = fs.readFile(`/proc/${pid}/stat`);
  if (!stat) return { identity: null, startedAtMs: null };

  const identity = bootId ? linuxProcessIdentityFromStat(bootId, stat) : null;

  let startedAtMs: number | null = null;
  if (uptimeSec !== null) {
    const ticks = Number(linuxStartTicksFromProcStat(stat));
    if (Number.isFinite(ticks)) {
      const ageSec = uptimeSec - ticks / CLOCK_TICKS_PER_SEC;
      // A negative age means the clocks disagree; report unknown rather than a
      // future timestamp, which would read as "brand new" and suppress an alarm.
      if (ageSec >= 0) startedAtMs = nowMs - ageSec * 1000;
    }
  }

  return { identity, startedAtMs };
}

export interface ScanResult {
  processes: ScannedProcess[];
  /** Absolute path walked for the owned pass — surfaced so a misconfigured root
   *  shows up as "scanned nothing" rather than as "nothing is running". */
  ownedRootAbs: string;
  ownedRootExists: boolean;
  userManagerRoot: string | null;
  /** The OWNED pass hit its cap — absence is no longer provable, so the caller must
   *  not close rows on this scan. */
  ownedTruncated: boolean;
  /** The FOREIGN pass hit its cap — the courtesy view is partial. Carries NO
   *  implication for ledger correctness and must never degrade the verdict. */
  foreignTruncated: boolean;
  /**
   * User-manager processes the FOREIGN pass read but did NOT list because their
   * cmdline misses `foreignSignature`: pid → kernel identity. Never displayed
   * (the signature still keeps an unrelated owner/peer process out of the pane),
   * but the reconciler needs it (WI-10005782). An enrolled UNCONFINED task stays
   * in its spawner's cgroup, outside our slice, and its argv need not name the
   * repo. A wake executor's `claude -p --resume <id>` turn runs in the
   * operator's own service cgroup with no repo path in argv. Without this map,
   * such a row read "gone from the kernel" one grace period after spawn while the
   * process kept running: 405 of 406 resume-headless rows over three days, none
   * of them shorter than the grace period. Keyed by pid so a match needs the
   * row's pid AND its start time.
   */
  unlistedIdentityByPid: Map<number, string>;
}

/**
 * Enumerate processes. The `owned` flag on each row is what `reconcile` uses to
 * split residue into "a bypass we must alarm on" and "someone else's process we
 * merely display".
 */
export function scanProcesses(opts: ScanOptions = {}): ScanResult {
  const fs = opts.fs ?? nodeCgroupFs;
  const cgroupRoot = opts.cgroupRoot ?? CGROUP_ROOT;
  const maxOwned = opts.maxOwnedProcesses ?? DEFAULT_MAX_OWNED;
  const maxForeign = opts.maxForeignProcesses ?? DEFAULT_MAX_FOREIGN;
  const selfPid = opts.selfPid ?? process.pid;

  const bootId = fs.readFile('/proc/sys/kernel/random/boot_id');
  const uptimeSec = readUptimeSec(fs);
  const scanNowMs = Date.now();

  const ownCgroup = parseProcCgroup(fs.readFile(`/proc/${selfPid}/cgroup`) ?? '');
  const userManagerRoot = opts.userManagerRoot ?? deriveUserManagerRoot(ownCgroup);

  const ownedRootRel = userManagerRoot ? `${userManagerRoot}/${TASK_ROOT_SLICE}` : `/${TASK_ROOT_SLICE}`;
  const ownedRootAbs = absCgroupDir(ownedRootRel, cgroupRoot);
  const ownedRootExists = fs.isDir(ownedRootAbs);

  const processes: ScannedProcess[] = [];
  const unlistedIdentityByPid = new Map<number, string>();
  const seen = new Set<number>();
  let ownedCount = 0;
  let foreignCount = 0;
  let ownedTruncated = false;
  let foreignTruncated = false;

  // Window liveness is a property of the SCOPE, not of each process in it, and a
  // busy window holds dozens — so probe once per scope and reuse. The application's
  // pid set is likewise read once per slice, not once per window.
  const appPidsBySlice = new Map<string, Set<number>>();
  const windowAliveByScope = new Map<string, boolean | null>();

  const probeWindow = (absDir: string, cgroupPath: string): boolean | null | undefined => {
    if (!isTerminalWindowScope(cgroupPath)) return undefined;
    const cached = windowAliveByScope.get(absDir);
    if (cached !== undefined) return cached;

    // A window scope's parent IS the terminal app slice.
    const sliceAbs = absDir.slice(0, absDir.lastIndexOf('/'));
    let appPids = appPidsBySlice.get(sliceAbs);
    if (!appPids) {
      appPids = readTerminalAppPids(sliceAbs, fs);
      appPidsBySlice.set(sliceAbs, appPids);
    }

    const alive = terminalWindowAlive(absDir, appPids, fs);
    windowAliveByScope.set(absDir, alive);
    return alive;
  };

  const push = (pid: number, absDir: string, owned: boolean): void => {
    if (seen.has(pid)) return;
    // Two independent budgets — a busy foreign population must never be able to
    // starve the owned pass and put the reconciler into permanent degraded mode.
    if (owned) {
      if (ownedCount >= maxOwned) {
        ownedTruncated = true;
        return;
      }
      ownedCount++;
    } else {
      if (foreignCount >= maxForeign) {
        foreignTruncated = true;
        return;
      }
      foreignCount++;
    }
    seen.add(pid);
    const cgroupPath = relCgroupPath(absDir, cgroupRoot);
    // Classify HERE, not in the pane. The rule set is the guard's intent expressed
    // at runtime; duplicating it in a component is how the two drift apart, and a
    // pane that classifies for itself is a pane that can quietly invent a coverage
    // hole (EI-19325095302441792).
    const { scope, exemptReason } = classifyScope(cgroupPath, owned, {
      terminalWindowAlive: probeWindow(absDir, cgroupPath),
    });
    const facts = readProcFacts(pid, bootId, uptimeSec, scanNowMs, fs);
    processes.push({
      pid,
      cgroupPath,
      processIdentity: facts.identity,
      startedAtMs: facts.startedAtMs,
      cmdline: parseProcCmdline(fs.readFile(`/proc/${pid}/cmdline`)),
      owned,
      scope,
      exemptReason,
    });
  };

  // ── pass 1: everything under our slice, at any depth ─────────────────────
  if (ownedRootExists) {
    for (const node of walkCgroupTree(ownedRootAbs, fs)) {
      for (const pid of node.pids) push(pid, node.absDir, true);
    }
  }

  // ── pass 2: the rest of the user manager, signature-filtered ─────────────
  const sig = opts.foreignSignature;
  if (sig && userManagerRoot) {
    const managerAbs = absCgroupDir(userManagerRoot, cgroupRoot);
    for (const node of walkCgroupTree(managerAbs, fs)) {
      if (node.absDir === ownedRootAbs || node.absDir.startsWith(`${ownedRootAbs}/`)) continue;
      // A dead terminal window's residue must stay visible even when NONE of its
      // processes match our repo signature (EI-19398679054297365). The signature
      // filter exists to keep an unrelated owner/peer process out of the foreign
      // pass, but a closed window's leftovers are exactly the kind of thing that is
      // very often NOT this repo (a stray build tool, an unrelated shell) — gating
      // on the signature FIRST made that residue structurally unreachable: on this
      // box 50 of 59 processes across 14 dead-window scopes never matched the repo
      // path and were silently dropped before `classifyScope` (which already knows
      // how to call this out as `abandoned-window`) ever ran. Probe liveness at the
      // SCOPE level (once per scope, cached — see `probeWindow` above) and bypass
      // the signature filter ONLY for a scope the probe positively confirms is
      // dead. A live or unknown window keeps the existing signature-gated
      // behavior, so an owner's live terminal (routinely full of processes that
      // don't match any repo) still can't flood the foreign pass.
      const cgroupPath = relCgroupPath(node.absDir, cgroupRoot);
      const isWindow = isTerminalWindowScope(cgroupPath);
      const windowConfirmedDead = isWindow && probeWindow(node.absDir, cgroupPath) === false;
      for (const pid of node.pids) {
        if (seen.has(pid) || pid === selfPid) continue;
        if (!windowConfirmedDead) {
          const cmdline = parseProcCmdline(fs.readFile(`/proc/${pid}/cmdline`));
          if (!cmdline || !sig.test(cmdline)) {
            // Not listed, but still a fact about the kernel: keep its identity so
            // an enrolled unconfined row with a repo-less argv is not misread as
            // gone (WI-10005782). Visibility is unchanged — this map is never shown.
            const identity = readProcFacts(pid, bootId, uptimeSec, scanNowMs, fs).identity;
            if (identity) unlistedIdentityByPid.set(pid, identity);
            continue;
          }
        }
        push(pid, node.absDir, false);
      }
    }
  }

  return {
    processes,
    ownedRootAbs,
    ownedRootExists,
    userManagerRoot,
    ownedTruncated,
    foreignTruncated,
    unlistedIdentityByPid,
  };
}

/**
 * The default foreign signature for this repo. A caller may override it; it lives
 * here so there is ONE place to fix when the tree moves, and so the default is
 * anchored on a path rather than a binary NAME.
 *
 * Anchoring on the path is deliberate. Matching a bare binary name ("papercusp",
 * "node") is precisely the mistake behind the `pkill -f` incidents: it matches the
 * owner's live desktop window, every peer agent's test instance, and unrelated
 * processes that merely share a runtime.
 *
 * ── WHY THE ANCHOR IS THE WORKSPACE, NOT THE ONE CHECKOUT (EI-20476751101455367) ──
 *
 * It used to anchor on `repoRoot` itself, and that made our own release machinery
 * structurally invisible. We run several checkouts of this product side by side —
 * `papercusp` (dev), `papercusp-checkpoint` (what green-checkpoint runs its suites
 * in), `papercup-release` (what :3070 serves). `REPO_ROOT` resolves from the cwd of
 * whichever one the operator happens to be running out of, so the signature named
 * exactly ONE of them and every process from the other two failed the `sig.test`
 * at the top of the foreign pass — dropped before `classifyScope` ever ran.
 *
 * Measured on this box 2026-08-16: three vitest processes from `papercusp-checkpoint`,
 * idle at 0.000 cores, aged 4.8h/14h/15h, holding 3,121 MB between them, each alone
 * in its own `app.slice/run-u<N>.scope`. `processes:list { live:true }` scanned 547
 * processes and reported `unaccounted: 0` — a FALSE CLEAN, the direction that hides
 * residue. The operator was serving from `papercup-release`, so the leftovers of the
 * gate's own dead runs could not match the signature.
 *
 * This is the same failure the foreign pass's `windowConfirmedDead` bypass above was
 * added to fix ("gating on the signature FIRST made that residue structurally
 * unreachable"), reached by a second route: there the residue was not OUR repo, here
 * it is our repo under a sibling directory name.
 *
 * So the anchor is the DIRECTORY THAT CONTAINS the checkout — every sibling checkout
 * of ours matches, and the property that mattered is untouched: it is still a path
 * anchor, not a name match, so `/usr/bin/papercusp-desktop` still does not match.
 *
 * ⚠ Do NOT instead "fix" this by widening `SYSTEMD_RUN_SCOPE_RE` in `scope-class` to
 * cover the `run-u<N>.scope` form these leftovers use. That regex grants the
 * `systemd-unit` EXEMPTION, so widening it would classify this residue as accounted-for
 * and hide it again — permanently, and with a rationale that reads correct.
 */
export function defaultForeignSignature(repoRoot: string): RegExp {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const workspaceRoot = repoRoot.slice(0, repoRoot.lastIndexOf('/'));
  // A checkout at the filesystem root (or a bare relative name) has no meaningful
  // containing workspace — anchoring on "" or "/" would match every process on the
  // box, which is the opposite of this function's job. Fall back to the checkout.
  if (workspaceRoot.length <= 1) return new RegExp(escape(repoRoot));
  return new RegExp(`${escape(workspaceRoot)}/`);
}
