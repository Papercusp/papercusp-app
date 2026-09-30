/**
 * Assemble the GCP workspace-host IMAGE-family release request — and the image-scoped artifact
 * every stage of it is bound to.
 *
 * This is the missing producer named by D-193. `gcp-image-family-release-cli` consumes a request
 * file whose header calls its gate evidence "already-verified", and `executeGcpImageFamilyRelease`
 * ratifies that evidence before it authorizes a billable Packer build — but nothing in the tree
 * ever ASSEMBLED the request, so `releaseGate.artifact` could only ever be hand-written. The same
 * gap D-192 closed one layer down, with the same consequence: a hand-written artifact is an
 * assertion, and the gate exists to refuse assertions.
 *
 * ## Why the published-bundle artifact cannot simply be reused
 *
 * The publication manifest (D-192) describes how `server.tgz` was built: a sidecar bash builder,
 * a host `/etc/os-release` base, and the bare image id `papercusp-workspace-host`. The image
 * release describes a different build — Packer, over an immutable Ubuntu image, producing a
 * specific GCP image resource — and the gate enforces exactly that difference:
 *
 *   - `workspace-host-release-gate.ts` rejects any `builder.kind` that is not `hashicorp-packer`
 *     and any `builder.templatePath` that is not a Packer template. The comment there records
 *     the r8 cut dying at `packer init` because a sidecar manifest passed every other check
 *     (EI-21750653220169836).
 *   - `gcp-image-family.ts` parses `artifact.image.id` as an immutable
 *     `projects/{project}/global/images/{name}` reference; family aliases and bare names fail.
 *   - the adapter re-reads `builder.templatePath` off disk and refuses unless its digest equals
 *     the pinned `builder.templateSha256`, and passes `baseImage.reference` through the same
 *     immutable-id parser.
 *
 * What DOES carry over is the trust report, and this file transcribes rather than recomputes it.
 * Its subject is the published bundle, and the gate only requires that subject digest to equal
 * `release.bundleSha256` and `buildManifest.releaseArtifact.sha256`. Re-running the trust
 * pipeline here would produce a second measurement that can disagree with the evidence actually
 * shipped beside the bundle — precisely the drift D-191 found in the r10 manifest.
 *
 * ## The property this file exists to guarantee
 *
 * The release gate compares the clean-room report's image identity against the artifact's
 * (`sameImage`), so a report produced under a different artifact is refused — correctly, but
 * expensively, since discovering it costs a full clean-room boot. Both the clean-room INPUT and
 * the release REQUEST are therefore emitted from ONE artifact built once, in `imageArtifact()`.
 * That makes the mismatch structurally impossible instead of merely fixed: there is no second
 * definition to drift from, and the `--emit request` path re-checks the pairing anyway, because
 * a report can always arrive from an older run.
 *
 * ## Measured, never accepted from the caller
 *
 *   - `builder.templateSha256` — hashed from the template on disk, under `--repo-root`. The
 *     adapter checks this digest before it spends a build, so a hand-typed value is a build that
 *     fails late for a reason that names Packer rather than the field that chose the file.
 *   - the release bundle's digest, size, version and URLs, and the whole trust report — read from
 *     the publication manifest, which measured them from the bytes it published.
 *   - material digests and sizes, measured from `--source-root` when the input omits them.
 *   - `builder.kind`, which is pinned to the Packer kind rather than read from input.
 *
 * Everything the publication directory cannot know — the target project, image name, family,
 * base image, clean-room placement and compatibility request — comes from the input file and is
 * validated, not defaulted. A missing value is refused; none is silently invented.
 */
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute, resolve } from "node:path";

import {
  WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
  WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
  WORKSPACE_HOST_PACKER_BUILDER_KIND,
  buildWorkspaceHostBuildManifest,
  type WorkspaceHostBuildManifestInput,
  type WorkspaceHostBuildMaterial,
  type WorkspaceHostBuildParameter,
  type WorkspaceHostBuildTarget,
  type WorkspaceHostImageArtifact,
} from "@papercusp/deployment-driver";
import { isCliEntry } from "@papercusp/operator-core/lib/util/cli-entry";
import {
  buildGcpImageFamilyExactPathReadinessConfig,
  isSupportedGcpImageFamilyCredentialRef,
  type GcpImageFamilyExactPathReadinessConfig,
} from "@papercusp/operator-core/lib/workspace-host/gcp-image-family-production";

