import { createHash } from "node:crypto";

import type { WorkspaceHostBuildManifest } from "./workspace-host-build-manifest";
import {
  verifyWorkspaceHostBuildManifest,
  verifyWorkspaceHostReleaseProvenance,
} from "./workspace-host-build-manifest";
import {
  DEFAULT_WORKSPACE_HOST_MODEL,
  WORKSPACE_HOST_BOOTC_BASE_IMAGE,
  DEFAULT_WORKSPACE_HOST_AGENT_USER,
  DEFAULT_WORKSPACE_HOST_SERVICE_USER,
  DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
  workspaceHostBootstrapChecks,
  WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
  WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
  WORKSPACE_HOST_CONTAINERS_POLICY_PATH,
  WORKSPACE_HOST_DATA_ROOT,
  WORKSPACE_HOST_MODELS,
  WORKSPACE_HOST_RUNTIME_ROOT,
  WORKSPACE_HOST_STATE_ROOT,
  buildWorkspaceHostBootstrap,
  parseWorkspaceHostBootstrapAttestation,
  validateWorkspaceHostBootstrapAttestation,
  type WorkspaceHostBootstrapAttestation,
  type WorkspaceHostBootstrapEntrypoints,
  type WorkspaceHostBootstrapInput,
  type WorkspaceHostBootstrapIsolation,
  type WorkspaceHostBootstrapRelease,
  type WorkspaceHostBootstrapService,
  type WorkspaceHostModel,
} from "./workspace-host-bootstrap";
import type {
  WorkspaceHostImageRef,
  WorkspaceHostProviderTarget,
} from "./workspace-host-types";

export const WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION =
  "papercusp-workspace-host-image-acceptance-v1";

/**
 * The authorized key the CLEAN-ROOM fixture installs when a spec does not name one.
 *
 * It is a fixed literal on purpose. The gate compares `bootstrapScriptSha256` to prove the
 * fixture is deterministic, so the script must not vary with environment-specific key material;
 * substituting a real controller key here would make that check fail across environments for a
 * reason that has nothing to do with the image.
 *
 * Its private half was generated and destroyed in the same command and was never recorded, so it
 * authorizes nobody. That is the point: the clean-room VM still exercises the real
 * authorized_keys rendering path — so a regression in it fails the gate — without granting access
 * to anything. Production provisioning passes the controller's actual public key instead.
 */
export const WORKSPACE_HOST_CLEAN_ROOM_AUTHORIZED_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIARur6lLxx+/iz7rmO8bWK0dgsvHlrS1hemegIRKbYma papercusp-workspace-host-clean-room-fixture (private key discarded at generation)";

export const WORKSPACE_HOST_IMAGE_ACTIONS = [
  "install",
  "upgrade",
  "rollback",
] as const;
export type WorkspaceHostImageAction =
  (typeof WORKSPACE_HOST_IMAGE_ACTIONS)[number];

export const WORKSPACE_HOST_IMAGE_LIFECYCLE_STATES = [
  "active",
  "deprecated",
  "withdrawn",
] as const;
export type WorkspaceHostImageLifecycleState =
  (typeof WORKSPACE_HOST_IMAGE_LIFECYCLE_STATES)[number];

interface WorkspaceHostImageCompatibilityRuleBase {
  provider: WorkspaceHostProviderTarget;
  architecture: string;
  bootstrapContractVersion: typeof WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION;
  actions: readonly WorkspaceHostImageAction[];
  /** Optional freshness ceiling for new installs/upgrades. Rollback uses supportEndsAt instead. */
  maximumArtifactAgeDays?: number;
  /**
   * The agent-home bundle contract versions THIS bundle's host program can parse, derived at
   * build time from the source being packaged (WI-10001751).
   *
   * An age ceiling cannot answer this question. `maximumArtifactAgeDays` is 30, and the r31
   * publication was cut 2026-09-07T09:18Z — SIX HOURS AND FIFTY-TWO MINUTES before agent-home
   * bundle v3 landed (96b0d248, 16:10Z the same day). So it was a well within-policy, 10-day-old,
   * fully-signed artifact that could not parse the only material the controller is permitted to
   * send (v3 alone is admission-eligible, D-311). Freshness in DAYS cannot see a skew measured in
   * HOURS against a contract boundary; only naming the versions can.
   *
   * Absent means "this publication predates the declaration", NOT "any version is fine" — see the
   * refusal in provision-bootstrap, which fails closed on exactly that reading.
   */
  agentHomeBundleContractVersions?: readonly string[];
}

/** One exact cell in the provider × architecture × host-model acceptance matrix. */
export type WorkspaceHostImageCompatibilityRule =
  WorkspaceHostImageCompatibilityRuleBase &
    (
      | {
          /** Omitted preserves the shipped pre-bootc artifact wire shape. */
          hostModel?: "ubuntu-release-bundle";
          ubuntuVersion: typeof WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION;
          bootcBaseImage?: never;
        }
      | {
          hostModel: "bootc-image";
          bootcBaseImage: string;
          ubuntuVersion?: never;
        }
    );

/** Immutable lifecycle edges. Every reference names both image id and version. */
export interface WorkspaceHostImageLifecycleMetadata {
  state: WorkspaceHostImageLifecycleState;
  publishedAt: string;
  deprecatedAt?: string;
  supportEndsAt?: string;
  successor?: WorkspaceHostImageRef & { version: string };
  rollbackTarget?: WorkspaceHostImageRef & { version: string };
}

