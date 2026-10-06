import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * systemd-scope — the pure `systemd-run --user --scope` argv-builder shared by every
 * spawn seam that isolates a payload into its own memory-capped cgroup instead of
 * running inside the launching process's own cgroup.
 *
 * Extracted from `harness/routines/release-actions.ts` (the original green-checkpoint
 * precedent, release-gate-ready-branch-2026-06-04 / the 2026-07-01 40G OOM crash-loop
 * fix) so a SECOND call-site — the per-agent-turn spawn seam in `dbos/orchestrator-runner.ts`
 * (bg-host-agent-spawn-scope-isolation-2026-07-02, WI-1499) — can reuse the exact same
 * mechanism without importing `release-actions.ts` (which registers a system action as a
 * module-level side effect and would be a backwards dependency for the core spawn
 * chokepoint to carry). `release-actions.ts` re-exports `buildIsolatedScopeArgv` from here
 * for backward compatibility with its existing test import.
 */

/** systemd-run launch failures that mean "the SCOPE could not start" (no bus, no
 *  binary, no permission) — retry the payload DIRECT rather than failing the caller.
 *  A payload failure inside a healthy scope must NOT match (it exits with the
 *  payload's own code/stderr, usually well past the launch window). */
export const SCOPE_LAUNCH_FAILURE_RE =
  /Failed to connect to bus|Failed to start transient scope|Interactive authentication required|No such file or directory/i;

/**
 * Keep the CLI's `--collect` spelling, but pin the failure half of its contract
 * explicitly as a unit property. `--collect` is documented as a shortcut for
 * this property on current systemd, while the live user manager has still
 * observed failed transient services with `CollectMode=inactive`; emitting both
 * makes the intended cleanup policy visible and testable at the D-Bus boundary.
 */
export const SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS = [
  '--collect',
  '--property=CollectMode=inactive-or-failed',
] as const;

/**
 * Can a `systemd-run --user` client started with `env` reach a USER manager at all?
 *
 * `systemd-run` being on PATH says nothing about this. A hosted workspace host runs
 * the operator as a SYSTEM service with no login session, so there is no user
 * manager and no user bus; `systemd-run --user` then exits 1 with
 * "Failed to connect to bus: No medium found" before the payload ever execs
 * (WI-10003189: every New Session on avi-test r50 died at boot this way).
 *
 * This mirrors systemd's own user-bus address resolution rather than guessing:
 * the client tries `$XDG_RUNTIME_DIR/systemd/private`, then the session bus from
 * `$DBUS_SESSION_BUS_ADDRESS`, then `$XDG_RUNTIME_DIR/bus`; with neither variable
 * set it returns -ENOMEDIUM (the "No medium found" above). Both variables unset is
 * therefore a definite "no"; a runtime dir whose sockets do not exist is a "no" too.
 * A non-`unix:path=` session address (abstract socket, tcp) cannot be stat'ed, so it
 * is deferred to systemd as a "yes"; the live scope probe
 * (`task-manager/managed-spawn.ts` `probeScopeSupport`) remains the authority for
 * everything this cheap check cannot see.
 *
 * Pure given `env` + `exists`; exported for tests.
 */
export function userManagerBusReachable(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): boolean {
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim();
  if (runtimeDir && (exists(join(runtimeDir, 'systemd', 'private')) || exists(join(runtimeDir, 'bus')))) {
    return true;
  }
  const sessionAddress = env.DBUS_SESSION_BUS_ADDRESS?.trim();
  if (!sessionAddress) return false;
  const unixPath = /(?:^|;)unix:(?:[^;]*,)?path=([^,;]+)/.exec(sessionAddress)?.[1];
  return unixPath ? exists(unixPath) : true;
}

/** Static, dependency-free runner used after systemd has accepted a payload. */
export const SYSTEMD_ENV_RUNNER_PATH = fileURLToPath(new URL('./systemd-scope-env-runner.mjs', import.meta.url));
/** Credential id is deliberately boring: it is visible to systemd, never a secret. */
export const SYSTEMD_ENV_CREDENTIAL_NAME = 'papercusp-env';
/** The fd must outlive asynchronous systemd admission, but never forever. */
export const SECRET_ENV_TRANSPORT_RELEASE_GRACE_MS = 60_000;

