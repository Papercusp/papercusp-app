/**
 * LatitudeDriver — the first cloud DeploymentDriver (`cloud-deployment-layer-2026-06-06`
 * P-009 / D-002 / D-003). Implements the provider-agnostic `DeploymentDriver`
 * contract from `@papercusp/deployment-driver` against the Latitude.sh REST API.
 *
 * - `provision` — `POST /servers` then poll `GET /servers/{id}` until the frame is
 *   reachable (status ready + an IPv4 assigned); returns a `Frame`.
 * - `teardown` — `DELETE /servers/{id}` (DESTROY, not stop — ends billing, P-012).
 * - `install` / `join` — delegated to the PROVIDER-AGNOSTIC `frame-installer`
 *   (shared with every driver): bootstrap the frame to run its OWN orchestrator
 *   loop + OWN embedded-pg (D-006/D-007) then admit it as a headless peer.
 *
 * The API client + `sleep` are injectable so provision/teardown are fully
 * unit-testable with a mocked HTTP layer — no live Latitude account required.
 */
import type {
  DeploymentConfig,
  DeploymentContext,
  DeploymentDriver,
  Frame,
} from '@papercusp/deployment-driver';
import {
  createLatitudeApiClient,
  LatitudeApiError,
  pickInStockSite,
  type LatitudeApiClient,
  type LatitudeServerAttributes,
} from './latitude-api';
import { installFrame, joinFrame } from '../frame-installer';
import type { RemoteExec } from '../remote-exec';

/** Latitude statuses that mean the frame is up and usable. */
const READY_STATUSES = new Set(['on', 'active', 'ready', 'running']);
/** Latitude statuses that mean provisioning failed (stop polling, throw). */
const FAILED_STATUSES = new Set(['failed', 'error', 'deleted']);

/** VM statuses (capitalized in the VM API — live-verified 2026-06-06). */
const VM_READY = new Set(['Running']);
const VM_FAILED = new Set(['Destroying', 'Failed', 'Error']);
/** SSH lands on `ubuntu` on the default VM image (root login disabled). */
const VM_DEFAULT_SSH_USER = 'ubuntu';
const DEFAULT_VM_PLAN = 'vm.small';

const DEFAULT_OS = 'ubuntu_22_04_x64_lts';
/**
 * VM creates MUST carry an explicit OS now: as of 2026-06-12 the API accepts
 * an OS-less VM create and yields a Running-but-empty machine (no image, no
 * ssh — found live by WI-101's bench fleet; the 06-06 verification predated
 * the change). The metal default above is NOT vm-compatible ("is not
 * compatible with this plan"); per `/plans/operating_systems` provisionable_on,
 * Ubuntu 24.04 is the plain image provisionable on the vm.* family.
 */
const DEFAULT_VM_OS = 'ubuntu_24_04_x64_lts';

export interface LatitudeDriverDeps {
  /** Injected client (tests). Default: built per-call from the resolved API key. */
  client?: LatitudeApiClient;
  /** Resolve the API key for a config. Default: `credentialRef` env name, else LATITUDE_API_KEY. */
  resolveApiKey?: (config: DeploymentConfig) => string | undefined;
  baseUrl?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** How long teardown keeps re-issuing DELETE + confirming before giving up (default 5 min). */
  teardownTimeoutMs?: number;
  /** Injected for tests so polling doesn't actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Build the RemoteExec for a frame (install/credential staging). Injected for tests. */
  makeRemoteExec?: (frame: Frame, config: DeploymentConfig) => RemoteExec;
  /** Optional join hook (P-014/P-015 admission). Default: a log no-op — the frame
   *  federates via its own boot announce; explicit admission lands with P-015. */
  onJoin?: (frame: Frame, config: DeploymentConfig, ctx: DeploymentContext) => Promise<void>;
}

function defaultResolveApiKey(config: DeploymentConfig): string | undefined {
  // `credentialRef` may name an env var (`env:MY_KEY` or `MY_KEY`); default to the
  // documented LATITUDE_API_KEY. The secret itself never lives in the config.
  const ref = config.credentialRef;
  if (ref) {
    const envName = ref.startsWith('env:') ? ref.slice(4) : ref;
    const v = process.env[envName];
    if (v) return v;
  }
  return process.env.LATITUDE_API_KEY;
}