/** The OCI identity a bootc host actually boots and verifies through containers/image. */
export interface WorkspaceHostBootcImageIdentity {
  /** Registry-qualified tagged source image; the digest below is the immutable identity. */
  image: string;
  imageDigest: `sha256:${string}`;
  baseImage: string;
  signaturePolicyPath: typeof WORKSPACE_HOST_CONTAINERS_POLICY_PATH;
}

interface WorkspaceHostImageArtifactBase {
  contractVersion: typeof WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION;
  image: WorkspaceHostImageRef & { version: string };
  buildManifest: WorkspaceHostBuildManifest;
  release: WorkspaceHostBootstrapRelease;
  lifecycle: WorkspaceHostImageLifecycleMetadata;
  compatibility: readonly WorkspaceHostImageCompatibilityRule[];
}

/**
 * Provider-neutral acceptance metadata around one immutable VM image release.
 * The canonical build manifest owns reproducible inputs; the bootstrap release
 * owns the runtime payload; the model-specific member owns the host identity.
 */
export type WorkspaceHostImageArtifact = WorkspaceHostImageArtifactBase &
  (
    | {
        /** Omitted preserves the shipped pre-bootc artifact wire shape. */
        hostModel?: "ubuntu-release-bundle";
        bootc?: never;
      }
    | {
        hostModel: "bootc-image";
        bootc: WorkspaceHostBootcImageIdentity;
      }
  );

export type WorkspaceHostImageCompatibilityIssueCode =
  | "invalid-artifact"
  | "invalid-observed-at"
  | "matrix-miss"
  | "action-not-supported"
  | "artifact-not-yet-published"
  | "stale-artifact"
  | "deprecated-artifact"
  | "withdrawn-artifact"
  | "support-ended"
  | "rollback-source-missing"
  | "rollback-target-mismatch";

export interface WorkspaceHostImageCompatibilityIssue {
  code: WorkspaceHostImageCompatibilityIssueCode;
  message: string;
}

interface WorkspaceHostImageCompatibilityRequestBase {
  action: WorkspaceHostImageAction;
  provider: WorkspaceHostProviderTarget;
  architecture: string;
  observedAt: string;
  /** Required for rollback so the current image's immutable edge can be checked. */
  currentArtifact?: WorkspaceHostImageArtifact;
}

export type WorkspaceHostImageCompatibilityRequest =
  WorkspaceHostImageCompatibilityRequestBase &
    (
      | {
          hostModel?: "ubuntu-release-bundle";
          ubuntuVersion: typeof WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION;
          bootcBaseImage?: never;
        }
      | {
          hostModel: "bootc-image";
          bootcBaseImage: string;
          ubuntuVersion?: never;
        }
    );

export interface WorkspaceHostImageCompatibilityResult {
  compatible: boolean;
  matchedRule?: WorkspaceHostImageCompatibilityRule;
  issues: readonly WorkspaceHostImageCompatibilityIssue[];
}

export interface WorkspaceHostCleanRoomInstallSpec {
  fixtureId: string;
  action: WorkspaceHostImageAction;
  provider: WorkspaceHostProviderTarget;
  architecture: string;
  /** Omitted preserves the shipped Ubuntu fixture. Bootc fixtures are explicit. */
  hostModel?: WorkspaceHostModel;
  /** Required by the bootc matrix; ignored nowhere and forbidden on the Ubuntu model. */
  bootcBaseImage?: string;
  observedAt: string;
  hostId: string;
  migrationId: string;
  minimumNodeMajor: number;
  service: WorkspaceHostBootstrapService;
  isolation?: WorkspaceHostBootstrapIsolation;
  /**
   * Keys to authorize for the workspace account. Optional here — unlike on
   * `WorkspaceHostBootstrapInput`, where it is required — because a clean-room VM is torn down
   * and has no controller to admit. Omitted ⇒ `WORKSPACE_HOST_CLEAN_ROOM_AUTHORIZED_KEY`, which
   * keeps the fixture script deterministic.
   */
  workspaceAuthorizedKeys?: readonly string[];
  entrypoints?: Partial<WorkspaceHostBootstrapEntrypoints>;
  publicMetadata?: Readonly<Record<string, unknown>>;
  currentArtifact?: WorkspaceHostImageArtifact;
}

export interface WorkspaceHostCleanRoomInstallFixture {
  contractVersion: typeof WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION;
  fixtureId: string;
  image: WorkspaceHostImageRef & { version: string };
  manifestIdentity: WorkspaceHostBuildManifest["manifestIdentity"];
  bootstrapInput: WorkspaceHostBootstrapInput;
  bootstrapScript: string;
  bootstrapScriptSha256: string;
}

export interface WorkspaceHostCleanRoomExecutor {
  execute(
    fixture: WorkspaceHostCleanRoomInstallFixture,
  ): Promise<{ stdout: string }>;
}

export type WorkspaceHostCleanRoomAcceptanceCheck =
  | "artifact-identity"
  | "compatibility-matrix"
  | "deterministic-bootstrap-fixture"
  | "exact-bootstrap-attestation";

export interface WorkspaceHostCleanRoomAcceptanceReport {
  contractVersion: typeof WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION;
  fixtureId: string;
  image: WorkspaceHostImageRef & { version: string };
  passed: boolean;
  checks: readonly WorkspaceHostCleanRoomAcceptanceCheck[];
  issues: readonly WorkspaceHostImageCompatibilityIssue[];
  bootstrapScriptSha256?: string;
  attestation?: WorkspaceHostBootstrapAttestation;
}

