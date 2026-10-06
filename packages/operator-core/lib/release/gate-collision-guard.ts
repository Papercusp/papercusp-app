/**
 * EI-19385475092979200 — refuse (softly) to restart a gate-critical shared host while a
 * green-checkpoint run is in flight or is about to be, but only when the live mechanism
 * evidence says the restart can actually reach that run.
 *
 * ## The hazard
 *
 * Restarting a shared host the gate's suite depends on — the embedding sidecar, the inference
 * gateway, the background routines host — can perturb a run. The concrete hard hazard is a
 * restart that shares the run's systemd cgroup and therefore terminates it; separate detached
 * checkpoint units do not have that KillMode=control-group reach. Even with separate cgroups,
 * ambient host load during boot remains a residual risk, so the guard says what it measured
 * instead of presenting every live lock as an abortable collision.
 *
 * ## Why `ps` is the wrong oracle (the near-miss this is built from)
 *
 * On 2026-08-02 an agent DID check for an in-flight run before restarting the sidecar — `ps`
 * at 23:14:43Z and again at 23:14:50Z, both clear. The hourly gate then fired at 23:15:02Z,
 * in the 45-second gap between the check and the action, and the restart landed 34 seconds
 * into a live run. A hand-run `ps` answers "is a run in flight RIGHT NOW", which is stale the
 * instant it returns, and it cannot see the one fact that would have prevented this: the gate
 * fires on a SCHEDULE, and `harness_shared.routines.next_fire_at` says exactly when.
 *
 * That is why the imminent-fire window here is DELIBERATELY TWO-SIDED. The reported incident
 * happened at :15:36 — i.e. 36 seconds AFTER the scheduled fire time, not before it. A guard
 * that only looked forward ("is a fire coming up?") would have sailed straight past the very
 * incident it exists to prevent. Looking behind also covers the genuine gap where the tick has
 * fired but the run process has not yet raced for the shared run-lock, during which BOTH the
 * lock probe and a forward-only schedule check read clear.
 *
 * ## Fail OPEN, always
 *
 * Every unknown resolves to "no collision". A restart wrongly REFUSED because of a stale lock
 * file, an unreadable routines row, or a missing module in a stripped bundle is worse than the
 * collision this guards against: a genuinely wedged sidecar during a ~55-minute run may
 * legitimately need restarting, and an agent that cannot restart it has no recourse inside the
 * tool. Same contract as {@link readInFlightRetriage} and `resolveDeadRoutineOverdueMs`.
 *
 * For the same reason a confirmed shared-cgroup collision is a SOFT block: the caller is
 * refused with the run's age and candidate, and told the exact override to re-call with. A
 * known detached sibling and an unknown cgroup relationship both fail open with an explicit
 * note rather than silently converting uncertainty into a refusal.
 *
 * Precedent for the shape: `release:checkpoint-run` was taught to read the `inFlightRetriage`
 * marker and refuse with `🚨 AUTO-REFIRE IN FLIGHT — STAND DOWN` (EI-19343516395023183). Same
 * problem, same solution, different verb — so this REUSES that module's reader rather than
 * standing up a third way to ask "what is the gate doing".
 */

import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { StoredInFlightRetriage } from './in-flight-retriage';
import { RESTART_TARGET_UNITS, type RestartTargetName } from '../agent-tools/dev/restart-target-units';
import { acquireWithContentionRetry } from '../agent-tools/locks/contention-retry';

let execFileAsync: ((...args: any[]) => Promise<any>) | undefined;
const runExecFile = (...args: any[]) => (execFileAsync ??= promisify(execFile) as any)(...args);

/**
 * The restart targets whose blast radius overlaps a green-checkpoint run's dependencies.
 *
 * NOT `dev` or `staging`: those are operator web hosts (:3070 / :3170). The gate runs its
 * suite in an isolated checkout and does not route through either, so guarding them would be
 * pure false-positive friction on the two targets restarted most often.
 */
export const GATE_SENSITIVE_RESTART_TARGETS = ['embed-sidecar', 'gateway', 'bg-host'] as const;

export type GateSensitiveTarget = (typeof GATE_SENSITIVE_RESTART_TARGETS)[number];

export function isGateSensitiveTarget(target: string): target is GateSensitiveTarget {
  return (GATE_SENSITIVE_RESTART_TARGETS as readonly string[]).includes(target);
}

/** How far AHEAD of a scheduled gate fire a restart is treated as colliding. */
export const IMMINENT_FIRE_LOOKAHEAD_SEC = 120;

/**
 * How far BEHIND a scheduled fire a restart is still treated as colliding — the window in
 * which the tick has fired but the run has not yet taken the shared run-lock, so the lock
 * probe reads clear while a run is in fact starting. The 2026-08-02 near-miss lived here
 * (:15:36, 36s past the fire), which is why this is not zero.
 */
export const IMMINENT_FIRE_LOOKBEHIND_SEC = 120;

/** Raw observations. Every field is independently nullable — a partial probe still judges. */
export interface GateCollisionProbe {
  /** True when a probe THREW. Distinct from "probed cleanly and found nothing". */
  probeFailed: boolean;
  /** The shared green-checkpoint run-lock, held by a process verified alive. */
  runLockHeld: boolean;
  /** Age of the run holding the lock, when known. */
  runElapsedSec: number | null;
  /** Verified PID that owns the run-lock, when the lock reader exposes it. */
  runLockPid?: number | null;
  /** Unified cgroup path of the checkpoint owner, when it can be read. */
  runLockCgroupPath?: string | null;
  /** Unified cgroup path systemd assigns to the restart target, when it can be read. */
  targetCgroupPath?: string | null;
  /** True when the cgroup comparison itself could not be completed. */
  cgroupProbeFailed?: boolean;
  /** Seconds until the next scheduled fire; NEGATIVE = that many seconds PAST it. */
  nextFireInSec: number | null;
  /** An auto-refire in flight — the strongest possible stand-down signal. */
  refire: StoredInFlightRetriage | null;
}

