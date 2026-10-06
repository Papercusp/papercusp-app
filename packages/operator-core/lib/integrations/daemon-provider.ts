/**
 * Sandboxed `daemon` providers (plan generalized-integrations…-2026-10-05
 * P-002, D-006).
 *
 * A third-party provider runs as a subprocess under the plugin-loader
 * supervisor's fixed `provider` sandbox profile: no network namespace of its
 * own, no host filesystem beyond the system dirs, its runtime and its own
 * read-only plugin dir, and a scrubbed environment. It reaches the outside
 * world ONLY through a daemon→host `host.fetch` request, which this module
 * serves by forwarding to the CALLER's `ProviderHost.fetch` — the same
 * host-mediated fetch (`createHostFetch`) a `js` provider gets, so egress
 * allowlisting and per-source token injection are enforced in one place and
 * the daemon never sees a credential.
 *
 * Per-call scope: every `syncPage` / `invoke` mints a random `callToken`
 * bound to that call's `source`. A `host.fetch` is refused unless it carries a
 * live token AND names the bound source, so a daemon serving account A can
 * never act for account B of the same provider, and nothing it does between
 * calls can reach the network at all.
 *
 * Fail-closed: the supervisor refuses to spawn when the sandbox cannot be
 * established, and a call made without a host `fetch` is refused before the
 * daemon is contacted.
 */

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  PROVIDER_DAEMON_METHODS,
  validateProviderDescriptor,
  type HostFetchRequest,
  type ProviderAdapter,
  type ProviderDaemonCallParams,
  type ProviderDescriptor,
  type ProviderHost,
  type ProviderInvokeRequest,
  type ProviderSyncPage,
  type ProviderSyncRequest,
} from '@papercusp/plugin-sdk';
import type { StartDaemonOptions } from '@papercusp/plugin-loader/daemon';
import { pinModuleState } from '@papercusp/module-singleton';
import { HostFetchError } from './host-fetch';

export type DaemonProviderErrorCode =
  | 'host-fetch-unavailable'
  | 'descriptor-invalid'
  | 'descriptor-mismatch';

export class DaemonProviderError extends Error {
  constructor(
    readonly code: DaemonProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DaemonProviderError';
  }
}

/** JSON-RPC error codes the host replies to a refused daemon `host.fetch`. */
export const DAEMON_HOST_FETCH_ERRORS = {
  invalidParams: -32602,
  callTokenInvalid: -32001,
  sourceNotBound: -32002,
  hostFetchRefused: -32003,
} as const;

/** The slice of the supervisor handle this adapter drives. */
export interface ProviderDaemonHandle {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  shutdown(): Promise<void>;
  pid(): number | undefined;
}

export interface StartDaemonProviderOptions {
  pluginName: string;
  /** Plugin directory (bound read-only, used as cwd). */
  pluginDir: string;
  /** Daemon argv; binary first. */
  cmd: string[];
  /** Manifest-declared descriptor; the daemon's `describe` must report the same id. */
  declared?: ProviderDescriptor;
  /** Interpreter prefixes to bind. Default: this host's own node install prefix. */
  runtimeDirs?: string[];
  bwrapBinary?: string;
  onLog?: (line: string) => void;
  callTimeoutMs?: number;
  healthIntervalMs?: number;
  /** Test seam; defaults to `startDaemonPlugin` from `@papercusp/plugin-loader/daemon`. */
  startDaemon?: (opts: StartDaemonOptions) => Promise<ProviderDaemonHandle>;
}

export interface DaemonProviderRuntime {
  descriptor: ProviderDescriptor;
  adapter: ProviderAdapter;
  handle: ProviderDaemonHandle;
  /** Number of in-flight calls holding a live callToken. */
  activeCalls(): number;
  shutdown(): Promise<void>;
}

interface CallBinding {
  source: string;
  host: ProviderHost;
}

/** Node's install prefix (…/bin/node → …), the default runtime bind. */
export function hostNodeRuntimeDir(): string {
  return path.dirname(path.dirname(process.execPath));
}

/**
 * Resolve a manifest daemon command for the sandbox. The sandbox PATH is
 * `/usr/bin:/bin`, so a bare `node` would miss a node installed elsewhere
 * (nvm, a desktop-bundled runtime); it becomes this host's own node, whose
 * prefix is the default runtime bind. Other commands pass through unchanged.
 */
export function resolveProviderCommand(cmd: string[]): string[] {
  return cmd[0] === 'node' ? [process.execPath, ...cmd.slice(1)] : cmd;
}

const runtimeState = pinModuleState('@papercusp/operator-core.integrations.daemon-provider', () => ({
  runtimes: new Map<string, DaemonProviderRuntime>(),
}));

/** Running daemon providers in this process, keyed by owning plugin name. */
export function daemonProviderRuntimes(): ReadonlyMap<string, DaemonProviderRuntime> {
  return runtimeState.runtimes;
}

/** Track a started daemon provider so unload can stop it. */
export function trackDaemonProvider(pluginName: string, runtime: DaemonProviderRuntime): void {
  runtimeState.runtimes.set(pluginName, runtime);
}

