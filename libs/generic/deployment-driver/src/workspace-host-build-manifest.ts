import { createHash } from "node:crypto";

import { canonicalize } from "@papercusp/publish-auth/jcs";

import type { WorkspaceHostProviderTarget } from "./workspace-host-types";

export const WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION =
  "papercusp-workspace-host-build-input-v1";
export const WORKSPACE_HOST_BUILD_MANIFEST_SCHEMA_VERSION = 1;
export const WORKSPACE_HOST_PACKER_BUILDER_KIND = "hashicorp-packer";
export const WORKSPACE_HOST_SIDECAR_BUILDER_KIND =
  "papercusp-desktop-sidecar";
/**
 * P-307 / D-254 — the bootc producer. One OCI image is built once, then
 * `bootc-image-builder` renders it to each cloud's disk format (gce / ami / vhd), so the
 * per-cloud BAKE paths collapse to one while the per-cloud PUBLISH adapters stay as they
 * are (each cloud's image registry genuinely differs, and D-253 keeps them).
 *
 * Its `templatePath` names a Containerfile, not a `.pkr.hcl` — see
 * WORKSPACE_HOST_BUILDER_TEMPLATE_SHAPES, which is what keeps a builder kind and the
 * template file it is handed from drifting apart.
 */
export const WORKSPACE_HOST_BOOTC_BUILDER_KIND = "bootc-image-builder";
export const WORKSPACE_HOST_BUILDER_KINDS = [
  WORKSPACE_HOST_PACKER_BUILDER_KIND,
  WORKSPACE_HOST_SIDECAR_BUILDER_KIND,
  WORKSPACE_HOST_BOOTC_BUILDER_KIND,
] as const;
export type WorkspaceHostBuilderKind =
  (typeof WORKSPACE_HOST_BUILDER_KINDS)[number];

/** Backward-compatible name for the D-047 VM-image builder. */
export const WORKSPACE_HOST_SHARED_BUILDER_KIND =
  WORKSPACE_HOST_PACKER_BUILDER_KIND;

/**
 * What a given builder kind's `templatePath` must LOOK like, and which kinds may produce a
 * VM image at all. Kept beside the kinds themselves so the two cannot drift: adding a kind
 * without deciding its template shape is a type error, not a runtime surprise.
 *
 * This table exists because the field used to be stored and never read. A manifest naming
 * the desktop-sidecar builder — whose "template" is a bash script — passed every gate and
 * died later at `packer init`, with an error naming Packer rather than the manifest field
 * that chose the file (EI-21750653220169836; the r8 workspace-host artifact shipped exactly
 * that way). The point is to refuse the manifest BEFORE anything billable runs, naming the
 * field that is actually wrong.
 *
 * `imageFamilyEligible: false` still gets a shape, deliberately: the sidecar bundle is a
 * real builder with a real template, it simply may not cut a VM image. Encoding that as a
 * missing entry would make "unknown kind" and "known kind, wrong job" indistinguishable —
 * the same collapse-two-causes-into-one-message defect this table is here to prevent.
 */
export interface WorkspaceHostBuilderTemplateShape {
  /** Matches the templatePath a build of this kind is handed. */
  readonly pattern: RegExp;
  /** Human description of the accepted shape, for the refusal message. */
  readonly description: string;
  /** Whether this kind may produce a workspace-host VM image release. */
  readonly imageFamilyEligible: boolean;
}

export const WORKSPACE_HOST_BUILDER_TEMPLATE_SHAPES: Readonly<
  Record<WorkspaceHostBuilderKind, WorkspaceHostBuilderTemplateShape>
> = {
  [WORKSPACE_HOST_PACKER_BUILDER_KIND]: {
    pattern: /\.pkr\.(hcl|json)$/,
    description: "a Packer template (.pkr.hcl or .pkr.json)",
    imageFamilyEligible: true,
  },
  [WORKSPACE_HOST_BOOTC_BUILDER_KIND]: {
    // bootc-image-builder consumes an OCI image built from a Containerfile; the manifest
    // pins the Containerfile because that is the in-repo, content-addressable input.
    pattern: /(^|\/)[^/]*Containerfile$/,
    description: "a Containerfile",
    imageFamilyEligible: true,
  },
  [WORKSPACE_HOST_SIDECAR_BUILDER_KIND]: {
    pattern: /\.(sh|mjs|ts)$/,
    description: "a sidecar build script (.sh, .mjs or .ts)",
    imageFamilyEligible: false,
  },
};