export interface SecretEnvironmentTransport {
  /** `/proc/<operator-pid>/fd/<fd>`; the backing file is unlinked immediately. */
  sourcePath: string;
  /** Close the operator-side reference after the consumer has started. */
  release: () => void;
}

export interface SecretEnvironmentPayload {
  argv: string[];
  transport: SecretEnvironmentTransport;
  /** The transient-service property that makes the credential available. */
  credentialProperty?: string;
}

/** Encode the exact replacement environment as NUL-delimited NAME=value records. */
export function encodeSecretEnvironment(env: Readonly<Record<string, string | undefined>>): Buffer {
  const records: string[] = [];
  for (const [name, value] of Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (value === undefined) continue;
    if (name.length === 0 || name.includes('=') || name.includes('\0')) continue;
    if (value.includes('\0')) throw new TypeError(`environment value for ${name} contains NUL`);
    records.push(`${name}=${value}`);
  }
  return Buffer.from(records.length ? `${records.join('\0')}\0` : '', 'utf8');
}

/**
 * Create an anonymous, unlinked environment payload. `/dev/shm` is the normal
 * path (tmpfs); the unlinked tmpdir fallback keeps payload data out of argv and
 * journald even on hosts without a usable shared-memory mount.
 */
export function createSecretEnvironmentTransport(
  env: Readonly<Record<string, string | undefined>>,
): SecretEnvironmentTransport {
  const bytes = encodeSecretEnvironment(env);
  const roots = process.platform === 'linux' && existsSync('/dev/shm') ? ['/dev/shm', tmpdir()] : [tmpdir()];
  let fd: number | null = null;
  let lastError: unknown = null;
  for (const root of roots) {
    const pathname = join(root, `papercusp-env-${process.pid}-${randomUUID()}`);
    try {
      fd = openSync(pathname, 'wx', 0o600);
      unlinkSync(pathname);
      break;
    } catch (error) {
      lastError = error;
      if (fd != null) {
        try {
          closeSync(fd);
        } catch {
          /* best effort */
        }
        fd = null;
      }
      try {
        unlinkSync(pathname);
      } catch {
        /* best effort */
      }
    }
  }
  if (fd == null) {
    throw lastError instanceof Error ? lastError : new Error('unable to create anonymous environment fd');
  }
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error('anonymous environment fd write made no progress');
      offset += written;
    }
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      /* best effort */
    }
    throw error;
  }
  let released = false;
  let releaseTimer: ReturnType<typeof setTimeout> | null = null;
  const release = (): void => {
    if (released) return;
    released = true;
    if (releaseTimer) clearTimeout(releaseTimer);
    try {
      closeSync(fd!);
    } catch {
      /* already closed */
    }
  };
  releaseTimer = setTimeout(release, SECRET_ENV_TRANSPORT_RELEASE_GRACE_MS);
  releaseTimer.unref?.();
  return {
    sourcePath: `/proc/${process.pid}/fd/${fd}`,
    release,
  };
}

export function environmentRunnerPayload(
  base: readonly string[],
  source: string,
  mode: 'fd-path' | 'credential',
): string[] {
  return [
    process.execPath,
    SYSTEMD_ENV_RUNNER_PATH,
    mode === 'fd-path' ? '--env-fd-path' : '--credential',
    source,
    '--',
    ...base,
  ];
}

function buildSecretEnvironmentPayload(
  base: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  mode: 'fd-path' | 'credential',
): SecretEnvironmentPayload {
  const transport = createSecretEnvironmentTransport(env);
  return {
    argv: environmentRunnerPayload(
      base,
      mode === 'credential' ? SYSTEMD_ENV_CREDENTIAL_NAME : transport.sourcePath,
      mode,
    ),
    transport,
    ...(mode === 'credential'
      ? { credentialProperty: `--property=LoadCredential=${SYSTEMD_ENV_CREDENTIAL_NAME}:${transport.sourcePath}` }
      : {}),
  };
}

export function buildExactEnvPayloadWithTransport(
  base: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): SecretEnvironmentPayload {
  return buildSecretEnvironmentPayload(base, env, 'fd-path');
}

export function buildServiceEnvPayloadWithTransport(
  base: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): SecretEnvironmentPayload {
  return buildSecretEnvironmentPayload(base, env, 'credential');
}

