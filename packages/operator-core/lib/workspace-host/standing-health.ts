/**
 * Standing health for live hosted workspace hosts (WI-10004950).
 *
 * Until this existed, `workspace_hosts.health_status` was written only by a soak
 * (`recordWorkspaceHostSoakSample` → `recordWorkspaceHostHealth`), so every live host that was
 * not mid-soak read NULL. Nothing told anyone that a customer's host was down, unreachable, or
 * about to lose its agent login.
 *
 * This pass is the standing producer. It reuses the soak's seams and check builders rather than
 * forking them, so a host's health means the same thing whichever producer wrote it:
 *   - seams: `resolveWorkspaceHostSoakSeams` (provider read + controller reach over GCP IAP or AWS SSM),
 *   - checks: `workspaceHostComputeCheck` / `workspaceHostReachCheck` from soak.ts,
 *   - writer: `recordWorkspaceHostHealth`.
 *
 * Three rules:
 *
 * 1. ONLY THE CONTROLLER PROBES. A host is probed by the process whose controller id is stamped
 *    on its row (`controller_id`), the same authority that provisions it, so two operators on one
 *    database never double the IAP cost or race each other's attestation.
 *
 * 2. A FRESH ATTESTATION IS LEFT ALONE. A host attested within `freshMs` is skipped: an active
 *    soak samples every few minutes and owns the host's health while it runs. The standing pass
 *    writes every 15 minutes, so its own last write is never "fresh" at the next tick.
 *
 * 3. NO VACUOUS CHECKS, NO SILENT SKIPS. Incarnation and image stability are properties of a
 *    WINDOW (the soak's job); one sample pinned from its own reading would report them as
 *    trivially ok, so they are not written here. And a host that could not be asked is still
 *    attested, with `ok: null` checks naming why, so "unknown" is visible rather than absent.
 */
import { createHash } from 'node:crypto';
import {
  resolveWorkspaceHostHealthStatus,
  type WorkspaceHostHealthAttestation,
  type WorkspaceHostHealthCheck,
} from '@papercusp/deployment-driver';
import {
  workspaceHostAgentCredentialChecks,
  type WorkspaceHostAgentCredentialExpiryReading,
} from './agent-credential-expiry';
import {
  workspaceHostComputeCheck,
  workspaceHostReachCheck,
  type WorkspaceHostSoakInstanceReading,
  type WorkspaceHostSoakReachOutcome,
  type WorkspaceHostSoakSubject,
} from './soak';

/** Cadence of the scheduled pass; each due host costs one provider read and one IAP reach. */
export const WORKSPACE_HOST_STANDING_HEALTH_CRONTAB = '*/15 * * * *';
/** A host attested more recently than this is skipped (an active soak owns its health). */
export const WORKSPACE_HOST_STANDING_HEALTH_FRESH_MS = 10 * 60_000;
/**
 * Cadence of the spot-reclaim sweep (WI-10005210, D-028). A reclaimed spot host stays down until
 * something restarts it, so at the standing cadence it could sit down for up to 15 minutes. The
 * sweep costs one provider read per live SPOT host and nothing else while those hosts are up.
 */
export const WORKSPACE_HOST_SPOT_RECLAIM_CRONTAB = '*/2 * * * *';
/** The `soakId` slot of the reach subject; the standing pass is not a soak and stores no samples. */
export const WORKSPACE_HOST_STANDING_HEALTH_SUBJECT_ID = 'standing-health';

export interface WorkspaceHostStandingHealthTarget {
  workspaceId: string;
  hostId: string;
  /** ISO timestamp of the host's last attestation from any producer, or null when never attested. */
  healthAttestedAt: string | null;
}

/** The subset of the soak seams this pass uses. */
export interface WorkspaceHostStandingHealthSeams {
  readInstance(): Promise<WorkspaceHostSoakInstanceReading>;
  probeFor(subject: WorkspaceHostSoakSubject): {
    probeReach(): Promise<WorkspaceHostSoakReachOutcome>;
    /**
     * Read the agent logins' expiry on the host (WI-10003720). Optional so a provider without it
     * still attests compute + reach; asked only after a successful reach, over the same transport.
     */
    readAgentCredentialExpiry?(): Promise<WorkspaceHostAgentCredentialExpiryReading>;
  };
}

