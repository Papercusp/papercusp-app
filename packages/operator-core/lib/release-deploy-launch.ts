/**
 * release-deploy-launch — the agent-facing deploy lever's launch + status primitives
 * (release-pipeline-resilience-2026-06-09 P-015 / deploy-trigger-and-gate-unblock-2026-06-21).
 *
 * The `release:deploy` MCP tool wraps these. Why a separate module: the launch logic
 * fires a DETACHED deploy (the deploy RESTARTS the very :3070 operator that hosts the
 * tool — an awaited child deploy-cli is killed by its own restart before returning;
 * root-caused 2026-06-06, see release-actions.ts). Keeping the launch + the pure
 * status/recommendation computation here makes both unit-testable WITHOUT firing a real
 * deploy (inject the spawn seam / pass a snapshot), and keeps the tool file thin.
 *
 * Design (owner-confirmed, deploy-trigger D-003): build on the EXISTING deploy chokepoint
 * `apps/operator/lib/release/deploy-cli.ts` — no new deploy logic. operator-core MUST NOT
 * import `apps/operator/lib/release/*` (wrong dependency direction + that lib carries a
 * deploy/rollback surface), so this SHELLS OUT to the CLI via tsx, mirroring
 * `harness/routines/release-actions.ts`'s auto-serve launch. The live auto-serve routine is
 * left untouched; the few small launch primitives (the unit name, the tsx/root resolution)
 * are duplicated BY VALUE — the codebase's standing convention for these cross-tier literals
 * (see the `__DEPLOY_PLAN__` marker comment in release-actions.ts / deploy-cli.ts).
 */

import { spawn } from 'node:child_process';
import { createTextCollector } from './child-output.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GitPipelineSnapshot, RoutineInfo } from './git-pipeline-stats';
import { gitPipelineSnapshot, releaseTriggerControlBlockReason } from './git-pipeline-stats';
import { evaluateReleaseTriggerFireStale } from './release/release-trigger-fire-stale';
import { summarizeFreezeAndConverge } from './release/freeze-disposition';
import {
  buildDeployTerminalShell,
  readDeployTerminalMarker,
  RELEASE_DEPLOY_UNIT,
  type DeployTerminalMarker,
} from './release-deploy-terminal';
import { isRecordedInconclusiveStatus } from './release/gate-abort-status';
import { isRecordableVerdict } from './release/gate-verdict-target';
import { resolveManualRunAuthority } from './release/manual-run-authority';
import {
  readLiveReleaseCertification,
  type LiveReleaseCertification,
} from './release/live-release-certification';
import type { ReleaseTraceManualRunAuthority } from './release-trace';
import { SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS } from './systemd-scope';

/**
 * The fixed transient systemd unit the detached deploy runs as. MUST match
 * `AUTO_DEPLOY_UNIT` in `harness/routines/release-actions.ts` — systemd-run refuses a
 * second unit with the same name while one is active, so sharing it makes a MANUAL deploy
 * (this lever) and the AUTO-serve deploy mutually exclusive: one release checkout, one
 * deploy at a time. A concurrent attempt returns "deploy already in flight" instead of two
 * deploys racing the same checkout (which storms the live :3070 operator).
 */
export const DEPLOY_UNIT = RELEASE_DEPLOY_UNIT;

/** The integration tree the deploy operates in. Explicit env (set in the :3070 unit env at
 *  the release-gate cutover) so it stays correct after the operator itself runs from the
 *  release checkout. Mirrors release-actions.ts `integrationRoot()`. */
export function integrationRoot(): string {
  return process.env.PAPERCUSP_INTEGRATION_ROOT ?? path.resolve(process.cwd(), '..', '..');
}

/** Absolute tsx bin in the integration tree (the systemd unit can't depend on the manager
 *  PATH resolving a project-local `tsx` — EI-193). Mirrors release-actions.ts. */
export function tsxBin(root: string): string {
  return path.join(root, 'node_modules/.bin/tsx');
}

// ─── In-flight detection (EI-18724155280048738) ───────────────────────────────

/**
 * Is a deploy RUNNING right now? The signal that was missing, and the reason a caller
 * could not tell "the trigger did nothing" from "the trigger started a deploy".
 *
 * EI-18724155280048738: `release:deploy{op:trigger}` can return a transport error
 * (`CONNECTION_CLOSED` against PgBouncer :6432) even though the handler ran to completion and
 * the deploy launched — the audit_log for the 2026-07-26 16:09Z incident records
 * `launched:true` for the trigger whose caller saw only the error. The sanctioned recovery was
 * "don't retry blind, check with `ps`" — but `ps` RACES the spawn: `systemd-run` returns as
 * soon as the unit is STARTED, while the `bash`→`tsx`→deploy-cli child tree takes ~20s more to
 * become visible. Every signal available in that window (`ps`, `op:status`'s
 * `green-deployable`, the operator journal) reads exactly like "nothing happened", which is
 * precisely the reading that invites a second trigger against the shared release checkout.
 *
 * systemd is the race-free authority BY CONSTRUCTION: `systemd-run --unit=` only exits 0 once
 * the unit exists, so the unit is queryable strictly BEFORE the child is `ps`-visible — it
 * covers the whole window `ps` misses. (The unit is also what already enforces one-deploy-at-
 * a-time; see DEPLOY_UNIT. This just reads the state that guard was relying on implicitly.)
 *
 * The log mtime (the filer's suggested discriminator) is kept as CORROBORATION only: the log
 * is `>`-truncated per run, so it is a decent freshness tell but it cannot distinguish a
 * running deploy from one that just exited, and it is absent entirely before the first write.
 */
export interface DeployInFlight {
  /** True iff the transient deploy unit is currently activating/active/deactivating. */
  active: boolean;
  unit: string;
  /** systemd `ActiveState` (inactive | activating | active | deactivating | failed), null if unreadable. */
  activeState: string | null;
  /** systemd `SubState` (e.g. running, exited), null if unreadable. */
  subState: string | null;
  /** Wall-clock start of the deploy process, when systemd's timestamp could be parsed. */
  startedAtMs: number | null;
  /** Where the running deploy writes — the file to tail for `__DEPLOY_PLAN__` / progress. */
  logPath: string;
  /** Corroboration only (see above); null when the log does not exist. */
  logMtimeMs: number | null;
  /** Durable last terminal outcome. Populated even after --collect erases the unit. */
  terminal?: DeployTerminalMarker | null;
  /** How `active` was decided — 'systemd-unavailable' means treat `active:false` as UNKNOWN. */
  source: 'systemd' | 'systemd-unavailable';
}

/** ActiveState values that mean the unit still has work in flight. `deactivating` counts:
 *  the deploy's own :3070 restart happens late, so the deploy is not settled until inactive. */
const IN_FLIGHT_ACTIVE_STATES = new Set(['activating', 'active', 'deactivating']);

