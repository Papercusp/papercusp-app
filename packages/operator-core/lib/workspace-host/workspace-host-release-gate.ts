import {
  WORKSPACE_HOST_BOOTC_BUILDER_KIND,
  WORKSPACE_HOST_BUILDER_KINDS,
  WORKSPACE_HOST_BUILDER_TEMPLATE_SHAPES,
  WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
  WORKSPACE_HOST_IMAGE_FAMILY_BUILDER_KINDS,
  evaluateWorkspaceHostImageCompatibility,
  validateWorkspaceHostImageArtifact,
  verifyWorkspaceHostBuildManifest,
  workspaceHostImageModel,
  type WorkspaceHostBuildManifestVerification,
  type WorkspaceHostBuilderKind,
  type WorkspaceHostBuilderTemplateShape,
  type WorkspaceHostCleanRoomAcceptanceCheck,
  type WorkspaceHostCleanRoomAcceptanceReport,
  type WorkspaceHostImageArtifact,
  type WorkspaceHostImageCompatibilityRequest,
  type WorkspaceHostImageCompatibilityResult,
} from '@papercusp/deployment-driver';

import type { ArtifactTrustReport } from './artifact-trust';
import {
  validateWorkspaceHostBootcBakeManifest,
  workspaceHostReleaseSubjectSha256,
  type WorkspaceHostBootcBakeManifest,
} from './bootc-bake-manifest';

export const WORKSPACE_HOST_RELEASE_GATE_VERSION = 'workspace-host-release-gate-v1';

const REQUIRED_CLEAN_ROOM_CHECKS = [
  'artifact-identity',
  'compatibility-matrix',
  'deterministic-bootstrap-fixture',
  'exact-bootstrap-attestation',
] as const satisfies readonly WorkspaceHostCleanRoomAcceptanceCheck[];

const SHA256 = /^[a-f0-9]{64}$/;

/**
 * Every image-family release path (GCP, AWS, Azure) feeds
 * `buildManifest.builder.templatePath` straight into the named builder — `packer init` /
 * `packer build` for Packer, `podman build` + `bootc-image-builder` for bootc. A template
 * that does not have that builder's shape cannot be built no matter what digest it carries.
 *
 * P-307 replaced a hardcoded packer-only pair of checks with the shared
 * WORKSPACE_HOST_BUILDER_TEMPLATE_SHAPES table so a second builder could exist without this
 * gate and the manifest contract disagreeing about which kinds are legal. The eligibility
 * question and the shape question stay SEPARATE below, because they have different repairs:
 * a kind that may not cut an image at all is a routing mistake, while a wrong template
 * extension is a manifest-authoring mistake, and one message for both sends readers to the
 * wrong file.
 */

export type WorkspaceHostReleaseGateFailureCode =
  | 'clean-room-rejected'
  | 'clean-room-subject-mismatch'
  | 'incompatible-image'
  | 'invalid-bootc-bake-manifest'
  | 'invalid-build-manifest'
  | 'invalid-image-artifact'
  | 'trust-subject-mismatch'
  | 'unsupported-builder'
  | 'untrusted-release';

export interface WorkspaceHostReleaseGateFailure {
  code: WorkspaceHostReleaseGateFailureCode;
  message: string;
}

export interface WorkspaceHostReleaseGateInput {
  artifact: WorkspaceHostImageArtifact;
  /** Required for bootc artifacts; forbidden for the Ubuntu/Packer model. */
  bootcBakeManifest?: WorkspaceHostBootcBakeManifest;
  trustReport: ArtifactTrustReport;
  compatibilityRequest: WorkspaceHostImageCompatibilityRequest;
  cleanRoomReport: WorkspaceHostCleanRoomAcceptanceReport;
}

export interface WorkspaceHostReleaseGateVerdict {
  version: typeof WORKSPACE_HOST_RELEASE_GATE_VERSION;
  accepted: boolean;
  manifest: WorkspaceHostBuildManifestVerification;
  compatibility: WorkspaceHostImageCompatibilityResult;
  failures: readonly WorkspaceHostReleaseGateFailure[];
}

function sameImage(
  left: WorkspaceHostCleanRoomAcceptanceReport['image'],
  right: WorkspaceHostImageArtifact['image'],
): boolean {
  return left.id === right.id && left.version === right.version;
}

function issueSummary(issues: WorkspaceHostImageCompatibilityResult['issues']): string {
  return issues.map((issue) => `${issue.code}: ${issue.message}`).join('; ');
}

/**
 * Join the independently-tested build, trust, image-compatibility, and
 * clean-room contracts at the one point where a workspace-host release is
 * admitted. Every verdict is recomputed or bound to the exact immutable image
 * and release digest supplied here; callers cannot combine green evidence from
 * different artifacts.
 */
