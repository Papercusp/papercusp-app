/**
 * systemd-service-probe — read a `--user` service's REAL "how many seconds ago
 * did its MAIN process start", straight from the OS, for dev:restart's
 * coalesce-truth check (EI-11137).
 *
 * The bug this exists to kill: dev:restart's cooldown lock-marker alone is NOT
 * proof that a restart actually happened. A marker can be held while NO real
 * restart occurred — a withheld/failed restart, or a stale marker that on a
 * busy fleet is perpetually re-observed — and the old code returned
 * `coalesced:true` ("a peer already restarted it, probe directly") on pure
 * trust of that marker. Net effect: EVERY subsequent bg-host restart was
 * silently suppressed for the marker's TTL, so bg-host code fixes never went
 * live (it re-bundles the working tree ONLY on restart). We now cross-check the
 * marker against this ground truth before coalescing.
 *
 * Implementation: MainPID/LoadState/ActiveState via `systemctl --user show`,
 * elapsed seconds via `ps -o etimes=`. That is robust across locales/TZ — unlike parsing systemd's
 * locale-formatted ExecMainStartTimestamp string — and is the same primitive
 * probeBgHostCodeDrift (service-health.ts) already relies on. Fail-soft: any
 * error, or a non-linux host, returns { ok:false } so the caller falls back to
 * marker-trust rather than crashing the restart path.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  gitSidecarEnabled,
  isSidecarInfrastructureFault,
  noteSidecarFallback,
  runCommandViaSpawnerSidecar,
} from '../../fleet/git-via-sidecar';

const run = promisify(execFile);

/** Per-site override for {@link execProbeCommand}'s sidecar route (`0` = force local). */
export const SYSTEMD_PROBE_SIDECAR_VAR = 'PAPERCUSP_SYSTEMD_PROBE_SPAWN_SIDECAR';

export interface ExecProbeCommandDeps {
  sidecarEnabled?: () => boolean;
  viaSidecar?: typeof runCommandViaSpawnerSidecar;
  local?: (command: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string }>;
}

/**
 * Run one probe subprocess (`systemctl` / `ps`) with execFile semantics — resolve
 * `{ stdout }` on exit 0, REJECT otherwise — routed through the spawner sidecar
 * where the host has one (WI-10002709).
 *
 * Why: this probe runs on the request operator's hot path (dev:pipeline_position's
 * `serving` leg, dev:restart's coalesce check, dev:service_health). A local
 * `execFile` from a ~2 GB :3070 cluster worker blocks the event loop ~240 ms per
 * spawn for the fork alone, and probeServiceStart pays two (systemctl + ps) —
 * measured as ~25% of main-thread samples in one sentinel window. The sidecar's
 * fork is cheap and the caller pays only a socket round-trip.
 *
 * A transport failure or a sidecar-infrastructure fault falls back to the local
 * spawn (counted via noteSidecarFallback, which also feeds the circuit breaker),
 * so a sick sidecar degrades latency, never the probe's answer.
 */
export async function execProbeCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  deps: ExecProbeCommandDeps = {},
): Promise<{ stdout: string }> {
  const sidecarEnabled = deps.sidecarEnabled ?? (() => gitSidecarEnabled(SYSTEMD_PROBE_SIDECAR_VAR));
  if (sidecarEnabled()) {
    let res: Awaited<ReturnType<typeof runCommandViaSpawnerSidecar>> | null = null;
    try {
      res = await (deps.viaSidecar ?? runCommandViaSpawnerSidecar)(command, args, { timeoutMs });
    } catch (e) {
      noteSidecarFallback('systemd-service-probe', e);
    }
    if (res && isSidecarInfrastructureFault(res)) {
      noteSidecarFallback('systemd-service-probe', new Error(res.stderr));
      res = null;
    }
    if (res) {
      if (res.code !== 0) {
        throw new Error(`${command} ${args.join(' ')} exited ${res.code} (via spawner sidecar): ${res.stderr.trim()}`);
      }
      return { stdout: res.stdout };
    }
  }
  const local = deps.local ?? ((c: string, a: string[], o: { timeout: number }) => run(c, a, o));
  const { stdout } = await local(command, args, { timeout: timeoutMs });
  return { stdout };
}

