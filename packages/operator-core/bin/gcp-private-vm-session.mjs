/**
 * gcp-private-vm-session — boot ONE private GCP instance, run a script on it over IAP,
 * capture stdout, and tear the whole thing down leaving zero residue.
 *
 * This is the flow shared by the two workspace-host clean-room subjects, which are
 * deliberately NOT the same thing:
 *
 *   1. PRE-BUILD bootstrap acceptance (papercusp-gcp-bootstrap-acceptance) boots STOCK
 *      Ubuntu and runs the release fixture's bootstrap script on it, proving the SIGNED
 *      BUNDLE installs and self-attests on a pristine machine. Its attestation becomes the
 *      expected reference the release gate ratifies.
 *   2. POST-BUILD canary (papercusp-gcp-clean-room) boots the ALREADY-BUILT candidate image
 *      and proves that image boots privately and self-attests to the same release.
 *
 * The ordering is load-bearing and is why (1) cannot boot the candidate image: the gate that
 * authorizes building the image consumes (1)'s report, so the image does not exist yet.
 * `gcp-image-family.ts:validateCleanBootProof` then checks (2)'s attestation AGAINST (1)'s.
 *
 * WHY PRIVATE-ONLY: instances are created with --no-address and reached exclusively over
 * IAP. For the canary this is the very property the gate asserts; for the acceptance run it
 * keeps the two rigs identical so a bundle that only installs on a publicly-addressed box
 * cannot pass here and fail there.
 *
 * TRUST RULE: every value returned is OBSERVED — read back from the GCP API or from the
 * guest's own stdout. Nothing is reported because we intended it. In particular `terminated`
 * and `residualResourceIds` are computed from the teardown's real outcome, so a leaked VM
 * can never be reported as a clean run.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ResourceLedger, ephemeralSuffix, fail, gcloudJson, run, runOrThrow } from './gcp-ephemeral.mjs';
import {
  CLEAN_ROOM_NETWORK_TAG,
  assertCloudNatEgressReachable,
  assertIapSshReachable,
  buildCleanRoomInstanceCreateArgs,
} from './gcp-clean-room-args.mjs';

/** Stock Ubuntu 24.04 LTS, matching WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION ('24.04'). */
export const STOCK_UBUNTU_IMAGE_PROJECT = 'ubuntu-os-cloud';
export const STOCK_UBUNTU_IMAGE_FAMILY_BY_ARCHITECTURE = Object.freeze({
  x86_64: 'ubuntu-2404-lts-amd64',
  amd64: 'ubuntu-2404-lts-amd64',
  arm64: 'ubuntu-2404-lts-arm64',
  aarch64: 'ubuntu-2404-lts-arm64',
});

const DEFAULT_BOOT_BUDGET_MS = 12 * 60 * 1000;
const DEFAULT_SCRIPT_BUDGET_MS = 20 * 60 * 1000;

