/**
 * Outside-accountant attestations of a closed monthly statement
 * (agent-economy-flywheel-2026-08-30 P-047, D-031).
 *
 * Each month a statement is signed and published (P-044, D-028). An outside
 * accountant then checks it against Stripe's balance transactions and payouts
 * and the bank feed, and signs an attestation document. We never store that
 * document, only its SHA-256, inside a public ATTESTATION RECORD:
 *
 *   { month, statementDigest, monthRoot, documentSha256, attestor, attestedOn, scope }
 *
 * The record is the chain entry on stream `transparency.statement-attestations`,
 * so the hourly anchor run (D-024) puts it on chain in a later root of the same
 * log. `statementDigest` covers the statement's `report.latestAnchor`, which is
 * the root covering month end, so the attestation is bound to that month's root
 * through the statement itself; `monthRoot` repeats it for the reader.
 *
 * A PROOF is { attestation, bundle } with `bundle.entry` = the record. Anyone
 * holding the document can hash it and verify the proof against public chain
 * data with `verifyStatementAttestation`. This module imports no Postgres code.
 */
import { createHash } from 'node:crypto';
import { canonicalJson, sha256Hex } from '@papercusp/hash-chain';
import { verifyInclusionBundle, type AnchorInclusionBundle, type AnchorReader, type BundleVerdict } from './ledger-anchor';
import type { MonthlyStatement } from './transparency-report';

export const STATEMENT_ATTESTATION_STREAM_ID = 'transparency.statement-attestations';
export const STATEMENT_ATTESTATION_FORMAT = 'papercusp.statement-attestation' as const;
export const STATEMENT_ATTESTATION_PROOF_FORMAT = 'papercusp.statement-attestation-proof' as const;

/** What the accountant checked the statement against. P-047 asks for all three. */
export const ATTESTATION_SCOPES = ['stripe-balance-transactions', 'stripe-payouts', 'bank-feed'] as const;
export type AttestationScope = (typeof ATTESTATION_SCOPES)[number];

const HEX64 = /^[0-9a-f]{64}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** The root covering month end, as the statement's report names it (D-028). */
export interface AttestedMonthRoot {
  readonly logId: string;
  readonly treeSize: number;
  readonly logRoot: string;
  /** The anchor backend's reference (e.g. the EAS attestation uid). */
  readonly ref: string;
}

export interface StatementAttestation {
  readonly format: typeof STATEMENT_ATTESTATION_FORMAT;
  readonly version: 1;
  readonly workspaceId: string;
  /** The attested month, YYYY-MM. */
  readonly month: string;
  /** sha256(canonicalJson(statement)) of the published signed statement. */
  readonly statementDigest: string;
  readonly monthRoot: AttestedMonthRoot;
  /** SHA-256 of the signed attestation document (lowercase hex). */
  readonly documentSha256: string;
  readonly attestor: { readonly name: string; readonly firm: string | null };
  /** The date on the attestation document, YYYY-MM-DD. */
  readonly attestedOn: string;
  /** Sorted, deduplicated subset of ATTESTATION_SCOPES. */
  readonly scope: readonly AttestationScope[];
}

/** What a caller supplies to record an attestation; the rest comes from the published statement. */
export interface StatementAttestationInput {
  readonly month: string;
  readonly documentSha256: string;
  readonly attestorName: string;
  readonly attestorFirm?: string | null;
  readonly attestedOn: string;
  readonly scope: readonly string[];
}

