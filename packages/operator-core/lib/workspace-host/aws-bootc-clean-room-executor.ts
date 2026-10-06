/**
 * AWS bootc clean-room executor (WI-10005633).
 *
 * The workspace-host release gate needs a clean-room report whose bootstrap attestation was
 * produced by a host that BOOTED the candidate image: the bootc bootstrap script reads
 * `bootc status` and refuses unless the booted digest is the artifact's digest. The GCP
 * executor (`workspace-host-clean-room-executor.ts`) boots stock Ubuntu and installs a release
 * bundle, so it can never attest a bootc image.
 *
 * This executor attests the bake's own AWS disk:
 *   1. upload it with coldsnap and register it as a transient, unencrypted AMI in the publisher
 *      account, shared only with the clean account (`stageCleanRoomImage`);
 *   2. launch it in the clean account with the release's own canary bin, which runs the
 *      fixture's bootstrap script over SSM, reads the attestation back and terminates the
 *      instance (`launchCleanAccountCanary`);
 *   3. deregister the AMI and delete its snapshot, then census both to zero
 *      (`discardCleanRoomImage`), on success and on failure alike.
 *
 * Steps 1 and 2 reuse the release adapter's upload/register shape and its canary, so the clean
 * room boots the same disk, the same way, as the release that follows it.
 */
import { randomUUID } from 'node:crypto';

import {
  WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_PREFIX,
  type WorkspaceHostCleanRoomExecutor,
  type WorkspaceHostCleanRoomInstallFixture,
} from '@papercusp/deployment-driver';

import type { AwsAmiCleanAccountLaunchProof, AwsAmiReleaseAdapter } from './aws-ami-release';
import type { WorkspaceHostBootcCloudArtifact } from './bootc-bake-manifest';

export const AWS_BOOTC_CLEAN_ROOM_RUN_TAG = 'papercusp:clean-room-run';
export const AWS_BOOTC_CLEAN_ROOM_STAGE = 'clean-room-transient';

const ACCOUNT_ID = /^\d{12}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

export interface AwsBootcCleanRoomStageInput {
  region: string;
  bootcArtifact: WorkspaceHostBootcCloudArtifact;
  imageName: string;
  description: string;
  architecture: string;
  /** The ONLY account granted launch and create-volume permission. */
  shareWithAccountId: string;
  tags: Readonly<Record<string, string>>;
}

export interface AwsBootcCleanRoomDiscardInput {
  region: string;
  imageId: string;
  snapshotId: string;
}

/** The three adapter operations the clean room uses; `SdkAwsAmiReleaseAdapter` provides all three. */
export interface AwsBootcCleanRoomAdapter {
  stageCleanRoomImage(input: AwsBootcCleanRoomStageInput): Promise<{ imageId: string; snapshotId: string }>;
  launchCleanAccountCanary: AwsAmiReleaseAdapter['launchCleanAccountCanary'];
  discardCleanRoomImage(input: AwsBootcCleanRoomDiscardInput): Promise<{ residualResourceIds: readonly string[] }>;
}

export interface AwsBootcCleanRoomPlacement {
  /** The account that uploads and registers the transient AMI (the release publisher). */
  publisherAccountId: string;
  /** Region of the transient AMI and of the clean-account launch. */
  region: string;
  cleanAccount: {
    accountId: string;
    subnetId: string;
    instanceProfileArn: string;
  };
  /** The AWS/ami row of the canonical bake manifest; verified byte-for-byte before upload. */
  bootcArtifact: WorkspaceHostBootcCloudArtifact;
  architecture: string;
  /** `workspaceHostReleaseSubjectSha256(artifact)` of the release under test. */
  releaseSha256: string;
}

export class AwsBootcCleanRoomError extends Error {
  constructor(
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'AwsBootcCleanRoomError';
  }
}