/**
 * The builder kinds that may cut a workspace-host VM image release, derived from the table
 * above rather than restated — a second hand-maintained list is how the two disagree.
 */
export const WORKSPACE_HOST_IMAGE_FAMILY_BUILDER_KINDS: readonly WorkspaceHostBuilderKind[] =
  WORKSPACE_HOST_BUILDER_KINDS.filter(
    (kind) => WORKSPACE_HOST_BUILDER_TEMPLATE_SHAPES[kind].imageFamilyEligible,
  );

export type WorkspaceHostBuildParameterValue = string | number | boolean;

export interface WorkspaceHostBuildMaterial {
  /** Repository-relative POSIX path. Absolute paths and traversal are refused. */
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly executable?: boolean;
}

export interface WorkspaceHostBuildParameter {
  readonly name: string;
  /** Build-shaping, non-secret value. Secret-shaped parameter names are refused. */
  readonly value: WorkspaceHostBuildParameterValue;
}

export interface WorkspaceHostBuildTarget {
  readonly provider: WorkspaceHostProviderTarget;
  /** Provider locations receiving identical built bytes. Empty means provider-global. */
  readonly locations: readonly string[];
}

export interface WorkspaceHostBuildManifestInput {
  readonly contractVersion: typeof WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION;
  readonly distributionProfile: "vm-release";
  readonly source: {
    readonly repository: string;
    /** Immutable Git object identity (SHA-1 or SHA-256 repository format). */
    readonly revision: string;
  };
  readonly releaseArtifact: {
    readonly name: string;
    readonly version: string;
    readonly sha256: string;
    readonly sizeBytes: number;
  };
  readonly baseImage: {
    readonly reference: string;
    readonly architecture: string;
    readonly sha256: string;
  };
  readonly builder: {
    readonly strategy: "shared";
    readonly kind: WorkspaceHostBuilderKind;
    readonly version: string;
    readonly templatePath: string;
    readonly templateSha256: string;
  };
  readonly materials: readonly WorkspaceHostBuildMaterial[];
  readonly parameters: readonly WorkspaceHostBuildParameter[];
  readonly targets: readonly WorkspaceHostBuildTarget[];
}

export interface WorkspaceHostBuildManifestPayload extends WorkspaceHostBuildManifestInput {
  readonly schemaVersion: typeof WORKSPACE_HOST_BUILD_MANIFEST_SCHEMA_VERSION;
}

export interface WorkspaceHostBuildManifest extends WorkspaceHostBuildManifestPayload {
  /** SHA-256 over RFC 8785 canonical JSON of the normalized payload, excluding this field. */
  readonly manifestIdentity: `sha256:${string}`;
}

export interface WorkspaceHostBuildManifestVerification {
  readonly ok: boolean;
  readonly expectedIdentity: `sha256:${string}`;
  readonly errors: readonly string[];
}

export class WorkspaceHostBuildManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceHostBuildManifestError";
  }
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
const GIT_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SECRET_PARAMETER =
  /(?:^|[-_.])(credential|password|private[-_]?key|secret|token)(?:$|[-_.])/i;
/**
 * GCP image references are provider resources, not guest-local labels or paths. Keep this
 * validator local to the provider-neutral manifest package so the release gate rejects a
 * non-image value before a provider adapter (or a billable build) is reached.
 */
const GCP_IMMUTABLE_IMAGE_REFERENCE =
  /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/global\/images\/[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const OCI_IMAGE_REFERENCE =
  /^[a-z0-9][a-z0-9._-]*(?::\d{1,5})?(?:\/[a-z0-9][a-z0-9._-]*)+(?::[A-Za-z0-9][A-Za-z0-9._-]{0,127})?$/;

/**
 * Material paths that name secret key material. The manifest is published beside the artifact it
 * describes, so enumerating a private key here leaks its existence and location even when the
 * bytes never leave the builder.
 *
 * Deliberately narrower than "contains the word key": a minisign PUBLIC key (`.pub`) is a
 * required part of a verifiable release and must keep passing.
 */
const SECRET_MATERIAL =
  /(?:^|[/_.-])(?:private[-_.]?key|secret|secrets|credential|credentials|password|passwd|token|id_rsa|id_ecdsa|id_ed25519)(?:$|[/_.-])|\.(?:pem|key|p12|pfx|jks|keystore)$/i;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireText(value: string, path: string): string {
  if (value.trim().length === 0)
    throw new WorkspaceHostBuildManifestError(
      `${path} must be a non-empty string`,
    );
  return value;
}

function requireSha256(value: string, path: string): string {
  if (!SHA256_HEX.test(value)) {
    throw new WorkspaceHostBuildManifestError(
      `${path} must be a lowercase 64-character SHA-256 hex digest`,
    );
  }
  return value;
}

function requireSize(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkspaceHostBuildManifestError(
      `${path} must be a non-negative safe integer`,
    );
  }
  return value;
}