export interface ServiceStartInfo {
  /** false ⇒ could not determine (no systemd / non-linux / probe error) —
   *  the caller should fall back to trusting the lock marker. */
  ok: boolean;
  /** the service's current MainPID; 0 when systemd reports no live main process.
   *  Undefined for a unit TYPE that has no MainPID concept at all (a `.timer`
   *  — see `activeState` for that case). */
  mainPid?: number;
  /** seconds since the current MainPID started; undefined when there is no live
   *  main process to measure (mainPid 0 or absent). */
  secondsSinceStart?: number;
  /**
   * EI-20093902925801178: systemd's own `NRestarts` — the monotonic count of
   * restarts systemd has performed for this unit under its `Restart=` policy.
   * Read from the SAME `systemctl show` call as `MainPID`/`ActiveState`, so it
   * costs no extra subprocess.
   *
   * This is ground truth that no sampling interval can miss, which is the whole
   * point: the supervision reconciler's in-memory flap counters are written by a
   * routine in `papercup-bg-host` but READ by `dev:service_health` in the
   * operator process, where that Map is permanently empty — so every supervised
   * unit reports `restartsLast10m: 0, flapState: 'ok'` regardless of reality.
   * Measured 2026-08-10: 4 restarts in 43s while the health tool read zero.
   *
   * Undefined when systemd did not report the property (a `.timer` and other
   * unit types with no main process omit it). An omitted counter is UNKNOWN,
   * never `0` — conflating them is the exact bug this field exists to kill.
   */
  nRestarts?: number;
  /**
   * WI-10550: EXACT epoch-ms at which the current MainPID started, read straight
   * from `/proc/<MainPID>` mtime. Undefined when there is no live main process,
   * or the read failed (never a fabricated value — the caller falls back).
   *
   * PREFER THIS over deriving `Date.now() - secondsSinceStart * 1000`. That
   * derivation carries two errors which bias the SAME way, so they add rather
   * than cancel: `ps -o etimes=` truncates elapsed to whole seconds (understating
   * elapsed, so the start looks LATER), and the caller's `Date.now()` is sampled
   * after this function's subprocesses return (later still — measured at 0.6-0.76s
   * on this host under memory pressure). For the comparison this feeds — "did the
   * process start AFTER the code changed?" — a start that looks later biases the
   * answer toward a false confident YES, which is worse than no answer.
   *
   * WHY `/proc` mtime is genuinely process-START and not access-time (the obvious
   * worry, which "the value is stable across two reads" does NOT rule out, since a
   * latched first-access is also stable): mtime minus the kernel's own field-22
   * start is CONSTANT at +0.2518 / +0.2570 / +0.2556s across three units aged
   * 0.11h, 3.99h and 8.22h. An access-derived mtime would drift with age; a
   * constant to sub-millisecond places the discrepancy in `btime` — an
   * integer-second field in /proc/stat — not in mtime. That also makes mtime the
   * BETTER of the two: field-22 arithmetic inherits btime's truncation, needs
   * USER_HZ, and costs a second file parse.
   */
  startedAtMs?: number;
  /**
   * EI-18700974567040702: raw systemd `ActiveState`
   * (active/inactive/failed/activating/deactivating/reloading) — the UNIVERSAL
   * liveness signal, unlike `MainPID`: every systemd unit TYPE reports it,
   * including a `.timer` (which has no main process to report a PID for at
   * all — `systemctl show -p MainPID` simply OMITS that line for one, it is
   * not printed as `0`). Undefined only when `ok` is false.
   */
  activeState?: string;
  /**
   * EI-210532: raw systemd `LoadState` (`loaded`, `not-found`, `masked`, …).
   * `ActiveState=inactive` is also emitted for a unit with `LoadState=not-found`,
   * so callers must read this before treating `activeState` as a real service
   * liveness measurement.
   */
  loadState?: string;
  /**
   * EI-210532: whether systemd knows this unit (`loadState === 'loaded'`).
   * False means the unit is absent or otherwise not loaded; it is deliberately
   * separate from `activeState`, whose default `inactive` is not evidence that
   * an absent unit is down.
   */
  known?: boolean;
  /**
   * WI-20039196108947848: systemd's persisted enablement state. `disabled` and
   * `masked` mean the unit was intentionally paused; unlike `ActiveState`, this
   * field distinguishes that choice from an enabled unit that stopped running.
   */
  unitFileState?: string;
  /**
   * systemd's last unit result (`success`, `exit-code`, `start-limit-hit`, …).
   * `start-limit-hit` is a latched manager failure: a later `restart` is still
   * refused until `reset-failed` clears it.
   */
  result?: string;
}