/** Immutable GCP image reference. Family aliases are deliberately not accepted anywhere here. */
const IMMUTABLE_IMAGE_ID =
  /^projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/global\/images\/([a-z]([-a-z0-9]{0,61}[a-z0-9])?)$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const RESOURCE_NAME = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
/** The gcloud active-user credential. Service-account KEY files are refused by gcp-preflight. */
const GCLOUD_ACTIVE_USER_CREDENTIAL_REF = "gcloud://active-user";

export interface GcpImageReleaseRequestCliArgs {
  inputFile: string;
  repoRoot: string;
  sourceRoot?: string;
  cleanRoomReportFile?: string;
  emit: "artifact" | "clean-room-input" | "request";
  /**
   * Which credential chain the emitted connection names. Defaults to the gcloud active user.
   *
   * This is EXPLICIT on purpose. The composition seam strips GOOGLE_APPLICATION_CREDENTIALS,
   * GOOGLE_OAUTH_ACCESS_TOKEN and CLOUDSDK_AUTH_ACCESS_TOKEN from every child environment so a
   * release cannot quietly fall back to ambient ADC, and an automatic fallback here would hand
   * that property straight back: the emitted request would no longer say which identity performed
   * the release. So the caller names the chain, or gets the default — never a silent substitution
   * when the default's token happens to be unavailable.
   */
  credentialRef: string;
}

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    fail(`${label} must be a non-empty string`);
  return (value as string).trim();
}

/**
 * A string copied through VERBATIM, whitespace included.
 *
 * `requiredString` trims, which is right for identifiers and catastrophic for the signing public
 * key: its digest is taken over the exact bytes, trailing newline and all, so trimming it emits an
 * artifact whose `signingKeySha256` no longer pins its own key. The gate rejects that — correctly,
 * and with a message that points at the digest rather than at the trim that caused it.
 */
function requiredVerbatimString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    fail(`${label} must be a non-empty string`);
  return value as string;
}

function requiredRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be an object`);
  return value;
}

function requiredDigest(value: unknown, label: string): string {
  const digest = requiredString(value, label).toLowerCase();
  if (!SHA256_HEX.test(digest))
    fail(`${label} must be a lowercase 64-character SHA-256 hex digest`);
  return digest;
}

function requiredImmutableImageId(value: unknown, label: string): string {
  const id = requiredString(value, label);
  if (!IMMUTABLE_IMAGE_ID.test(id)) {
    fail(
      `${label} must be an immutable projects/{project}/global/images/{name} reference; family aliases are forbidden`,
    );
  }
  return id;
}

function requiredTimestamp(value: unknown, label: string): string {
  const raw = requiredString(value, label);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) fail(`${label} must be an ISO-8601 timestamp`);
  return raw;
}

/**
 * Repository-relative POSIX path, matching the adapter's own rule. Rejecting traversal here
 * rather than at the adapter keeps the refusal next to the field the operator actually typed.
 */
function repoRelativePath(value: unknown, label: string): string {
  const path = requiredString(value, label);
  if (
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(`${label} must be a normalized repository-relative POSIX path`);
  }
  return path;
}

async function digestOfFile(
  absolutePath: string,
  label: string,
): Promise<{ sha256: string; sizeBytes: number }> {
  let bytes: Buffer;
  try {
    bytes = await readFile(absolutePath);
  } catch {
    fail(`${label} could not be read at ${absolutePath}`);
  }
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
  };
}

export function parseGcpImageReleaseRequestCliArgs(
  argv: readonly string[],
): GcpImageReleaseRequestCliArgs {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) fail(`unexpected argument ${token}`);
    const key = token.slice(2);
    const allowed = new Set([
      "input-file",
      "repo-root",
      "source-root",
      "clean-room-report",
      "emit",
      "credential-ref",
    ]);
    if (!allowed.has(key)) fail(`unknown flag --${key}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--"))
      fail(`--${key} requires a value`);
    values[key] = next;
    index += 1;
  }
  const emit = values.emit ?? "request";
  if (
    emit !== "artifact" &&
    emit !== "clean-room-input" &&
    emit !== "request"
  ) {
    fail("--emit must be one of: artifact, clean-room-input, request");
  }
  if (!values["input-file"]) fail("--input-file is required");
  if (emit === "request" && !values["clean-room-report"]) {
    fail(
      "--emit request requires --clean-room-report (the gate ratifies a report, never an assertion)",
    );
  }
  const credentialRef = (
    values["credential-ref"] ?? GCLOUD_ACTIVE_USER_CREDENTIAL_REF
  ).trim();
  // Refuse an unusable chain HERE rather than letting the release reach the composition seam and
  // die at `connectionCredentialRef`. The accepted set is imported, never restated, so this edge
  // cannot drift away from the seam that ultimately enforces it.
  if (!isSupportedGcpImageFamilyCredentialRef(credentialRef)) {
    fail(
      `--credential-ref must be ${GCLOUD_ACTIVE_USER_CREDENTIAL_REF} or adc://<safe-chain>; ` +
        "hosted references require an explicit resolver and are not accepted by the release composition seam",
    );
  }
  return {
    inputFile: values["input-file"]!,
    repoRoot: values["repo-root"] ?? process.cwd(),
    ...(values["source-root"] ? { sourceRoot: values["source-root"] } : {}),
    ...(values["clean-room-report"]
      ? { cleanRoomReportFile: values["clean-room-report"] }
      : {}),
    emit,
    credentialRef,
  };
}

