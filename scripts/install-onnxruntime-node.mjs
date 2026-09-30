#!/usr/bin/env node
/**
 * Keep onnxruntime-node's large CUDA provider files durable across installs.
 *
 * The npm package intentionally omits CUDA/TensorRT binaries from its tarball
 * and downloads them from NuGet in its own postinstall. A root dependency
 * declaration makes the package reproducible; this wrapper makes the optional
 * CUDA payload explicit, testable, and compatible with install:safe's
 * `--offline-safe` mode.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

export const ONNXRUNTIME_NODE_VERSION = '1.24.3';
export const CUDA_PROVIDER_FILES = Object.freeze([
  'libonnxruntime_providers_cuda.so',
  'libonnxruntime_providers_shared.so',
  'libonnxruntime_providers_tensorrt.so',
]);

const SKIP_INSTALL_VALUES = new Set(['0', 'false', 'no', 'off', 'skip', 'offline-safe']);
const require = createRequire(import.meta.url);

function firstValue(env, names) {
  for (const name of names) {
    if (env[name] !== undefined && env[name] !== '') return env[name];
  }
  return undefined;
}

function normalizeOs(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeCpu(value) {
  const normalized = normalizeOs(value);
  return normalized === 'amd64' ? 'x64' : normalized;
}

/**
 * npm exposes the requested target as npm_config_os / npm_config_cpu during
 * lifecycle scripts. Falling back to the host keeps direct CLI invocation
 * deterministic while still honoring cross-target installs.
 */
export function resolveTargetPlatform(
  env = process.env,
  { platform = process.platform, arch = process.arch } = {},
) {
  return {
    os:
      normalizeOs(firstValue(env, ['npm_config_os', 'NPM_CONFIG_OS'])) ||
      normalizeOs(platform),
    cpu:
      normalizeCpu(firstValue(env, ['npm_config_cpu', 'NPM_CONFIG_CPU', 'npm_config_arch', 'NPM_CONFIG_ARCH'])) ||
      normalizeCpu(arch),
  };
}

/**
 * NODE_OPTIONS for the upstream CUDA installer child, with a longer
 * happy-eyeballs per-attempt timeout.
 *
 * Measured 2026-09-24 on the tower (memory-reduction-2026-09-24 P-008): the
 * installer's download from api.nuget.org failed with IPv6 ENETUNREACH plus an
 * IPv4 ETIMEDOUT raised by `internalConnectMultipleTimeout`, while
 * `curl -4` fetched the same URL in 0.4 s. Node's default per-attempt timeout
 * (250 ms) abandoned the slow-to-connect IPv4 address before it answered, so
 * the CUDA provider was never installed and every model silently ran on CPU.
 * The same run with a 5 s attempt timeout installed the provider. An explicit
 * caller setting wins.
 */
export const NETWORK_ATTEMPT_TIMEOUT_MS = 5000;
export function withNetworkAttemptTimeout(nodeOptions) {
  const current = typeof nodeOptions === 'string' ? nodeOptions.trim() : '';
  if (/--network-family-autoselection-attempt-timeout[=\s]/.test(current)) return current;
  const flag = `--network-family-autoselection-attempt-timeout=${NETWORK_ATTEMPT_TIMEOUT_MS}`;
  return current ? `${current} ${flag}` : flag;
}

export function requestedInstallSetting(env = process.env) {
  const raw = firstValue(env, [
    'ONNXRUNTIME_NODE_INSTALL',
    'npm_config_onnxruntime_node_install',
    'NPM_CONFIG_ONNXRUNTIME_NODE_INSTALL',
  ]);
  return raw === undefined ? undefined : String(raw).trim().toLowerCase();
}

export function isOfflineSafeInstall(env = process.env) {
  return SKIP_INSTALL_VALUES.has(requestedInstallSetting(env));
}

export function resolveOrtPackageRoot(repoRoot = process.cwd()) {
  return dirname(require.resolve('onnxruntime-node/package.json', { paths: [repoRoot] }));
}

function readOrtPackageJson(packageRoot) {
  return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
}

export function providerFilePaths({
  packageRoot,
  target = resolveTargetPlatform(),
} = {}) {
  if (!packageRoot) throw new Error('providerFilePaths requires packageRoot');
  const packageJson = readOrtPackageJson(packageRoot);
  const napiVersion = packageJson.binary?.napi_versions?.[0] ?? 6;
  const binRoot = join(
    packageRoot,
    'bin',
    `napi-v${napiVersion}`,
    target.os,
    target.cpu,
  );
  return CUDA_PROVIDER_FILES.map((file) => join(binRoot, file));
}

