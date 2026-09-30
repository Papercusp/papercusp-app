#!/usr/bin/env node
/**
 * papercusp-gcp-bootstrap-acceptance — run a release fixture's exact bootstrap script on a
 * pristine STOCK Ubuntu instance and return the host's own stdout, so the workspace-host
 * release gate can ratify a real attestation instead of an asserted one.
 *
 * Invoked by CommandWorkspaceHostCleanRoomExecutor as:
 *     papercusp-gcp-bootstrap-acceptance --json-stdin        (payload on stdin)
 *
 * INPUT  { projectId, zone, subnetwork, architecture, machineType?,
 *          fixture: { fixtureId, bootstrapScript, bootstrapScriptSha256? } }
 *
 * OUTPUT { stdout, instanceName, imageName, imageProject, observedAt,
 *          computeRunning, osLoginReady, publicIpv4Assigned, terminated, residualResourceIds }
 *        `stdout` is what runWorkspaceHostCleanRoomAcceptance parses the attestation out of.
 *
 * WHY STOCK UBUNTU, NOT THE CANDIDATE IMAGE: this is the PRE-BUILD half of the clean room.
 * Its report is consumed by evaluateWorkspaceHostReleaseGate, whose verdict AUTHORIZES
 * building the image — so the image cannot exist yet, and booting it here would be circular.
 * What is being accepted is the SIGNED BUNDLE's ability to install itself and self-attest on
 * a machine carrying none of our state. The post-build canary
 * (papercusp-gcp-clean-room) is the other half, and gcp-image-family.ts:validateCleanBootProof
 * checks ITS attestation against the one this run produces.
 *
 * TRUST RULE: this tool NEVER synthesizes an attestation. It returns only what the guest
 * actually printed; a bootstrap that stays silent yields silence, which the acceptance
 * function then rejects. Fabricating a healthy-looking attestation here would defeat the
 * entire purpose of the gate.
 */
import { createHash } from 'node:crypto';

import { fail, main, requireExactText, requireText } from './gcp-ephemeral.mjs';
import {
  STOCK_UBUNTU_IMAGE_PROJECT,
  resolveImageFromFamily,
  runScriptOnPrivateVm,
  stockUbuntuImageFamily,
} from './gcp-private-vm-session.mjs';

const BOOT_BUDGET_MS = 12 * 60 * 1000;
const BOOTSTRAP_BUDGET_MS = 20 * 60 * 1000;

async function bootstrapAcceptance(input) {
  const projectId = requireText(input.projectId, 'projectId');
  const zone = requireText(input.zone, 'zone');
  // Required at the boundary for the same reason as the canary (EI-21744781090863686):
  // --no-address without a NAT-backed subnet leaves the guest with no egress, and this
  // script MUST reach the public Cupboard URL to download and signature-verify the bundle.
  // Defaulting here would surface 20 minutes later as an opaque apt-get/curl timeout.
  const subnetwork = requireText(input.subnetwork, 'subnetwork');
  const architecture = requireText(input.architecture, 'architecture');

  const fixture = input.fixture;
  if (!fixture || typeof fixture !== 'object') fail('fixture is required to run bootstrap acceptance');
  // requireExactText, NOT requireText: the digest below is computed over these exact bytes and
  // compared against the fixture's advertised sha256. requireText trims, and the fixture's
  // bootstrap script ends in a newline, so trimming here rejected every genuine fixture.
  const bootstrapScript = requireExactText(fixture.bootstrapScript, 'fixture.bootstrapScript');
  const fixtureId = requireText(fixture.fixtureId, 'fixture.fixtureId');

  // The submitted script must match its own advertised digest before we execute it.
  const actualDigest = createHash('sha256').update(bootstrapScript, 'utf8').digest('hex');
  if (typeof fixture.bootstrapScriptSha256 === 'string' && fixture.bootstrapScriptSha256 !== actualDigest) {
    fail('fixture.bootstrapScript does not match fixture.bootstrapScriptSha256');
  }

  // Resolve the family to a concrete image so the run records which stock base it used.
  const imageProject = STOCK_UBUNTU_IMAGE_PROJECT;
  const imageName = await resolveImageFromFamily(imageProject, stockUbuntuImageFamily(architecture));

  const session = await runScriptOnPrivateVm({
    projectId,
    zone,
    subnetwork,
    imageName,
    imageProject,
    script: bootstrapScript,
    fixtureId,
    role: 'bootstrap-acceptance',
    instancePrefix: 'pc-bootstrap-acc',
    ...(typeof input.machineType === 'string' && input.machineType.trim() !== ''
      ? { machineType: input.machineType.trim() }
      : {}),
    bootBudgetMs: BOOT_BUDGET_MS,
    scriptBudgetMs: BOOTSTRAP_BUDGET_MS,
  });

  // A leaked instance is an operational incident, not a footnote. The canary refuses to
  // report a clean run with residue and this half holds the identical bar, naming the exact
  // ids so they can be reclaimed by hand.
  if (session.residualResourceIds.length > 0) {
    fail('bootstrap acceptance could not tear down every resource it created', {
      residualResourceIds: session.residualResourceIds,
    });
  }

  return {
    stdout: session.stdout,
    instanceName: session.instanceName,
    imageName,
    imageProject,
    observedAt: session.observedAt,
    computeRunning: session.computeRunning,
    osLoginReady: session.osLoginReady,
    publicIpv4Assigned: session.publicIpv4Assigned,
    terminated: session.terminated,
    residualResourceIds: session.residualResourceIds,
    fixtureId,
    bootstrapScriptSha256: actualDigest,
  };
}

await main('papercusp-gcp-bootstrap-acceptance', bootstrapAcceptance);
