/**
 * GcpDriver — the THIRD cloud `DeploymentDriver`, alongside Latitude and Hetzner.
 * Like Hetzner it is provision/teardown-only: `install`/`join` reuse the SAME
 * provider-independent `frame-installer`, which is what makes the seam worth
 * having.
 *
 * WHY (p2p-public-release-remaining-lanes-2026-07-16 D-086). P-508/P-205 — the
 * last engineering gate before the p2p public-release GO/NO-GO — needs two
 * SEPARATE public-IP machines. That was carried as rig-blocked, but the block was
 * a dead credential, not a missing capability: both on-disk Hetzner tokens return
 * HTTP 401, and a cred-gated leg that SKIPS looks exactly like one that never
 * existed. GCP is live for this workspace and the bench harness is
 * provisioner-agnostic (`p2p-perf-tier3/remote-peer.ts` has zero hetzner/hcloud
 * references; `sshPeerLauncher` consumes a plain `SshSlotSpec`). So the correct
 * fix is one more driver behind the existing seam.
 *
 * `DeploymentTarget` is deliberately an open string, so registering `'gcp'`
 * required no edit to `@papercusp/deployment-driver`.
 *
 * NOT A WORKSPACE HOST — read this before assuming a conflict.
 * EI-21127501437946732 rules that `WorkspaceHostProvider` is the separate durable
 * host surface and that the legacy `DeploymentDriver` must not be extended for
 * it. That ruling is about DURABLE hosts; it explicitly permits reuse for "open
 * targets". These frames are the opposite of durable: `provisionBenchFleet` takes
 * a `DeploymentDriver` by signature, and every frame it brings up is destroyed in
 * the run's `finally` (teardown = DELETE, confirmed gone, so no billing leak).
 * A durable GCP workspace host still belongs behind `WorkspaceHostProvider`.
 *
 * VOCABULARY. GCP's placement unit is a ZONE, so `config.region` is read as a
 * zone (`us-east1-b`); `provider.zone` overrides. `config.size` is the machine
 * type (`e2-standard-4`).
 *
 * NAT / HOLEPUNCH. This driver always attaches a ONE_TO_ONE_NAT external IP: the
 * requirement is two DISTINCT public IPs on separate machines. The NAT-like
 * inbound-drop that makes a holepunch meaningful is applied IN-GUEST by
 * `bench-bootstrap` (nftables), identically on every provider — so no
 * GCP-specific firewall rule is needed for the holepunch scenario to stay honest.
 */
import type {
  DeploymentConfig,
  DeploymentContext,
  DeploymentDriver,
  Frame,
} from '@papercusp/deployment-driver';
import {
  createGcpComputeApiClient,
  GcpApiError,
  toGcpInstanceName,
  type GcpComputeApiClient,
  type GcpInstanceAttributes,
} from './gcp-compute-api';
import { installFrame, joinFrame } from '../frame-installer';

const READY_STATUSES = new Set(['RUNNING']);
const FAILED_STATUSES = new Set(['TERMINATED', 'SUSPENDED', 'STOPPING', 'SUSPENDING']);
const DEFAULT_IMAGE = 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2204-lts';
const DEFAULT_MACHINE_TYPE = 'e2-standard-4';
/**
 * GCP images disable root SSH; the login user comes from the `ssh-keys` metadata
 * entry. `frame.meta.sshUser` is how `sshTargetForFrame` learns it (and switches
 * to sudo), so it must match the user half of the injected key.
 */
const DEFAULT_SSH_USER = 'papercusp';

export interface GcpDriverDeps {
  client?: GcpComputeApiClient;
  /** Resolve the GCP project id. Default: config.provider.projectId, else env. */
  resolveProjectId?: (config: DeploymentConfig) => string | undefined;
  /** Resolve a bearer token. Default: Application Default Credentials. */
  getAccessToken?: () => Promise<string>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** How long teardown keeps re-issuing DELETE + confirming before giving up (default 5 min). */
  teardownTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  makeRemoteExec?: import('../frame-installer').FrameInstallerDeps['makeRemoteExec'];
  onJoin?: import('../frame-installer').FrameInstallerDeps['onJoin'];
}