export function inspectCudaProvider({
  repoRoot = process.cwd(),
  env = process.env,
  resolvePackageRoot = resolveOrtPackageRoot,
  fileExists = existsSync,
} = {}) {
  const target = resolveTargetPlatform(env);
  let packageRoot;
  try {
    packageRoot = resolvePackageRoot(repoRoot);
  } catch {
    return {
      target,
      packageRoot: null,
      files: [],
      missing: CUDA_PROVIDER_FILES.map((file) => `onnxruntime-node/${file}`),
      packageMissing: true,
    };
  }

  const files = providerFilePaths({ packageRoot, target });
  return {
    target,
    packageRoot,
    files,
    missing: files.filter((file) => !fileExists(file)),
    packageMissing: false,
  };
}

export function assertCudaProviderAssets({
  repoRoot = process.cwd(),
  env = process.env,
  resolvePackageRoot = resolveOrtPackageRoot,
  fileExists = existsSync,
} = {}) {
  const requested = normalizeOs(env.PAPERCUSP_RERANK_DEVICE) || '';
  if (requested !== 'cuda' && requested !== 'gpu') {
    return { requested: false, ok: true };
  }

  const report = inspectCudaProvider({
    repoRoot,
    env,
    resolvePackageRoot,
    fileExists,
  });
  if (report.missing.length > 0) {
    const missing = report.missing.map((file) => `  - ${file}`).join('\n');
    throw new Error(
      `PAPERCUSP_RERANK_DEVICE=${requested} requests CUDA, but onnxruntime-node ` +
        `${ONNXRUNTIME_NODE_VERSION} is missing provider assets for ` +
        `${report.target.os}/${report.target.cpu}:\n${missing}\n` +
        'Run a normal install (not npm run install:safe -- --offline-safe) ' +
        'with network access to fetch the CUDA 12 provider payload.',
    );
  }
  return { requested: true, ok: true, ...report };
}

/**
 * Run ORT's own installer only for a native linux/x64 target. npm can resolve
 * another target through npm_config_os/cpu, but a lifecycle process cannot
 * execute that target's native installer on a different host.
 */
export function installCudaProvider({
  repoRoot = process.cwd(),
  env = process.env,
  host = { platform: process.platform, arch: process.arch },
  resolvePackageRoot = resolveOrtPackageRoot,
  run = spawnSync,
  fileExists = existsSync,
} = {}) {
  const target = resolveTargetPlatform(env, host);
  const setting = requestedInstallSetting(env);

  if (isOfflineSafeInstall(env)) {
    console.log(`onnxruntime-node CUDA install skipped (${setting ?? 'offline-safe'}).`);
    return { skipped: true, reason: 'offline-safe', target };
  }

  if (target.os !== 'linux' || target.cpu !== 'x64') {
    console.log(`onnxruntime-node CUDA install skipped for target ${target.os}/${target.cpu}.`);
    return { skipped: true, reason: 'target-not-linux-x64', target };
  }

  const hostTarget = resolveTargetPlatform({}, host);
  if (target.os !== hostTarget.os || target.cpu !== hostTarget.cpu) {
    console.log(
      `onnxruntime-node CUDA install skipped for cross-host target ` +
        `${target.os}/${target.cpu} (host ${hostTarget.os}/${hostTarget.cpu}).`,
    );
    return { skipped: true, reason: 'cross-host-target', target };
  }

  let packageRoot;
  try {
    packageRoot = resolvePackageRoot(repoRoot);
  } catch {
    console.warn(
      `onnxruntime-node ${ONNXRUNTIME_NODE_VERSION} is optional and was not extracted; ` +
        'CUDA provider installation will be retried when the dependency is available.',
    );
    return { skipped: true, reason: 'package-missing', target };
  }

  const installScript = join(packageRoot, 'script', 'install.js');
  const result = run(process.execPath, [installScript], {
    cwd: packageRoot,
    stdio: 'inherit',
    env: {
      ...env,
      ONNXRUNTIME_NODE_INSTALL: 'cuda12',
      NODE_OPTIONS: withNetworkAttemptTimeout(env.NODE_OPTIONS),
    },
  });
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  if (status !== 0) {
    throw new Error(`onnxruntime-node CUDA provider installer exited with status ${status}`);
  }

  const report = inspectCudaProvider({
    repoRoot,
    env,
    resolvePackageRoot: () => packageRoot,
    fileExists,
  });
  if (report.missing.length > 0) {
    throw new Error(
      `onnxruntime-node CUDA provider installer completed but did not produce:\n` +
        report.missing.map((file) => `  - ${file}`).join('\n'),
    );
  }
  console.log(
    `onnxruntime-node CUDA provider assets verified for ${target.os}/${target.cpu}.`,
  );
  return { skipped: false, target, packageRoot, files: report.files };
}

export function main() {
  installCudaProvider();
}

if (isCliEntry(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      `onnxruntime-node CUDA provider setup failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  }
}
