/**
 * HetznerDriver — the SECOND cloud DeploymentDriver (`cloud-deployment-layer-2026-06-06`
 * P-018). Cheap VM bulk; a different API shape from Latitude (see `hetzner-api.ts`),
 * which is the proof the `DeploymentDriver` seam is provider-agnostic, not
 * Latitude-shaped. `install`/`join` reuse the SAME provider-independent
 * `frame-installer` as Latitude — only `provision`/`teardown` are Hetzner-specific.
 */
import type {
  DeploymentConfig,
  DeploymentContext,
  DeploymentDriver,
  Frame,
} from '@papercusp/deployment-driver';
import {
  createHetznerApiClient,
  HetznerApiError,
  type HetznerApiClient,
  type HetznerServerAttributes,
} from './hetzner-api';
import { installFrame, joinFrame } from '../frame-installer';

const READY_STATUSES = new Set(['running', 'on', 'active']);
const FAILED_STATUSES = new Set(['error', 'deleting', 'unknown', 'off']);
const DEFAULT_IMAGE = 'ubuntu-22.04';

export interface HetznerDriverDeps {
  client?: HetznerApiClient;
  resolveApiToken?: (config: DeploymentConfig) => string | undefined;
  baseUrl?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** How long teardown keeps re-issuing DELETE + confirming before giving up (default 5 min). */
  teardownTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  makeRemoteExec?: import('../frame-installer').FrameInstallerDeps['makeRemoteExec'];
  onJoin?: import('../frame-installer').FrameInstallerDeps['onJoin'];
}

function defaultResolveApiToken(config: DeploymentConfig): string | undefined {
  const ref = config.credentialRef;
  if (ref) {
    const envName = ref.startsWith('env:') ? ref.slice(4) : ref;
    const v = process.env[envName];
    if (v) return v;
  }
  return process.env.HCLOUD_TOKEN ?? process.env.HETZNER_API_TOKEN;
}

/** Map a DeploymentConfig onto Hetzner create attributes (validated). */
export function toHetznerAttributes(config: DeploymentConfig, ctx: DeploymentContext): HetznerServerAttributes {
  const provider = (config.provider ?? {}) as Record<string, unknown>;
  const server_type = config.size?.trim() ?? (provider.serverType as string | undefined)?.trim();
  if (!server_type) {
    throw new Error(
      `HetznerDriver.provision: missing required field 'size' (the Hetzner server_type, e.g. 'cx22'). ` +
        `Provide { target:'hetzner', region:'nbg1', size:'cx22' }.`,
    );
  }
  return {
    name: (provider.name as string | undefined) ?? `papercusp-${ctx.harnessSlug}`,
    server_type,
    image: (provider.image as string | undefined) ?? DEFAULT_IMAGE,
    location: config.region?.trim() ?? (provider.location as string | undefined),
    ssh_keys: provider.sshKeys as Array<string | number> | undefined,
    user_data: provider.userData as string | undefined,
  };
}

