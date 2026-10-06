/**
 * Headroom admission for a NEW desktop (agent-multi-desktops-grid-2026-10-06 P-004, D-007).
 *
 * An agent may now start as many desktops as it likes, so the machine — not a fixed
 * per-agent count — is the limit. Before a new desktop is provisioned we admit it only
 * when MemAvailable, minus a host reserve, still covers one desktop's footprint.
 *
 * The footprint is MEASURED, never guessed: each live desktop is a task-ledger root
 * (X server) with its window manager and apps enrolled as child tasks, so the memory a
 * desktop really costs is the sum of its subtree's cgroup `memory.current`. The median
 * over live desktops is the footprint; until one has been measured a conservative floor
 * stands in (and the verdict says which it used).
 *
 * A refusal is actionable: it reports measured available vs needed and lists the
 * caller's own idle/frozen desktops, which are exactly the ones to release first.
 *
 * Reused, not re-rolled: MemAvailable comes from host-capacity's reader, MemTotal from
 * the generic meminfo parser, cgroup sampling from the task manager's cgroup reader.
 *
 * Tuning (D-014): the soft cap and host reserve are numeric env knobs, following the
 * `capacityOverridesFromEnv` precedent in host-capacity.ts. A hosted workspace runs on
 * its own VM, so a per-host knob is a per-workspace knob there.
 */
import { readFileSync } from 'node:fs';
import { readMemAvailableBytes } from '../../sync/hyperbee/perf/host-capacity';
import { parseMeminfoKb } from '../../storage/pg-tuning-drift';
import { absCgroupDir, sampleCgroup } from '../../task-manager/cgroup-read';
import { listTasks } from '../../task-manager/store';
import { listDesktopSessions, type DesktopSessionRecord } from '../../desktop/desktop-session-registry';

const GiB = 1024 ** 3;

/** Stand-in footprint until a live desktop has been measured: an X server, a window
 *  manager and one browser comfortably fit, so this errs toward refusing early. */
export const DESKTOP_FOOTPRINT_FLOOR_BYTES = 1 * GiB;
/** Never let desktops eat into the last slice of the machine. */
export const DESKTOP_HOST_RESERVE_MIN_BYTES = 2 * GiB;
export const DESKTOP_HOST_RESERVE_FRACTION = 0.1;

export const DESKTOP_HEADROOM_EXHAUSTED = 'desktop_headroom_exhausted' as const;
export const DESKTOP_SOFT_CAP_REACHED = 'desktop_soft_cap_reached' as const;

export interface DesktopAdmissionInputs {
  /** MemAvailable in bytes; null when the host does not report it. */
  availableBytes: number | null;
  /** MemTotal in bytes; null when unreadable (the reserve then uses its floor). */
  totalBytes: number | null;
  /** Measured per-desktop footprints (bytes) of the live desktops. */
  footprints: readonly number[];
  /** Live desktops in this workspace, for the optional soft cap. */
  liveCount: number;
  softCap: number | null;
  reserveBytesOverride?: number | null;
}

export interface DesktopAdmissionVerdict {
  admit: boolean;
  code?: typeof DESKTOP_HEADROOM_EXHAUSTED | typeof DESKTOP_SOFT_CAP_REACHED;
  /** True when MemAvailable could not be read: admitted, but unmeasured. */
  unmeasured?: boolean;
  availableBytes: number | null;
  neededBytes: number;
  reserveBytes: number;
  footprintBytes: number;
  footprintSource: 'measured' | 'floor';
  measuredDesktops: number;
  liveCount: number;
  softCap: number | null;
}

export function medianBytes(values: readonly number[]): number | null {
  const v = values.filter((n) => Number.isFinite(n) && n > 0).slice().sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[mid]! : Math.round((v[mid - 1]! + v[mid]!) / 2);
}

export function hostReserveBytes(totalBytes: number | null, override?: number | null): number {
  if (override != null && Number.isFinite(override) && override >= 0) return override;
  const fraction = totalBytes != null && totalBytes > 0 ? Math.round(totalBytes * DESKTOP_HOST_RESERVE_FRACTION) : 0;
  return Math.max(DESKTOP_HOST_RESERVE_MIN_BYTES, fraction);
}

