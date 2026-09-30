/**
 * Fail-closed runtime policy for the immutable `vm-release` distribution.
 *
 * Dogfood and development launches are deliberately unchanged: every guard in
 * this module is gated on the exact distribution profile. A vm-release process,
 * however, must prove that its packaged sidecar bytes match the package-contained
 * provenance manifest before it can reuse or start an operator.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, posix, resolve, sep } from 'node:path';
import { assertRemoteAuthReady } from './remote-auth-policy';

export const VM_RELEASE_DISTRIBUTION_PROFILE = 'vm-release';
export const VM_RELEASE_FORBIDDEN_PORTS = new Set([3055, 3170, 3270]);
export const VM_RELEASE_MODEL_ASSET_MANIFEST =
  'node_modules/@huggingface/transformers/models/papercusp-model-assets.json';

interface ProvenanceArtifact {
  name: string;
  sha256: string;
}

interface BuildProvenance {
  version: string;
  buildSha: string;
  artifacts: ProvenanceArtifact[];
}

interface ModelAssetFile {
  path: string;
  bytes: number;
  sha256: string;
}

interface ModelAsset {
  mode: string;
  runtimeId: string;
  revision: string;
  nativeDimensions: number;
  files: ModelAssetFile[];
}

interface ModelAssetManifest {
  schemaVersion: 1;
  pack: 'local-models';
  required: true;
  cachePolicy: {
    remoteFetch: 'forbidden-on-vm-release';
    missingOrCorrupt: 'refuse-startup';
    recovery: string;
  };
  compatibility: {
    transformersPackage: string;
    runtimeDefaults: string[];
  };
  models: ModelAsset[];
}

export interface VmReleaseRuntimePolicyOptions {
  env?: NodeJS.ProcessEnv;
  sidecarDir: string;
  hostname: string;
  port: number;
}

export function isVmReleaseDistribution(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAPERCUSP_DISTRIBUTION_PROFILE === VM_RELEASE_DISTRIBUTION_PROFILE;
}

function fail(detail: string): never {
  throw new Error(`[vm-release] immutable runtime policy refused startup: ${detail}`);
}

function parseManifest(path: string): BuildProvenance {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`cannot read package-contained build-provenance.json (${(error as Error).message})`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('build-provenance.json must contain one object');
  }
  const manifest = value as Partial<BuildProvenance>;
  if (typeof manifest.version !== 'string' || !manifest.version) {
    fail('build-provenance.json has no exact version');
  }
  if (typeof manifest.buildSha !== 'string' || !manifest.buildSha) {
    fail('build-provenance.json has no exact buildSha');
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    fail('build-provenance.json lists no artifacts');
  }
  return manifest as BuildProvenance;
}

function safeArtifactName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    !isAbsolute(name) &&
    !name.includes('\\') &&
    !name.split('/').some((part) => part === '' || part === '.' || part === '..') &&
    posix.normalize(name) === name
  );
}

function sha256(path: string): string {
  const digest = createHash('sha256');
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      digest.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(fd);
  }
  return digest.digest('hex');
}

function parseModelAssetManifest(path: string): ModelAssetManifest {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(
      `required model-asset manifest is missing or unreadable (${(error as Error).message}); ` +
      'recover by replacing this runtime with a signed release containing the pinned local-models pack',
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('model-asset manifest must contain one object');
  }
  const manifest = value as Partial<ModelAssetManifest>;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.pack !== 'local-models' ||
    manifest.required !== true ||
    manifest.cachePolicy?.remoteFetch !== 'forbidden-on-vm-release' ||
    manifest.cachePolicy?.missingOrCorrupt !== 'refuse-startup' ||
    !manifest.cachePolicy?.recovery ||
    !manifest.compatibility?.transformersPackage ||
    !Array.isArray(manifest.compatibility.runtimeDefaults) ||
    !Array.isArray(manifest.models) ||
    manifest.models.length === 0
  ) {
    fail('model-asset manifest does not satisfy the vm-release local-only/readiness contract');
  }
  return manifest as ModelAssetManifest;
}

function relativeFiles(root: string, prefix = ''): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(resolve(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...relativeFiles(root, rel));
    else files.push(rel);
  }
  return files.sort();
}

/**
 * Prove the exact, independently-versioned model pack before a customer
 * runtime may become ready. Full hashes are deliberate: the largest files are
 * external ONNX data, and a name/size-only check cannot distinguish corruption.
 */