const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const REGISTRY_IMAGE =
  /^[a-z0-9][a-z0-9._-]*(?::\d{1,5})?(?:\/[a-z0-9][a-z0-9._-]*)+(?::[A-Za-z0-9][A-Za-z0-9._-]{0,127})?$/;
const DAY_MS = 24 * 60 * 60 * 1_000;

export function workspaceHostImageModel(
  artifact: Pick<WorkspaceHostImageArtifact, "hostModel">,
): WorkspaceHostModel {
  return artifact.hostModel ?? DEFAULT_WORKSPACE_HOST_MODEL;
}

function compatibilityModel(
  value: Pick<WorkspaceHostImageCompatibilityRule, "hostModel"> |
    Pick<WorkspaceHostImageCompatibilityRequest, "hostModel">,
): WorkspaceHostModel {
  return value.hostModel ?? DEFAULT_WORKSPACE_HOST_MODEL;
}

function compatibilityPlatform(value: WorkspaceHostImageCompatibilityRule): string {
  return compatibilityModel(value) === "bootc-image"
    ? value.bootcBaseImage ?? ""
    : value.ubuntuVersion ?? "";
}

/**
 * Report a non-string as the validation failure it is, rather than crashing on it.
 *
 * The parameter is TYPED `string`, so TypeScript is satisfied — but every caller here
 * validates values parsed from JSON on disk, where that guarantee does not hold. The bare
 * `value.trim()` therefore threw `Cannot read properties of undefined` for exactly the
 * malformed input this helper exists to reject, and because compatibility evaluation runs
 * outside `runWorkspaceHostCleanRoomAcceptance`'s try/catch, that TypeError escaped the whole
 * acceptance path instead of becoming a `passed: false` report naming the field.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireText(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${path} must be a non-empty string`);
  }
}

function timestamp(value: unknown, path: string, errors: string[]): number {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) errors.push(`${path} must be an ISO timestamp`);
  return parsed;
}

function sameImage(
  left: unknown,
  right: unknown,
): boolean {
  return (
    isRecord(left) &&
    isRecord(right) &&
    left.id === right.id &&
    left.version === right.version
  );
}

/** Verify every identity and lifecycle edge before compatibility is evaluated. */
export function validateWorkspaceHostImageArtifact(
  artifact: WorkspaceHostImageArtifact,
): readonly string[] {
  const errors: string[] = [];
  if (!isRecord(artifact)) {
    return ["artifact must be an object"];
  }
  if (
    artifact.contractVersion !==
    WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION
  ) {
    errors.push(
      `contractVersion must be '${WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION}'`,
    );
  }
  // Structural preconditions come first. Every check below reads THROUGH these sections, and
  // a validator whose entire job is to report what is wrong must not crash on the malformed
  // input it exists to reject: `runWorkspaceHostCleanRoomAcceptance` calls compatibility
  // evaluation OUTSIDE its try/catch, so a TypeError here escapes the acceptance path as an
  // opaque "Cannot read properties of undefined" instead of a `passed: false` report naming
  // the offending field.
  const section = (value: unknown, path: string): value is Record<string, unknown> => {
    const present = isRecord(value);
    if (!present) errors.push(`${path} must be an object`);
    return present;
  };
  const listSection = (value: unknown, path: string): value is readonly unknown[] => {
    const present = Array.isArray(value);
    if (!present) errors.push(`${path} must be an array`);
    return present;
  };
  const hasImage = section(artifact.image, "image");
  const hasManifest = section(artifact.buildManifest, "buildManifest");
  const hasRelease = section(artifact.release, "release");
  const hasLifecycle = section(artifact.lifecycle, "lifecycle");
  const hasCompatibility = listSection(artifact.compatibility, "compatibility");
  const hostModel = workspaceHostImageModel(artifact);
  if (!WORKSPACE_HOST_MODELS.includes(hostModel)) {
    errors.push(`unsupported hostModel '${String(hostModel)}'`);
  }
  const bootc = (artifact as unknown as Record<string, unknown>).bootc;
  const bootcRecord = isRecord(bootc) ? bootc : undefined;
  if (hostModel === "bootc-image") {
    if (!section(bootc, "bootc")) {
      // The section helper already names the structural error.
    } else {
      if (
        typeof bootcRecord?.image !== "string" ||
        !REGISTRY_IMAGE.test(bootcRecord.image)
      ) {
        errors.push("bootc.image must be a registry-qualified tagged image reference");
      }
      if (
        typeof bootcRecord?.imageDigest !== "string" ||
        !IMAGE_DIGEST.test(bootcRecord.imageDigest)
      ) {
        errors.push("bootc.imageDigest must be a lowercase sha256 manifest digest");
      }
      if (
        typeof bootcRecord?.baseImage !== "string" ||
        !REGISTRY_IMAGE.test(bootcRecord.baseImage)
      ) {
        errors.push("bootc.baseImage must be a registry-qualified image reference");
      }
      if (
        bootcRecord?.signaturePolicyPath !==
        WORKSPACE_HOST_CONTAINERS_POLICY_PATH
      ) {
        errors.push(
          `bootc.signaturePolicyPath must be '${WORKSPACE_HOST_CONTAINERS_POLICY_PATH}'`,
        );
      }
    }
  } else if (bootc !== undefined) {
    errors.push("bootc is valid only when hostModel is 'bootc-image'");
  }

  if (hasImage) {
    requireText(artifact.image.id, "image.id", errors);
    requireText(artifact.image.version, "image.version", errors);
  }

  if (hasManifest) {
    const manifest = verifyWorkspaceHostBuildManifest(artifact.buildManifest);
    if (!manifest.ok) {
      errors.push(...manifest.errors.map((error) => `buildManifest: ${error}`));
    }
  }
  const buildManifest = hasManifest
    ? (artifact.buildManifest as unknown as Record<string, unknown>)
    : undefined;
  const releaseArtifactValue = buildManifest?.releaseArtifact;
  const baseImageValue = buildManifest?.baseImage;
  const materialsValue = buildManifest?.materials;
  const targetsValue = buildManifest?.targets;
  section(releaseArtifactValue, "buildManifest.releaseArtifact");
  section(baseImageValue, "buildManifest.baseImage");
  listSection(materialsValue, "buildManifest.materials");
  listSection(targetsValue, "buildManifest.targets");
  const releaseArtifact = isRecord(releaseArtifactValue)
    ? releaseArtifactValue
    : undefined;
  const baseImage = isRecord(baseImageValue) ? baseImageValue : undefined;
  const materials = Array.isArray(materialsValue)
    ? (materialsValue as readonly unknown[])
    : undefined;
  const targets = Array.isArray(targetsValue)
    ? (targetsValue as readonly unknown[])
    : undefined;
  if (materials !== undefined) {
    materials.forEach((material: unknown, index: number) => {
      if (!isRecord(material)) {
        errors.push(`buildManifest.materials[${index}] must be an object`);
      }
    });
  }
  if (targets !== undefined) {
    targets.forEach((target: unknown, index: number) => {
      if (!isRecord(target)) {
        errors.push(`buildManifest.targets[${index}] must be an object`);
      }
    });
  }
  if (
    hasImage &&
    hasManifest &&
    releaseArtifact !== undefined &&
    artifact.image.version !== releaseArtifact.version
  ) {
    errors.push(
      "image.version must equal buildManifest.releaseArtifact.version",
    );
  }
  if (hasImage && hasRelease && artifact.release.version !== artifact.image.version) {
    errors.push("release.version must equal image.version");
  }

  // Nothing below can be evaluated without all three sections, and continuing would only
  // convert a clear structural rejection into a crash.
  if (
    !hasImage ||
    !hasManifest ||
    !hasRelease ||
    !hasLifecycle ||
    !hasCompatibility
  ) {
    return errors;
  }

  // The delegated provenance verifier expects the manifest's release artifact and materials to
  // have the runtime shapes it reads (`sha256.toLowerCase()` and `materials.find(...)`). The
  // manifest verifier reports malformed values, but deliberately catches its own exceptions;
  // do not call the lower-level verifier until these two nested sections are safe to traverse.
  const release = artifact.release as unknown as Record<string, unknown>;
  const canVerifyReleaseProvenance =
    releaseArtifact !== undefined &&
    materials !== undefined &&
    typeof releaseArtifact.sha256 === "string" &&
    typeof releaseArtifact.version === "string" &&
    materials.every(isRecord) &&
    typeof release.version === "string" &&
    typeof release.bundleSha256 === "string" &&
    typeof release.bundleUrl === "string" &&
    typeof release.signatureUrl === "string";

  // The release pins must be provenance-bound to the manifest above: same digest, same version,
  // an immutably addressed bundle, a matching detached signature, and a packaged executable
  // initializer. This is delegated rather than restated so the two surfaces cannot drift — the
  // digest and version equalities used to be duplicated here, which is exactly the second copy
  // that goes stale. The manifest's own self-consistency errors are dropped because they are
  // already reported above under the `buildManifest:` prefix; re-reporting them here would show
  // one defect twice and invite fixing it in the wrong place.
  if (canVerifyReleaseProvenance) {
    const provenance = verifyWorkspaceHostReleaseProvenance(
      artifact.buildManifest,
      artifact.release,
    );
    if (!provenance.ok) {
      errors.push(
        ...provenance.errors
          .filter((error) => !error.startsWith("manifest is not self-consistent:"))
          .map((error) => `release provenance: ${error}`),
      );
    }
  }

  if (
    typeof release.signingKeySha256 !== "string" ||
    !SHA256.test(release.signingKeySha256)
  ) {
    errors.push("release.signingKeySha256 must be a lowercase SHA-256 digest");
  }
  requireText(
    release.signingPublicKey,
    "release.signingPublicKey",
    errors,
  );
  if (
    typeof release.signingPublicKey === "string" &&
    typeof release.signingKeySha256 === "string" &&
    createHash("sha256")
      .update(release.signingPublicKey, "utf8")
      .digest("hex") !== release.signingKeySha256
  ) {
    errors.push(
      "release.signingKeySha256 must equal the SHA-256 of signingPublicKey",
    );
  }

  const lifecycle = artifact.lifecycle as unknown as Record<string, unknown>;
  const lifecycleState = lifecycle.state;
  const publishedAt = timestamp(
    lifecycle.publishedAt,
    "lifecycle.publishedAt",
    errors,
  );
  const deprecatedAt = lifecycle.deprecatedAt
    ? timestamp(
        lifecycle.deprecatedAt,
        "lifecycle.deprecatedAt",
        errors,
      )
    : undefined;
  const supportEndsAt = lifecycle.supportEndsAt
    ? timestamp(
        lifecycle.supportEndsAt,
        "lifecycle.supportEndsAt",
        errors,
      )
    : undefined;
  if (
    !WORKSPACE_HOST_IMAGE_LIFECYCLE_STATES.includes(
      lifecycleState as WorkspaceHostImageLifecycleState,
    )
  ) {
    errors.push(`unsupported lifecycle.state '${String(lifecycleState)}'`);
  }
  if (lifecycleState === "active" && deprecatedAt !== undefined) {
    errors.push("active artifacts must not carry lifecycle.deprecatedAt");
  }
  if (lifecycleState !== "active" && deprecatedAt === undefined) {
    errors.push(
      "deprecated/withdrawn artifacts require lifecycle.deprecatedAt",
    );
  }
  if (
    deprecatedAt !== undefined &&
    Number.isFinite(publishedAt) &&
    deprecatedAt < publishedAt
  ) {
    errors.push("lifecycle.deprecatedAt must not predate publishedAt");
  }
  if (
    supportEndsAt !== undefined &&
    Number.isFinite(publishedAt) &&
    supportEndsAt < publishedAt
  ) {
    errors.push("lifecycle.supportEndsAt must not predate publishedAt");
  }
  if (
    lifecycleState === "deprecated" &&
    !lifecycle.successor
  ) {
    errors.push("deprecated artifacts require an exact lifecycle.successor");
  }
  if (sameImage(artifact.image, lifecycle.successor)) {
    errors.push("lifecycle.successor must differ from the current image");
  }
  if (sameImage(artifact.image, lifecycle.rollbackTarget)) {
    errors.push("lifecycle.rollbackTarget must differ from the current image");
  }
  for (const [name, ref] of [
    ["lifecycle.successor", lifecycle.successor],
    ["lifecycle.rollbackTarget", lifecycle.rollbackTarget],
  ] as const) {
    if (ref !== undefined) {
      if (!isRecord(ref)) {
        errors.push(`${name} must be an object`);
      } else {
        requireText(ref.id, `${name}.id`, errors);
        requireText(ref.version, `${name}.version`, errors);
      }
    }
  }

  const compatibility = artifact.compatibility as readonly unknown[];
  if (compatibility.length === 0) {
    errors.push("compatibility must contain at least one matrix row");
  }
  const targetProviders = new Set(
    (targets ?? []).map((target: unknown) =>
      isRecord(target) ? target.provider : undefined,
    ),
  );
  const seen = new Set<string>();
  compatibility.forEach((rawRule, index) => {
    if (!isRecord(rawRule)) {
      errors.push(`compatibility[${index}] must be an object`);
      return;
    }
    const rule = rawRule as unknown as WorkspaceHostImageCompatibilityRule;
    const ruleHostModel = compatibilityModel(rule);
    requireText(rule.provider, `compatibility[${index}].provider`, errors);
    requireText(
      rule.architecture,
      `compatibility[${index}].architecture`,
      errors,
    );
    if (!targetProviders.has(rule.provider)) {
      errors.push(
        `compatibility[${index}].provider '${rule.provider}' is absent from buildManifest.targets`,
      );
    }
    if (
      rule.architecture !==
      (baseImage !== undefined ? baseImage.architecture : undefined)
    ) {
      errors.push(
        `compatibility[${index}].architecture must equal buildManifest.baseImage.architecture`,
      );
    }
    if (ruleHostModel !== hostModel) {
      errors.push(`compatibility[${index}].hostModel must equal artifact hostModel '${hostModel}'`);
    }
    if (ruleHostModel === "ubuntu-release-bundle") {
      if (rule.ubuntuVersion !== WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION) {
        errors.push(
          `compatibility[${index}].ubuntuVersion must be '${WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION}'`,
        );
      }
      if (rule.bootcBaseImage !== undefined) {
        errors.push(`compatibility[${index}].bootcBaseImage is invalid for the Ubuntu host model`);
      }
    } else {
      if (
        typeof rule.bootcBaseImage !== "string" ||
        !REGISTRY_IMAGE.test(rule.bootcBaseImage)
      ) {
        errors.push(`compatibility[${index}].bootcBaseImage must be a registry-qualified image reference`);
      }
      if (rule.bootcBaseImage !== bootcRecord?.baseImage) {
        errors.push(`compatibility[${index}].bootcBaseImage must equal bootc.baseImage`);
      }
      if (rule.ubuntuVersion !== undefined) {
        errors.push(`compatibility[${index}].ubuntuVersion is invalid for the bootc host model`);
      }
    }
    if (
      rule.bootstrapContractVersion !==
      WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION
    ) {
      errors.push(
        `compatibility[${index}].bootstrapContractVersion must be '${WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION}'`,
      );
    }
    if (!Array.isArray(rule.actions)) {
      errors.push(`compatibility[${index}].actions must be an array`);
    } else {
      if (rule.actions.length === 0) {
        errors.push(`compatibility[${index}].actions must not be empty`);
      }
      const uniqueActions = new Set(rule.actions);
      if (
        uniqueActions.size !== rule.actions.length ||
        rule.actions.some(
          (action) => !WORKSPACE_HOST_IMAGE_ACTIONS.includes(action),
        )
      ) {
        errors.push(
          `compatibility[${index}].actions must contain unique supported actions`,
        );
      }
    }
    if (
      rule.maximumArtifactAgeDays !== undefined &&
      (!Number.isSafeInteger(rule.maximumArtifactAgeDays) ||
        rule.maximumArtifactAgeDays <= 0)
    ) {
      errors.push(
        `compatibility[${index}].maximumArtifactAgeDays must be a positive integer`,
      );
    }
    const key = [
      rule.provider,
      rule.architecture,
      ruleHostModel,
      compatibilityPlatform(rule),
      typeof rule.bootstrapContractVersion === "string"
        ? rule.bootstrapContractVersion
        : "",
    ].join("\u0000");
    if (seen.has(key)) {
      errors.push(`compatibility contains duplicate matrix row ${index}`);
    }
    seen.add(key);
  });
  return errors;
}

