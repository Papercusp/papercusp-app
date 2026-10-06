/**
 * Fleet-logs retention GC — WI-224710 cause #2 ("`fleet-logs` grows without
 * bound").
 *
 * Every headless-spawn launch path backs its session with a log file instead
 * of a desktop window under `papercuspPathForWorkspace(workspaceId,
 * 'fleet-logs')` (launch-agent, launch-on-plan, goals/start,
 * fleet-headcount-action, delegated-spawn-honor, goal-auto-start, launch-su,
 * console-launch, revive-responder). None of those writers ever deletes
 * anything, so the directory grows forever. Measured live 2026-08-30 on
 * papercusp: 25G / 2,946 files in ONE such directory, on a filesystem sitting
 * at 98% used with only ~46.5G of the required 2%-floor headroom left — this
 * one directory alone was over half the remaining disk margin the
 * green-checkpoint gate needs to render a verdict at all (a prior
 * "unbounded fleet-logs" re-validation checked the wrong, non-existent
 * `~/.papercusp/fleet-logs` path and concluded this cause was minor; the real
 * per-workspace path was never actually measured — see WI-224710 comment
 * history).
 *
 * Two independent bounds, matching WI-224710's originally proposed fix:
 *   1. AGE — delete any file whose mtime is older than `retentionMs`.
 *   2. TOTAL-BYTES CEILING — after the age pass, if a directory is still over
 *      `maxTotalBytes`, delete additional files OLDEST-mtime-first until
 *      under it. The safety net against a burst of spawns outrunning the age
 *      window between sweeps.
 *
 * Deliberately NOT scoped here: a per-file size cap / truncation of an
 * individual huge (multi-GB) log. Doing that safely requires knowing the
 * file is not still open for append by a live writer — getting that wrong
 * corrupts a live agent's log mid-write. The two bounds above already evict
 * an outlier once it ages out or the directory crosses the ceiling; a single
 * runaway writer producing a multi-GB log is a separate bug in whatever
 * produces it (WI-224710 thread comment 78848's decomposition item (b), "the
 * actual disk drivers" — not gate-owned, needs its own lane).
 *
 * Best-effort, never throws: a vanished/locked file is skipped, one
 * unreadable directory doesn't abort the sweep (readdir failure → treated as
 * an empty directory), and every deletion failure is collected in the result
 * rather than raised. Purely mtime-based (matches the existing
 * `pruneOldLogs` used for checkpoint-logs retention, apps/operator's
 * green-checkpoint.ts): a live, actively-written log's mtime keeps advancing,
 * so a genuinely in-use file is never caught by the age bound.
 */
import { readdirSync, rmSync, statSync, lstatSync, realpathSync, unlinkSync, type Dirent, type Stats } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative as relativePath, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { workspacesRoot } from './workspace-registry';
import { openWriterPidsMany, NATIVE_BG_SCAN_DEADLINE_MS, type OpenWriterScan } from './native-bg-task-ledger';

/** 3 days: long enough to debug a recent spawn, short enough to keep the
 *  steady-state footprint well clear of the disk-headroom floor. */
export const FLEET_LOGS_GC_DEFAULT_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

/** 10 GiB per fleet-logs directory: a burst safety net independent of age. */
export const FLEET_LOGS_GC_DEFAULT_MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024;

export interface FleetLogsGcOptions {
  retentionMs?: number;
  maxTotalBytes?: number;
  dryRun?: boolean;
  /** Injectable for tests: sweep exactly these directories instead of
   *  discovering them from the on-disk workspace registry. */
  dirs?: string[];
}

export interface FleetLogsGcDirResult {
  dir: string;
  scanned: number;
  removedByAge: number;
  removedByCeiling: number;
  bytesFreed: number;
  bytesRemaining: number;
  errors: Array<{ path: string; error: string }>;
}

export interface FleetLogsGcResult {
  dirs: FleetLogsGcDirResult[];
  dryRun: boolean;
}

/** Every `fleet-logs` directory that plausibly exists on this host: one per
 *  workspace dir actually present on disk, plus the legacy home-root path.
 *  Discovered from the filesystem itself (not `backgroundWorkspaceIds()`,
 *  which reflects which workspace this PROCESS is scoped to, not which
 *  workspace DIRECTORIES exist) so an orphaned/inactive workspace's logs are
 *  swept too — the disk doesn't care which workspace is active. A missing
 *  directory is simply never discovered; sweeping it is a no-op regardless
 *  (readdirSync failure inside gcOneDir is treated as "nothing to scan"). */