/**
 * Escape a payload argument for systemd's transient SERVICE ExecStart parser.
 *
 * systemd expands `$` expressions in ExecStart arguments before it launches
 * the payload. A shell command passed as `bash -c <command>` therefore loses
 * Bash parameter expansions such as `${PIPESTATUS[0]}` unless each `$` is
 * escaped as `$$`. Doubling every dollar also preserves shell `$$` (it becomes
 * `$$$$` for systemd, which leaves `$$` for Bash).
 */
export function escapeSystemdServiceArgument(value: string): string {
  // Use a replacer function: a string replacement of `$$` has JavaScript's
  // special replacement meaning "insert one literal `$`", which would make
  // the attempted escaping a silent no-op.
  return value.replaceAll('$', () => '$$');
}

/** Shared per-agent scope budget. Headless fleet members and orchestrated agent
 * turns are the same resource shape, so they must resolve the same override and
 * default instead of drifting into capped vs uncapped launch paths. */
export function agentSpawnScopeMemoryMaxG(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PAPERCUSP_AGENT_SPAWN_MEMORY_MAX_G);
  return Number.isFinite(raw) && raw > 0 ? raw : 6;
}

/** Per-fork vitest heap budget (GiB) — one fork's `--max-old-space-size` worth. */
const CHECKPOINT_FORK_HEAP_G = 4;

/** Fixed scope overhead (GiB): tsx/npm plus the testcontainers helpers, and headroom. */
const CHECKPOINT_SCOPE_OVERHEAD_G = 8;

/** Vitest fork count per capacity mode. MUST track `GREEN_CHECKPOINT_MAX_FORKS` /
 * `GREEN_CHECKPOINT_RESERVED_MAX_FORKS` in apps/operator/lib/release/green-checkpoint.ts.
 * Duplicated rather than imported because operator-core is the LOWER layer; the
 * release-actions-memory-cap test pins these values to the real constants. */
export const CHECKPOINT_FORKS_BY_MODE = { shared: 2, reserved: 8 } as const;

/** Memory cap (GiB) for an isolated green-checkpoint scope.
 *
 * Derive the cap from the fork count so the scheduled gate and detached manual
 * launcher share one policy. The cap keeps a suite's reclaim/OOM inside its own
 * cgroup instead of allowing it to pressure the operator host. */
export function checkpointScopeMemoryMaxG(env: NodeJS.ProcessEnv = process.env): number {
  const mode = env.PAPERCUSP_GREEN_CHECKPOINT_CAPACITY_MODE === 'reserved' ? 'reserved' : 'shared';
  return CHECKPOINT_SCOPE_OVERHEAD_G + CHECKPOINT_FORKS_BY_MODE[mode] * CHECKPOINT_FORK_HEAP_G;
}

/** A green command that runs the Papercusp Vitest fork runner (the suite the fork heaps model). */
const VITEST_FORK_SUITE_RE = /\btest:affected\b|\bvitest\b/;

/**
 * Memory cap (GiB) for one install's green-checkpoint scope, sized by the suite it runs
 * (WI-10006274). The fork-derived cap models the Papercusp Vitest affected runner; an install
 * whose green command runs anything else (a foreign pot's `npm test` running node:test, a build)
 * has no Vitest fork heaps, so it requests the scope overhead alone. `greenCmd` is the routing
 * overlay's command; null/undefined means the install runs the operator-home default suite.
 */
export function checkpointScopeMemoryMaxGForGreenCmd(
  greenCmd: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (greenCmd == null || greenCmd.trim() === '' || VITEST_FORK_SUITE_RE.test(greenCmd)) {
    return checkpointScopeMemoryMaxG(env);
  }
  return CHECKPOINT_SCOPE_OVERHEAD_G;
}