/** Pure decision — every input is measured by the caller, so this is exhaustively testable. */
export function decideDesktopAdmission(input: DesktopAdmissionInputs): DesktopAdmissionVerdict {
  const measured = medianBytes(input.footprints);
  const footprintBytes = measured ?? DESKTOP_FOOTPRINT_FLOOR_BYTES;
  const reserveBytes = hostReserveBytes(input.totalBytes, input.reserveBytesOverride);
  const neededBytes = footprintBytes + reserveBytes;
  const base = {
    availableBytes: input.availableBytes,
    neededBytes,
    reserveBytes,
    footprintBytes,
    footprintSource: measured != null ? ('measured' as const) : ('floor' as const),
    measuredDesktops: input.footprints.filter((n) => Number.isFinite(n) && n > 0).length,
    liveCount: input.liveCount,
    softCap: input.softCap,
  };
  if (input.softCap != null && input.liveCount >= input.softCap) {
    return { admit: false, code: DESKTOP_SOFT_CAP_REACHED, ...base };
  }
  // Desktops only run on Linux hosts, where MemAvailable always exists; an unreadable
  // value is an instrument failure, so admit and SAY it was unmeasured rather than
  // refusing every desktop on a reading we could not take.
  if (input.availableBytes == null) return { admit: true, unmeasured: true, ...base };
  if (input.availableBytes < neededBytes) return { admit: false, code: DESKTOP_HEADROOM_EXHAUSTED, ...base };
  return { admit: true, ...base };
}