function requireRelativePath(value: string, path: string): string {
  requireText(value, path);
  const segments = value.split("/");
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new WorkspaceHostBuildManifestError(
      `${path} must be a normalized repository-relative POSIX path`,
    );
  }
  return value;
}

function assertUnique(values: readonly string[], path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value))
      throw new WorkspaceHostBuildManifestError(
        `${path} contains duplicate '${value}'`,
      );
    seen.add(value);
  }
}

function normalizeMaterials(
  materials: readonly WorkspaceHostBuildMaterial[],
): WorkspaceHostBuildMaterial[] {
  if (materials.length === 0)
    throw new WorkspaceHostBuildManifestError(
      "materials must contain at least one build input",
    );
  materials.forEach((material, index) => {
    if (typeof material.path === "string" && SECRET_MATERIAL.test(material.path))
      throw new WorkspaceHostBuildManifestError(
        `materials[${index}].path ${material.path} names secret key material, which must never be enumerated in a published manifest`,
      );
  });
  const normalized = materials.map((material, index) => ({
    path: requireRelativePath(material.path, `materials[${index}].path`),
    sha256: requireSha256(material.sha256, `materials[${index}].sha256`),
    sizeBytes: requireSize(material.sizeBytes, `materials[${index}].sizeBytes`),
    ...(material.executable === undefined
      ? {}
      : { executable: material.executable }),
  }));
  assertUnique(
    normalized.map((material) => material.path),
    "materials",
  );
  return normalized.sort((left, right) => compareText(left.path, right.path));
}

function normalizeParameters(
  parameters: readonly WorkspaceHostBuildParameter[],
): WorkspaceHostBuildParameter[] {
  const normalized = parameters.map((parameter, index) => {
    const name = requireText(parameter.name, `parameters[${index}].name`);
    if (SECRET_PARAMETER.test(name)) {
      throw new WorkspaceHostBuildManifestError(
        `parameters[${index}].name '${name}' is secret-shaped and cannot enter the manifest`,
      );
    }
    if (
      typeof parameter.value === "number" &&
      !Number.isFinite(parameter.value)
    ) {
      throw new WorkspaceHostBuildManifestError(
        `parameters[${index}].value must be finite`,
      );
    }
    return { name, value: parameter.value };
  });
  assertUnique(
    normalized.map((parameter) => parameter.name),
    "parameters",
  );
  return normalized.sort((left, right) => compareText(left.name, right.name));
}

function normalizeTargets(
  targets: readonly WorkspaceHostBuildTarget[],
): WorkspaceHostBuildTarget[] {
  if (targets.length === 0)
    throw new WorkspaceHostBuildManifestError(
      "targets must contain at least one provider",
    );
  const normalized = targets.map((target, index) => {
    const provider = requireText(target.provider, `targets[${index}].provider`);
    const locations = target.locations.map((location, locationIndex) =>
      requireText(location, `targets[${index}].locations[${locationIndex}]`),
    );
    assertUnique(locations, `targets[${index}].locations`);
    return { provider, locations: [...locations].sort(compareText) };
  });
  assertUnique(
    normalized.map((target) => target.provider),
    "targets",
  );
  return normalized.sort((left, right) =>
    compareText(left.provider, right.provider),
  );
}