/**
 * Swap policy for a transient scope. Choose by what the payload IS, not by habit.
 *
 * `'deny'` (MemorySwapMax=0) is correct ONLY for a long-lived process whose event loop the
 * rest of the system waits on. There, swap-thrash IS the freeze: the bg-host incident
 * (WI-1086, 2026-06-30) measured a 68 GB thrash producing ~100s page-in stalls that froze
 * routinesTick/git-sync into an ~11min restart loop, so a clean hard-recycle at MemoryMax
 * genuinely beat paging. That reasoning is about a SHARED ORCHESTRATOR — not about memory.
 *
 * `'allow'` is correct for a WORKER: an agent session, a spawned job. Nothing blocks on its
 * event loop, so if it exceeds its budget the right outcome is that it gets SLOWER, not that
 * it dies. Denying swap on a worker converts ordinary memory pressure into an OOM kill even
 * when the host has terabytes of free swap — measured 2026-08-24 at 1.87 TB free while agent
 * scopes were being killed at a 6 GiB cap, with 7 of 74 scopes sitting at exactly 6.0 GiB
 * (i.e. cap-bounded, not demand). That is the WI-41206 defect: this policy was mirrored from
 * bg-host onto agent scopes, where the analogy does not hold.
 *
 * MemoryMax stays in BOTH cases as the per-payload runaway backstop. This changes only what
 * happens when a payload reaches it: page, or die.
 */
export type ScopeSwapPolicy = 'allow' | 'deny';

/** Build the systemd-run argv that runs `base` in a transient user SCOPE with its own
 *  memory cap. `--scope` (NOT `--unit`): the payload stays OUR CHILD — stdio piped,
 *  process-group kill + full env inheritance intact — but lands in its own cgroup
 *  OUTSIDE the launching service's MemoryMax.
 *
 *  `swap` defaults to 'allow' (WI-41206): the dominant caller here is a worker scope, and a
 *  worker should page rather than be killed. A caller whose payload is a shared orchestrator —
 *  or a known leaker whose thrash would wedge the box — opts into 'deny' EXPLICITLY, so that
 *  choice is visible at the call site instead of silently inherited. */
export function buildIsolatedScopeArgv(
  base: string[],
  memoryMaxG: number,
  swap: ScopeSwapPolicy = 'allow',
  runtimeMaxSec: number | null = null,
  unit: string | null = null,
): string[] {
  return [
    'systemd-run',
    '--user',
    '--scope',
    '--quiet',
    ...SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS,
    ...(unit ? [`--unit=${unit}`] : []),
    `--property=MemoryMax=${memoryMaxG}G`,
    ...(swap === 'deny' ? ['--property=MemorySwapMax=0'] : []),
    // EI-22129539141207312 — the LAST-RESORT wall. Every other bound on a scoped run
    // lives inside a process that can die before it fires, which is not a theoretical
    // ordering worry: all three were defeated at once by one run, measured resident 29h.
    //   · the payload's in-process self-watchdog is a setTimeout on the Node event loop,
    //     so a main thread blocked in a synchronous native call (futex) never runs it;
    //   · the launching routine parent's kill-timer dies with that parent, and this
    //     scope is DESIGNED to outlive it (see release-actions' own note);
    //   · the bash wrapper's EXIT trap only runs once the payload exits, which is
    //     exactly what a wedged payload never does.
    // systemd owns none of those failure modes, which is the whole point — and this
    // file already says so for the NAMED variant: a RuntimeMaxSec "is enforced by
    // systemd even if the operator dies, which a timer of ours could never promise".
    // Pass a bound STRICTLY ABOVE the caller's in-band chain so it can only ever catch
    // a run that has defeated every in-band mechanism; null keeps the historical
    // unbounded behaviour for callers with their own supervision.
    ...(runtimeMaxSec != null ? [`--property=RuntimeMaxSec=${runtimeMaxSec}`] : []),
    ...base,
  ];
}

/**
 * The NAMED variant (task-manager-no-escape-2026-07-27, P-005).
 *
 * Same mechanism as {@link buildIsolatedScopeArgv} — a transient `--scope`, so the
 * payload stays our child with stdio piped — but with the two additions the task
 * manager is built on:
 *
 *   `--unit=<name>`   the scope carries the LEDGER KEY in its own name, which is
 *                     what turns reconciliation into a string join instead of a
 *                     cmdline heuristic, and what makes a subtree kill addressable
 *                     (`systemctl --user kill <unit>`) without ever touching a pid.
 *   `--slice=<name>`  everything we launch lands under one root slice, so the
 *                     scanner can enumerate ALL descendants — including grandchildren
 *                     that double-forked and reparented — by walking one cgroup tree.
 *
 * Budgets are per-scope systemd properties rather than anything we police: a
 * `RuntimeMaxSec` deadline is enforced by systemd even if the operator dies, which
 * a timer of ours could never promise.
 */