function defaultResolveProjectId(config: DeploymentConfig): string | undefined {
  const provider = (config.provider ?? {}) as Record<string, unknown>;
  const fromProvider = (provider.projectId as string | undefined)?.trim();
  if (fromProvider) return fromProvider;
  const ref = config.credentialRef;
  if (ref) {
    const envName = ref.startsWith('env:') ? ref.slice(4) : ref;
    const v = process.env[envName];
    if (v) return v;
  }
  return (
    process.env.GCP_PROJECT_ID ??
    process.env.GOOGLE_CLOUD_PROJECT ??
    process.env.CLOUDSDK_CORE_PROJECT
  );
}

/**
 * ADC token. Imported lazily so a process that never provisions on GCP does not
 * pay for google-auth-library, and so unit tests can inject `getAccessToken`
 * without any credential being present.
 */
async function defaultGetAccessToken(): Promise<string> {
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  const value = typeof token === 'string' ? token : token?.token;
  if (!value) throw new Error('GcpDriver: Application Default Credentials returned no access token.');
  return value;
}

/** Map a DeploymentConfig onto GCP instance-create attributes (validated). */
export function toGcpInstanceAttributes(
  config: DeploymentConfig,
  ctx: DeploymentContext,
): GcpInstanceAttributes {
  const provider = (config.provider ?? {}) as Record<string, unknown>;
  const zone = ((provider.zone as string | undefined) ?? config.region)?.trim();
  if (!zone) {
    throw new Error(
      `GcpDriver.provision: missing required field 'region' (a GCP ZONE, e.g. 'us-east1-b'). ` +
        `Provide { target:'gcp', region:'us-east1-b', size:'e2-standard-4' }.`,
    );
  }
  const machineType =
    config.size?.trim() ?? (provider.machineType as string | undefined)?.trim() ?? DEFAULT_MACHINE_TYPE;
  const sshUser = (provider.sshUser as string | undefined)?.trim() || DEFAULT_SSH_USER;
  const publicKey = (provider.sshPublicKey as string | undefined)?.trim();

  return {
    name: toGcpInstanceName((provider.name as string | undefined) ?? `papercusp-${ctx.harnessSlug}`),
    zone,
    machineType,
    sourceImage: (provider.image as string | undefined) ?? DEFAULT_IMAGE,
    bootDiskGb: provider.bootDiskGb as number | undefined,
    // GCP takes the public key INLINE in metadata; there is no key-id indirection
    // like Hetzner's ssh_keys. Absent ⇒ no key injected and the frame is
    // unreachable, so provision() refuses rather than leaving a billing orphan.
    sshKeys: publicKey ? `${sshUser}:${publicKey}` : undefined,
    tags: provider.tags as string[] | undefined,
    network: provider.network as string | undefined,
  };
}

