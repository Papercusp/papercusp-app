/**
 * Optional Sigstore provenance for a listing's pinned content
 * (cupboard-release-pipeline-content-trust-2026-09-16 P-010, SPEC-P-010 /
 * SPEC-P-010b, AUTO-BAR R-6; D-055/D-056).
 *
 * A third-party repo may call the reusable workflow
 * `Papercusp/cupboard-actions/.github/workflows/verify.yml`, which attests the
 * canonical digest of its `<ref>/` tree. When the Worker pins a listing it asks
 * GitHub for attestations whose subject is that digest, and — itself, against the
 * Sigstore trusted root, never trusting GitHub's say-so — verifies one. A pass
 * stores `verified_by = 'attestation'` (a browse badge); EVERYTHING else stores
 * `'worker'`. The badge is never a substitute for the Worker's own pin and
 * content scan: it is computed only from the bytes the Worker already pinned, and
 * every failure mode — no attestation, GitHub unreachable, a stale trusted root,
 * a verifier bug — degrades to `'worker'` without blocking the publish (R-6).
 *
 * Fail-closed on trust, fail-open on availability: a bundle that does not verify,
 * names another workflow, another digest, another commit or another repository
 * never earns the badge; but no outage here can refuse a listing.
 */

import nodeCrypto from 'node:crypto';
import { bundleFromJSON } from '@sigstore/bundle';
import { TrustedRoot } from '@sigstore/protobuf-specs';
import { Verifier, toSignedEntity, toTrustMaterial } from '@sigstore/verify';
import trustedRootJson from './attestation-trusted-root.json';

/** The ONLY workflow whose attestations earn the badge. Any ref of it. */
export const CUPBOARD_WORKFLOW_IDENTITY_PREFIX =
  'https://github.com/Papercusp/cupboard-actions/.github/workflows/verify.yml@';
/** The OIDC issuer a GitHub Actions run is signed under. */
export const GITHUB_ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';
/** The in-toto predicate the reusable workflow emits for a tree digest. */
export const TREE_DIGEST_PREDICATE_TYPE =
  'https://github.com/Papercusp/cupboard-actions/predicates/tree-digest/v1';

const IN_TOTO_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
const IN_TOTO_PAYLOAD_TYPE = 'application/vnd.in-toto+json';
/** Fulcio certificate extension OIDs (https://github.com/sigstore/fulcio/blob/main/docs/oid-info.md). */
const OID_ISSUER_V2 = '1.3.6.1.4.1.57264.1.8';
const OID_BUILD_SIGNER_URI = '1.3.6.1.4.1.57264.1.9';
const OID_SOURCE_REPOSITORY_URI = '1.3.6.1.4.1.57264.1.12';
const OID_SOURCE_REPOSITORY_DIGEST = '1.3.6.1.4.1.57264.1.13';
const OID_SOURCE_REPOSITORY_VISIBILITY = '1.3.6.1.4.1.57264.1.22';

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
/** A publisher can have many attestations for one digest; verify a bounded few. */
const MAX_ATTESTATIONS = 5;
const FETCH_TIMEOUT_MS = 5000;

export type VerifiedBy = 'worker' | 'attestation';

export type AttestationPolicyReason =
  | 'workflow_identity'
  | 'issuer'
  | 'subject_digest'
  | 'predicate_type'
  | 'commit'
  | 'source_repository'
  | 'visibility'
  | 'statement';

export type AttestationVerdict =
  | { ok: true; signerWorkflow: string; sourceRepositoryUri: string }
  | {
      ok: false;
      code:
        | 'invalid_input'
        | 'no_attestation'
        | 'github_unreachable'
        | 'bad_response'
        | 'bundle_invalid'
        | 'verification_failed'
        | 'policy_mismatch';
      reason?: AttestationPolicyReason;
    };

export interface VerifyAttestationInput {
  /** `owner/name` of the listing's repository. */
  repo: string;
  /** Hex sha256 canonical tree digest the Worker pinned (`pinned_tree_digest`). */
  treeDigest: string;
  /** The commit the Worker pinned. */
  commitSha: string;
  /** Optional bearer: raises GitHub's rate limit; never required. */
  token?: string;
  fetchImpl?: typeof fetch;
  /** Injectable Sigstore trusted root (tests); defaults to the checked-in one. */
  trustedRoot?: unknown;
}

// ---------------------------------------------------------------------------
// workerd node:crypto shim
// ---------------------------------------------------------------------------

type VerifyFn = (algorithm: unknown, data: unknown, key: unknown, signature: unknown, callback?: unknown) => unknown;
const SHIM_MARK = Symbol.for('papercusp.cupboard.workerdCryptoVerifyShim');

