import {
  WORKSPACE_HOST_CREDENTIAL_CHANNELS,
  buildWorkspaceHostInitializationCanaryEvidence,
  validateWorkspaceHostInitializationCanary,
  type WorkspaceHostAgentVerificationReport,
  type WorkspaceHostCredentialChannel,
  type WorkspaceHostCredentialLifecyclePlan,
  type WorkspaceHostCredentialLifecycleReceipt,
  type WorkspaceHostInitializationCanaryEvidence,
  type WorkspaceHostInitializationCanaryValidation,
} from '@papercusp/deployment-driver';

/**
 * Assemble the P-046 canary evidence from REAL credential-lifecycle receipts.
 *
 * WHY THIS FILE EXISTS. `buildWorkspaceHostInitializationCanaryEvidence` and
 * `validateWorkspaceHostInitializationCanary` were both complete and both had ZERO production
 * callers — only their own tests. So the artifact that closes P-046 ("a private-repository plus
 * all-three-agent live canary") had no producer at all: the lifecycle could run, and nothing
 * turned what it observed into evidence. This is that seam.
 *
 * WHY DERIVATION IS THE WHOLE JOB. The evidence type declares each field as the literal `true`
 * (`bound: true`, `rotated: true`, …), which makes a FAILING canary unrepresentable. The builder
 * already refuses to widen a false observation into that literal. This module is the layer above
 * it, and it inherits the same obligation: every boolean here is DERIVED by joining a receipt to
 * the plan step it answers. Nothing is asserted, and nothing defaults to `true` — a channel with
 * no receipt for a transition is `false`, which the builder then rejects with the specific
 * shortfall. A missing observation must read as "not observed", never as "fine".
 */

/** One completed lifecycle action: the plan that was executed, and the receipts it produced. */
export interface WorkspaceHostCanaryLifecycleRun {
  readonly plan: WorkspaceHostCredentialLifecyclePlan;
  readonly receipts: readonly WorkspaceHostCredentialLifecycleReceipt[];
}

/** The four transitions the canary validator demands, per channel. */
export interface WorkspaceHostCanaryChannelObservation {
  readonly bound: boolean;
  readonly rotated: boolean;
  readonly previousBindingRevoked: boolean;
  readonly reconnected: boolean;
}

export type WorkspaceHostCanaryChannelObservations = Readonly<
  Record<WorkspaceHostCredentialChannel, WorkspaceHostCanaryChannelObservation>
>;