function normalizeBaseImageReference(
  reference: string,
  targets: readonly WorkspaceHostBuildTarget[],
  builderKind: WorkspaceHostBuilderKind,
): string {
  const normalized = requireText(reference, "baseImage.reference");
  if (builderKind === WORKSPACE_HOST_BOOTC_BUILDER_KIND) {
    if (!OCI_IMAGE_REFERENCE.test(normalized)) {
      throw new WorkspaceHostBuildManifestError(
        "baseImage.reference must be a registry-qualified OCI image reference for bootc-image-builder",
      );
    }
    return normalized;
  }
  if (
    targets.some((target) => target.provider === "gcp") &&
    !GCP_IMMUTABLE_IMAGE_REFERENCE.test(normalized)
  ) {
    throw new WorkspaceHostBuildManifestError(
      "baseImage.reference must be an immutable projects/{project}/global/images/{name} reference when a gcp target is present; family aliases are forbidden",
    );
  }
  return normalized;
}

export function normalizeWorkspaceHostBuildManifestInput(
  input: WorkspaceHostBuildManifestInput,
): WorkspaceHostBuildManifestPayload {
  if (input.contractVersion !== WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION) {
    throw new WorkspaceHostBuildManifestError(
      `contractVersion must be '${WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION}'`,
    );
  }
  if (input.distributionProfile !== "vm-release") {
    throw new WorkspaceHostBuildManifestError(
      "distributionProfile must be 'vm-release'",
    );
  }
  if (!GIT_REVISION.test(input.source.revision)) {
    throw new WorkspaceHostBuildManifestError(
      "source.revision must be a lowercase immutable Git SHA-1 or SHA-256 object id",
    );
  }
  if (
    input.builder.strategy !== "shared" ||
    !WORKSPACE_HOST_BUILDER_KINDS.includes(
      input.builder.kind as WorkspaceHostBuilderKind,
    )
  ) {
    throw new WorkspaceHostBuildManifestError(
      `builder must select a shared canonical producer (${WORKSPACE_HOST_BUILDER_KINDS.join(", ")})`,
    );
  }
  const normalizedTargets = normalizeTargets(input.targets);

  return {
    schemaVersion: WORKSPACE_HOST_BUILD_MANIFEST_SCHEMA_VERSION,
    contractVersion: input.contractVersion,
    distributionProfile: input.distributionProfile,
    source: {
      repository: requireText(input.source.repository, "source.repository"),
      revision: input.source.revision,
    },
    releaseArtifact: {
      name: requireText(input.releaseArtifact.name, "releaseArtifact.name"),
      version: requireText(
        input.releaseArtifact.version,
        "releaseArtifact.version",
      ),
      sha256: requireSha256(
        input.releaseArtifact.sha256,
        "releaseArtifact.sha256",
      ),
      sizeBytes: requireSize(
        input.releaseArtifact.sizeBytes,
        "releaseArtifact.sizeBytes",
      ),
    },
    baseImage: {
      reference: normalizeBaseImageReference(
        input.baseImage.reference,
        normalizedTargets,
        input.builder.kind,
      ),
      architecture: requireText(
        input.baseImage.architecture,
        "baseImage.architecture",
      ),
      sha256: requireSha256(input.baseImage.sha256, "baseImage.sha256"),
    },
    builder: {
      strategy: input.builder.strategy,
      kind: input.builder.kind,
      version: requireText(input.builder.version, "builder.version"),
      templatePath: requireRelativePath(
        input.builder.templatePath,
        "builder.templatePath",
      ),
      templateSha256: requireSha256(
        input.builder.templateSha256,
        "builder.templateSha256",
      ),
    },
    materials: normalizeMaterials(input.materials),
    parameters: normalizeParameters(input.parameters),
    targets: normalizedTargets,
  };
}

export function canonicalWorkspaceHostBuildManifestPayload(
  payload: WorkspaceHostBuildManifestPayload,
): string {
  // TypeScript's structural typing permits a full manifest at this boundary.
  // Strip the self-referential identity at runtime so every caller hashes only
  // the payload even when it passes the enriched object directly.
  const { manifestIdentity: _manifestIdentity, ...canonicalPayload } =
    payload as WorkspaceHostBuildManifest;
  return canonicalize(canonicalPayload);
}

