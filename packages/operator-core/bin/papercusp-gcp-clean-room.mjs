#!/usr/bin/env node
/**
 * papercusp-gcp-clean-room — boot a candidate workspace-host image in an isolated,
 * private GCP instance, run the release fixture's exact bootstrap script, capture the
 * host's own attestation, and tear the whole thing down leaving zero residue.
 *
 * Invoked by CommandGcpImageFamilyCleanRoomRunner as:
 *     papercusp-gcp-clean-room --json-stdin        (payload on stdin)
 *
 * INPUT  GcpImageFamilyCleanRoomRunInput: { projectId, zone, imageId,
 *          buildManifestIdentity, releaseVersion, releaseSha256, fixture }
 *        where fixture = { fixtureId, bootstrapInput, bootstrapScript,
 *          bootstrapScriptSha256, ... } built by
 *          buildWorkspaceHostCleanRoomInstallFixture.
 *
 * OUTPUT GcpImageCleanBootProof, validated by cleanProof()
 *        (gcp-image-family-adapter.ts:415), which REQUIRES:
 *          computeRunning === true
 *          osLoginReady === true
 *          publicIpv4Assigned === false   <-- a public IP FAILS the gate
 *          terminated === true
 *          residualResourceIds.length === 0
 *          attestation.status === 'healthy' and validating against fixture.bootstrapInput
 *
 * WHY PRIVATE-ONLY: the gate asserts the image boots and self-attests WITHOUT any public
 * ingress path, so the instance is created with --no-address and reached exclusively over
 * IAP. This is the property the canary exists to prove; it is not a hardening nicety.
 *
 * TRUST RULE: every boolean in the proof is an OBSERVED value read back from GCP or from
 * the host's own attestation. Nothing is asserted because we intended it — in particular
 * `terminated` and `residualResourceIds` are computed from the teardown's real outcome,
 * so a leaked VM can never be reported as a clean run.
 */
import { createHash } from 'node:crypto';

import {
  describeImage,
  fail,
  main,
  parseImmutableImageId,
  parseJsonObject,
  requireExactText,
  requireText,
} from './gcp-ephemeral.mjs';
import { runScriptOnPrivateVm } from './gcp-private-vm-session.mjs';

/** Must match WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_PREFIX in the deployment driver. */
const ATTESTATION_PREFIX = 'PAPERCUSP_WORKSPACE_HOST_ATTESTATION=';
const BOOT_BUDGET_MS = 12 * 60 * 1000;
const BOOTSTRAP_BUDGET_MS = 20 * 60 * 1000;

/**
 * Decode the attestation the bootstrap script prints as its final marker line.
 * A missing marker is a hard failure: an unattested boot is exactly the thing the
 * clean-room exists to catch, so it must never degrade into "no attestation found, assume ok".
 */
function extractAttestation(stdout) {
  const lines = String(stdout).split(/\r?\n/);
  let encoded;
  // Scan from the end: the marker is emitted last, and a rerun would append a newer one.
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].startsWith(ATTESTATION_PREFIX)) {
      encoded = lines[index].slice(ATTESTATION_PREFIX.length).trim();
      break;
    }
  }
  if (!encoded) fail('bootstrap produced no attestation marker; the image did not self-attest');
  let decoded;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch (error) {
    fail(`bootstrap attestation was not valid base64: ${error.message}`);
  }
  return parseJsonObject(decoded, 'bootstrap attestation');
}

async function cleanRoom(input) {
  const requested = parseImmutableImageId(input.imageId, 'imageId');
  const projectId = requireText(input.projectId, 'projectId');
  const zone = requireText(input.zone, 'zone');
  const buildManifestIdentity = requireText(input.buildManifestIdentity, 'buildManifestIdentity');
  // Required at the boundary: a missing subnetwork must fail fast and loudly here rather
  // than default to a no-egress network and surface 20 minutes later as an opaque
  // apt-get/curl timeout inside the guest.
  const subnetwork = requireText(input.subnetwork, 'subnetwork');

  if (projectId !== requested.projectId) fail('projectId does not match the project embedded in imageId');

  const fixture = input.fixture;
  if (!fixture || typeof fixture !== 'object') fail('fixture is required to run a clean-room canary');
  // requireExactText, NOT requireText: same content-addressing rule as the pre-build acceptance
  // binary. The digest check below is conditional on bootstrapScriptSha256 being supplied, which
  // is why trimming stayed invisible under hand-made inputs that omit it and only bit on the
  // production path, where a real fixture always carries its digest.
  const bootstrapScript = requireExactText(fixture.bootstrapScript, 'fixture.bootstrapScript');
  const fixtureId = requireText(fixture.fixtureId, 'fixture.fixtureId');

  // The submitted script must match its own advertised digest before we execute it.
  const actualDigest = createHash('sha256').update(bootstrapScript, 'utf8').digest('hex');
  if (typeof fixture.bootstrapScriptSha256 === 'string' && fixture.bootstrapScriptSha256 !== actualDigest) {
    fail('fixture.bootstrapScript does not match fixture.bootstrapScriptSha256');
  }

  // The candidate must exist and be READY before we spend money booting it.
  await describeImage(projectId, requested.imageName);

  // Private-only instance booting the CANDIDATE image: no external address, IAP is the sole
  // ingress. Creation, boot/OS-Login waits, and exhaustive teardown are the shared flow.
  const session = await runScriptOnPrivateVm({
    projectId,
    zone,
    subnetwork,
    imageName: requested.imageName,
    imageProject: projectId,
    script: bootstrapScript,
    fixtureId,
    role: 'clean-room',
    instancePrefix: 'pc-cleanroom',
    bootBudgetMs: BOOT_BUDGET_MS,
    scriptBudgetMs: BOOTSTRAP_BUDGET_MS,
  });

  const { instanceName, observedAt, computeRunning, osLoginReady, publicIpv4Assigned, residualResourceIds } =
    session;
  const attestation = extractAttestation(session.stdout);

  if (!attestation) fail('clean-room produced no attestation');
  if (attestation.status !== 'healthy') {
    fail(`clean-room attestation status is ${String(attestation.status)}, not healthy`);
  }

  const evidenceRef = `gcp-clean-room:${instanceName}:${createHash('sha256')
    .update(`${requested.imageId}|${buildManifestIdentity}|${fixtureId}|${observedAt}`)
    .digest('hex')
    .slice(0, 32)}`;

  return {
    evidenceRef,
    projectId,
    zone,
    imageId: requested.imageId,
    buildManifestIdentity,
    computeRunning,
    osLoginReady,
    publicIpv4Assigned,
    attestation,
    // Terminated is true only when teardown actually left nothing behind.
    terminated: residualResourceIds.length === 0,
    residualResourceIds,
    observedAt,
    fixtureId,
    ...(typeof fixture.bootstrapScriptSha256 === 'string'
      ? { bootstrapScriptSha256: fixture.bootstrapScriptSha256 }
      : {}),
  };
}

await main('papercusp-gcp-clean-room', cleanRoom);