async function readJson(
  path: string,
  label: string,
): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    fail(`${label} could not be read at ${path}`);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return requiredRecord(parsed, label);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    fail(`${label} is not valid JSON`);
  }
}

/**
 * Materials describe the repository inputs the image build consumes. Digests may be omitted and
 * measured from `--source-root`, which is the point: hand-typing digests is how a manifest starts
 * describing a build that did not happen.
 */
async function resolveMaterials(
  raw: unknown,
  sourceRoot: string | undefined,
  publishedMaterials: ReadonlyMap<string, WorkspaceHostBuildMaterial>,
): Promise<readonly WorkspaceHostBuildMaterial[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    // The manifest normalizer refuses an empty list, and rightly: a build manifest that names no
    // inputs describes nothing. Refusing here names the input field instead of surfacing as a
    // WorkspaceHostBuildManifestError from two layers down.
    fail("materials must list at least one build input");
  }
  const materials: WorkspaceHostBuildMaterial[] = [];
  for (const [index, entry] of raw.entries()) {
    const record = requiredRecord(entry, `materials[${index}]`);
    const path = repoRelativePath(record.path, `materials[${index}].path`);
    const executable = record.executable === true;
    // Some materials are not repository files at all — the remote initializer the provenance rule
    // requires is a BUILT artifact inside the published bundle, addressed by its bundle-relative
    // path. Its digest was already measured when the bundle was published, so transcribe that
    // measurement rather than re-deriving it from a path that means something else here.
    if (record.from === "publication-manifest") {
      const published = publishedMaterials.get(path);
      if (!published) {
        fail(
          `materials[${index}] asks for the publication manifest's measurement of ${path}, ` +
            `but that manifest records no material at that path`,
        );
      }
      materials.push(published);
      continue;
    }
    if (record.sha256 === undefined || record.sizeBytes === undefined) {
      if (!sourceRoot) {
        fail(
          `materials[${index}] omits sha256/sizeBytes and no --source-root was given to measure it`,
        );
      }
      const measured = await digestOfFile(
        resolve(sourceRoot, path),
        `materials[${index}]`,
      );
      materials.push({
        path,
        sha256: measured.sha256,
        sizeBytes: measured.sizeBytes,
        ...(executable ? { executable } : {}),
      });
      continue;
    }
    materials.push({
      path,
      sha256: requiredDigest(record.sha256, `materials[${index}].sha256`),
      sizeBytes: Number(record.sizeBytes),
      ...(executable ? { executable } : {}),
    });
  }
  return materials;
}

function resolveParameters(
  raw: unknown,
): readonly WorkspaceHostBuildParameter[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail("parameters must be an array");
  return raw.map((entry, index) => {
    const record = requiredRecord(entry, `parameters[${index}]`);
    const value = record.value;
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      fail(`parameters[${index}].value must be a string, number or boolean`);
    }
    return {
      name: requiredString(record.name, `parameters[${index}].name`),
      value,
    };
  });
}