/** Fail-closed compatibility verdict for one exact image artifact. */
export function evaluateWorkspaceHostImageCompatibility(
  artifact: WorkspaceHostImageArtifact,
  request: WorkspaceHostImageCompatibilityRequest,
): WorkspaceHostImageCompatibilityResult {
  const issues: WorkspaceHostImageCompatibilityIssue[] = [];
  const invalid = validateWorkspaceHostImageArtifact(artifact);
  if (invalid.length > 0) {
    return {
      compatible: false,
      issues: invalid.map((message) => ({
        code: "invalid-artifact",
        message,
      })),
    };
  }

  const observedAt = Date.parse(request.observedAt);
  if (!Number.isFinite(observedAt)) {
    return {
      compatible: false,
      issues: [
        {
          code: "invalid-observed-at",
          message: "observedAt must be an ISO timestamp",
        },
      ],
    };
  }
  const requestHostModel = compatibilityModel(request);
  const requestPlatform =
    requestHostModel === "bootc-image" ? request.bootcBaseImage : request.ubuntuVersion;
  const matchedRule = artifact.compatibility.find(
    (rule) =>
      rule.provider === request.provider &&
      rule.architecture === request.architecture &&
      compatibilityModel(rule) === requestHostModel &&
      compatibilityPlatform(rule) === requestPlatform &&
      rule.bootstrapContractVersion ===
        WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
  );
  if (!matchedRule) {
    return {
      compatible: false,
      issues: [
        {
          code: "matrix-miss",
          message: `No compatibility row matches ${request.provider}/${request.architecture}/${requestHostModel}/${requestPlatform}`,
        },
      ],
    };
  }
  if (!matchedRule.actions.includes(request.action)) {
    issues.push({
      code: "action-not-supported",
      message: `Compatibility row does not allow '${request.action}'`,
    });
  }

  const publishedAt = Date.parse(artifact.lifecycle.publishedAt);
  if (observedAt < publishedAt) {
    issues.push({
      code: "artifact-not-yet-published",
      message: "Artifact publication time is later than observedAt",
    });
  }
  if (artifact.lifecycle.state === "withdrawn") {
    issues.push({
      code: "withdrawn-artifact",
      message:
        "Withdrawn artifacts are never installable, upgradeable, or rollback targets",
    });
  } else if (
    artifact.lifecycle.state === "deprecated" &&
    request.action !== "rollback"
  ) {
    issues.push({
      code: "deprecated-artifact",
      message:
        "Deprecated artifacts are accepted only through an explicit rollback edge",
    });
  }
  if (
    artifact.lifecycle.supportEndsAt &&
    observedAt > Date.parse(artifact.lifecycle.supportEndsAt)
  ) {
    issues.push({
      code: "support-ended",
      message: `Artifact support ended at ${artifact.lifecycle.supportEndsAt}`,
    });
  }
  if (
    request.action !== "rollback" &&
    matchedRule.maximumArtifactAgeDays !== undefined &&
    observedAt - publishedAt > matchedRule.maximumArtifactAgeDays * DAY_MS
  ) {
    issues.push({
      code: "stale-artifact",
      message: `Artifact exceeds the ${matchedRule.maximumArtifactAgeDays}-day freshness ceiling`,
    });
  }
  if (request.action === "rollback") {
    if (!request.currentArtifact) {
      issues.push({
        code: "rollback-source-missing",
        message: "Rollback requires the currently installed artifact metadata",
      });
    } else {
      const invalidCurrentArtifact = validateWorkspaceHostImageArtifact(
        request.currentArtifact,
      );
      if (invalidCurrentArtifact.length > 0) {
        issues.push(
          ...invalidCurrentArtifact.map((message) => ({
            code: "invalid-artifact" as const,
            message: `currentArtifact: ${message}`,
          })),
        );
      } else if (
        !sameImage(
          request.currentArtifact.lifecycle.rollbackTarget,
          artifact.image,
        )
      ) {
        issues.push({
          code: "rollback-target-mismatch",
          message: `Current image ${request.currentArtifact.image.id}@${request.currentArtifact.image.version} does not name ${artifact.image.id}@${artifact.image.version} as its rollback target`,
        });
      }
    }
  }
  return { compatible: issues.length === 0, matchedRule, issues };
}