export function evaluateWorkspaceHostReleaseGate(
  input: WorkspaceHostReleaseGateInput,
): WorkspaceHostReleaseGateVerdict {
  const failures: WorkspaceHostReleaseGateFailure[] = [];
  const manifest = verifyWorkspaceHostBuildManifest(input.artifact.buildManifest);
  if (!manifest.ok) {
    failures.push({
      code: 'invalid-build-manifest',
      message: manifest.errors.join('; '),
    });
  } else {
    const artifactErrors = validateWorkspaceHostImageArtifact(input.artifact);
    if (artifactErrors.length > 0) {
      failures.push({
        code: 'invalid-image-artifact',
        message: artifactErrors.join('; '),
      });
    }
  }

  // The builder block describes the VM-IMAGE builder, and every provider's release path
  // packer-inits builder.templatePath before it does anything billable. Until this check
  // existed the field was stored and never read, so a manifest naming the sidecar bundle
  // builder — a bash script — passed every gate and died at `packer init` with an error
  // that named Packer rather than the manifest field that chose the file
  // (EI-21750653220169836; the r8 workspace-host artifact shipped exactly that way).
  const builder = input.artifact.buildManifest.builder;
  const hostModel = workspaceHostImageModel(input.artifact);
  const bootc = input.artifact.hostModel === 'bootc-image' ? input.artifact.bootc : undefined;
  const builderErrors: string[] = [];
  const shape = WORKSPACE_HOST_BUILDER_TEMPLATE_SHAPES[
    builder.kind as WorkspaceHostBuilderKind
  ] as WorkspaceHostBuilderTemplateShape | undefined;
  if (!shape) {
    builderErrors.push(
      `builder.kind '${builder.kind}' is not a known workspace-host builder (expected one of ${WORKSPACE_HOST_BUILDER_KINDS.join(', ')})`,
    );
  } else if (!shape.imageFamilyEligible) {
    builderErrors.push(
      `builder.kind '${builder.kind}' cannot produce an image-family release (eligible kinds: ${WORKSPACE_HOST_IMAGE_FAMILY_BUILDER_KINDS.join(', ')})`,
    );
  } else if (!shape.pattern.test(builder.templatePath)) {
    builderErrors.push(
      `builder.templatePath '${builder.templatePath}' is not ${shape.description}, which is what builder.kind '${builder.kind}' builds`,
    );
  }
  if (hostModel === 'bootc-image' && builder.kind !== WORKSPACE_HOST_BOOTC_BUILDER_KIND) {
    builderErrors.push(
      `hostModel 'bootc-image' requires builder.kind '${WORKSPACE_HOST_BOOTC_BUILDER_KIND}'`,
    );
  } else if (hostModel === 'ubuntu-release-bundle' && builder.kind === WORKSPACE_HOST_BOOTC_BUILDER_KIND) {
    builderErrors.push(
      `builder.kind '${WORKSPACE_HOST_BOOTC_BUILDER_KIND}' requires hostModel 'bootc-image'`,
    );
  }
  if (builderErrors.length > 0) {
    failures.push({
      code: 'unsupported-builder',
      message: builderErrors.join('; '),
    });
  }

  const bakeErrors: string[] = [];
  if (hostModel === 'bootc-image') {
    if (!input.bootcBakeManifest) {
      bakeErrors.push('bootcBakeManifest is required for a bootc image release');
    } else {
      bakeErrors.push(...validateWorkspaceHostBootcBakeManifest(input.bootcBakeManifest));
      const manifest = input.bootcBakeManifest;
      if (!bootc) {
        bakeErrors.push('artifact.bootc is required for a bootc image release');
      } else if (manifest.image !== bootc.image.replace(/:[^/:]+$/, '')) {
        bakeErrors.push('bootcBakeManifest.image does not match artifact.bootc.image repository');
      }
      if (bootc && `${manifest.image}:${manifest.tag}` !== bootc.image) {
        bakeErrors.push('bootcBakeManifest image:tag does not match artifact.bootc.image');
      }
      if (
        bootc &&
        (manifest.digest !== bootc.imageDigest ||
          manifest.pinnedRef !== `${manifest.image}@${bootc.imageDigest}`)
      ) {
        bakeErrors.push('bootcBakeManifest is not bound to artifact.bootc.imageDigest');
      }
    }
  } else if (input.bootcBakeManifest) {
    bakeErrors.push('bootcBakeManifest is valid only for hostModel bootc-image');
  }
  if (bakeErrors.length > 0) {
    failures.push({ code: 'invalid-bootc-bake-manifest', message: bakeErrors.join('; ') });
  }

  if (!input.trustReport.trusted || input.trustReport.failures.length > 0) {
    failures.push({
      code: 'untrusted-release',
      message:
        input.trustReport.failures.map((failure) => failure.message).join('; ') ||
        'Artifact trust report is not trusted',
    });
  }

  const trustDigest = input.trustReport.subject.sha256;
  const releaseDigest = workspaceHostReleaseSubjectSha256(input.artifact);
  const manifestDigest = input.artifact.buildManifest.releaseArtifact.sha256;
  if (
    trustDigest !== releaseDigest ||
    (hostModel === 'ubuntu-release-bundle' && trustDigest !== manifestDigest)
  ) {
    failures.push({
      code: 'trust-subject-mismatch',
      message:
        hostModel === 'bootc-image'
          ? `Trust subject ${trustDigest} must equal bootc image digest ${releaseDigest}`
          : `Trust subject ${trustDigest} must equal release.bundleSha256 ` +
            `${releaseDigest} and buildManifest.releaseArtifact.sha256 ${manifestDigest}`,
    });
  }

  const compatibility = evaluateWorkspaceHostImageCompatibility(input.artifact, input.compatibilityRequest);
  if (!compatibility.compatible) {
    failures.push({
      code: 'incompatible-image',
      message: issueSummary(compatibility.issues),
    });
  }

  const cleanRoom = input.cleanRoomReport;
  if (!sameImage(cleanRoom.image, input.artifact.image)) {
    failures.push({
      code: 'clean-room-subject-mismatch',
      message:
        `Clean-room report for ${cleanRoom.image.id}@${cleanRoom.image.version} ` +
        `does not match ${input.artifact.image.id}@${input.artifact.image.version}`,
    });
  }

  const missingChecks = REQUIRED_CLEAN_ROOM_CHECKS.filter((check) => !cleanRoom.checks.includes(check));
  const cleanRoomErrors: string[] = [];
  if (cleanRoom.contractVersion !== WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION) {
    cleanRoomErrors.push('clean-room contract version is unsupported');
  }
  if (!cleanRoom.passed) cleanRoomErrors.push('clean-room report did not pass');
  if (cleanRoom.issues.length > 0) {
    cleanRoomErrors.push(issueSummary(cleanRoom.issues));
  }
  if (missingChecks.length > 0) {
    cleanRoomErrors.push(`missing checks: ${missingChecks.join(', ')}`);
  }
  if (!cleanRoom.bootstrapScriptSha256 || !SHA256.test(cleanRoom.bootstrapScriptSha256)) {
    cleanRoomErrors.push('bootstrap script digest is missing or invalid');
  }
  if (!cleanRoom.attestation) {
    cleanRoomErrors.push('exact bootstrap attestation is missing');
  } else {
    if (cleanRoom.attestation.hostModel !== hostModel) {
      cleanRoomErrors.push(
        `bootstrap attestation hostModel '${cleanRoom.attestation.hostModel}' does not match artifact hostModel '${hostModel}'`,
      );
    } else if (cleanRoom.attestation.hostModel === 'bootc-image' && hostModel === 'bootc-image') {
      if (!bootc) {
        cleanRoomErrors.push('artifact bootc image identity is missing');
      } else if (
        cleanRoom.attestation.release.version !== input.artifact.release.version ||
        cleanRoom.attestation.release.source !== bootc.image ||
        cleanRoom.attestation.release.imageDigest !== bootc.imageDigest ||
        cleanRoom.attestation.release.signaturePolicyPath !== bootc.signaturePolicyPath ||
        cleanRoom.attestation.bootcBaseImage !== bootc.baseImage
      ) {
        cleanRoomErrors.push('bootstrap attestation bootc image identity does not match');
      }
    } else if (cleanRoom.attestation.hostModel === 'ubuntu-release-bundle') {
      if (
        cleanRoom.attestation.release.version !== input.artifact.release.version ||
        cleanRoom.attestation.release.bundleSha256 !== releaseDigest ||
        cleanRoom.attestation.release.signingKeySha256 !== input.artifact.release.signingKeySha256
      ) {
        cleanRoomErrors.push('bootstrap attestation release identity does not match');
      }
    }
    if (!cleanRoom.attestation.release.signatureVerified) {
      cleanRoomErrors.push('bootstrap attestation did not verify the release signature');
    }
  }
  if (cleanRoomErrors.length > 0) {
    failures.push({
      code: 'clean-room-rejected',
      message: cleanRoomErrors.join('; '),
    });
  }

  return {
    version: WORKSPACE_HOST_RELEASE_GATE_VERSION,
    accepted: failures.length === 0,
    manifest,
    compatibility,
    failures,
  };
}