function resolveTargets(
  raw: unknown,
  projectId: string,
): readonly WorkspaceHostBuildTarget[] {
  if (raw === undefined) return [{ provider: "gcp", locations: [projectId] }];
  if (!Array.isArray(raw)) fail("targets must be an array");
  return raw.map((entry, index) => {
    const record = requiredRecord(entry, `targets[${index}]`);
    const locations = record.locations;
    if (locations !== undefined && !Array.isArray(locations))
      fail(`targets[${index}].locations must be an array`);
    return {
      provider: requiredString(
        record.provider,
        `targets[${index}].provider`,
      ) as WorkspaceHostBuildTarget["provider"],
      locations: ((locations as unknown[]) ?? []).map((value, at) =>
        requiredString(value, `targets[${index}].locations[${at}]`),
      ),
    };
  });
}

export interface ImageArtifactBuild {
  artifact: WorkspaceHostImageArtifact;
  trustReport: Record<string, unknown>;
  projectId: string;
  family: string;
  publishedAt: string;
  cleanRoom: { zone: string; serviceAccountEmail: string; subnetwork: string };
  compatibilityRequest: Record<string, unknown>;
  readiness: GcpImageFamilyExactPathReadinessConfig;
}

/**
 * Build the ONE image-scoped artifact every emitted document is bound to.
 *
 * The bundle-facing half is transcribed from the publication manifest rather than restated: that
 * document measured the bytes it published, and a second hand-entered copy of a digest is the
 * failure D-191 recorded. The image-facing half is built here, because no other document in the
 * system describes the Packer build.
 */
