import {
  assertWorkspaceHostSecretIsolation,
  deriveWorkspaceHostCanonicalArtifactUrls,
  validateWorkspaceHostImageArtifact,
  type WorkspaceHostImageArtifact,
} from '@papercusp/deployment-driver';

import {
  ARTIFACT_TRUST_EVIDENCE_ORDER,
  ARTIFACT_TRUST_PIPELINE_VERSION,
  type ArtifactTrustEvidence,
  type ArtifactTrustEvidenceKind,
  type ArtifactTrustReport,
} from './artifact-trust';

/**
 * The closed publication envelope shared by the bundle producer (this module) and the Cupboard
 * Worker that serves it (D-107). This module owns CONSTRUCTION only: assembling and serializing
 * `manifest.json`. Upload, the finalization marker, the R2 adapter and every
 * `/admin/artifacts/workspace-host` or public `/artifacts/workspace-host` route belong to
 * WI-41736/operator-public (D-108), which re-validates at its own network boundary.
 *
 * The wire names below are NOT this module's to choose. `manifest.json` is served from the public
 * `/artifacts/workspace-host/...` routes, whose validator applies a CLOSED top-level allowlist, and
 * `schemaVersion` is shared with the finalization marker — both owned exclusively by
 * WI-41736/operator-public (D-108). The producer therefore adopts the published contract verbatim;
 * `publication-manifest.contract.test.ts` pins these names against that route so the two halves
 * cannot drift apart again silently.
 */
export const WORKSPACE_HOST_PUBLICATION_SCHEMA_VERSION = 1;
export const WORKSPACE_HOST_PUBLICATION_KIND = 'papercusp-workspace-host-release';

/** The three objects published together under one content address (D-105). */
export const WORKSPACE_HOST_PUBLISHED_BUNDLE_NAME = 'server.tgz';
export const WORKSPACE_HOST_PUBLISHED_SIGNATURE_NAME = 'server.tgz.minisig';
export const WORKSPACE_HOST_PUBLISHED_MANIFEST_NAME = 'manifest.json';

const SHA256 = /^[a-f0-9]{64}$/;

/** Exact SHA-256/size descriptor for one stored object, as the publisher must find it in R2. */
export interface WorkspaceHostPublishedObject {
  readonly name: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

/**
 * The `manifest.json` document.
 *
 * Deliberately carries NO separate `bundleSha256` field. The content address is
 * `objects.bundle.sha256`, and the producer proves it equals
 * `artifact.release.bundleSha256`; a third copy of the same digest is a value that can only
 * drift, never disagree usefully.
 */
export interface WorkspaceHostPublicationManifest {
  readonly schemaVersion: typeof WORKSPACE_HOST_PUBLICATION_SCHEMA_VERSION;
  readonly kind: typeof WORKSPACE_HOST_PUBLICATION_KIND;
  readonly artifact: WorkspaceHostImageArtifact;
  readonly files: {
    readonly bundle: WorkspaceHostPublishedObject;
    readonly signature: WorkspaceHostPublishedObject;
  };
  readonly trustReport: ArtifactTrustReport;
}

/**
 * The closed key set. `_exhaustive` below fails to compile if the envelope gains a member that
 * is not listed here, so "closed" is enforced by the compiler rather than by memory: widening
 * the published contract has to be a deliberate edit that also bumps the version.
 */
export const WORKSPACE_HOST_PUBLICATION_MANIFEST_KEYS = [
  'schemaVersion',
  'kind',
  'artifact',
  'files',
  'trustReport',
] as const satisfies readonly (keyof WorkspaceHostPublicationManifest)[];

type EnvelopeIsClosed =
  Exclude<
    keyof WorkspaceHostPublicationManifest,
    (typeof WORKSPACE_HOST_PUBLICATION_MANIFEST_KEYS)[number]
  > extends never
    ? true
    : never;
const _exhaustive: EnvelopeIsClosed = true;
void _exhaustive;

export type WorkspaceHostPublicationFailureCode =
  | 'build-artifact-mismatch'
  | 'duplicate-trust-evidence'
  | 'evidence-subject-mismatch'
  | 'inactive-lifecycle'
  | 'invalid-image-artifact'
  | 'invalid-trust-policy'
  | 'sbom-binding-mismatch'
  | 'invalid-object-descriptor'
  | 'missing-trust-evidence'
  | 'non-canonical-artifact-url'
  | 'object-digest-mismatch'
  | 'provenance-invalid'
  | 'secret-material'
  | 'secret-scan-policy'
  | 'signature-binding-mismatch'
  | 'trust-subject-mismatch'
  | 'unsupported-trust-version'
  | 'untrusted-release';

export interface WorkspaceHostPublicationFailure {
  code: WorkspaceHostPublicationFailureCode;
  message: string;
}

export interface WorkspaceHostPublicationManifestInput {
  artifact: WorkspaceHostImageArtifact;
  trustReport: ArtifactTrustReport;
  /** Exact stored bytes of `server.tgz`. */
  bundle: { sha256: string; bytes: number };
  /** Exact stored bytes of the detached `server.tgz.minisig`. */
  signature: { sha256: string; bytes: number };
  /** Publication origin; defaults to the canonical D-105 Cupboard origin. */
  origin?: string;
}

export class WorkspaceHostPublicationManifestError extends Error {
  readonly failures: readonly WorkspaceHostPublicationFailure[];