export type WorkspaceHostStandingHealthOutcome =
  | {
      kind: 'attested';
      workspaceId: string;
      hostId: string;
      status: WorkspaceHostHealthAttestation['status'];
      checks: readonly WorkspaceHostHealthCheck[];
      /** Present only for a reclaimed spot host (WI-10005210). */
      recovery?: WorkspaceHostReclaimRecovery;
    }
  | { kind: 'skipped-fresh'; workspaceId: string; hostId: string; attestedAt: string }
  | { kind: 'record-failed'; workspaceId: string; hostId: string; error: string };

/**
 * What the pass did about a reclaimed spot host (WI-10005210). Carried on the host's `attested`
 * outcome, so a reclaim that was seen but not restarted says why instead of vanishing.
 */
export type WorkspaceHostReclaimRecovery =
  | { kind: 'restart-enqueued'; operationId: string }
  | { kind: 'restart-skipped'; reason: string }
  | { kind: 'restart-failed'; error: string };

/**
 * The prepared restart of a reclaimed host. `input` is opaque here: the composition root builds
 * the lifecycle request and hands it back to its own `enqueue`, so this module needs no
 * dependency on the lifecycle workflow.
 */
export type WorkspaceHostReclaimRestartPlan =
  | { kind: 'restart'; operationId: string; input: unknown }
  | { kind: 'skip'; reason: string };

export interface WorkspaceHostReclaimRestartSeams {
  /**
   * Re-read the host and build the start request. Runs INSIDE a step. It must return `skip` when
   * the host is no longer meant to be up: a controller stop that finished after the target list
   * leaves a stopped spot VM that is NOT a reclaim.
   */
  prepare(target: { workspaceId: string; hostId: string }, operationId: string): Promise<WorkspaceHostReclaimRestartPlan>;
  /**
   * Durably enqueue the start. Called at the WORKFLOW layer, outside any step, because DBOS forbids
   * starting a workflow from inside a step. Report a busy host (another lifecycle operation holds
   * it) as `restart-skipped`, not as a failure.
   */
  enqueue(plan: { operationId: string; input: unknown }): Promise<WorkspaceHostReclaimRecovery>;
}

export interface WorkspaceHostStandingHealthRuntime {
  /** A checkpointed step: on replay its recorded result is returned without re-running `fn`. */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** The controller id this process holds authority as. */
  controllerId: string;
  listTargets(controllerId: string): Promise<WorkspaceHostStandingHealthTarget[]>;
  resolveSeams(input: { workspaceId: string; hostId: string }): Promise<WorkspaceHostStandingHealthSeams>;
  recordHealth(workspaceId: string, attestation: WorkspaceHostHealthAttestation): Promise<void>;
  /** Wall clock, read ONLY inside steps so a replay sees the recorded value. */
  now(): Date;
  freshMs?: number;
  /** Restart reclaimed spot hosts. Absent: a reclaim is still attested, just not restarted. */
  reclaim?: WorkspaceHostReclaimRestartSeams;
}

export interface WorkspaceHostStandingHealthPassResult {
  controllerId: string;
  outcomes: WorkspaceHostStandingHealthOutcome[];
}

