/**
 * task-manager/cgroup-read — the kernel side of the ledger
 * (task-manager-no-escape-2026-07-27, P-006).
 *
 * Everything here reads cgroup v2's unified hierarchy under `/sys/fs/cgroup`. The
 * parsers are pure and separately tested because the FORMATS are the part that
 * silently changes between kernels and the part a live-box test cannot pin: a
 * `memory.peak` that does not exist on an older kernel, a `cpu.stat` that gains a
 * field, a `cgroup.procs` that is empty because the scope emptied between the
 * readdir and the read. Each of those must degrade to `null` — never to a zero
 * that reads as a real measurement, because a fabricated 0 RSS is worse than an
 * honest "unknown" in a pane whose whole job is telling you what is eating the box.
 *
 * IO is behind an injected reader so the scanner's tests never touch a real /sys.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';

export const CGROUP_ROOT = '/sys/fs/cgroup';

/** Minimal fs surface — injected in tests. */
export interface CgroupFs {
  readFile(path: string): string | null;
  readDir(path: string): string[];
  isDir(path: string): boolean;
}

export const nodeCgroupFs: CgroupFs = {
  readFile(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  readDir(path) {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
  isDir(path) {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
};

// ── pure parsers ────────────────────────────────────────────────────────────

/**
 * `/proc/<pid>/cgroup` -> the unified (v2) path.
 *
 * v2 is the `0::<path>` line. A hybrid/v1 host has numbered controller lines
 * instead; we return null rather than guessing, and the caller degrades to an
 * unconfined-but-still-ledgered task. Getting this wrong in the other direction —
 * accepting a v1 controller path as if it were the unified one — would make the
 * ownership test (`isOwnedCgroupPath`) answer confidently and wrongly.
 */
export function parseProcCgroup(content: string): string | null {
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    // hierarchy-id:controllers:path — v2 is id 0 with an empty controller list.
    const firstColon = t.indexOf(':');
    const secondColon = t.indexOf(':', firstColon + 1);
    if (firstColon < 0 || secondColon < 0) continue;
    if (t.slice(0, firstColon) === '0' && t.slice(firstColon + 1, secondColon) === '') {
      const path = t.slice(secondColon + 1);
      return path.startsWith('/') ? path : null;
    }
  }
  return null;
}

/** `cgroup.procs` -> pids. Empty file is a legitimate answer (an emptied scope). */
export function parseCgroupProcs(content: string): number[] {
  const out: number[] = [];
  for (const line of content.split('\n')) {
    const n = Number(line.trim());
    if (Number.isInteger(n) && n > 0) out.push(n);
  }
  return out;
}

/** A single-integer cgroup file (`memory.current`, `pids.current`, `memory.peak`).
 *  `max` (the literal systemd uses for "no limit") is not a number — null. */
export function parseCgroupInt(content: string | null): number | null {
  if (content == null) return null;
  const t = content.trim();
  if (!t || t === 'max') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * `/pids.events` -> the cumulative number of fork attempts refused by the
 * cgroup's pids controller. Unlike `pids.current`, this high-water signal stays
 * available after the workload drains, which is what lets terminal diagnosis
 * attribute a later exit to historical fork pressure.
 */
export function parseCgroupPidsEventsMax(content: string | null): number | null {
  if (content == null) return null;
  for (const line of content.split('\n')) {
    const [key, value, ...extra] = line.trim().split(/\s+/);
    if (key !== 'max' || extra.length > 0) continue;
    if (!/^\d+$/.test(value ?? '')) return null;
    const count = Number(value);
    return Number.isSafeInteger(count) && count >= 0 ? count : null;
  }
  return null;
}

/** `cpu.stat` -> usage_usec. Returns null when the field is absent rather than 0. */
export function parseCpuStatUsageUsec(content: string | null): number | null {
  if (content == null) return null;
  for (const line of content.split('\n')) {
    const [k, v] = line.trim().split(/\s+/);
    if (k === 'usage_usec') {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

/** `/proc/<pid>/cmdline` is NUL-separated; the trailing NUL must not become a
 *  phantom empty argument. */
export function parseProcCmdline(content: string | null): string {
  if (!content) return '';
  return content.split('\0').filter(Boolean).join(' ').trim();
}

// ── reads ───────────────────────────────────────────────────────────────────

export interface CgroupSample {
  memoryBytes: number | null;
  peakMemoryBytes: number | null;
  cpuUsec: number | null;
  pidsCurrent: number | null;
  pidsEventsMax: number | null;
}

/** Sample one cgroup directory. Every field independently degrades to null. */
export function sampleCgroup(absDir: string, fs: CgroupFs = nodeCgroupFs): CgroupSample {
  return {
    memoryBytes: parseCgroupInt(fs.readFile(`${absDir}/memory.current`)),
    peakMemoryBytes: parseCgroupInt(fs.readFile(`${absDir}/memory.peak`)),
    cpuUsec: parseCpuStatUsageUsec(fs.readFile(`${absDir}/cpu.stat`)),
    pidsCurrent: parseCgroupInt(fs.readFile(`${absDir}/pids.current`)),
    pidsEventsMax: parseCgroupPidsEventsMax(fs.readFile(`${absDir}/pids.events`)),
  };
}

/** Pids directly in one cgroup directory (NOT its children — see collectPidsDeep). */
export function readCgroupProcs(absDir: string, fs: CgroupFs = nodeCgroupFs): number[] {
  const content = fs.readFile(`${absDir}/cgroup.procs`);
  return content == null ? [] : parseCgroupProcs(content);
}

/** The unified cgroup path of a running pid, or null. */
export function readProcessCgroupPath(pid: number, fs: CgroupFs = nodeCgroupFs): string | null {
  const content = fs.readFile(`/proc/${pid}/cgroup`);
  return content == null ? null : parseProcCgroup(content);
}

export function readProcessCmdline(pid: number, fs: CgroupFs = nodeCgroupFs): string {
  return parseProcCmdline(fs.readFile(`/proc/${pid}/cmdline`));
}

/**
 * Walk a cgroup subtree, yielding every directory that holds at least one process.
 *
 * Depth-bounded: a runaway nesting (or a symlink loop someone contrives) must not
 * be able to hang the reconciler, which runs on a 30s cadence and would otherwise
 * pile up. 32 is far past any real slice/scope nesting.
 */
export function walkCgroupTree(
  absRoot: string,
  fs: CgroupFs = nodeCgroupFs,
  maxDepth = 32,
): { absDir: string; pids: number[] }[] {
  const out: { absDir: string; pids: number[] }[] = [];
  const stack: { dir: string; depth: number }[] = [{ dir: absRoot, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop()!;
    if (depth > maxDepth) continue;
    if (!fs.isDir(dir)) continue;
    const pids = readCgroupProcs(dir, fs);
    if (pids.length > 0) out.push({ absDir: dir, pids });
    for (const entry of fs.readDir(dir)) {
      const child = `${dir}/${entry}`;
      if (fs.isDir(child)) stack.push({ dir: child, depth: depth + 1 });
    }
  }
  return out;
}

/** `/sys/fs/cgroup/<relative>` -> absolute, tolerating a leading slash. */
export function absCgroupDir(relativePath: string, root = CGROUP_ROOT): string {
  const rel = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
  return rel ? `${root}/${rel}` : root;
}

/** The inverse: an absolute /sys path back to the kernel-relative cgroup path,
 *  which is the form `/proc/<pid>/cgroup` reports and the ledger stores. */
export function relCgroupPath(absDir: string, root = CGROUP_ROOT): string {
  return absDir.startsWith(root) ? absDir.slice(root.length) || '/' : absDir;
}
