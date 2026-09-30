/** release:trace — one exact-SHA projection over the existing release authorities. */
import * as path from 'node:path';
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { gitPipelinePosition } from '../../git-pipeline-position';
import { gitPipelineSnapshot } from '../../git-pipeline-stats';
import { computeDeployStatus, integrationRoot } from '../../release-deploy-launch';
import { buildReleaseTrace, type ReleaseTraceAwait, type ReleaseTraceWake } from '../../release-trace';
import { buildKey } from '../../events/await/catalog';
import { inspectEventKey } from '../../events/await/store';
import { withBoundedTimeout, type BoundedTimeoutResult } from '../../bounded-timeout';
import { canonicalHarnessSlug, operatorHomeHarnessSlug } from '../../harness/operator-home-harness';
import { resolveAgentIdentity } from '../coordination/identity';
import { resolveManualRunAuthority } from '../../release/manual-run-authority';
import { statePlaneForDoor } from '../state-plane-door';

/**
 * Keep the composite diagnostic below the MCP transport deadline even when one
 * of its independent release/PG reads is queued behind a saturated pool.
 * The three budgets are sequential in the handler, so their sum remains below
 * the ~55s client deadline in the worst case. The position leg is 20s because
 * a measured live read can take about 19.5s while the gate is repairing; a
 * 15s cap turns a slow-but-valid position into an unknown release verdict.
 */
export const RELEASE_TRACE_SNAPSHOT_TIMEOUT_MS = 20_000;
export const RELEASE_TRACE_POSITION_TIMEOUT_MS = 20_000;
export const RELEASE_TRACE_AWAIT_TIMEOUT_MS = 10_000;

type TraceTimeoutStage = 'pipeline_snapshot' | 'pipeline_position' | 'await_history';

/**
 * release:trace composes one fixed pipeline: the operator-home integration
 * tree, green-checkpoint, and deployed :3070 state. A caller from another
 * harness must not be able to mistake those correct values for its own release
 * truth, so every returned envelope names the subject and concrete foreign
 * callers receive a warning beside it.
 */
function releaseTraceSubjectStamp(ctx: { harnessSlug?: string | null }) {
  const home = canonicalHarnessSlug(operatorHomeHarnessSlug());
  const subject = {
    harness: home,
    scope: 'operator-home-release-pipeline' as const,
    integrationRoot: integrationRoot(),
    note:
      `Every sha, gate verdict and deploy position in this reply describes the \`${home}\` operator release pipeline ONLY. ` +
      'Other harnesses run their own green-checkpoint and promotion — this reply is not evidence about them.',
  };

  const raw = ctx?.harnessSlug?.trim();
  const caller = raw && raw !== '*' ? canonicalHarnessSlug(raw) : null;
  if (!caller || caller === home) return { subject };

  return {
    subject,
    harnessMismatch: {
      callerHarness: caller,
      reportedHarness: home,
      warning:
        `⚠ CROSS-HARNESS READ — you called from harness \`${caller}\`, but release:trace reports the \`${home}\` operator pipeline. ` +
        `These SHAs, gate reds and deploy positions are NOT \`${caller}\`'s and must not be quoted as its release truth: ` +
        `\`${caller}\` promotes on its OWN green-checkpoint. This tool has no \`${caller}\` mode; use that harness's own release surface.`,
    },
  };
}
type ReleaseTraceSubjectStamp = ReturnType<typeof releaseTraceSubjectStamp>;

function throwReadError(read: BoundedTimeoutResult<unknown>, label: string): never {
  if (read.error instanceof Error) throw read.error;
  throw new Error(read.errorMessage ?? `${label} failed`);
}

function traceTimeoutResponse(
  args: { path?: string; sha?: string },
  stage: TraceTimeoutStage,
  timeoutMs: number,
  read: BoundedTimeoutResult<unknown>,
  subjectStamp: ReleaseTraceSubjectStamp,
  event?: string,
) {
  return {
    data: {
      ok: false,
      ...subjectStamp,
      target: { path: args.path ?? null, sha: args.sha ?? null },
      trace: { status: 'unknown', complete: false },
      nextVerb: null,
      error: {
        code: 'trace_timeout',
        stage,
        retryable: true,
        timeoutMs,
        elapsedMs: read.elapsedMs,
        ...(event ? { event } : {}),
        message: `release:trace ${stage} did not complete within ${timeoutMs}ms; release truth is unknown — retry the read`,
      },
    },
  };
}

