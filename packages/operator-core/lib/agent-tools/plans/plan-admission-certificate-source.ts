/**
 * Production FinalizationCertificate -> AdmissionCertificate source.
 *
 * Governance events are read from the pot's durable federated setting log, folded
 * with the shared governance projector, and resolved for the exact plan revision
 * and policy epoch the lifecycle door is holding. The newest matching round wins
 * deterministically; an open/paused/revoked/quarantined newer round therefore
 * cannot be bypassed by an older certificate for the same revision.
 */
import { canonicalJson } from '../../authority/authority-rpc-envelope';
import { resolveFederatedPotScope } from '../../federated-pot-scope';
import { potHomeSlugForHarness } from '../../hive-federation';
import {
  admissibleCertificate,
  projectGovernanceFederation,
  resolveRoundControls,
  type FederatedGovernanceEvent,
  type PlanGovernanceControls,
} from './governance-federation';
import type { GovernanceRound } from './governance-round';
import type { AdmissionCertificate } from './plan-admission-enforcement';
import type { PlanAdmissionCertificateSource } from './plan-admission-gate';
import {
  readPlanAdmissionGovernanceSnapshot,
  type PlanAdmissionGovernanceSnapshot,
} from './plan-admission-governance-store';

type ResolvePotHomeSlug = (
  workspaceId: string,
  harnessSlug: string,
) => Promise<string | null>;
type ReadSnapshot = (
  input: { workspaceId: string; potHomeSlug: string },
) => Promise<PlanAdmissionGovernanceSnapshot>;

export interface PlanAdmissionCertificateSourceDeps {
  readonly resolvePotHomeSlug?: ResolvePotHomeSlug;
  readonly readSnapshot?: ReadSnapshot;
}

export function bridgeFinalizationToAdmissionCertificate(
  certificate: {
    readonly planRevisionHash: string;
    readonly policyVersion: number;
    readonly admitted: boolean;
    readonly finalizedAtMs: number;
    readonly certificateHash: string;
  },
  ratificationWindowSec: number,
): AdmissionCertificate {
  return {
    planRevisionHash: certificate.planRevisionHash,
    policyVersion: certificate.policyVersion,
    admitted: certificate.admitted,
    expiresAtMs: certificate.finalizedAtMs + ratificationWindowSec * 1_000,
    certificateHash: certificate.certificateHash,
  };
}

function roundOpenEvents(
  events: readonly FederatedGovernanceEvent[],
  planRevisionHash: string,
  policyVersion: number,
): Array<{ event: FederatedGovernanceEvent; round: GovernanceRound }> {
  return events.flatMap((event) =>
    event.body.kind === 'round-open' &&
    event.body.round.planRevisionHash === planRevisionHash &&
    event.body.round.policyVersion === policyVersion
      ? [{ event, round: event.body.round }]
      : [],
  );
}

function quarantinedControls(roundId: string, detail: string): PlanGovernanceControls {
  return {
    roundId,
    status: 'quarantined',
    quarantineReason: detail,
    revokedReason: null,
  };
}

export function createPlanAdmissionCertificateSource(
  deps: PlanAdmissionCertificateSourceDeps = {},
): PlanAdmissionCertificateSource {
  const resolvePotHomeSlug = deps.resolvePotHomeSlug ?? potHomeSlugForHarness;
  const readSnapshot = deps.readSnapshot ?? readPlanAdmissionGovernanceSnapshot;

  return {
    async resolve(input) {
      const workspaceId = input.opts.workspaceId;
      const harnessSlug = input.opts.harnessSlug;
      if (!workspaceId || !harnessSlug) return { certificate: null, governance: null };

      try {
        const potHomeSlug = await resolvePotHomeSlug(workspaceId, harnessSlug);
        if (!potHomeSlug) return { certificate: null, governance: null };
        const snapshot = await readSnapshot({ workspaceId, potHomeSlug });
        // A malformed dedicated-prefix row means the event set is incomplete or
        // tampered. Never admit from a partial subset that merely happens to retain
        // one valid finalization certificate.
        if (snapshot.integrityErrors.length > 0) {
          return { certificate: null, governance: null };
        }

        const candidates = roundOpenEvents(
          snapshot.events,
          input.planRevisionHash,
          input.policy.policyVersion,
        ).sort(
          (a, b) =>
            b.round.createdAtMs - a.round.createdAtMs ||
            a.round.roundId.localeCompare(b.round.roundId) ||
            a.event.eventId.localeCompare(b.event.eventId),
        );
        const selected = candidates[0];
        if (!selected) return { certificate: null, governance: null };

        const selectedRoundDefinitions = new Set(
          snapshot.events.flatMap((event) =>
            event.body.kind === 'round-open' && event.body.round.roundId === selected.round.roundId
              ? [canonicalJson(event.body.round)]
              : [],
          ),
        );
        if (
          snapshot.conflictedRoundIds.has(selected.round.roundId) ||
          selectedRoundDefinitions.size > 1
        ) {
          return {
            certificate: null,
            governance: quarantinedControls(
              selected.round.roundId,
              `immutable governance-event conflict for round ${selected.round.roundId}`,
            ),
          };
        }

        const projection = projectGovernanceFederation(snapshot.potId, snapshot.events);
        const governance = resolveRoundControls(
          projection,
          selected.round.roundId,
          input.nowMs,
        );
        const finalization = admissibleCertificate(
          projection,
          selected.round.roundId,
          input.nowMs,
        );
        if (!finalization) return { certificate: null, governance };
        return {
          certificate: bridgeFinalizationToAdmissionCertificate(
            finalization,
            input.policy.ratificationWindowSec,
          ),
          governance,
        };
      } catch {
        // Governance exists, so a storage/scope read failure must fail CLOSED.
        // Returning no certificate gives the caller its normal typed refusal instead
        // of turning a transient backing-store fault into an unstructured tool crash.
        return { certificate: null, governance: null };
      }
    },
  };
}

/** Production default imported by the common gate; test overrides still win. */
export const productionPlanAdmissionCertificateSource =
  createPlanAdmissionCertificateSource({
    readSnapshot: async ({ workspaceId, potHomeSlug }) => {
      const potId = await resolveFederatedPotScope(workspaceId, potHomeSlug);
      const snapshot = await readPlanAdmissionGovernanceSnapshot({
        workspaceId,
        potHomeSlug,
      });
      // Pin the source and store to the same canonical identity even if a registry
      // refresh races the two reads. A mismatch fails closed as an integrity error.
      return snapshot.potId === potId
        ? snapshot
        : {
            ...snapshot,
            integrityErrors: [
              ...snapshot.integrityErrors,
              `pot scope changed while resolving certificate: '${potId}' -> '${snapshot.potId}'`,
            ],
          };
    },
  });