  constructor(failures: readonly WorkspaceHostPublicationFailure[]) {
    super(`workspace-host publication manifest rejected: ${failures.map((f) => `${f.code}: ${f.message}`).join('; ')}`);
    this.name = 'WorkspaceHostPublicationManifestError';
    this.failures = failures;
  }
}

function evidenceOf<K extends ArtifactTrustEvidenceKind>(
  report: ArtifactTrustReport,
  kind: K,
): Extract<ArtifactTrustEvidence, { kind: K }> | undefined {
  return report.evidence.find((entry) => entry.kind === kind) as
    | Extract<ArtifactTrustEvidence, { kind: K }>
    | undefined;
}

function descriptorErrors(object: { sha256: string; bytes: number }, label: string): string[] {
  const errors: string[] = [];
  if (!SHA256.test(object.sha256)) {
    errors.push(`${label}.sha256 must be a lowercase SHA-256 digest`);
  }
  if (!Number.isSafeInteger(object.bytes) || object.bytes <= 0) {
    errors.push(`${label}.bytes must be a positive integer byte count`);
  }
  return errors;
}

/**
 * Every reason this input may not be published, as data.
 *
 * The canonical build, image and release-provenance validators are DELEGATED to
 * `validateWorkspaceHostImageArtifact` (which itself runs the build-manifest and
 * release-provenance checks) rather than restated here, so the publication surface cannot drift
 * away from the surface that admits a release. What this function adds is everything D-107
 * requires that no existing validator covers: the stored-object descriptors, trust-evidence
 * completeness, the signature binding, and the zero-finding secret policy.
 */
export function workspaceHostPublicationManifestFailures(
  input: WorkspaceHostPublicationManifestInput,
): readonly WorkspaceHostPublicationFailure[] {
  const failures: WorkspaceHostPublicationFailure[] = [];
  const push = (code: WorkspaceHostPublicationFailureCode, message: string): void => {
    failures.push({ code, message });
  };

  const artifactErrors = validateWorkspaceHostImageArtifact(input.artifact);
  if (artifactErrors.length > 0) {
    push('invalid-image-artifact', artifactErrors.join('; '));
  }

  const descriptorIssues = [
    ...descriptorErrors(input.bundle, 'bundle'),
    ...descriptorErrors(input.signature, 'signature'),
  ];
  if (descriptorIssues.length > 0) {
    push('invalid-object-descriptor', descriptorIssues.join('; '));
  }

  const bundleDigest = input.bundle.sha256;
  const releaseDigest = input.artifact.release.bundleSha256;

  // The content address IS the bundle digest. A manifest published under /sha256/<digest>/ whose
  // stored bundle is a different artifact is precisely the substitution the address exists to
  // prevent, so this never falls through to a version comparison.
  if (SHA256.test(bundleDigest) && bundleDigest !== releaseDigest) {
    push(
      'object-digest-mismatch',
      `stored bundle digest ${bundleDigest} must equal release.bundleSha256 ${releaseDigest}`,
    );
  }

  // The published URLs are derived from the verified digest (D-106), never hand-authored: the
  // address and the integrity check are then the same value, so a mutable or fixture host cannot
  // be introduced by editing a string.
  if (SHA256.test(releaseDigest)) {
    let canonical: ReturnType<typeof deriveWorkspaceHostCanonicalArtifactUrls> | undefined;
    try {
      canonical = deriveWorkspaceHostCanonicalArtifactUrls(releaseDigest, { origin: input.origin });
    } catch (error) {
      push('non-canonical-artifact-url', error instanceof Error ? error.message : String(error));
    }
    if (canonical) {
      if (input.artifact.release.bundleUrl !== canonical.bundleUrl) {
        push(
          'non-canonical-artifact-url',
          `release.bundleUrl must be the digest-derived ${canonical.bundleUrl}`,
        );
      }
      if (input.artifact.release.signatureUrl !== canonical.signatureUrl) {
        push(
          'non-canonical-artifact-url',
          `release.signatureUrl must be the digest-derived ${canonical.signatureUrl}`,
        );
      }
    }
  }

  const trust = input.trustReport;
  if (trust.version !== ARTIFACT_TRUST_PIPELINE_VERSION) {
    push(
      'unsupported-trust-version',
      `trust report version must be '${ARTIFACT_TRUST_PIPELINE_VERSION}'`,
    );
  }
  if (!trust.trusted || trust.failures.length > 0) {
    push(
      'untrusted-release',
      trust.failures.map((failure) => failure.message).join('; ') ||
        'artifact trust report is not trusted',
    );
  }

  // The report must describe THIS bundle, byte for byte — not merely a bundle with the same
  // digest recorded at a different size, and not an unsigned one.
  if (trust.subject.sha256 !== bundleDigest) {
    push(
      'trust-subject-mismatch',
      `trust subject ${trust.subject.sha256} must equal the stored bundle digest ${bundleDigest}`,
    );
  }
  if (trust.subject.bytes !== input.bundle.bytes) {
    push(
      'trust-subject-mismatch',
      `trust subject size ${trust.subject.bytes} must equal the stored bundle size ${input.bundle.bytes}`,
    );
  }
  if (!trust.subject.signed) {
    push('trust-subject-mismatch', 'trust subject must be signed to publish a detached signature');
  }

  // The build manifest records what was actually built. If it does not describe the bytes being
  // published, the envelope's provenance half and its content half are about different artifacts.
  const built = input.artifact.buildManifest?.releaseArtifact;
  if (built) {
    if (built.sha256 !== bundleDigest) {
      push(
        'build-artifact-mismatch',
        `buildManifest.releaseArtifact.sha256 ${built.sha256} must equal the published bundle digest ${bundleDigest}`,
      );
    }
    if (built.sizeBytes !== input.bundle.bytes) {
      push(
        'build-artifact-mismatch',
        `buildManifest.releaseArtifact.sizeBytes ${built.sizeBytes} must equal the published bundle size ${input.bundle.bytes}`,
      );
    }
  }

  // Publishing a withdrawn or superseded release under a permanent, immutable content address is
  // not recoverable by editing the release afterwards.
  if (input.artifact.lifecycle?.state !== 'active') {
    push(
      'inactive-lifecycle',
      `artifact lifecycle must be 'active' at publication, not '${input.artifact.lifecycle?.state}'`,
    );
  }

  if (
    !Number.isSafeInteger(trust.policy.maxAttestationAgeMs) ||
    trust.policy.maxAttestationAgeMs <= 0
  ) {
    push(
      'invalid-trust-policy',
      'policy.maxAttestationAgeMs must be a positive integer for the attestation freshness bound to mean anything',
    );
  }

  const missing = ARTIFACT_TRUST_EVIDENCE_ORDER.filter((kind) => !evidenceOf(trust, kind));
  if (missing.length > 0) {
    push('missing-trust-evidence', `missing evidence: ${missing.join(', ')}`);
  }

  // `evidenceOf` returns the FIRST match, so a duplicate class is invisible to every check above:
  // a second, weaker `signature` entry would ride along unexamined. The publisher rejects both
  // duplicates and any extra class, so refuse them here rather than build a manifest that cannot
  // be published.
  const duplicated = ARTIFACT_TRUST_EVIDENCE_ORDER.filter(
    (kind) => trust.evidence.filter((entry) => entry.kind === kind).length > 1,
  );
  if (duplicated.length > 0) {
    push('duplicate-trust-evidence', `duplicate evidence: ${duplicated.join(', ')}`);
  }
  if (trust.evidence.length !== ARTIFACT_TRUST_EVIDENCE_ORDER.length) {
    push(
      'duplicate-trust-evidence',
      `evidence must contain exactly the ${ARTIFACT_TRUST_EVIDENCE_ORDER.length} required classes, found ${trust.evidence.length}`,
    );
  }

  for (const entry of trust.evidence) {
    if (
      typeof entry.tool?.name !== 'string' ||
      entry.tool.name.trim().length === 0 ||
      typeof entry.tool?.version !== 'string' ||
      entry.tool.version.trim().length === 0
    ) {
      push('missing-trust-evidence', `${entry.kind} evidence must record exact tool name and version`);
    }
  }

  // A scan of a DIFFERENT SBOM says nothing about this bundle's components, even though both
  // entries are individually well-formed and bound to the right subject digest.
  const sbom = evidenceOf(trust, 'sbom');
  const vulnerability = evidenceOf(trust, 'vulnerability-scan');
  if (sbom && vulnerability && sbom.documentSha256 !== vulnerability.sbomSha256) {
    push(
      'sbom-binding-mismatch',
      `vulnerability scan consumed SBOM ${vulnerability.sbomSha256}, but the published SBOM evidence is ${sbom.documentSha256}`,
    );
  }

  // Evidence gathered over a different artifact cannot vouch for this one; without this, five
  // green evidence classes from an unrelated build would satisfy the envelope.
  const strayEvidence = trust.evidence.filter((entry) => entry.subjectSha256 !== bundleDigest);
  if (strayEvidence.length > 0) {
    push(
      'evidence-subject-mismatch',
      `evidence ${strayEvidence.map((entry) => entry.kind).join(', ')} must be bound to ${bundleDigest}`,
    );
  }

  const signature = evidenceOf(trust, 'signature');
  if (signature) {
    if (!signature.valid) {
      push('signature-binding-mismatch', 'signature evidence must report a valid signature');
    }
    // D-107 requires the signature evidence to bind BOTH the detached signature it verified and
    // the key it verified under. Without the key binding, evidence produced under a signing key
    // the release does not pin would satisfy publication.
    if (signature.signatureSha256 === undefined) {
      push(
        'signature-binding-mismatch',
        'signature evidence must record signatureSha256, the digest of the detached signature it verified',
      );
    } else if (signature.signatureSha256 !== input.signature.sha256) {
      push(
        'signature-binding-mismatch',
        `signature evidence verified signature ${signature.signatureSha256}, but the published signature is ${input.signature.sha256}`,
      );
    }
    if (signature.signingKeySha256 === undefined) {
      push(
        'signature-binding-mismatch',
        'signature evidence must record signingKeySha256, the digest of the verifying key',
      );
    } else if (signature.signingKeySha256 !== input.artifact.release.signingKeySha256) {
      push(
        'signature-binding-mismatch',
        `signature evidence used key ${signature.signingKeySha256}, but the release pins ${input.artifact.release.signingKeySha256}`,
      );
    }
  }

  // Zero findings under a policy that TOLERATES findings is not a zero-finding policy: the next
  // build could carry a secret and still pass. D-107 requires both halves.
  const secretScan = evidenceOf(trust, 'secret-scan');
  if (trust.policy.maxSecretFindings !== 0) {
    push(
      'secret-scan-policy',
      `publication requires a zero-finding secret policy; policy.maxSecretFindings is ${trust.policy.maxSecretFindings}`,
    );
  }
  if (secretScan && secretScan.findings.length > 0) {
    push(
      'secret-scan-policy',
      `secret scan reported ${secretScan.findings.length} finding(s); publication requires zero`,
    );
  }

  const provenance = evidenceOf(trust, 'provenance-attestation');
  if (provenance && !provenance.valid) {
    push('provenance-invalid', 'provenance attestation evidence must be valid');
  }

  return failures;
}

/**
 * Assemble the closed D-107 envelope, or throw with every reason it was rejected.
 *
 * Fail-closed by construction: the manifest object is only built after the input has passed, so
 * there is no partially-valid manifest for a caller to publish by ignoring a return value.
 */
export function buildWorkspaceHostPublicationManifest(
  input: WorkspaceHostPublicationManifestInput,
): WorkspaceHostPublicationManifest {
  const failures = workspaceHostPublicationManifestFailures(input);
  if (failures.length > 0) {
    throw new WorkspaceHostPublicationManifestError(failures);
  }

  const manifest: WorkspaceHostPublicationManifest = {
    schemaVersion: WORKSPACE_HOST_PUBLICATION_SCHEMA_VERSION,
    kind: WORKSPACE_HOST_PUBLICATION_KIND,
    artifact: input.artifact,
    files: {
      bundle: {
        name: WORKSPACE_HOST_PUBLISHED_BUNDLE_NAME,
        sha256: input.bundle.sha256,
        sizeBytes: input.bundle.bytes,
      },
      signature: {
        name: WORKSPACE_HOST_PUBLISHED_SIGNATURE_NAME,
        sha256: input.signature.sha256,
        sizeBytes: input.signature.bytes,
      },
    },
    trustReport: input.trustReport,
  };

  // The envelope is world-readable at a public URL. Private key material or a secret-shaped
  // field reaching it is unrecoverable once published, so this is asserted on the assembled
  // document rather than trusted from the inputs.
  //
  // `trust.policy` is scanned by VALUE rather than as a record, and only that record is treated
  // this way. Its key names include `maxSecretFindings` — the number of secrets the scanner may
  // tolerate, which is a threshold, not a secret — and the shared guard's key-name heuristic
  // cannot tell those apart. Passing the values as an array keeps the value-level check (PEM
  // material in a policy field is still rejected) while dropping only the key-name test that
  // produces the false positive.
  const { policy, ...trustWithoutPolicy } = manifest.trustReport;
  assertWorkspaceHostSecretIsolation(
    { ...manifest, trustReport: trustWithoutPolicy },
    'manifest',
  );
  assertWorkspaceHostSecretIsolation(Object.values(policy), 'manifest.trustReport.policy');

  return manifest;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return Object.fromEntries(entries.map(([key, entry]) => [key, canonicalize(entry)]));
}

/**
 * Serialize with recursively sorted keys so the same manifest always produces the same bytes.
 * Array order is preserved because it is meaningful (evidence order, build materials).
 */
export function serializeWorkspaceHostPublicationManifest(
  manifest: WorkspaceHostPublicationManifest,
): string {
  return `${JSON.stringify(canonicalize(manifest), null, 2)}\n`;
}
