/**
 * Readiness evaluator for the public-release post-GO sequence.
 *
 * It deliberately does not start a canary, run chaos, change defaults, or
 * authorize shipment. It consumes already-produced evidence and proves that:
 *   P-501 began only after an independent GO and met its release-scoped minimum;
 *   P-502 followed the soak and retained the single-owning-hive freeze model;
 *   P-503 may now make the separate automatic-mode/default decision.
 */
import {
  validatePhysicalPhaseG,
  type PhysicalPhaseGInput,
} from './physical-drill-phase-g';
import {
  phaseITargetOf,
  validatePhysicalPhaseI,
  type PhysicalPhaseIInput,
} from './physical-drill-phase-i';
import {
  validatePostGoCanaryEvidence,
  type PostGoCanaryEvidence,
} from './post-go-canary-observations';

export const POST_GO_RELEASE_CANARY_SCHEMA = 'hive-git-post-go-release-canary/v1' as const;
/** Default P-501 soak minimum for every release without an owner ruling. */
export const POST_GO_RELEASE_CANARY_MIN_DURATION_MS = 72 * 60 * 60 * 1_000;
export const POST_GO_RELEASE_PLAN_ITEMS = ['P-501', 'P-502', 'P-503'] as const;

/**
 * Release-scoped soak minimums, each backed by a recorded owner ruling.
 * Endgame D-132 removes the timed soak for 0.0.28-alpha; D-163 carries that
 * ruling to its 0.0.29-alpha replacement. Other releases retain the 72h default.
 * Keep this keyed by exact release
 * version: a global edit would silently shorten every later soak.
 */
export const POST_GO_RELEASE_CANARY_DURATION_OVERRIDES: Readonly<
  Record<string, { minimumDurationMs: number; decisionRef: string }>
> = Object.freeze({
  '0.0.28-alpha': {
    minimumDurationMs: 0,
    decisionRef: 'p2p-public-release-endgame-2026-09-01#D-132',
  },
  '0.0.29-alpha': {
    minimumDurationMs: 0,
    decisionRef: 'p2p-public-release-endgame-2026-09-01#D-163',
  },
});

const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The soak minimum that applies to `releaseVersion`, with its authority. */
export function postGoReleaseCanaryMinimum(releaseVersion: unknown): {
  minimumDurationMs: number;
  decisionRef: string | null;
} {
  const override =
    typeof releaseVersion === 'string' &&
    Object.prototype.hasOwnProperty.call(POST_GO_RELEASE_CANARY_DURATION_OVERRIDES, releaseVersion)
      ? POST_GO_RELEASE_CANARY_DURATION_OVERRIDES[releaseVersion]
      : undefined;
  return override
    ? { minimumDurationMs: override.minimumDurationMs, decisionRef: override.decisionRef }
    : { minimumDurationMs: POST_GO_RELEASE_CANARY_MIN_DURATION_MS, decisionRef: null };
}

function formatHours(ms: number): string {
  return String(Math.round((ms / 3_600_000) * 100) / 100);
}

const GIT_OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const OWNER_ID = /^[A-Za-z0-9._:@-]{3,160}$/;

export type PostGoReleaseCanaryInput = {
  schemaVersion: typeof POST_GO_RELEASE_CANARY_SCHEMA;
  candidateSha: string;
  /**
   * The release this candidate ships as (e.g. "0.0.28-alpha"). It selects the
   * soak minimum from POST_GO_RELEASE_CANARY_DURATION_OVERRIDES (default 72h).
   */
  releaseVersion: string;
  independentGo: {
    decision: 'GO';
    candidateSha: string;
    approvedAt: string;
    reviewerOwnerId: string;
    implementationOwnerId: string;
    attestationRef: string;
  };
  /**
   * The soak window plus its P-501 substance (C1-C6): hourly observations of
   * the canary hive, the adjudicated alarm history and the alarm-rail proof.
   * See post-go-canary-observations.ts.
   */
  canary: PostGoCanaryEvidence & {
    candidateSha: string;
    startedAt: string;
    finishedAt: string;
  };
  ownerFreezeChaos: {
    candidateSha: string;
    window: {
      startedAt: string;
      finishedAt: string;
    };
    phaseG: PhysicalPhaseGInput;
    /**
     * The owner-outage and recovery evidence (WI-10004733). The verdicts
     * "protected effects froze during the outage" and "they resumed only after
     * the owning-hive proof was restored" are DERIVED from a validated P-521
     * Phase I run (live -> lost -> outage -> restored through the production
     * sinks), never accepted as hand-typed fields: the former
     * duringOwnerOutage / afterOwnerRecovery strings had no producer.
     */
    phaseI: PhysicalPhaseIInput;
  };
  evaluatedAt: string;
};