function fixtureBootstrapInput(
  artifact: WorkspaceHostImageArtifact,
  spec: WorkspaceHostCleanRoomInstallSpec,
): WorkspaceHostBootstrapInput {
  const hostModel = workspaceHostImageModel(artifact);
  const bootc = artifact.hostModel === "bootc-image" ? artifact.bootc : undefined;
  if (hostModel === "bootc-image" && !bootc) {
    throw new Error("bootc image artifact is missing its image identity");
  }
  return {
    contractVersion: WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
    action: spec.action,
    hostId: spec.hostId,
    hostModel,
    ...(hostModel === "bootc-image"
      ? {
          bootc: {
            image: bootc!.image,
            imageDigest: bootc!.imageDigest,
            baseImage: bootc!.baseImage,
            signaturePolicyPath: bootc!.signaturePolicyPath,
          },
        }
      : {}),
    release: artifact.release,
    migrationId: spec.migrationId,
    minimumNodeMajor: spec.minimumNodeMajor,
    service: spec.service,
    isolation: spec.isolation,
    workspaceAuthorizedKeys: spec.workspaceAuthorizedKeys?.length
      ? spec.workspaceAuthorizedKeys
      : [WORKSPACE_HOST_CLEAN_ROOM_AUTHORIZED_KEY],
    entrypoints: spec.entrypoints,
    publicMetadata: {
      ...spec.publicMetadata,
      imageAcceptance: {
        fixtureId: spec.fixtureId,
        provider: spec.provider,
        architecture: spec.architecture,
        imageId: artifact.image.id,
        imageVersion: artifact.image.version,
        manifestIdentity: artifact.buildManifest.manifestIdentity,
      },
    },
  };
}

