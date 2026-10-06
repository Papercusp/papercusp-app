import type {
  WorkspaceHostImageArtifact,
  WorkspaceHostProviderTarget,
} from '@papercusp/deployment-driver';

export const WORKSPACE_HOST_BOOTC_BAKE_CONTRACT_VERSION = 'papercusp-bootc-bake-v1';

export const WORKSPACE_HOST_BOOTC_CLOUD_TYPES = {
  gcp: 'gce',
  aws: 'ami',
  azure: 'vhd',
} as const satisfies Record<WorkspaceHostProviderTarget, string>;

export type WorkspaceHostBootcProvider = keyof typeof WORKSPACE_HOST_BOOTC_CLOUD_TYPES;
export type WorkspaceHostBootcCloudType =
  (typeof WORKSPACE_HOST_BOOTC_CLOUD_TYPES)[WorkspaceHostBootcProvider];

export interface WorkspaceHostBootcCloudArtifact {
  cloud: WorkspaceHostBootcProvider;
  type: WorkspaceHostBootcCloudType;
  /** Absolute or manifest-relative local disk path. Provider adapters verify it before upload. */
  artifact: string;
  sha256: string;
  sizeBytes: number;
}

/**
 * The release tree the baked IMAGE carries at /opt/papercusp/releases/<version> (WI-10005761).
 * bake-cloud-images.sh derives it from the image itself (`/opt/papercusp/current`), never from
 * its own flags, so a `--source-image` reuse is described as accurately as a fresh build.
 */
export interface WorkspaceHostBootcBakeRelease {
  version: string;
}

export interface WorkspaceHostBootcBakeManifest {
  contractVersion: typeof WORKSPACE_HOST_BOOTC_BAKE_CONTRACT_VERSION;
  /** OCI repository without a tag or digest. */
  image: string;
  tag: string;
  digest: `sha256:${string}`;
  pinnedRef: string;
  registryNamespace: string;
  /** Dry-run plans deliberately carry zero-byte placeholders and are never releasable. */
  dryRun?: false;
  /**
   * The release baked into the image, or null for an OS-only image. Absent on manifests written
   * before WI-10005761; consumers must treat absent exactly like null (no release is proven).
   */
  release?: WorkspaceHostBootcBakeRelease | null;
  /** One artifact per selected provider. All were rendered from pinnedRef. */
  clouds: readonly WorkspaceHostBootcCloudArtifact[];
}

export class WorkspaceHostBootcBakeManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceHostBootcBakeManifestError';
  }
}

/** The digest provider scans, tags, canaries, and manifests bind to for this host model. */
export function workspaceHostReleaseSubjectSha256(artifact: WorkspaceHostImageArtifact): string {
  return artifact.hostModel === 'bootc-image'
    ? artifact.bootc.imageDigest.replace(/^sha256:/, '')
    : artifact.release.bundleSha256;
}

const SHA256 = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IMAGE_REPOSITORY =
  /^[a-z0-9][a-z0-9._-]*(?::\d{1,5})?(?:\/[a-z0-9][a-z0-9._-]*)+$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The --release-version / PAPERCUSP_RELEASE_VERSION charset the bake and Containerfile enforce. */
const RELEASE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeArtifactPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\')) return false;
  const parts = value.split('/');
  return !parts.some((part, index) => part === '.' || part === '..' || (part === '' && index > 0));
}