function fail(message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new AwsBootcCleanRoomError(message, details);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function validateAwsBootcCleanRoomPlacement(placement: AwsBootcCleanRoomPlacement): void {
  if (!ACCOUNT_ID.test(placement.publisherAccountId)) fail('placement.publisherAccountId must be a 12-digit account id');
  if (!ACCOUNT_ID.test(placement.cleanAccount.accountId)) fail('placement.cleanAccount.accountId must be a 12-digit account id');
  if (placement.cleanAccount.accountId === placement.publisherAccountId) {
    fail('the clean account must differ from the publisher account: a clean room is a customer-like account');
  }
  if (!REGION.test(placement.region)) fail(`placement.region '${placement.region}' is not an AWS region`);
  if (!/^subnet-[0-9a-f]{8,17}$/.test(placement.cleanAccount.subnetId)) fail('placement.cleanAccount.subnetId must be a subnet id');
  if (!placement.cleanAccount.instanceProfileArn.startsWith('arn:aws')) {
    fail('placement.cleanAccount.instanceProfileArn must be an ARN');
  }
  if (placement.bootcArtifact.cloud !== 'aws' || placement.bootcArtifact.type !== 'ami') {
    fail('placement.bootcArtifact must be the AWS/ami row of the bake manifest');
  }
  if (!/^[0-9a-f]{64}$/.test(placement.releaseSha256)) fail('placement.releaseSha256 must be a sha256 hex digest');
}

/**
 * Re-encode the canary's attestation as the bootstrap's own stdout marker, so the shared
 * `runWorkspaceHostCleanRoomAcceptance` parses and validates it exactly as it does on GCP.
 */
export function attestationStdout(attestation: AwsAmiCleanAccountLaunchProof['attestation']): string {
  const encoded = Buffer.from(JSON.stringify(attestation), 'utf8').toString('base64');
  return `${WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_PREFIX}${encoded}\n`;
}

function checkProof(
  proof: AwsAmiCleanAccountLaunchProof,
  placement: AwsBootcCleanRoomPlacement,
  imageId: string,
  fixture: WorkspaceHostCleanRoomInstallFixture,
): void {
  const problems: string[] = [];
  if (proof.accountId !== placement.cleanAccount.accountId) problems.push(`ran in account ${proof.accountId}, not the clean account`);
  if (proof.region !== placement.region) problems.push(`ran in region ${proof.region}, not ${placement.region}`);
  if (proof.imageId !== imageId) problems.push(`launched ${proof.imageId}, not the staged image ${imageId}`);
  if (proof.fixtureId !== fixture.fixtureId) problems.push(`executed fixture ${proof.fixtureId}, not ${fixture.fixtureId}`);
  if (!proof.ssmOnline) problems.push('SSM never came online');
  if (proof.publicIpv4Assigned) problems.push('the instance was assigned a public IPv4 address');
  if (!proof.terminated) problems.push('the instance was not terminated');
  if (proof.residualResourceIds.length > 0) problems.push(`canary residue: ${proof.residualResourceIds.join(', ')}`);
  if (!proof.attestation || typeof proof.attestation !== 'object' || Array.isArray(proof.attestation)) {
    problems.push('the canary returned no bootstrap attestation');
  }
  if (problems.length > 0) fail(`clean-room canary proof rejected: ${problems.join('; ')}`, { proof });
}

export class AwsBootcCleanRoomExecutor implements WorkspaceHostCleanRoomExecutor {
  constructor(
    private readonly adapter: AwsBootcCleanRoomAdapter,
    private readonly placement: AwsBootcCleanRoomPlacement,
    private readonly runId: () => string = () => randomUUID(),
  ) {
    validateAwsBootcCleanRoomPlacement(placement);
  }

  async execute(fixture: WorkspaceHostCleanRoomInstallFixture): Promise<{ stdout: string }> {
    const { placement } = this;
    const runId = this.runId();
    const version = fixture.image.version;
    const staged = await this.adapter.stageCleanRoomImage({
      region: placement.region,
      bootcArtifact: placement.bootcArtifact,
      imageName: `papercusp-workspace-host-clean-room-${version}-${runId.slice(0, 8)}`,
      description: `Papercusp workspace-host clean room ${version} (transient, run ${runId})`,
      architecture: placement.architecture,
      shareWithAccountId: placement.cleanAccount.accountId,
      tags: {
        [AWS_BOOTC_CLEAN_ROOM_RUN_TAG]: runId,
        'papercusp:clean-room-fixture': fixture.fixtureId,
        'papercusp:release-version': version,
        'papercusp:release-stage': AWS_BOOTC_CLEAN_ROOM_STAGE,
      },
    });

    let proof: AwsAmiCleanAccountLaunchProof | undefined;
    let failure: unknown;
    try {
      proof = await this.adapter.launchCleanAccountCanary({
        accountId: placement.cleanAccount.accountId,
        region: placement.region,
        subnetId: placement.cleanAccount.subnetId,
        instanceProfileArn: placement.cleanAccount.instanceProfileArn,
        imageId: staged.imageId,
        releaseVersion: version,
        releaseSha256: placement.releaseSha256,
        buildManifestIdentity: fixture.manifestIdentity,
        fixture,
      });
      checkProof(proof, placement, staged.imageId, fixture);
    } catch (error) {
      failure = error;
    }

    // Teardown runs on every path; an unmeasured teardown never reads as clean.
    let residue: readonly string[];
    let teardownError: string | undefined;
    try {
      residue = (await this.adapter.discardCleanRoomImage({
        region: placement.region,
        imageId: staged.imageId,
        snapshotId: staged.snapshotId,
      })).residualResourceIds;
    } catch (error) {
      teardownError = errorMessage(error);
      residue = [staged.imageId, staged.snapshotId];
    }

    const details = { runId, imageId: staged.imageId, snapshotId: staged.snapshotId, residualResourceIds: residue };
    if (failure) {
      const suffix = residue.length > 0 ? ` (teardown left ${residue.join(', ')}${teardownError ? `: ${teardownError}` : ''})` : '';
      fail(`AWS bootc clean room failed: ${errorMessage(failure)}${suffix}`, details);
    }
    if (residue.length > 0) {
      fail(`AWS bootc clean room left residue: ${residue.join(', ')}${teardownError ? ` (${teardownError})` : ''}`, details);
    }
    return { stdout: attestationStdout(proof!.attestation) };
  }
}