/**
 * workerd's `node:crypto.verify(null|undefined, data, ecKey, sig)` THROWS
 * `Failed to initialize verification context`, while `verify('sha256', …)` works.
 * `@sigstore/core` calls it with an undefined algorithm for ECDSA keys and swallows
 * the throw into `false`, so unshimmed in-Worker verification fails with "inclusion
 * promise could not be verified" while plain Node passes — and a Node-only test
 * cannot see the divergence (measured in local workerd, 2026-10-01).
 *
 * The shim ONLY rewrites a missing algorithm on an EC key to `sha256`. That can
 * turn a throw into a real ECDSA-SHA256 check; it cannot turn a bad signature
 * into a good one, so it cannot widen what verifies. A key that is not P-256
 * simply fails the check (fail closed). Idempotent across module re-evaluation.
 */
export function installWorkerdCryptoShim(): void {
  const target = nodeCrypto as unknown as { verify: VerifyFn & { [SHIM_MARK]?: true } };
  if (typeof target.verify !== 'function' || target.verify[SHIM_MARK]) return;
  const original = target.verify;
  const shim = function (this: unknown, algorithm: unknown, data: unknown, key: unknown, signature: unknown, callback?: unknown) {
    const isEcKey = (key as { asymmetricKeyType?: string } | null | undefined)?.asymmetricKeyType === 'ec';
    const effective = algorithm == null && isEcKey ? 'sha256' : algorithm;
    return original.call(this, effective, data, key, signature, callback);
  } as VerifyFn & { [SHIM_MARK]?: true };
  shim[SHIM_MARK] = true;
  try {
    target.verify = shim;
  } catch {
    // A non-writable export: leave verification unshimmed. It then fails closed
    // (no badge) rather than throwing into the publish path.
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Decode a DER UTF8String extension value (Fulcio v2 extensions). */
function derUtf8(value: Uint8Array): string | null {
  if (value.length < 2 || value[0] !== 0x0c) return null;
  let length = value[1] ?? 0;
  let offset = 2;
  if (length & 0x80) {
    const bytes = length & 0x7f;
    if (bytes < 1 || bytes > 2 || value.length < 2 + bytes) return null;
    length = 0;
    for (let i = 0; i < bytes; i += 1) length = (length << 8) | (value[2 + i] ?? 0);
    offset = 2 + bytes;
  }
  if (offset + length !== value.length) return null;
  return new TextDecoder().decode(value.subarray(offset, offset + length));
}

export interface CertLike {
  extension(oid: string): { value: Uint8Array } | undefined;
}

function certExtension(cert: CertLike, oid: string): string | null {
  const ext = cert.extension(oid);
  return ext ? derUtf8(ext.value) : null;
}

let defaultTrustMaterial: ReturnType<typeof toTrustMaterial> | null = null;
function trustMaterialFor(root: unknown | undefined): ReturnType<typeof toTrustMaterial> {
  if (root !== undefined) return toTrustMaterial(TrustedRoot.fromJSON(root));
  defaultTrustMaterial ??= toTrustMaterial(TrustedRoot.fromJSON(trustedRootJson));
  return defaultTrustMaterial;
}

interface InTotoStatement {
  _type?: unknown;
  predicateType?: unknown;
  subject?: Array<{ digest?: { sha256?: unknown } }>;
  predicate?: { commitSha?: unknown } | null;
}

function parseStatement(payload: Uint8Array): InTotoStatement | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payload)) as unknown;
    return parsed !== null && typeof parsed === 'object' ? (parsed as InTotoStatement) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

/**
 * Verify ONE bundle (already shaped as Sigstore bundle JSON) against the policy
 * for `input`. Pure over its inputs apart from the shim install; never throws.
 */
export function verifyAttestationBundle(bundleJson: unknown, input: VerifyAttestationInput): AttestationVerdict {
  installWorkerdCryptoShim();
  let bundle: ReturnType<typeof bundleFromJSON>;
  try {
    bundle = bundleFromJSON(bundleJson);
  } catch {
    return { ok: false, code: 'bundle_invalid' };
  }
  if (bundle.content.$case !== 'dsseEnvelope' || bundle.content.dsseEnvelope.payloadType !== IN_TOTO_PAYLOAD_TYPE) {
    return { ok: false, code: 'bundle_invalid' };
  }
  const payload = bundle.content.dsseEnvelope.payload;

  let signerWorkflow: string;
  let cert: CertLike;
  try {
    const entity = toSignedEntity(bundle);
    if (entity.key.$case !== 'certificate') return { ok: false, code: 'bundle_invalid' };
    const signer = new Verifier(trustMaterialFor(input.trustedRoot)).verify(entity, {});
    signerWorkflow = signer.identity?.subjectAlternativeName ?? '';
    cert = entity.key.certificate as unknown as CertLike;
  } catch {
    // Signature, certificate chain, transparency-log inclusion or a stale trusted
    // root: none of it is the badge's to forgive.
    return { ok: false, code: 'verification_failed' };
  }

  return checkAttestationPolicy({ signerWorkflow, cert, payload }, input);
}