function payloadSha(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  for (const key of ['sha', 'commitSha', 'commit_sha', 'deployedSha', 'deployed_sha', 'testedSha', 'tested_sha']) {
    if (typeof row[key] === 'string') return row[key].toLowerCase();
  }
  return null;
}

function sameSha(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left === right || left.startsWith(right) || right.startsWith(left);
}

function pipelineName(root: string): string {
  return (path.basename(path.resolve(root)).replace(/[^a-zA-Z0-9_-]/g, '-') || 'default').slice(0, 64);
}

const tracePath = z
  .string()
  .min(1)
  .max(400)
  .describe('Repo-relative path whose release position should be traced; required unless sha is supplied.');
const traceSha = z
  .string()
  .min(4)
  .max(64)
  .describe('Commit SHA whose release lineage should be traced; required unless path is supplied.');
const traceContext = {
  work_item: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe(
      'Optional work item to make the terminal nextVerb a ready work_items:set_live_verified call; it does not replace the required path or sha.',
    ),
  after_generation: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('generatedAtMs from the caller’s cached trace; any different generation requires full replacement.'),
};

export default defineTool({
  name: 'release:trace',
  profile: 'engineer',
  description:
    'One read-only, SHA-centric release truth: exact fix-commit containment in the gate\'s observed candidate, commit presence, exact gate + authoritative failing tests, green pin, deployed SHA, registered awaits, stale-wake lineage, tested/deployed parity, applicable safety constraints, and at most one safe nextVerb. Composes dev:pipeline_position, release:deploy status, and events:status authorities instead of creating another release state machine.',
  capability: 'intel:read',
  requirePrincipal: false,
  // EI-20246294559310854: this diagnostic composes several independent admin-pool,
  // git, and await-history reads and never consumes ctx.tx. Do not retain the
  // dispatcher's ambient org-app transaction while red-verdict reconciliation runs;
  // under pool pressure that held slot made release:trace itself hit
  // withWorkspace:acquire(app) before the read could finish.
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES, 'cup', 'release-fixer', 'release-manager'],
  guidance: {
    when: 'After a release/gate/deploy wake, or whenever one commit’s truth is scattered across pipeline, gate, deploy, and await reads. Pass path when runtime ownership matters; pass sha for the canonical exact ancestry answer at gate.fixCommitContainment — do not derive it from logs, working-tree diffs, or a hand-run merge-base.',
    notWhen:
      'To mutate the release pipeline. Follow the returned nextVerb; release:trace itself never commits, runs a gate, or deploys.',
    chaining:
      'release:trace { path | sha, work_item? } → follow the single non-null nextVerb → after a wake, call release:trace again with after_generation from the prior response. The await verb is progress-certified (default ON): only a `progressing` run yields checkpoint:await; `stalled`/`unknown` route elsewhere — do not re-read lane heartbeats to second-guess it.',
    returns:
      '{ generatedAtMs, target, gate: { candidateVerdict, fixCommitContainment, ... }, greenPin, deploy, testedDeployedParity, awaits, staleWake, constraints, nextVerb, resync, summary }',
    seeAlso: ['dev:pipeline_position', 'release:deploy', 'events:status', 'deploy:await', 'checkpoint:await'],
  },
  // Use a representable union rather than a refinement: the same schema is published to
  // callers as JSON Schema, where a custom refinement would disappear and advertise the
  // rejected work_item-only shape (EI-20232784385629302).
  args: z.union([
    z.object({ path: tracePath, sha: traceSha.optional(), ...traceContext }),
    z.object({ path: tracePath.optional(), sha: traceSha, ...traceContext }),
  ]),
  result: z
    .object({
      generatedAtMs: z.unknown().optional(),
      target: z.unknown().optional(),
      gate: z.unknown().optional(),
      greenPin: z.unknown().optional(),
      deploy: z.unknown().optional(),
      testedDeployedParity: z.unknown().optional(),
      awaits: z.unknown().optional(),
      staleWake: z.unknown().optional(),
      constraints: z.unknown().optional(),
      nextVerb: z.unknown().optional(),
      resync: z.unknown().optional(),
      summary: z.unknown().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const subjectStamp = releaseTraceSubjectStamp(ctx);
    if (!args.path && !args.sha) return { data: { ok: false, ...subjectStamp, error: 'Provide path or sha.' } };
    const identity = resolveAgentIdentity(ctx);
    // A diagnostic read must stay fork/sidecar-free. The default enables the
    // dev-deploy spawner sidecar, which can block this read while composing
    // release truth (EI-20264406467393669).
    const snapshotRead = await withBoundedTimeout(
      () => gitPipelineSnapshot(undefined, { useSpawnerSidecar: false, includeActiveRun: true }),
      {
        fallback: null,
        timeoutMs: RELEASE_TRACE_SNAPSHOT_TIMEOUT_MS,
        label: 'release:trace:pipeline-snapshot',
      },
    );
    if (snapshotRead.degraded) {
      if (snapshotRead.reason === 'error') throwReadError(snapshotRead, 'release:trace:pipeline-snapshot');
      return traceTimeoutResponse(
        args,
        'pipeline_snapshot',
        RELEASE_TRACE_SNAPSHOT_TIMEOUT_MS,
        snapshotRead,
        subjectStamp,
      );
    }
    const snapshot = snapshotRead.value;
    if (!snapshot) throw new Error('release:trace:pipeline-snapshot returned no snapshot');

    const positionRead = await withBoundedTimeout(
      () =>
        gitPipelinePosition(
          { path: args.path, sha: args.sha },
          {
            loadSnapshot: () => Promise.resolve(snapshot),
            loadDeploy: () => Promise.resolve(snapshot.deploy),
          },
        ),
      {
        fallback: null,
        timeoutMs: RELEASE_TRACE_POSITION_TIMEOUT_MS,
        label: 'release:trace:pipeline-position',
      },
    );
    if (positionRead.degraded) {
      if (positionRead.reason === 'error') throwReadError(positionRead, 'release:trace:pipeline-position');
      return traceTimeoutResponse(
        args,
        'pipeline_position',
        RELEASE_TRACE_POSITION_TIMEOUT_MS,
        positionRead,
        subjectStamp,
      );
    }
    const position = positionRead.value;
    if (!position) throw new Error('release:trace:pipeline-position returned no position');
    // An inconclusive checkpoint does not judge code. Its gate counters and failingTests
    // therefore describe the previous verdict and must not be attributed to this candidate.
    // Keep the older counters/candidate in the projection as historical context, but make
    // the gate non-authoritative and suppress its test names only for the exact candidate.
    const inconclusiveCandidate = snapshot.gate.inconclusive?.candidate;
    const candidateInconclusive = sameSha(position.targetSha, inconclusiveCandidate);
    const repairQueueInconclusive =
      candidateInconclusive &&
      (snapshot.gate.inconclusive?.status === 'repair-in-progress' ||
        snapshot.gate.inconclusive?.status === 'repair-staging-mismatch');
    const inheritedRepairQueueFailingTests = repairQueueInconclusive ? snapshot.gate.failingTests : [];
    // `gitPipelinePosition` performs the authoritative live run-lock read after the
    // snapshot. If that read finds an active checkpoint while the snapshot's probe did
    // not, reconcile it before computing deploy status; otherwise a stale snapshot
    // `fireStale` survives into release:trace even though a fresh verdict is in flight.
    const positionCheckpointRun = position.gate?.checkpointRunInFlight ?? null;
    const reconciledActiveRun =
      positionCheckpointRun?.active === true && snapshot.activeRun?.active !== true
        ? positionCheckpointRun
        : (snapshot.activeRun ?? positionCheckpointRun);
    const reconciledSnapshot =
      reconciledActiveRun === snapshot.activeRun ? snapshot : { ...snapshot, activeRun: reconciledActiveRun };
    const deploy = computeDeployStatus(reconciledSnapshot);
    // Keep the snapshot fallback for narrow contract doubles that only provide
    // the deploy state; production computeDeployStatus always supplies gate.
    const deployGate = deploy.gate ?? snapshot.gate;
    const pipeline = pipelineName(snapshot.deploy.integrationRoot);
    const keys = [
      buildKey('deploy', { sha: position.targetSha ?? args.sha }),
      buildKey('deploy-failed'),
      buildKey('checkpoint', { pipeline }),
      buildKey('checkpoint-red', { pipeline }),
    ];
    const historyReads = await Promise.all(
      keys.map(async (event) => {
        const read = await withBoundedTimeout(() => inspectEventKey(event), {
          fallback: null,
          timeoutMs: RELEASE_TRACE_AWAIT_TIMEOUT_MS,
          label: `release:trace:await-history:${event}`,
        });
        if (read.degraded && read.reason === 'error') throwReadError(read, `release:trace:await-history:${event}`);
        return { event, read };
      }),
    );
    const timedOutHistory = historyReads.find(({ read }) => read.degraded);
    if (timedOutHistory) {
      return traceTimeoutResponse(
        args,
        'await_history',
        RELEASE_TRACE_AWAIT_TIMEOUT_MS,
        timedOutHistory.read,
        subjectStamp,
        timedOutHistory.event,
      );
    }
    const histories = historyReads.map(({ event, read }) => {
      if (!read.value) throw new Error(`release:trace:await-history:${event} returned no history`);
      return { event, history: read.value };
    });
    const awaits: ReleaseTraceAwait[] = histories.flatMap(({ event, history }) =>
      history.waiters.map((row) => ({
        event,
        awaitId: row.id,
        subscriberId: row.subscriberId,
        state: row.cancelledAt
          ? 'cancelled'
          : row.firedAt
            ? row.firedReason === 'expired'
              ? 'expired'
              : 'fired'
            : 'registered',
        registeredAt: row.createdAt,
        firedAt: row.firedAt,
        firedReason: row.firedReason,
        observedSha: payloadSha(row.firedPayload),
      })),
    );
    const wakes: ReleaseTraceWake[] = histories.flatMap(({ event, history }) =>
      history.deliveries.map((row) => ({
        event,
        deliveryId: row.id,
        subscriberId: row.subscriberId,
        status: row.status,
        channel: row.channel,
        createdAt: row.createdAt,
        deliveredAt: row.deliveredAt,
        observedSha: payloadSha(row.payload),
      })),
    );

    // EI-21456558908416090: read the live manual-run authority alongside the other release
    // authorities. Bounded and fail-open by construction — `withBoundedTimeout`'s fallback is
    // the "no recorded prohibition" answer, which preserves this tool's pre-existing behaviour
    // exactly when the authority store is slow or down.
    const manualRunAuthority = await withBoundedTimeout(
      () => resolveManualRunAuthority({ readerOwnerId: identity.ownerId }),
      {
        fallback: null,
        timeoutMs: RELEASE_TRACE_AWAIT_TIMEOUT_MS,
        label: 'release:trace:manual-run-authority',
      },
    );

    // P-005 / D-015 io seam: buildReleaseTrace stays pure, so the steering kill-switch is
    // resolved HERE and handed in. `.catch(() => true)` fails OPEN to the shipped default-ON
    // behaviour — a flag store that is down must not silently strip the certificate, because a
    // missing certificate is indistinguishable from a healthy run in the rendered verb.
    const progressCertificateEnabled = await getFlag(
      FLAGS.RELEASE_TRACE_PROGRESS_CERTIFICATE,
      identity.ownerId,
    ).catch(() => true);

    const trace = buildReleaseTrace({
      position,
      progressCertificateEnabled,
      deploy,
      pipeline,
      inspectedKeys: keys,
      awaits,
      wakes,
      snapshotGeneration: snapshot.generatedAtMs,
      consumerGeneration: args.after_generation,
      requesterId: identity.ownerId,
      workItem: args.work_item,
      gate: {
        state: deploy.state,
        authoritative: !snapshot.gate.verdictStale && !candidateInconclusive,
        consecutiveReds: snapshot.gate.consecutiveReds,
        failingTests: snapshot.gate.verdictStale || candidateInconclusive ? [] : snapshot.gate.failingTests,
        failingTestsMeasured:
          snapshot.gate.verdictStale || candidateInconclusive ? false : snapshot.gate.failingTestsMeasured,
        // EI-18832825158594027: the blanking above only covers a STALE verdict / inconclusive
        // candidate. The monotonic fold inherits a prior observation's names for the SAME
        // candidate, where `verdictStale` is legitimately false — so those names survive the
        // blanking and render as an authoritative, current blame list. This marker is the axis
        // that distinguishes them. False when the list was blanked: `[]` has nothing to inherit.
        failingTestsCarriedForward:
          snapshot.gate.verdictStale || candidateInconclusive
            ? false
            : snapshot.gate.failingTestsCarriedForward === true,
        recordedVerdict: snapshot.gate.recordedVerdict,
        inheritedRepairQueueFailingTests,
        inheritedRepairQueueFailingTestsSource: repairQueueInconclusive ? 'prior-gate-verdict' : null,
        // Use computeDeployStatus's active-run-aware projection. Forwarding the raw
        // snapshot freshness here could say "not firing" while the same snapshot proves
        // a live checkpoint is producing the next verdict (EI-21313251739637753).
        fireStale: deployGate.fireStale,
        fireStaleReason: deployGate.fireStaleReason,
        verdictStale: snapshot.gate.verdictStale,
        verdictStaleReason: snapshot.gate.verdictStaleReason,
        // The checkpoint judges the local integration root. Preserve the exact
        // candidate so release:trace can distinguish gate eligibility from the
        // separate origin/GitHub publication leg.
        observedCandidate: snapshot.gate.observedCandidate,
        // Preserve the live run projection from gitPipelinePosition. The terminal
        // observedCandidate can legitimately name an older verdict while this run
        // is judging a newer candidate.
        checkpointRunInFlight: positionCheckpointRun ?? undefined,
        // EI-21103060581352507: preserve the gate's terminal no-verdict
        // authority so release:trace can refuse an await for a cancelled
        // candidate whose measured producer is already gone.
        inconclusive: snapshot.gate.inconclusive,
        // EI-18672078222841101: who already owns this red. Unlike `failingTests` above
        // this is NOT blanked on a stale verdict — `describeGateRedOwnership` renders the
        // staleness itself ('verdict-stale'), which is exactly the case that misled a
        // reader of this tool into diagnosing an already-fixed leg.
        redOwner: snapshot.gate.redOwner,
        // EI-21456558908416090: whether a recorded decision currently withholds manual
        // checkpoint-run authority, so this tool stops recommending the one action the active
        // plan forbids. Fails OPEN on a slow/failed authority read: this tool only RECOMMENDS,
        // release:checkpoint-run enforces the same tokens and fails closed itself, and blanking
        // the nextVerb of a diagnostic on a transient blip would degrade it exactly when the
        // pipeline is already unhealthy and agents most need it.
        manualRunAuthority: manualRunAuthority.value ?? null,
      },
    });
    // `tool_invocations` already records the tool name, args, and coord_owner_id. Stamp the
    // result-side ancestry tuple too so a wrong lever can be attributed to either a bad
    // canonical read or a caller bypass without reconstructing the response body.
    ctx.metadata?.({
      releaseTraceFixCommitContainment: {
        callerId: identity.ownerId,
        fixSha: trace.gate.fixCommitContainment.fixSha,
        observedCandidate: trace.gate.fixCommitContainment.observedCandidate,
        verdict: trace.gate.fixCommitContainment.verdict,
      },
    });
    const plane = statePlaneForDoor(trace, 'release:trace', { path: args.path, sha: args.sha }, ctx);
    return {
      data: {
        ...trace,
        repairQueue: snapshot.gate.repairQueue ?? null,
        repairQueueRead: snapshot.gate.repairQueueRead,
        ...subjectStamp,
        ...(plane ? { plane } : {}),
      },
    };
  },
});