export function makeGcpDriver(deps: GcpDriverDeps = {}): DeploymentDriver {
  const resolveProjectId = deps.resolveProjectId ?? defaultResolveProjectId;
  const pollIntervalMs = deps.pollIntervalMs ?? 5_000;
  const pollTimeoutMs = deps.pollTimeoutMs ?? 10 * 60_000;
  const teardownTimeoutMs = deps.teardownTimeoutMs ?? 5 * 60_000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const installerDeps = { makeRemoteExec: deps.makeRemoteExec, onJoin: deps.onJoin };

  function clientFor(config: DeploymentConfig): GcpComputeApiClient {
    if (deps.client) return deps.client;
    const projectId = resolveProjectId(config);
    if (!projectId) {
      throw new Error(
        'GcpDriver: no project id. Set provider.projectId (or GCP_PROJECT_ID / GOOGLE_CLOUD_PROJECT).',
      );
    }
    return createGcpComputeApiClient({
      projectId,
      getAccessToken: deps.getAccessToken ?? defaultGetAccessToken,
      baseUrl: deps.baseUrl,
      fetchImpl: deps.fetchImpl,
      sleep,
    });
  }

  const log = (ctx: DeploymentContext, level: 'info' | 'warn' | 'error', msg: string) =>
    ctx.log?.(level, `[gcp] ${msg}`);

  return {
    target: 'gcp',
    placement: 'remote',

    async provision(config, ctx): Promise<Frame> {
      const client = clientFor(config);
      const attrs = toGcpInstanceAttributes(config, ctx);
      const provider = (config.provider ?? {}) as Record<string, unknown>;
      const sshUser = (provider.sshUser as string | undefined)?.trim() || DEFAULT_SSH_USER;
      if (!attrs.sshKeys) {
        // Fail BEFORE the create call. A keyless instance boots, bills, and is
        // unreachable — the worst of the three outcomes.
        throw new Error(
          `GcpDriver.provision: no SSH public key. Set provider.sshPublicKey (the contents of the ` +
            `.pub matching provider.sshIdentityFile) — GCP has no key-id indirection, the key is ` +
            `injected inline via metadata.`,
        );
      }
      log(
        ctx,
        'info',
        `creating instance ${attrs.name} (type=${attrs.machineType}, image=${attrs.sourceImage}, zone=${attrs.zone})`,
      );
      let instance = await client.createInstance(attrs);
      const deadline = Date.now() + pollTimeoutMs;
      while (!(READY_STATUSES.has(instance.status) && instance.ipv4)) {
        if (FAILED_STATUSES.has(instance.status)) {
          throw new Error(`GcpDriver.provision: instance ${attrs.name} entered status '${instance.status}'`);
        }
        if (ctx.signal?.aborted) throw new Error('GcpDriver.provision: aborted');
        if (Date.now() >= deadline) {
          throw new Error(
            `GcpDriver.provision: instance ${attrs.name} not ready after ${Math.round(pollTimeoutMs / 1000)}s ` +
              `(last status '${instance.status}', ip=${instance.ipv4 ?? 'none'})`,
          );
        }
        await sleep(pollIntervalMs);
        instance = await client.getInstance(attrs.zone, attrs.name);
      }
      log(ctx, 'info', `instance ${attrs.name} ready at ${instance.ipv4}`);
      return {
        id: attrs.name, // NAME, not numeric id: every zonal API call addresses by name.
        target: 'gcp',
        placement: 'remote',
        host: instance.ipv4,
        kind: 'vm',
        region: attrs.zone,
        // sshUser is what sshTargetForFrame reads to pick the login (and to turn
        // sudo on) — GCP images disable root.
        meta: { machineType: attrs.machineType, zone: attrs.zone, sshUser, instanceId: instance.id },
      };
    },

    install: (frame, config, ctx) => installFrame(frame, config, ctx, installerDeps),
    join: (frame, config, ctx) => joinFrame(frame, config, ctx, installerDeps),

    async teardown(frame, config, ctx): Promise<void> {
      const client = clientFor(config);
      const zone = (frame.meta?.zone as string | undefined) ?? frame.region;
      if (!zone) {
        throw new Error(
          `GcpDriver.teardown: frame ${frame.id} has no zone (meta.zone/region) — cannot address the instance; ` +
            `it may still be BILLING. Destroy it manually.`,
        );
      }
      log(ctx, 'info', `destroying instance ${frame.id} in ${zone} (teardown = DESTROY → ends billing)`);

      // Same destroy-not-stuck discipline as LatitudeDriver/HetznerDriver: a 2xx
      // DELETE is an ACCEPTED action, not a confirmed destroy, and a destroy that
      // does not stick bills indefinitely. Confirm the instance is actually GONE
      // (getInstance 404), re-issuing DELETE per round until the deadline.
      const isGone = async (): Promise<boolean> => {
        try {
          await client.getInstance(zone, frame.id);
          return false;
        } catch (e) {
          if (e instanceof GcpApiError && (e.status === 404 || e.status === 410)) return true;
          throw e;
        }
      };

      const deadline = Date.now() + teardownTimeoutMs;
      for (let attempt = 1; ; attempt++) {
        try {
          await client.deleteInstance(zone, frame.id);
        } catch (e) {
          if (e instanceof GcpApiError && (e.status === 404 || e.status === 410)) {
            // already gone — success
          } else if (e instanceof GcpApiError && (e.status === 409 || e.status === 412)) {
            // conflict / precondition — an operation is already running; keep confirming
          } else {
            throw e;
          }
        }
        if (await isGone()) break;
        if (Date.now() >= deadline) {
          throw new Error(
            `GcpDriver.teardown: instance ${frame.id} still exists after ${attempt} DELETE attempt(s) ` +
              `over ${Math.round(teardownTimeoutMs / 1000)}s — it may still be BILLING; destroy it manually.`,
          );
        }
        log(ctx, 'warn', `instance ${frame.id} still present after DELETE (attempt ${attempt}); re-confirming`);
        await sleep(pollIntervalMs);
      }
      log(ctx, 'info', `instance ${frame.id} destroyed (confirmed gone)`);
    },
  };
}

export const GcpDriver: DeploymentDriver = makeGcpDriver();