/**
 * Policy half of the verification: runs ONLY on a signature the Worker itself
 * verified, so the statement bytes are authentic; policy decides whether they are
 * about THIS listing. Split out and exported so the certificate-extension checks
 * (a genuine bundle cannot be forged into a non-public source repository) are
 * testable against an edited certificate view without touching the signature leg.
 */
export function checkAttestationPolicy(
  { signerWorkflow, cert, payload }: { signerWorkflow: string; cert: CertLike; payload: Uint8Array },
  input: VerifyAttestationInput,
): AttestationVerdict {
  const mismatch = (reason: AttestationPolicyReason): AttestationVerdict => ({ ok: false, code: 'policy_mismatch', reason });

  if (!signerWorkflow.startsWith(CUPBOARD_WORKFLOW_IDENTITY_PREFIX)) return mismatch('workflow_identity');
  const buildSigner = certExtension(cert, OID_BUILD_SIGNER_URI);
  if (buildSigner === null || !buildSigner.startsWith(CUPBOARD_WORKFLOW_IDENTITY_PREFIX)) return mismatch('workflow_identity');
  if (certExtension(cert, OID_ISSUER_V2) !== GITHUB_ACTIONS_ISSUER) return mismatch('issuer');

  const statement = parseStatement(payload);
  if (statement === null || statement._type !== IN_TOTO_STATEMENT_TYPE) return mismatch('statement');
  if (statement.predicateType !== TREE_DIGEST_PREDICATE_TYPE) return mismatch('predicate_type');
  const subjects = Array.isArray(statement.subject) ? statement.subject : [];
  if (!subjects.some((subject) => subject?.digest?.sha256 === input.treeDigest)) return mismatch('subject_digest');

  const attestedCommit = statement.predicate?.commitSha;
  if (attestedCommit !== input.commitSha || certExtension(cert, OID_SOURCE_REPOSITORY_DIGEST) !== input.commitSha) {
    return mismatch('commit');
  }
  const sourceRepositoryUri = certExtension(cert, OID_SOURCE_REPOSITORY_URI);
  if (sourceRepositoryUri !== `https://github.com/${input.repo}`) return mismatch('source_repository');
  if (certExtension(cert, OID_SOURCE_REPOSITORY_VISIBILITY) !== 'public') return mismatch('visibility');

  return { ok: true, signerWorkflow, sourceRepositoryUri };
}

/**
 * Ask GitHub for attestations over `treeDigest` in `repo` and verify them
 * ourselves. Resolves to a verdict; never throws, never blocks beyond a bounded
 * timeout.
 */
export async function verifyCupboardAttestation(input: VerifyAttestationInput): Promise<AttestationVerdict> {
  if (!REPO_RE.test(input.repo) || !DIGEST_RE.test(input.treeDigest) || !COMMIT_RE.test(input.commitSha)) {
    return { ok: false, code: 'invalid_input' };
  }
  try {
    const fetchImpl = input.fetchImpl ?? fetch;
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': 'papercusp-cupboard-worker',
      'x-github-api-version': '2022-11-28',
    };
    if (input.token) headers.authorization = `Bearer ${input.token}`;
    const response = await fetchImpl(`https://api.github.com/repos/${input.repo}/attestations/sha256:${input.treeDigest}`, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status === 404) return { ok: false, code: 'no_attestation' };
    if (!response.ok) return { ok: false, code: 'github_unreachable' };
    const body = (await response.json()) as { attestations?: Array<{ bundle?: unknown }> } | null;
    const attestations = Array.isArray(body?.attestations) ? body.attestations.slice(0, MAX_ATTESTATIONS) : [];
    if (attestations.length === 0) return { ok: false, code: 'no_attestation' };

    let firstFailure: AttestationVerdict = { ok: false, code: 'no_attestation' };
    for (const attestation of attestations) {
      const verdict = verifyAttestationBundle(attestation?.bundle, input);
      if (verdict.ok) return verdict;
      if (firstFailure.ok === false && firstFailure.code === 'no_attestation') firstFailure = verdict;
    }
    return firstFailure;
  } catch {
    return { ok: false, code: 'github_unreachable' };
  }
}

/**
 * What the publish path stores in `verified_by`: `'attestation'` only when a
 * Sigstore attestation verifies for the PINNED bytes, `'worker'` for everything
 * else — including every error. The caller has already pinned and scanned.
 */
export async function resolveVerifiedBy(input: VerifyAttestationInput): Promise<VerifiedBy> {
  const verdict = await verifyCupboardAttestation(input);
  return verdict.ok ? 'attestation' : 'worker';
}
