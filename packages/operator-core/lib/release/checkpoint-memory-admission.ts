import { totalmem } from 'node:os';

import {
  absCgroupDir,
  type CgroupFs,
  nodeCgroupFs,
  parseCgroupInt,
  readProcessCgroupPath,
  readProcessCmdline,
} from '../task-manager/cgroup-read';

/**
 * checkpoint-memory-admission — the ONE cross-root bound on concurrent green-checkpoint
 * memory commitment, consulted by BOTH scope-creating seams before their scope exists.
 *
 * ## Why this module exists (green-checkpoint-red-streak-root-cause-2026-08-17, P-006)
 *
 * The gate's run-lock is PER-ROOT, not global: `green-checkpoint.ts` hashes `integrationRoot`
 * into the lock filename, so per-root == per-pot. ~15 pots share the one hourly cron. Each
 * reserved-mode run commits `checkpointScopeMemoryMaxG()` = 40 GiB to its own transient
 * cgroup, and NOTHING anywhere summed those commitments — 15 pots firing on the same tick
 * could each claim 40 GiB against a 251 GiB host. The per-root lock is working exactly as
 * designed; it simply answers a different question than "can this host afford one more run".
 *
 * ## Why the check lives here and not at one launcher
 *
 * There are TWO seams that create a checkpoint scope, and a bound at either one alone leaves
 * the other unbounded (D-007):
 *
 *  1. SCHEDULED — `harness/routines/release-actions.ts` -> `runScript(..., { memoryMaxG })` ->
 *     `buildIsolatedScopeArgv` -> an ANONYMOUS `run-*.scope`. This is the real exposure: it is
 *     the path the hourly cron takes for every pot.
 *  2. MANUAL — `release-checkpoint-launch.ts` -> `buildCheckpointSystemdArgv` -> a NAMED unit
 *     from `checkpointUnitForRoot`.
 *
 * Both call {@link admitCheckpointMemory} BEFORE building their argv, so the bound cannot be
 * bypassed by taking the other door.
 *
 * ## Why enumeration goes through /proc rather than unit names
 *
 * The scheduled scope is anonymous (`run-<hex>.scope`), so there is no name to enumerate by —
 * measured 2026-08-29 on in-flight scheduled run 748ebbe0, whose cgroup was
 * `run-r22e2567d61e447b194890ee47851d7e3.scope` with `memory.max` = 42949672960 (exactly
 * 40 GiB). The only reliable handle is the running green-checkpoint process itself: resolve
 * its cgroup via `/proc/<pid>/cgroup`, then read that cgroup's committed `memory.max`. Live
 * COMMITMENT is what has to be summed, not live USAGE — a run sitting at 7 GB of a 40 GiB cap
 * can still demand the whole cap later, so admitting against usage would re-create the
 * over-subscription this exists to prevent.
 *
 * ## Why this FAILS OPEN, deliberately against the precedent one layer up
 *
 * `readQualificationAdmission` (release-actions.ts) fails CLOSED: an admission it cannot
 * measure is not permission. This one is the opposite ON PURPOSE. The status quo here is
 * *entirely unbounded*, so a probe that cannot measure commitment must not end up MORE
 * restrictive than having no probe at all. Over-refusal does not degrade gracefully: it
 * freezes `main` for every pot, and a frozen gate is a worse outcome than the memory
 * contention this guard is trimming. Concretely, admission is granted when the commitment
 * cannot be measured, and — separately — whenever nothing else is running, so a lone run is
 * never refused however the budget is configured.
 */

const GIB = 1024 ** 3;

/** Marker every green-checkpoint payload's argv carries, on both seams. */
const CHECKPOINT_CMDLINE_MARKER = 'green-checkpoint.ts';

/**
 * Share of host RAM the SUM of concurrent checkpoint scopes may commit.
 *
 * Half the host is a deliberate midpoint, not a tuned constant: on the 251 GiB dev box it
 * admits three concurrent 40 GiB reserved runs while leaving the operator, Postgres, the
 * agent fleet and page cache the other half. Override per host with
 * `PAPERCUSP_CHECKPOINT_MEMORY_BUDGET_G` when that split is wrong for the machine.
 */