function identityFor(
  payload: WorkspaceHostBuildManifestPayload,
): `sha256:${string}` {
  const digest = createHash("sha256")
    .update(canonicalWorkspaceHostBuildManifestPayload(payload), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

export function buildWorkspaceHostBuildManifest(
  input: WorkspaceHostBuildManifestInput,
): WorkspaceHostBuildManifest {
  const payload = normalizeWorkspaceHostBuildManifestInput(input);
  return { ...payload, manifestIdentity: identityFor(payload) };
}

export function verifyWorkspaceHostBuildManifest(
  manifest: WorkspaceHostBuildManifest,
): WorkspaceHostBuildManifestVerification {
  try {
    const {
      manifestIdentity,
      schemaVersion: _schemaVersion,
      ...input
    } = manifest;
    const payload = normalizeWorkspaceHostBuildManifestInput(input);
    const expectedIdentity = identityFor(payload);
    const errors = [
      ...(manifest.schemaVersion ===
      WORKSPACE_HOST_BUILD_MANIFEST_SCHEMA_VERSION
        ? []
        : [
            `schemaVersion must be ${WORKSPACE_HOST_BUILD_MANIFEST_SCHEMA_VERSION}`,
          ]),
      ...(manifestIdentity === expectedIdentity
        ? []
        : [
            `manifestIdentity ${manifestIdentity} does not match canonical payload ${expectedIdentity}`,
          ]),
    ];
    return { ok: errors.length === 0, expectedIdentity, errors };
  } catch (error) {
    return {
      ok: false,
      expectedIdentity: `sha256:${"0".repeat(64)}`,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

/**
 * Release provenance: does a bootstrap's release pin actually describe THIS build?
 *
 * A bootstrap release carries a URL and a digest, and nothing in the bootstrap module can tell
 * whether those describe a real artifact or were hand-typed into a test. That is not a
 * hypothetical gap: every publication URL in this repository today lives in a `.test.ts` file.
 * Binding the pin to a manifest is what makes fixture provenance DETECTABLE — a digest that
 * matches no build cannot pass, however plausible its hostname looks.
 *
 * This lives beside the manifest deliberately. The question "is this release the one this
 * manifest built?" is manifest truth, and answering it here keeps the dependency pointing one
 * way (bootstrap -> manifest, the direction `workspace-host-image` already uses) instead of
 * introducing a second release surface.
 */

/** Bundle-relative path of the remote initializer executable inside the extracted release. */
export const WORKSPACE_HOST_REMOTE_INITIALIZER_ENTRYPOINT =
  "bin/papercusp-remote-initializer";

/**
 * Bundle-relative path of the credential-delivery executable inside the extracted release.
 *
 * Separate from the remote initializer because the two programs have opposite relationships with
 * secret material (D-215); a bundle carrying one but not the other can initialize a host and then
 * fail every `git`/`agent` bind on it.
 *
 * ⚠ NAMED `deliver-material`, NOT `credential-delivery`, AND IT MUST STAY THAT WAY. `SECRET_MATERIAL`
 * below refuses any manifest path containing `credential`, because a published manifest enumerating
 * a credential path leaks its existence and location. This entry is a PROGRAM, not key material, so
 * the refusal is a false positive — but the guard is a NAME heuristic and cannot tell the two apart.
 * Renaming the file is the honest fix; exempting `bin/` or `executable: true` would punch a hole
 * through which a real credential path could later pass. Do not "restore" the obvious name.
 */
export const WORKSPACE_HOST_CREDENTIAL_DELIVERY_ENTRYPOINT =
  "bin/papercusp-deliver-material";

/** Inert until the optional desktop pack installs its socket-activated service. */
export const WORKSPACE_HOST_DESKTOP_SESSION_ENTRYPOINT = "bin/papercusp-desktop-session.cjs";

/** Bundle-relative PUI generation installed and attested as one immutable release unit. */
export const WORKSPACE_HOST_PUI_ENTRYPOINT = "bin/pui";
export const WORKSPACE_HOST_PUI_COMPANION_PATH = "pui-companion.wasm";
export const WORKSPACE_HOST_PUI_INSTALL_MANIFEST_PATH = "pui-install.json";

export interface WorkspaceHostRequiredReleaseMaterial {
  readonly path: string;
  readonly executable?: true;
}

/**
 * Runtime materials without which a signed bundle can install successfully but cannot actually
 * initialize a remote workspace or prove that its PUI binary and companion came from one build.
 * Keep this as the single release-gate contract; producers and fixtures consume these exported
 * paths rather than maintaining parallel required-material lists.
 */
export const WORKSPACE_HOST_REQUIRED_RELEASE_MATERIALS: readonly WorkspaceHostRequiredReleaseMaterial[] =
  [
    { path: WORKSPACE_HOST_REMOTE_INITIALIZER_ENTRYPOINT, executable: true },
    { path: WORKSPACE_HOST_CREDENTIAL_DELIVERY_ENTRYPOINT, executable: true },
    { path: WORKSPACE_HOST_DESKTOP_SESSION_ENTRYPOINT, executable: true },
    { path: WORKSPACE_HOST_PUI_ENTRYPOINT, executable: true },
    { path: WORKSPACE_HOST_PUI_COMPANION_PATH },
    { path: WORKSPACE_HOST_PUI_INSTALL_MANIFEST_PATH },
  ];

/**
 * Path segments naming a MUTABLE release channel. A URL ending in one of these can serve
 * different bytes tomorrow, so pinning a digest against it is a promise the URL cannot keep.
 */
const MUTABLE_URL_SEGMENT =
  /^(?:latest|stable|current|main|master|edge|head|nightly|rolling|dev|unstable)(?:\.[A-Za-z0-9.]+)?$/i;

/**
 * Reserved and non-resolvable TLDs (RFC 2606 / RFC 6761). A host under one of these can never
 * be a real publication target, so its presence is positive evidence of fixture provenance
 * rather than a mere absence of evidence.
 */
const FIXTURE_HOST = /(?:^|\.)(?:invalid|test|example|localhost|local|internal)$/i;

/**
 * A content-addressed path segment pair — `/sha256/<64 hex>` followed by a `/` or the end of the
 * path. Anchoring on the `sha256/` label rather than "a 64-hex run anywhere in the string" is
 * deliberate: a bare hex run also matches a query value or a hostname, neither of which addresses
 * the artifact, so a looser pattern would accept a mutable URL that merely mentions a digest.
 */
const CONTENT_ADDRESSED_DIGEST = /\/sha256\/([0-9a-fA-F]{64})(?=\/|$)/;

/**
 * The pathname of a URL, or the empty string when it does not parse. An unparseable URL is
 * reported by the shape checks; returning empty here keeps the addressing rules from reading a
 * digest out of a string that is not a URL at all.
 */
function urlPathname(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return "";
  }
}

/**
 * The published origin for workspace-host release artifacts.
 *
 * This is the maintained artifact origin, extended rather than replaced: a second publisher would
 * be a parallel release system, which is precisely what this lane must not build.
 *
 * ⚠ The BRANDED host, deliberately — not the Worker's own `*.workers.dev` origin. Both names route
 * to the same Worker and serve byte-identical bodies, but the workers.dev form embeds the
 * Cloudflare ACCOUNT SUBDOMAIN, which is the release owner's GitHub handle. Because this constant
 * is bundled into the shipped host, using that form compiled a personal identity string into every
 * release and forced an acceptance in the release identity gate (WI-38233 disclosed it; WI-38321
 * removed it). Callers that genuinely need another origin pass `options.origin`; do not reintroduce
 * an account-bearing hostname here.
 *
 * ⚠ FROM THE PAPERCUSP DEV BOX this hostname will not resolve or connect: that box silently
 * blackholes TLS to every papercusp-family name by SNI (EI-16742,
 * agent-insights/su-box-sni-tls-blackhole-not-outage). A local timeout here is NOT evidence the
 * origin is down, and must not be "fixed" by pointing this back at workers.dev.
 */
export const WORKSPACE_HOST_ARTIFACT_ORIGIN = "https://cupboard.papercusp.com";

/** The published path prefix under which workspace-host artifacts are content-addressed. */
export const WORKSPACE_HOST_ARTIFACT_PATH_PREFIX = "/artifacts/workspace-host";

/** The three artifacts published together for one workspace-host bundle. */
export interface WorkspaceHostCanonicalArtifactUrls {
  readonly bundleUrl: string;
  readonly signatureUrl: string;
  readonly manifestUrl: string;
}

/**
 * Derive the canonical published URLs for a bundle from its verified digest.
 *
 * This exists so that a bootstrap config or manifest never has to author these URLs by hand, and
 * therefore can never *default* to a fixture host or a mutable `latest` path when a digest is
 * missing: an absent or malformed digest THROWS rather than yielding a plausible-looking URL.
 * Deriving from the digest is also what makes the resulting pin self-verifying — the address and
 * the integrity check are the same value.
 */
export function deriveWorkspaceHostCanonicalArtifactUrls(
  bundleSha256: string,
  options: { readonly origin?: string } = {},
): WorkspaceHostCanonicalArtifactUrls {
  const digest = requireText(bundleSha256, "bundleSha256").toLowerCase();
  if (!SHA256_HEX.test(digest))
    throw new Error(
      "bundleSha256 must be a lowercase SHA-256 digest; canonical artifact URLs are derived from the digest and must never be defaulted",
    );

  const origin = options.origin ?? WORKSPACE_HOST_ARTIFACT_ORIGIN;
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new Error(`origin ${origin} must be a valid public HTTPS URL`);
  }
  if (parsedOrigin.protocol !== "https:")
    throw new Error(`origin ${origin} must use HTTPS`);
  if (FIXTURE_HOST.test(parsedOrigin.hostname))
    throw new Error(
      `origin host ${parsedOrigin.hostname} is a reserved non-resolvable name, not a publication target`,
    );

  const base = `${parsedOrigin.origin}${WORKSPACE_HOST_ARTIFACT_PATH_PREFIX}/sha256/${digest}`;
  const bundleUrl = `${base}/server.tgz`;
  return {
    bundleUrl,
    signatureUrl: `${bundleUrl}.minisig`,
    manifestUrl: `${base}/manifest.json`,
  };
}

/** The release pins a bootstrap config carries, as the subset provenance can adjudicate. */
export interface WorkspaceHostReleasePins {
  readonly version: string;
  readonly bundleUrl: string;
  readonly bundleSha256: string;
  readonly signatureUrl: string;
}

export interface WorkspaceHostReleaseProvenanceResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

/**
 * The release-addressing rule, shared by every surface that pins a workspace-host bundle.
 *
 * D-106 requires build manifests, bootstrap configuration, validators and fixtures to agree on
 * ONE rule for what makes a pin immutable rather than each restating it. Two callers can prove
 * different things, so the caller passes the digest/version it can actually stand behind:
 *
 *   - the build manifest proves them from the artifact it just built;
 *   - the bootstrap contract proves them from the pins the release itself carries, which makes
 *     this a SELF-CONSISTENCY check — the URL must address the very digest the host is about to
 *     verify after download. Without it, `requirePublicHttpsUrl` would happily accept a mutable
 *     `.../latest.tgz` alongside a well-formed digest that nothing ties it to, and that URL is
 *     baked into a script that runs as root on the host.
 *
 * Because both callers run the same rule, a URL accepted by one surface cannot be rejected by
 * the other — which is the property that kept drifting when the rule was written out twice.
 */
export function workspaceHostReleaseAddressingErrors(
  release: WorkspaceHostReleasePins,
  expected: {
    readonly sha256: string;
    readonly version: string;
    /**
     * How the caller names the artifact it can prove, so the message stays accurate on both
     * surfaces: the manifest proves "the built artifact"; bootstrap proves the digest the
     * release pins.
     */
    readonly subject?: string;
  },
): string[] {
  const errors: string[] = [];
  const expectedDigest = expected.sha256.toLowerCase();
  const subject = expected.subject ?? "the built artifact";

  errors.push(...immutableUrlErrors(release.bundleUrl, "release.bundleUrl"));
  errors.push(
    ...immutableUrlErrors(release.signatureUrl, "release.signatureUrl"),
  );

  // The signature must be the detached companion of the bundle it signs. Allowing an unrelated
  // signature URL would let a valid signature over a DIFFERENT artifact satisfy the check.
  if (release.signatureUrl !== `${release.bundleUrl}.minisig`)
    errors.push(
      "release.signatureUrl must be release.bundleUrl suffixed with .minisig",
    );

  // An immutable pin needs the URL to name WHICH artifact it addresses — otherwise the same URL
  // can be re-pointed at a different build without the pin changing. Two forms qualify:
  //
  //   content-addressed  .../sha256/<bundleSha256>/server.tgz   (the canonical published path)
  //   version-embedded   .../<version>/server.tgz
  //
  // The content-addressed form is strictly stronger and is therefore checked first: the digest
  // IS the immutability proof, where a version string only promises one. A content-addressed URL
  // whose digest is NOT the expected one is a HARDER failure than an unpinned one — it does not
  // merely fail to prove immutability, it positively addresses a different artifact — so it is
  // reported as a mismatch rather than falling through to the version-embedding rule.
  if (release.bundleUrl.length > 0) {
    // Match against the PATH only. A digest in a query string or fragment does not determine
    // which bytes the origin serves, so treating one as an address would accept a mutable URL
    // that merely mentions the digest it is supposed to be pinned to.
    const contentAddress = CONTENT_ADDRESSED_DIGEST.exec(
      urlPathname(release.bundleUrl),
    );
    if (contentAddress) {
      const addressedDigest = (contentAddress[1] ?? "").toLowerCase();
      if (addressedDigest !== expectedDigest)
        errors.push(
          `release.bundleUrl is content-addressed at ${addressedDigest}, which is not ${subject} ${expectedDigest}`,
        );
    } else if (!release.bundleUrl.includes(expected.version))
      errors.push(
        `release.bundleUrl must be content-addressed under /sha256/${expectedDigest}/ or embed the release version ${expected.version} so the pin is immutable`,
      );
  }

  return errors;
}

function immutableUrlErrors(value: string, label: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return [`${label} must be a valid public HTTPS URL`];
  }
  const errors: string[] = [];
  if (parsed.protocol !== "https:") errors.push(`${label} must use HTTPS`);
  if (FIXTURE_HOST.test(parsed.hostname))
    errors.push(
      `${label} host ${parsed.hostname} is a reserved non-resolvable name, not a publication target`,
    );
  const segments = parsed.pathname.split("/").filter((part) => part.length > 0);
  const basename = segments.at(-1) ?? "";
  if (basename.length === 0)
    errors.push(`${label} must address a file, not a directory`);
  if (segments.some((segment) => MUTABLE_URL_SEGMENT.test(segment)))
    errors.push(
      `${label} must not point at a mutable release channel; pin an immutable versioned path`,
    );
  return errors;
}

/**
 * Verify that a release pin is the artifact this manifest built.
 *
 * Returns every failure rather than throwing on the first, because a caller repairing a release
 * config wants the whole list — and because a single reported error invites fixing that one
 * symptom while the rest of the provenance stays broken.
 */
export function verifyWorkspaceHostReleaseProvenance(
  manifest: WorkspaceHostBuildManifest,
  release: WorkspaceHostReleasePins,
): WorkspaceHostReleaseProvenanceResult {
  const errors: string[] = [];

  const manifestVerification = verifyWorkspaceHostBuildManifest(manifest);
  if (!manifestVerification.ok)
    errors.push(
      ...manifestVerification.errors.map(
        (error) => `manifest is not self-consistent: ${error}`,
      ),
    );

  const expectedDigest = manifest.releaseArtifact.sha256.toLowerCase();
  const pinnedDigest = release.bundleSha256.toLowerCase();
  if (!SHA256_HEX.test(pinnedDigest))
    errors.push("release.bundleSha256 must be a lowercase SHA-256 digest");
  else if (pinnedDigest !== expectedDigest)
    errors.push(
      `release.bundleSha256 ${pinnedDigest} does not match the built artifact ${expectedDigest}`,
    );

  if (release.version !== manifest.releaseArtifact.version)
    errors.push(
      `release.version ${release.version} does not match the built artifact version ${manifest.releaseArtifact.version}`,
    );

  // The addressing rule lives in one place (see workspaceHostReleaseAddressingErrors) so the
  // bootstrap contract cannot drift from it. Here the manifest is the authority for what the
  // URL must address, because it just built the artifact.
  errors.push(
    ...workspaceHostReleaseAddressingErrors(release, {
      sha256: expectedDigest,
      version: manifest.releaseArtifact.version,
    }),
  );

  for (const required of WORKSPACE_HOST_REQUIRED_RELEASE_MATERIALS) {
    const material = manifest.materials.find(
      (candidate) => candidate.path === required.path,
    );
    if (!material) {
      errors.push(`materials must include required release material ${required.path}`);
      continue;
    }
    if (material.sizeBytes === 0)
      errors.push(`${required.path} must be non-empty`);
    if (required.executable === true && material.executable !== true)
      errors.push(`${required.path} must be marked executable`);
  }

  return { ok: errors.length === 0, errors };
}