export type GateCollisionKind =
  /** The target cannot affect a gate run — never blocks. */
  | 'not-gate-sensitive'
  /** A probe threw; we do not know. Fails OPEN. */
  | 'probe-failed'
  /** Probed cleanly, nothing in flight, no fire imminent. */
  | 'clear'
  /** A run holds the shared run-lock right now. */
  | 'run-in-flight'
  /** A run is active, but its known systemd cgroup is separate from the target. */
  | 'run-in-flight-isolated'
  /** A run is active, but its cgroup relationship to the target is unknown. */
  | 'run-in-flight-unknown'
  /** No lock held, but a scheduled fire is within the two-sided window. */
  | 'imminent-fire';

export interface GateCollisionVerdict {
  /** The caller must REFUSE when true. Never true if `override` was passed. */
  blocked: boolean;
  kind: GateCollisionKind;
  /** A collision was found but waived by an explicit override. */
  overridden: boolean;
  /** Human-facing explanation — safe to put straight into a tool result. */
  note: string;
  detail: {
    runElapsedSec: number | null;
    nextFireInSec: number | null;
    refiringCandidate: string | null;
    refireAttempt: number | null;
    runLockPid: number | null;
    runLockCgroupPath: string | null;
    targetCgroupPath: string | null;
    cgroupRelation: GateRunCgroupRelation;
  };
}

export type GateRunCgroupRelation = 'same' | 'different' | 'unknown';

function humanizeSec(sec: number): string {
  const s = Math.abs(Math.round(sec));
  if (s < 90) return `${s}s`;
  return `${Math.round(s / 60)}min`;
}