/** Env knobs (D-014). Non-numeric / non-positive values are ignored. */
export function desktopAdmissionOverridesFromEnv(env: NodeJS.ProcessEnv = process.env): {
  softCap: number | null;
  reserveBytes: number | null;
} {
  const num = (v: string | undefined): number | null => {
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const cap = num(env.PAPERCUSP_DESKTOP_SOFT_CAP);
  return { softCap: cap != null ? Math.floor(cap) : null, reserveBytes: num(env.PAPERCUSP_DESKTOP_HOST_RESERVE_BYTES) };
}

export function readMemTotalBytes(): number | null {
  try {
    const kb = parseMeminfoKb(readFileSync('/proc/meminfo', 'utf8'), 'MemTotal');
    return kb != null && kb > 0 ? kb * 1024 : null;
  } catch {
    return null;
  }
}

/** Drop any cgroup that sits inside another selected one, so nested scopes are not double-counted. */
export function outermostCgroups(paths: readonly string[]): string[] {
  const uniq = [...new Set(paths.filter(Boolean))].sort((a, b) => a.length - b.length);
  const kept: string[] = [];
  for (const p of uniq) {
    if (!kept.some((k) => p === k || p.startsWith(k.endsWith('/') ? k : `${k}/`))) kept.push(p);
  }
  return kept;
}

export interface FootprintDeps {
  listSubtreeCgroups: (rootTaskId: string) => Promise<string[]>;
  memoryBytes: (cgroupPath: string) => number | null;
}

const defaultFootprintDeps: FootprintDeps = {
  listSubtreeCgroups: async (rootTaskId) =>
    (await listTasks({ rootTaskId })).map((t) => t.cgroupPath).filter((p): p is string => Boolean(p)),
  // The ledger stores the kernel-relative form `/proc/<pid>/cgroup` reports.
  memoryBytes: (cgroupPath) => sampleCgroup(cgroupPath.startsWith('/sys/') ? cgroupPath : absCgroupDir(cgroupPath)).memoryBytes,
};

/**
 * One desktop's measured footprint: the summed `memory.current` of its task subtree.
 * Null when it cannot be measured (unenrolled, or every cgroup already gone).
 */
export async function measureDesktopFootprintBytes(
  row: Pick<DesktopSessionRecord, 'taskId'>,
  deps: FootprintDeps = defaultFootprintDeps,
): Promise<number | null> {
  if (!row.taskId) return null;
  let total = 0;
  let seen = 0;
  for (const path of outermostCgroups(await deps.listSubtreeCgroups(row.taskId))) {
    const bytes = deps.memoryBytes(path);
    if (bytes != null && bytes > 0) {
      total += bytes;
      seen += 1;
    }
  }
  return seen > 0 ? total : null;
}

export interface ReleasableDesktop {
  name: string | null;
  desktopSessionId: string;
  state: string;
  lastActiveAt: string | null;
}

export interface DesktopAdmissionResult {
  verdict: DesktopAdmissionVerdict;
  /** The caller's own idle/frozen desktops — what to release to make room. */
  releasable: ReleasableDesktop[];
}

export interface AdmitNewDesktopDeps {
  listLive: () => Promise<DesktopSessionRecord[]>;
  measure: (row: DesktopSessionRecord) => Promise<number | null>;
  availableBytes: () => number | null;
  totalBytes: () => number | null;
  overrides: () => { softCap: number | null; reserveBytes: number | null };
}

/**
 * Measure, decide, and (on refusal) name what to release. Measurement failures degrade
 * to the floor footprint — never to an admission crash.
 */
export async function admitNewDesktop(
  opts: { workspaceId: string; ownerId?: string | null },
  deps?: Partial<AdmitNewDesktopDeps>,
): Promise<DesktopAdmissionResult> {
  const d: AdmitNewDesktopDeps = {
    listLive: () => listDesktopSessions({ workspaceId: opts.workspaceId }),
    measure: (row) => measureDesktopFootprintBytes(row),
    availableBytes: readMemAvailableBytes,
    totalBytes: readMemTotalBytes,
    overrides: () => desktopAdmissionOverridesFromEnv(),
    ...(deps ?? {}),
  };
  let live: DesktopSessionRecord[] = [];
  try {
    live = await d.listLive();
  } catch {
    // Unreadable registry: decide on the floor footprint with no live desktops counted.
  }
  const footprints: number[] = [];
  for (const row of live) {
    try {
      const bytes = await d.measure(row);
      if (bytes != null) footprints.push(bytes);
    } catch {
      // One unmeasurable desktop never blocks the decision.
    }
  }
  const { softCap, reserveBytes } = d.overrides();
  const verdict = decideDesktopAdmission({
    availableBytes: d.availableBytes(),
    totalBytes: d.totalBytes(),
    footprints,
    liveCount: live.length,
    softCap,
    reserveBytesOverride: reserveBytes,
  });
  const releasable = verdict.admit
    ? []
    : live
        .filter((r) => r.scope === 'agent' && opts.ownerId && r.scopeRef === opts.ownerId && (r.state === 'idle' || r.state === 'frozen'))
        .map((r) => ({
          name: r.name ?? null,
          desktopSessionId: r.id,
          state: r.state,
          lastActiveAt: r.lastActiveAt ? new Date(r.lastActiveAt).toISOString() : null,
        }));
  return { verdict, releasable };
}

const MiB = (n: number | null) => (n == null ? 'unknown' : `${Math.round(n / 1024 ** 2)} MiB`);

/** The refusal payload provision_desktop returns. */
export function admissionRefusal(result: DesktopAdmissionResult): Record<string, unknown> {
  const v = result.verdict;
  const reason =
    v.code === DESKTOP_SOFT_CAP_REACHED
      ? `this workspace is capped at ${v.softCap} live desktops (PAPERCUSP_DESKTOP_SOFT_CAP) and has ${v.liveCount}.`
      : `not enough free memory for another desktop: ${MiB(v.availableBytes)} available, ${MiB(v.neededBytes)} needed ` +
        `(${v.footprintSource} footprint ${MiB(v.footprintBytes)} + host reserve ${MiB(v.reserveBytes)}).`;
  return {
    ok: false,
    error: v.code,
    reason,
    availableBytes: v.availableBytes,
    neededBytes: v.neededBytes,
    footprintBytes: v.footprintBytes,
    footprintSource: v.footprintSource,
    reserveBytes: v.reserveBytes,
    liveDesktops: v.liveCount,
    releasable: result.releasable,
    next:
      result.releasable.length > 0
        ? `release one of your idle desktops with computer:release_desktop { desktop: "<name>" }, then retry.`
        : 'release a desktop you no longer need (computer:list_desktops), or retry once memory frees up.',
  };
}
