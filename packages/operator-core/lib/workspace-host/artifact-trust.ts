import type { HandoffArtifact } from '../release-cut-launch';

export const ARTIFACT_TRUST_PIPELINE_VERSION = 'artifact-trust-v1';
export const ARTIFACT_TRUST_EVIDENCE_ORDER = [
  'signature',
  'sbom',
  'vulnerability-scan',
  'secret-scan',
  'provenance-attestation',
] as const;

export type ArtifactTrustEvidenceKind = (typeof ARTIFACT_TRUST_EVIDENCE_ORDER)[number];
export type VulnerabilitySeverity = 'unknown' | 'low' | 'medium' | 'high' | 'critical';

/** The release handoff is the canonical artifact descriptor; trust adds no provider identity. */
export type ArtifactTrustSubject = Pick<HandoffArtifact, 'path' | 'name' | 'bytes' | 'sha256' | 'signed'>;

export interface ArtifactTrustTool {
  name: string;
  version: string;
}

interface ArtifactTrustEvidenceBase {
  kind: ArtifactTrustEvidenceKind;
  /** Digest of the artifact the tool actually inspected. */
  subjectSha256: string;
  tool: ArtifactTrustTool;
}

export interface SignatureEvidence extends ArtifactTrustEvidenceBase {
  kind: 'signature';
  valid: boolean;
  signer?: string;
  /**
   * Digest of the exact detached signature file this evidence verified.
   *
   * Optional here because not every trusted artifact is published, but REQUIRED to publish a
   * workspace-host bundle (D-107): without it, evidence produced over some other detached
   * signature would satisfy an envelope that ships a different `.minisig`.
   */
  signatureSha256?: string;
  /**
   * Digest of the public verification key this evidence verified under. Publication requires it
   * to equal the key the release pins, so evidence gathered under an unpinned key cannot vouch
   * for the published bundle.
   */
  signingKeySha256?: string;
}

export interface SbomEvidence extends ArtifactTrustEvidenceBase {
  kind: 'sbom';
  format: string;
  documentSha256: string;
  componentCount: number;
}

export interface VulnerabilityFinding {
  id: string;
  severity: VulnerabilitySeverity;
}

export interface VulnerabilityEvidence extends ArtifactTrustEvidenceBase {
  kind: 'vulnerability-scan';
  /** Digest of the exact SBOM document the scanner consumed. */
  sbomSha256: string;
  findings: readonly VulnerabilityFinding[];
}

export interface SecretFinding {
  ruleId: string;
  location?: string;
}

export interface SecretScanEvidence extends ArtifactTrustEvidenceBase {
  kind: 'secret-scan';
  findings: readonly SecretFinding[];
}

export interface ProvenanceAttestationEvidence extends ArtifactTrustEvidenceBase {
  kind: 'provenance-attestation';
  valid: boolean;
  predicateType: string;
  issuedAt: string;
  attestationSha256: string;
}

export type ArtifactTrustEvidence =
  | SignatureEvidence
  | SbomEvidence
  | VulnerabilityEvidence
  | SecretScanEvidence
  | ProvenanceAttestationEvidence;

export interface ArtifactTrustAdapters {
  verifySignature(subject: Readonly<ArtifactTrustSubject>): Promise<SignatureEvidence | null | undefined>;
  generateSbom(subject: Readonly<ArtifactTrustSubject>): Promise<SbomEvidence | null | undefined>;
  scanVulnerabilities(
    subject: Readonly<ArtifactTrustSubject>,
    sbom: Readonly<SbomEvidence>,
  ): Promise<VulnerabilityEvidence | null | undefined>;
  scanSecrets(subject: Readonly<ArtifactTrustSubject>): Promise<SecretScanEvidence | null | undefined>;
  verifyProvenance(subject: Readonly<ArtifactTrustSubject>): Promise<ProvenanceAttestationEvidence | null | undefined>;
}

/** All five evidence classes are mandatory; this policy controls their bounded tolerances. */
export interface ArtifactTrustPolicy {
  denyVulnerabilitiesAtOrAbove: Exclude<VulnerabilitySeverity, 'unknown'>;
  maxSecretFindings: number;
  maxAttestationAgeMs: number;
}