function normalizeCgroupPath(value: string | null | undefined): string | null {
  const path = value?.trim();
  if (!path || !path.startsWith('/')) return null;
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/**
 * PURE — systemd's ControlGroup is the cgroup root for a unit, while a process may be in
 * that unit or in a child cgroup. Only a root/descendant relationship is a collision; sibling
 * transient units share parents but are deliberately independent for KillMode=control-group.
 * Missing paths are UNKNOWN, never same — the live guard fails open in that case.
 *
 * The legacy `undefined`/`undefined` case is retained for old injectable callers that only
 * supplied the original lock reader. Production probes populate both fields (or explicit nulls)
 * whenever they inspect a held lock, so an actual unreadable cgroup never takes this fallback.
 */
export function gateRunCgroupRelation(
  runCgroupPath: string | null | undefined,
  targetCgroupPath: string | null | undefined,
): GateRunCgroupRelation {
  if (runCgroupPath === undefined && targetCgroupPath === undefined) return 'same';
  const run = normalizeCgroupPath(runCgroupPath);
  const target = normalizeCgroupPath(targetCgroupPath);
  if (!run || !target) return 'unknown';
  const nested = (parent: string, child: string) => child === parent || child.startsWith(`${parent}/`);
  return nested(target, run) || nested(run, target) ? 'same' : 'different';
}

export interface ProcessCgroupObservation {
  /** false is reserved for a provably absent /proc row; null means unreadable. */
  alive: boolean | null;
  cgroupPath: string | null;
}

function defaultReadProcessObservation(pid: number): ProcessCgroupObservation {
  try {
    const unified = readFileSync(`/proc/${pid}/cgroup`, 'utf8')
      .split('\n')
      .find((line) => line.startsWith('0::'))
      ?.slice(3)
      .trim();
    return { alive: true, cgroupPath: normalizeCgroupPath(unified) };
  } catch (error) {
    return {
      alive: (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : null,
      cgroupPath: null,
    };
  }
}

function defaultReadProcessCgroup(pid: number): string | null {
  return defaultReadProcessObservation(pid).cgroupPath;
}

async function defaultReadTargetCgroup(target: RestartTargetName): Promise<string | null> {
  const { stdout } = await runExecFile(
    'systemctl',
    ['--user', 'show', RESTART_TARGET_UNITS[target], '-p', 'ControlGroup', '--value'],
    { timeout: 3_000 },
  );
  return normalizeCgroupPath(String(stdout));
}

/**
 * PURE verdict. Every input is explicit, so the whole decision table — including each
 * single-condition removal — is provable from fixtures with no filesystem and no database.
 * (A guard whose only test is "0 violations on a tree that has 0 violations" would pass
 * identically with its condition INVERTED; this shape is what makes teeth testable.)
 */
export function judgeGateCollision(input: {
  target: string;
  probe: GateCollisionProbe;
  override: boolean;
}): GateCollisionVerdict {
  const { target, probe, override } = input;
  const cgroupRelation = probe.runLockHeld
    ? gateRunCgroupRelation(probe.runLockCgroupPath, probe.targetCgroupPath)
    : 'unknown';
  const detail = {
    runElapsedSec: probe.runElapsedSec,
    nextFireInSec: probe.nextFireInSec,
    refiringCandidate: probe.refire?.refiringCandidate ?? null,
    refireAttempt: probe.refire?.refireAttempt ?? null,
    runLockPid: probe.runLockPid ?? null,
    runLockCgroupPath: probe.runLockCgroupPath ?? null,
    targetCgroupPath: probe.targetCgroupPath ?? null,
    cgroupRelation,
  };

  if (!isGateSensitiveTarget(target)) {
    return {
      blocked: false,
      kind: 'not-gate-sensitive',
      overridden: false,
      note: `${target} is not a green-checkpoint dependency — no gate-collision check applies.`,
      detail,
    };
  }

  if (probe.probeFailed) {
    // Fail OPEN and SAY SO. Silence here would read as a verified all-clear.
    return {
      blocked: false,
      kind: 'probe-failed',
      overridden: false,
      note: `Could NOT determine whether a green-checkpoint run is in flight (the probe failed) — proceeding, because a restart wrongly refused is worse than the collision. Verify by hand if this restart is gate-sensitive.`,
      detail,
    };
  }

  const fireImminent =
    probe.nextFireInSec !== null &&
    probe.nextFireInSec <= IMMINENT_FIRE_LOOKAHEAD_SEC &&
    probe.nextFireInSec >= -IMMINENT_FIRE_LOOKBEHIND_SEC;

  if (!probe.runLockHeld && !fireImminent) {
    return {
      blocked: false,
      kind: 'clear',
      overridden: false,
      note: `No green-checkpoint run in flight${
        probe.nextFireInSec !== null ? `; next scheduled fire in ~${humanizeSec(probe.nextFireInSec)}` : ''
      }.`,
      detail,
    };
  }

  if (probe.runLockHeld && cgroupRelation === 'different') {
    return {
      blocked: false,
      kind: 'run-in-flight-isolated',
      overridden: false,
      note:
        `A green-checkpoint run IS IN FLIGHT, but its cgroup (${probe.runLockCgroupPath}) is separate from ` +
        `${target}'s systemd cgroup (${probe.targetCgroupPath}) — restarting ${target} cannot terminate that run ` +
        `through systemd cgroup membership. Proceeding with residual risk: the restart can still add ambient host ` +
        `load during boot, while the run's own watchdog covers loss of the parent-side kill timer.`,
      detail,
    };
  }

  if (probe.runLockHeld && cgroupRelation === 'unknown') {
    return {
      blocked: false,
      kind: 'run-in-flight-unknown',
      overridden: false,
      note:
        `A green-checkpoint run IS IN FLIGHT, but its cgroup relationship to ${target} could not be determined ` +
        `(checkpoint=${probe.runLockCgroupPath ?? 'unknown'}, target=${probe.targetCgroupPath ?? 'unknown'}). ` +
        `Proceeding because this guard fails open when mechanism metadata is unknown; verify the restart's impact ` +
        `against systemd if the target is gate-sensitive.`,
      detail,
    };
  }

  const kind: GateCollisionKind = probe.runLockHeld ? 'run-in-flight' : 'imminent-fire';

  const what = probe.runLockHeld
    ? `A green-checkpoint run IS IN FLIGHT${
        probe.runElapsedSec !== null ? ` (running ${humanizeSec(probe.runElapsedSec)})` : ''
      }${
        probe.refire
          ? ` and is MID AUTO-REFIRE (attempt ${probe.refire.refireAttempt}/${probe.refire.maxRefires}, now judging ${probe.refire.refiringCandidate})`
          : ''
      }.`
    : probe.nextFireInSec !== null && probe.nextFireInSec >= 0
      ? `The hourly green-checkpoint gate fires in ${humanizeSec(probe.nextFireInSec)}.`
      : `The hourly green-checkpoint gate fired ${humanizeSec(probe.nextFireInSec ?? 0)} ago and its run may not have taken the shared run-lock yet.`;

  const why =
    `The run shares ${target}'s systemd cgroup, so restarting ${target} can terminate it; even when the cgroups ` +
    `are separate, ambient host load during boot can still perturb the gate, and a parent restart can drop only ` +
    `the parent's kill timer (the run's own watchdog is the backstop).`;

  if (override) {
    return {
      blocked: false,
      kind,
      overridden: true,
      note: `${what} ${why} PROCEEDING ANYWAY — override_gate_collision was passed. If the gate reds on anything embedding- or search-shaped, attribute it to THIS restart and re-run before reading it as a regression.`,
      detail,
    };
  }

  return {
    blocked: true,
    kind,
    overridden: false,
    note: `Restart WITHHELD — nothing was done: no lock taken, no drain. ${what} ${why} Either wait it out, or — if ${target} is genuinely wedged and must be restarted now — re-call with { override_gate_collision: true } and record in \`reason\` that the run may be affected.`,
    detail,
  };
}

/** Injectable readers, so the shell is testable without a filesystem or a database. */
export interface GateCollisionProbeDeps {
  readRunLock: () => { held: boolean; elapsedSec: number | null; pid?: number };
  /** Read the checkpoint owner's unified cgroup. Optional for backwards-compatible fixtures. */
  readRunLockCgroup?: (pid: number) => string | null | Promise<string | null>;
  /** Read the restart target's systemd ControlGroup. Optional for backwards-compatible fixtures. */
  readTargetCgroup?: (target: GateSensitiveTarget) => string | null | Promise<string | null>;
  readNextFireInSec: () => Promise<number | null>;
  readRefire: () => Promise<StoredInFlightRetriage | null>;
}

/**
 * When the gate next fires, from the SAME routines row `readInFlightRetriage` reads.
 *
 * Scoped on `install_slug` AND `workspace_id`: that table is multi-tenant (one row per
 * harness, and every harness's row carries the same `:15` schedule), so an under-scoped read
 * returns some other harness's row — well-formed, confident, wrong. A zero-row result fails
 * open, which is the safe direction here.
 *
 * Also read by the green checkpoint's post-verdict pure-lane proof capture
 * (scripts/lib/pure-lane-proof-capture.mjs), which stops before a slice that would run into
 * the next fire.
 */
export async function readGreenCheckpointNextFireInSec(): Promise<number | null> {
  const [{ operatorHomeHarnessSlug }, { getOrgPg }, { activeWorkspaceId }] = await Promise.all([
    import('../harness/operator-home-harness'),
    import('@papercusp/db-org'),
    import('../workspace-registry'),
  ]);
  const slug = operatorHomeHarnessSlug();
  if (!slug) return null;
  const { sql } = getOrgPg();
  const rows = (await sql.unsafe(
    `SELECT EXTRACT(EPOCH FROM (next_fire_at - now())) AS next_fire_in_sec
       FROM harness_shared.routines
      WHERE install_slug = $1 AND workspace_id = $2
        AND target_role = 'system:green-checkpoint' AND active = true
      LIMIT 1`,
    [slug, activeWorkspaceId()],
  )) as Array<{ next_fire_in_sec: string | number | null }>;
  const raw = rows[0]?.next_fire_in_sec;
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

async function defaultDeps(): Promise<GateCollisionProbeDeps> {
  const [{ integrationRoot }, { isCheckpointRunLockHeldCheap }, { readInFlightRetriage }] = await Promise.all([
    import('../release-deploy-launch'),
    import('../release-checkpoint-launch'),
    import('./in-flight-retriage'),
  ]);
  return {
    readRunLock: () => isCheckpointRunLockHeldCheap(integrationRoot()),
    readRunLockCgroup: defaultReadProcessCgroup,
    readTargetCgroup: defaultReadTargetCgroup,
    readNextFireInSec: readGreenCheckpointNextFireInSec,
    readRefire: () => readInFlightRetriage(),
  };
}

/**
 * Thin I/O shell. Each reader is isolated so ONE failure degrades ONE field rather than
 * collapsing the whole probe to `probeFailed` — a readable run-lock still blocks correctly
 * when the routines read is what broke.
 */
export async function probeGateCollision(
  deps?: GateCollisionProbeDeps,
  target: GateSensitiveTarget = 'bg-host',
): Promise<GateCollisionProbe> {
  let d: GateCollisionProbeDeps;
  try {
    d = deps ?? (await defaultDeps());
  } catch {
    return { probeFailed: true, runLockHeld: false, runElapsedSec: null, nextFireInSec: null, refire: null };
  }

  let probeFailed = false;
  let runLockHeld = false;
  let runElapsedSec: number | null = null;
  let runLockPid: number | null | undefined;
  let runLockCgroupPath: string | null | undefined;
  let targetCgroupPath: string | null | undefined;
  let cgroupProbeFailed = false;
  try {
    const lock = d.readRunLock();
    runLockHeld = lock.held;
    runElapsedSec = lock.elapsedSec;
    runLockPid = lock.pid ?? null;
  } catch {
    probeFailed = true;
  }

  // Only a held lock needs mechanism analysis. The default deps always provide these readers;
  // old injectable fixtures that do not provide them retain the pre-cgroup pure-test contract.
  const hasCgroupReaders = Boolean(d.readRunLockCgroup || d.readTargetCgroup);
  if (runLockHeld && ((runLockPid !== null && runLockPid !== undefined) || hasCgroupReaders)) {
    if (runLockPid !== null && runLockPid !== undefined && d.readRunLockCgroup) {
      try {
        runLockCgroupPath = await d.readRunLockCgroup(runLockPid);
      } catch {
        cgroupProbeFailed = true;
        runLockCgroupPath = null;
      }
    } else {
      cgroupProbeFailed = true;
      runLockCgroupPath = null;
    }
    if (d.readTargetCgroup) {
      try {
        targetCgroupPath = await d.readTargetCgroup(target);
      } catch {
        cgroupProbeFailed = true;
        targetCgroupPath = null;
      }
    }
  }

  let nextFireInSec: number | null = null;
  try {
    nextFireInSec = await d.readNextFireInSec();
  } catch {
    probeFailed = true;
  }

  let refire: StoredInFlightRetriage | null = null;
  try {
    refire = await d.readRefire();
  } catch {
    // The refire marker only ENRICHES the message; losing it is never a probe failure.
  }

  return {
    probeFailed,
    runLockHeld,
    runElapsedSec,
    ...(runLockPid !== undefined ? { runLockPid } : {}),
    ...(runLockCgroupPath !== undefined ? { runLockCgroupPath } : {}),
    ...(targetCgroupPath !== undefined ? { targetCgroupPath } : {}),
    ...(cgroupProbeFailed ? { cgroupProbeFailed } : {}),
    nextFireInSec,
    refire,
  };
}

/** Probe + judge, the one call `dev:restart` makes. Never throws. */
export async function checkGateCollision(
  target: string,
  override: boolean,
  deps?: GateCollisionProbeDeps,
): Promise<GateCollisionVerdict> {
  if (!isGateSensitiveTarget(target)) {
    return judgeGateCollision({
      target,
      probe: { probeFailed: false, runLockHeld: false, runElapsedSec: null, nextFireInSec: null, refire: null },
      override,
    });
  }
  const probe = await probeGateCollision(deps, target);
  return judgeGateCollision({ target, probe, override });
}

/**
 * WI-222053 — the same cgroup mechanism guard, applied to git-sync operations.
 *
 * The 2026-08-27 papercusp freeze was sustained by restarts that killed a long
 * superproject commit after it acquired `exclusive(git-sync:papercusp)`. Both
 * scheduled bg-host fires and manual :3070 fires were observed as holders, so a
 * target-name-only `bg-host` guard is incomplete. The authoritative mechanism is:
 * a live `system:git-sync:<pid>:<uuid>` holder whose process is inside the unit
 * being restarted. Reuse {@link gateRunCgroupRelation} so sibling transient units
 * remain isolated and a stale/dead/foreign holder never becomes a false refusal.
 * The staging operator (`:3170`) is intentionally excluded: it does not host
 * git-sync execution, and its restart must not contend on the workspace-wide
 * git-sync barrier used by the dev and bg-host processes.
 */
export const GIT_SYNC_SENSITIVE_RESTART_TARGETS = ['dev', 'bg-host'] as const;

export type GitSyncSensitiveTarget = (typeof GIT_SYNC_SENSITIVE_RESTART_TARGETS)[number];

export function isGitSyncSensitiveTarget(target: string): target is GitSyncSensitiveTarget {
  return (GIT_SYNC_SENSITIVE_RESTART_TARGETS as readonly string[]).includes(target);
}

export interface GitSyncLockHolder {
  resource: string;
  owner: string;
  acquiredAtMs: number | null;
  expiresAtMs: number | null;
}

export interface GitSyncOperationObservation extends GitSyncLockHolder {
  pid: number | null;
  alive: boolean | null;
  processCgroupPath: string | null;
  cgroupRelation: GateRunCgroupRelation;
  ageSec: number | null;
}

export interface GitSyncCollisionProbe {
  /** True only when the holder ledger itself could not be read. Per-process unknowns stay explicit. */
  probeFailed: boolean;
  targetCgroupPath: string | null;
  operations: GitSyncOperationObservation[];
}

export type GitSyncCollisionKind =
  | 'not-git-sync-sensitive'
  | 'probe-failed'
  | 'clear'
  | 'operation-in-flight'
  | 'operation-in-flight-isolated'
  | 'operation-in-flight-unknown';

export interface GitSyncCollisionVerdict {
  blocked: boolean;
  kind: GitSyncCollisionKind;
  overridden: boolean;
  note: string;
  detail: {
    targetCgroupPath: string | null;
    collidingResources: string[];
    collidingPids: number[];
    isolatedResources: string[];
    unknownResources: string[];
    deadResources: string[];
  };
}

const gitSyncPid = (owner: string): number | null => {
  const match = /^system:git-sync:(\d+):/.exec(owner);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
};

const gitSyncDetail = (probe: GitSyncCollisionProbe): GitSyncCollisionVerdict['detail'] => {
  const recognized = probe.operations.filter((op) => op.pid !== null);
  const colliding = recognized.filter((op) => op.alive === true && op.cgroupRelation === 'same');
  return {
    targetCgroupPath: probe.targetCgroupPath,
    collidingResources: colliding.map((op) => op.resource),
    collidingPids: colliding.flatMap((op) => (op.pid === null ? [] : [op.pid])),
    isolatedResources: recognized
      .filter((op) => op.alive === true && op.cgroupRelation === 'different')
      .map((op) => op.resource),
    unknownResources: recognized
      .filter((op) => op.alive === null || (op.alive === true && op.cgroupRelation === 'unknown'))
      .map((op) => op.resource),
    deadResources: recognized.filter((op) => op.alive === false).map((op) => op.resource),
  };
};

export function judgeGitSyncCollision(input: {
  target: string;
  probe: GitSyncCollisionProbe;
  override: boolean;
}): GitSyncCollisionVerdict {
  const { target, probe, override } = input;
  const detail = gitSyncDetail(probe);

  if (!isGitSyncSensitiveTarget(target)) {
    return {
      blocked: false,
      kind: 'not-git-sync-sensitive',
      overridden: false,
      note: `${target} does not host git-sync execution — no git-sync restart-collision check applies.`,
      detail,
    };
  }
  if (probe.probeFailed) {
    const note =
      'Could NOT read live git-sync resource holders. Restart safety is unknown, so the restart is withheld; ' +
      're-call with override_git_sync_collision:true only when the host itself is wedged.';
    if (override) {
      return {
        blocked: false,
        kind: 'probe-failed',
        overridden: true,
        note: `${note} PROCEEDING ANYWAY under the audited override.`,
        detail,
      };
    }
    return {
      blocked: true,
      kind: 'probe-failed',
      overridden: false,
      note,
      detail,
    };
  }

  const colliding = probe.operations.filter(
    (op) => op.pid !== null && op.alive === true && op.cgroupRelation === 'same',
  );
  if (colliding.length > 0) {
    const operations = colliding
      .map((op) => `${op.resource} (pid ${op.pid}${op.ageSec === null ? '' : `, ${humanizeSec(op.ageSec)} old`})`)
      .join(', ');
    const why =
      `The live operation shares ${target}'s systemd cgroup (${probe.targetCgroupPath}), so restarting ${target} ` +
      'would SIGKILL the commit after lock acquisition and leave the tree frozen behind an orphaned lease.';
    if (override) {
      return {
        blocked: false,
        kind: 'operation-in-flight',
        overridden: true,
        note: `Git-sync IS IN FLIGHT: ${operations}. ${why} PROCEEDING ANYWAY because override_git_sync_collision:true was passed; the override is audited.`,
        detail,
      };
    }
    return {
      blocked: true,
      kind: 'operation-in-flight',
      overridden: false,
      note:
        `Restart REFUSED — NOTHING was done: no cooldown claimed, no drain, no signal. Git-sync IS IN FLIGHT: ${operations}. ` +
        `${why} EI-21930094737784126: this check is a CGROUP PROXY, so on a host that runs git-sync itself it is ~always true ` +
        'while the workspace-wide `git-sync` barrier it stands in for is free about half the time (fires hold it only ~5-10s). ' +
        'The supported way through a merely BUSY host is to re-call with git_sync_drain_sec:<seconds> — that WAITS for the drain ' +
        'and lets the barrier arbitrate. override_git_sync_collision:true is for a WEDGED host only: it SIGKILLs an in-flight ' +
        "commit and strands a peer's uncommitted work, so pass it only when the restart is itself the remedy, and record why.",
      detail,
    };
  }

  if (detail.unknownResources.length > 0) {
    const note =
      `Git-sync holder(s) exist (${detail.unknownResources.join(', ')}), but their live process/cgroup relation to ${target} ` +
      'could not be proven. Restart safety is unknown, so the restart is withheld; use override_git_sync_collision:true only when the host itself is wedged.';
    if (override) {
      return {
        blocked: false,
        kind: 'operation-in-flight-unknown',
        overridden: true,
        note: `${note} PROCEEDING ANYWAY under the audited override.`,
        detail,
      };
    }
    return {
      blocked: true,
      kind: 'operation-in-flight-unknown',
      overridden: false,
      note,
      detail,
    };
  }
  if (detail.isolatedResources.length > 0) {
    return {
      blocked: false,
      kind: 'operation-in-flight-isolated',
      overridden: false,
      note:
        `Git-sync is active for ${detail.isolatedResources.join(', ')}, but its process is in a sibling cgroup outside ` +
        `${target}'s restart blast radius.`,
      detail,
    };
  }
  return {
    blocked: false,
    kind: 'clear',
    overridden: false,
    note: detail.deadResources.length
      ? `No live git-sync operation shares ${target}'s cgroup; ignored expired-process holder(s): ${detail.deadResources.join(', ')}.`
      : `No live git-sync operation shares ${target}'s cgroup.`,
    detail,
  };
}

export interface GitSyncCollisionProbeDeps {
  readHolders: () => Promise<GitSyncLockHolder[]>;
  readProcess: (pid: number) => ProcessCgroupObservation | Promise<ProcessCgroupObservation>;
  readTargetCgroup: (target: GitSyncSensitiveTarget) => string | null | Promise<string | null>;
  nowMs?: () => number;
}

async function defaultGitSyncDeps(): Promise<GitSyncCollisionProbeDeps> {
  const [{ getTxPool, readResourceQueue }, { workspaceScopedLockDomain }] = await Promise.all([
    import('../agent-tools/locks/su-lock-store'),
    import('../agent-tools/locks/coordination-domain'),
  ]);
  return {
    readHolders: async () => {
      const queue = await readResourceQueue(getTxPool(), { coordinationDomain: workspaceScopedLockDomain() });
      return queue.holders
        .filter((holder) => holder.mode === 'exclusive' && holder.resource.startsWith('git-sync:'))
        .map((holder) => ({
          resource: holder.resource,
          owner: holder.owner,
          acquiredAtMs: holder.acquired_ts?.getTime?.() ?? null,
          expiresAtMs: holder.expires_ts?.getTime?.() ?? null,
        }));
    },
    readProcess: defaultReadProcessObservation,
    readTargetCgroup: defaultReadTargetCgroup,
  };
}

export async function probeGitSyncCollision(
  deps?: GitSyncCollisionProbeDeps,
  target: GitSyncSensitiveTarget = 'bg-host',
): Promise<GitSyncCollisionProbe> {
  let readers: GitSyncCollisionProbeDeps;
  try {
    readers = deps ?? (await defaultGitSyncDeps());
  } catch {
    return { probeFailed: true, targetCgroupPath: null, operations: [] };
  }

  let holders: GitSyncLockHolder[];
  try {
    holders = await readers.readHolders();
  } catch {
    return { probeFailed: true, targetCgroupPath: null, operations: [] };
  }
  if (holders.length === 0) return { probeFailed: false, targetCgroupPath: null, operations: [] };

  let targetCgroupPath: string | null = null;
  try {
    targetCgroupPath = normalizeCgroupPath(await readers.readTargetCgroup(target));
  } catch {
    // Per-mechanism unknown: retain the holder observations and fail open explicitly.
  }

  const nowMs = readers.nowMs?.() ?? Date.now();
  const operations = await Promise.all(
    holders.map(async (holder): Promise<GitSyncOperationObservation> => {
      const pid = gitSyncPid(holder.owner);
      let process: ProcessCgroupObservation = { alive: null, cgroupPath: null };
      if (pid !== null) {
        try {
          process = await readers.readProcess(pid);
        } catch {
          // One unreadable process must not collapse every independently-readable holder.
        }
      }
      return {
        ...holder,
        pid,
        alive: process.alive,
        processCgroupPath: normalizeCgroupPath(process.cgroupPath),
        cgroupRelation:
          process.alive === true ? gateRunCgroupRelation(process.cgroupPath, targetCgroupPath) : 'unknown',
        ageSec: holder.acquiredAtMs === null ? null : Math.max(0, Math.round((nowMs - holder.acquiredAtMs) / 1_000)),
      };
    }),
  );
  return { probeFailed: false, targetCgroupPath, operations };
}

/** Probe + judge, the one additional read-only guard `dev:restart` calls. Never throws. */
export async function checkGitSyncCollision(
  target: string,
  override: boolean,
  deps?: GitSyncCollisionProbeDeps,
): Promise<GitSyncCollisionVerdict> {
  if (!isGitSyncSensitiveTarget(target)) {
    return judgeGitSyncCollision({
      target,
      probe: { probeFailed: false, targetCgroupPath: null, operations: [] },
      override,
    });
  }
  const probe = await probeGitSyncCollision(deps, target);
  return judgeGitSyncCollision({ target, probe, override });
}

/**
 * The isolated staging-sync service owns this flock exclusively while it may
 * mutate the checkout. A staging restart probes for a SHARED lock: that fails
 * while sync is in its exclusive checkout/build phase, but succeeds after the
 * sync script downgrades its own lock for the final restart/readiness phase.
 */
export const STAGING_SYNC_LOCK_PATH = '/tmp/papercup-staging-sync.lock';

export type StagingSyncCollisionKind =
  | 'not-staging-target'
  | 'clear'
  | 'staging-sync-in-flight'
  | 'probe-failed';

export interface StagingSyncCollisionVerdict {
  blocked: boolean;
  kind: StagingSyncCollisionKind;
  note: string;
  detail: { lockPath: string; lockHeld: boolean | null };
}

async function defaultStagingSyncLockProbe(): Promise<boolean> {
  // Do not create the shared lock file merely by previewing a restart.
  if (!existsSync(STAGING_SYNC_LOCK_PATH)) return false;
  try {
    await runExecFile(
      '/usr/bin/flock',
      ['--nonblock', '--shared', STAGING_SYNC_LOCK_PATH, 'true'],
      { timeout: 3_000 },
    );
    return false;
  } catch (error) {
    // flock(1) uses status 1 for a nonblocking lock conflict. Other failures
    // are UNKNOWN, not evidence that the sync lock is clear.
    // execFile reports a child's exit status as a NUMERIC `code`, which
    // ErrnoException (string code) does not model.
    if ((error as { code?: unknown }).code === 1) return true;
    throw error;
  }
}

/** Refuse target:staging while the sync service holds its exclusive checkout lock. */
export async function checkStagingSyncCollision(
  target: string,
  probe: () => Promise<boolean> = defaultStagingSyncLockProbe,
): Promise<StagingSyncCollisionVerdict> {
  const detail = { lockPath: STAGING_SYNC_LOCK_PATH, lockHeld: null as boolean | null };
  if (target !== 'staging') {
    return {
      blocked: false,
      kind: 'not-staging-target',
      note: `${target} is not the staging operator; no staging-sync lock check applies.`,
      detail,
    };
  }
  try {
    const lockHeld = await probe();
    detail.lockHeld = lockHeld;
    return lockHeld
      ? {
          blocked: true,
          kind: 'staging-sync-in-flight',
          note:
            `Restart REFUSED — papercup-staging-sync holds its exclusive checkout lock (${detail.lockPath}). ` +
            'Nothing was restarted; retry after the sync reaches its final restart phase.',
          detail,
        }
      : {
          blocked: false,
          kind: 'clear',
          note: `papercup-staging-sync is not in its exclusive checkout/build phase (${detail.lockPath}).`,
          detail,
        };
  } catch {
    return {
      blocked: true,
      kind: 'probe-failed',
      note:
        `Restart REFUSED — could not verify the papercup-staging-sync lock at ${detail.lockPath}. ` +
        'Nothing was restarted; retry after the lock probe is healthy.',
      detail,
    };
  }
}

/**
 * The preflight above explains a collision precisely, but it cannot close the
 * check→kill race by itself. The legacy superproject `git-sync` resource is the
 * existing serialization seam every papercusp superproject fire acquires after
 * its per-slug lock. A restart takes that same resource exclusively immediately
 * before scheduling systemctl, and intentionally leaves the short lease to
 * expire after the delayed kill handoff. Releasing on callback return would
 * recreate the one-second race this barrier exists to close.
 *
 * WI-222686 aligns the exact `git-sync` name with the action's workspace domain;
 * always call resourceLockDomain rather than transcribing that domain here.
 */
export const GIT_SYNC_RESTART_BARRIER_RESOURCE = 'git-sync';
export const GIT_SYNC_RESTART_BARRIER_TTL_SEC = 60;

type BarrierHolder = { owner: string; owner_label?: string | null; mode: string; status: string };

type BarrierAcquireRaw =
  | { ok: true; lock_id: string; expires_ts: Date }
  /**
   * `lock_id` is present exactly when the failure left a QUEUED EXCLUSIVE behind
   * (`drain_timeout`, or `status:'draining'` on a no-wait acquire). That queue row
   * is not inert: a draining exclusive REFUSES NEW SHARED ACQUIRES, so an abandoned
   * one back-pressures every harness's git-sync until its TTL lapses. Measured by
   * hand on 2026-08-31 (EI-21930094737784126) — a failed `locks:acquire_resource`
   * still returned a lock_id and left the barrier draining. Whoever consumes this
   * MUST release it; see `acquireGitSyncRestartBarrier`.
   */
  | { ok: false; reason: string; holders: BarrierHolder[]; lock_id?: string };

export interface GitSyncRestartBarrierDeps {
  resolveDomain: (resource: string) => string;
  newOwner: () => string;
  acquire: (params: {
    coordinationDomain: string;
    resource: string;
    owner: string;
    ownerLabel: string | null;
    ttlSec: number;
    /** 0 = today's bare try-acquire. >0 = drain shared holders for up to N sec. */
    maxWaitSec: number;
  }) => Promise<BarrierAcquireRaw>;
  release: (params: { coordinationDomain: string; owner: string; lockId: string }) => Promise<void>;
}

/**
 * How long the restart barrier drains shared git-sync holders before giving up.
 *
 * ORIGINALLY MEASURED 2026-08-31 (EI-21930094737784126) at 45s: sampling the live
 * `git-sync` barrier every 5s showed fires holding it for **~5-10 seconds**, arriving
 * in bursts of ~6, with **20 of 40 sampled seconds at zero holders**. `LOCK_TTL_SEC =
 * 600` in git-sync-action.ts is a generous LEASE BOUND, not the work duration — reading
 * it as the wait we would have to outlast is the mistake that made this look unfixable.
 *
 * RE-MEASURED 2026-09-01 (EI-22047168222679674): that baseline went stale as fleet
 * concurrency grew. A caller who legitimately wanted MORE drain (git_sync_drain_sec:180)
 * was rejected by the schema max (then 45), and a same-day reproduction at the
 * then-current 45s cap still surfaced `git_sync_barrier_drain_timeout` with **8 live
 * shared holders** — above the ~6-holder burst the original sample characterised, and
 * consistent with more agents now firing git-sync concurrently than on 2026-08-31.
 * Widened to 120s: still a small fraction of the handler's own ~330s ceiling
 * (`MAX_DRAIN_SEC + 30`) and of the `LOCK_TTL_SEC = 600` lease bound, but enough
 * margin to clear a burst roughly 2-3x the original sample without forcing every
 * merely-busy caller into `override_git_sync_collision` (which SIGKILLs an in-flight
 * commit and strands a peer's uncommitted work — see the call site's own warning).
 *
 * It is not merely a timeout: a draining exclusive REFUSES NEW SHARED ACQUIRES, so the
 * sweep stops feeding itself while we wait. That is why draining converges and why
 * polling the cgroup predicate never could — polling races the sweep it is trying to
 * observe. If this value goes stale again, re-sample `locks:list { resource:'git-sync' }`
 * over a live window rather than guessing.
 */
export const GIT_SYNC_RESTART_BARRIER_DRAIN_SEC = 120;

export type GitSyncRestartBarrierOutcome =
  | {
      acquired: true;
      resource: typeof GIT_SYNC_RESTART_BARRIER_RESOURCE;
      lockId: string;
      owner: string;
      coordinationDomain: string;
      expiresAt: string;
      release: () => Promise<void>;
    }
  | {
      acquired: false;
      resource: typeof GIT_SYNC_RESTART_BARRIER_RESOURCE;
      reason: string;
      holders: BarrierHolder[];
    };

async function defaultGitSyncRestartBarrierDeps(): Promise<GitSyncRestartBarrierDeps> {
  const [{ inWorkspaceTxn }, lockStore, { resourceLockDomain }] = await Promise.all([
    import('../agent-tools/locks/in-workspace-txn'),
    import('../agent-tools/locks/su-lock-store'),
    import('../agent-tools/locks/coordination-domain'),
  ]);
  return {
    resolveDomain: resourceLockDomain,
    newOwner: () => `system:dev-restart:git-sync-barrier:${process.pid}:${randomUUID()}`,
    acquire: async ({ coordinationDomain, resource, owner, ownerLabel, ttlSec, maxWaitSec }) => {
      // Route through the drain-capable acquire rather than a bare try-acquire, so a
      // live git-sync burst is WAITED OUT instead of bounced. Normalises the wait
      // module's four-shape result into BarrierAcquireRaw, carrying `lock_id` on
      // every outcome that left a queue row behind so the caller can release it.
      const { acquireResourceExclusiveWithWait } = await import('../agent-tools/locks/resource-acquire-wait');
      const r = await acquireResourceExclusiveWithWait({
        coordinationDomain,
        owner,
        ownerLabel,
        resource,
        reason: 'dev:restart git-sync kill barrier (WI-222053)',
        ttlSec,
        maxWaitSec,
      });
      if (r.ok && r.status === 'held') {
        return { ok: true, lock_id: r.lock_id, expires_ts: new Date(Date.now() + ttlSec * 1000) };
      }
      // `status:'draining'` (ok:true, maxWaitSec 0) is NOT an acquisition — it is a
      // parked queue row. Normalise it to a failure so it can never read as success.
      if (r.ok) return { ok: false, reason: 'draining', holders: r.holders, lock_id: r.lock_id };
      return {
        ok: false,
        reason: r.reason,
        holders: r.holders,
        ...('lock_id' in r && r.lock_id ? { lock_id: r.lock_id } : {}),
      };
    },
    release: async ({ coordinationDomain, owner, lockId }) => {
      await inWorkspaceTxn(coordinationDomain, owner, (tx) =>
        lockStore.tryReleaseResource(tx, { coordinationDomain, owner, lockId }),
      );
    },
  };
}

export async function acquireGitSyncRestartBarrier(
  ownerLabel: string | null,
  deps?: GitSyncRestartBarrierDeps,
  opts?: { maxDrainSec?: number },
): Promise<GitSyncRestartBarrierOutcome> {
  const d = deps ?? (await defaultGitSyncRestartBarrierDeps());
  const resource = GIT_SYNC_RESTART_BARRIER_RESOURCE;
  const coordinationDomain = d.resolveDomain(resource);
  const owner = d.newOwner();
  const maxWaitSec = Math.max(0, opts?.maxDrainSec ?? 0);
  const result = await d.acquire({
    coordinationDomain,
    resource,
    owner,
    ownerLabel,
    // The lease starts when the exclusive is QUEUED, not when it becomes held.
    // Preserve it for the entire drain plus the existing kill-handoff window;
    // otherwise a 120s drain loses its 60s lease and admits new git-sync fires.
    ttlSec: Math.ceil(maxWaitSec) + GIT_SYNC_RESTART_BARRIER_TTL_SEC,
    maxWaitSec,
  });
  if (!result.ok) {
    // RELEASE THE QUEUED EXCLUSIVE. A failed acquire that left a queue row behind is
    // not inert: while it sits in 'draining' it REFUSES NEW SHARED ACQUIRES, so an
    // abandoned one back-pressures every harness's git-sync until its TTL lapses.
    // Best-effort — a failed release must not mask the acquire failure the caller
    // actually needs to see, and the TTL is the backstop.
    if (result.lock_id) {
      // EI-22627342911348772: a timed-out drain leaves its queued exclusive in
      // place deliberately, so this cleanup is a correctness boundary, not a
      // cosmetic best effort. A one-shot release can lose to transient
      // workspace advisory-lock contention; the abandoned row then promotes to
      // `held` after the shared git-sync holder exits and the next restart sees
      // its predecessor as `git_sync_barrier_held_exclusive`. Give cleanup the
      // same bounded contention retry used by acquisition. Non-contention
      // failures still fall through to the TTL backstop and never mask the
      // original acquire refusal.
      await acquireWithContentionRetry(() =>
        d.release({ coordinationDomain, owner, lockId: result.lock_id! }),
      )
        .catch(() => {});
    }
    return { acquired: false, resource, reason: result.reason, holders: result.holders };
  }
  return {
    acquired: true,
    resource,
    lockId: result.lock_id,
    owner,
    coordinationDomain,
    expiresAt: result.expires_ts.toISOString(),
    release: () => d.release({ coordinationDomain, owner, lockId: result.lock_id }),
  };
}