export interface TaskScopeProperties {
  unit: string;
  slice: string;
  /** Environment explicitly bound to a transient SERVICE. A service is not a
   * child of the launching process, so it cannot inherit the caller's env. */
  env?: Readonly<Record<string, string | undefined>>;
  memoryMaxBytes?: number | null;
  cpuWeight?: number | null;
  tasksMax?: number | null;
  runtimeMaxSec?: number | null;
  /**
   * Garbage-collect failed units immediately (default true).
   *
   * Task-manager callers set this false: a failed unit is the only durable
   * source of `Result=oom-kill|timeout|exit-code`, ExecMainStatus, MemoryPeak,
   * and InvocationID. The task writer snapshots those properties, persists them
   * in `task_ledger`, then calls `reset-failed`, so retention is bounded by the
   * writer rather than lost before it can observe the cause.
   */
  collectFailedUnit?: boolean;
  /**
   * EI-21229453838112711 — the directory the PAYLOAD runs in. Only a transient
   * SERVICE needs this. A `--scope` payload is forked from the systemd-run
   * client and inherits its cwd, so the scope path is already correct and
   * deliberately ignores this field; a service is started by the user manager
   * instead, whose WorkingDirectory defaults to $HOME. Spawning with
   * `{ cwd }` sets it for the systemd-run CLIENT and has no effect on a service
   * payload, so without this the job silently runs in the home directory.
   */
  workingDirectory?: string | null;
  /** WI-41206: swap policy for this task's cgroup. Defaults to 'allow' — a task that reaches
   *  its MemoryMax should PAGE, not be OOM-killed. Pass 'deny' only for a payload whose
   *  thrashing would wedge something the whole system waits on. See {@link ScopeSwapPolicy}. */
  swap?: ScopeSwapPolicy;
  /** Extra `--property=K=V` pairs; escape hatch for a one-off, kept last. */
  extraProperties?: readonly string[];
}

function appendTaskProperties(argv: string[], props: TaskScopeProperties): void {
  if (props.memoryMaxBytes && props.memoryMaxBytes > 0) {
    // MemoryPeak is a terminal fact only when accounting is explicitly enabled.
    // This is what lets the task ledger distinguish a cgroup-cap OOM from an
    // unrelated signal after the cgroup directory itself has disappeared.
    argv.push('--property=MemoryAccounting=yes');
    argv.push(`--property=MemoryMax=${Math.floor(props.memoryMaxBytes)}`);
    // WI-41206: defaults to 'allow'. This used to hardcode MemorySwapMax=0 on the reasoning
    // that "swap-thrash IS the event-loop freeze" — true of the bg-host ORCHESTRATOR that
    // reasoning came from (WI-1086), false of a task scope, which nothing waits on. A task at
    // its cap should page and finish slowly, not be OOM-killed on a host with free swap.
    // See {@link ScopeSwapPolicy}; MemoryMax above is still the runaway backstop.
    if ((props.swap ?? 'allow') === 'deny') argv.push('--property=MemorySwapMax=0');
  }
  if (props.cpuWeight && props.cpuWeight > 0) {
    argv.push(`--property=CPUWeight=${Math.floor(props.cpuWeight)}`);
  }
  if (props.tasksMax && props.tasksMax > 0) {
    argv.push(`--property=TasksMax=${Math.floor(props.tasksMax)}`);
  }
  if (props.runtimeMaxSec && props.runtimeMaxSec > 0) {
    argv.push(`--property=RuntimeMaxSec=${Math.floor(props.runtimeMaxSec)}`);
  }
  for (const p of props.extraProperties ?? []) argv.push(`--property=${p}`);
}

/**
 * The task's own wall-clock deadline, exported INTO the payload as absolute epoch ms.
 *
 * ── WHY (WI-1639265, measured 2026-08-31) ───────────────────────────────────
 *
 * `RuntimeMaxSec` above is a systemd PROPERTY: the manager enforces it and the
 * payload never learns of it. A payload that schedules its own work against an
 * internal budget therefore admits work it has no time left to finish, and is
 * SIGKILLed part-way through with no verdict of its own. Every liveness probe
 * reads that as a hang rather than as a deadline, which is what makes it
 * expensive — the measured case was a `test:affected` run whose 45-minute
 * shared-admission QUEUE budget is a fixed internal constant that knows nothing
 * about the caller's wall clock.
 *
 * ABSOLUTE, never a duration: a duration restarts at every hop that re-reads it,
 * and the whole point is that the clock has been running since the unit started.
 *
 * A payload that finds this variable should treat it as an upper bound it may
 * only ever tighten. Inheriting an OUTER task's deadline is correct — a child
 * cannot outlive the scope that contains it.
 */
