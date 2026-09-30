/**
 * Per-job CPU accounting for `capability:bash` background jobs, read from the job's own
 * cgroup (EI-20051445912325691).
 *
 * WHY THE KERNEL'S AGGREGATE AND NOT A PROCESS-TREE WALK. "Is my backgrounded job working
 * or wedged?" is ~12% of all bash calls on this box, and every hand-rolled answer to it is
 * a traversal you then have to trust: a `ps -o %cpu` reading is a process-LIFETIME average,
 * a single-shot sampler has no prior sample to difference against, and a tree walk that
 * misses a descendant, a double-fork or a reparent returns 0 — indistinguishable from a
 * genuinely idle job, which is the reading that invites killing and relaunching work that
 * was fine. A background job runs in its OWN systemd scope, so the kernel already sums the
 * whole subtree exactly; reading its aggregate cannot miss a descendant because membership,
 * not parentage, is what it accounts for.
 *
 * WHY IT IS COMPUTED HERE RATHER THAN DOCUMENTED AS A RECIPE. Measured 2026-08-10, the
 * shell form has three separate ways to lie, and all three land on a reader who is already
 * worried their job is stuck:
 *   1. Only a `run_in_background: true` job gets its own scope. A FOREGROUND call (or a
 *      manual trailing `&` inside one) runs in the OPERATOR's cgroup — measured 7.33 cores
 *      across 34 pids in the same window the job itself burned 0.91. That over-reads by ~8x
 *      and, worse, can never read zero, so a dead job looks busy and the reader keeps
 *      waiting. This module is only ever called with a tracked job's own scope, so the
 *      mistake is unrepresentable.
 *   2. The scope is TORN DOWN when the job exits, so a read moments later returns empty and
 *      `bc` evaluates the blanks — observed printing `-3.35 cores`. Hence: every failure
 *      here returns null with a REASON, never a number.
 *   3. `cpu.stat` is readable even though the cpu controller is NOT delegated to the scope
 *      (`cgroup.controllers` = `[memory pids]`). Anyone who checks controllers first
 *      concludes this is impossible and gives up — a wrong conclusion I drew and retracted
 *      mid-investigation.
 *
 * CPU USAGE IS A DELTA, so a single sample is meaningless (the `top -b -n1` artifact,
 * EI-20017779937060288). Two samples are required, and `coresBetween` refuses to invent a
 * rate from anything else.
 */

/** One reading of a cgroup's cumulative CPU usage. `usageUsec` is monotonic per cgroup. */
export interface CgroupCpuSample {
  atMs: number;
  usageUsec: number;
}

/** Minimum gap between samples. Below this, scheduler jitter and the read itself dominate
 *  the arithmetic, so a rate computed over it is noise wearing a number's clothes. */
export const MIN_SAMPLE_GAP_MS = 250;

/**
 * Pull `usage_usec` out of a cgroup v2 `cpu.stat` body.
 *
 * Returns null for anything that is not a usable number — an empty read (the torn-down
 * scope above), a body without the key, or a non-numeric value. Null means UNKNOWN and is
 * never coerced to 0 by callers: "no measurement" and "measured zero" are opposite claims,
 * and conflating them is the whole bug this module exists to avoid.
 */
export function parseCgroupUsageUsec(cpuStatBody: string | null | undefined): number | null {
  if (!cpuStatBody) return null;
  for (const line of cpuStatBody.split('\n')) {
    if (!line.startsWith('usage_usec')) continue;
    const raw = line.slice('usage_usec'.length).trim();
    // `Number('')` is 0, so an EMPTY value would parse as a measured zero — the exact
    // "blank read becomes a real-looking number" bug this module exists to prevent, and it
    // was present here until the test above caught it. Reject the empty string explicitly.
    if (raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
}

/**
 * Resolve the cgroup-relative path from a `/proc/<pid>/cgroup` body.
 *
 * cgroup v2 emits a single `0::<path>` line. A v1 body (`<id>:<controller>:<path>`) has no
 * unified path, and guessing one from a controller hierarchy would produce a real-looking
 * path that accounts for something else — so it returns null rather than a plausible answer.
 */
export function cgroupRelPathFromProc(procCgroupBody: string | null | undefined): string | null {
  if (!procCgroupBody) return null;
  for (const line of procCgroupBody.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('0::')) continue;
    const path = trimmed.slice('0::'.length);
    return path.startsWith('/') ? path : null;
  }
  return null;
}

/**
 * Cores burned between two samples: elapsed CPU-microseconds over elapsed wall-microseconds.
 * 1.0 means one core saturated for the whole window.
 *
 * Refuses (null) on: a missing sample; a window shorter than MIN_SAMPLE_GAP_MS; and a
 * NEGATIVE usage delta, which is not a slow job but a different cgroup — the scope was torn
 * down and recreated, or the pid was reused. That asymmetry is deliberate and mirrors
 * `isFrozen` / `withinBootGrace` in bghost-watchdog.mjs: never manufacture a reading from a
 * signal that has gone missing.
 */
export function coresBetween(
  a: CgroupCpuSample | null | undefined,
  b: CgroupCpuSample | null | undefined,
): number | null {
  if (!a || !b) return null;
  const elapsedMs = b.atMs - a.atMs;
  if (!Number.isFinite(elapsedMs) || elapsedMs < MIN_SAMPLE_GAP_MS) return null;
  const usedUsec = b.usageUsec - a.usageUsec;
  if (!Number.isFinite(usedUsec) || usedUsec < 0) return null;
  return usedUsec / (elapsedMs * 1000);
}

/** Injectable filesystem reader, so every path above is testable without a real cgroup. */
export type ReadTextFn = (path: string) => string | null;

/**
 * Read one sample for `pid` by resolving its cgroup and reading that cgroup's `cpu.stat`.
 * Fails soft to null — this is diagnostic garnish on a tool whose real job is returning
 * output, so it must never throw and never block the reply.
 */
export function readCgroupCpuSample(
  pid: number | null | undefined,
  deps: { readText: ReadTextFn; now?: () => number; cgroupRoot?: string },
): CgroupCpuSample | null {
  if (pid == null || !Number.isInteger(pid) || pid <= 0) return null;
  const root = deps.cgroupRoot ?? '/sys/fs/cgroup';
  const rel = cgroupRelPathFromProc(deps.readText(`/proc/${pid}/cgroup`));
  if (!rel) return null;
  const usageUsec = parseCgroupUsageUsec(deps.readText(`${root}${rel}/cpu.stat`));
  if (usageUsec == null) return null;
  return { atMs: (deps.now ?? Date.now)(), usageUsec };
}

/** What a caller should say when it has no rate to report. Distinct strings, because
 *  "not measured yet" and "the job is gone" prompt opposite next actions. */
export type CpuUnavailableReason =
  | 'not-a-background-job'
  | 'job-not-running'
  | 'cgroup-unreadable'
  | 'awaiting-second-sample';