function errorDetail(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function notAttempted(why: string): WorkspaceHostHealthCheck {
  return { name: 'controller-reach', ok: null, detail: `not attempted: ${why}` };
}

/** Why a reach cannot be attempted for this reading, or null when it can. */
function reachBlocker(reading: WorkspaceHostSoakInstanceReading): string | null {
  if (reading.kind === 'unreadable') return 'the provider could not be read';
  if (reading.kind === 'absent') return 'the provider reports no instance';
  if (reading.status !== 'RUNNING') return `the instance is ${reading.status}, not RUNNING`;
  if (!reading.instanceId) return 'the provider returned no instance id';
  return null;
}

/**
 * Cloud statuses for a stopped instance: GCP's TERMINATED, and EC2's `stopped` as the AWS soak
 * reading reports it (upper-cased, `awsWorkspaceHostSoakReading`). The set used to hold the raw
 * lower-case EC2 name, which no reading ever carries, so no AWS host could match (WI-10005389).
 */
const WORKSPACE_HOST_STOPPED_STATUSES: ReadonlySet<string> = new Set(['TERMINATED', 'STOPPED']);

/** The check a reclaimed spot host carries; the pass keys its restart off this name. */
export const WORKSPACE_HOST_SPOT_RECLAIMED_CHECK = 'spot-reclaimed';

/**
 * True when the cloud stopped a spot (preemptible) host on its own (WI-10005210).
 *
 * A spot VM can be stopped by the cloud at any time, and GCP will not restart it (spot requires
 * `automaticRestart: false`). The pass only probes hosts whose `desired_state` says they should be
 * up, and a stop the controller orders moves the row to `stopped` when it completes, so a stopped
 * spot VM here is a reclaim. The one exception, a stop that completed after the target list, is
 * caught by the re-read in `WorkspaceHostReclaimRestartSeams.prepare`.
 */
export function workspaceHostSpotReclaimed(reading: WorkspaceHostSoakInstanceReading): boolean {
  return reading.kind === 'observed' && reading.preemptible === true && WORKSPACE_HOST_STOPPED_STATUSES.has(reading.status);
}

function spotReclaimedCheck(status: string): WorkspaceHostHealthCheck {
  return {
    name: WORKSPACE_HOST_SPOT_RECLAIMED_CHECK,
    ok: false,
    detail: `spot instance is ${status}: the cloud reclaimed it while the host is meant to run`,
  };
}

/**
 * One restart per host per pass: hashing the pass's recorded clock keeps a replay on the same
 * operation (and so on the same DBOS workflow id) instead of minting a second start.
 */
export function workspaceHostReclaimOperationId(target: { workspaceId: string; hostId: string }, passNowMs: number): string {
  const hex = createHash('sha256')
    .update(`workspace-host-spot-reclaim:${target.workspaceId}:${target.hostId}:${passNowMs}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/**
 * Take one standing attestation of a host. Never throws for a probe failure: a host that could
 * not be read or reached IS the observation.
 */
export async function probeWorkspaceHostStandingHealth(
  target: { workspaceId: string; hostId: string },
  deps: Pick<WorkspaceHostStandingHealthRuntime, 'resolveSeams' | 'now'>,
): Promise<WorkspaceHostHealthAttestation> {
  const observedAt = deps.now().toISOString();
  let checks: WorkspaceHostHealthCheck[];
  let seams: WorkspaceHostStandingHealthSeams | null = null;
  let seamsError: string | null = null;
  try {
    seams = await deps.resolveSeams(target);
  } catch (error) {
    seamsError = errorDetail(error);
  }
  if (!seams) {
    const why = `the controller could not resolve the host (${seamsError})`;
    checks = [{ name: 'compute-running', ok: null, detail: why }, notAttempted(why)];
  } else {
    const reading = await seams
      .readInstance()
      .catch((error: unknown): WorkspaceHostSoakInstanceReading => ({ kind: 'unreadable', detail: errorDetail(error) }));
    const blocker = reachBlocker(reading);
    let reach: WorkspaceHostHealthCheck;
    let agentChecks: WorkspaceHostHealthCheck[] = [];
    if (blocker !== null || reading.kind !== 'observed') {
      reach = notAttempted(blocker ?? 'no observed instance');
    } else {
      const subject: WorkspaceHostSoakSubject = {
        workspaceId: target.workspaceId,
        hostId: target.hostId,
        soakId: WORKSPACE_HOST_STANDING_HEALTH_SUBJECT_ID,
        instanceId: reading.instanceId!,
        image: reading.sourceImage ?? '',
      };
      const probe = seams.probeFor(subject);
      const outcome = await probe
        .probeReach()
        .catch((error: unknown): WorkspaceHostSoakReachOutcome => ({
          kind: 'transport-failure',
          detail: errorDetail(error),
        }));
      reach = workspaceHostReachCheck(outcome);
      // Only a host we actually reached is asked about its logins: an unreached host already
      // says why in its reach check, and a second failed ssh would only repeat it.
      if (outcome.kind === 'reached' && probe.readAgentCredentialExpiry) {
        const expiry = await probe
          .readAgentCredentialExpiry()
          .catch((error: unknown): WorkspaceHostAgentCredentialExpiryReading => ({
            kind: 'transport-failure',
            detail: errorDetail(error),
          }));
        agentChecks = workspaceHostAgentCredentialChecks(expiry, new Date(observedAt));
      }
    }
    checks = [
      workspaceHostComputeCheck(reading),
      ...(workspaceHostSpotReclaimed(reading) && reading.kind === 'observed' ? [spotReclaimedCheck(reading.status)] : []),
      reach,
      ...agentChecks,
    ];
  }
  const compute = checks.find((check) => check.name === 'compute-running');
  return {
    hostId: target.hostId,
    observedAt,
    status: resolveWorkspaceHostHealthStatus({ reachable: compute?.ok !== false, checks }),
    checks,
  };
}

/** True when the host was attested within `freshMs` of `nowMs` by any producer. */
export function workspaceHostStandingHealthIsFresh(
  target: WorkspaceHostStandingHealthTarget,
  nowMs: number,
  freshMs: number = WORKSPACE_HOST_STANDING_HEALTH_FRESH_MS,
): boolean {
  if (!target.healthAttestedAt) return false;
  const attestedMs = Date.parse(target.healthAttestedAt);
  return Number.isFinite(attestedMs) && nowMs - attestedMs < freshMs;
}

/**
 * One pass over every live host this controller holds authority for: each due host is probed
 * and attested in its OWN step, so a crash mid-pass resumes at the next host instead of
 * re-probing (and re-paying IAP for) the ones already done.
 */
export async function runWorkspaceHostStandingHealthPass(
  runtime: WorkspaceHostStandingHealthRuntime,
): Promise<WorkspaceHostStandingHealthPassResult> {
  const freshMs = runtime.freshMs ?? WORKSPACE_HOST_STANDING_HEALTH_FRESH_MS;
  const listed = await runtime.step('standing-health-list', async () => ({
    targets: await runtime.listTargets(runtime.controllerId),
    nowMs: runtime.now().getTime(),
  }));
  const outcomes: WorkspaceHostStandingHealthOutcome[] = [];
  for (const target of listed.targets) {
    const { workspaceId, hostId } = target;
    if (workspaceHostStandingHealthIsFresh(target, listed.nowMs, freshMs)) {
      outcomes.push({ kind: 'skipped-fresh', workspaceId, hostId, attestedAt: target.healthAttestedAt! });
      continue;
    }
    outcomes.push(await attestAndRecoverHost(runtime, { workspaceId, hostId }, listed.nowMs));
  }
  return { controllerId: runtime.controllerId, outcomes };
}

/** A host that was probed: attested (with any reclaim recovery) or not recorded. */
type WorkspaceHostProbedOutcome = Exclude<WorkspaceHostStandingHealthOutcome, { kind: 'skipped-fresh' }>;

/**
 * Probe and attest one host in its own step, then restart it if the attestation shows a spot
 * reclaim. Shared by the standing pass and the spot-reclaim sweep, so a reclaim is written and
 * restarted the same way whichever of them saw it first.
 */
async function attestAndRecoverHost(
  runtime: Pick<WorkspaceHostStandingHealthRuntime, 'step' | 'resolveSeams' | 'recordHealth' | 'now' | 'reclaim'>,
  target: { workspaceId: string; hostId: string },
  passNowMs: number,
): Promise<WorkspaceHostProbedOutcome> {
  const { workspaceId, hostId } = target;
  const outcome = await runtime.step(
    `standing-health-host:${workspaceId}:${hostId}`,
    async (): Promise<WorkspaceHostProbedOutcome> => {
      const attestation = await probeWorkspaceHostStandingHealth(target, runtime);
      try {
        await runtime.recordHealth(workspaceId, attestation);
      } catch (error) {
        return { kind: 'record-failed', workspaceId, hostId, error: errorDetail(error) };
      }
      return { kind: 'attested', workspaceId, hostId, status: attestation.status, checks: attestation.checks };
    },
  );
  const reclaimed =
    outcome.kind === 'attested' &&
    outcome.checks.some((check) => check.name === WORKSPACE_HOST_SPOT_RECLAIMED_CHECK && check.ok === false);
  if (reclaimed && runtime.reclaim) {
    return { ...outcome, recovery: await recoverReclaimedHost(runtime, runtime.reclaim, target, passNowMs) };
  }
  return outcome;
}

export interface WorkspaceHostSpotReclaimSweepRuntime
  extends Pick<WorkspaceHostStandingHealthRuntime, 'step' | 'controllerId' | 'resolveSeams' | 'recordHealth' | 'now'> {
  /** Live SPOT hosts this controller holds authority for (`listWorkspaceHostSpotReclaimTargets`). */
  listSpotTargets(controllerId: string): Promise<{ workspaceId: string; hostId: string }[]>;
  reclaim: WorkspaceHostReclaimRestartSeams;
}

/**
 * What the sweep saw for one spot host. Only a reclaimed host is attested, so a spot host that is
 * up (or absent, or could not be read) leaves its health to the standing pass, which attests it
 * with full reach and says why it is unknown.
 */
export type WorkspaceHostSpotReclaimSweepOutcome =
  | { kind: 'not-reclaimed'; workspaceId: string; hostId: string; status: string }
  | { kind: 'unread'; workspaceId: string; hostId: string; detail: string }
  | WorkspaceHostProbedOutcome;

export interface WorkspaceHostSpotReclaimSweepResult {
  controllerId: string;
  outcomes: WorkspaceHostSpotReclaimSweepOutcome[];
}

type SpotReclaimReading = { kind: 'reclaimed' } | { kind: 'not-reclaimed'; status: string } | { kind: 'unread'; detail: string };

async function readSpotReclaim(
  runtime: Pick<WorkspaceHostSpotReclaimSweepRuntime, 'resolveSeams'>,
  target: { workspaceId: string; hostId: string },
): Promise<SpotReclaimReading> {
  let reading: WorkspaceHostSoakInstanceReading;
  try {
    reading = await (await runtime.resolveSeams(target)).readInstance();
  } catch (error) {
    return { kind: 'unread', detail: errorDetail(error) };
  }
  if (reading.kind === 'unreadable') return { kind: 'unread', detail: reading.detail };
  if (workspaceHostSpotReclaimed(reading)) return { kind: 'reclaimed' };
  return { kind: 'not-reclaimed', status: reading.kind === 'absent' ? 'absent' : reading.status };
}

/**
 * The spot-reclaim sweep (WI-10005210, D-028): read each live spot host's instance from the
 * provider, in its own step. A host that is up costs that one read: no IAP reach and no health
 * write. A reclaimed host is attested and restarted exactly as the standing pass would do it, and
 * that fresh attestation makes the next standing pass skip the host instead of acting twice.
 */
export async function runWorkspaceHostSpotReclaimSweep(
  runtime: WorkspaceHostSpotReclaimSweepRuntime,
): Promise<WorkspaceHostSpotReclaimSweepResult> {
  const listed = await runtime.step('spot-reclaim-list', async () => ({
    targets: await runtime.listSpotTargets(runtime.controllerId),
    nowMs: runtime.now().getTime(),
  }));
  const outcomes: WorkspaceHostSpotReclaimSweepOutcome[] = [];
  for (const { workspaceId, hostId } of listed.targets) {
    const target = { workspaceId, hostId };
    const reading = await runtime.step(`spot-reclaim-read:${workspaceId}:${hostId}`, () =>
      readSpotReclaim(runtime, target),
    );
    if (reading.kind === 'reclaimed') {
      outcomes.push(await attestAndRecoverHost(runtime, target, listed.nowMs));
    } else {
      outcomes.push({ ...reading, workspaceId, hostId });
    }
  }
  return { controllerId: runtime.controllerId, outcomes };
}

type PreparedReclaim = WorkspaceHostReclaimRestartPlan | { kind: 'error'; error: string };

/**
 * Restart a reclaimed spot host through the controller's own lifecycle `start`, never a direct
 * provider call: the lifecycle workflow is deduplicated per host, so a restart can never run
 * beside a stop, repair or destroy another operation already holds.
 */
async function recoverReclaimedHost(
  runtime: Pick<WorkspaceHostStandingHealthRuntime, 'step'>,
  reclaim: WorkspaceHostReclaimRestartSeams,
  target: { workspaceId: string; hostId: string },
  passNowMs: number,
): Promise<WorkspaceHostReclaimRecovery> {
  const operationId = workspaceHostReclaimOperationId(target, passNowMs);
  const plan = await runtime.step(
    `standing-health-reclaim:${target.workspaceId}:${target.hostId}`,
    async (): Promise<PreparedReclaim> =>
      reclaim.prepare(target, operationId).catch((error: unknown) => ({ kind: 'error', error: errorDetail(error) })),
  );
  if (plan.kind === 'skip') return { kind: 'restart-skipped', reason: plan.reason };
  if (plan.kind === 'error') return { kind: 'restart-failed', error: `could not prepare the restart: ${plan.error}` };
  try {
    return await reclaim.enqueue({ operationId: plan.operationId, input: plan.input });
  } catch (error) {
    return { kind: 'restart-failed', error: errorDetail(error) };
  }
}