/** Why an input cannot be recorded, or null when it can. */
export function attestationInputProblem(input: StatementAttestationInput): string | null {
  if (typeof input?.month !== 'string' || !MONTH.test(input.month)) return 'month must be YYYY-MM';
  if (typeof input.documentSha256 !== 'string' || !HEX64.test(input.documentSha256)) {
    return 'documentSha256 must be 64 lowercase hex characters (the SHA-256 of the signed document)';
  }
  const name = typeof input.attestorName === 'string' ? input.attestorName.trim() : '';
  if (name.length === 0 || name.length > 200) return 'attestorName must be 1-200 characters';
  if (input.attestorFirm != null && (typeof input.attestorFirm !== 'string' || input.attestorFirm.trim().length > 200)) {
    return 'attestorFirm must be a string of at most 200 characters';
  }
  if (typeof input.attestedOn !== 'string' || !DAY.test(input.attestedOn)) return 'attestedOn must be YYYY-MM-DD';
  if (input.attestedOn.slice(0, 7) < input.month) return 'attestedOn must not be before the attested month';
  if (!Array.isArray(input.scope) || input.scope.length === 0) return `scope must list at least one of ${ATTESTATION_SCOPES.join(', ')}`;
  const unknown = input.scope.filter((s) => !(ATTESTATION_SCOPES as readonly string[]).includes(s));
  if (unknown.length > 0) return `unknown scope ${unknown.join(', ')}; allowed: ${ATTESTATION_SCOPES.join(', ')}`;
  return null;
}

function normalizedScope(scope: readonly string[]): AttestationScope[] {
  return ATTESTATION_SCOPES.filter((s) => scope.includes(s));
}

/** The record for a validated input and the statement it attests. Throws on a bad input or a statement with no month root. */
export function buildStatementAttestation(input: {
  readonly workspaceId: string;
  readonly attestation: StatementAttestationInput;
  readonly statement: MonthlyStatement;
  readonly statementDigest: string;
}): StatementAttestation {
  const problem = attestationInputProblem(input.attestation);
  if (problem) throw new Error(`buildStatementAttestation: ${problem}`);
  const root = input.statement.report.latestAnchor;
  if (!root) throw new Error('buildStatementAttestation: the statement names no anchored month root');
  const a = input.attestation;
  return {
    format: STATEMENT_ATTESTATION_FORMAT,
    version: 1,
    workspaceId: input.workspaceId,
    month: a.month,
    statementDigest: input.statementDigest,
    monthRoot: { logId: root.logId, treeSize: root.treeSize, logRoot: root.logRoot, ref: root.ref },
    documentSha256: a.documentSha256,
    attestor: { name: a.attestorName.trim(), firm: a.attestorFirm?.trim() || null },
    attestedOn: a.attestedOn,
    scope: normalizedScope(a.scope),
  };
}

/** Shape check for a record read back from storage or a proof. */
export function parseStatementAttestation(raw: unknown): StatementAttestation | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const root = r.monthRoot as Record<string, unknown> | undefined;
  const attestor = r.attestor as Record<string, unknown> | undefined;
  const ok =
    r.format === STATEMENT_ATTESTATION_FORMAT &&
    r.version === 1 &&
    typeof r.workspaceId === 'string' &&
    r.workspaceId.length > 0 &&
    typeof r.statementDigest === 'string' &&
    HEX64.test(r.statementDigest) &&
    !!root &&
    typeof root.logId === 'string' &&
    Number.isSafeInteger(root.treeSize) &&
    (root.treeSize as number) > 0 &&
    typeof root.logRoot === 'string' &&
    typeof root.ref === 'string' &&
    !!attestor &&
    typeof attestor.name === 'string' &&
    (attestor.firm === null || typeof attestor.firm === 'string') &&
    Array.isArray(r.scope) &&
    attestationInputProblem({
      month: r.month as string,
      documentSha256: r.documentSha256 as string,
      attestorName: attestor.name,
      attestorFirm: attestor.firm as string | null,
      attestedOn: r.attestedOn as string,
      scope: r.scope as string[],
    }) === null &&
    canonicalJson(normalizedScope(r.scope as string[])) === canonicalJson(r.scope);
  return ok ? (raw as StatementAttestation) : null;
}

/** A stable identifier for a record: sha256 of its canonical JSON. */
export function statementAttestationDigest(record: StatementAttestation): string {
  return sha256Hex(canonicalJson(record));
}

/** SHA-256 of the attestation document's bytes, as recorded in `documentSha256`. */
export function attestationDocumentSha256(document: Uint8Array): string {
  return createHash('sha256').update(document).digest('hex');
}