/** Map a DeploymentConfig onto Latitude `POST /servers` attributes (validated). */
export function toLatitudeAttributes(config: DeploymentConfig, ctx: DeploymentContext): LatitudeServerAttributes {
  const provider = (config.provider ?? {}) as Record<string, unknown>;
  const project = (provider.project as string | undefined)?.trim();
  // `size` IS the Latitude plan slug (VM vs bare metal is the plan's nature).
  const plan = config.size?.trim() ?? (provider.plan as string | undefined)?.trim();
  const site = config.region?.trim() ?? (provider.site as string | undefined)?.trim();
  const missing = [
    !project && 'provider.project',
    !plan && 'size (the Latitude plan slug)',
    !site && 'region (the Latitude site code)',
  ].filter(Boolean) as string[];
  if (missing.length) {
    throw new Error(
      `LatitudeDriver.provision: deployment config is missing required field(s): ${missing.join(', ')}. ` +
        `Provide e.g. { target:'latitude', region:'NYC', size:'m4-metal-small', provider:{ project:'<id>' } }.`,
    );
  }
  return {
    project: project!,
    plan: plan!,
    site: site!,
    operating_system: (provider.operatingSystem as string | undefined) ?? DEFAULT_OS,
    hostname: (provider.hostname as string | undefined) ?? `papercusp-${ctx.harnessSlug}`,
    ssh_keys: provider.sshKeys as string[] | undefined,
    user_data: provider.userData as string | undefined,
    // Hourly so a destroy-on-teardown frame only bills while it's actually running.
    billing: (provider.billing as LatitudeServerAttributes['billing']) ?? 'hourly',
  };
}