export const TASK_DEADLINE_EPOCH_MS_ENV = 'PAPERCUSP_TASK_DEADLINE_EPOCH_MS';

/**
 * The deadline env for a task, or an EMPTY object when the task carries no
 * `RuntimeMaxSec`. Empty is the honest answer for an unbounded task: an absent
 * variable means "no deadline was set", which a reader can distinguish from a
 * deadline it simply has not reached.
 */
export function taskDeadlineEnv(
  runtimeMaxSec: number | null | undefined,
  nowMs: number = Date.now(),
): Record<string, string> {
  if (typeof runtimeMaxSec !== 'number' || !Number.isFinite(runtimeMaxSec) || runtimeMaxSec <= 0) return {};
  return {
    [TASK_DEADLINE_EPOCH_MS_ENV]: String(Math.floor(nowMs) + Math.floor(runtimeMaxSec) * 1000),
  };
}

/**
 * Wrap a payload so it runs under EXACTLY `env`, independently of the environment
 * the `systemd-run` client itself needs (WI-40906).
 *
 * ── WHY THIS EXISTS (measured 2026-08-23) ───────────────────────────────────
 *
 * A `--scope` payload is forked from the systemd-run client, so it inherits the
 * client's environment. That made `spawn(systemd-run …, { env })` look like it
 * set the payload's env — and it does — but it sets the CLIENT's too, and the
 * client needs its own env to work at all: `systemd-run --user` reaches the user
 * manager over `$DBUS_SESSION_BUS_ADDRESS`. Hand it an env that points that
 * variable somewhere else and the launch dies before the payload ever execs:
 *
 *     Failed to start transient scope unit:
 *       The name org.freedesktop.systemd1 was not provided by any .service files
 *
 * That is not a hypothetical. A sandbox desktop publishes its own accessibility
 * bus and hands apps `DBUS_SESSION_BUS_ADDRESS` for it; every GUI app launched
 * into such a desktop therefore failed to start, silently — the caller passes
 * `stdio: 'ignore'`, so the message above went nowhere and `managedSpawn`
 * returned a healthy-looking handle for a process that had never run. It reads as
 * "the app doesn't work on this desktop", which is why it cost a day to find.
 *
 * BE PRECISE ABOUT WHICH ENVS BREAK IT, because the obvious generalisation is wrong
 * and would send the next reader hunting for the wrong thing (all measured here):
 *
 *   DBUS_SESSION_BUS_ADDRESS unset, XDG_RUNTIME_DIR kept  -> WORKS. systemd falls
 *       back to $XDG_RUNTIME_DIR/bus, so merely stripping the variable is safe.
 *       This is why `scrubExecEnv` callers (pty, capability jobs) never hit it.
 *   DBUS_SESSION_BUS_ADDRESS pointed elsewhere            -> FATAL, message above.
 *       A redirect defeats the fallback: the address is present and wrong.
 *   both unset                                            -> FATAL, but a DIFFERENT
 *       message ("Failed to connect to bus: No medium found").
 *
 * So the hazard is a REDIRECTED bus, not a thin env. The fix still belongs here
 * rather than in the one caller that redirects today: run the client with the
 * operator's own environment, and give the payload its exact env through an
 * anonymous fd that never puts values in argv or a journal-visible property.
 * Measured: the payload still lands in its own scope cgroup, so confinement is
 * unaffected.
 *
 * Semantics match `child_process.spawn({ env })` deliberately — total
 * replacement, not a merge, and `undefined` values are dropped — because callers
 * reach this path by passing exactly that option and must not get a second,
 * subtly different env model depending on whether confinement happened to be
 * available.
 */
export function buildExactEnvPayload(base: readonly string[], env: NodeJS.ProcessEnv): string[] {
  return buildExactEnvPayloadWithTransport(base, env).argv;
}