/** systemd unit-type suffixes this probe recognizes as already-complete — anything
 *  else is assumed a bare service name and gets `.service` appended (the historical
 *  default `dev:restart`'s targets rely on). Recognizing `.timer` (and siblings) here
 *  matters: the OLD unconditional-unless-`.service` rule mangled
 *  `papercup-live-federation-gate.timer` into `papercup-live-federation-gate.timer.service`
 *  — a unit that does not exist, so systemctl silently reported MainPID=0 for a healthy,
 *  `active`/`waiting` timer, and nobody could see it because that same 0 was previously
 *  indistinguishable from a probe failure (the exact defect this file's other fix kills). */
const KNOWN_UNIT_SUFFIXES = /\.(service|socket|device|mount|automount|swap|target|path|timer|slice|scope)$/;

/**
 * PURE — the unit-type-suffix decision, split out so the exact `.timer`
 * mangling bug (EI-18700974567040702) is directly unit-testable without
 * mocking `child_process`. Exported for `systemd-service-probe.test.ts`.
 */
export function resolveUnitName(unit: string): string {
  return KNOWN_UNIT_SUFFIXES.test(unit) ? unit : `${unit}.service`;
}

/**
 * PURE — parse `systemctl show` KEY=VALUE output (NOT `--value`, see the call
 * site's comment for why) into a lookup map. A property systemd considers
 * inapplicable to the queried unit's TYPE (MainPID on a `.timer`) is simply
 * absent as a key, never an empty string. Split out for direct unit testing.
 */
export function parseSystemctlShowOutput(stdout: string): Map<string, string> {
  const props = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    props.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return props;
}

/**
 * PURE — the systemd state fields shared by every `probeServiceStart` return
 * path. Keeping LoadState beside ActiveState prevents the `not-found` /
 * `inactive` pair from being silently reduced to a false outage verdict.
 */