export function makeLatitudeDriver(deps: LatitudeDriverDeps = {}): DeploymentDriver {
  const resolveApiKey = deps.resolveApiKey ?? defaultResolveApiKey;
  const pollIntervalMs = deps.pollIntervalMs ?? 10_000;
  const pollTimeoutMs = deps.pollTimeoutMs ?? 15 * 60_000;
  const teardownTimeoutMs = deps.teardownTimeoutMs ?? 5 * 60_000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const installerDeps = { makeRemoteExec: deps.makeRemoteExec, onJoin: deps.onJoin };

  function clientFor(config: DeploymentConfig): LatitudeApiClient {
    if (deps.client) return deps.client;
    const apiKey = resolveApiKey(config);
    if (!apiKey) {
      throw new Error(
        `LatitudeDriver: no API key. Set LATITUDE_API_KEY (or a credentialRef env) so the driver can ` +
          `call the Latitude.sh API.`,
      );
    }
    return createLatitudeApiClient({ apiKey, baseUrl: deps.baseUrl });
  }

  const log = (ctx: DeploymentContext, level: 'info' | 'warn' | 'error', msg: string) =>
    ctx.log?.(level, `[latitude] ${msg}`);

  return {
    target: 'latitude',
    placement: 'remote',

    async provision(config, ctx): Promise<Frame> {
      const client = clientFor(config);

      // ── VM path (kind:'vm') — POST /virtual_machines. Live-verified 2026-06-06:
      // Running in ~16s (vs a 15-25 min metal reimage), key injected for `ubuntu`,
      // passwordless sudo. The default cloud target; metal is for KVM-needing work.
      if (config.kind === 'vm') {
        const provider = (config.provider ?? {}) as Record<string, unknown>;
        const planRef = config.size?.trim() || (provider.plan as string | undefined)?.trim() || DEFAULT_VM_PLAN;
        // Create wants the plan ID — a human name ('vm.small') 404s. Resolve names.
        let planId = planRef;
        if (!planRef.startsWith('plan_')) {
          const plans = await client.listVmPlans();
          const match = plans.find((p) => p.name === planRef);
          if (!match) {
            throw new Error(
              `LatitudeDriver.provision: unknown VM plan '${planRef}'. Known: ${plans.map((p) => p.name).join(', ')}`,
            );
          }
          planId = match.id;
        }
        const project = (provider.project as string | undefined)?.trim();
        if (!project) throw new Error('LatitudeDriver.provision: deployment config is missing provider.project');
        log(ctx, 'info', `creating VM (plan=${planRef}, project=${project})`);
        const created = await client.createVm({
          name: (provider.hostname as string | undefined) ?? `papercusp-${ctx.harnessSlug}`,
          plan: planId,
          project,
          // VM creates honor `site` (verified live 2026-06-12) — without it the
          // API places the VM wherever it likes (an ASH request landed in DAL),
          // which silently breaks co-located fleet runs.
          ...(config.region ? { site: config.region } : {}),
          ssh_keys: provider.sshKeys as string[] | undefined,
          operating_system: (provider.operatingSystem as string | undefined) ?? DEFAULT_VM_OS,
        });
        log(ctx, 'info', `vm ${created.id} created (status=${created.status}); waiting for Running`);
        const deadline = Date.now() + pollTimeoutMs;
        let vm = await client.getVm(created.id); // never trust the create echo
        while (!(VM_READY.has(vm.status) && vm.primary_ipv4)) {
          if (VM_FAILED.has(vm.status)) {
            throw new Error(`LatitudeDriver.provision: vm ${vm.id} entered status '${vm.status}'`);
          }
          if (ctx.signal?.aborted) throw new Error('LatitudeDriver.provision: aborted');
          if (Date.now() >= deadline) {
            throw new Error(
              `LatitudeDriver.provision: vm ${vm.id} not Running after ${Math.round(pollTimeoutMs / 1000)}s ` +
                `(last status '${vm.status}', ip=${vm.primary_ipv4 ?? 'none'})`,
            );
          }
          await sleep(pollIntervalMs);
          vm = await client.getVm(vm.id);
        }
        log(ctx, 'info', `vm ${vm.id} Running at ${vm.primary_ipv4} (ssh user: ${vm.sshUser ?? VM_DEFAULT_SSH_USER})`);
        return {
          id: vm.id,
          target: 'latitude',
          placement: 'remote',
          host: vm.primary_ipv4,
          kind: 'vm',
          region: config.region,
          meta: { planId, sshUser: vm.sshUser ?? VM_DEFAULT_SSH_USER },
        };
      }

      let attrs = toLatitudeAttributes(config, ctx);
      log(ctx, 'info', `creating server (plan=${attrs.plan}, site=${attrs.site}, os=${attrs.operating_system})`);

      let created;
      try {
        created = await client.createServer(attrs);
      } catch (e) {
        // Latitude stock is VOLATILE per site (observed live 2026-06-06: a smoke
        // run consumed a site's last unit and the next create 422'd). The config
        // region is a *preference*, not a pin — on SERVERS_OUT_OF_STOCK re-pick an
        // in-stock site for the plan and retry once. Pin with provider.strictRegion.
        const provider = (config.provider ?? {}) as Record<string, unknown>;
        const outOfStock =
          e instanceof LatitudeApiError &&
          e.status === 422 &&
          JSON.stringify(e.body ?? '').includes('SERVERS_OUT_OF_STOCK');
        if (!outOfStock || provider.strictRegion === true) throw e;
        const site = pickInStockSite(await client.listPlans(), attrs.plan, [attrs.site]);
        if (!site || site === attrs.site) throw e;
        log(ctx, 'warn', `site ${attrs.site} out of stock for ${attrs.plan}; retrying at in-stock site ${site}`);
        attrs = { ...attrs, site };
        created = await client.createServer(attrs);
      }
      log(ctx, 'info', `server ${created.id} created (status=${created.status}); waiting for it to come up`);

      // Poll until ready (IP assigned + status ready), or fail/timeout. NEVER trust
      // the create echo's status — observed live 2026-06-06: the echo claimed 'on'
      // while a fresh GET 30s later said 'deploying' for ~7 min (the OS reimage),
      // then 'on' for real. Readiness comes only from fresh getServer polls.
      const deadline = Date.now() + pollTimeoutMs;
      let server = await client.getServer(created.id);
      while (!(READY_STATUSES.has(server.status) && server.primary_ipv4)) {
        if (FAILED_STATUSES.has(server.status)) {
          throw new Error(`LatitudeDriver.provision: server ${server.id} entered status '${server.status}'`);
        }
        if (ctx.signal?.aborted) throw new Error('LatitudeDriver.provision: aborted');
        if (Date.now() >= deadline) {
          throw new Error(
            `LatitudeDriver.provision: server ${server.id} not ready after ${Math.round(pollTimeoutMs / 1000)}s ` +
              `(last status '${server.status}', ip=${server.primary_ipv4 ?? 'none'})`,
          );
        }
        await sleep(pollIntervalMs);
        server = await client.getServer(server.id);
      }

      log(ctx, 'info', `server ${server.id} ready at ${server.primary_ipv4}`);
      return {
        id: server.id,
        target: 'latitude',
        placement: 'remote',
        host: server.primary_ipv4,
        kind: config.kind === 'metal' ? 'metal' : 'vm',
        // The ACTUAL site (may differ from config.region after a stock fallback).
        region: attrs.site,
        meta: { planSlug: server.planSlug, ipv6: server.primary_ipv6, hostname: server.hostname },
      };
    },

    // install + join are provider-agnostic — delegated to the shared frame-installer.
    install: (frame, config, ctx) => installFrame(frame, config, ctx, installerDeps),
    join: (frame, config, ctx) => joinFrame(frame, config, ctx, installerDeps),

    async teardown(frame, config, ctx): Promise<void> {
      const client = clientFor(config);

      // ── VM teardown (id prefix is the reliable discriminator). Same confirm-gone
      // discipline as metal; 'Destroying' is the in-flight state, 404 is gone.
      if (frame.id.startsWith('vm_')) {
        log(ctx, 'info', `destroying vm ${frame.id} (teardown = DESTROY → ends billing)`);
        const isGone = async (): Promise<boolean> => {
          try {
            await client.getVm(frame.id);
            return false;
          } catch (e) {
            if (e instanceof LatitudeApiError && (e.status === 404 || e.status === 410)) return true;
            throw e;
          }
        };
        const vmDeadline = Date.now() + teardownTimeoutMs;
        for (let attempt = 1; ; attempt++) {
          try {
            await client.deleteVm(frame.id);
          } catch (e) {
            if (!(e instanceof LatitudeApiError && (e.status === 404 || e.status === 410))) throw e;
          }
          if (await isGone()) break;
          if (Date.now() >= vmDeadline) {
            throw new Error(
              `LatitudeDriver.teardown: vm ${frame.id} still exists after ${attempt} DELETE attempt(s) ` +
                `over ${Math.round(teardownTimeoutMs / 1000)}s — it may still be BILLING; destroy it manually.`,
            );
          }
          log(ctx, 'warn', `vm ${frame.id} still present after DELETE (attempt ${attempt}); re-confirming`);
          await sleep(pollIntervalMs);
        }
        log(ctx, 'info', `vm ${frame.id} destroyed (confirmed gone)`);
        return;
      }

      log(ctx, 'info', `destroying server ${frame.id} (teardown = DESTROY → ends billing)`);

      // Latitude can ACCEPT a DELETE (204) against an in-flight deploy without
      // applying it — observed live 2026-06-06: DELETE→204 while 'deploying',
      // server persisted; a later DELETE took. A destroy that doesn't stick
      // bills indefinitely, so confirm the server is actually GONE, re-issuing
      // the DELETE each round until it is (or the teardown deadline passes).
      const isGone = async (): Promise<boolean> => {
        try {
          const s = await client.getServer(frame.id);
          return s.status === 'deleted';
        } catch (e) {
          if (e instanceof LatitudeApiError && (e.status === 404 || e.status === 410)) return true;
          throw e;
        }
      };

      const deadline = Date.now() + teardownTimeoutMs;
      for (let attempt = 1; ; attempt++) {
        try {
          await client.deleteServer(frame.id);
        } catch (e) {
          // DELETE on an already-gone server 404s — that's success.
          if (!(e instanceof LatitudeApiError && (e.status === 404 || e.status === 410))) throw e;
        }
        if (await isGone()) break;
        if (Date.now() >= deadline) {
          throw new Error(
            `LatitudeDriver.teardown: server ${frame.id} still exists after ${attempt} DELETE attempt(s) ` +
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

/** The default LatitudeDriver (resolves its API key + client per call). */
export const LatitudeDriver: DeploymentDriver = makeLatitudeDriver();