export interface StatementAttestationProof {
  readonly format: typeof STATEMENT_ATTESTATION_PROOF_FORMAT;
  readonly version: 1;
  readonly attestation: StatementAttestation;
  /** The D-024 proof for the attestation's chain link, with `entry` = the record. */
  readonly bundle: AnchorInclusionBundle;
}

/** Assemble a proof; throws if the bundle does not prove this record (an issuer bug). */
export function assembleStatementAttestationProof(input: {
  readonly attestation: StatementAttestation;
  readonly bundle: AnchorInclusionBundle;
}): StatementAttestationProof {
  if (input.bundle.link.streamId !== STATEMENT_ATTESTATION_STREAM_ID) {
    throw new Error(`assembleStatementAttestationProof: bundle proves stream '${input.bundle.link.streamId}', not ${STATEMENT_ATTESTATION_STREAM_ID}`);
  }
  if (canonicalJson(input.bundle.entry ?? null) !== canonicalJson(input.attestation)) {
    throw new Error('assembleStatementAttestationProof: bundle entry is not this attestation record');
  }
  return { format: STATEMENT_ATTESTATION_PROOF_FORMAT, version: 1, attestation: input.attestation, bundle: input.bundle };
}

export type StatementAttestationVerdict =
  | {
      readonly ok: true;
      readonly attestation: StatementAttestation;
      /** End of the hour whose anchor covers the attestation: it existed by then. */
      readonly anchoredWindowEnd: number;
      readonly attester: string | null;
      /** True when the caller supplied the document and its hash matched; null when no document was supplied. */
      readonly documentMatches: true | null;
      /** Scopes the accountant did NOT attest (empty when all three were). */
      readonly scopeMissing: readonly AttestationScope[];
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'malformed'
        | 'entry-mismatch'
        | 'wrong-stream'
        | 'not-the-month-log'
        | 'anchored-before-month-root'
        | 'document-mismatch'
        | Exclude<BundleVerdict, { ok: true }>['reason'];
    };

/**
 * Verify a proof with only public chain data. Pass `documentSha256` (or hash
 * the document with `attestationDocumentSha256`) to tie the proof to the
 * document in hand; pin `expectedAttester` to the published anchor address.
 */
export async function verifyStatementAttestation(
  proof: StatementAttestationProof,
  reader: AnchorReader,
  opts: { readonly documentSha256?: string; readonly expectedAttester?: string; readonly expectedLogId?: string } = {},
): Promise<StatementAttestationVerdict> {
  if (proof?.format !== STATEMENT_ATTESTATION_PROOF_FORMAT || proof.version !== 1 || !proof.bundle?.link) {
    return { ok: false, reason: 'malformed' };
  }
  const attestation = parseStatementAttestation(proof.attestation);
  if (!attestation) return { ok: false, reason: 'malformed' };
  // The bundle must carry the record itself, or the link could belong to some other entry.
  if (canonicalJson(proof.bundle.entry ?? null) !== canonicalJson(attestation)) return { ok: false, reason: 'entry-mismatch' };
  if (proof.bundle.link.streamId !== STATEMENT_ATTESTATION_STREAM_ID) return { ok: false, reason: 'wrong-stream' };
  // "Alongside that month's root": same log, at or after the month root.
  if (proof.bundle.logId !== attestation.monthRoot.logId) return { ok: false, reason: 'not-the-month-log' };
  if (proof.bundle.treeSize < attestation.monthRoot.treeSize) return { ok: false, reason: 'anchored-before-month-root' };
  let documentMatches: true | null = null;
  if (opts.documentSha256 !== undefined) {
    if (opts.documentSha256.toLowerCase() !== attestation.documentSha256) return { ok: false, reason: 'document-mismatch' };
    documentMatches = true;
  }
  const verdict = await verifyInclusionBundle(proof.bundle, reader, {
    expectedAttester: opts.expectedAttester,
    expectedLogId: opts.expectedLogId,
  });
  if (!verdict.ok) return verdict;
  return {
    ok: true,
    attestation,
    anchoredWindowEnd: verdict.anchoredWindowEnd,
    attester: verdict.attester,
    documentMatches,
    scopeMissing: ATTESTATION_SCOPES.filter((s) => !attestation.scope.includes(s)),
  };
}