function discoverFleetLogsDirs(): string[] {
  const dirs = new Set<string>();
  dirs.add(join(homedir(), '.papercusp', 'fleet-logs'));
  let entries: Dirent[];
  try {
    entries = readdirSync(workspacesRoot(), { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    dirs.add(join(workspacesRoot(), entry.name, '.papercusp', 'fleet-logs'));
  }
  return [...dirs];
}

function listFilesWithStat(dir: string): Array<{ path: string; mtimeMs: number; size: number }> {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ path: string; mtimeMs: number; size: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue; // fleet-logs is a flat directory of *.log files
    const p = join(dir, entry.name);
    try {
      const st = statSync(p);
      out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      /* vanished between readdir and stat — skip, not an error */
    }
  }
  return out;
}

function gcOneDir(
  dir: string,
  retentionMs: number,
  maxTotalBytes: number,
  dryRun: boolean,
): FleetLogsGcDirResult {
  const files = listFilesWithStat(dir);
  const errors: Array<{ path: string; error: string }> = [];
  const cutoff = Date.now() - retentionMs;
  let removedByAge = 0;
  let removedByCeiling = 0;
  let bytesFreed = 0;

  // Pass 1: age. Whatever survives goes into `remaining` for the ceiling pass.
  const remaining: Array<{ path: string; mtimeMs: number; size: number }> = [];
  for (const f of files) {
    if (f.mtimeMs >= cutoff) {
      remaining.push(f);
      continue;
    }
    if (!dryRun) {
      try {
        unlinkSync(f.path);
      } catch (e) {
        errors.push({ path: f.path, error: (e as Error)?.message ?? String(e) });
        remaining.push(f); // failed to remove — still occupies bytes
        continue;
      }
    }
    removedByAge++;
    bytesFreed += f.size;
  }

  // Pass 2: total-bytes ceiling, oldest-mtime-first, over whatever the age
  // pass left behind (including anything a dry run "would have" removed —
  // a dry run reports what pass 1 alone would free plus what pass 2 would
  // additionally free from the age-surviving set, which is the accurate
  // picture: pass 2 never needs to reconsider a file pass 1 already marked).
  remaining.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = remaining.reduce((s, f) => s + f.size, 0);
  for (const f of remaining) {
    if (total <= maxTotalBytes) break;
    if (!dryRun) {
      try {
        unlinkSync(f.path);
      } catch (e) {
        errors.push({ path: f.path, error: (e as Error)?.message ?? String(e) });
        continue; // still occupies bytes — leave it in `total`
      }
    }
    total -= f.size;
    bytesFreed += f.size;
    removedByCeiling++;
  }

  return {
    dir,
    scanned: files.length,
    removedByAge,
    removedByCeiling,
    bytesFreed,
    bytesRemaining: total,
    errors,
  };
}

/** Run one sweep. Pure w.r.t. its inputs (`dirs` overrides discovery), so a
 *  test never has to mock the workspace registry — it just points at a tmp
 *  dir. Never throws. */
export function runFleetLogsGc(opts: FleetLogsGcOptions = {}): FleetLogsGcResult {
  const retentionMs = opts.retentionMs ?? FLEET_LOGS_GC_DEFAULT_RETENTION_MS;
  const maxTotalBytes = opts.maxTotalBytes ?? FLEET_LOGS_GC_DEFAULT_MAX_TOTAL_BYTES;
  const dryRun = opts.dryRun === true;
  const dirs = opts.dirs ?? discoverFleetLogsDirs();
  return {
    dirs: dirs.map((d) => gcOneDir(d, retentionMs, maxTotalBytes, dryRun)),
    dryRun,
  };
}

// ---------------------------------------------------------------------------
// One-off working-DIRECTORY retention (WI-10002015).
//
// The sweep above bounds `fleet-logs`, a flat directory of *.log FILES with
// known writers. It does not touch the other half of the measured growth:
// one-off working DIRECTORIES created directly under `~/.papercusp` by ad-hoc
// tooling, which have no owner and no retention at all. Measured 2026-09-20 on
// this host: 188 top-level directories, several multi-GB, the oldest 100+ days.
//
// ⚠ THE FILE-BASED SAFETY ARGUMENT ABOVE DOES NOT TRANSFER, and assuming it
// does destroys live work. That argument is "a live, actively-written log's
// mtime keeps advancing, so a genuinely in-use file is never caught by the age
// bound". For a DIRECTORY that is false: only creating/deleting/renaming an
// entry touches a directory's mtime, so appending to a nested file leaves every
// ancestor directory's mtime frozen — measured 2026-09-20, a pure append left
// the top dir, the intermediate dir AND the file's own immediate parent all
// unchanged. So `find -maxdepth 1 -type d -mtime +N -delete` classifies an
// ACTIVELY-WRITTEN working dir as stale. The live near-miss: the largest
// directory on this host (82.8 GiB, an in-flight release) had an own-mtime 79
// minutes old while being actively written; a size-ranked or own-mtime sweep
// would have deleted it mid-release.
//
// Hence three independent guards, each load-bearing:
//   1. ALLOWLIST BY CONSTRUCTION, not a denylist. Only `mktemp`-suffixed names
//      (a final dot + exactly 6 [A-Za-z0-9]) are eligible: that suffix is
//      machine-generated by mktemp, so such a directory is *by construction* a
//      one-off temporary. A denylist would silently eat every future durable
//      directory the moment someone forgot to add it; this cannot. Measured on
//      this host: 4 of 188 top-level dirs match, so the blast radius is small
//      and knowable rather than "everything we failed to think of".
//   2. RECURSIVE newest-mtime age bound — the newest mtime anywhere in the
//      tree, never the directory's own, per the paragraph above.
//   3. RE-STAT IMMEDIATELY BEFORE REMOVAL. The scan is not atomic: a directory
//      can be adopted by a live writer between scan and unlink. The tree is
//      re-walked at the moment of deletion and skipped if anything got newer.
//
// Deliberately NOT swept: the ~180 non-mktemp one-off directories. Their names
// are ad-hoc agent choices with no machine-readable disposability signal, so
// reclaiming them safely needs an ownership convention rather than a pattern
// guess. That is a separate lane; guessing here is precisely the failure this
// allowlist exists to prevent.
//
// Symlinks are never followed (`Dirent.isDirectory()` is lstat-shaped, so a
// symlinked directory reports false and is treated as a leaf). That matters:
// `~/.papercusp` reaches ~50 checkouts whose `node_modules/@papercusp/*`
// symlink back into workspace packages, and following that DAG is unbounded.
// ---------------------------------------------------------------------------

/** A trailing mktemp template expansion: a final dot plus exactly six
 *  [A-Za-z0-9]. Anchored, so `foo.bar` and `p046-r31` never match. */
const MKTEMP_SUFFIX_RE = /^(.+)\.[A-Za-z0-9]{6}$/;

/** 7 days. Deliberately far more conservative than the 3-day fleet-logs bound:
 *  the unit of deletion here is a whole tree that may represent hours of
 *  irreplaceable in-flight work, so the cost of deleting too early is not
 *  symmetric with the cost of keeping a stale directory one more day. */
export const PAPERCUSP_WORKDIR_GC_DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Bounds one tree walk. A pathological tree costs a bounded scan instead of
 *  stalling the sweep; hitting the cap makes the directory INELIGIBLE (we
 *  cannot prove it is stale, so we must not delete it). */
export const PAPERCUSP_WORKDIR_GC_SCAN_ENTRY_CAP = 200_000;

/** Defense-in-depth only: the allowlist already excludes every one of these,
 *  since none carries a mktemp suffix. This is the second lock, for a future
 *  directory that happens to be named e.g. `secrets.AbC123`. Compared against
 *  the name with the mktemp suffix stripped. */
export const PAPERCUSP_WORKDIR_GC_PROTECTED_BASENAMES: ReadonlySet<string> = new Set([
  'hives', 'worktrees', 'launch-context', 'secrets', 'signing', 'state', 'sockets',
  'fleet-logs', 'checkpoint-logs', 'session-claude', 'session-mcp', 'session-ports',
  'vendor', 'toolchains', 'runtime', 'tracking', 'turn-provenance', 'wake-spills',
  'scratch', 'tmp', 'su-codex-homes', 'su-omp-homes', 'role-codex-homes',
  'pot-git', 'bench-harnesses', 'live-fed-gate',
]);

export interface PapercuspWorkdirGcOptions {
  /** Defaults to `~/.papercusp`. Injectable so a test points at a tmp dir. */
  root?: string;
  retentionMs?: number;
  dryRun?: boolean;
  /** Test seam. Missing, partial or failed process evidence always keeps trees. */
  scanOpenPaths?: (paths: readonly string[]) => Promise<OpenWriterScan>;
  /** Injectable clock for tests. */
  now?: number;
}

export interface PapercuspWorkdirGcCandidate {
  path: string;
  name: string;
  bytes: number;
  newestMtimeMs: number;
  ageMs: number;
  removed: boolean;
  /** Why an eligible-looking directory was NOT removed. */
  skipped?: 'too-new' | 'protected' | 'not-mktemp' | 'scan-capped' | 'raced' | 'error' | 'in-use' | 'process-scan-incomplete';
  error?: string;
}

export interface PapercuspWorkdirGcResult {
  root: string;
  scanned: number;
  removed: number;
  bytesFreed: number;
  dryRun: boolean;
  wouldRemove: number;
  bytesReclaimable: number;
  candidates: PapercuspWorkdirGcCandidate[];
}

/** Recursive newest-mtime + total bytes for one tree. Never follows symlinks,
 *  never throws, and reports `capped` rather than silently under-reporting —
 *  an under-reported newest-mtime would make a live tree look stale, which is
 *  the one error this whole mechanism exists to avoid. */
function scanTree(
  dir: string,
  cap: number,
  ignoreRootMtime = false,
): { newestMtimeMs: number; bytes: number; entries: number; capped: boolean } {
  let newestMtimeMs = 0;
  let bytes = 0;
  let entries = 0;
  const stack: string[] = [dir];

  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (entries >= cap) return { newestMtimeMs, bytes, entries, capped: true };

    // The directory's own mtime still counts — it catches an empty tree whose
    // last activity was creating/removing an entry. After this GC removes a
    // linked worktree, Git updates the producer container's root mtime as a
    // side effect; that one root timestamp can be ignored while descendants
    // are still checked and the directory identity is revalidated.
    try {
      const st = lstatSync(current);
      if (!st.isDirectory()) return { newestMtimeMs, bytes, entries, capped: true };
      if (!(ignoreRootMtime && current === dir) && st.mtimeMs > newestMtimeMs) newestMtimeMs = st.mtimeMs;
    } catch {
      return { newestMtimeMs, bytes, entries, capped: true };
    }

    let children: Dirent[];
    try {
      children = readdirSync(current, { withFileTypes: true });
    } catch {
      return { newestMtimeMs, bytes, entries, capped: true }; // cannot prove staleness
    }

    for (const child of children) {
      entries++;
      if (entries >= cap) return { newestMtimeMs, bytes, entries, capped: true };
      const p = join(current, child.name);
      // isDirectory() is lstat-shaped: a symlink-to-directory reports false, so
      // the symlink DAG is never followed.
      if (child.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!child.isFile()) continue; // symlink / socket / fifo — not our bytes
      try {
        const st = lstatSync(p);
        if (!st.isFile()) return { newestMtimeMs, bytes, entries, capped: true };
        if (st.mtimeMs > newestMtimeMs) newestMtimeMs = st.mtimeMs;
        bytes += st.size;
      } catch {
        return { newestMtimeMs, bytes, entries, capped: true };
      }
    }
  }

  return { newestMtimeMs, bytes, entries, capped: false };
}