export interface ArtifactTrustFailure {
  stage: ArtifactTrustEvidenceKind | 'artifact' | 'policy';
  code:
    | 'adapter-error'
    | 'artifact-unsigned'
    | 'attestation-from-future'
    | 'attestation-invalid'
    | 'attestation-stale'
    | 'evidence-subject-mismatch'
    | 'invalid-artifact'
    | 'invalid-policy'
    | 'malformed-evidence'
    | 'missing-evidence'
    | 'sbom-mismatch'
    | 'secret-threshold'
    | 'signature-invalid'
    | 'vulnerability-threshold';
  message: string;
}

export interface ArtifactTrustReport {
  version: typeof ARTIFACT_TRUST_PIPELINE_VERSION;
  subject: ArtifactTrustSubject;
  policy: ArtifactTrustPolicy;
  trusted: boolean;
  evidence: readonly ArtifactTrustEvidence[];
  failures: readonly ArtifactTrustFailure[];
}

export interface ArtifactTrustRuntime {
  now?: () => number;
}

const SHA256 = /^[0-9a-f]{64}$/;
/**
 * Severity ordering for `denyVulnerabilitiesAtOrAbove`. Exported so the
 * workspace-host IMAGE scan gate (`image-scan-policy.ts`) ranks severities against
 * this exact table instead of keeping a second copy that can drift out of step with
 * the policy it is supposed to be enforcing.
 */
