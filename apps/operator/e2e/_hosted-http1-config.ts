import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { tmpdir } from 'node:os';

export const DEFAULT_HOSTED_ACCEPTANCE_ORIGIN = 'https://app.papercusp.com';

export interface HostedHttp1AcceptanceConfig {
  origin: string;
  storageStatePath: string;
  evidenceDir: string;
  proxyServer?: string;
  slo: {
    coldHydrationMs: number;
    finiteInteractionMs: number;
    reconnectReplayMs: number;
    fcpMs: number;
    lcpMs: number;
    syncQueueWaitMs: number;
  };
}

function exactLoopbackSocksProxy(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('PAPERCUSP_HOSTED_ACCEPTANCE_PROXY must be an exact loopback SOCKS5 URL');
  }
  const port = Number(url.port);
  if (
    url.protocol !== 'socks5:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash
  ) {
    throw new Error('PAPERCUSP_HOSTED_ACCEPTANCE_PROXY must be an exact loopback SOCKS5 URL');
  }
  return `${url.protocol}//${url.hostname}:${url.port}`;
}

function exactHttpsOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('PAPERCUSP_HOSTED_ACCEPTANCE_ORIGIN must be an exact HTTPS origin');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash
  ) {
    throw new Error('PAPERCUSP_HOSTED_ACCEPTANCE_ORIGIN must be an exact HTTPS origin');
  }
  return url.origin;
}

function positiveMs(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer number of milliseconds`);
  }
  return value;
}

function secureStorageStatePath(raw: string | undefined, cwd: string): string {
  if (!raw?.trim()) {
    throw new Error(
      'PAPERCUSP_HOSTED_ACCEPTANCE_STORAGE_STATE is required; point it at a chmod 600 Playwright storage-state file',
    );
  }
  const file = isAbsolute(raw) ? raw : resolve(cwd, raw);
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error('PAPERCUSP_HOSTED_ACCEPTANCE_STORAGE_STATE must name an existing file');
  }
  if ((statSync(file).mode & 0o077) !== 0) {
    throw new Error('PAPERCUSP_HOSTED_ACCEPTANCE_STORAGE_STATE must not be readable by group or other users (chmod 600)');
  }
  return file;
}

/**
 * Parse the live-only acceptance profile. Missing auth is a hard failure, never
 * a skipped/anonymous run that could be mistaken for hosted acceptance.
 */
export function readHostedHttp1AcceptanceConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): HostedHttp1AcceptanceConfig {
  const origin = exactHttpsOrigin(
    env.PAPERCUSP_HOSTED_ACCEPTANCE_ORIGIN ?? DEFAULT_HOSTED_ACCEPTANCE_ORIGIN,
  );
  const storageStatePath = secureStorageStatePath(
    env.PAPERCUSP_HOSTED_ACCEPTANCE_STORAGE_STATE,
    cwd,
  );
  const evidenceDir = resolve(
    env.PAPERCUSP_HOSTED_ACCEPTANCE_EVIDENCE_DIR?.trim() ||
      resolve(tmpdir(), 'papercusp-hosted-http1-acceptance'),
  );
  const proxyServer = exactLoopbackSocksProxy(env.PAPERCUSP_HOSTED_ACCEPTANCE_PROXY);
  return {
    origin,
    storageStatePath,
    evidenceDir,
    proxyServer,
    slo: {
      coldHydrationMs: positiveMs(env, 'PAPERCUSP_HOSTED_SLO_COLD_HYDRATION_MS', 15_000),
      finiteInteractionMs: positiveMs(env, 'PAPERCUSP_HOSTED_SLO_INTERACTION_MS', 5_000),
      reconnectReplayMs: positiveMs(env, 'PAPERCUSP_HOSTED_SLO_RECONNECT_MS', 15_000),
      fcpMs: positiveMs(env, 'PAPERCUSP_HOSTED_SLO_FCP_MS', 5_000),
      lcpMs: positiveMs(env, 'PAPERCUSP_HOSTED_SLO_LCP_MS', 10_000),
      syncQueueWaitMs: positiveMs(env, 'PAPERCUSP_HOSTED_SLO_SYNC_QUEUE_WAIT_MS', 1_000),
    },
  };
}

/** Evidence records paths only. Query strings can contain tickets or opaque IDs. */
export function redactEvidenceUrl(raw: string): string {
  const url = new URL(raw);
  return `${url.origin}${url.pathname}`;
}

export function isForcedHttp1(protocol: string): boolean {
  return protocol.toLowerCase() === 'http/1.1';
}
