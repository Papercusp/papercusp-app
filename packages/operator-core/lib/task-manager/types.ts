/**
 * task-manager/types — the row shape + the PURE naming algebra that joins the
 * three planes this subsystem spans (task-manager-no-escape-2026-07-27, P-002).
 *
 * The whole design rests on one trick: **the kernel object's NAME carries the
 * ledger key**. A task registered as `01k2f7…` is launched into the transient
 * scope `pc-01k2f7….scope`, so reconciling "what the kernel is running" against
 * "what the ledger says" is a string JOIN, not a cmdline heuristic. Everything
 * in this file exists to make that join total and reversible — hence
 * `scopeUnitForTask` / `taskIdFromScopeUnit` are tested as an exact round-trip.
 *
 * PURE by construction: no IO, no PG, no child_process, no clock except what the
 * caller passes. The store, the scanner and the chokepoint all import from here;
 * nothing here imports them.
 */

/** Lifecycle states. Mirrors the CHECK constraint in migration 696 (widened by
 *  migration 774 for `ended_unobserved`) — the two must be edited together (the
 *  store asserts membership before every write). */
export const TASK_STATES = [
  'pending',
  'running',
  'exited',
  'killed',
  'timed_out',
  'stranded',
  'unaccounted',
  'foreign',
  'ended_unobserved',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/**
 * States meaning "this process is over". `stranded` counts: the ledger said
 * running, the kernel disagreed, and the reconciler closed the row. It is kept
 * DISTINCT from `exited` because we never observed an exit code — reporting a
 * strand as a clean exit is exactly the kind of manufactured certainty that makes
 * an inherited "job COMPLETED" claim untrustworthy.
 *
 * `ended_unobserved` (task-manager-no-escape-2026-07-27#D-018) is ALSO kept
 * distinct from both neighbours: unlike `exited`, no exit code was ever
 * observed (the owning process died before `wireExit()` could record one);
 * unlike `stranded`, this is NOT the escape/anomaly class — the reconciler
 * independently confirmed via systemd that the task's transient scope was
 * released in good order, i.e. every process in it is confirmed gone, not
 * merely absent from one scan. A continuous stream of routine shutdowns filed
 * as `stranded` buries the one real escape that state exists to surface —
 * that is the whole reason this state exists rather than reusing `stranded`
 * with a different `exitReason`.
 */
export const TERMINAL_TASK_STATES: readonly TaskState[] = [
  'exited',
  'killed',
  'timed_out',
  'stranded',
  'ended_unobserved',
];

export function isTerminalState(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.includes(state);
}

/** States that assert a live OS process we OWN (and may therefore signal). */
export function isLiveOwnedState(state: TaskState): boolean {
  return state === 'pending' || state === 'running';
}

/**
 * Is this row exempt from AUTOMATED reaping?
 *
 * `isLiveOwnedState` above answers "may we signal this at all". This answers a
 * strictly narrower question: may a TIMER signal it, unattended. The two are not
 * the same, and conflating them is what this predicate exists to prevent.
 *
 * Stamped by `adopt-terminal-session`, which enrols the psu sessions a human
 * started by typing in a terminal. Those rows exist so the sessions are VISIBLE
 * and so a person or an agent can make a DELIBERATE `processes:kill { taskId }`
 * — never so something kills the owner's terminals on a schedule. We do not own
 * a `vte-spawn` scope's lifetime (the terminal window does), so auto-reaping one
 * closes a window and takes the live agent inside it with it.
 *
 * Deliberately NOT consulted by `killTask`: an explicit kill must still work, or
 * enrolment would remove the very handle it was added to provide. Automated
 * callers are the ones that must ask. See plan
 * terminal-psu-session-enrolment-2026-08-24 D-001 (owner ruling, 2026-08-24).
 */
export function isAutoReapExempt(row: Pick<TaskRow, 'detail'>): boolean {
  return row.detail?.autoReapExempt === true;
}

/**
 * What a task IS. Deliberately an open union (`string & {}`) rather than a closed
 * enum + DB CHECK: new root seams enrol over time and a migration per spawn site
 * would be friction with no safety win. The scheduled-registry's `ManagedCategory`
 * made the same call for the same reason.
 */
export type TaskClass =
  | 'agent-session' // a spawned agent CLI (the biggest subtree by far)
  | 'sidecar' // substrate / gateway / spawner / embed
  | 'bash-job' // capability:bash background job
  | 'test-run' // vitest / playwright / the gate suite
  | 'build' // tsc, vite, cargo
  | 'deploy' // release cut / checkpoint
  | 'service' // an adopted systemd unit
  | 'desktop' // Tauri shell + its children
  | 'pty' // interactive terminal host
  | 'other'
  | (string & {});

/** Who asked for this. `system:<name>` for routine-driven work, `human` for a
 *  hand-launched process the reconciler adopted, otherwise an agent ownerId. */
export type TaskLauncher = string;

/** The provenance block — the reason this subsystem exists. `ps` answers none of it. */
export interface TaskProvenance {
  launchedBy: TaskLauncher;
  workItemId?: string | null;
  planSlug?: string | null;
  fleetSlug?: string | null;
  sessionId?: string | null;
}

/** Resource budget. Every field optional: an unbudgeted task is legal (and is what
 *  everything is today), it just cannot be protected from taking the box down. */
export interface TaskBudget {
  memoryMaxBytes?: number | null;
  /** WI-41206: cgroup swap policy for this task. Omitted/'allow' (the default) lets the task
   *  PAGE when it reaches `memoryMaxBytes` instead of being OOM-killed — correct for a worker,
   *  which nothing waits on. Pass 'deny' (MemorySwapMax=0) only for a payload whose thrashing
   *  would wedge something the whole system depends on; the substrate sidecar is the one such
   *  caller in-tree, because its leak is what produced the WI-1086 68 GB thrash. */
  swap?: 'allow' | 'deny' | null;
  cpuWeight?: number | null;
  tasksMax?: number | null;
  /** Wall-clock ceiling. Enforced by systemd's own RuntimeMaxSec — NOT by a timer
   *  of ours, which would die with the operator and leave the task immortal. */
  runtimeMaxSec?: number | null;
}

/** Last metrics sample, read straight out of the scope's cgroup files. */
export interface TaskMetrics {
  lastMemoryBytes?: number | null;
  peakMemoryBytes?: number | null;
  cpuUsec?: number | null;
  pidsCurrent?: number | null;
  /** Cumulative fork-refusal counter from cgroup v2 `pids.events`. */
  pidsEventsMax?: number | null;
}

/**
 * Terminal facts captured from systemd before a failed transient task unit is
 * reset and garbage-collected.
 *
 * These live inside `task_ledger.detail.terminalProvenance` rather than a second
 * process-history table. The ledger already owns the task's state, budget,
 * metrics, scope unit, and cgroup path; this block adds only the systemd facts
 * that disappear when `reset-failed` releases the unit. `scopeUnit` is required
 * so a provenance block can never be detached from the kernel identity it
 * describes.
 */
export interface TaskTerminalProvenance {
  capturedAt: string;
  scopeUnit: string;
  cgroupPath: string | null;
  invocationId: string | null;
  loadState: string | null;
  activeState: string | null;
  serviceResult: string | null;
  /** Raw wait(2) `si_code` exposed by systemd (`1` exited, `2` killed, `3` dumped). */
  execMainCode: number | null;
  /** Raw exit status or signal number paired with `execMainCode`. */
  execMainStatus: number | null;
  memoryMaxBytes: number | null;
  peakMemoryBytes: number | null;
  /** Says whether peak RSS came from systemd's terminal snapshot or the ledger's last cgroup sample. */
  peakMemorySource: 'systemd' | 'cgroup-sample' | 'unknown';
}

function terminalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function terminalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Parse the bounded terminal block stored in the ledger's open `detail` bag. */
export function taskTerminalProvenanceFromDetail(
  detail: Record<string, unknown> | null | undefined,
): TaskTerminalProvenance | null {
  const raw = detail?.terminalProvenance;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const scopeUnit = terminalString(value.scopeUnit);
  const capturedAt = terminalString(value.capturedAt);
  if (!scopeUnit || !capturedAt) return null;
  const peakMemorySource =
    value.peakMemorySource === 'systemd' ||
    value.peakMemorySource === 'cgroup-sample' ||
    value.peakMemorySource === 'unknown'
      ? value.peakMemorySource
      : 'unknown';
  return {
    capturedAt,
    scopeUnit,
    cgroupPath: terminalString(value.cgroupPath),
    invocationId: terminalString(value.invocationId),
    loadState: terminalString(value.loadState),
    activeState: terminalString(value.activeState),
    serviceResult: terminalString(value.serviceResult),
    execMainCode: terminalNumber(value.execMainCode),
    execMainStatus: terminalNumber(value.execMainStatus),
    memoryMaxBytes: terminalNumber(value.memoryMaxBytes),
    peakMemoryBytes: terminalNumber(value.peakMemoryBytes),
    peakMemorySource,
  };
}

/** One ledger row, as the store returns it. */
export interface TaskRow extends TaskProvenance, TaskBudget, TaskMetrics {
  taskId: string;
  workspaceId: string;
  harnessSlug?: string | null;

  parentTaskId?: string | null;
  rootTaskId: string;

  class: TaskClass;
  title: string;
  argv: string[];
  cwd?: string | null;

  scopeUnit?: string | null;
  cgroupPath?: string | null;
  /** A HINT only. Never signal on it without re-verifying `processIdentity`. */
  pid?: number | null;
  processIdentity?: string | null;
  confined: boolean;

  state: TaskState;
  exitCode?: number | null;
  exitReason?: string | null;
  terminalProvenance?: TaskTerminalProvenance | null;
  startedAt: string;
  endedAt?: string | null;
  lastSeenAt: string;
  deadlineAt?: string | null;

  logPath?: string | null;
  detail: Record<string, unknown>;
}

/** What a caller hands `managedSpawn` / `registerTask`. */
export interface TaskSpec extends TaskProvenance, TaskBudget {
  class: TaskClass;
  title: string;
  argv: string[];
  cwd?: string | null;
  parentTaskId?: string | null;
  harnessSlug?: string | null;
  logPath?: string | null;
  detail?: Record<string, unknown>;
}

// ── naming algebra ──────────────────────────────────────────────────────────

/** The transient scope prefix. Short on purpose: it shows up in every
 *  `systemctl --user` listing on the box and in every cgroup path. */
export const TASK_SCOPE_PREFIX = 'pc-';
/** The root slice everything we own lives under. The scanner walks it recursively,
 *  so class sub-slices may nest arbitrarily deep without the scan changing. */
export const TASK_ROOT_SLICE = 'papercusp.slice';
export type TaskUnitKind = 'scope' | 'service';

/**
 * Task ids are restricted to `[0-9a-z]` so they are valid inside a systemd unit
 * name with zero escaping, and so `taskIdFromScopeUnit` can be an exact inverse.
 * Sortable-by-time prefix (base36 ms) + random suffix — a ULID in spirit, without
 * pulling a dependency for 8 lines.
 */
export function newTaskId(now: number = Date.now(), rand: () => number = Math.random): string {
  const ts = Math.floor(now).toString(36).padStart(9, '0');
  let suffix = '';
  while (suffix.length < 10) {
    suffix += Math.floor(rand() * 0x100000000)
      .toString(36)
      .replace(/[^0-9a-z]/g, '');
  }
  return `${ts}${suffix.slice(0, 10)}`;
}

export function isValidTaskId(taskId: string): boolean {
  return /^[0-9a-z]{4,64}$/.test(taskId);
}

/** Separates the machine-readable task id from the human-readable label inside a
 *  scope unit name. `--` because a single `-` is legal inside a label. */
export const TASK_SCOPE_LABEL_SEP = '--';

/**
 * `pc-<taskId>.scope`, or `pc-<taskId>--<label>.scope` when a label is supplied.
 *
 * The label exists because `systemctl --user list-units` is how people have always
 * found a running fleet member, and replacing a descriptive unit name with an
 * opaque id would take that away to buy nothing — the id is only meaningful to the
 * reconciler. Carrying both keeps the exact ledger join AND stays greppable, so no
 * existing habit breaks when a seam is enrolled.
 *
 * Throws on an invalid id rather than emitting a unit name systemd will reject at
 * spawn time (a launch-time failure is far harder to read than a call-time one).
 */
function taskUnitForTask(taskId: string, kind: TaskUnitKind, label?: string): string {
  if (!isValidTaskId(taskId)) {
    throw new Error(
      `task-manager: invalid taskId ${JSON.stringify(taskId)} — must match /^[0-9a-z]{4,64}$/ to be a legal systemd unit name`,
    );
  }
  const safe = (label ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return safe
    ? `${TASK_SCOPE_PREFIX}${taskId}${TASK_SCOPE_LABEL_SEP}${safe}.${kind}`
    : `${TASK_SCOPE_PREFIX}${taskId}.${kind}`;
}

export function scopeUnitForTask(taskId: string, label?: string): string {
  return taskUnitForTask(taskId, 'scope', label);
}

export function serviceUnitForTask(taskId: string, label?: string): string {
  return taskUnitForTask(taskId, 'service', label);
}

/**
 * The exact inverse — label and all. Returns null for anything that is not ours,
 * which is how the reconciler tells "a scope we launched" from "some other
 * transient scope on this user manager", without a lookup.
 */
export function taskIdFromScopeUnit(unit: string): string | null {
  const trimmed = unit.trim();
  const suffix = trimmed.endsWith('.scope') ? '.scope' : trimmed.endsWith('.service') ? '.service' : null;
  if (!trimmed.startsWith(TASK_SCOPE_PREFIX) || !suffix) return null;
  const body = trimmed.slice(TASK_SCOPE_PREFIX.length, -suffix.length);
  const sep = body.indexOf(TASK_SCOPE_LABEL_SEP);
  const id = sep >= 0 ? body.slice(0, sep) : body;
  return isValidTaskId(id) ? id : null;
}

/**
 * `papercusp-<class>.slice`. systemd reads `-` as a hierarchy separator, so a
 * class like `agent-session` yields `papercusp.slice/papercusp-agent.slice/
 * papercusp-agent-session.slice` — intermediate slices are auto-created, and the
 * recursive scan picks all of it up regardless. That nesting is a feature: it
 * makes "cap ALL agent work at N GB" a one-line property on a parent slice.
 */
export function sliceForClass(taskClass: TaskClass): string {
  const token = String(taskClass)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return token ? `papercusp-${token}.slice` : TASK_ROOT_SLICE;
}

/** True when `cgroupPath` sits inside anything we own. Used to classify a scanned
 *  process as ours-vs-foreign without needing a ledger row for it. */
export function isOwnedCgroupPath(cgroupPath: string): boolean {
  return cgroupPath.includes('/papercusp.slice/') || cgroupPath.includes(`/${TASK_SCOPE_PREFIX}`);
}

/**
 * The user manager's own cgroup root (`…/user@1000.service`), from any path beneath
 * it. Null when we are not under a user manager at all (a container, a system-slice
 * deployment) — the caller then works relative to the cgroup root.
 *
 * Lives here rather than in `scan` because both the SCANNER and the SPAWN chokepoint
 * need it, and `managed-spawn` importing `scan` would drag the whole kernel-walk
 * graph into the hot path every process is born through. This file imports nothing.
 */
export function deriveUserManagerRoot(ownCgroupPath: string | null): string | null {
  if (!ownCgroupPath) return null;
  const segs = ownCgroupPath.split('/').filter(Boolean);
  const idx = segs.findIndex((s) => /^user@\d+\.service$/.test(s));
  if (idx < 0) return null;
  return `/${segs.slice(0, idx + 1).join('/')}`;
}

/**
 * The cgroup DIRECTORY path a slice NAME expands to.
 *
 * systemd reads `-` in a unit name as a hierarchy separator, so
 * `papercusp-agent-session.slice` is not one directory — it is
 * `papercusp.slice/papercusp-agent.slice/papercusp-agent-session.slice`, with the
 * intermediate slices auto-created. The recursive scan never had to know this
 * (it walks until it finds the unit); anything that wants to READ one specific
 * scope's cgroup does, and reproducing the expansion at the call site is how two
 * copies of a systemd naming rule drift apart.
 */
export function sliceCgroupPath(slice: string): string {
  const base = slice.endsWith('.slice') ? slice.slice(0, -'.slice'.length) : slice;
  const parts = base.split('-').filter(Boolean);
  return parts.map((_, i) => `${parts.slice(0, i + 1).join('-')}.slice`).join('/');
}

/**
 * Where a confined task's scope lives, as a cgroup path — DERIVED, never observed.
 *
 * WI-37509: reading `/proc/<child-pid>/cgroup` right after spawn looks like the
 * direct way to answer this and is wrong, because `systemd-run --scope` FORKS —
 * the pid we hold is the client, and it has not moved into the new scope yet (often
 * never will, in that pid). That read therefore returns the SPAWNER's cgroup, which
 * is how the ledger came to record a sidecar as living inside `papercup-dev-api.service`
 * and another inside a GNOME Terminal window. The path is fully determined by the
 * task id and class the moment they are minted, so derive it and skip the race.
 */
export function scopeCgroupRelPath(userManagerRoot: string | null, taskClass: TaskClass, scopeUnit: string): string {
  const slicePath = sliceCgroupPath(sliceForClass(taskClass));
  const root = (userManagerRoot ?? '').replace(/\/+$/, '');
  return `${root}/${slicePath}/${scopeUnit}`;
}