export function serviceStartStateFromProps(
  props: Map<string, string>,
): Pick<ServiceStartInfo, 'activeState' | 'loadState' | 'known' | 'unitFileState' | 'result'> {
  const activeState = props.get('ActiveState');
  const loadState = props.get('LoadState');
  const unitFileState = props.get('UnitFileState');
  const result = props.get('Result');
  return {
    ...(activeState === undefined ? {} : { activeState }),
    ...(loadState === undefined ? {} : { loadState, known: loadState === 'loaded' }),
    ...(unitFileState === undefined ? {} : { unitFileState }),
    ...(result === undefined ? {} : { result }),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Arbitrary-unit state query (bash-to-tool-substitution-2026-07-26, P-014).
 *
 * WHY THIS EXISTS, measured rather than assumed: `dev:service_health` answers
 * "is it up" only for the units in its own fixed registry, and the corpus says
 * that is not the question agents ask. Of 114 `systemctl is-active|is-failed`
 * atoms in the 7d window (23 sessions), 50 name a unit the registry cannot
 * reach — a transient `papercup-green-checkpoint-manual-<rand>` scope, a
 * timer-driven oneshot, a SYSTEM-scope unit (`auditd`, `ufw`, `pgbouncer`), or
 * a unit that does not exist at all. Narrowing the substitution pattern to the
 * registry instead leaves 19 distinct shapes — below the harness's
 * MIN_SAMPLE_SIZE — so the pattern could not have earned a verdict either way.
 * The tool had to widen.
 *
 * ⚠ THE DEFECT THIS FIXES IS NOT COVERAGE, IT IS A WRONG ANSWER. `systemctl
 * is-active <unit-that-does-not-exist>` prints `inactive` and exits 4. Three
 * units in the corpus — `papercup-auto-deploy`, `papercup-green-checkpoint`,
 * `papercup-pgbouncer` — are LoadState=not-found in BOTH scopes on this host,
 * and every atom querying them captured stdout (`2>&1` / `2>/dev/null`) without
 * reading the exit code. So an agent asked about a phantom unit and read back
 * "inactive": byte-identical to a real service that is stopped. That is the
 * same class as `logs:read`'s `unitsUnknown` (a typo'd unit is byte-identical
 * to a healthy silent one) and as `dev:listening_ports`' `ownerVisible` — ABSENT
 * EVIDENCE MUST NEVER READ AS EVIDENCE OF ABSENCE. `known` is the field that
 * separates them, and `unitsUnknown` is what surfaces it without being read.
 *
 * ⚠ SCOPE IS THREE-VALUED, NOT A BOOLEAN, for the reason `logs:read` learned the
 * hard way: `--user` and `--system` are different journals/managers, and a unit
 * absent from one is simply not there. A boolean would force a caller asking
 * about `auditd` (system) and `papercup-dev-api` (user) in one breath to pick a
 * manager that cannot hold half the answer, and get a confident `not-found`.
 * `'all'` queries both and merges.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Which systemd manager to ask. `all` asks both and merges. */
export type SystemdScope = 'user' | 'system' | 'all';

/** One unit's state as systemd reports it. */
export interface UnitState {
  /** The resolved unit name (`.service` appended when no unit-type suffix was given). */
  unit: string;
  /** The manager that answered. */
  scope: 'user' | 'system';
  /**
   * systemd's `LoadState` — `loaded` | `not-found` | `masked` | `error` | `bad-setting`.
   * THE field that separates "stopped" from "never heard of it".
   */
  loadState: string;
  /** systemd's `ActiveState` verbatim: active | activating | inactive | deactivating | failed | reloading. */
  activeState: string;
  /** systemd's `SubState` (running/dead/exited/waiting/…) — the detail behind ActiveState. */
  subState?: string;
  /**
   * `loadState === 'loaded'`. FALSE means systemd has no such unit, and
   * `activeState` on such a row is a systemd default (`inactive`), NOT a
   * measurement — never read it as "the service is down".
   */
  known: boolean;
  /** `activeState === 'active'` — the literal `systemctl is-active` answer, for a KNOWN unit only. */
  active: boolean;
  /** `activeState === 'failed'` — the literal `systemctl is-failed` answer. */
  failed: boolean;
  /**
   * EI-20093902925801178: systemd's OWN `NRestarts` — a monotonic count of the
   * restarts systemd has performed for this unit under its `Restart=` policy.
   *
   * This is the one restart signal that CANNOT be missed by sampling. The
   * supervision reconciler's in-memory flap state is written by a routine
   * running in `papercup-bg-host`, while `dev:service_health` reads that same
   * module's Map from the OPERATOR process — where it is permanently empty, so
   * every supervised unit reports all-zero counters and `flapState:'ok'`
   * whatever is actually happening. Reading the counter from the OS here is the
   * same ground-truth escape hatch `activeState` above already uses, and it is
   * immune to both the cross-process gap AND to a loop cycling faster than any
   * probe interval (measured: 4 restarts in 43s while the health tool read
   * `restartsLast10m: 0`).
   *
   * Undefined when systemd did not report the property — a `.timer` and other
   * unit types that run no main process omit it entirely, and an omitted
   * counter must never be read as `0` restarts.
   */
  nRestarts?: number;
}

/** What a unit-state query returns. */
export interface UnitStateResult {
  states: UnitState[];
  /**
   * Units NO queried scope has heard of. Present so a caller that never reads
   * `known` still cannot mistake a phantom unit for a stopped service — the
   * `logs:read` `unitsUnknown` contract, deliberately identical.
   */
  unitsUnknown: string[];
  /** Scopes that could not be queried at all (no systemd, non-linux, exec error). */
  scopesUnavailable: Array<'user' | 'system'>;
}

/** The properties one `systemctl show` call asks for. `Id` is what maps a block back to a unit. */
const UNIT_STATE_PROPS = ['Id', 'LoadState', 'ActiveState', 'SubState', 'NRestarts'] as const;

/**
 * PURE — split a multi-unit `systemctl show` stdout into one property map per
 * unit. systemd separates unit blocks with a BLANK LINE and names each with
 * `Id=`; a unit it has never heard of still gets a full block
 * (`LoadState=not-found`, `ActiveState=inactive`), which is exactly why the
 * caller must read `LoadState` and not `ActiveState`.
 *
 * Split out for direct unit testing — the blank-line framing is the one thing
 * that would silently mis-attribute every state to the wrong unit.
 */
export function parseMultiUnitShowOutput(stdout: string): Map<string, string>[] {
  const blocks: Map<string, string>[] = [];
  for (const block of stdout.split(/\n\s*\n/)) {
    if (!block.trim()) continue;
    const props = parseSystemctlShowOutput(block);
    if (props.size > 0) blocks.push(props);
  }
  return blocks;
}

/** PURE — one parsed `systemctl show` block to a `UnitState`. */
export function unitStateFromProps(props: Map<string, string>, scope: 'user' | 'system', fallbackUnit: string): UnitState {
  const loadState = props.get('LoadState') ?? 'error';
  const activeState = props.get('ActiveState') ?? 'inactive';
  const subState = props.get('SubState');
  // EI-20093902925801178: parse defensively. A property systemd considers
  // inapplicable to the unit TYPE is absent (never an empty string), and an
  // absent counter is UNKNOWN, not zero — collapsing the two would recreate
  // exactly the "no data rendered as healthy" bug this field exists to kill.
  // ⚠ An EMPTY value (`NRestarts=` with nothing after it — systemd really does
  // emit bare KEY= for some properties, per parseSystemctlShowOutput's own
  // tests) must be treated as ABSENT, not as zero. `Number('')` is 0, so a
  // naive parse turns "systemd told us nothing" into "measured zero restarts" —
  // the precise defect this field exists to eliminate. Caught by its own test.
  const rawNRestarts = props.get('NRestarts')?.trim();
  const parsedNRestarts = rawNRestarts ? Number(rawNRestarts) : Number.NaN;
  const nRestarts = Number.isInteger(parsedNRestarts) && parsedNRestarts >= 0 ? parsedNRestarts : undefined;
  return {
    unit: props.get('Id') ?? fallbackUnit,
    scope,
    loadState,
    activeState,
    ...(subState ? { subState } : {}),
    known: loadState === 'loaded',
    // A unit systemd does not know is never "active" — guard it here so a
    // caller reading `active` alone can't be misled either.
    active: loadState === 'loaded' && activeState === 'active',
    failed: activeState === 'failed',
    ...(nRestarts !== undefined ? { nRestarts } : {}),
  };
}

/** The exec seam, injectable so the whole path is testable without systemd. */
export type SystemctlExec = (args: string[]) => Promise<string>;

const defaultSystemctlExec: SystemctlExec = async (args) => {
  // `systemctl show` exits 0 even for a not-found unit, but a manager that is
  // entirely absent (no user bus) exits non-zero — execFile rejects there, and
  // the caller records the scope as unavailable rather than inventing states.
  const { stdout } = await execProbeCommand('systemctl', args, 5000);
  return stdout;
};

/**
 * Ask systemd for the state of arbitrary units — the tool form of
 * `systemctl [--user|--system] is-active|is-failed <unit>...`.
 *
 * ONE exec per scope regardless of unit count (`systemctl show` takes a unit
 * LIST), which is also why the multi-unit shape agents actually write
 * (`is-active papercup-dev-api papercup-staging-api`) is expressible here and
 * was not before.
 */
export async function probeUnitStates(
  units: string[],
  scope: SystemdScope = 'user',
  exec: SystemctlExec = defaultSystemctlExec,
): Promise<UnitStateResult> {
  const resolved = units.map(resolveUnitName);
  const scopes: Array<'user' | 'system'> = scope === 'all' ? ['user', 'system'] : [scope];
  const states: UnitState[] = [];
  const scopesUnavailable: Array<'user' | 'system'> = [];

  if (process.platform !== 'linux') {
    return { states: [], unitsUnknown: [], scopesUnavailable: scopes };
  }

  for (const s of scopes) {
    let stdout: string;
    try {
      stdout = await exec([
        s === 'user' ? '--user' : '--system',
        'show',
        ...UNIT_STATE_PROPS.flatMap((p) => ['-p', p]),
        ...resolved,
      ]);
    } catch {
      scopesUnavailable.push(s);
      continue;
    }
    const blocks = parseMultiUnitShowOutput(stdout);
    blocks.forEach((props, i) => states.push(unitStateFromProps(props, s, resolved[i] ?? resolved[0] ?? '')));
  }

  // Unknown EVERYWHERE, not merely in one scope: a unit that is `not-found`
  // under --user but `loaded` under --system is found, and reporting it as
  // unknown would recreate the very confusion this field exists to remove.
  const knownUnits = new Set(states.filter((st) => st.known).map((st) => st.unit));
  const unitsUnknown = resolved.filter((u) => !knownUnits.has(u));

  return { states, unitsUnknown, scopesUnavailable };
}

/**
 * PURE — pick the best available start-time source from a `ServiceStartInfo`,
 * exported (per this file's convention) so the PREFERENCE ORDER is directly
 * testable without mocking `child_process`. WI-10550.
 *
 * Order, and why it is not arbitrary:
 *   1. `startedAtMs` — measured, exact.
 *   2. `nowMs - secondsSinceStart * 1000` — DERIVED, and wrong in a specific
 *      direction. `etimes` truncates elapsed to whole seconds, and `nowMs` is
 *      read by the caller only after this module's subprocesses have returned.
 *      Both understate elapsed, so both make the start look LATER, and being
 *      biased the same way they add rather than cancel.
 *   3. `null` — UNKNOWN. Never a fabricated timestamp.
 *
 * That direction matters to the caller that motivated this: a start that looks
 * later makes "did this process start AFTER the code changed?" more likely to
 * answer YES, so the derivation's error pushes toward falsely asserting a
 * process runs code it does not. Prefer measured; degrade to UNKNOWN, not to a
 * confident wrong answer.
 */
export function resolveServiceStartMs(
  info: ServiceStartInfo,
  nowMs: number,
): { pid: number | null; startedAtMs: number | null } | null {
  if (!info.ok) return null;
  if (info.startedAtMs !== undefined) return { pid: info.mainPid ?? null, startedAtMs: info.startedAtMs };
  if (info.secondsSinceStart === undefined) return null;
  return { pid: info.mainPid ?? null, startedAtMs: nowMs - info.secondsSinceStart * 1000 };
}

/**
 * WI-10550: EXACT process start as epoch ms, from `/proc/<pid>` directory mtime.
 *
 * One stat syscall — no subprocess, so no fork/exec latency to be anchored
 * against; no locale parsing, unlike systemd's `ExecMainStartTimestamp` (the
 * documented reason this module reaches for `ps -o etimes=` in the first place,
 * see the file header); no USER_HZ and no `btime` truncation, unlike
 * `/proc/<pid>/stat` field 22.
 *
 * Returns null — never a guess — on any failure, including a non-Linux host and
 * the benign race where the pid exits between the systemctl read and this call.
 * Callers keep their existing fallback.
 */
async function readProcStartMs(pid: number): Promise<number | null> {
  try {
    const { stat } = await import('node:fs/promises');
    const st = await stat(`/proc/${pid}`);
    return Number.isFinite(st.mtimeMs) && st.mtimeMs > 0 ? st.mtimeMs : null;
  } catch {
    return null;
  }
}

/** The exec seam used by `probeServiceStart`; tests can avoid a real systemd. */
export type ServiceStartExec = (
  command: string,
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout: string }>;

const defaultServiceStartExec: ServiceStartExec = async (command, args, options) =>
  execProbeCommand(command, args, options.timeout);

export type SystemdDaemonReloadNeed = 'needed' | 'not-needed' | 'unknown';

/**
 * Ask systemd whether this unit's on-disk definition differs from the manager's
 * loaded copy. `daemon-reload` refreshes the whole user manager, so code-only
 * restarts must not invoke it when the unit files are already current.
 * Unknown is conservative: callers keep the existing reload behavior.
 */
export async function probeSystemdDaemonReloadNeed(
  unit: string,
  exec: ServiceStartExec = defaultServiceStartExec,
): Promise<SystemdDaemonReloadNeed> {
  if (process.platform !== 'linux') return 'unknown';
  try {
    const { stdout } = await exec(
      'systemctl',
      ['--user', 'show', '-p', 'NeedDaemonReload', resolveUnitName(unit)],
      { timeout: 3000 },
    );
    const value = parseSystemctlShowOutput(stdout).get('NeedDaemonReload')?.trim().toLowerCase();
    if (value === 'yes') return 'needed';
    if (value === 'no') return 'not-needed';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function probeServiceStart(
  unit: string,
  exec: ServiceStartExec = defaultServiceStartExec,
): Promise<ServiceStartInfo> {
  // Linux/systemd-only (a Windows desktop runs this sidecar under WSL, still
  // process.platform === 'linux', so it is NOT short-circuited — the try/catch
  // is the backstop for WSL-without-systemd).
  if (process.platform !== 'linux') return { ok: false };
  try {
    const svc = resolveUnitName(unit);
    const { stdout } = await exec(
      'systemctl',
      // EI-20093902925801178 / WI-20039196108947848: these properties ride along
      // on the EXISTING show call — no extra subprocess for restart history or
      // the persisted enablement state.
      [
        '--user',
        'show',
        '-p',
        'MainPID',
        '-p',
        'ActiveState',
        '-p',
        'LoadState',
        '-p',
        'UnitFileState',
        '-p',
        'Result',
        '-p',
        'NRestarts',
        svc,
      ],
      { timeout: 3000 },
    );
    const props = parseSystemctlShowOutput(stdout);
    const startState = serviceStartStateFromProps(props);
    const mainPidRaw = props.get('MainPID');
    // Parsed once and spread into EVERY return path below — a `.timer` and a
    // down unit have restart histories too, and dropping the counter on those
    // paths would reintroduce "absent reads as zero" for exactly the units whose
    // restarts matter most. Absent/unparseable stays undefined, never 0.
    // Empty-is-absent, for the same reason as unitStateFromProps above:
    // `Number('')` is 0, which would render "systemd said nothing" as a
    // measured zero.
    const nRestartsRaw = props.get('NRestarts')?.trim();
    const nRestartsNum = nRestartsRaw ? Number(nRestartsRaw) : Number.NaN;
    const restarts = Number.isInteger(nRestartsNum) && nRestartsNum >= 0 ? { nRestarts: nRestartsNum } : {};
    if (mainPidRaw === undefined) {
      // No MainPID property for this unit type at all (e.g. a `.timer`) —
      // ActiveState is the only signal available, and on its own it is a
      // complete, determinate answer (a timer never has a "recent restart").
      return { ok: true, ...startState, ...restarts };
    }
    const mainPid = Number(mainPidRaw);
    // MainPID 0 ⇒ systemd has no live main process (down / never started). That
    // is a determinate answer: there is NO recent restart to coalesce against.
    if (!Number.isFinite(mainPid) || mainPid <= 0) return { ok: true, mainPid: 0, ...startState, ...restarts };
    const { stdout: etimesOut } = await exec(
      'ps',
      ['-o', 'etimes=', '-p', String(mainPid)],
      { timeout: 3000 },
    );
    const etimes = Number(etimesOut.trim());
    // WI-10550: read the EXACT start alongside etimes. Independent of etimes'
    // whole-second truncation and of the caller's Date.now() anchor, so a caller
    // comparing "started after the code changed?" is not biased toward YES.
    // Fail-soft: null (⇒ field omitted) whenever /proc cannot answer, so the
    // caller's existing etimes fallback still applies.
    const startedAtMs = await readProcStartMs(mainPid);
    const exact = startedAtMs === null ? {} : { startedAtMs };
    if (!Number.isFinite(etimes) || etimes < 0) return { ok: true, mainPid, ...startState, ...exact, ...restarts };
    return { ok: true, mainPid, secondsSinceStart: etimes, ...startState, ...exact, ...restarts };
  } catch {
    return { ok: false };
  }
}
