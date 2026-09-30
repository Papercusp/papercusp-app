import { gitPipelineSnapshot, type GitPipelineSnapshot } from '../../git-pipeline-stats';
import { pipelineName } from '../../release/pipeline-name';
import type {
  ProducerHealthCertificate,
  ProducerHealthObservation,
  ProducerHealthObservationState,
} from './verified-wait';
import { PRODUCER_HEALTH_CERTIFICATE_VERSION } from './verified-wait';

export interface CheckpointProducerDetails extends Record<string, unknown> {
  pipeline: string;
  candidateSha?: string;
  runId?: string;
}

interface CheckpointRunLockReading {
  held: boolean;
  elapsedSec: number | null;
  pid?: number;
}

type CheckpointRunLockReader = (
  root: string,
) => CheckpointRunLockReading | null | Promise<CheckpointRunLockReading | null>;

async function readCheckpointRunLock(root: string): Promise<CheckpointRunLockReading | null> {
  try {
    // Keep the timeout verifier on the same cheap, PID-verified lock source as
    // gitPipelinePosition. Dynamic import preserves the adapter's existing cold
    // path and keeps a probe failure fail-soft to the snapshot-only behavior.
    const { isCheckpointRunLockHeldCheap } = await import('../../release-checkpoint-launch');
    return isCheckpointRunLockHeldCheap(root);
  } catch {
    return null;
  }
}

function checkpointRunLockRoot(
  pipeline: string,
  snapshot: GitPipelineSnapshot,
): string | null {
  // The active-run probe already resolved this pipeline's registry root. Its
  // explicit null is authoritative: do not fall back to the operator deploy
  // root when a non-default pipeline has no unique mapping.
  const configuredRoot =
    'activeRunRoot' in snapshot ? snapshot.activeRunRoot : snapshot.deploy?.integrationRoot;
  if (configuredRoot && pipelineName(configuredRoot) === pipeline) return configuredRoot;

  // A missing or mismatched root must degrade to UNKNOWN rather than attach
  // another pipeline's lock to this wait. Legacy injected snapshots may only
  // carry deploy state; never guess from the process cwd or environment.
  return null;
}

function snapshotWithLiveCheckpointRunLock(
  snapshot: GitPipelineSnapshot,
  lock: CheckpointRunLockReading | null,
): GitPipelineSnapshot {
  if (!lock?.held || snapshot.activeRun?.active === true) return snapshot;

  const startedAtMs =
    lock.elapsedSec != null && Number.isFinite(lock.elapsedSec)
      ? snapshot.generatedAtMs - Math.max(0, lock.elapsedSec) * 1_000
      : null;
  return {
    ...snapshot,
    activeRun: {
      active: true,
      candidate: null,
      startedAtMs,
      progressAtMs: startedAtMs,
      elapsedSec: lock.elapsedSec ?? null,
    },
  };
}

function checkpointProgressAtMs(snapshot: GitPipelineSnapshot): number | null {
  return (
    snapshot.activeRun?.progressAtMs ??
    snapshot.activeRun?.startedAtMs ??
    snapshot.routines?.greenCheckpoint?.lastFiredAtMs ??
    null
  );
}

function matchingVerdict(
  snapshot: GitPipelineSnapshot,
  issuedAtMs: number,
  details: CheckpointProducerDetails,
) {
  return (snapshot.recent ?? []).find((event) => {
    if (event.kind !== 'green_checkpoint' || event.createdAtMs < issuedAtMs) return false;
    const candidate = typeof event.detail.candidate === 'string' ? event.detail.candidate : null;
    const candidateMatches =
      !details.candidateSha ||
      (candidate != null &&
        (candidate.startsWith(details.candidateSha) || details.candidateSha.startsWith(candidate)));
    const runMatches = !details.runId || event.detail.runId === details.runId;
    return candidateMatches && runMatches;
  });
}