export async function buildImageArtifact(
  args: GcpImageReleaseRequestCliArgs,
): Promise<ImageArtifactBuild> {
  const input = await readJson(resolve(args.inputFile), "input file");

  const publicationManifestPath = resolve(
    requiredString(input.publicationManifest, "publicationManifest"),
  );
  const publication = await readJson(
    publicationManifestPath,
    "publication manifest",
  );
  const publishedArtifact = requiredRecord(
    publication.artifact,
    "publication manifest artifact",
  );
  const publishedRelease = requiredRecord(
    publishedArtifact.release,
    "publication manifest artifact.release",
  );
  const publishedManifest = requiredRecord(
    publishedArtifact.buildManifest,
    "publication manifest artifact.buildManifest",
  );
  const publishedReleaseArtifact = requiredRecord(
    publishedManifest.releaseArtifact,
    "publication manifest releaseArtifact",
  );
  const trustReport = requiredRecord(
    publication.trustReport,
    "publication manifest trustReport",
  );

  // The gate requires these three digests to agree. Checking it HERE means a mismatched pair is
  // reported against the two documents that disagree, rather than as an opaque gate refusal.
  const bundleSha256 = requiredDigest(
    publishedRelease.bundleSha256,
    "publication manifest release.bundleSha256",
  );
  const manifestReleaseSha = requiredDigest(
    publishedReleaseArtifact.sha256,
    "publication manifest releaseArtifact.sha256",
  );
  const trustSubject = requiredRecord(
    trustReport.subject,
    "publication manifest trustReport.subject",
  );
  const trustSha = requiredDigest(
    trustSubject.sha256,
    "publication manifest trustReport.subject.sha256",
  );
  if (bundleSha256 !== manifestReleaseSha || bundleSha256 !== trustSha) {
    fail(
      `publication manifest is internally inconsistent: release.bundleSha256 ${bundleSha256}, ` +
        `releaseArtifact.sha256 ${manifestReleaseSha}, trustReport.subject.sha256 ${trustSha}`,
    );
  }
  if (trustReport.trusted !== true)
    fail(
      "publication manifest trustReport is not trusted; refusing to compose a release",
    );

  // Measurements the publication run already took, indexed so a material can cite one instead of
  // being hand-typed. Absent or malformed entries simply do not participate.
  const publishedMaterials = new Map<string, WorkspaceHostBuildMaterial>();
  if (Array.isArray(publishedManifest.materials)) {
    for (const entry of publishedManifest.materials) {
      if (!isRecord(entry) || typeof entry.path !== "string") continue;
      if (
        typeof entry.sha256 !== "string" ||
        typeof entry.sizeBytes !== "number"
      )
        continue;
      publishedMaterials.set(entry.path, {
        path: entry.path,
        sha256: entry.sha256,
        sizeBytes: entry.sizeBytes,
        ...(entry.executable === true ? { executable: true } : {}),
      });
    }
  }

  const projectId = requiredString(input.projectId, "projectId");
  const imageName = requiredString(input.imageName, "imageName");
  if (!RESOURCE_NAME.test(imageName))
    fail("imageName must be a valid GCP resource name");
  const family = requiredString(input.family, "family");
  if (!RESOURCE_NAME.test(family))
    fail("family must be a valid GCP resource name");
  const version = requiredString(
    publishedArtifact.image &&
      (publishedArtifact.image as Record<string, unknown>).version,
    "publication manifest image.version",
  );

  const baseImage = requiredRecord(input.baseImage, "baseImage");
  const builderInput = requiredRecord(input.builder, "builder");
  const templatePath = repoRelativePath(
    builderInput.templatePath,
    "builder.templatePath",
  );
  // MEASURED: the adapter refuses a build whose template digest differs from this value, so
  // reading it here is what keeps that check from firing after the build is already paid for.
  const template = await digestOfFile(
    resolve(args.repoRoot, templatePath),
    "builder.templatePath",
  );

  const buildManifestInput: WorkspaceHostBuildManifestInput = {
    contractVersion: WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
    distributionProfile: "vm-release",
    source: {
      repository: requiredString(
        requiredRecord(input.source, "source").repository,
        "source.repository",
      ),
      revision: requiredString(
        requiredRecord(input.source, "source").revision,
        "source.revision",
      ),
    },
    releaseArtifact: {
      name: requiredString(
        publishedReleaseArtifact.name,
        "publication manifest releaseArtifact.name",
      ),
      version,
      sha256: bundleSha256,
      sizeBytes: Number(publishedReleaseArtifact.sizeBytes),
    },
    baseImage: {
      reference: requiredImmutableImageId(
        baseImage.reference,
        "baseImage.reference",
      ),
      architecture: requiredString(
        baseImage.architecture,
        "baseImage.architecture",
      ),
      sha256: requiredDigest(baseImage.sha256, "baseImage.sha256"),
    },
    builder: {
      strategy: "shared",
      // PINNED, not read from input: the gate accepts exactly one builder kind for an image
      // release, so letting a caller supply it only creates a way to get it wrong.
      kind: WORKSPACE_HOST_PACKER_BUILDER_KIND,
      version,
      templatePath,
      templateSha256: template.sha256,
    },
    materials: await resolveMaterials(
      input.materials,
      args.sourceRoot,
      publishedMaterials,
    ),
    parameters: resolveParameters(input.parameters),
    targets: resolveTargets(input.targets, projectId),
  };

  const buildManifest = buildWorkspaceHostBuildManifest(buildManifestInput);
  const publishedAt = requiredTimestamp(input.publishedAt, "publishedAt");

  const compatibility =
    input.compatibility ?? (publishedArtifact.compatibility as unknown);
  if (!Array.isArray(compatibility) || compatibility.length === 0) {
    fail(
      "compatibility must be a non-empty array (supply it, or publish a manifest that carries one)",
    );
  }

  const artifact: WorkspaceHostImageArtifact = {
    contractVersion: WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
    image: {
      // The immutable resource id, NOT the bare product name the publication manifest carries.
      id: `projects/${projectId}/global/images/${imageName}`,
      version,
    },
    buildManifest,
    release: {
      version,
      bundleUrl: requiredString(
        publishedRelease.bundleUrl,
        "publication manifest release.bundleUrl",
      ),
      bundleSha256,
      signatureUrl: requiredString(
        publishedRelease.signatureUrl,
        "publication manifest release.signatureUrl",
      ),
      signingKeySha256: requiredDigest(
        publishedRelease.signingKeySha256,
        "publication manifest release.signingKeySha256",
      ),
      signingPublicKey: requiredVerbatimString(
        publishedRelease.signingPublicKey,
        "publication manifest release.signingPublicKey",
      ),
    },
    lifecycle: { state: "active", publishedAt },
    compatibility: compatibility as WorkspaceHostImageArtifact["compatibility"],
  };

  const cleanRoomInput = requiredRecord(input.cleanRoom, "cleanRoom");
  const readiness = buildGcpImageFamilyExactPathReadinessConfig(
    input.readiness,
    {
      // Captured by the producer rather than accepted from JSON: the consumer later compares these
      // exact values to its live user/cwd immediately before the billable release seam.
      username: userInfo().username,
      cwd: await realpath(args.repoRoot),
      source: buildManifest.source,
    },
  );
  return {
    artifact,
    trustReport,
    projectId,
    family,
    publishedAt,
    cleanRoom: {
      zone: requiredString(cleanRoomInput.zone, "cleanRoom.zone"),
      serviceAccountEmail: requiredString(
        cleanRoomInput.serviceAccountEmail,
        "cleanRoom.serviceAccountEmail",
      ),
      subnetwork: requiredString(
        cleanRoomInput.subnetwork,
        "cleanRoom.subnetwork",
      ),
    },
    compatibilityRequest: requiredRecord(
      input.compatibilityRequest,
      "compatibilityRequest",
    ),
    readiness,
  };
}