export const CHECKPOINT_MEMORY_BUDGET_FRACTION = 0.5;

/**
 * A run requesting at most this many GiB is a SMALL run (WI-10006274): it is the fixed scope
 * overhead with no Vitest fork heaps, i.e. a foreign pot's own suite (`npm test`, node:test).
 */
export const CHECKPOINT_SMALL_RUN_MAX_G = 8;

/**
 * GiB small runs may commit beyond the budget, in total. Bounded so the host can never be
 * committed past budget + allowance; large runs are still admitted only under the budget.
 */
export const CHECKPOINT_SMALL_RUN_ALLOWANCE_G = 16;

/** Env var carrying an absolute budget in GiB, overriding the fraction above. */
export const CHECKPOINT_MEMORY_BUDGET_ENV = 'PAPERCUSP_CHECKPOINT_MEMORY_BUDGET_G';

/** Env var that disables the bound entirely (ops escape hatch, peer of
 *  `PAPERCUSP_CHECKPOINT_SCOPE=0`). Set to `0` to admit unconditionally. */
export const CHECKPOINT_MEMORY_ADMISSION_ENV = 'PAPERCUSP_CHECKPOINT_MEMORY_ADMISSION';

/** One live checkpoint scope's committed memory. */
export interface CheckpointScopeCommitment {
  /** Kernel-relative cgroup path, as `/proc/<pid>/cgroup` reports it. */
  cgroup: string;
  /** A pid observed inside it (the first one seen; the cgroup is the identity). */
  pid: number;
  /** Committed `memory.max` in GiB, or null when the cgroup declares `max` (unbounded). */
  committedG: number | null;
}

export interface CheckpointMemoryCommitment {
  /** Sum of the BOUNDED scopes' `memory.max`, in GiB. */
  committedG: number;
  /** Distinct live checkpoint cgroups observed. */
  scopes: CheckpointScopeCommitment[];
  /** Scopes whose `memory.max` reads `max` — real commitment this sum cannot express. */
  unbounded: number;
  /**
   * False when the probe could not read the process table at all. NOT set false merely
   * because zero runs were found: "no peers" is a measurement, and a real one.
   */
  measured: boolean;
  detail: string;
}

export type CheckpointAdmissionReason =
  /** Measured, and the request fits under the budget. */
  | 'admitted'
  /** Nothing else is running; a lone run is never refused. */
  | 'admitted-sole-run'
  /** Commitment could not be measured — fail open (see the module note). */
  | 'admitted-unmeasurable'
  /** The bound is switched off by env. */
  | 'admitted-disabled'
  /** Over the budget, but a small run within the bounded small-run allowance (WI-10006274). */
  | 'admitted-small-run'
  /** Measured, and committed + request exceeds the budget. */
  | 'over-budget';

export interface CheckpointMemoryAdmission {
  admit: boolean;
  reason: CheckpointAdmissionReason;
  /** GiB this run is about to commit. */
  requestG: number;
  /** GiB already committed by live checkpoint scopes. */
  committedG: number;
  budgetG: number;
  /** Distinct live checkpoint cgroups counted into `committedG`. */
  scopes: number;
  unbounded: number;
  /** One line, safe to log verbatim — always names the numbers behind the verdict. */
  detail: string;
}

/** Injected in tests; the default reads the real `/proc` + `/sys/fs/cgroup`. */
export interface CheckpointMemoryProbe {
  fs: CgroupFs;
  /** Pids to consider. Default: every numeric entry under `/proc`. */
  listPids(): number[];
  /** Host RAM in bytes. */
  totalMemBytes(): number;
  /** This process's own pid, excluded from the scan. */
  selfPid(): number;
}

export function defaultCheckpointMemoryProbe(fs: CgroupFs = nodeCgroupFs): CheckpointMemoryProbe {
  return {
    fs,
    listPids() {
      return fs
        .readDir('/proc')
        .filter((entry) => /^\d+$/.test(entry))
        .map((entry) => Number(entry));
    },
    totalMemBytes: () => totalmem(),
    selfPid: () => process.pid,
  };
}