function assertVmReleaseModelAssets(sidecarRoot: string, env: NodeJS.ProcessEnv): void {
  const manifestPath = resolve(sidecarRoot, VM_RELEASE_MODEL_ASSET_MANIFEST);
  const manifest = parseModelAssetManifest(manifestPath);
  const transformersRoot = resolve(sidecarRoot, 'node_modules/@huggingface/transformers');
  const packagePath = resolve(transformersRoot, 'package.json');
  let packageIdentity: { name?: unknown; version?: unknown };
  try {
    packageIdentity = JSON.parse(readFileSync(packagePath, 'utf8')) as typeof packageIdentity;
  } catch (error) {
    fail(`cannot read transformers package identity (${(error as Error).message})`);
  }
  if (
    packageIdentity.name !== '@huggingface/transformers' ||
    packageIdentity.version !== manifest.compatibility.transformersPackage
  ) {
    fail(
      `model compatibility requires @huggingface/transformers@${manifest.compatibility.transformersPackage}, ` +
      `got ${String(packageIdentity.name)}@${String(packageIdentity.version)}`,
    );
  }

  const namespaceRoot = resolve(transformersRoot, 'models/onnx-community');
  const expectedModels = new Set<string>();
  const modes = new Set<string>();
  for (const model of manifest.models) {
    if (
      !model ||
      typeof model.mode !== 'string' ||
      !model.mode ||
      !safeArtifactName(model.runtimeId) ||
      model.runtimeId.split('/').length !== 2 ||
      !/^[0-9a-f]{40}$/.test(model.revision) ||
      !Number.isInteger(model.nativeDimensions) ||
      model.nativeDimensions <= 0 ||
      !Array.isArray(model.files) ||
      model.files.length === 0
    ) {
      fail(`invalid pinned model declaration ${JSON.stringify(model?.runtimeId)}`);
    }
    if (modes.has(model.mode)) fail(`duplicate model mode ${model.mode}`);
    modes.add(model.mode);
    const modelName = model.runtimeId.split('/')[1]!;
    if (expectedModels.has(modelName)) fail(`duplicate model directory ${modelName}`);
    expectedModels.add(modelName);

    const modelRoot = resolve(namespaceRoot, modelName);
    const expectedFiles = new Set<string>();
    for (const file of model.files) {
      if (
        !file ||
        !safeArtifactName(file.path) ||
        !Number.isInteger(file.bytes) ||
        file.bytes <= 0 ||
        !/^[0-9a-f]{64}$/.test(file.sha256)
      ) {
        fail(`invalid file declaration for ${model.runtimeId}`);
      }
      if (expectedFiles.has(file.path)) fail(`duplicate file ${modelName}/${file.path}`);
      expectedFiles.add(file.path);
      const path = resolve(modelRoot, file.path);
      let stat;
      try {
        stat = statSync(path);
      } catch (error) {
        fail(
          `required model file is missing: ${modelName}/${file.path} (${(error as Error).message}); ` +
          manifest.cachePolicy.recovery,
        );
      }
      if (!stat.isFile()) fail(`required model asset is not a file: ${modelName}/${file.path}`);
      const real = realpathSync(path);
      if (!real.startsWith(`${modelRoot}${sep}`)) {
        fail(`model asset resolves outside its pinned directory: ${modelName}/${file.path}`);
      }
      if (stat.size !== file.bytes) {
        fail(
          `model asset size mismatch for ${modelName}/${file.path}: expected ${file.bytes}, got ${stat.size}; ` +
          manifest.cachePolicy.recovery,
        );
      }
      const actual = sha256(path);
      if (actual !== file.sha256) {
        fail(
          `model asset sha256 mismatch for ${modelName}/${file.path}: expected ${file.sha256}, got ${actual}; ` +
          manifest.cachePolicy.recovery,
        );
      }
    }
    const actualFiles = relativeFiles(modelRoot);
    const unexpected = actualFiles.filter((path) => !expectedFiles.has(path));
    const missing = [...expectedFiles].filter((path) => !actualFiles.includes(path));
    if (unexpected.length || missing.length) {
      fail(
        `model file inventory mismatch for ${modelName}: missing=${missing.join(',') || '<none>'}, ` +
        `unexpected=${unexpected.join(',') || '<none>'}`,
      );
    }
  }
  const actualModels = readdirSync(namespaceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const missingModels = [...expectedModels].filter((name) => !actualModels.includes(name));
  const unexpectedModels = actualModels.filter((name) => !expectedModels.has(name));
  if (missingModels.length || unexpectedModels.length) {
    fail(
      `model inventory mismatch: missing=${missingModels.join(',') || '<none>'}, ` +
      `unexpected=${unexpectedModels.join(',') || '<none>'}`,
    );
  }
  for (const requiredMode of manifest.compatibility.runtimeDefaults) {
    if (!modes.has(requiredMode)) fail(`runtime default ${requiredMode} has no pinned model asset`);
  }

  // The embedder adapters consume this exact flag and set Transformers.js'
  // allowRemoteModels=false before constructing a pipeline. Set it only after
  // the complete local pack has passed, so "local-only" never masks absence.
  env.PAPERCUSP_TRANSFORMERS_LOCAL_ONLY = '1';
}

/** Assert just the selected HTTP port; called again after sticky-port resolution. */
export function assertVmReleaseRuntimePort(port: number, env: NodeJS.ProcessEnv = process.env): void {
  if (!isVmReleaseDistribution(env)) return;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    fail(`operator port ${String(port)} is invalid`);
  }
  if (VM_RELEASE_FORBIDDEN_PORTS.has(port)) {
    fail(`operator port ${port} is reserved for a dogfood dev/local/staging surface`);
  }
}