function checkpointObservationState(
  snapshot: GitPipelineSnapshot,
  details: CheckpointProducerDetails,
): ProducerHealthObservationState | undefined {
  const routine = snapshot.routines?.greenCheckpoint;
  const activeRun = snapshot.activeRun;
  const candidateBound = Boolean(details.candidateSha || details.runId);
  const explicitlyPaused = routine?.pause?.reason != null;

  if (activeRun?.active === true) return 'active';

  // The live probe produced NO reading at all — not "confirmed not running", just
  // never observed (a skipped/unresolvable probe root, a swallowed probe exception,
  // or `includeActiveRun` never having been asked for it). That is genuinely unknown
  // regardless of whether the wait names a specific candidate: an absent observation
  // is not evidence the named run isn't there, and must not be allowed to fall through
  // to the timestamp-staleness heuristic below, which cannot distinguish "no signal"
  // from "a stale one" and can misclassify an active, un-probed writer as stalled
  // (EI-21045433666635330). This check MUST run before the candidate-bound early
  // return: that return exists to withhold `idle` (a real claim that no run is
  // expected), never to withhold `unknown` (a claim only that nothing was observed).
  if (activeRun == null) return 'unknown';

  // EI-20971831715218093: a candidate-bound wait cannot conclude a stalled/absent
  // producer merely because the checkpoint mechanism is not currently judging ANY
  // candidate (activeRun.candidate == null). That reading is "hasn't started judging
  // yet" every bit as much as "started and went quiet" -- the routine can sit with no
  // active candidate while unrelated, live upstream work (e.g. a separate affected-
  // test verifier task the checkpoint launch waits on) genuinely progresses. Falling
  // through to the timestamp-staleness heuristic below in that state misreads the
  // routine's own last-tick timestamp (which can be arbitrarily old on a slow cadence)
  // as evidence the producer went stale, and recommends an owner takeover for a
  // producer that was never stalled. Prefer the conservative `unknown` (re-await) —
  // never a positive `idle` claim, since a candidate-bound wait cannot safely assert
  // no run is expected for ITS candidate either.
  if (candidateBound && activeRun.candidate == null) return 'unknown';

  // A candidate-bound wait is asking about a specific run. Once we know a DIFFERENT
  // candidate is (or was) the one being judged, an idle routine still cannot safely
  // declare our candidate "expected idle"; keep the old stalled/absent diagnosis for
  // that targeted case — this only applies once we know the probe DID observe an
  // actual candidate (activeRun.candidate is non-null here).
  if (candidateBound) return undefined;

  // `active` on the routine is configuration/liveness of the scheduler, not
  // proof that a checkpoint is currently running. An explicit pause is even
  // stronger evidence that no run is expected right now.
  //
  // EI-21502021074096764: report that pause as its own state rather than
  // flattening it into `idle`. Both remain non-takeover outcomes classifying as
  // `expected-idle`, so this changes no downstream behaviour — it changes what
  // the waiting agent is TOLD. A paused gate rendered `producerState: "idle"`
  // next to `active: false` / `routineActive: false` / `candidate: null`, which
  // together read as a stranded producer and invite a takeover of a gate whose
  // live owner paused it deliberately.
  if (explicitlyPaused && activeRun.candidate == null) {
    return 'paused';
  }
  if (routine?.active === true && activeRun.candidate == null) {
    return 'idle';
  }

  // EI-21201405924579516: an observed inactive run plus an inactive (or missing)
  // routine without pause provenance is not an authoritative absence. The
  // systemd snapshot proves only that no run is active at this instant; the
  // routine metadata does not tell us whether it was deliberately disabled,
  // between launches, or read from a stale/degraded row. Returning undefined
  // here leaves producerPresent=false and turns that ambiguity into an
  // owner-takeover verdict. Keep it conservative and re-await instead.
  if (activeRun.candidate == null && routine?.active !== true && !explicitlyPaused) {
    return 'unknown';
  }

  return undefined;
}