export interface BuiltTaskArgv {
  argv: string[];
  transport: SecretEnvironmentTransport | null;
}

function buildTaskArgv(base: string[], props: TaskScopeProperties, kind: 'scope' | 'service'): BuiltTaskArgv {
  // A transient SERVICE is parsed by systemd's ExecStart machinery, unlike a
  // transient SCOPE whose payload is forked from this process. Keep the scope
  // path byte-for-byte compatible while protecting every service payload arg.
  const payloadBase = kind === 'service' ? base.map(escapeSystemdServiceArgument) : base;
  // WI-1639265: fold the deadline into the env the caller already supplied, rather than
  // synthesizing one. `buildExactEnvPayload` is TOTAL REPLACEMENT, so manufacturing an env
  // where the caller passed none would strip the payload's whole environment down to this
  // one variable — a far worse bug than the one being fixed. The envless cases are covered
  // where they can be reached instead: a SERVICE takes `--setenv` below, and an envless
  // SCOPE payload is forked from the systemd-run client, so its deadline rides the client's
  // env at the launch site (see managed-spawn.ts).
  const deadlineEnv = taskDeadlineEnv(props.runtimeMaxSec);
  const payloadEnv = props.env ? { ...props.env, ...deadlineEnv } : null;
  const payload = payloadEnv
    ? kind === 'service'
      ? buildServiceEnvPayloadWithTransport(payloadBase, payloadEnv)
      : buildExactEnvPayloadWithTransport(payloadBase, payloadEnv)
    : null;
  const argv = [
    'systemd-run',
    '--user',
    ...(kind === 'scope' ? ['--scope'] : ['--pipe', '--wait']),
    '--quiet',
    ...(props.collectFailedUnit === false ? [] : SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS),
    `--unit=${props.unit}`,
    `--slice=${props.slice}`,
  ];
  if (kind === 'service') {
    argv.push(
      // EI-21192501620501693: keep the whole transient service cgroup reaped.
      '--property=KillMode=control-group',
      '--property=TimeoutStopSec=10s',
    );
  }
  // WI-1639265: a transient SERVICE is started by the user manager and inherits nothing, so
  // `--setenv` is the established way to reach its payload — six sibling launchers already
  // pass gate/watchdog variables exactly like this. Only when there is NO exact-env payload:
  // the env runner replaces the environment wholesale, so a `--setenv` beside it would be
  // silently dropped. Deliberately not emitted for a `--scope`: that payload is forked from
  // the systemd-run client rather than started by the manager, `--setenv` is documented for
  // the service case, and a flag this launcher rejected would fail EVERY confined spawn on
  // the host. The scope path is covered at its launch site instead.
  if (kind === 'service' && !payloadEnv) {
    for (const [name, value] of Object.entries(deadlineEnv)) argv.push(`--setenv=${name}=${value}`);
  }
  if (kind === 'service' && props.workingDirectory) {
    argv.push(`--working-directory=${props.workingDirectory}`);
  }
  if (payload?.credentialProperty) argv.push(payload.credentialProperty);
  appendTaskProperties(argv, props);
  argv.push(...(payload?.argv ?? payloadBase));
  return { argv, transport: payload?.transport ?? null };
}

export function buildTaskScopeArgvWithTransport(base: string[], props: TaskScopeProperties): BuiltTaskArgv {
  return buildTaskArgv(base, props, 'scope');
}

export function buildTaskScopeArgv(base: string[], props: TaskScopeProperties): string[] {
  return buildTaskScopeArgvWithTransport(base, props).argv;
}

/**
 * Build a named transient SERVICE argv. systemd-run uses service mode by
 * default, so there is intentionally no `--service` flag: on the supported CLI
 * that token is parsed as the `--service-type` abbreviation and makes launch
 * fail. `--pipe --wait` preserves the synchronous seam's stdio/exit contract
 * while the service unit remains owned by the user manager if this client dies.
 */
export function buildTaskServiceArgv(base: string[], props: TaskScopeProperties): string[] {
  return buildTaskServiceArgvWithTransport(base, props).argv;
}

export function buildTaskServiceArgvWithTransport(base: string[], props: TaskScopeProperties): BuiltTaskArgv {
  return buildTaskArgv(base, props, 'service');
}