/**
 * Verify immutable package identity and the one-operator network/environment
 * contract. This must run before `serve --ensure` can adopt an existing process.
 */
export function assertVmReleaseRuntimePolicy(options: VmReleaseRuntimePolicyOptions): void {
  const env = options.env ?? process.env;
  if (!isVmReleaseDistribution(env)) return;

  const expectedVersion = env.PAPERCUSP_BUILD_VERSION;
  const expectedSha = env.PAPERCUSP_BUILD_SHA;
  if (!expectedVersion) fail('PAPERCUSP_BUILD_VERSION is required');
  if (!expectedSha) fail('PAPERCUSP_BUILD_SHA is required');
  if (env.PAPERCUSP_ENV_OPERATOR_ID) {
    fail('PAPERCUSP_ENV_OPERATOR_ID would create a second environment operator');
  }
  if (env.PAPERCUSP_PROVISION_ENV_OPERATORS !== '0') {
    fail('PAPERCUSP_PROVISION_ENV_OPERATORS must be exactly 0');
  }

  assertVmReleaseRuntimePort(options.port, env);
  assertRemoteAuthReady(options.hostname, env);

  const sidecarRoot = realpathSync(options.sidecarDir);
  const manifest = parseManifest(resolve(sidecarRoot, 'build-provenance.json'));
  if (manifest.version !== expectedVersion) {
    fail(`manifest version ${manifest.version} does not equal baked version ${expectedVersion}`);
  }
  if (manifest.buildSha !== expectedSha) {
    fail(`manifest buildSha ${manifest.buildSha} does not equal baked SHA ${expectedSha}`);
  }

  const seen = new Set<string>();
  for (const artifact of manifest.artifacts) {
    if (!artifact || !safeArtifactName(artifact.name)) {
      fail(`unsafe artifact name ${JSON.stringify(artifact?.name)}`);
    }
    if (seen.has(artifact.name)) fail(`duplicate artifact ${artifact.name}`);
    seen.add(artifact.name);
    if (!/^[0-9a-f]{64}$/.test(artifact.sha256)) {
      fail(`artifact ${artifact.name} has an invalid sha256`);
    }
    const artifactPath = resolve(sidecarRoot, artifact.name);
    const realArtifact = realpathSync(artifactPath);
    if (realArtifact !== sidecarRoot && !realArtifact.startsWith(`${sidecarRoot}${sep}`)) {
      fail(`artifact ${artifact.name} resolves outside the packaged sidecar`);
    }
    if (!lstatSync(artifactPath).isFile()) fail(`artifact ${artifact.name} is not a file`);
    const actual = sha256(artifactPath);
    if (actual !== artifact.sha256) {
      fail(`artifact ${artifact.name} hash mismatch (expected ${artifact.sha256}, got ${actual})`);
    }
  }
  for (const required of ['serve.mjs', 'bin/node']) {
    if (!seen.has(required)) fail(`manifest does not attest required runtime artifact ${required}`);
  }
  assertVmReleaseModelAssets(sidecarRoot, env);
}