/**
 * Stop and forget the plugin's daemon provider, if one is running. The entry
 * leaves the map before the shutdown is awaited, so a caller that does not
 * await still sees a consistent map; shutdown errors are swallowed because
 * the process is being discarded either way.
 */
export async function stopDaemonProvider(pluginName: string): Promise<boolean> {
  const runtime = runtimeState.runtimes.get(pluginName);
  if (!runtime) return false;
  runtimeState.runtimes.delete(pluginName);
  await runtime.shutdown().catch(() => {});
  return true;
}

export async function startDaemonProvider(opts: StartDaemonProviderOptions): Promise<DaemonProviderRuntime> {
  const daemonModule = await import('@papercusp/plugin-loader/daemon');
  const { JsonRpcHandlerError } = daemonModule;
  const timeoutMs = opts.callTimeoutMs ?? 60_000;
  const calls = new Map<string, CallBinding>();

  const serveHostFetch = async (params: unknown): Promise<unknown> => {
    const p = (params ?? {}) as { callToken?: unknown; source?: unknown; request?: unknown };
    const binding = typeof p.callToken === 'string' ? calls.get(p.callToken) : undefined;
    if (!binding) {
      throw new JsonRpcHandlerError(
        DAEMON_HOST_FETCH_ERRORS.callTokenInvalid,
        'call-token-invalid: host.fetch is only available inside a live provider call',
      );
    }
    if (p.source !== binding.source) {
      throw new JsonRpcHandlerError(
        DAEMON_HOST_FETCH_ERRORS.sourceNotBound,
        `source-not-bound: this call serves source "${binding.source}"`,
      );
    }
    const request = p.request as HostFetchRequest | undefined;
    if (!request || typeof request !== 'object' || typeof request.url !== 'string') {
      throw new JsonRpcHandlerError(DAEMON_HOST_FETCH_ERRORS.invalidParams, 'host.fetch: request.url is required');
    }
    try {
      return await binding.host.fetch({ source: binding.source, request });
    } catch (e: unknown) {
      if (e instanceof HostFetchError) {
        throw new JsonRpcHandlerError(DAEMON_HOST_FETCH_ERRORS.hostFetchRefused, `${e.code}: ${e.message}`, {
          code: e.code,
        });
      }
      throw e;
    }
  };

  const start = opts.startDaemon ?? (daemonModule.startDaemonPlugin as (o: StartDaemonOptions) => Promise<ProviderDaemonHandle>);
  const handle = await start({
    pluginName: opts.pluginName,
    cmd: resolveProviderCommand(opts.cmd),
    cwd: opts.pluginDir,
    sandbox: 'provider',
    runtimeDirs: opts.runtimeDirs ?? [hostNodeRuntimeDir()],
    bwrapBinary: opts.bwrapBinary,
    restart: { policy: 'on-failure' },
    healthIntervalMs: opts.healthIntervalMs,
    onLog: opts.onLog,
    requestHandlers: { [PROVIDER_DAEMON_METHODS.hostFetch]: serveHostFetch },
  });

  let descriptor: ProviderDescriptor;
  try {
    const raw = await handle.request<unknown>(PROVIDER_DAEMON_METHODS.describe, undefined, timeoutMs);
    const errors = validateProviderDescriptor(raw);
    if (errors.length > 0) {
      throw new DaemonProviderError('descriptor-invalid', `daemon ${opts.pluginName} describe(): ${errors.join('; ')}`);
    }
    descriptor = raw as ProviderDescriptor;
    if (opts.declared && opts.declared.id !== descriptor.id) {
      throw new DaemonProviderError(
        'descriptor-mismatch',
        `daemon ${opts.pluginName} describes provider "${descriptor.id}" but its manifest declares "${opts.declared.id}"`,
      );
    }
  } catch (e) {
    await handle.shutdown();
    throw e;
  }

  const withCall = async <T>(method: string, request: { source: string }, host: ProviderHost | undefined): Promise<T> => {
    if (!host || typeof host.fetch !== 'function') {
      throw new DaemonProviderError(
        'host-fetch-unavailable',
        `provider "${descriptor.id}" refused: no host-mediated fetch for this call`,
      );
    }
    const callToken = randomBytes(32).toString('hex');
    calls.set(callToken, { source: request.source, host });
    try {
      const params: ProviderDaemonCallParams<typeof request> = { request, callToken };
      return await handle.request<T>(method, params, timeoutMs);
    } finally {
      calls.delete(callToken);
    }
  };

  const adapter: ProviderAdapter = {
    describe: () => descriptor,
    syncPage: (request: ProviderSyncRequest, host: ProviderHost) =>
      withCall<ProviderSyncPage>(PROVIDER_DAEMON_METHODS.syncPage, request, host),
    invoke: (request: ProviderInvokeRequest, host: ProviderHost) =>
      withCall<unknown>(PROVIDER_DAEMON_METHODS.invoke, request, host),
  };

  return {
    descriptor,
    adapter,
    handle,
    activeCalls: () => calls.size,
    shutdown: () => handle.shutdown(),
  };
}