export const SEVERITY_RANK: Record<VulnerabilitySeverity, number> = {
  unknown: -1,
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function failure(
  failures: ArtifactTrustFailure[],
  stage: ArtifactTrustFailure['stage'],
  code: ArtifactTrustFailure['code'],
  message: string,
): void {
  failures.push({ stage, code, message });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validTool(tool: ArtifactTrustTool | undefined): boolean {
  return Boolean(
    tool &&
    typeof tool.name === 'string' &&
    tool.name.trim() &&
    typeof tool.version === 'string' &&
    tool.version.trim(),
  );
}

function validateSubject(subject: ArtifactTrustSubject, failures: ArtifactTrustFailure[]): void {
  if (
    !subject ||
    typeof subject.path !== 'string' ||
    !subject.path ||
    typeof subject.name !== 'string' ||
    !subject.name ||
    !Number.isSafeInteger(subject.bytes) ||
    subject.bytes <= 0 ||
    typeof subject.sha256 !== 'string' ||
    !SHA256.test(subject.sha256)
  ) {
    failure(
      failures,
      'artifact',
      'invalid-artifact',
      'Artifact trust requires a non-empty path/name, positive byte count, and canonical lowercase SHA-256.',
    );
  }
  if (subject?.signed !== true) {
    failure(failures, 'artifact', 'artifact-unsigned', 'Artifact handoff has no updater signature metadata.');
  }
}

function validatePolicy(policy: ArtifactTrustPolicy, failures: ArtifactTrustFailure[]): void {
  if (
    !policy ||
    !['low', 'medium', 'high', 'critical'].includes(policy.denyVulnerabilitiesAtOrAbove) ||
    !Number.isSafeInteger(policy.maxSecretFindings) ||
    policy.maxSecretFindings < 0 ||
    !Number.isSafeInteger(policy.maxAttestationAgeMs) ||
    policy.maxAttestationAgeMs <= 0
  ) {
    failure(
      failures,
      'policy',
      'invalid-policy',
      'Artifact trust policy requires a known vulnerability threshold and non-negative, finite bounds.',
    );
  }
}

function validateCommonEvidence(
  evidence: ArtifactTrustEvidence,
  expectedKind: ArtifactTrustEvidenceKind,
  subject: ArtifactTrustSubject,
  failures: ArtifactTrustFailure[],
): void {
  if (evidence.kind !== expectedKind || !validTool(evidence.tool)) {
    failure(
      failures,
      expectedKind,
      'malformed-evidence',
      `${expectedKind} evidence has the wrong kind or lacks exact tool name/version metadata.`,
    );
  }
  if (evidence.subjectSha256 !== subject.sha256) {
    failure(
      failures,
      expectedKind,
      'evidence-subject-mismatch',
      `${expectedKind} evidence is bound to '${evidence.subjectSha256}', not artifact '${subject.sha256}'.`,
    );
  }
}

async function collectEvidence<T extends ArtifactTrustEvidence>(
  stage: ArtifactTrustEvidenceKind,
  run: () => Promise<T | null | undefined>,
  evidence: ArtifactTrustEvidence[],
  failures: ArtifactTrustFailure[],
): Promise<T | undefined> {
  try {
    const result = await run();
    if (!result) {
      failure(failures, stage, 'missing-evidence', `${stage} produced no evidence.`);
      return undefined;
    }
    evidence.push(result);
    return result;
  } catch (error) {
    failure(failures, stage, 'adapter-error', `${stage} adapter failed: ${errorMessage(error)}`);
    return undefined;
  }
}

function validateSignature(
  result: SignatureEvidence,
  subject: ArtifactTrustSubject,
  failures: ArtifactTrustFailure[],
): void {
  validateCommonEvidence(result, 'signature', subject, failures);
  if (result.valid !== true) {
    failure(failures, 'signature', 'signature-invalid', 'Artifact signature verification did not succeed.');
  }
}

function validateSbom(result: SbomEvidence, subject: ArtifactTrustSubject, failures: ArtifactTrustFailure[]): void {
  validateCommonEvidence(result, 'sbom', subject, failures);
  if (
    typeof result.format !== 'string' ||
    !result.format.trim() ||
    !SHA256.test(result.documentSha256) ||
    !Number.isSafeInteger(result.componentCount) ||
    result.componentCount < 0
  ) {
    failure(
      failures,
      'sbom',
      'malformed-evidence',
      'SBOM evidence requires a format, canonical document SHA-256, and non-negative component count.',
    );
  }
}

function validateVulnerabilities(
  result: VulnerabilityEvidence,
  subject: ArtifactTrustSubject,
  sbom: SbomEvidence,
  policy: ArtifactTrustPolicy,
  failures: ArtifactTrustFailure[],
): void {
  validateCommonEvidence(result, 'vulnerability-scan', subject, failures);
  if (result.sbomSha256 !== sbom.documentSha256) {
    failure(
      failures,
      'vulnerability-scan',
      'sbom-mismatch',
      `Vulnerability scan consumed SBOM '${result.sbomSha256}', not '${sbom.documentSha256}'.`,
    );
  }
  if (!Array.isArray(result.findings)) {
    failure(failures, 'vulnerability-scan', 'malformed-evidence', 'Vulnerability findings must be an array.');
    return;
  }
  const threshold = SEVERITY_RANK[policy.denyVulnerabilitiesAtOrAbove];
  for (const candidate of result.findings as readonly unknown[]) {
    const finding = candidate as Partial<VulnerabilityFinding> | null | undefined;
    const severity = finding?.severity;
    if (
      !finding ||
      typeof finding.id !== 'string' ||
      !finding.id.trim() ||
      typeof severity !== 'string' ||
      !Object.hasOwn(SEVERITY_RANK, severity)
    ) {
      failure(
        failures,
        'vulnerability-scan',
        'malformed-evidence',
        'Every vulnerability requires an id and a declared severity.',
      );
      continue;
    }
    const declaredSeverity = severity as VulnerabilitySeverity;
    if (SEVERITY_RANK[declaredSeverity] >= threshold) {
      failure(
        failures,
        'vulnerability-scan',
        'vulnerability-threshold',
        `Vulnerability '${finding.id}' severity '${declaredSeverity}' meets the denied '${policy.denyVulnerabilitiesAtOrAbove}' threshold.`,
      );
    }
  }
}

function validateSecrets(
  result: SecretScanEvidence,
  subject: ArtifactTrustSubject,
  policy: ArtifactTrustPolicy,
  failures: ArtifactTrustFailure[],
): void {
  validateCommonEvidence(result, 'secret-scan', subject, failures);
  if (
    !Array.isArray(result.findings) ||
    result.findings.some((finding) => !finding || typeof finding.ruleId !== 'string' || !finding.ruleId.trim())
  ) {
    failure(failures, 'secret-scan', 'malformed-evidence', 'Every secret finding requires a rule id.');
    return;
  }
  if (result.findings.length > policy.maxSecretFindings) {
    failure(
      failures,
      'secret-scan',
      'secret-threshold',
      `Secret scan found ${result.findings.length}; policy allows ${policy.maxSecretFindings}.`,
    );
  }
}

function validateAttestation(
  result: ProvenanceAttestationEvidence,
  subject: ArtifactTrustSubject,
  policy: ArtifactTrustPolicy,
  now: number,
  failures: ArtifactTrustFailure[],
): void {
  validateCommonEvidence(result, 'provenance-attestation', subject, failures);
  if (result.valid !== true) {
    failure(
      failures,
      'provenance-attestation',
      'attestation-invalid',
      'Provenance attestation verification did not succeed.',
    );
  }
  if (
    typeof result.predicateType !== 'string' ||
    !result.predicateType.trim() ||
    !SHA256.test(result.attestationSha256)
  ) {
    failure(
      failures,
      'provenance-attestation',
      'malformed-evidence',
      'Attestation requires a predicate type and canonical attestation SHA-256.',
    );
  }
  const issuedAt = Date.parse(result.issuedAt);
  if (!Number.isFinite(issuedAt)) {
    failure(
      failures,
      'provenance-attestation',
      'malformed-evidence',
      'Attestation issuedAt must be an exact timestamp.',
    );
    return;
  }
  const age = now - issuedAt;
  if (age < 0) {
    failure(
      failures,
      'provenance-attestation',
      'attestation-from-future',
      'Attestation issuedAt is later than the policy evaluation time.',
    );
  } else if (age > policy.maxAttestationAgeMs) {
    failure(
      failures,
      'provenance-attestation',
      'attestation-stale',
      `Attestation age ${age}ms exceeds the ${policy.maxAttestationAgeMs}ms policy limit.`,
    );
  }
}

/**
 * Run the provider-neutral artifact trust chain. Adapters own tool execution; this layer
 * only sequences them, binds their evidence, and applies the fail-closed release policy.
 */
export async function evaluateArtifactTrust(
  subject: ArtifactTrustSubject,
  adapters: ArtifactTrustAdapters,
  policy: ArtifactTrustPolicy,
  runtime: ArtifactTrustRuntime = {},
): Promise<ArtifactTrustReport> {
  const evidence: ArtifactTrustEvidence[] = [];
  const failures: ArtifactTrustFailure[] = [];
  validateSubject(subject, failures);
  validatePolicy(policy, failures);

  if (failures.some((item) => item.code === 'invalid-artifact' || item.code === 'invalid-policy')) {
    return {
      version: ARTIFACT_TRUST_PIPELINE_VERSION,
      subject,
      policy,
      trusted: false,
      evidence,
      failures,
    };
  }

  const signature = await collectEvidence('signature', () => adapters.verifySignature(subject), evidence, failures);
  if (signature) validateSignature(signature, subject, failures);

  const sbom = await collectEvidence('sbom', () => adapters.generateSbom(subject), evidence, failures);
  if (sbom) validateSbom(sbom, subject, failures);

  if (sbom) {
    const vulnerabilities = await collectEvidence(
      'vulnerability-scan',
      () => adapters.scanVulnerabilities(subject, sbom),
      evidence,
      failures,
    );
    if (vulnerabilities) validateVulnerabilities(vulnerabilities, subject, sbom, policy, failures);
  } else {
    failure(
      failures,
      'vulnerability-scan',
      'missing-evidence',
      'Vulnerability scan cannot run without the exact generated SBOM evidence.',
    );
  }

  const secrets = await collectEvidence('secret-scan', () => adapters.scanSecrets(subject), evidence, failures);
  if (secrets) validateSecrets(secrets, subject, policy, failures);

  const attestation = await collectEvidence(
    'provenance-attestation',
    () => adapters.verifyProvenance(subject),
    evidence,
    failures,
  );
  if (attestation) {
    const now = runtime.now?.() ?? Date.now();
    if (!Number.isFinite(now)) {
      failure(failures, 'policy', 'invalid-policy', 'Artifact trust evaluation time must be finite.');
    } else {
      validateAttestation(attestation, subject, policy, now, failures);
    }
  }

  return {
    version: ARTIFACT_TRUST_PIPELINE_VERSION,
    subject,
    policy,
    trusted: failures.length === 0,
    evidence,
    failures,
  };
}

export class ArtifactTrustError extends Error {
  constructor(readonly report: ArtifactTrustReport) {
    super(`Artifact trust rejected '${report.subject.name}': ${report.failures.map((item) => item.message).join(' ')}`);
    this.name = 'ArtifactTrustError';
  }
}

/** Fail-closed assertion for callers that must not continue with an untrusted artifact. */
export function assertArtifactTrusted(
  report: ArtifactTrustReport,
): asserts report is ArtifactTrustReport & { trusted: true } {
  if (!report.trusted || report.failures.length > 0) throw new ArtifactTrustError(report);
}
