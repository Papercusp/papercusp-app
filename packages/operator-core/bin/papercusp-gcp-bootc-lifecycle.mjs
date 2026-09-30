#!/usr/bin/env node
/**
 * papercusp-gcp-bootc-lifecycle — P-305 real-host proof for the signed RPM/bootc port.
 *
 * The runner imports one exact GCE artifact, boots it without a public address, reaches it
 * only through IAP, reverse-forwards the controller's loopback release registry, proves
 * correct-key acceptance plus wrong-key rejection, crosses a signed switch/reboot, crosses a
 * direct bootc rollback/reboot, and verifies identity/ACL plus /var persistence on all three
 * deployments. Every created cloud resource is removed in finally and residue fails the run.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';

import { fail, gcloudJson, main, run, runOrThrow } from './gcp-ephemeral.mjs';
import {
  P305_LIFECYCLE_SCHEMA_VERSION,
  buildP305PhaseProbeScript,
  buildP305RollbackScript,
  buildP305SwitchScript,
  normalizeP305LifecycleInput,
  parseP305HostPrepareDiagnostics,
  parseP305PhaseMarker,
} from './gcp-bootc-lifecycle-args.mjs';
import {
  assertCleanRoomIapReachable,
  assertIapReverseTunnelRunning,
  openPrivateVmSession,
} from './gcp-private-vm-session.mjs';

const REGISTRY_PORT = 5096;
const BOOT_BUDGET_MS = 15 * 60 * 1000;
const SWITCH_BUDGET_MS = 60 * 60 * 1000;
const PROBE_BUDGET_MS = 10 * 60 * 1000;
const OCI_MANIFEST_ACCEPT = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
].join(', ');

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function requireExactArtifact(path, expectedSha256) {
  const stat = await lstat(path).catch((error) => fail(`initial GCE artifact cannot be read: ${error.message}`));
  if (!stat.isFile() || stat.isSymbolicLink()) fail('initial GCE artifact must be a regular non-symlink file');
  const actualSha256 = await hashFile(path);
  if (actualSha256 !== expectedSha256) {
    fail('initial GCE artifact sha256 does not match the requested immutable input', {
      expectedSha256,
      actualSha256,
    });
  }
  return { bytes: stat.size, sha256: actualSha256 };
}

async function requireControllerRegistryReference(repository, expectedDigest) {
  const slash = repository.indexOf('/');
  if (slash < 1) fail('update repository does not contain a registry host and repository path');
  const registryHost = repository.slice(0, slash);
  const repositoryPath = repository.slice(slash + 1);
  const manifestUrl = `http://${registryHost}/v2/${repositoryPath}/manifests/${expectedDigest}`;
  let response;
  try {
    response = await fetch(manifestUrl, {
      method: 'HEAD',
      headers: { accept: OCI_MANIFEST_ACCEPT },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    fail(`controller release registry preflight failed: ${error.message}`);
  }
  if (!response.ok) {
    fail(`controller release registry does not contain the requested update digest (HTTP ${response.status})`);
  }
  const observedDigest = response.headers.get('docker-content-digest');
  if (observedDigest !== expectedDigest) {
    fail('controller release registry returned a different update digest', {
      expectedDigest,
      observedDigest,
    });
  }
  return { manifestUrl, digest: observedDigest };
}

async function waitForForwardedRegistry(session, updateImageReference, tunnel) {
  const quotedReference = JSON.stringify(`docker://${updateImageReference}`);
  let lastError = 'not-attempted';
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await session.runRootCommand(`skopeo inspect --tls-verify=false --format '{{.Digest}}' ${quotedReference}`, {
        timeoutMs: 2 * 60 * 1000,
      });
      return;
    } catch (error) {
      lastError = error.message;
      assertIapReverseTunnelRunning(tunnel.status());
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  fail('reverse-forwarded release registry did not become reachable from the guest', { lastError });
}

async function withRegistryTunnel(session, updateImageReference, action) {
  const tunnel = await session.startReverseTunnel({ remotePort: REGISTRY_PORT });
  try {
    await waitForForwardedRegistry(session, updateImageReference, tunnel);
    return await action();
  } finally {
    await tunnel.stop();
  }
}

async function deleteCloudResource(args, label) {
  const result = await run('gcloud', [...args, '--quiet'], { timeoutMs: 10 * 60 * 1000 }).catch((error) => ({
    exitCode: -1,
    stdout: '',
    stderr: error.message,
  }));
  if (result.exitCode === 0 || /was not found|notFound/i.test(result.stderr)) return null;
  return `${label}:${result.stderr.slice(-500)}`;
}

async function lifecycle(input) {
  const request = normalizeP305LifecycleInput(input);
  const artifact = await requireExactArtifact(request.initialGceTarPath, request.initialGceTarSha256);
  const controllerRegistry = await requireControllerRegistryReference(request.updateRepository, request.updateDigest);
  // The VM helper checks again before boot, but uploads and image imports are also
  // billable mutations. Reject missing IAP ingress or NAT before creating either.
  await assertCleanRoomIapReachable(request.projectId, request.subnetwork, request.zone);

  const suffix = randomBytes(4).toString('hex');
  const imageName = `p305-lifecycle-r21-${suffix}`;
  const objectUri = `${request.stagingBucket}/${imageName}.tar.gz`;
  const imageId = `projects/${request.projectId}/global/images/${imageName}`;
  const sentinelToken = createHash('sha256')
    .update(`${suffix}|${artifact.sha256}|${request.updateDigest}`, 'utf8')
    .digest('hex');

  const phases = [];
  const reboots = [];
  const residualResourceIds = [];
  let session;
  let objectUploaded = false;
  let imageCreated = false;
  let lifecycleError;

  try {
    // Read-only bucket preflight before the first provider mutation.
    // Set cleanup ownership before each mutation: a timeout is an unknown outcome, not proof
    // that the provider did nothing. Exact random names make delete-on-absence safe.
    objectUploaded = true;
    await runOrThrow(
      'gcloud',
      ['storage', 'buckets', 'describe', request.stagingBucket, `--project=${request.projectId}`],
      { timeoutMs: 2 * 60 * 1000 },
    );

    await runOrThrow(
      'gcloud',
      ['storage', 'cp', request.initialGceTarPath, objectUri, `--project=${request.projectId}`],
      { timeoutMs: 90 * 60 * 1000 },
    );
    imageCreated = true;
    await runOrThrow(
      'gcloud',
      ['compute', 'images', 'create', imageName, `--source-uri=${objectUri}`, `--project=${request.projectId}`],
      { timeoutMs: 30 * 60 * 1000 },
    );
    const imported = await gcloudJson(['compute', 'images', 'describe', imageName, `--project=${request.projectId}`]);
    if (imported?.status !== 'READY' || imported?.selfLink?.endsWith(`/images/${imageName}`) !== true) {
      fail(`imported image ${imageName} did not resolve READY with the expected immutable identity`);
    }

    session = await openPrivateVmSession({
      projectId: request.projectId,
      zone: request.zone,
      subnetwork: request.subnetwork,
      imageName,
      imageProject: request.projectId,
      fixtureId: `p305-${suffix}`,
      role: 'bootc-lifecycle',
      instancePrefix: 'p305-lifecycle',
      machineType: request.machineType,
      bootBudgetMs: BOOT_BUDGET_MS,
    });

    // Keep one remote-forward listener across the initial probe and the signed switch. Closing
    // and immediately reopening the same guest port races sshd's cancellation of the first
    // listener: the replacement SSH can exit 255 after startReverseTunnel's startup window,
    // leaving the reachability loop to report a misleading registry error. The initial probe
    // already proves this exact tunnel can serve the digest, so reuse it for the switch.
    const initialPhase = await withRegistryTunnel(session, request.updateImageReference, async () => {
      const initialStdout = await session.runRootScript(
        buildP305PhaseProbeScript({
          phase: 'initial',
          expectedVersion: request.expectedInitialVersion,
          updateImageReference: request.updateImageReference,
          sentinelToken,
        }),
        { timeoutMs: PROBE_BUDGET_MS },
      );
      const observedInitialPhase = parseP305PhaseMarker(initialStdout, 'initial');
      await session.runRootScript(buildP305SwitchScript(request.updateImageReference), {
        timeoutMs: SWITCH_BUDGET_MS,
      });
      return observedInitialPhase;
    });
    phases.push(initialPhase);
    reboots.push({ transition: 'signed-switch', ...(await session.rebootAndWait({ budgetMs: BOOT_BUDGET_MS })) });

    const updatedStdout = await session.runRootScript(
      buildP305PhaseProbeScript({
        phase: 'updated',
        expectedVersion: request.expectedUpdateVersion,
        updateImageReference: request.updateImageReference,
        sentinelToken,
      }),
      { timeoutMs: PROBE_BUDGET_MS },
    );
    phases.push(parseP305PhaseMarker(updatedStdout, 'updated'));

    await session.runRootScript(buildP305RollbackScript(), { timeoutMs: PROBE_BUDGET_MS });
    reboots.push({ transition: 'direct-rollback', ...(await session.rebootAndWait({ budgetMs: BOOT_BUDGET_MS })) });

    const rolledBackStdout = await session.runRootScript(
      buildP305PhaseProbeScript({
        phase: 'rolled-back',
        expectedVersion: request.expectedInitialVersion,
        updateImageReference: request.updateImageReference,
        sentinelToken,
      }),
      { timeoutMs: PROBE_BUDGET_MS },
    );
    phases.push(parseP305PhaseMarker(rolledBackStdout, 'rolled-back'));

    if (new Set(phases.map((phase) => phase.boot_id)).size !== 3) {
      fail('the lifecycle did not observe three distinct boot ids');
    }
    if (new Set(phases.map((phase) => phase.sentinel_sha256)).size !== 1) {
      fail('the retained /var sentinel changed across the lifecycle');
    }
  } catch (error) {
    lifecycleError = error;
  } finally {
    if (session) {
      const instanceResiduals = await session.close();
      residualResourceIds.push(...instanceResiduals);
    }
    if (imageCreated) {
      const imageResidual = await deleteCloudResource(
        ['compute', 'images', 'delete', imageName, `--project=${request.projectId}`],
        `image:${imageId}`,
      );
      if (imageResidual) residualResourceIds.push(imageResidual);
    }
    if (objectUploaded) {
      const objectResidual = await deleteCloudResource(
        ['storage', 'rm', objectUri, `--project=${request.projectId}`],
        `gcs-object:${objectUri}`,
      );
      if (objectResidual) residualResourceIds.push(objectResidual);
    }
  }

  if (lifecycleError) {
    const details = lifecycleError.details && typeof lifecycleError.details === 'object' ? lifecycleError.details : {};
    const hostPrepareDiagnostics = parseP305HostPrepareDiagnostics(details.stderr);
    lifecycleError.details = {
      ...details,
      ...(hostPrepareDiagnostics ? { hostPrepareDiagnostics } : {}),
      phases,
      reboots,
      residualResourceIds,
    };
    throw lifecycleError;
  }
  if (residualResourceIds.length > 0) {
    fail('P-305 lifecycle assertions passed but teardown left residual resources', { residualResourceIds });
  }

  const evidenceRef = `p305-gcp-bootc-lifecycle:${createHash('sha256')
    .update(JSON.stringify({ imageId, updateDigest: request.updateDigest, phases, reboots }), 'utf8')
    .digest('hex')}`;

  return {
    schemaVersion: P305_LIFECYCLE_SCHEMA_VERSION,
    evidenceRef,
    projectId: request.projectId,
    zone: request.zone,
    initialArtifact: { path: request.initialGceTarPath, ...artifact },
    initialImageId: imageId,
    controllerRegistry,
    updateImageReference: request.updateImageReference,
    updateDigest: request.updateDigest,
    privateIngressOnly: session.publicIpv4Assigned === false,
    computeRunning: session.computeRunning,
    osLoginReady: session.osLoginReady,
    phases,
    reboots,
    signatureControls: { correctKeyAccepted: true, wrongKeyRejected: true },
    retainedVarData: true,
    terminated: true,
    residualResourceIds,
    observedAt: new Date().toISOString(),
  };
}

await main('papercusp-gcp-bootc-lifecycle', lifecycle);