/** Validate the one-digest handoff for the providers selected in bake-cloud-images.sh. */
export function validateWorkspaceHostBootcBakeManifest(value: unknown): readonly string[] {
  const errors: string[] = [];
  const candidate = object(value);
  if (!candidate) return ['bootc bake manifest must be an object'];
  if (candidate.contractVersion !== WORKSPACE_HOST_BOOTC_BAKE_CONTRACT_VERSION) {
    errors.push(`contractVersion must be '${WORKSPACE_HOST_BOOTC_BAKE_CONTRACT_VERSION}'`);
  }
  const image = typeof candidate.image === 'string' ? candidate.image : '';
  const tag = typeof candidate.tag === 'string' ? candidate.tag : '';
  const digest = typeof candidate.digest === 'string' ? candidate.digest : '';
  const registryNamespace =
    typeof candidate.registryNamespace === 'string' ? candidate.registryNamespace : '';
  if (!IMAGE_REPOSITORY.test(image)) errors.push('image must be a registry-qualified OCI repository');
  if (!TAG.test(tag)) errors.push('tag must be a safe OCI tag');
  if (!DIGEST.test(digest)) errors.push('digest must be a lowercase sha256 manifest digest');
  if (!IMAGE_REPOSITORY.test(`${registryNamespace}/workspace-host`)) {
    errors.push('registryNamespace must be a registry-qualified namespace');
  }
  if (image && registryNamespace && image !== `${registryNamespace}/workspace-host`) {
    errors.push('image must equal registryNamespace/workspace-host');
  }
  if (candidate.pinnedRef !== `${image}@${digest}`) {
    errors.push('pinnedRef must equal image@digest');
  }
  if (candidate.dryRun !== undefined && candidate.dryRun !== false) {
    errors.push('dry-run bake manifests cannot be consumed by a release');
  }
  if (candidate.release !== undefined && candidate.release !== null) {
    const release = object(candidate.release);
    if (!release) {
      errors.push('release must be an object or null');
    } else if (typeof release.version !== 'string' || !RELEASE_VERSION.test(release.version)) {
      errors.push('release.version must be a safe release version');
    }
  }

  if (!Array.isArray(candidate.clouds)) {
    errors.push('clouds must be an array');
    return errors;
  }
  const seen = new Set<string>();
  candidate.clouds.forEach((raw, index) => {
    const cloud = object(raw);
    if (!cloud) {
      errors.push(`clouds[${index}] must be an object`);
      return;
    }
    const provider = typeof cloud.cloud === 'string' ? cloud.cloud : '';
    if (!Object.hasOwn(WORKSPACE_HOST_BOOTC_CLOUD_TYPES, provider)) {
      errors.push(`clouds[${index}].cloud must be gcp, aws, or azure`);
      return;
    }
    if (seen.has(provider)) errors.push(`clouds contains duplicate provider '${provider}'`);
    seen.add(provider);
    const expected = WORKSPACE_HOST_BOOTC_CLOUD_TYPES[provider as WorkspaceHostBootcProvider];
    if (cloud.type !== expected) {
      errors.push(`clouds[${index}].type must be '${expected}' for ${provider}`);
    }
    if (!safeArtifactPath(cloud.artifact)) {
      errors.push(`clouds[${index}].artifact must be a normalized local path`);
    }
    if (typeof cloud.sha256 !== 'string' || !SHA256.test(cloud.sha256)) {
      errors.push(`clouds[${index}].sha256 must be a lowercase SHA-256 digest`);
    }
    if (!Number.isSafeInteger(cloud.sizeBytes) || Number(cloud.sizeBytes) <= 0) {
      errors.push(`clouds[${index}].sizeBytes must be a positive safe integer`);
    }
  });
  if (candidate.clouds.length === 0) {
    errors.push('clouds must contain at least one provider artifact');
  }
  return errors;
}

export function parseWorkspaceHostBootcBakeManifest(value: unknown): WorkspaceHostBootcBakeManifest {
  const errors = validateWorkspaceHostBootcBakeManifest(value);
  if (errors.length > 0) throw new WorkspaceHostBootcBakeManifestError(errors.join('; '));
  const candidate = value as WorkspaceHostBootcBakeManifest;
  return {
    ...candidate,
    clouds: candidate.clouds.map((cloud) => ({ ...cloud })),
  };
}

/**
 * WI-10005761 — on the bootc model a release is IMAGE CONTENT, not a label: the bootstrap never
 * installs one, it requires /opt/papercusp/releases/<version> to already be in the booted image.
 * So a release request may only name the version the bake actually carries. Returns the refusal
 * when it does not (an OS-only bake, a pre-WI-10005761 manifest, or a different release), else
 * undefined. Measured cost of the missing check: two billable clean rooms that booted, passed
 * harden-os, and died at install-runtime.
 */
export function workspaceHostBootcBakeReleaseMismatch(
  manifest: Pick<WorkspaceHostBootcBakeManifest, 'release' | 'tag'>,
  releaseVersion: string,
): string | undefined {
  const baked = manifest.release?.version;
  if (baked === releaseVersion) return undefined;
  const carries =
    baked === undefined
      ? manifest.release === null
        ? 'is OS-only (it carries no release)'
        : 'records no baked release (it predates WI-10005761 or is OS-only)'
      : `carries release ${baked}`;
  return (
    `bake ${manifest.tag} ${carries}, but the release names ${releaseVersion}; ` +
    `re-bake with bake-cloud-images.sh --release-root <extracted ${releaseVersion}> --release-version ${releaseVersion}`
  );
}

export function workspaceHostBootcCloudArtifact(
  manifest: WorkspaceHostBootcBakeManifest,
  provider: WorkspaceHostProviderTarget,
): WorkspaceHostBootcCloudArtifact {
  if (!Object.hasOwn(WORKSPACE_HOST_BOOTC_CLOUD_TYPES, provider)) {
    throw new WorkspaceHostBootcBakeManifestError(`unsupported bootc provider '${provider}'`);
  }
  const parsed = parseWorkspaceHostBootcBakeManifest(manifest);
  const artifact = parsed.clouds.find((entry) => entry.cloud === provider);
  if (!artifact) throw new WorkspaceHostBootcBakeManifestError(`clouds is missing provider '${provider}'`);
  return artifact;
}