export type PostGoReleaseCanaryVerdict = {
  ok: boolean;
  errors: string[];
  result: null | {
    schemaVersion: typeof POST_GO_RELEASE_CANARY_SCHEMA;
    candidateSha: string;
    status: 'ready-for-default-mode-decision';
    planItems: typeof POST_GO_RELEASE_PLAN_ITEMS;
    independentGoApprovedAt: string;
    releaseVersion: string;
    canaryDurationMs: number;
    minimumDurationMs: number;
    /** The owner ruling that set a non-default minimum; null for the 72h default. */
    minimumDurationDecisionRef: string | null;
    canaryHive: string;
    canaryObservationCount: number;
    ownerFreezeVerified: true;
    ownerRecoveryVerified: true;
    observedAt: string;
  };
};

function pushError(errors: string[], condition: boolean, message: string): void {
  if (!condition) errors.push(message);
}

function timestamp(value: unknown): number {
  return Date.parse(typeof value === 'string' ? value : '');
}

export function validatePostGoReleaseCanary(
  input: PostGoReleaseCanaryInput,
): PostGoReleaseCanaryVerdict {
  const errors: string[] = [];
  const candidateSha = input?.candidateSha ?? '';

  pushError(
    errors,
    input?.schemaVersion === POST_GO_RELEASE_CANARY_SCHEMA,
    `schemaVersion must be ${POST_GO_RELEASE_CANARY_SCHEMA}`,
  );
  pushError(errors, GIT_OID.test(candidateSha), 'candidateSha must be a 40- or 64-hex Git OID');
  const releaseVersion = input?.releaseVersion ?? '';
  pushError(
    errors,
    typeof releaseVersion === 'string' && RELEASE_VERSION.test(releaseVersion),
    'releaseVersion must name the shipping release (e.g. 0.0.28-alpha)',
  );
  const minimum = postGoReleaseCanaryMinimum(releaseVersion);

  const go = input?.independentGo;
  pushError(errors, go?.decision === 'GO', 'independentGo.decision must be GO');
  pushError(errors, go?.candidateSha === candidateSha, 'independent GO must bind the exact candidate');
  pushError(
    errors,
    OWNER_ID.test(go?.reviewerOwnerId ?? '') && OWNER_ID.test(go?.implementationOwnerId ?? ''),
    'independent GO must name valid reviewer and implementation owner ids',
  );
  pushError(
    errors,
    go?.reviewerOwnerId !== go?.implementationOwnerId,
    'independent GO reviewer must differ from the implementation owner',
  );
  pushError(
    errors,
    typeof go?.attestationRef === 'string' && go.attestationRef.trim().length > 0,
    'independent GO must carry a durable attestationRef',
  );

  const approvedAt = timestamp(go?.approvedAt);
  const canaryStartedAt = timestamp(input?.canary?.startedAt);
  const canaryFinishedAt = timestamp(input?.canary?.finishedAt);
  const canaryDurationMs = canaryFinishedAt - canaryStartedAt;
  pushError(errors, Number.isFinite(approvedAt), 'independent GO approvedAt must be ISO-8601');
  pushError(
    errors,
    input?.canary?.candidateSha === candidateSha,
    'canary must bind the exact independently approved candidate',
  );
  pushError(
    errors,
    Number.isFinite(canaryStartedAt) &&
      Number.isFinite(canaryFinishedAt) &&
      canaryStartedAt <= canaryFinishedAt,
    'canary window must contain ordered ISO-8601 timestamps',
  );
  pushError(
    errors,
    Number.isFinite(approvedAt) &&
      Number.isFinite(canaryStartedAt) &&
      canaryStartedAt >= approvedAt,
    'canary cannot start before the independent GO',
  );
  if (minimum.minimumDurationMs > 0) {
    pushError(
      errors,
      Number.isFinite(canaryDurationMs) &&
        canaryDurationMs >= minimum.minimumDurationMs,
      `canary must run for an actual minimum of ${formatHours(minimum.minimumDurationMs)} hours` +
        (minimum.decisionRef ? ` (${releaseVersion}, ${minimum.decisionRef})` : ''),
    );
  }
  // Duration alone would pass a full-length window full of divergence escalations and
  // STALLED pages (WI-10002545): every P-501 predicate must hold throughout.
  errors.push(
    ...validatePostGoCanaryEvidence(
      input?.canary,
      { startedAt: input?.canary?.startedAt ?? '', finishedAt: input?.canary?.finishedAt ?? '' },
      input?.evaluatedAt ?? '',
    ),
  );

  const chaos = input?.ownerFreezeChaos;
  const chaosStartedAt = timestamp(chaos?.window?.startedAt);
  const chaosFinishedAt = timestamp(chaos?.window?.finishedAt);
  pushError(
    errors,
    chaos?.candidateSha === candidateSha,
    'owner-freeze chaos must bind the exact canary candidate',
  );
  pushError(
    errors,
    Number.isFinite(chaosStartedAt) &&
      Number.isFinite(chaosFinishedAt) &&
      chaosStartedAt <= chaosFinishedAt,
    'owner-freeze chaos window must contain ordered ISO-8601 timestamps',
  );
  pushError(
    errors,
    Number.isFinite(canaryFinishedAt) &&
      Number.isFinite(chaosStartedAt) &&
      chaosStartedAt >= canaryFinishedAt,
    'owner-freeze chaos cannot execute before the canary soak finishes',
  );
  const phaseI = chaos?.phaseI;
  const phaseIStartedAt = timestamp(phaseI?.window?.startedAt);
  const phaseIFinishedAt = timestamp(phaseI?.window?.finishedAt);
  pushError(
    errors,
    Number.isFinite(phaseIStartedAt) &&
      Number.isFinite(phaseIFinishedAt) &&
      phaseIStartedAt >= chaosStartedAt &&
      phaseIFinishedAt <= chaosFinishedAt,
    'Phase I evidence must fall inside the post-canary owner-freeze chaos window',
  );
  let ownerFreezeVerified = false;
  let ownerRecoveryVerified = false;
  try {
    const phaseIVerdict = validatePhysicalPhaseI(phaseI as PhysicalPhaseIInput);
    for (const error of phaseIVerdict.errors) errors.push(`Phase I: ${error}`);
    const assertions = phaseIVerdict.ok ? phaseIVerdict.result?.assertions : undefined;
    ownerFreezeVerified =
      assertions?.ownerOutageFrozeBothHostsWithoutFailover === true &&
      assertions?.authorityLostBetweenPushAttemptsFroze === true;
    ownerRecoveryVerified = assertions?.restoredOwnerMadeFreshAuthorizedProgress === true;
  } catch (error) {
    errors.push(
      `Phase I evidence is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // D-119 / WI-10004748: P-502 must freeze the canary's REAL owning authority.
  // A Phase I run against a disposable minted key (the P-521 drill target)
  // proves the fencing model, not that the live canary owner froze.
  const phaseITarget = phaseI ? phaseITargetOf(phaseI) : null;
  const canaryOwnerBound =
    phaseITarget?.kind === 'canary-owner' &&
    phaseITarget.potHomeSlug === input.canary?.hive &&
    phaseI?.owner?.first?.hiveId === phaseITarget.hiveId &&
    phaseI?.owner?.restored?.hiveId === phaseITarget.hiveId;
  pushError(
    errors,
    canaryOwnerBound,
    'Phase I must target the canary hive\'s real owning authority (target.kind canary-owner, potHomeSlug = canary.hive, owner hiveId = target.hiveId)',
  );
  if (!canaryOwnerBound) ownerFreezeVerified = ownerRecoveryVerified = false;
  pushError(
    errors,
    ownerFreezeVerified,
    'owner outage must freeze protected effects and refuse non-owner authority',
  );
  pushError(
    errors,
    ownerRecoveryVerified,
    'protected effects may resume only after owning-hive proof is restored',
  );

  const phaseG = chaos?.phaseG;
  const phaseGStartedAt = timestamp(phaseG?.window?.startedAt);
  const phaseGFinishedAt = timestamp(phaseG?.window?.finishedAt);
  pushError(
    errors,
    Number.isFinite(phaseGStartedAt) &&
      Number.isFinite(phaseGFinishedAt) &&
      phaseGStartedAt >= chaosStartedAt &&
      phaseGFinishedAt <= chaosFinishedAt,
    'Phase G evidence must fall inside the post-canary owner-freeze chaos window',
  );
  try {
    const phaseGVerdict = validatePhysicalPhaseG(phaseG);
    for (const error of phaseGVerdict.errors) errors.push(`Phase G: ${error}`);
    pushError(
      errors,
      phaseGVerdict.ok && phaseGVerdict.result?.complete === true,
      'owner-freeze chaos must contain complete validated P-308 Phase G evidence',
    );
  } catch (error) {
    errors.push(
      `Phase G evidence is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const evaluatedAt = timestamp(input?.evaluatedAt);
  pushError(
    errors,
    Number.isFinite(evaluatedAt) &&
      Number.isFinite(chaosFinishedAt) &&
      evaluatedAt >= chaosFinishedAt,
    'evaluatedAt must be at or after the completed owner-freeze chaos window',
  );
  // Ordered timestamps alone admit an entirely future-dated 72-hour receipt.
  // The verifier's clock, not a value inside that receipt, bounds elapsed time.
  pushError(
    errors,
    Number.isFinite(evaluatedAt) && evaluatedAt <= Date.now(),
    'evaluatedAt cannot be in the future relative to the verifier clock',
  );

  const uniqueErrors = [...new Set(errors)];
  if (uniqueErrors.length > 0) return { ok: false, errors: uniqueErrors, result: null };
  return {
    ok: true,
    errors: [],
    result: {
      schemaVersion: POST_GO_RELEASE_CANARY_SCHEMA,
      candidateSha,
      status: 'ready-for-default-mode-decision',
      planItems: POST_GO_RELEASE_PLAN_ITEMS,
      independentGoApprovedAt: go.approvedAt,
      releaseVersion,
      canaryDurationMs,
      minimumDurationMs: minimum.minimumDurationMs,
      minimumDurationDecisionRef: minimum.decisionRef,
      canaryHive: input.canary.hive,
      canaryObservationCount: input.canary.observations.length,
      ownerFreezeVerified: true,
      ownerRecoveryVerified: true,
      observedAt: input.evaluatedAt,
    },
  };
}