export function makeHetznerDriver(deps: HetznerDriverDeps = {}): DeploymentDriver {
  const resolveApiToken = deps.resolveApiToken ?? defaultResolveApiToken;
  const pollIntervalMs = deps.pollIntervalMs ?? 5_000;
  const pollTimeoutMs = deps.pollTimeoutMs ?? 10 * 60_000;
  const teardownTimeoutMs = deps.teardownTimeoutMs ?? 5 * 60_000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const installerDeps = { makeRemoteExec: deps.makeRemoteExec, onJoin: deps.onJoin };

  function clientFor(config: DeploymentConfig): HetznerApiClient {
    if (deps.client) return deps.client;
    const apiToken = resolveApiToken(config);
    if (!apiToken) throw new Error('HetznerDriver: no API token. Set HCLOUD_TOKEN (or a credentialRef env).');
    return createHetznerApiClient({ apiToken, baseUrl: deps.baseUrl });
  }

  const log = (ctx: DeploymentContext, level: 'info' | 'warn' | 'error', msg: string) =>
    ctx.log?.(level, `[hetzner] ${msg}`);

  return {
    target: 'hetzner',
    placement: 'remote',

    async provision(config, ctx): Promise<Frame> {
      const client = clientFor(config);
      const attrs = toHetznerAttributes(config, ctx);
      log(ctx, 'info', `creating server (type=${attrs.server_type}, image=${attrs.image}, loc=${attrs.location ?? 'auto'})`);
      let server = await client.createServer(attrs);
      const deadline = Date.now() + pollTimeoutMs;
      while (!(READY_STATUSES.has(server.status) && server.ipv4)) {
        if (FAILED_STATUSES.has(server.status)) {
          throw new Error(`HetznerDriver.provision: server ${server.id} entered status '${server.status}'`);
        }
        if (ctx.signal?.aborted) throw new Error('HetznerDriver.provision: aborted');
        if (Date.now() >= deadline) {
          throw new Error(
            `HetznerDriver.provision: server ${server.id} not ready after ${Math.round(pollTimeoutMs / 1000)}s ` +
              `(last status '${server.status}', ip=${server.ipv4 ?? 'none'})`,
          );
        }
        await sleep(pollIntervalMs);
        server = await client.getServer(server.id);
      }
      log(ctx, 'info', `server ${server.id} ready at ${server.ipv4}`);
      return {
        id: server.id,
        target: 'hetzner',
        placement: 'remote',
        host: server.ipv4,
        kind: 'vm', // Hetzner Cloud is VMs
        region: config.region,
        meta: { serverType: attrs.server_type },
      };
    },

    install: (frame, config, ctx) => installFrame(frame, config, ctx, installerDeps),
    join: (frame, config, ctx) => joinFrame(frame, config, ctx, installerDeps),

    async teardown(frame, config, ctx): Promise<void> {
      const client = clientFor(config);
      log(ctx, 'info', `destroying server ${frame.id} (teardown = DESTROY → ends billing)`);

      // Same destroy-not-stuck class LatitudeDriver hit live (2026-06-06): a 2xx
      // DELETE is an *accepted action*, not a confirmed destroy. A destroy that
      // doesn't stick bills indefinitely — confirm the server is actually GONE
      // (getServer 404), re-issuing DELETE per round until the teardown deadline.
      // Hetzner nuance: delete is async (status 'deleting'), and a re-DELETE while
      // the action runs can 423-lock / 409-conflict — both mean "in progress".
      const isGone = async (): Promise<boolean> => {
        try {
          await client.getServer(frame.id);
          return false;
        } catch (e) {
          if (e instanceof HetznerApiError && (e.status === 404 || e.status === 410)) return true;
          throw e;
        }
      };

      const deadline = Date.now() + teardownTimeoutMs;
      for (let attempt = 1; ; attempt++) {
        try {
          await client.deleteServer(frame.id);
        } catch (e) {
          if (e instanceof HetznerApiError && (e.status === 404 || e.status === 410)) {
            // already gone — success
          } else if (e instanceof HetznerApiError && (e.status === 423 || e.status === 409)) {
            // locked/conflict — an action (likely the delete itself) is running; keep confirming
          } else {
            throw e;
          }
        }
        if (await isGone()) break;
        if (Date.now() >= deadline) {
          throw new Error(
            `HetznerDriver.teardown: server ${frame.id} still exists after ${attempt} DELETE attempt(s) ` +
              `over ${Math.round(teardownTimeoutMs / 1000)}s — it may still be BILLING; destroy it manually.`,
          );
        }
        log(ctx, 'warn', `server ${frame.id} still present after DELETE (attempt ${attempt}); re-confirming`);
        await sleep(pollIntervalMs);
      }
      log(ctx, 'info', `server ${frame.id} destroyed (confirmed gone)`);
    },
  };
}

export const HetznerDriver: DeploymentDriver = makeHetznerDriver();