/**
 * Sum the memory COMMITTED by every live green-checkpoint scope.
 *
 * The caller's own pid is excluded so a launcher can never count itself, and pids are grouped
 * by cgroup so a run's vitest forks (all inside the one scope) contribute its cap exactly
 * once rather than once per fork.
 */
export function measureCheckpointCommitment(
  probe: CheckpointMemoryProbe = defaultCheckpointMemoryProbe(),
): CheckpointMemoryCommitment {
  const pids = probe.listPids();
  if (pids.length === 0) {
    // An empty /proc listing is a FAILED READ, not an empty machine — this process is in it.
    return {
      committedG: 0,
      scopes: [],
      unbounded: 0,
      measured: false,
      detail: 'checkpoint-memory: /proc unreadable (0 pids listed) — commitment unmeasurable',
    };
  }

  const self = probe.selfPid();
  const byCgroup = new Map<string, CheckpointScopeCommitment>();
  for (const pid of pids) {
    if (pid === self) continue;
    if (!readProcessCmdline(pid, probe.fs).includes(CHECKPOINT_CMDLINE_MARKER)) continue;
    const cgroup = readProcessCgroupPath(pid, probe.fs);
    // A v1/hybrid host reports no unified path; it also cannot be summed. Skipping it here
    // under-counts rather than over-counts, which is the fail-open direction.
    if (!cgroup || byCgroup.has(cgroup)) continue;
    // `parseCgroupInt` returns null for the literal `max`, which is exactly the
    // unbounded-scope case we must report separately rather than fold in as zero.
    const bytes = parseCgroupInt(probe.fs.readFile(`${absCgroupDir(cgroup)}/memory.max`));
    byCgroup.set(cgroup, { cgroup, pid, committedG: bytes == null ? null : bytes / GIB });
  }

  const scopes = [...byCgroup.values()];
  const committedG = scopes.reduce((sum, s) => sum + (s.committedG ?? 0), 0);
  const unbounded = scopes.filter((s) => s.committedG == null).length;
  return {
    committedG,
    scopes,
    unbounded,
    measured: true,
    detail:
      `checkpoint-memory: ${scopes.length} live scope(s) committing ${committedG.toFixed(1)} GiB` +
      (unbounded > 0 ? ` (+${unbounded} with memory.max=max, uncounted)` : ''),
  };
}

/** Host-derived ceiling on the SUM of concurrent checkpoint commitments, in GiB. */
export function checkpointMemoryBudgetG(
  env: NodeJS.ProcessEnv = process.env,
  probe: CheckpointMemoryProbe = defaultCheckpointMemoryProbe(),
): number {
  const override = Number(env[CHECKPOINT_MEMORY_BUDGET_ENV]);
  if (Number.isFinite(override) && override > 0) return override;
  return Math.floor((probe.totalMemBytes() / GIB) * CHECKPOINT_MEMORY_BUDGET_FRACTION);
}

/**
 * The admission decision. Call this BEFORE creating a checkpoint scope, on either seam.
 *
 * `requestG` is the cap the caller is about to commit — i.e. exactly what it is about to pass
 * as `MemoryMax`, so the admission and the scope can never disagree about the size of the run.
 */