export class WorkspaceHostCanaryObservationError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Canary lifecycle observations are not usable: ${problems.join('; ')}`);
    this.name = 'WorkspaceHostCanaryObservationError';
    this.problems = problems;
  }
}

interface MutableObservation {
  bound: boolean;
  rotated: boolean;
  previousBindingRevoked: boolean;
  reconnected: boolean;
  /** Index of the run that last PROVED this channel bound; -1 while never proven. */
  lastBoundRun: number;
  /** Index of the run that last PROVED a binding on this channel revoked; -1 while never. */
  lastRevokedRun: number;
}

function emptyObservation(): MutableObservation {
  return {
    bound: false,
    rotated: false,
    previousBindingRevoked: false,
    reconnected: false,
    lastBoundRun: -1,
    lastRevokedRun: -1,
  };
}

/**
 * Derive per-channel canary observations from completed lifecycle runs.
 *
 * THE JOIN, AND WHY IT IS NOT STRING MATCHING. A receipt carries only `{ stepId, evidence }` —
 * it does not restate which channel or transition it answers. The planner does encode that in
 * the step id (`bind-next-<channel>`, `verify-revoked-<channel>`, …), and parsing those ids
 * would "work" — but it would silently re-implement the planner's naming scheme in a second
 * place, and would keep passing if the planner ever renamed a step. So the join goes through the
 * PLAN instead: `stepId` resolves to the plan's own step, which carries `kind` and `channel` as
 * data. A receipt that resolves to no step is an integrity fault between runner and plan, and is
 * reported rather than skipped.
 *
 * WHY THE PLAN'S `action` DISAMBIGUATES. `rotated` and `reconnected` are BOTH proven by a
 * `verify-bound` receipt, and the receipts are indistinguishable on their own. What separates
 * them is which action was being performed — a rotate's verify proves rotation, a reconnect's
 * verify proves reconnection. Pooling receipts across runs would let a rotate's verify satisfy
 * `reconnected`, manufacturing a transition that was never exercised. That is precisely the
 * dishonesty the evidence builder exists to prevent, so the attribution happens per run.
 */
export function deriveWorkspaceHostCanaryChannelObservations(
  runs: readonly WorkspaceHostCanaryLifecycleRun[],
): WorkspaceHostCanaryChannelObservations {
  const problems: string[] = [];
  const observations = new Map<WorkspaceHostCredentialChannel, MutableObservation>(
    WORKSPACE_HOST_CREDENTIAL_CHANNELS.map((channel) => [channel, emptyObservation()] as const),
  );

  runs.forEach((run, runIndex) => {
    const steps = new Map(run.plan.steps.map((step) => [step.id, step] as const));
    const action = run.plan.action;

    for (const receipt of run.receipts) {
      const step = steps.get(receipt.stepId);
      if (!step) {
        problems.push(
          `run ${runIndex} ('${action}') produced a receipt for step '${receipt.stepId}', which is not in its own plan`,
        );
        continue;
      }

      const observed = observations.get(step.channel);
      if (!observed) {
        problems.push(`run ${runIndex} ('${action}') reported step '${step.id}' on unknown channel '${step.channel}'`);
        continue;
      }

      // Only the VERIFY transitions are evidence. A bare `bind`/`revoke` receipt says the
      // mutation was attempted; the matching verify is what says it held. The planner always
      // emits the verify as a dependent step, so requiring it costs nothing and closes the gap
      // where an unverified mutation would read as a proven one.
      if (step.kind === 'verify-bound') {
        observed.bound = true;
        observed.lastBoundRun = runIndex;
        if (action === 'rotate') observed.rotated = true;
        if (action === 'reconnect') observed.reconnected = true;
      } else if (step.kind === 'verify-revoked') {
        observed.lastRevokedRun = runIndex;
        // A rotate revokes the PREVIOUS binding after proving the next one bound; a standalone
        // revoke proves a binding that existed is gone. Both establish that a real binding was
        // revoked, which is what the canary's `previousBindingRevoked` claims.
        if (action === 'rotate' || action === 'revoke') observed.previousBindingRevoked = true;
      }
    }
  });

  // ORDER MATTERS, and pooled booleans cannot see it. `bound` records that a verify-bound
  // receipt exists SOMEWHERE in the sequence; it does not say the channel is still bound at the
  // end. A sequence that rotates, reconnects, and then revokes would set every flag while
  // leaving the channel with no live binding — evidence that is true in each part and false as
  // a whole. Comparing the last proving run of each kind is what catches that.
  for (const [channel, observed] of observations) {
    if (observed.bound && observed.lastRevokedRun > observed.lastBoundRun) {
      problems.push(
        `the '${channel}' channel was revoked (run ${observed.lastRevokedRun}) after it was last proven bound (run ${observed.lastBoundRun}), so it is not bound at the end of the canary`,
      );
    }
  }

  if (problems.length > 0) throw new WorkspaceHostCanaryObservationError(problems);

  return Object.fromEntries(
    [...observations].map(([channel, observed]) => [
      channel,
      {
        bound: observed.bound,
        rotated: observed.rotated,
        previousBindingRevoked: observed.previousBindingRevoked,
        reconnected: observed.reconnected,
      },
    ]),
  ) as WorkspaceHostCanaryChannelObservations;
}

export interface AssembleWorkspaceHostCanaryEvidenceInput {
  readonly runId: string;
  readonly workspaceId: string;
  readonly hostId: string;
  readonly observedAt: string;
  readonly repository: { readonly visibility: 'public' | 'private'; readonly cloned: boolean };
  readonly agents: WorkspaceHostAgentVerificationReport;
  /** Completed lifecycle runs, in the order they were executed. */
  readonly lifecycleRuns: readonly WorkspaceHostCanaryLifecycleRun[];
  readonly backupRestore: {
    readonly authorizationMaterialExcluded: boolean;
    readonly credentialReferencesExcluded: boolean;
    readonly reboundChannels: readonly WorkspaceHostCredentialChannel[];
  };
}

export interface WorkspaceHostCanaryAssembly {
  readonly evidence: WorkspaceHostInitializationCanaryEvidence;
  readonly validation: WorkspaceHostInitializationCanaryValidation;
  readonly channelObservations: WorkspaceHostCanaryChannelObservations;
}

/**
 * Turn observed lifecycle runs into validated canary evidence.
 *
 * The builder throws on any shortfall rather than returning failing evidence, so a caller that
 * gets a value back knows every transition was observed. Validation still runs here and is
 * returned: the builder proves the observations, the validator proves the ASSEMBLED artifact
 * satisfies the contract the plan closes against, and keeping both means a future change to
 * either one cannot quietly diverge from the other.
 */
export function assembleWorkspaceHostCanaryEvidence(
  input: AssembleWorkspaceHostCanaryEvidenceInput,
): WorkspaceHostCanaryAssembly {
  const channelObservations = deriveWorkspaceHostCanaryChannelObservations(input.lifecycleRuns);

  const evidence = buildWorkspaceHostInitializationCanaryEvidence({
    runId: input.runId,
    workspaceId: input.workspaceId,
    hostId: input.hostId,
    observedAt: input.observedAt,
    repository: input.repository,
    agents: input.agents,
    channelLifecycle: channelObservations,
    backupRestore: input.backupRestore,
  });

  return {
    evidence,
    validation: validateWorkspaceHostInitializationCanary(evidence),
    channelObservations,
  };
}
