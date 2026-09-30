/**
 * p2p/sandbox/cgroup-limits.ts — P-105 §2: the COMPUTE axis
 * (DESIGN-p2p-P105-…md §2). Allotments (inference-token accounting) are
 * inference-myopic: a zero-token `cargo build` or a runaway test loop can
 * saturate CPU/RAM/disk on the shared box without ever touching the token
 * ledger. Decision: cgroup v2 limits (cpu.max, memory.max, io.max) plus an
 * RLIMIT_* ulimit floor as defense-in-depth — a MECHANICAL backstop that
 * doesn't depend on the workload being honest.
 *
 * PURE config-builder + cgroup-v2-file renderer (unit-testable, no root or
 * cgroup filesystem needed); `applyCgroupLimits` is the REAL write, used
 * only by the drill (requires cgroup v2 mounted + delegated controller
 * permissions — never wired into a production spawn path here).
 */

export interface CgroupLimitInput {
  /** CPU ceiling as a percentage of one core, e.g. 50 = half a core. */
  cpuMaxPercent: number;
  memoryMaxBytes: number;
  /** IO ceiling in bytes/sec (both read and write share this ceiling — v1
   *  keeps the config surface small; split rbps/wbps is a later refinement). */
  ioMaxBytesPerSec: number;
}

export interface CgroupLimitSpec extends CgroupLimitInput {
  /** cgroup v2 uses a 100ms period by default; `cpu.max` = "<quota> <period>". */
  cpuPeriodUs: number;
}

const DEFAULT_CPU_PERIOD_US = 100_000;

/** Build a validated limit spec. Every bound must be positive; cpuMaxPercent
 *  > 0 (an all-zero cgroup would starve the session entirely — that's a
 *  kill, not a limit; see enforcement-kill.ts). */
export function buildCgroupLimits(input: CgroupLimitInput): CgroupLimitSpec {
  if (input.cpuMaxPercent <= 0) throw new Error('buildCgroupLimits: cpuMaxPercent must be positive');
  if (input.memoryMaxBytes <= 0) throw new Error('buildCgroupLimits: memoryMaxBytes must be positive');
  if (input.ioMaxBytesPerSec <= 0) throw new Error('buildCgroupLimits: ioMaxBytesPerSec must be positive');
  return { ...input, cpuPeriodUs: DEFAULT_CPU_PERIOD_US };
}

/** Render the cgroup v2 controller-file CONTENTS this spec maps to. Pure —
 *  the caller writes these strings to `<cgroupPath>/<filename>`. `io.max`
 *  needs a major:minor device id, which is host-specific; this renders the
 *  `<major>:<minor>` placeholder form the drill substitutes at apply time. */
export function renderCgroupV2Files(spec: CgroupLimitSpec, ioDevice = '<major>:<minor>'): Record<string, string> {
  const quotaUs = Math.round((spec.cpuMaxPercent / 100) * spec.cpuPeriodUs);
  return {
    'cpu.max': `${quotaUs} ${spec.cpuPeriodUs}`,
    'memory.max': String(spec.memoryMaxBytes),
    'io.max': `${ioDevice} rbps=${spec.ioMaxBytesPerSec} wbps=${spec.ioMaxBytesPerSec}`,
  };
}

/** RLIMIT_* floor (defense-in-depth per §2 — applies even if cgroup
 *  delegation is unavailable on a given host). Values are conservative
 *  per-process ceilings, not the cgroup's aggregate limits. */
export interface UlimitFloor {
  /** RLIMIT_CPU seconds. */
  cpuSeconds: number;
  /** RLIMIT_AS bytes (virtual memory ceiling). */
  addressSpaceBytes: number;
  /** RLIMIT_NPROC — caps fork-bombs independent of cgroup pids controller. */
  maxProcesses: number;
}

export function buildUlimitFloor(spec: CgroupLimitSpec): UlimitFloor {
  return {
    cpuSeconds: 3600, // 1h ceiling regardless of cgroup CPU share — a runaway loop dies eventually
    addressSpaceBytes: spec.memoryMaxBytes,
    maxProcesses: 256,
  };
}

export type OverLimitAxis = 'cpu' | 'memory' | 'io';

/** Pure over-limit decision the supervision sweep (or the drill) can poll
 *  against a live usage sample. Returns every axis currently over, not just
 *  the first — a caller deciding whether to escalate to kill (§5) wants the
 *  full picture. */
export function decideOverLimit(
  usage: { cpuPercent: number; memoryBytes: number; ioBytesPerSec: number },
  spec: CgroupLimitSpec,
): OverLimitAxis[] {
  const over: OverLimitAxis[] = [];
  if (usage.cpuPercent > spec.cpuMaxPercent) over.push('cpu');
  if (usage.memoryBytes > spec.memoryMaxBytes) over.push('memory');
  if (usage.ioBytesPerSec > spec.ioMaxBytesPerSec) over.push('io');
  return over;
}

export interface CgroupFsDeps {
  writeFile?: (path: string, content: string) => Promise<void>;
  mkdir?: (path: string) => Promise<void>;
}

export type ApplyCgroupOutcome = { ok: true; cgroupPath: string } | { ok: false; refusal: { code: 'write-failed'; detail: string } };

/**
 * REAL write: create `<cgroupRoot>/<principalName>` and write its cpu.max /
 * memory.max / io.max controller files. Requires cgroup v2 mounted with the
 * relevant controllers delegated to the caller — drill-only.
 */
export async function applyCgroupLimits(
  cgroupRoot: string,
  principalName: string,
  spec: CgroupLimitSpec,
  ioDevice: string | undefined,
  deps: CgroupFsDeps = {},
): Promise<ApplyCgroupOutcome> {
  const { mkdir: mkdirFs, writeFile: writeFileFs } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const mkdir = deps.mkdir ?? ((p: string) => mkdirFs(p, { recursive: true }).then(() => undefined));
  const writeFile = deps.writeFile ?? ((p: string, c: string) => writeFileFs(p, c, 'utf8'));
  const cgroupPath = join(cgroupRoot, principalName);
  try {
    await mkdir(cgroupPath);
    const files = renderCgroupV2Files(spec, ioDevice);
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(cgroupPath, name), content);
    }
    return { ok: true, cgroupPath };
  } catch (e) {
    return { ok: false, refusal: { code: 'write-failed', detail: e instanceof Error ? e.message : String(e) } };
  }
}