function requiredSessionText(value, path) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${path} must be a non-empty string`);
  return value.trim();
}

/** Pure argv builder for one command over the private IAP/OS-Login path. */
export function buildIapSshArgs({ projectId, instanceName, zone, command }) {
  return [
    'compute',
    'ssh',
    requiredSessionText(instanceName, 'instanceName'),
    `--project=${requiredSessionText(projectId, 'projectId')}`,
    `--zone=${requiredSessionText(zone, 'zone')}`,
    '--tunnel-through-iap',
    '--quiet',
    '--command',
    requiredSessionText(command, 'command'),
  ];
}

/** Pure argv builder for copying one controller-side file to a private VM. */
export function buildIapScpArgs({ projectId, instanceName, zone, sourcePath, remotePath }) {
  return [
    'compute',
    'scp',
    requiredSessionText(sourcePath, 'sourcePath'),
    `${requiredSessionText(instanceName, 'instanceName')}:${requiredSessionText(remotePath, 'remotePath')}`,
    `--project=${requiredSessionText(projectId, 'projectId')}`,
    `--zone=${requiredSessionText(zone, 'zone')}`,
    '--tunnel-through-iap',
    '--quiet',
  ];
}

/**
 * Pure argv builder for a controller-local registry reverse-forwarded onto the guest.
 * The remote bind stays on loopback, so this does not create a network-visible registry.
 */
export function buildIapReverseTunnelArgs({
  projectId,
  instanceName,
  zone,
  remotePort,
  localHost = '127.0.0.1',
  localPort = remotePort,
}) {
  const parsedRemotePort = Number(remotePort);
  const parsedLocalPort = Number(localPort);
  if (!Number.isInteger(parsedRemotePort) || parsedRemotePort < 1 || parsedRemotePort > 65535) {
    fail('remotePort must be an integer from 1 through 65535');
  }
  if (!Number.isInteger(parsedLocalPort) || parsedLocalPort < 1 || parsedLocalPort > 65535) {
    fail('localPort must be an integer from 1 through 65535');
  }
  const host = requiredSessionText(localHost, 'localHost');
  if (!/^(?:127(?:\.\d{1,3}){3}|localhost)$/.test(host)) {
    fail('localHost must be a controller loopback address');
  }
  return [
    'compute',
    'ssh',
    requiredSessionText(instanceName, 'instanceName'),
    `--project=${requiredSessionText(projectId, 'projectId')}`,
    `--zone=${requiredSessionText(zone, 'zone')}`,
    '--tunnel-through-iap',
    '--quiet',
    '--',
    '-N',
    '-R',
    `127.0.0.1:${parsedRemotePort}:${host}:${parsedLocalPort}`,
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
  ];
}

/** Fail with the tunnel's own diagnostic once a late SSH exit is observable. */
export function assertIapReverseTunnelRunning(status) {
  if (status?.exitCode === undefined) return;
  fail(`IAP reverse tunnel exited while it was required (exit ${status.exitCode})`, {
    stderr: typeof status.stderr === 'string' ? status.stderr : '',
  });
}

/**
 * Resolve an image FAMILY to the concrete image it currently points at.
 *
 * The family is resolved to an exact name before the instance is created so the run records
 * WHICH stock image it actually used. Passing `--image-family` straight to `instances create`
 * would work but leaves no record: families advance (ubuntu-os-cloud republishes roughly
 * monthly), so a later investigation into "why did acceptance pass then fail" could not tell
 * whether the base image moved underneath it.
 */
export async function resolveImageFromFamily(imageProject, imageFamily) {
  const image = await gcloudJson([
    'compute',
    'images',
    'describe-from-family',
    imageFamily,
    `--project=${imageProject}`,
  ]);
  if (!image || typeof image !== 'object' || typeof image.name !== 'string' || image.name.trim() === '') {
    fail(`image family ${imageProject}/${imageFamily} did not resolve to a concrete image`);
  }
  if (image.status !== 'READY') {
    fail(`image ${image.name} from family ${imageFamily} is not READY (status=${String(image.status)})`);
  }
  return image.name;
}

/** Map a contract architecture string to its stock Ubuntu family, refusing anything unknown. */
export function stockUbuntuImageFamily(architecture) {
  const key = String(architecture ?? '').trim().toLowerCase();
  const family = STOCK_UBUNTU_IMAGE_FAMILY_BY_ARCHITECTURE[key];
  if (!family) {
    fail(
      `no stock Ubuntu image family is known for architecture '${architecture}'; ` +
        `expected one of ${Object.keys(STOCK_UBUNTU_IMAGE_FAMILY_BY_ARCHITECTURE).join(', ')}`,
    );
  }
  return family;
}

/** Wait until the instance reports RUNNING, or throw. */
async function awaitRunning(projectId, instance, zone, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let lastStatus = 'UNKNOWN';
  while (Date.now() < deadline) {
    const described = await gcloudJson([
      'compute',
      'instances',
      'describe',
      instance,
      `--project=${projectId}`,
      `--zone=${zone}`,
    ]).catch(() => null);
    if (described?.status) {
      lastStatus = described.status;
      if (lastStatus === 'RUNNING') return described;
      if (lastStatus === 'TERMINATED' || lastStatus === 'SUSPENDED') {
        fail(`private instance entered ${lastStatus} before it could be exercised`);
      }
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  fail(`private instance did not reach RUNNING within ${budgetMs}ms (last status ${lastStatus})`);
}

/**
 * Read back whether GCP actually assigned a public IPv4. This is READ FROM THE API rather
 * than inferred from the --no-address flag we passed: the property is about what exists, not
 * about what we asked for.
 */
export function hasPublicIpv4(instance) {
  const interfaces = Array.isArray(instance?.networkInterfaces) ? instance.networkInterfaces : [];
  return interfaces.some((nic) =>
    (Array.isArray(nic?.accessConfigs) ? nic.accessConfigs : []).some(
      (config) => typeof config?.natIP === 'string' && config.natIP.trim() !== '',
    ),
  );
}

/** Poll IAP SSH until it answers, proving OS Login is usable over the private path. */
async function awaitOsLogin(projectId, instance, zone, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let lastError = 'not-attempted';
  while (Date.now() < deadline) {
    const probe = await run(
      'gcloud',
      [
        'compute',
        'ssh',
        instance,
        `--project=${projectId}`,
        `--zone=${zone}`,
        '--tunnel-through-iap',
        '--quiet',
        '--command',
        'echo papercusp-oslogin-ready',
      ],
      { timeoutMs: 3 * 60 * 1000 },
    ).catch((error) => ({ exitCode: -1, stdout: '', stderr: String(error?.message ?? error) }));

    if (probe.exitCode === 0 && probe.stdout.includes('papercusp-oslogin-ready')) return true;
    lastError = probe.stderr.slice(-300);
    await new Promise((r) => setTimeout(r, 15_000));
  }
  fail(`OS Login over IAP did not become ready within ${budgetMs}ms`, { lastError });
}

async function waitForDifferentBootId({ projectId, instanceName, zone, previousBootId, budgetMs }) {
  const deadline = Date.now() + budgetMs;
  let lastError = 'not-attempted';
  while (Date.now() < deadline) {
    const probe = await run(
      'gcloud',
      buildIapSshArgs({
        projectId,
        instanceName,
        zone,
        command: 'cat /proc/sys/kernel/random/boot_id',
      }),
      { timeoutMs: 2 * 60 * 1000 },
    ).catch((error) => ({ exitCode: -1, stdout: '', stderr: String(error?.message ?? error) }));
    const bootId = probe.stdout.trim();
    if (probe.exitCode === 0 && /^[0-9a-f-]{36}$/i.test(bootId) && bootId !== previousBootId) {
      return bootId;
    }
    lastError = probe.stderr.slice(-500) || `still on boot id ${bootId || '<unavailable>'}`;
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  fail(`private instance did not complete a new boot within ${budgetMs}ms`, { previousBootId, lastError });
}

/**
 * Verify, BEFORE any instance exists, that IAP SSH can actually reach the clean room.
 *
 * The run's only route to the guest is `gcloud compute ssh --tunnel-through-iap`, which
 * connects from Google's fixed IAP range. If no INGRESS rule on the subnet's network admits
 * that range on tcp:22 to our tag, the implied-deny drops the probe — but the instance still
 * boots and reports RUNNING, so the failure surfaces only as a full-budget `awaitOsLogin`
 * timeout whose message names OS Login and sends the reader to IAM. Two read-only API calls
 * here turn that 12-minute misdirection into an immediate refusal naming the exact repair
 * (EI-21749232930340104).
 *
 * Read-only and fail-CLOSED: an unreachable clean room is a real blocker, and booting anyway
 * to "see what happens" is what this replaces.
 */
export async function assertCleanRoomIapReachable(
  projectId,
  subnetwork,
  zone,
  { gcloudJsonFn = gcloudJson } = {},
) {
  const region = String(zone).replace(/-[a-z]$/, '');
  const subnet = await gcloudJsonFn([
    'compute',
    'networks',
    'subnets',
    'describe',
    subnetwork,
    `--project=${projectId}`,
    `--region=${region}`,
  ]);
  // The API returns the network as a full self-link; firewall rules are listed by name.
  const networkName = String(subnet?.network ?? '').split('/').pop();
  if (!networkName) fail(`could not resolve the network backing subnet '${subnetwork}' in ${region}`);

  const rules = await gcloudJsonFn([
    'compute',
    'firewall-rules',
    'list',
    `--project=${projectId}`,
    `--filter=network:${networkName}`,
  ]);

  try {
    assertIapSshReachable(Array.isArray(rules) ? rules : [], {
      networkName,
      projectId,
      tag: CLEAN_ROOM_NETWORK_TAG,
    });
  } catch (error) {
    fail(error.message);
  }

  // Cloud NAT is the guest's only egress route because the instance is deliberately created
  // with --no-address. Query routers first, then each router's NATs, before the ledger tracks
  // anything billable. The router response is annotated with its observed region so the pure
  // predicate cannot accidentally accept a same-named subnet served by another region.
  const routers = await gcloudJsonFn([
    'compute',
    'routers',
    'list',
    `--project=${projectId}`,
    `--regions=${region}`,
    `--filter=network:${networkName}`,
  ]);
  const matchingRouters = (Array.isArray(routers) ? routers : []).filter((router) => {
    const routerNetworkName = String(router?.network ?? '').split('/').pop();
    const routerRegion = String(router?.region ?? '').split('/').pop();
    return routerNetworkName === networkName && routerRegion === region && typeof router?.name === 'string';
  });
  const natCandidates = [];
  for (const router of matchingRouters) {
    const routerName = router.name.split('/').pop();
    const routerRegion = String(router.region).split('/').pop();
    const nats = await gcloudJsonFn([
      'compute',
      'routers',
      'nats',
      'list',
      `--router=${routerName}`,
      `--region=${routerRegion}`,
      `--project=${projectId}`,
    ]);
    for (const nat of Array.isArray(nats) ? nats : []) {
      natCandidates.push({ ...nat, routerRegion });
    }
  }

  try {
    assertCloudNatEgressReachable(natCandidates, {
      projectId,
      networkName,
      subnetwork,
      region,
    });
  } catch (error) {
    fail(error.message);
  }

  return { networkName };
}

/**
 * Open one private VM and keep it alive across a caller-driven lifecycle.
 *
 * This is the reusable form of the clean-room primitive. The existing single-script
 * helper below delegates to it, while update/rollback proofs can issue several commands
 * and cross real reboot boundaries without losing the resource ledger.
 */
export async function openPrivateVmSession({
  projectId,
  zone,
  subnetwork,
  imageName,
  imageProject,
  fixtureId,
  role = 'clean-room',
  instancePrefix = 'pc-cleanroom',
  machineType,
  bootBudgetMs = DEFAULT_BOOT_BUDGET_MS,
}) {
  const instanceName = `${requiredSessionText(instancePrefix, 'instancePrefix')}-${ephemeralSuffix()}`;
  const observedAt = new Date().toISOString();

  await assertCleanRoomIapReachable(projectId, subnetwork, zone);
  const ledger = new ResourceLedger(projectId);
  let closed = false;
  let computeRunning = false;
  let osLoginReady = false;
  let publicIpv4Assigned = false;

  try {
    // Track before the create call: a client-side timeout has an UNKNOWN provider outcome.
    // Deleting an absent generated name is harmless; failing to track a completed create leaks.
    ledger.track('instance', instanceName, zone);
    await runOrThrow(
      'gcloud',
      buildCleanRoomInstanceCreateArgs({
        instanceName,
        projectId,
        zone,
        imageName,
        imageProject,
        subnetwork,
        fixtureId,
        role,
        ...(machineType ? { machineType } : {}),
      }),
      { timeoutMs: 8 * 60 * 1000 },
    );

    const running = await awaitRunning(projectId, instanceName, zone, bootBudgetMs);
    computeRunning = running.status === 'RUNNING';
    publicIpv4Assigned = hasPublicIpv4(running);
    if (publicIpv4Assigned) {
      fail('private instance was assigned a public IPv4; the private-boot property does not hold');
    }
    osLoginReady = await awaitOsLogin(projectId, instanceName, zone, bootBudgetMs);
  } catch (error) {
    const residualResourceIds = await ledger.destroyAll();
    if (residualResourceIds.length > 0) {
      const details = error && typeof error === 'object' && error.details && typeof error.details === 'object'
        ? error.details
        : {};
      error.details = { ...details, residualResourceIds };
    }
    throw error;
  }

  const runRootCommand = async (command, { timeoutMs = DEFAULT_SCRIPT_BUDGET_MS } = {}) =>
    runOrThrow(
      'gcloud',
      buildIapSshArgs({
        projectId,
        instanceName,
        zone,
        command: `sudo bash -c ${JSON.stringify(requiredSessionText(command, 'command'))}`,
      }),
      { timeoutMs },
    );

  const runRootScript = async (
    script,
    { timeoutMs = DEFAULT_SCRIPT_BUDGET_MS, remotePath = `/tmp/papercusp-${ephemeralSuffix()}.sh` } = {},
  ) => {
    if (typeof script !== 'string' || script.trim() === '') fail('script must be a non-empty string');
    const scriptDir = await mkdtemp(join(tmpdir(), 'pc-private-vm-'));
    const scriptPath = join(scriptDir, 'script.sh');
    try {
      await writeFile(scriptPath, script, { mode: 0o700 });
      await runOrThrow(
        'gcloud',
        buildIapScpArgs({ projectId, instanceName, zone, sourcePath: scriptPath, remotePath }),
        { timeoutMs: 5 * 60 * 1000 },
      );
      return await runOrThrow(
        'gcloud',
        buildIapSshArgs({
          projectId,
          instanceName,
          zone,
          command: `sudo bash ${remotePath}`,
        }),
        { timeoutMs },
      );
    } finally {
      await run(
        'gcloud',
        buildIapSshArgs({
          projectId,
          instanceName,
          zone,
          command: `sudo rm -f -- ${remotePath}`,
        }),
        { timeoutMs: 60_000 },
      ).catch(() => null);
      await rm(scriptDir, { recursive: true, force: true }).catch(() => {});
    }
  };

  const rebootAndWait = async ({ budgetMs = bootBudgetMs } = {}) => {
    const previousBootId = (await runRootCommand('cat /proc/sys/kernel/random/boot_id', { timeoutMs: 60_000 })).trim();
    if (!/^[0-9a-f-]{36}$/i.test(previousBootId)) fail(`guest returned invalid boot id '${previousBootId}'`);
    const reboot = await run(
      'gcloud',
      buildIapSshArgs({
        projectId,
        instanceName,
        zone,
        command: "sudo systemctl reboot --message='Papercusp P-305 lifecycle proof'",
      }),
      { timeoutMs: 2 * 60 * 1000 },
    );
    // OpenSSH commonly returns 255 because sshd disappears during a successful reboot.
    if (reboot.exitCode !== 0 && reboot.exitCode !== 255) {
      fail(`guest reboot request failed with exit code ${reboot.exitCode}`, { stderr: reboot.stderr.slice(-1000) });
    }
    const bootId = await waitForDifferentBootId({ projectId, instanceName, zone, previousBootId, budgetMs });
    return { previousBootId, bootId };
  };

  const startReverseTunnel = async ({ remotePort, localHost = '127.0.0.1', localPort = remotePort } = {}) => {
    const args = buildIapReverseTunnelArgs({
      projectId,
      instanceName,
      zone,
      remotePort,
      localHost,
      localPort,
    });
    const child = spawn('gcloud', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let exitCode;
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    const closedPromise = new Promise((resolve) => {
      child.once('error', (error) => {
        stderr = `${stderr}\n${error.message}`.slice(-4000);
        exitCode = -1;
        resolve();
      });
      child.once('close', (code) => {
        exitCode = code ?? -1;
        resolve();
      });
    });
    await Promise.race([closedPromise, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (exitCode !== undefined) {
      fail(`IAP reverse tunnel exited before it became usable (exit ${exitCode})`, { stderr });
    }

    let stopped = false;
    return {
      pid: child.pid,
      async stop() {
        if (stopped) return;
        stopped = true;
        child.kill('SIGTERM');
        await Promise.race([closedPromise, new Promise((resolve) => setTimeout(resolve, 5_000))]);
        if (exitCode === undefined) {
          child.kill('SIGKILL');
          await closedPromise;
        }
      },
      status() {
        return { exitCode, stderr };
      },
    };
  };

  return {
    instanceName,
    observedAt,
    computeRunning,
    osLoginReady,
    publicIpv4Assigned,
    runRootCommand,
    runRootScript,
    rebootAndWait,
    startReverseTunnel,
    async close() {
      if (closed) return [];
      closed = true;
      return ledger.destroyAll();
    },
  };
}

/**
 * Create a private instance, run `script` on it as root over IAP, and tear it down.
 *
 * Teardown runs in a `finally`, so a failure anywhere above still destroys the instance —
 * a failed run must never leave a billable VM behind. The observed teardown outcome is
 * returned rather than assumed.
 */
export async function runScriptOnPrivateVm({
  projectId,
  zone,
  subnetwork,
  imageName,
  imageProject,
  script,
  fixtureId,
  role = 'clean-room',
  instancePrefix = 'pc-cleanroom',
  machineType,
  remotePath = '/tmp/papercusp-bootstrap.sh',
  bootBudgetMs = DEFAULT_BOOT_BUDGET_MS,
  scriptBudgetMs = DEFAULT_SCRIPT_BUDGET_MS,
}) {
  let session;
  let stdout;
  let residualResourceIds = [];
  try {
    session = await openPrivateVmSession({
      projectId,
      zone,
      subnetwork,
      imageName,
      imageProject,
      fixtureId,
      role,
      instancePrefix,
      machineType,
      bootBudgetMs,
    });
    stdout = await session.runRootScript(script, { timeoutMs: scriptBudgetMs, remotePath });
  } finally {
    // Teardown always runs, including on every failure path above.
    if (session) residualResourceIds = await session.close();
  }

  return {
    instanceName: session.instanceName,
    observedAt: session.observedAt,
    stdout,
    computeRunning: session.computeRunning,
    osLoginReady: session.osLoginReady,
    publicIpv4Assigned: session.publicIpv4Assigned,
    // Terminated is true only when teardown actually left nothing behind.
    terminated: residualResourceIds.length === 0,
    residualResourceIds,
  };
}