function cleanRoomCompatibilityRequest(
  artifact: WorkspaceHostImageArtifact,
  spec: WorkspaceHostCleanRoomInstallSpec,
): WorkspaceHostImageCompatibilityRequest {
  const hostModel = spec.hostModel ?? workspaceHostImageModel(artifact);
  const common = {
    action: spec.action,
    provider: spec.provider,
    architecture: spec.architecture,
    observedAt: spec.observedAt,
    currentArtifact: spec.currentArtifact,
  } as const;
  return hostModel === "bootc-image"
    ? {
        ...common,
        hostModel,
        bootcBaseImage:
          spec.bootcBaseImage ??
          (artifact.hostModel === "bootc-image"
            ? artifact.bootc.baseImage
            : WORKSPACE_HOST_BOOTC_BASE_IMAGE),
      }
    : {
        ...common,
        hostModel,
        ubuntuVersion: WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
      };
}

/** Build the exact deterministic script a clean-room executor must run. */
export function buildWorkspaceHostCleanRoomInstallFixture(
  artifact: WorkspaceHostImageArtifact,
  spec: WorkspaceHostCleanRoomInstallSpec,
): WorkspaceHostCleanRoomInstallFixture {
  const compatibility = evaluateWorkspaceHostImageCompatibility(
    artifact,
    cleanRoomCompatibilityRequest(artifact, spec),
  );
  if (!compatibility.compatible) {
    throw new Error(
      `Workspace-host image is incompatible: ${compatibility.issues
        .map((issue) => `${issue.code}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  const fixtureErrors: string[] = [];
  requireText(spec.fixtureId, "fixtureId", fixtureErrors);
  if (fixtureErrors.length > 0) {
    throw new Error(fixtureErrors.join("; "));
  }
  const bootstrapInput = fixtureBootstrapInput(artifact, spec);
  const bootstrapScript = buildWorkspaceHostBootstrap(bootstrapInput);
  return {
    contractVersion: WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
    fixtureId: spec.fixtureId,
    image: artifact.image,
    manifestIdentity: artifact.buildManifest.manifestIdentity,
    bootstrapInput,
    bootstrapScript,
    bootstrapScriptSha256: createHash("sha256")
      .update(bootstrapScript, "utf8")
      .digest("hex"),
  };
}

/**
 * Run one deterministic clean-room install/upgrade/rollback fixture. The
 * executor is injected so repository tests use a hermetic fake while a VM rig
 * can run the identical signed bootstrap script without changing the contract.
 */
export async function runWorkspaceHostCleanRoomAcceptance(
  artifact: WorkspaceHostImageArtifact,
  spec: WorkspaceHostCleanRoomInstallSpec,
  executor: WorkspaceHostCleanRoomExecutor,
): Promise<WorkspaceHostCleanRoomAcceptanceReport> {
  const compatibility = evaluateWorkspaceHostImageCompatibility(
    artifact,
    cleanRoomCompatibilityRequest(artifact, spec),
  );
  const base = {
    contractVersion: WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
    fixtureId: spec.fixtureId,
    image: artifact.image,
  } as const;
  if (!compatibility.compatible) {
    return { ...base, passed: false, checks: [], issues: compatibility.issues };
  }

  let fixture: WorkspaceHostCleanRoomInstallFixture;
  try {
    fixture = buildWorkspaceHostCleanRoomInstallFixture(artifact, spec);
    const replay = buildWorkspaceHostCleanRoomInstallFixture(artifact, spec);
    if (
      fixture.bootstrapScript !== replay.bootstrapScript ||
      fixture.bootstrapScriptSha256 !== replay.bootstrapScriptSha256
    ) {
      throw new Error("clean-room bootstrap fixture is not deterministic");
    }
  } catch (error) {
    return {
      ...base,
      passed: false,
      checks: ["artifact-identity", "compatibility-matrix"],
      issues: [
        {
          code: "invalid-artifact",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  try {
    const result = await executor.execute(fixture);
    const attestation = parseWorkspaceHostBootstrapAttestation(result.stdout);
    const validation = validateWorkspaceHostBootstrapAttestation(
      attestation,
      fixture.bootstrapInput,
    );
    if (!validation.ok) {
      return {
        ...base,
        passed: false,
        checks: [
          "artifact-identity",
          "compatibility-matrix",
          "deterministic-bootstrap-fixture",
        ],
        issues: validation.errors.map((message) => ({
          code: "invalid-artifact",
          message: `clean-room attestation: ${message}`,
        })),
        bootstrapScriptSha256: fixture.bootstrapScriptSha256,
        attestation,
      };
    }
    return {
      ...base,
      passed: true,
      checks: [
        "artifact-identity",
        "compatibility-matrix",
        "deterministic-bootstrap-fixture",
        "exact-bootstrap-attestation",
      ],
      issues: [],
      bootstrapScriptSha256: fixture.bootstrapScriptSha256,
      attestation,
    };
  } catch (error) {
    return {
      ...base,
      passed: false,
      checks: [
        "artifact-identity",
        "compatibility-matrix",
        "deterministic-bootstrap-fixture",
      ],
      issues: [
        {
          code: "invalid-artifact",
          message: `clean-room execution: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      bootstrapScriptSha256: fixture.bootstrapScriptSha256,
    };
  }
}

/** Build an exact healthy attestation for deterministic fake clean-room executors. */
export function workspaceHostCleanRoomFixtureAttestation(
  fixture: WorkspaceHostCleanRoomInstallFixture,
  observedAt: string,
  nodeMajor = fixture.bootstrapInput.minimumNodeMajor,
): WorkspaceHostBootstrapAttestation {
  const serviceUser =
    fixture.bootstrapInput.service.user ?? DEFAULT_WORKSPACE_HOST_SERVICE_USER;
  const serviceGroup = fixture.bootstrapInput.service.group ?? serviceUser;
  const workspaceUser =
    fixture.bootstrapInput.isolation?.workspaceUser ??
    DEFAULT_WORKSPACE_HOST_WORKSPACE_USER;
  const workspaceGroup =
    fixture.bootstrapInput.isolation?.workspaceGroup ?? workspaceUser;
  const agentUser =
    fixture.bootstrapInput.isolation?.agentUser ??
    DEFAULT_WORKSPACE_HOST_AGENT_USER;
  const agentGroup = fixture.bootstrapInput.isolation?.agentGroup ?? agentUser;
  const common = {
    contractVersion: WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
    hostId: fixture.bootstrapInput.hostId,
    action: fixture.bootstrapInput.action,
    observedAt,
    status: "healthy",
    migration: { id: fixture.bootstrapInput.migrationId, applied: true },
    runtime: {
      nodeMajor,
      minimumNodeMajor: fixture.bootstrapInput.minimumNodeMajor,
      psu: true,
      pui: true,
      agentLaunchers: { claude: true, codex: true, omp: true },
      // A clean-room image is validated before any host provisioning runs, so no vendor agent
      // runtime has been installed at this point (D-259). False is the accurate reading, not a
      // placeholder — the fixture must not claim a capability the image does not carry.
      agentRuntimesInstalledByBootstrap: false,
      agentRuntimesVerifiedByBootstrap: false,
    },
    service: {
      name: fixture.bootstrapInput.service.name,
      user: serviceUser,
      group: serviceGroup,
      bindHost: "127.0.0.1",
      port: fixture.bootstrapInput.service.port,
      active: true,
    },
    isolation: {
      workspaceUser,
      workspaceGroup,
      agentUser,
      agentGroup,
      runtimeRoot: WORKSPACE_HOST_RUNTIME_ROOT,
      stateRoot: WORKSPACE_HOST_STATE_ROOT,
      workspaceRoot: WORKSPACE_HOST_DATA_ROOT,
      runtimeReadableByWorkspaceUser: false,
      runtimeWritableByWorkspaceUser: false,
      runtimeReadableByAgentUser: true,
      runtimeWritableByAgentUser: false,
      agentHomeReadableBySshUser: false,
      workspaceWritableByService: true,
      workspaceWritableBySshUser: true,
      workspaceWritableByAgentUser: true,
      sudo: false,
      serviceGroupMember: false,
      operatorIngress: "ssh-local-forward",
    },
  } as const;
  if (fixture.bootstrapInput.hostModel === "bootc-image") {
    const bootc = fixture.bootstrapInput.bootc;
    if (!bootc) throw new Error("bootc clean-room fixture is missing its image identity");
    return {
      ...common,
      hostModel: "bootc-image",
      bootcBaseImage: bootc.baseImage ?? WORKSPACE_HOST_BOOTC_BASE_IMAGE,
      release: {
        version: fixture.bootstrapInput.release.version,
        source: bootc.image,
        imageDigest: bootc.imageDigest,
        signaturePolicyPath: bootc.signaturePolicyPath,
        signatureVerified: true,
      },
      isolation: {
        ...common.isolation,
        updateMode: "bootc-atomic-image-swap",
      },
      checks: workspaceHostBootstrapChecks("bootc-image").map((name) => ({
        name,
        ok: true as const,
      })),
    };
  }
  return {
    ...common,
    hostModel: "ubuntu-release-bundle",
    ubuntuVersion: WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
    release: {
      version: fixture.bootstrapInput.release.version,
      source: fixture.bootstrapInput.release.bundleUrl,
      bundleSha256: fixture.bootstrapInput.release.bundleSha256,
      signingKeySha256: fixture.bootstrapInput.release.signingKeySha256,
      signatureVerified: true,
    },
    isolation: {
      ...common.isolation,
      updateMode: "signed-atomic-release-swap",
    },
    checks: workspaceHostBootstrapChecks("ubuntu-release-bundle").map((name) => ({
      name,
      ok: true as const,
    })),
  };
}