/** Pure: parse `systemctl show`'s `Key=Value` lines into a lookup. Exported for testing. */
export function parseSystemctlShow(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Pure: derive the in-flight verdict from systemctl's properties + the log's mtime.
 * Exported so the decision is unit-testable without a systemd on the box.
 *
 * `ExecMainStartTimestamp` is systemd's human format ("Sun 2026-07-26 12:09:43 EDT"). V8 parses
 * the common US zone abbreviations but not every zone a host might run in, so an unparseable
 * timestamp degrades to null rather than to a wrong instant — `active` never depends on it.
 */
export function computeDeployInFlight(args: {
  props: Record<string, string> | null;
  logPath: string;
  logMtimeMs: number | null;
  terminal?: DeployTerminalMarker | null;
}): DeployInFlight {
  const { props, logPath, logMtimeMs, terminal = null } = args;
  if (!props) {
    return {
      active: false,
      unit: DEPLOY_UNIT,
      activeState: null,
      subState: null,
      startedAtMs: null,
      logPath,
      logMtimeMs,
      terminal,
      source: 'systemd-unavailable',
    };
  }
  const activeState = props.ActiveState ?? null;
  const parsed = Date.parse(props.ExecMainStartTimestamp ?? '');
  return {
    active: !!activeState && IN_FLIGHT_ACTIVE_STATES.has(activeState),
    unit: DEPLOY_UNIT,
    activeState,
    subState: props.SubState ?? null,
    startedAtMs: Number.isFinite(parsed) ? parsed : null,
    logPath,
    logMtimeMs,
    terminal,
    source: 'systemd',
  };
}

export interface ReadDeployInFlightDeps {
  spawnFn?: SpawnLike;
  /** Injectable stat seam (default: fs.statSync mtime, or null when absent). */
  logMtimeMs?: () => number | null;
  /** Injectable durable terminal-marker seam. */
  terminalMarker?: () => DeployTerminalMarker | null;
}

/** Read whether a deploy is running right now. Never throws — an unreadable systemd degrades
 *  to `source:'systemd-unavailable'`, which a caller must read as UNKNOWN, not as "idle". */
export function readDeployInFlight(deps: ReadDeployInFlightDeps = {}): Promise<DeployInFlight> {
  const logPath = `/tmp/${DEPLOY_UNIT}.log`;
  const spawnFn = deps.spawnFn ?? spawn;
  const readMtime =
    deps.logMtimeMs ??
    (() => {
      try {
        return fs.statSync(logPath).mtimeMs;
      } catch {
        return null;
      }
    });
  const logMtimeMs = readMtime();
  const terminal = (deps.terminalMarker ?? readDeployTerminalMarker)();

  return new Promise<DeployInFlight>((resolve) => {
    const stdoutOut = createTextCollector();
    let settled = false;
    const done = (props: Record<string, string> | null) => {
      if (settled) return;
      settled = true;
      resolve(computeDeployInFlight({ props, logPath, logMtimeMs, terminal }));
    };
    try {
      const child = spawnFn('systemctl', [
        '--user',
        'show',
        DEPLOY_UNIT,
        '--property=ActiveState',
        '--property=SubState',
        '--property=ExecMainStartTimestamp',
      ]);
      stdoutOut.attach(child.stdout);
      child.on('error', () => done(null));
      child.on('close', (code: number | null) =>
        done(code === 0 ? parseSystemctlShow(stdoutOut.text()) : null),
      );
    } catch {
      done(null);
    }
  });
}

// ─── Status / recommendation (pure) ───────────────────────────────────────────

/** Where the live :3070 stands relative to the green pin + why a deploy is/ isn't possible. */
export type DeployStateKind =
  | 'up-to-date' // live :3070 is at the green pin; nothing to deploy
  | 'deploy-in-flight' // EI-18724155280048738: a deploy is RUNNING right now — do not trigger another
  | 'green-deployable' // green code is ahead + deployable but not yet live (the trigger case)
  | 'live-certification-required' // P-010: code is green, but exact-SHA live qualification is absent/stale/unreadable
  | 'live-certification-failed' // P-010: the exact-SHA specialized live verdict is RED
  | 'release-trigger-paused' // a deliberate release safety hold blocks ordinary deploys
  | 'release-trigger-unavailable' // release-trigger is absent/inactive without usable pause provenance
  | 'gate-red' // the gate is RED — the green pin can't advance until the reds are fixed
  | 'gate-verdict-stale' // WI-4489: the blob says red, but the verdict is superseded/unverified — colour UNKNOWN, not red
  | 'gate-paused' // P-009: the checkpoint routine is deliberately paused under recorded control authority
  | 'gate-wedged' // the green-checkpoint isn't firing or produced no verdict — surface to an operator
  | 'staging-buffered' // staging has commits awaiting the next (green) checkpoint — normal, just wait
  | 'unknown';

export interface CheckpointExecutionStatus {
  /** Current execution truth. A running/paused/blocked state has no implied code verdict. */
  state: 'running' | 'paused' | 'blocked' | 'idle' | 'unknown';
  /** Which existing authority produced the state above. */
  authority:
    | 'manual-unit'
    | 'shared-run-lock'
    | 'process-authority'
    | 'routine-control'
    | 'live-probe'
    | 'unmeasured';
  /** The run's own published phase, only while a measured run is live. */
  phase: string | null;
  /** Exact current blocker when the gate is paused/blocked/unreadable. */
  blocker: string | null;
  /** True only while a measured live run is still producing its verdict. */
  verdictPending: boolean;
  /** Probe health is separate from run liveness: a failed systemd probe can still be
   * corroborated by the independent shared run-lock. */
  probe: {
    status: 'ok' | 'failed' | 'unmeasured';
    detail: string | null;
  };
}

export interface DeployStatus {
  gate: {
    green: boolean;
    consecutiveReds: number;
    /**
     * Tri-state gate evidence. True/false are returned only when the in-routine counters or
     * watchdog establish a verdict; null means neither source could establish one (for example,
     * incomplete red/age data or a suppressed watchdog reading).
     */
    stalled: boolean | null;
    fireStale: boolean;
    fireStaleReason: string | null;
    lastGreenAtMs: number | null;
    /** WI-4489: the recorded RED is not trustworthy (superseded by a pin advance, or never
     *  verified because the routine's runs are being skipped). A stale red must NOT be reported as
     *  the gate's colour, and must NOT send anyone to fix the tests it names. */
    verdictStale: boolean;
    verdictStaleReason: string | null;
    lastFixerStatus: string | null;
    lastFixerCandidate: string | null;
    flakyWorkspaces: string[];
    /** WI-4533's `gate_health.failingTests`, threaded through to the agent-facing status
     *  surface (EI-10902) — the gate's OWN answer to "which tests are failing", already
     *  captured but previously stranded in the snapshot with no consumer. Empty on a green
     *  gate; never trust it when `verdictStale`. */
    failingTests: string[];
    /** True only when the sibling failingTests list is a real verdict measurement. */
    failingTestsMeasured?: boolean | null;
    /** EI-18832825158594027: true when the sibling failingTests list was inherited from an
     *  earlier observation of the same candidate rather than measured by the tick that produced
     *  this verdict. Never a current blame list. */
    failingTestsCarriedForward?: boolean | null;
    /** Normalized persisted frozen-repair queue; null/absent means no readable queue. */
    repairQueue?: GitPipelineSnapshot['gate']['repairQueue'];
    /** P-025: explicit value/absent/unreadable state for the persisted queue read. */
    repairQueueRead?: GitPipelineSnapshot['gate']['repairQueueRead'];
    /** WI-2141736 P-004: freeze-and-converge's own state + reason. Null = NOT MEASURED. */
    freezeAndConverge?: GitPipelineSnapshot['gate']['freezeAndConverge'];
    /** EI-10902: the most recent green-checkpoint TICK, from the append-only pipeline-events
     *  history (`harness_shared.pipeline_events`, mig 177) — whichever runner produced it
     *  (routine or manual `release:checkpoint-run`, WI-4494). Answers "what did the last gate
     *  tick decide, and on what code?" without grepping log files: the candidate sha it tested,
     *  the sha main was at BEFORE this tick (`from`), the verdict, and the exact per-run log
     *  path (WI-4957) to open for detail. Null only when no green_checkpoint event has been
     *  recorded yet for this install (a fresh/never-ticked gate), or when the newest
     *  event is a queue-owned repair hold whose queue is now absent and whose run-lock
     *  is measured idle. In that case the event remains append-only history, but exposing
     *  it as the live `lastVerdict` would resurrect a blocker its producer no longer owns. */
    lastVerdict: {
      tickAtMs: number;
      /** The commit this tick actually tested (12-char sha), when the CLI recorded one. */
      candidate: string | null;
      /** The sha `ready`/main was at BEFORE this tick (12-char sha) — the closest recorded
       *  analog of what the CLI's own log-filename calls "base". */
      from: string | null;
      /** The tick's outcome vocabulary (advanced | up-to-date | not-green | not-fast-forward |
       *  create-failed | error | skipped-locked | ...) — see buildCheckpointDetail's callers. */
      status: string;
      /** The exact per-run log this tick wrote (WI-4957), when recorded. */
      logPath: string | null;
    } | null;
  };
  deploy: {
    deployedSha: string | null;
    stagingHeadSha: string | null;
    greenPinSha: string | null;
    deployedBehindStaging: number | null;
    greenPinBehindStaging: number | null;
    deployedBehindGreenPin: number | null;
    greenPinAtStagingHead: boolean | null;
    deployedAtMs: number | null;
  };
  /** EI-18724155280048738: is a deploy RUNNING right now? The queryable state between "not
   *  started" and "deployedSha moved" — without it the whole early window of a live deploy is
   *  indistinguishable from a trigger that did nothing. Null only when the status was computed
   *  WITHOUT probing (the pure `computeDeployStatus(snap)` path, e.g. the staleness watchdog);
   *  `readDeployStatus()` always populates it. */
  deployInFlight: DeployInFlight | null;
  /** Last detached shell outcome, retained after systemd --collect removes the unit. */
  deployTerminal: DeployTerminalMarker | null;
  /** EI-20234052054064013: the live green-checkpoint singleton probe. This is separate from
   *  completed gate-health metadata: an active run (including an in-process auto-refire) is
   *  authoritative evidence that a fresh verdict is already being produced. Null means the
   *  snapshot was not probed (or the probe was unavailable); an object with `active:false` is
   *  preserved when the probe explicitly reports idle. */
  checkpointRunInFlight: GitPipelineSnapshot['activeRun'];
  /** P-009: one truthful execution/control projection. This distinguishes a measured
   * idle probe from an externally-held run, names the current phase/blocker, and never
   * upgrades "running" or "re-armed" into a green/red verdict. */
  checkpoint: CheckpointExecutionStatus;
  /** The same live authority predicate used by release:trace and release:checkpoint-run.
   * When withheld, status must not recommend a manual checkpoint that the executor refuses. */
  manualRunAuthority: ReleaseTraceManualRunAuthority | null;
  /** The SAME control row that gates the scheduled release-trigger. Ordinary manual triggers
   *  must not route around it; force remains the explicit override. */
  releaseTrigger: {
    active: boolean | null;
    cron: RoutineInfo['cron'];
    lastFiredAtMs: RoutineInfo['lastFiredAtMs'];
    nextFireAtMs: RoutineInfo['nextFireAtMs'];
    pause: RoutineInfo['pause'];
    blocked: boolean;
    blockReason: string | null;
    fireStale: boolean;
    fireStaleReason: string | null;
  };
  /** P-010: specialized live/federation qualification for the exact green pin.
   * Null only on pure legacy callers that did not supply a reader, or when no
   * green pin exists yet. `readDeployStatus()` always measures it when a pin exists. */
  liveCertification: LiveReleaseCertification | null;
  /** True iff `trigger` would do something safe + useful: there is green code ahead of the
   *  live deploy AND the gate is not currently red/wedged. */
  canTriggerGreen: boolean;
  /** True iff the live :3070 is already at the green pin (nothing green to deploy). */
  nothingToDeploy: boolean;
  state: DeployStateKind;
  /** The decision-tree recommendation (fix-reds > quarantine > owner-force; never silent-wait). */
  recommendation: string;
  /** One human-readable line. */
  summary: string;
  /** Non-fatal problems gathering the snapshot. */
  errors: string[];
}

/**
 * Pure: derive the deploy status + the decision-tree recommendation from a pipeline snapshot.
 * Exported for unit testing — no I/O.
 */
export function computeDeployStatus(
  snap: GitPipelineSnapshot,
  inFlight: DeployInFlight | null = null,
  liveCertification?: LiveReleaseCertification | null,
  manualRunAuthority: ReleaseTraceManualRunAuthority | null = null,
  /** WI-2141736 P-004: clock for the freeze-and-converge staleness note appended to
   *  `summary`. Defaults to the real clock so every existing caller is unchanged; tests
   *  pin it so the "last observed Nm ago" wording is deterministic. */
  nowMs: number = Date.now(),
): DeployStatus {
  const g = snap.gate;
  const d = snap.deploy;
  /**
   * A stale last-fire/last-green timestamp is not evidence that the checkpoint
   * scheduler is wedged when the run-lock probe has positively observed a live
   * checkpoint process.  Keep the raw snapshot fork-free for callers that do
   * not opt into the probe, but make a probed live run authoritative for this
   * status decision.  Unknown (`null`) and probed-idle (`active:false`) must
   * remain distinct from a positive liveness reading.
   */
  const checkpointRunInFlight = snap.activeRun;
  const checkpointRunActive = checkpointRunInFlight?.active === true;
  const fireStale = g.fireStale && !checkpointRunActive;
  const fireStaleReason = fireStale ? g.fireStaleReason : null;
  const activeCheckpointRecommendation = checkpointRunActive
    ? `A green-checkpoint run is ACTIVE${checkpointRunInFlight?.candidate ? ` on candidate ${checkpointRunInFlight.candidate}` : ''}` +
      `${checkpointRunInFlight?.currentPhase ? ` (phase: ${checkpointRunInFlight.currentPhase})` : ''}` +
      `${checkpointRunInFlight?.heldExternally ? ' under the shared run-lock' : ''}` +
      `${checkpointRunInFlight?.refireObserved ? ` (auto-refire from ${checkpointRunInFlight.initialCandidate ?? 'an earlier candidate'} observed)` : ''}. ` +
      'Do NOT run `release:checkpoint-run` again; re-check this status after the active run completes.'
    : null;
  // EI-10902: the most recent green_checkpoint pipeline event (snap.recent is newest-first) —
  // whatever runner produced it. `detail` carries the shape buildCheckpointDetail wrote
  // (candidate/from/failingTests/logPath/runId), already persisted for every tick; this is
  // the first read surface exposing it to an agent instead of a raw log grep.
  const lastCheckpointEvent = (snap.recent ?? []).find((e) => e.kind === 'green_checkpoint');
  // D-067 / WI-41252: repair-in-progress and repair-staging-mismatch are queue-owned
  // NO-VERDICT events, not durable truth about the candidate. `git-pipeline-stats`
  // deliberately clears `gate.inconclusive` once the authoritative repair_queue is absent.
  // When the independent run-lock probe is also positively idle, keeping that append-only
  // event in the live `lastVerdict` slot resurrects the dead queue, while the old red's
  // failingTests beside it send responders at historical failures. Preserve the event in
  // pipeline history, but remove it from this CURRENT projection.
  const latestCheckpointIsStaleRepairHold =
    lastCheckpointEvent !== undefined &&
    (lastCheckpointEvent.status === 'repair-in-progress' || lastCheckpointEvent.status === 'repair-staging-mismatch') &&
    g.inconclusive == null &&
    checkpointRunInFlight?.active === false;
  const lastVerdict =
    lastCheckpointEvent && !latestCheckpointIsStaleRepairHold
      ? {
          tickAtMs: lastCheckpointEvent.createdAtMs,
          candidate:
            typeof lastCheckpointEvent.detail?.candidate === 'string' ? lastCheckpointEvent.detail.candidate : null,
          from: typeof lastCheckpointEvent.detail?.from === 'string' ? lastCheckpointEvent.detail.from : null,
          status: lastCheckpointEvent.status,
          logPath: typeof lastCheckpointEvent.detail?.logPath === 'string' ? lastCheckpointEvent.detail.logPath : null,
        }
      : null;
  const candidateFossil = g.verdictStaleReasonCode === 'candidate-fossil' || lastVerdict?.status === 'candidate-fossil';
  const candidateFossilAuthority =
    candidateFossil && manualRunAuthority?.withheld === true && manualRunAuthority.governingRef.trim() !== ''
      ? manualRunAuthority
      : null;
  const candidateFossilAuthorityRecommendation = candidateFossilAuthority
    ? `Candidate selection is already owned by ${candidateFossilAuthority.governingRef}: ` +
      `${candidateFossilAuthority.reason} Do NOT launch \`release:checkpoint-run\` or add another ` +
      `exclusive materializer; the recorded authority holder and the scheduled green-checkpoint ` +
      `routine are the sole paths that should produce the next fresh candidate verdict.`
    : null;
  // A green_checkpoint event is not necessarily a verdict: skipped-* means the suite never
  // judged the candidate (for example, skipped-locked means another run held the lock). Keep
  // exposing that event as `lastVerdict` for diagnostics, but do not let the rolling gate-health
  // fields turn a fresh no-op into the reassuring "wait one cycle" state. The active-run probe is
  // authoritative when present: a non-verdict tick is expected while that run is still producing
  // the real outcome, so it must not be classified as a wedge yet.
  const latestCheckpointIsNonVerdict =
    lastCheckpointEvent !== undefined &&
    !latestCheckpointIsStaleRepairHold &&
    (!isRecordableVerdict(lastCheckpointEvent.status) || isRecordedInconclusiveStatus(lastCheckpointEvent.status));
  // A completed inconclusive tick is different from a skipped tick: the former ran far enough
  // to publish its own no-verdict reason (for example `repair-in-progress`), while the latter
  // never started the suite (for example `skipped-locked`). When the rolling gate-health cache
  // is also stale, prefer the event's first-hand disposition over the generic freshness
  // evaluator's historical run-lock inference. Otherwise a completed repair run is reported as
  // lock contention, sending the reader to hunt for a lock that was not held by that run.
  const latestCompletedNoVerdictReason =
    latestCheckpointIsNonVerdict &&
    !checkpointRunActive &&
    lastCheckpointEvent &&
    !lastCheckpointEvent.status.startsWith('skipped-')
      ? `the latest green-checkpoint run completed without producing a gate verdict (reason: ${lastCheckpointEvent.status})` +
        (typeof lastCheckpointEvent.detail?.logPath === 'string'
          ? `; run log: ${lastCheckpointEvent.detail.logPath}`
          : '') +
        ` — this is not evidence of run-lock contention`
      : null;
  const checkpointRoutine = snap.routines.greenCheckpoint;
  const checkpointProbe =
    checkpointRunInFlight == null
      ? { status: 'unmeasured' as const, detail: null }
      : checkpointRunInFlight.probeFailed
        ? { status: 'failed' as const, detail: checkpointRunInFlight.probeDetail ?? null }
        : { status: 'ok' as const, detail: null };
  const measuredRunActive =
    checkpointRunInFlight?.active === true &&
    (checkpointRunInFlight.probeFailed !== true ||
      checkpointRunInFlight.heldExternally === true ||
      checkpointRunInFlight.preLockAuthority !== undefined);
  const terminalFailure =
    checkpointRunInFlight?.active === false &&
    checkpointRunInFlight.terminalMarker === false &&
    checkpointRunInFlight.terminalEvidence?.abnormal === true
      ? checkpointRunInFlight.terminalEvidence
      : null;
  const checkpoint: CheckpointExecutionStatus = measuredRunActive
    ? {
        state: 'running',
        authority: checkpointRunInFlight?.preLockAuthority
          ? 'process-authority'
          : checkpointRunInFlight?.heldExternally
            ? 'shared-run-lock'
            : 'manual-unit',
        phase: checkpointRunInFlight?.currentPhase ?? null,
        blocker: null,
        verdictPending: true,
        probe: checkpointProbe,
      }
    : checkpointRoutine?.active === false && checkpointRoutine.pause
      ? {
          state: 'paused',
          authority: 'routine-control',
          phase: null,
          blocker: checkpointRoutine.pause.reason ?? 'green-checkpoint is paused without a recorded reason',
          verdictPending: false,
          probe: checkpointProbe,
        }
      : checkpointRunInFlight?.probeFailed
        ? {
            state: 'unknown',
            authority: 'unmeasured',
            phase: null,
            blocker: checkpointRunInFlight.probeDetail ?? 'green-checkpoint liveness probe failed',
            verdictPending: false,
            probe: checkpointProbe,
          }
        : terminalFailure
          ? {
              state: 'blocked',
              authority: 'live-probe',
              phase: null,
              blocker:
                `checkpoint terminated ${terminalFailure.serviceResult}/` +
                `${terminalFailure.exitCode}:${terminalFailure.exitStatus} without a verdict`,
              verdictPending: false,
              probe: checkpointProbe,
            }
          : latestCheckpointIsNonVerdict
            ? {
                state: 'blocked',
                authority: 'live-probe',
                phase: null,
                blocker: `latest checkpoint ended '${lastCheckpointEvent!.status}' without a gate verdict`,
                verdictPending: false,
                probe: checkpointProbe,
              }
            : checkpointRunInFlight?.active === false
              ? {
                  state: 'idle',
                  authority: 'live-probe',
                  phase: null,
                  blocker: null,
                  verdictPending: false,
                  probe: checkpointProbe,
                }
              : {
                  state: 'unknown',
                  authority: 'unmeasured',
                  phase: null,
                  blocker: null,
                  verdictPending: false,
                  probe: checkpointProbe,
                };
  const verdictStale = g.verdictStale || latestCheckpointIsStaleRepairHold;
  const verdictStaleReason = latestCompletedNoVerdictReason ?? (g.verdictStale
    ? g.verdictStaleReason
    : latestCheckpointIsStaleRepairHold
      ? `the latest ${lastCheckpointEvent!.status} event is historical: its repair queue is absent and the checkpoint run-lock is measured idle`
      : null);
  // EI-18646778682511611: a partial advance ('advanced-prefix', P-016/D-010) resets
  // `consecutiveReds` to 0 by design (trackGateStall treats it as "main is advancing,
  // not stalled") — but it is EXPLICITLY the case where the CANDIDATE/tip is still red
  // (green-checkpoint.ts's tryLongestGreenPrefix returns `green: false` for it on
  // purpose: only a longest-green-PREFIX shipped, the tip's own failures are real and
  // unfixed, tracked separately via the release-fixer dispatch). Reusing the stall-streak
  // counter as "the gate is green" therefore reported gate.green=true immediately after
  // a run with reproducing, non-flaky test failures — silently laundering a confirmed
  // regression into a green-looking status with no accountable follow-up. `consecutiveReds
  // === 0` answers "is main stalled"; it must NOT also answer "is the last-evaluated
  // candidate green" when the two diverge, so exclude the one status where they do.
  const lastVerdictWasPartialRed = lastVerdict?.status === 'advanced-prefix';
  // EI-20706962612084953: 'advanced-prefix' was the one status KNOWN to diverge — it was never
  // the only one. The writer's `reset` class also zeroes the streak for a genuinely NOT-GREEN
  // verdict whenever the release pin moved (`main` advancing via a path the routine never saw),
  // so the exclusion above left `consecutiveReds === 0` still reporting GREEN for a run that
  // recorded red — the same laundering this line was written to stop, one status over.
  // `gate_health.lastVerdict` is the writer's own statement of what the verdict WAS, so it
  // settles the question generally instead of one status at a time; `null` (a blob written
  // before the marker existed) degrades to exactly the previous behaviour.
  // (named `recordedVerdict`, not `lastVerdict`, precisely because `lastVerdict` above is a
  // DIFFERENT thing in this same scope — the checkpoint EVENT object. Two shapes under one
  // name is how a reader ends up asserting on the wrong one.)
  const lastVerdictRecordedNotGreen = g.recordedVerdict === 'not-green';
  const gateGreen = g.consecutiveReds === 0 && !fireStale && !lastVerdictWasPartialRed && !lastVerdictRecordedNotGreen;
  // P-009: gate_health is a cache. Once its verdict is stale, a fresh run is in flight,
  // the routine is deliberately paused, or the latest tick produced no verdict, its file
  // list is historical context rather than a current blame list. Suppress it at the shared
  // status writer so every downstream surface gets the same truthful empty list.
  const suppressHistoricalFailingTests =
    verdictStale || checkpoint.state === 'running' || checkpoint.state === 'paused' || checkpoint.state === 'blocked';
  const failingTests = suppressHistoricalFailingTests ? [] : (g.failingTests ?? []);
  const failingTestsMeasured = suppressHistoricalFailingTests ? false : (g.failingTestsMeasured ?? null);
  // EI-18832825158594027: when the list is suppressed above it is `[]`, so there is nothing
  // inherited left to label — false. Otherwise forward the writer's marker so downstream
  // surfaces can say the names are inherited instead of implying a fresh measurement.
  const failingTestsCarriedForward = suppressHistoricalFailingTests
    ? false
    : (g.failingTestsCarriedForward ?? false);
  const deployedBehindGreenPin = d.deployedBehindGreenPin;
  const greenPinBehindStaging = d.greenPinBehindStaging;
  const releaseTriggerRow = snap.routines.releaseTrigger;
  const releaseTriggerBlockReason = releaseTriggerControlBlockReason(releaseTriggerRow);
  const releaseTriggerBlocked = releaseTriggerBlockReason !== null;
  const releaseTriggerFireStale = evaluateReleaseTriggerFireStale(
    {
      active: releaseTriggerRow?.active ?? null,
      lastFiredMs: releaseTriggerRow?.lastFiredAtMs ?? null,
      deployedBehindGreenPin,
    },
    nowMs,
  );

  // Green code ahead of the live deploy that we could ship right now.
  const hasGreenAhead = typeof deployedBehindGreenPin === 'number' && deployedBehindGreenPin > 0;
  const nothingToDeploy = deployedBehindGreenPin === 0;
  // The green pin ("ready") is green BY CONSTRUCTION — it is the last commit that PASSED the
  // green checkpoint. Expediting its deploy therefore only requires that the pin is AHEAD of the
  // live deploy; it must NOT also demand the gate be *currently* green. A later red (or a wedged
  // checkpoint) must never strand an already-green pin — the auto-serve itself ships on "green
  // main ahead of the release checkout" regardless of current gate color. Coupling this to
  // gateGreen wedged op:trigger in exactly the 'green-deployable' state whose own recommendation
  // tells you to run it (deploy-trigger-and-gate-unblock-2026-06-21 follow-up).
  // EI-18724155280048738: a deploy already RUNNING is not a triggerable one. Refusing here (with
  // a definite reason) is strictly better than letting the caller fire and rely on systemd-run
  // exiting 1 on the duplicate unit — that path reports the hedged "a deploy MAY already be in
  // flight", which is the same can't-tell-two-states-apart defect one layer down.
  // Undefined preserves the pure function's historical fixture/caller contract. The
  // production read path always supplies a measured certificate when a green pin exists.
  const certificationAllowsDeploy = liveCertification === undefined || liveCertification?.certified === true;
  const canTriggerGreen = hasGreenAhead && !inFlight?.active && !releaseTriggerBlocked && certificationAllowsDeploy;

  // WI-4489: a RED is only authoritative if its verdict is CURRENT. `gate_health` is a cache that a
  // starved writer freezes: a `skipped-locked` fire is a no-op that leaves the blob untouched while
  // still refreshing `last_fired_at`, so `fireStale` reads FRESH over an hours-old red. Reporting
  // that as `gate-red` sends responders to fix tests that already pass — and (observed 2026-07-12)
  // the fixer's manual suite runs then HOLD the lock that keeps the routine skipping, so the stale
  // red sustains itself. Treat an unverified red as "colour unknown", never as red.
  const redAuthoritative = g.consecutiveReds > 0 && !verdictStale;

  let state: DeployStateKind;
  let recommendation: string;
  if (inFlight?.active) {
    // FIRST in the chain on purpose: every other state below describes where the pipeline is
    // PARKED, and each of them (green-deployable most of all) reads as "nothing is happening"
    // while a deploy is in fact mid-run. A running deploy is the answer to "why isn't my change
    // live yet", so it must win over the parked-state descriptions.
    state = 'deploy-in-flight';
    const startedAgo =
      typeof inFlight.startedAtMs === 'number' ? ` (started ${new Date(inFlight.startedAtMs).toISOString()})` : '';
    recommendation =
      `A deploy is RUNNING right now — systemd unit ${inFlight.unit} is ${inFlight.activeState}${startedAgo}. ` +
      `Do NOT trigger another: the manual lever and the auto-serve share one transient unit, so a second trigger is refused, and a genuine concurrent deploy against the shared release checkout is what that guard exists to prevent. ` +
      `Watch it with \`tail -f ${inFlight.logPath}\` (the \`__DEPLOY_PLAN__\` line marks the plan; the process tree only becomes \`ps\`-visible ~20s in). ` +
      // EI-19448585641887174: this used to recommend "await release:deployed" flatly, and
      // that is only right EARLY in a deploy. The event is emitted at the very END — after
      // the restart AND its health probe (apps/operator/lib/release/deploy.ts L389 restart
      // … L438 emit) — so for a deploy already past its restart it has ALREADY fired, and
      // an await armed now silently waits for the NEXT deploy instead. Reported live: an
      // agent followed this line and burned a 900s timeout. We cannot cheaply decide WHICH
      // side of the restart this deploy is on from here (that needs the serving probe), so
      // state the mechanism and name the check rather than assert the wrong half.
      `To WAIT on it: \`release:deployed\`/\`deploy-failed\` fire only at the END of the deploy, after the restart and its health probe — so if this deploy is already past its restart the event has ALREADY fired, and an await armed now would wait for the NEXT deploy, not this one. ` +
      `Check first with dev:pipeline_position: \`serving.startedSinceCodeChange: true\` means the restart already happened (verify directly, do NOT arm an await). ` +
      `Re-check this status once it finishes to confirm the live sha moved.`;
  } else if (hasGreenAhead && releaseTriggerBlocked) {
    const pause = releaseTriggerRow?.pause;
    state = pause ? 'release-trigger-paused' : 'release-trigger-unavailable';
    recommendation = pause
      ? `A deliberate release safety hold blocks ordinary deploys${pause.pausedBy ? ` (paused by ${pause.pausedBy}` : ''}${pause.pausedAtMs ? ` at ${new Date(pause.pausedAtMs).toISOString()}` : ''}${pause.pausedBy ? ')' : ''}: ${pause.reason ?? 'no reason recorded'}. ` +
        'Do NOT resume the routine or run release:deploy trigger until the recorded hold condition is satisfied. Force remains the explicit audited override.'
      : `${releaseTriggerBlockReason}. Refusing an ordinary deploy while its control state is unavailable; restore/verify the routine control before retrying. Force remains the explicit audited override.`;
  } else if (hasGreenAhead && liveCertification !== undefined && liveCertification?.certified !== true) {
    state = liveCertification?.status === 'failed' ? 'live-certification-failed' : 'live-certification-required';
    recommendation =
      `Green main is ahead, but ordinary deployment is fail-closed on exact-SHA live certification: ` +
      `${liveCertification?.reason ?? 'no certification reading is available'}. ` +
      `The release-trigger will launch or await the independent certification run for ${d.greenPin?.sha?.slice(0, 12) ?? 'the green pin'}; ` +
      `do not force past it unless explicitly accepting an uncertified deployment.`;
  } else if (hasGreenAhead) {
    // There IS green, deployable code that hasn't reached :3070 — the expedite case.
    state = 'green-deployable';
    recommendation =
      `${deployedBehindGreenPin} green commit(s) are deployable but not yet live on :3070. ` +
      `The auto-serve ships these each cycle; to expedite now run release:deploy { op: 'trigger', confirm: true } — it can only ship the green pin (safe even while the gate is currently red).`;
  } else if (checkpoint.state === 'unknown' && checkpoint.probe.status === 'failed') {
    state = 'gate-wedged';
    recommendation =
      `The green-checkpoint liveness probe FAILED: ${checkpoint.blocker}. ` +
      `This is unknown execution state, not an idle reading and not a gate verdict; repair/retry the probe before launching or waiting on a run.`;
  } else if (checkpoint.state === 'paused') {
    state = 'gate-paused';
    recommendation =
      `The green-checkpoint routine is DELIBERATELY PAUSED under recorded control authority: ${checkpoint.blocker}. ` +
      `Cached failing-test names are suppressed because no current verdict is being produced. ` +
      `Do not launch a manual checkpoint around the hold; satisfy its recorded condition and restore the scheduled routine so the next ordinary fire produces the fresh verdict.`;
  } else if (checkpoint.state === 'blocked') {
    state = 'gate-wedged';
    recommendation =
      `${checkpoint.blocker}. The run produced no gate verdict, so cached failing-test names are suppressed. ` +
      `Fix the named execution blocker, then let the scheduled routine fire through for one FRESH guarded verdict; do not substitute a manual checkpoint when plan or control authority requires ordinary scheduled proof.`;
  } else if (latestCheckpointIsNonVerdict && !checkpointRunActive) {
    state = 'gate-wedged';
    recommendation =
      `The latest green-checkpoint tick was '${lastCheckpointEvent!.status}' and produced no gate verdict. ` +
      `The gate's cached health is unverified until a checkpoint actually judges the candidate. ` +
      `Let the scheduled routine fire through for a FRESH verdict; do not substitute a manual checkpoint when plan or control authority requires ordinary scheduled proof, and do not treat this tick as green or red.`;
  } else if (redAuthoritative) {
    state = 'gate-red';
    recommendation =
      `The green gate is RED (${g.consecutiveReds} consecutive red${g.consecutiveReds === 1 ? '' : 's'})` +
      `${g.lastFixerStatus ? `, release-fixer: ${g.lastFixerStatus}` : ''}. ` +
      (checkpointRunActive
        ? `${activeCheckpointRecommendation} Cached failing-test names belong to the prior verdict and are suppressed while this fresh verdict is pending.`
        : failingTests.length === 0
          ? `This verdict names no failing tests — do NOT go hunting for tests. Inspect the checkpoint run log${lastVerdict?.logPath ? ` at ${lastVerdict.logPath}` : ''} or ask the verdict owner for the non-test failure before taking action.`
          : `Your change can't reach the green pin until the reds are fixed. ` +
            `FIX the reds (even out of your lane); if a red is CONFIRMED-unrelated + you can't fix it quickly, quarantine that test by hand (accountably: reason + de-quarantine follow-up); force only with explicit OWNER sign-off. Never silently wait.`);
  } else if (g.consecutiveReds > 0 && verdictStale) {
    // The blob says red, but that red is provably superseded or simply unverified. Do NOT dress it
    // up as green either — the honest state is "we don't know", with the one action that resolves it.
    state = 'gate-verdict-stale';
    recommendation =
      `The gate's health blob reports ${g.consecutiveReds} red(s), but that verdict is STALE — ${verdictStaleReason ?? 'it has been superseded'}. ` +
      `Do NOT chase the failing tests it names; they may already be green (verify by running them before you touch anything). ` +
      (activeCheckpointRecommendation
        ? `${activeCheckpointRecommendation} If the gate keeps reporting 'skipped-locked' after it finishes, let one routine fire through.`
        : (candidateFossilAuthorityRecommendation ??
          `Let the scheduled routine fire through for a FRESH verdict. Do not substitute a manual checkpoint when plan or control authority requires ordinary scheduled proof. If the gate keeps reporting 'skipped-locked', a peer's manual suite runs are holding the run-lock — let one routine fire through.`));
  } else if (fireStale) {
    state = 'gate-wedged';
    recommendation = `The green-checkpoint is WEDGED — not firing (${fireStaleReason ?? 'stale'}). It produces 0 reds because it never ran, so the gate can't advance. Surface this to an operator; the pipeline can't self-heal a non-firing checkpoint.`;
  } else if (typeof greenPinBehindStaging === 'number' && greenPinBehindStaging > 0) {
    state = 'staging-buffered';
    recommendation =
      `${greenPinBehindStaging} staging commit(s) are awaiting the next green-checkpoint (gate is green, it just hasn't promoted them to the pin yet). ` +
      `${activeCheckpointRecommendation ?? 'Wait one checkpoint cycle, then re-check; nothing to do.'}`;
  } else if (nothingToDeploy) {
    state = 'up-to-date';
    recommendation = 'The live :3070 operator is at the green pin — nothing to deploy.';
  } else {
    state = 'unknown';
    recommendation =
      'Could not determine the deploy position from the snapshot (a ref may be unresolved). Inspect dev:pipeline_position / the /admin Git tab.';
  }

  // WI-2141736 P-004: the freeze's own disposition, in prose, on the surface an agent
  // actually reads. Without this the record is structured-only, so "why is the freeze
  // off" stays archaeology for anyone not inspecting the raw payload — the exact gap
  // that let freeze-and-converge sit disabled fleet-wide for a day unnoticed. Null
  // (absent or malformed record) appends NOTHING rather than a healthy-sounding default.
  const freezeLine = summarizeFreezeAndConverge(
    { freezeAndConverge: g.freezeAndConverge ?? null },
    nowMs,
  );
  const summary =
    `[${state}] ${recommendation}` + (freezeLine ? ` · ${freezeLine}` : '');
  return {
    gate: {
      green: gateGreen,
      consecutiveReds: g.consecutiveReds,
      stalled: g.stalled,
      fireStale,
      fireStaleReason,
      lastGreenAtMs: g.lastGreenAtMs,
      verdictStale,
      verdictStaleReason,
      lastFixerStatus: g.lastFixerStatus,
      lastFixerCandidate: g.lastFixerCandidate,
      flakyWorkspaces: g.flakyWorkspaces,
      failingTests,
      failingTestsMeasured,
      failingTestsCarriedForward,
      repairQueue: g.repairQueue ?? null,
      repairQueueRead: g.repairQueueRead,
      // WI-2141736 P-004: the freeze's own state, for the case `repairQueue: null` cannot
      // distinguish — owner-suppressed, just-retired, or genuinely nothing frozen.
      freezeAndConverge: g.freezeAndConverge ?? null,
      lastVerdict,
    },
    deploy: {
      deployedSha: d.deployed?.sha ?? null,
      stagingHeadSha: d.stagingHead?.sha ?? null, // field name predates staging→main rename: stagingHead = integration (staging) HEAD
      greenPinSha: d.greenPin?.sha ?? null,
      deployedBehindStaging: d.deployedBehindStaging,
      greenPinBehindStaging: d.greenPinBehindStaging,
      deployedBehindGreenPin: d.deployedBehindGreenPin,
      greenPinAtStagingHead: d.greenPinAtStagingHead,
      deployedAtMs: d.deployedAtMs,
    },
    deployInFlight: inFlight,
    deployTerminal: inFlight?.terminal ?? null,
    checkpointRunInFlight,
    checkpoint,
    manualRunAuthority,
    releaseTrigger: {
      active: releaseTriggerRow?.active ?? null,
      cron: releaseTriggerRow?.cron ?? null,
      lastFiredAtMs: releaseTriggerRow?.lastFiredAtMs ?? null,
      nextFireAtMs: releaseTriggerRow?.nextFireAtMs ?? null,
      pause: releaseTriggerRow?.pause ?? null,
      blocked: releaseTriggerBlocked,
      blockReason: releaseTriggerBlockReason,
      fireStale: releaseTriggerFireStale.stale,
      fireStaleReason: releaseTriggerFireStale.reason,
    },
    liveCertification: liveCertification ?? null,
    canTriggerGreen,
    nothingToDeploy,
    state,
    recommendation,
    summary,
    errors: d.errors ?? [],
  };
}

export interface ReadDeployStatusDeps {
  loadSnapshot?: () => Promise<GitPipelineSnapshot>;
  /** Injectable in-flight probe (default: the real systemd read). */
  loadInFlight?: () => Promise<DeployInFlight>;
  /** Injectable P-010 exact-SHA live-certification reader. */
  loadLiveCertification?: (targetSha: string) => Promise<LiveReleaseCertification>;
  /** Reader identity matters for the serializer fence: its holder remains authorized. */
  readerOwnerId?: string | null;
  /** Injectable live manual-run authority reader. Omitted without readerOwnerId preserves
   * legacy/pure callers and avoids an ambient database read in watchdogs/tests. */
  loadManualRunAuthority?: () => Promise<ReleaseTraceManualRunAuthority | null>;
  /** Diagnostic only: identify which dependency is still pending if the outer status read times out. */
  onReadProgress?: (pending: DeployStatusReadStage[]) => void;
}

export type DeployStatusReadStage = 'snapshot' | 'inFlight' | 'manualRunAuthority' | 'liveCertification';

/** Read the current deploy status (the snapshot + the in-flight probe + the pure computation).
 *  READ-ONLY. The in-flight probe is best-effort: if it throws, the status still returns (with
 *  `deployInFlight:null`) rather than failing the whole read. */
export async function readDeployStatus(deps: ReadDeployStatusDeps = {}): Promise<DeployStatus> {
  // The release status surface is explicitly a liveness diagnostic.  It must
  // opt into the live run-lock probe, otherwise a long-running checkpoint has
  // no chance to clear the age-only fire-stale alarm until it finishes.
  // This is a liveness diagnostic, not an agent-spawn path.  The host-wide
  // spawner sidecar is enabled on production operators, but routing these
  // short local git reads through it can wedge the status call behind its IPC
  // queue until the tool's 20s outer timeout (EI-21307371780991377).  Keep the
  // diagnostic fork-free and let the small local git children finish promptly.
  const load =
    deps.loadSnapshot ??
    (() => gitPipelineSnapshot(undefined, { includeActiveRun: true, useSpawnerSidecar: false }));
  const loadInFlight = deps.loadInFlight ?? (() => readDeployInFlight());
  const loadManualRunAuthority =
    deps.loadManualRunAuthority ??
    (deps.readerOwnerId !== undefined
      ? () => resolveManualRunAuthority({ readerOwnerId: deps.readerOwnerId })
      : async () => null);
  const pending = new Set<DeployStatusReadStage>();
  const reportPending = () => {
    try {
      deps.onReadProgress?.([...pending]);
    } catch {
      // An observer cannot break the status read.
    }
  };
  const track = <T>(stage: DeployStatusReadStage, read: () => Promise<T>): Promise<T> => {
    pending.add(stage);
    reportPending();
    return Promise.resolve().then(read).finally(() => {
      pending.delete(stage);
      reportPending();
    });
  };
  const [snap, inFlight, manualRunAuthority] = await Promise.all([
    track('snapshot', load),
    track('inFlight', () => loadInFlight().catch(() => null)),
    track('manualRunAuthority', () => loadManualRunAuthority().catch(() => null)),
  ]);
  const targetSha = snap.deploy.greenPin?.sha ?? null;
  const loadCertification = deps.loadLiveCertification ?? ((sha: string) => readLiveReleaseCertification(sha));
  const certification = targetSha
    ? await track('liveCertification', () => loadCertification(targetSha).catch((error): LiveReleaseCertification => ({
        status: 'unreadable',
        targetSha,
        certified: false,
        reason: `live-certification read failed: ${error instanceof Error ? error.message : String(error)}`,
        bankPath: null,
        evidence: null,
        invalidLines: 0,
      })))
    : undefined;
  return computeDeployStatus(snap, inFlight, certification, manualRunAuthority);
}

// ─── Detached deploy launch ───────────────────────────────────────────────────

export interface LaunchDeployOpts {
  /** Force an UN-GREEN deploy of a specific commit (the owner-gated escape). Omitted ⇒ a
   *  safe green-pin deploy (deploy-cli's `--execute` ships green `main`/`ready`). */
  force?: boolean;
  /** REQUIRED when force — the exact commit to ship past the red gate (`--deploy-commit`). */
  commit?: string;
  /** Integration tree root (default integrationRoot()). */
  root?: string;
}

export interface LaunchDeployResult {
  launched: boolean;
  unit: string;
  mode: 'trigger' | 'force';
  commit?: string;
  /** systemd-run argv actually run (or that would be run). */
  argv: string[];
  logPath: string;
  /** Present on a launch failure (e.g. the unit already exists ⇒ a deploy is in flight). */
  reason?: string;
}

const SHA_RE = /^[0-9a-fA-F]{7,40}$/;

/** Pure: the deploy-cli flags for a trigger (green) vs a force (un-green commit). */
export function buildDeployCliArgs(opts: { force?: boolean; commit?: string }): string[] {
  if (opts.force) {
    if (!opts.commit || !SHA_RE.test(opts.commit)) {
      throw new Error(`force deploy requires a valid commit sha (--deploy-commit), got ${JSON.stringify(opts.commit)}`);
    }
    return ['--deploy-commit', opts.commit, '--force', '--execute'];
  }
  return ['--execute'];
}

/** Pure: the full `systemd-run` argv for the detached deploy. Mirrors release-actions.ts's
 *  auto-serve launch (PATH passthrough so the unit doesn't depend on the systemd-manager env,
 *  PAPERCUSP_ALLOW_DEV_RESTART=1 to self-authorize the restart step — the role gate at the tool
 *  IS the authorization). Exported for unit testing the command construction. */
export function buildSystemdRunArgv(root: string, deployCliArgs: string[], logPath: string, pathEnv: string): string[] {
  const payload =
    `PAPERCUSP_ALLOW_DEV_RESTART=1 PAPERCUSP_INTEGRATION_ROOT='${root}' '${tsxBin(root)}' ` +
    `apps/operator/lib/release/deploy-cli.ts ${deployCliArgs.join(' ')} > ${logPath} 2>&1`;
  const inner = buildDeployTerminalShell(payload);
  return [
    '--user',
    ...SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS,
    `--unit=${DEPLOY_UNIT}`,
    `--working-directory=${root}`,
    `--setenv=PATH=${pathEnv}`,
    'bash',
    '-c',
    inner,
  ];
}

export type SpawnLike = typeof spawn;

/**
 * Fire the deploy as a DETACHED transient systemd unit (survives the :3070 restart the deploy
 * itself triggers). Returns once systemd-run has accepted/refused the unit — the deploy's
 * OUTCOME is reported by deploy.ts (broadcast + pipeline event + the awaitable
 * release:deployed / deploy-failed events), NOT by this (about-to-be-restarted) caller.
 *
 * `spawnFn` is injectable so the tool's handler is unit-testable without launching anything.
 */
export function launchDetachedDeploy(opts: LaunchDeployOpts, spawnFn: SpawnLike = spawn): Promise<LaunchDeployResult> {
  const root = opts.root ?? integrationRoot();
  const mode: 'trigger' | 'force' = opts.force ? 'force' : 'trigger';
  const logPath = `/tmp/${DEPLOY_UNIT}.log`;
  const deployCliArgs = buildDeployCliArgs(opts);
  const argv = buildSystemdRunArgv(root, deployCliArgs, logPath, process.env.PATH ?? '');

  return new Promise<LaunchDeployResult>((resolve) => {
    const base: LaunchDeployResult = { launched: false, unit: DEPLOY_UNIT, mode, commit: opts.commit, argv, logPath };
    const child = spawnFn('systemd-run', argv);
    const stderrOut = createTextCollector(child.stderr);
    child.on('error', (e: unknown) => {
      resolve({ ...base, launched: false, reason: e instanceof Error ? e.message : String(e) });
    });
    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolve({ ...base, launched: true });
      } else {
        // Most common cause: the unit already exists ⇒ a deploy (manual or auto-serve) is in flight.
        resolve({
          ...base,
          launched: false,
          reason: `systemd-run exited ${code} (a deploy may already be in flight): ${stderrOut.text().trim().slice(0, 200)}`,
        });
      }
    });
  });
}