export function admitCheckpointMemory(opts: {
  requestG: number;
  env?: NodeJS.ProcessEnv;
  probe?: CheckpointMemoryProbe;
}): CheckpointMemoryAdmission {
  const env = opts.env ?? process.env;
  const probe = opts.probe ?? defaultCheckpointMemoryProbe();
  const requestG = opts.requestG;
  const budgetG = checkpointMemoryBudgetG(env, probe);

  if (env[CHECKPOINT_MEMORY_ADMISSION_ENV] === '0') {
    return {
      admit: true,
      reason: 'admitted-disabled',
      requestG,
      committedG: 0,
      budgetG,
      scopes: 0,
      unbounded: 0,
      detail: `checkpoint-memory: admission DISABLED by ${CHECKPOINT_MEMORY_ADMISSION_ENV}=0 — admitting ${requestG} GiB unbounded`,
    };
  }

  // EI-22093xxx / gate candidate 36318748: the module note above promises this admission FAILS
  // OPEN on an unmeasurable probe — "an unmeasurable probe must not be more restrictive than the
  // unbounded status quo it replaces". A probe that THROWS was not honouring that: it is not
  // fail-open, it is fail-CRASH, and it is the MOST restrictive outcome available because it
  // aborts the caller instead of merely refusing the run. Observed on the checkpoint host as
  // 'undefined is not iterable' propagating out of release-actions.ts's admission call and
  // red-pinning the gate; every probe accessor (`/proc` readdir, cgroup reads, `totalmem`) is an
  // unguarded host read, so a partial or restricted procfs can surface as a throw from several
  // places. Catch here rather than guarding each accessor: the CONTRACT is "unmeasurable ⇒ admit",
  // and a throw is the strongest possible evidence that the commitment is unmeasurable.
  let commitment: CheckpointMemoryCommitment;
  try {
    commitment = measureCheckpointCommitment(probe);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return {
      requestG,
      committedG: 0,
      budgetG,
      scopes: 0,
      unbounded: 0,
      admit: true,
      reason: 'admitted-unmeasurable',
      detail:
        `checkpoint-memory: commitment probe THREW (${why}) — FAILING OPEN, admitting ${requestG} GiB ` +
        `(the unbounded status quo, not a bound)`,
    };
  }
  const base = {
    requestG,
    committedG: commitment.committedG,
    budgetG,
    scopes: commitment.scopes.length,
    unbounded: commitment.unbounded,
  };

  if (!commitment.measured) {
    return {
      ...base,
      admit: true,
      reason: 'admitted-unmeasurable',
      detail: `${commitment.detail} — FAILING OPEN, admitting ${requestG} GiB (the unbounded status quo, not a bound)`,
    };
  }

  // A run with no live peers is never refused: refusing it could only ever be the budget
  // being misconfigured below one run's cap, and the cost of that mistake is a frozen `main`.
  if (commitment.scopes.length === 0) {
    return {
      ...base,
      admit: true,
      reason: 'admitted-sole-run',
      detail: `checkpoint-memory: no live checkpoint scopes — admitting ${requestG} GiB (budget ${budgetG} GiB)`,
    };
  }

  const wouldCommitG = commitment.committedG + requestG;
  if (wouldCommitG <= budgetG) {
    return {
      ...base,
      admit: true,
      reason: 'admitted',
      detail:
        `checkpoint-memory: admitting ${requestG} GiB — ${commitment.committedG.toFixed(1)} + ${requestG} = ` +
        `${wouldCommitG.toFixed(1)} GiB of ${budgetG} GiB budget across ${commitment.scopes.length} live scope(s)`,
    };
  }

  // WI-10006274: a small run may overcommit the budget by a bounded allowance. Without it,
  // three Papercusp-scale runs (40 GiB each against a 125 GiB budget) defer every small pot's
  // gate until one of them finishes, and a working-copy pot's standing PR waits with it. The
  // budget is a FRACTION of the host, so the allowance stays well inside physical memory, and
  // the total can never exceed budget + allowance: large runs still need the plain budget.
  const smallRunCeilingG = budgetG + CHECKPOINT_SMALL_RUN_ALLOWANCE_G;
  if (requestG <= CHECKPOINT_SMALL_RUN_MAX_G && wouldCommitG <= smallRunCeilingG) {
    return {
      ...base,
      admit: true,
      reason: 'admitted-small-run',
      detail:
        `checkpoint-memory: admitting small run ${requestG} GiB — ${commitment.committedG.toFixed(1)} + ${requestG} = ` +
        `${wouldCommitG.toFixed(1)} GiB, over the ${budgetG} GiB budget but within the ` +
        `${CHECKPOINT_SMALL_RUN_ALLOWANCE_G} GiB small-run allowance (${smallRunCeilingG} GiB)`,
    };
  }

  return {
    ...base,
    admit: false,
    reason: 'over-budget',
    detail:
      `checkpoint-memory: DEFERRING ${requestG} GiB — ${commitment.committedG.toFixed(1)} GiB already committed by ` +
      `${commitment.scopes.length} live scope(s); ${wouldCommitG.toFixed(1)} GiB would exceed the ${budgetG} GiB budget` +
      (commitment.unbounded > 0 ? ` (plus ${commitment.unbounded} uncounted unbounded scope(s))` : ''),
  };
}
