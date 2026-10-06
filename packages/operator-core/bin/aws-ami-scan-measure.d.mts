/** Types for aws-ami-scan-measure.mjs (papercusp-aws-ami-scan's pure logic, WI-10005587). */
export declare const AWS_AMI_SCAN_TOOL: 'papercusp-aws-ami-scan';
export declare const AWS_AMI_DESCRIPTION_PATTERN: RegExp;
export declare const PAPERCUSP_BUNDLE_PATH: string;
export declare const SECRET_BUNDLED_SAMPLE_CAP: number;
export declare const GUEST_PACKAGE_PROBES: readonly string[];

export interface AwsAmiScanRequest {
  region: string;
  imageId: string;
  buildManifestIdentity: string;
  releaseSha256: string;
}

export interface AwsAmiScanProvenance {
  snapshotId: string;
  releaseVersion: string;
  encrypted: boolean;
}

export interface AwsAmiScanMeasurement {
  sbomSha256: string;
  vulnerabilityFindings: number;
  vulnerabilityBySeverity: Record<string, number>;
  vulnerabilityFixableBySeverity: Record<string, number>;
  vulnerabilityByEcosystem: Record<string, number>;
  vulnerabilityByScope: Record<string, number>;
  vulnerabilityCriticalHighByScope: Record<string, number>;
  bundleCatalogedArtifacts: number;
  secretFindings: number;
  secretsByScope: Record<string, number>;
  secretSample: { rule: unknown; file: unknown; line: unknown }[];
  secretBundledSample: { rule: unknown; file: unknown; line: unknown }[];
  secretBundledSampleComplete: boolean;
  mountedFilesystems: number;
  candidateRootProof: string;
  catalogedArtifacts: { total: number; npm: number; rpm: number };
  guestPackages: Record<string, string | null>;
}

export interface AwsAmiScanMeasureInput {
  sbomText: string;
  vulnText: string;
  secretsText: string;
  mountedFilesystems: number;
  candidateRootProof: string;
  npmManifestsPresent: boolean;
}

export declare function parseAwsAmiScanInput(input: unknown): AwsAmiScanRequest;
export declare function assertAwsAmiProvenance(image: unknown, expected: AwsAmiScanRequest): AwsAmiScanProvenance;
export declare function selectCandidateRoot(paths: readonly string[], mountRoot: string): { proof: string; osRoot: string } | null;
export declare function measureAwsAmiScan(input: AwsAmiScanMeasureInput): AwsAmiScanMeasurement;
export declare function buildAwsAmiScanEvidence(
  request: AwsAmiScanRequest,
  provenance: AwsAmiScanProvenance,
  measurement: AwsAmiScanMeasurement,
  toolVersions: Readonly<Record<string, string>>,
): AwsAmiScanRequest &
  AwsAmiScanMeasurement & {
    trusted: true;
    evidenceRef: string;
    snapshotId: string;
    releaseVersion: string;
    scanner: Record<string, string>;
  };