/** Sweep one-off mktemp working directories under `root`. Best-effort, never
 *  throws. See the block comment above for why each guard is load-bearing. */
export async function runPapercuspWorkdirGc(
  opts: PapercuspWorkdirGcOptions = {},
): Promise<PapercuspWorkdirGcResult> {
  let root = opts.root ?? join(homedir(), '.papercusp');
  const retentionMs = opts.retentionMs ?? PAPERCUSP_WORKDIR_GC_DEFAULT_RETENTION_MS;
  const dryRun = opts.dryRun !== false;
  const now = opts.now ?? Date.now();
  const cutoff = now - retentionMs;

  let top: Dirent[];
  try {
    if (!Number.isFinite(now) || !Number.isFinite(retentionMs) || retentionMs < 0) throw new Error('invalid retention clock');
    if (!lstatSync(root).isDirectory()) throw new Error('not a directory');
    root = realpathSync(root);
    top = readdirSync(root, { withFileTypes: true });
  } catch {
    return { root, scanned: 0, removed: 0, bytesFreed: 0, wouldRemove: 0, bytesReclaimable: 0, dryRun, candidates: [] };
  }

  const candidates: PapercuspWorkdirGcCandidate[] = [];
  const identities = new Map<string, Stats>();
  let removed = 0;
  let bytesFreed = 0;
  let wouldRemove = 0;
  let bytesReclaimable = 0;

  for (const entry of top) {
    if (!entry.isDirectory()) continue; // includes symlinked dirs — never swept
    const name = entry.name;
    const match = MKTEMP_SUFFIX_RE.exec(name);
    if (!match) continue; // not machine-generated: not ours to reclaim

    const path = join(root, name);
    const base = match[1] as string;
    if (PAPERCUSP_WORKDIR_GC_PROTECTED_BASENAMES.has(base)) {
      candidates.push({
        path, name, bytes: 0, newestMtimeMs: 0, ageMs: 0,
        removed: false, skipped: 'protected',
      });
      continue;
    }

    try { identities.set(path, lstatSync(path)); }
    catch { continue; }
    const scan = scanTree(path, PAPERCUSP_WORKDIR_GC_SCAN_ENTRY_CAP);
    const ageMs = now - scan.newestMtimeMs;
    const record: PapercuspWorkdirGcCandidate = {
      path, name, bytes: scan.bytes, newestMtimeMs: scan.newestMtimeMs, ageMs, removed: false,
    };
    candidates.push(record);

    if (scan.capped) {
      // Could not prove staleness over the whole tree — refuse to delete.
      record.skipped = 'scan-capped';
      continue;
    }
    if (scan.newestMtimeMs >= cutoff) {
      record.skipped = 'too-new';
      continue;
    }
  }

  const eligible = candidates.filter((c) => !c.skipped);
  let openPaths: OpenWriterScan = { byPath: new Map(), complete: false };
  if (eligible.length > 0) {
    try {
      openPaths = await (opts.scanOpenPaths ?? ((paths) => openWriterPidsMany(paths, {
        descendants: true, includeCwd: true, failClosed: true, deadlineMs: NATIVE_BG_SCAN_DEADLINE_MS,
      })))(eligible.map((c) => c.path));
    } catch { /* no destructive action without process evidence */ }
  }

  for (const record of eligible) {
    const path = record.path;
    if (openPaths.byPath.get(path)?.length) { record.skipped = 'in-use'; continue; }
    if (!openPaths.complete) { record.skipped = 'process-scan-incomplete'; continue; }
    const identity = identities.get(path)!;
    try {
      const current = lstatSync(path);
      if (!current.isDirectory() || current.ino !== identity.ino || current.dev !== identity.dev) {
        record.skipped = 'raced'; continue;
      }
    } catch { record.skipped = 'raced'; continue; }

    // Guard 3: re-walk immediately before removal. The first scan may be many
    // seconds old by now, and a live writer can have adopted the tree since.
    const confirm = scanTree(path, PAPERCUSP_WORKDIR_GC_SCAN_ENTRY_CAP);
    if (confirm.capped || confirm.newestMtimeMs >= cutoff) {
      record.skipped = 'raced';
      record.newestMtimeMs = confirm.newestMtimeMs;
      record.ageMs = now - confirm.newestMtimeMs;
      continue;
    }

    try {
      const current = lstatSync(path);
      if (!current.isDirectory() || current.ino !== identity.ino || current.dev !== identity.dev) {
        record.skipped = 'raced'; continue;
      }
    } catch { record.skipped = 'raced'; continue; }

    wouldRemove++;
    bytesReclaimable += confirm.bytes;

    if (!dryRun) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch (e) {
        record.skipped = 'error';
        record.error = (e as Error)?.message ?? String(e);
        continue;
      }
    }
    if (!dryRun) {
      record.removed = true;
      removed++;
      bytesFreed += confirm.bytes;
    }
  }

  return { root, scanned: candidates.length, removed, bytesFreed, wouldRemove, bytesReclaimable, dryRun, candidates };
}