export function checkpointProducerCertificate(input: {
  pipeline: string;
  candidateSha?: string;
  runId?: string;
  ownerId: string | null;
  workItemId?: string | null;
  issuedAtMs: number;
  expectedCadenceMs: number;
  verificationDeadlineMs: number;
  snapshot: GitPipelineSnapshot;
}): ProducerHealthCertificate {
  return {
    version: PRODUCER_HEALTH_CERTIFICATE_VERSION,
    producer: {
      kind: 'green-checkpoint',
      id: input.runId ?? input.snapshot.activeRun?.candidate ?? input.candidateSha ?? input.pipeline,
    },
    owner: { ownerId: input.ownerId, workItemId: input.workItemId ?? null },
    issuedAtMs: input.issuedAtMs,
    lastProgressAtMs: checkpointProgressAtMs(input.snapshot),
    lastFireAtMs: matchingVerdict(input.snapshot, 0, input)?.createdAtMs ?? null,
    expectedCadenceMs: input.expectedCadenceMs,
    verificationDeadlineMs: input.verificationDeadlineMs,
    details: {
      pipeline: input.pipeline,
      ...(input.candidateSha ? { candidateSha: input.candidateSha } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
    },
  };
}

export async function observeCheckpointProducer(
  certificate: ProducerHealthCertificate,
  deps: {
    snapshot?: (pipeline: string) => Promise<GitPipelineSnapshot>;
    /** Test seam for the same live run-lock read used by gitPipelinePosition. */
    runLock?: CheckpointRunLockReader;
  } = {},
): Promise<ProducerHealthObservation> {
  const details = certificate.details as CheckpointProducerDetails | undefined;
  if (!details?.pipeline) throw new Error('checkpoint producer certificate is missing details.pipeline');
  const snapshot = await (deps.snapshot ?? ((pipeline) => gitPipelineSnapshot(pipeline, { includeActiveRun: true })))(
    details.pipeline,
  );
  const lockRoot = checkpointRunLockRoot(details.pipeline, snapshot);
  const lock = lockRoot
    ? await (deps.runLock ?? readCheckpointRunLock)(lockRoot)
    : null;
  const observedSnapshot = snapshotWithLiveCheckpointRunLock(snapshot, lock);
  const verdict = matchingVerdict(observedSnapshot, certificate.issuedAtMs, details);
  const producerPresent =
    observedSnapshot.activeRun?.active === true || observedSnapshot.routines?.greenCheckpoint?.active === true;
  const state = checkpointObservationState(observedSnapshot, details);
  // An unknown candidate-bound reading does not prove the producer is inactive.
  // Keep that uncertainty in the evidence shown to the waiting agent: `false`
  // was previously emitted even when the run probe returned no reading at all.
  const active = state === 'unknown' ? null : observedSnapshot.activeRun?.active ?? null;
  return {
    checkedAtMs: observedSnapshot.generatedAtMs,
    producerPresent,
    ...(state ? { state } : {}),
    lastProgressAtMs: checkpointProgressAtMs(observedSnapshot),
    lastFireAtMs: verdict?.createdAtMs ?? null,
    completedAtMs: verdict?.createdAtMs ?? null,
    evidence: {
      pipeline: details.pipeline,
      active,
      candidate: observedSnapshot.activeRun?.candidate ?? null,
      ...(lock?.held && observedSnapshot.activeRun?.active === true ? { activeSource: 'run-lock' } : {}),
      ...(lock?.pid != null ? { runLockPid: lock.pid } : {}),
      ...(state ? { producerState: state } : {}),
      routineActive: observedSnapshot.routines?.greenCheckpoint?.active ?? false,
      routinePauseReason: observedSnapshot.routines?.greenCheckpoint?.pause?.reason ?? null,
      verdictStatus: verdict?.status ?? null,
    },
  };
}
