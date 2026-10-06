/**
 * Publishing statement attestations on the public transparency report
 * (agent-economy-flywheel-2026-08-30 P-047 follow-up WI-10004823, D-031).
 *
 * The operator pushes each attestation RECORD to the Cupboard Worker over the
 * reconciliation HMAC (TRANSPARENCY_ATTESTATION_PATH), with its anchored
 * inclusion PROOF once the hourly anchor run covers the record's chain link
 * (`proof: null` until then). The Worker shows, beside each published monthly
 * statement, whether it is attested, by whom, against which scopes, and links
 * the proof.
 *
 * The Worker cannot read the chain, so it checks a proof OFFLINE only
 * (`statementAttestationProofProblem`): the record, its chain link and its
 * Merkle inclusion in the claimed root must all agree. Whether that root is
 * really on chain is the public reader's check, with `verifyStatementAttestation`
 * and an AnchorReader. This module imports no Postgres code.
 */
import { canonicalJson } from '@papercusp/hash-chain';
import type { AnchoredRoot, AnchorReader } from './ledger-anchor';
import {
  ATTESTATION_SCOPES,
  parseStatementAttestation,
  verifyStatementAttestation,
  type AttestationScope,
  type StatementAttestation,
  type StatementAttestationProof,
} from './statement-attestation';

export interface StatementAttestationPush {
  readonly workspaceId: string;
  readonly attestation: StatementAttestation;
  /** The anchored inclusion proof; null until an anchored root covers the record's chain link. */
  readonly proof: StatementAttestationProof | null;
}

/**
 * A reader that answers with the root the bundle itself claims. Verifying
 * against it checks everything but the chain lookup: the entry, the link hash
 * and the Merkle inclusion in that root.
 */
function claimedRootReader(proof: StatementAttestationProof): AnchorReader {
  const b = proof.bundle;
  const claimed: AnchoredRoot = {
    logId: b.logId,
    logRoot: b.logRoot,
    treeSize: b.treeSize,
    windowStart: b.anchor.windowStart,
    windowEnd: b.anchor.windowEnd,
    attester: b.anchor.attester,
    revoked: false,
  };
  return { read: async (ref) => (ref === b.anchor.ref ? claimed : null) };
}

/** Why `proof` does not prove `attestation` offline, or null when it does. */
export async function statementAttestationProofProblem(
  attestation: StatementAttestation,
  proof: StatementAttestationProof,
): Promise<string | null> {
  if (!proof || typeof proof !== 'object' || !proof.bundle || typeof proof.bundle !== 'object' || !proof.bundle.anchor) {
    return 'the proof is malformed';
  }
  if (canonicalJson(proof.attestation ?? null) !== canonicalJson(attestation)) return 'the proof is for a different attestation record';
  const verdict = await verifyStatementAttestation(proof, claimedRootReader(proof));
  return verdict.ok ? null : `the proof does not verify offline: ${verdict.reason}`;
}

/** Shape check for a push read off the wire; `null` when it is not one. */
export function parseStatementAttestationPush(raw: unknown): StatementAttestationPush | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.workspaceId !== 'string' || r.workspaceId.length === 0) return null;
  const attestation = parseStatementAttestation(r.attestation);
  if (!attestation || attestation.workspaceId !== r.workspaceId) return null;
  // `proof` is required on the wire: null (not yet anchored) or an object the Worker then checks.
  if (r.proof !== null && typeof r.proof !== 'object') return null;
  return { workspaceId: r.workspaceId, attestation, proof: r.proof as StatementAttestationProof | null };
}

/** One attestation as the public report shows it beside its month. */
export interface PublicAttestationSummary {
  readonly attestor: StatementAttestation['attestor'];
  readonly attestedOn: string;
  readonly scope: readonly AttestationScope[];
  /** Scopes the accountant did NOT attest (empty when all three were). */
  readonly scopeMissing: readonly AttestationScope[];
  readonly documentSha256: string;
  readonly statementDigest: string;
  /** `anchored` links the inclusion proof; `awaiting-anchor` until the anchor run covers the record. */
  readonly proof: { readonly status: 'anchored'; readonly url: string } | { readonly status: 'awaiting-anchor' };
}

/** A month's attestation status on the public report. */
export type PublicAttestationStatus =
  | { readonly status: 'attested'; readonly attestations: readonly PublicAttestationSummary[] }
  | { readonly status: 'not-attested' };

/** The public path serving one attestation's inclusion proof. */
export const attestationProofPath = (workspaceId: string, month: string, documentSha256: string): string =>
  `/transparency/${encodeURIComponent(workspaceId)}/attestations/${month}/${documentSha256}/proof`;

export function publicAttestationSummary(attestation: StatementAttestation, hasProof: boolean): PublicAttestationSummary {
  return {
    attestor: attestation.attestor,
    attestedOn: attestation.attestedOn,
    scope: attestation.scope,
    scopeMissing: ATTESTATION_SCOPES.filter((s) => !attestation.scope.includes(s)),
    documentSha256: attestation.documentSha256,
    statementDigest: attestation.statementDigest,
    proof: hasProof
      ? { status: 'anchored', url: attestationProofPath(attestation.workspaceId, attestation.month, attestation.documentSha256) }
      : { status: 'awaiting-anchor' },
  };
}