export const WINDOWS_BUILD_SCRATCH_GC_DEFAULT_RETENTION_MS = 48 * 60 * 60 * 1000;

const WINDOWS_BUILD_SCRATCH_NAME_RE = /^papercusp-win-cross-source-[A-Za-z0-9]{6}$/;
const WINDOWS_BUILD_SCRATCH_WORKTREE_NAME = 'papercusp-desktop';

export interface WindowsBuildScratchGcOptions {
  /** Producer uses /tmp explicitly; injectable for isolated tests. */
  root?: string;
  /** The Papercusp desktop source repository containing the linked worktree registrations. */
  repoRoot?: string;
  retentionMs?: number;
  dryRun?: boolean;
  scanOpenPaths?: (paths: readonly string[]) => Promise<OpenWriterScan>;
  now?: number;
}

export interface WindowsBuildScratchGcCandidate {
  path: string;
  buildRoot: string;
  name: string;
  bytes: number;
  newestMtimeMs: number;
  ageMs: number;
  removed: boolean;
  skipped?:
    | 'too-new'
    | 'scan-capped'
    | 'raced'
    | 'error'
    | 'in-use'
    | 'process-scan-incomplete'
    | 'git-inspection-failed'
    | 'unexpected-worktree'
    | 'unregistered-worktree'
    | 'unsafe-worktree-path'
    | 'git-locked'
    | 'lock-acquire-failed'
    | 'lock-verification-failed'
    | 'worktree-remove-failed'
    | 'worktree-remains';
  error?: string;
}