/**
 * Emit the request, re-checking the clean-room report against the artifact it will be ratified
 * beside. Both come from `buildImageArtifact` in the normal flow, but a report is a file on disk
 * and can always be an older run's — and that mismatch otherwise costs a full clean-room boot to
 * discover at the gate.
 */
export async function composeRequest(
  args: GcpImageReleaseRequestCliArgs,
): Promise<Record<string, unknown>> {
  const built = await buildImageArtifact(args);
  const reportDocument = await readJson(
    resolve(args.cleanRoomReportFile!),
    "clean-room report",
  );
  const cleanRoomReport = requiredRecord(
    reportDocument.cleanRoomReport ?? reportDocument,
    "clean-room report",
  );
  const reportImage = requiredRecord(
    cleanRoomReport.image,
    "clean-room report image",
  );
  if (
    requiredString(reportImage.id, "clean-room report image.id") !==
      built.artifact.image.id ||
    requiredString(reportImage.version, "clean-room report image.version") !==
      built.artifact.image.version
  ) {
    fail(
      `clean-room report is for ${String(reportImage.id)}@${String(reportImage.version)}, not ` +
        `${built.artifact.image.id}@${built.artifact.image.version}. Re-run the clean-room against ` +
        `--emit clean-room-input; the report is bound to the artifact identity it was produced under.`,
    );
  }
  if (cleanRoomReport.passed !== true)
    fail(
      "clean-room report did not pass; refusing to compose a release request",
    );

  return {
    request: {
      releaseGate: {
        artifact: built.artifact,
        trustReport: built.trustReport,
        compatibilityRequest: built.compatibilityRequest,
        cleanRoomReport,
      },
      projectId: built.projectId,
      family: built.family,
      publishedAt: built.publishedAt,
      cleanRoom: built.cleanRoom,
    },
    connection: {
      target: "gcp",
      // A TYPED reference into the host's resolver, not a bare string: the composition seam reads
      // `cloudCredentialRef.ref`, so a plain string reads as absent and the release dies at the
      // connection parse before it does anything billable.
      cloudCredentialRef: { kind: "cloud", ref: args.credentialRef },
      scope: { kind: "project", id: built.projectId },
      provider: { projectId: built.projectId },
    },
    readiness: built.readiness,
  };
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const args = parseGcpImageReleaseRequestCliArgs(argv);
  if (args.emit === "request") {
    process.stdout.write(
      `${JSON.stringify(await composeRequest(args), null, 2)}\n`,
    );
    return;
  }
  const built = await buildImageArtifact(args);
  if (args.emit === "artifact") {
    process.stdout.write(
      `${JSON.stringify({ artifact: built.artifact }, null, 2)}\n`,
    );
    return;
  }
  // clean-room-input: the acceptance CLI's exact input shape, carrying the SAME artifact the
  // request will carry, so the gate's sameImage check cannot fail for an avoidable reason.
  const input = await readJson(resolve(args.inputFile), "input file");
  process.stdout.write(
    `${JSON.stringify(
      {
        artifact: built.artifact,
        placement: requiredRecord(input.placement, "placement"),
        spec: requiredRecord(input.spec, "spec"),
      },
      null,
      2,
    )}\n`,
  );
}

if (isCliEntry(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