export interface WindowsBuildScratchGcResult {
  root: string;
  scanned: number;
  removed: number;
  bytesFreed: number;
  dryRun: boolean;
  wouldRemove: number;
  bytesReclaimable: number;
  candidates: WindowsBuildScratchGcCandidate[];
}

interface GitWorktreeRegistration {
  path: string;
  locked: boolean;
  lockReason: string;
}

function readGitWorktreeRegistrations(repoRoot: string): GitWorktreeRegistration[] {
  const output = execFileSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  return output
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const worktreeLine = lines.find((line) => line.startsWith('worktree '));
      if (!worktreeLine) return null;
      const lockedLine = lines.find((line) => line === 'locked' || line.startsWith('locked '));
      return {
        path: resolve(worktreeLine.slice('worktree '.length)),
        locked: lockedLine !== undefined,
        lockReason: lockedLine?.slice('locked'.length).trim() ?? '',
      };
    })
    .filter((row): row is GitWorktreeRegistration => row !== null);
}

function pathContains(parent: string, child: string): boolean {
  const relative = relativePath(parent, child);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith('..' + sep) &&
    !isAbsolute(relative)
  );
}

function runGitWorktreeCommand(repoRoot: string, args: string[]): string {
  return execFileSync('git', ['-C', repoRoot, 'worktree', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
}

function unlockOwnedBuildScratchWorktree(repoRoot: string, worktreePath: string, reason: string): void {
  try {
    const current = readGitWorktreeRegistrations(repoRoot).find((row) => row.path === worktreePath);
    if (current?.locked && current.lockReason === reason) {
      runGitWorktreeCommand(repoRoot, ['unlock', worktreePath]);
    }
  } catch {
    // Never alter an uncertain lock; the next sweep can inspect it again.
  }
}

function sameDirectory(path: string, identity: Stats): boolean {
  try {
    const current = lstatSync(path);
    return current.isDirectory() && current.dev === identity.dev && current.ino === identity.ino;
  } catch {
    return false;
  }
}

/** Reclaim only the exact mktemp containers produced by build-windows-cross.sh.
 *  A recursive newest-mtime scan and a complete open-writer scan are both
 *  required. Registered worktrees are first claimed with a unique lock; an
 *  existing lock belongs to someone else and is never overridden. */
export async function runWindowsBuildScratchGc(
  opts: WindowsBuildScratchGcOptions = {},
): Promise<WindowsBuildScratchGcResult> {
  let root = opts.root ?? '/tmp';
  const retentionMs = opts.retentionMs ?? WINDOWS_BUILD_SCRATCH_GC_DEFAULT_RETENTION_MS;
  const dryRun = opts.dryRun !== false;
  const now = opts.now ?? Date.now();
  const cutoff = now - retentionMs;
  const empty = (): WindowsBuildScratchGcResult => ({
    root, scanned: 0, removed: 0, bytesFreed: 0, wouldRemove: 0, bytesReclaimable: 0, dryRun, candidates: [],
  });

  let top: Dirent[];
  try {
    if (!Number.isFinite(now) || !Number.isFinite(retentionMs) || retentionMs < 0) return empty();
    if (!lstatSync(root).isDirectory()) return empty();
    root = realpathSync(root);
    top = readdirSync(root, { withFileTypes: true });
  } catch {
    return empty();
  }

  const repoRoot = opts.repoRoot ??
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../papercusp-desktop');
  const candidates: WindowsBuildScratchGcCandidate[] = [];
  const identities = new Map<string, Stats>();
  let removed = 0;
  let bytesFreed = 0;
  let wouldRemove = 0;
  let bytesReclaimable = 0;

  for (const entry of top) {
    if (!entry.isDirectory() || !WINDOWS_BUILD_SCRATCH_NAME_RE.test(entry.name)) continue;
    const path = join(root, entry.name);
    const buildRoot = join(path, WINDOWS_BUILD_SCRATCH_WORKTREE_NAME);
    let identity: Stats;
    try {
      identity = lstatSync(path);
      identities.set(path, identity);
    } catch {
      continue;
    }
    const scan = scanTree(path, PAPERCUSP_WORKDIR_GC_SCAN_ENTRY_CAP);
    const record: WindowsBuildScratchGcCandidate = {
      path,
      buildRoot,
      name: entry.name,
      bytes: scan.bytes,
      newestMtimeMs: scan.newestMtimeMs,
      ageMs: now - scan.newestMtimeMs,
      removed: false,
    };
    candidates.push(record);
    if (scan.capped) record.skipped = 'scan-capped';
    else if (scan.newestMtimeMs >= cutoff) record.skipped = 'too-new';
  }

  const eligible = candidates.filter((candidate) => !candidate.skipped);
  if (eligible.length === 0) {
    return { root, scanned: candidates.length, removed, bytesFreed, wouldRemove, bytesReclaimable, dryRun, candidates };
  }

  const scanOpenPaths = opts.scanOpenPaths ?? ((paths) => openWriterPidsMany(paths, {
    descendants: true,
    includeCwd: true,
    failClosed: true,
    deadlineMs: NATIVE_BG_SCAN_DEADLINE_MS,
  }));
  let openPaths: OpenWriterScan = { byPath: new Map(), complete: false };
  try {
    openPaths = await scanOpenPaths(eligible.map((candidate) => candidate.path));
  } catch {
    // Missing process evidence is not permission to remove scratch.
  }

  for (const record of eligible) {
    if (openPaths.byPath.get(record.path)?.length) {
      record.skipped = 'in-use';
      continue;
    }
    if (!openPaths.complete) {
      record.skipped = 'process-scan-incomplete';
      continue;
    }
    const identity = identities.get(record.path);
    if (!identity || !sameDirectory(record.path, identity)) {
      record.skipped = 'raced';
      continue;
    }

    const initialConfirm = scanTree(record.path, PAPERCUSP_WORKDIR_GC_SCAN_ENTRY_CAP);
    if (initialConfirm.capped) {
      record.skipped = 'scan-capped';
      continue;
    }
    if (initialConfirm.newestMtimeMs >= cutoff) {
      record.skipped = 'too-new';
      record.newestMtimeMs = initialConfirm.newestMtimeMs;
      record.ageMs = now - initialConfirm.newestMtimeMs;
      continue;
    }

    let registrations: GitWorktreeRegistration[];
    try {
      registrations = readGitWorktreeRegistrations(repoRoot);
    } catch (error) {
      record.skipped = 'git-inspection-failed';
      record.error = (error as Error)?.message ?? String(error);
      continue;
    }

    let buildRootStat: Stats | undefined;
    try {
      buildRootStat = lstatSync(record.buildRoot);
      if (!buildRootStat.isDirectory()) {
        record.skipped = 'unsafe-worktree-path';
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        record.skipped = 'unsafe-worktree-path';
        record.error = (error as Error)?.message ?? String(error);
        continue;
      }
    }

    const nestedRegistrations = registrations.filter((row) => pathContains(record.path, row.path));
    const registration = nestedRegistrations.find((row) => row.path === resolve(record.buildRoot));
    if (nestedRegistrations.some((row) => row.path !== resolve(record.buildRoot))) {
      record.skipped = 'unexpected-worktree';
      continue;
    }
    if (registration && !buildRootStat) {
      record.skipped = 'raced';
      continue;
    }

    let hasGitMarker = false;
    if (buildRootStat) {
      try {
        const marker = lstatSync(join(record.buildRoot, '.git'));
        hasGitMarker = marker.isFile() || marker.isDirectory() || marker.isSymbolicLink();
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          record.skipped = 'unsafe-worktree-path';
          record.error = (error as Error)?.message ?? String(error);
          continue;
        }
      }
    }
    if (!registration && hasGitMarker) {
      record.skipped = 'unregistered-worktree';
      continue;
    }
    if (registration?.locked) {
      record.skipped = 'git-locked';
      continue;
    }

    if (dryRun) {
      wouldRemove++;
      bytesReclaimable += initialConfirm.bytes;
      record.bytes = initialConfirm.bytes;
      record.newestMtimeMs = initialConfirm.newestMtimeMs;
      record.ageMs = now - initialConfirm.newestMtimeMs;
      continue;
    }

    let lockReason: string | undefined;
    if (registration) {
      lockReason = 'papercusp-build-scratch-gc:' + randomUUID();
      try {
        runGitWorktreeCommand(repoRoot, ['lock', '--reason', lockReason, record.buildRoot]);
      } catch (error) {
        record.skipped = 'lock-acquire-failed';
        record.error = (error as Error)?.message ?? String(error);
        continue;
      }
      let claimed: GitWorktreeRegistration | undefined;
      try {
        claimed = readGitWorktreeRegistrations(repoRoot).find((row) => row.path === resolve(record.buildRoot));
      } catch (error) {
        record.skipped = 'lock-verification-failed';
        record.error = (error as Error)?.message ?? String(error);
        unlockOwnedBuildScratchWorktree(repoRoot, resolve(record.buildRoot), lockReason);
        continue;
      }
      if (!claimed?.locked || claimed.lockReason !== lockReason) {
        record.skipped = 'lock-verification-failed';
        unlockOwnedBuildScratchWorktree(repoRoot, resolve(record.buildRoot), lockReason);
        continue;
      }
    }

    const unlockIfOwned = () => {
      if (lockReason) unlockOwnedBuildScratchWorktree(repoRoot, resolve(record.buildRoot), lockReason);
    };
    const confirm = scanTree(record.path, PAPERCUSP_WORKDIR_GC_SCAN_ENTRY_CAP);
    if (confirm.capped) {
      record.skipped = 'scan-capped';
      unlockIfOwned();
      continue;
    }
    if (confirm.newestMtimeMs >= cutoff || !sameDirectory(record.path, identity)) {
      record.skipped = 'raced';
      unlockIfOwned();
      continue;
    }
    let finalOpenPaths: OpenWriterScan = { byPath: new Map(), complete: false };
    try {
      finalOpenPaths = await scanOpenPaths([record.path]);
    } catch {
      // Keep the candidate and release only the lock this sweep claimed.
    }
    if (finalOpenPaths.byPath.get(record.path)?.length) {
      record.skipped = 'in-use';
      unlockIfOwned();
      continue;
    }
    if (!finalOpenPaths.complete) {
      record.skipped = 'process-scan-incomplete';
      unlockIfOwned();
      continue;
    }

    if (registration) {
      let exactLock: GitWorktreeRegistration | undefined;
      try {
        exactLock = readGitWorktreeRegistrations(repoRoot).find((row) => row.path === resolve(record.buildRoot));
      } catch (error) {
        record.skipped = 'lock-verification-failed';
        record.error = (error as Error)?.message ?? String(error);
        unlockIfOwned();
        continue;
      }
      if (!exactLock?.locked || exactLock.lockReason !== lockReason) {
        record.skipped = 'lock-verification-failed';
        unlockIfOwned();
        continue;
      }
      try {
        runGitWorktreeCommand(repoRoot, ['remove', '--force', '--force', record.buildRoot]);
      } catch (error) {
        record.skipped = 'worktree-remove-failed';
        record.error = (error as Error)?.message ?? String(error);
        unlockIfOwned();
        continue;
      }
      try {
        const after = readGitWorktreeRegistrations(repoRoot);
        if (after.some((row) => pathContains(record.path, row.path))) {
          record.skipped = 'worktree-remains';
          unlockIfOwned();
          continue;
        }
      } catch (error) {
        record.skipped = 'git-inspection-failed';
        record.error = (error as Error)?.message ?? String(error);
        continue;
      }
    }

    let cleanupOpenPaths: OpenWriterScan = { byPath: new Map(), complete: false };
    try {
      cleanupOpenPaths = await scanOpenPaths([record.path]);
    } catch {
      // Leave the container after worktree removal if writer evidence vanished.
    }
    if (cleanupOpenPaths.byPath.get(record.path)?.length) {
      record.skipped = 'in-use';
      continue;
    }
    if (!cleanupOpenPaths.complete) {
      record.skipped = 'process-scan-incomplete';
      continue;
    }

    // This is after Git's expected removal and after the last async process
    // scan. Ignore only the root mtime that Git itself refreshed; every
    // remaining descendant must still prove old, and the root identity must
    // still match the directory inspected before removal.
    const finalTree = scanTree(
      record.path,
      PAPERCUSP_WORKDIR_GC_SCAN_ENTRY_CAP,
      registration !== undefined,
    );
    if (finalTree.capped) {
      record.skipped = 'scan-capped';
      continue;
    }
    if (finalTree.newestMtimeMs >= cutoff || !sameDirectory(record.path, identity)) {
      record.skipped = 'raced';
      continue;
    }

    wouldRemove++;
    bytesReclaimable += confirm.bytes;
    try {
      if (registration) {
        const after = readGitWorktreeRegistrations(repoRoot);
        if (after.some((row) => pathContains(record.path, row.path))) {
          record.skipped = 'worktree-remains';
          continue;
        }
      }
      if (!sameDirectory(record.path, identity)) {
        record.skipped = 'raced';
        continue;
      }
      rmSync(record.path, { recursive: true, force: true });
    } catch (error) {
      record.skipped = 'error';
      record.error = (error as Error)?.message ?? String(error);
      continue;
    }
    record.bytes = confirm.bytes;
    record.newestMtimeMs = confirm.newestMtimeMs;
    record.ageMs = now - confirm.newestMtimeMs;
    record.removed = true;
    removed++;
    bytesFreed += confirm.bytes;
  }

  return { root, scanned: candidates.length, removed, bytesFreed, wouldRemove, bytesReclaimable, dryRun, candidates };
}

// ── `~/.papercusp/launch-context` — the third, unowned accumulation ──────────
//
// The two sweeps above leave a hole exactly the shape of this directory, and
// each leaves it for a DIFFERENT structural reason:
//
//   - `runFleetLogsGc` reaps FILES, but only inside directories literally named
//     `fleet-logs`;
//   - `runPapercuspWorkdirGc` sweeps DIRECTORIES under `~/.papercusp`, but only
//     mktemp-suffixed ones, and `launch-context` is in its protected-basenames
//     set — correctly, since the directory itself must never be removed.
//
// So a stable, named directory whose CONTENTS grow without bound is owned by
// neither. Measured on the papercusp box 2026-09-20: 769 MB across 14,920
// renders, the oldest dated 2026-05-31 — 14,626 files (719.8 MiB, 94% of both
// count and bytes) older than three days, on a root filesystem at 98%.
//
// ── WHY MTIME ALONE WOULD DELETE A LIVE SESSION'S PERSONA ───────────────────
//
// This is the one guard that makes this sweep different from its siblings, and
// getting it wrong is silent. A render is written ONCE, at launch, and then
// never touched again: the child reads it via `--system-prompt-file` at exec.
// Its mtime therefore records when the session STARTED, not when it was last
// useful. A session alive for ten days owns a ten-day-old file that every
// age-based rule on this page would happily reap.
//
// Age is consequently necessary but NOT sufficient, so this sweep additionally
// requires positive evidence of what is in use: `liveRenderPaths`, the set of
// `--system-prompt-file` argv values read from /proc by
// `listLiveSessionRenders`. That read is the authoritative answer to "what
// bytes is this process serving right now" — a respawn rewrites argv without
// touching any database row.
//
// FAIL-CLOSED: when that set is absent the sweep deletes NOTHING and says so
// (`refused: 'no-live-render-evidence'`). An empty Set is a measurement that
// found no live sessions; `undefined` is the absence of a measurement, and the
// two must never collapse into the same behaviour — the sibling above draws the
// same line with its `scan-capped` refusal. A caller that cannot enumerate
// /proc gets a no-op, never a guess.
//
// The caller must also pass an UNCAPPED enumeration. `listLiveSessionRenders`
// defaults to `SWEEP_SESSION_CAP` (500), which is a bound on work that is
// harmless for a notifier and load-bearing here: a truncated exclusion set
// silently converts live renders into deletion candidates.

/** Renders older than this are reclaimable — if, and only if, no live session
 *  is serving them. Matches the workdir sweep's 7 days. */
export const LAUNCH_CONTEXT_GC_DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface LaunchContextGcOptions {
  /** Defaults to `PAPERCUSP_LAUNCH_CONTEXT_DIR` or `~/.papercusp/launch-context`.
   *  Injectable so a test points at a tmp dir. */
  dir?: string;
  retentionMs?: number;
  dryRun?: boolean;
  now?: number;
  /**
   * Absolute render paths that live sessions are serving RIGHT NOW, normally
   * `new Set(listLiveSessionRenders('/proc', Infinity).map((r) => r.promptFile))`.
   *
   * Required to delete anything. Omitted ⇒ the sweep refuses (see above). It is
   * injected rather than read here so this module stays a pure fs unit with no
   * dependency on the coord/notification stack.
   */
  liveRenderPaths?: ReadonlySet<string>;
}

export interface LaunchContextGcCandidate {
  path: string;
  name: string;
  bytes: number;
  mtimeMs: number;
  ageMs: number;
  removed: boolean;
  skipped?: 'too-new' | 'live-session' | 'not-a-file' | 'raced' | 'error';
  error?: string;
}

export interface LaunchContextGcResult {
  dir: string;
  scanned: number;
  removed: number;
  bytesFreed: number;
  dryRun: boolean;
  /** Set when the sweep declined to consider ANY file. `removed` is 0. */
  refused?: 'no-live-render-evidence';
  /** How many candidates were held back because a live session serves them. */
  liveHeld: number;
  candidates: LaunchContextGcCandidate[];
}

/** The canonical launch-context directory, honouring the same env override as
 *  `launchContextDirPath()` in `stale-prompt-render-sweep.ts`. Duplicated as a
 *  one-line default rather than imported, so this fs-only module does not pull
 *  the coord/notification stack in behind it. */
function defaultLaunchContextDir(): string {
  return process.env.PAPERCUSP_LAUNCH_CONTEXT_DIR || join(homedir(), '.papercusp', 'launch-context');
}

/**
 * Reap aged persona/carry renders from `~/.papercusp/launch-context`.
 *
 * Best-effort and never throws, like its siblings: an unreadable directory is
 * treated as empty, a file that vanishes mid-sweep is recorded rather than
 * fatal, and every deletion failure lands in the candidate record.
 *
 * Only direct FILE children are considered — a subdirectory is never recursed
 * into and never removed.
 */
export function runLaunchContextGc(opts: LaunchContextGcOptions = {}): LaunchContextGcResult {
  const dir = opts.dir ?? defaultLaunchContextDir();
  const retentionMs = opts.retentionMs ?? LAUNCH_CONTEXT_GC_DEFAULT_RETENTION_MS;
  const dryRun = opts.dryRun === true;
  const now = opts.now ?? Date.now();
  const cutoff = now - retentionMs;
  const live = opts.liveRenderPaths;

  // Fail-closed: no evidence of what is in use ⇒ touch nothing. Reported before
  // the directory is even read, so the refusal can never be mistaken for "the
  // directory was empty".
  if (!live) {
    return {
      dir,
      scanned: 0,
      removed: 0,
      bytesFreed: 0,
      dryRun,
      refused: 'no-live-render-evidence',
      liveHeld: 0,
      candidates: [],
    };
  }

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { dir, scanned: 0, removed: 0, bytesFreed: 0, dryRun, liveHeld: 0, candidates: [] };
  }

  const candidates: LaunchContextGcCandidate[] = [];
  let removed = 0;
  let bytesFreed = 0;
  let liveHeld = 0;

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (!entry.isFile()) {
      // Includes symlinks and subdirectories — never followed, never removed.
      candidates.push({
        path, name: entry.name, bytes: 0, mtimeMs: 0, ageMs: 0,
        removed: false, skipped: 'not-a-file',
      });
      continue;
    }

    let mtimeMs: number;
    let bytes: number;
    try {
      const st = statSync(path);
      mtimeMs = st.mtimeMs;
      bytes = st.size;
    } catch (e) {
      candidates.push({
        path, name: entry.name, bytes: 0, mtimeMs: 0, ageMs: 0,
        removed: false, skipped: 'error', error: (e as Error)?.message ?? String(e),
      });
      continue;
    }

    const record: LaunchContextGcCandidate = {
      path, name: entry.name, bytes, mtimeMs, ageMs: now - mtimeMs, removed: false,
    };
    candidates.push(record);

    // Guard 1 — in use. Checked BEFORE age, because this is the guard whose
    // violation is unrecoverable: a live session's render is its persona.
    if (live.has(path)) {
      record.skipped = 'live-session';
      liveHeld++;
      continue;
    }

    // Guard 2 — age.
    if (mtimeMs >= cutoff) {
      record.skipped = 'too-new';
      continue;
    }

    // Guard 3 — re-stat immediately before unlinking. The readdir above may be
    // many seconds old, and a launch can have rewritten this path since.
    try {
      const confirm = statSync(path);
      if (confirm.mtimeMs >= cutoff) {
        record.skipped = 'raced';
        record.mtimeMs = confirm.mtimeMs;
        record.ageMs = now - confirm.mtimeMs;
        continue;
      }
    } catch (e) {
      record.skipped = 'raced';
      record.error = (e as Error)?.message ?? String(e);
      continue;
    }

    if (!dryRun) {
      try {
        unlinkSync(path);
      } catch (e) {
        record.skipped = 'error';
        record.error = (e as Error)?.message ?? String(e);
        continue;
      }
    }
    record.removed = true;
    removed++;
    bytesFreed += bytes;
  }

  return { dir, scanned: candidates.length, removed, bytesFreed, dryRun, liveHeld, candidates };
}
