/**
 * Assemble the AWS AMI release request for a BOOTC workspace-host image from a real bake (WI-10005624).
 *
 * `aws-ami-release-cli` executes an `AwsAmiReleaseRequest` whose `releaseGate` it treats as
 * already-verified evidence, and `executeAwsAmiRelease` ratifies that evidence before anything
 * billable. Nothing in the tree produced that evidence for a bootc image: the only bootc
 * `releaseGate` was a test fixture. This is the producer, the bootc counterpart of
 * `gcp-image-release-request-cli` (the Packer/Ubuntu model).
 *
 * ## What a bootc release is made of
 *
 * The image half is the bake: `infra/images/bootc/bake-cloud-images.sh` writes `bake-manifest.json`
 * (one OCI digest, one rendered disk per cloud) and its supply-chain step
 * (`release-supply-chain.sh`) leaves signature, provenance, SBOM and grype evidence beside it.
 * `image-secret-scan.sh` adds the secret-scan class the supply chain never produced.
 *
 * The server half is NOT in the image. A bootc host boots the OS image, and Initialize installs
 * the controller-pinned server bundle (aws-byoc-gcp-parity-2026-10-01#D-024). The artifact
 * validator still requires the `release` pins and the bundle's materials for a bootc artifact
 * (`validateWorkspaceHostImageArtifact` -> `verifyWorkspaceHostReleaseProvenance`), so they are
 * transcribed from that bundle's PUBLICATION MANIFEST — the document that measured the bytes it
 * published — never restated. That also forces `image.version` to the bundle's version.
 *
 * ## Measured, never accepted from the caller
 *
 *   - the OCI identity (repository, tag, digest) — read from the bake manifest;
 *   - every trust-evidence class — read from the files the tools wrote, each bound to the digest
 *     it actually inspected (cosign's verified digest, syft's manifest digest, the in-toto
 *     subject, the secret scan's recorded digest), then judged by `evaluateArtifactTrust`;
 *   - the source revision — the checkout the supply chain recorded; the Containerfile is refused
 *     if the working tree no longer matches that revision's blob;
 *   - `builder.kind`, `templatePath` and `bootc.signaturePolicyPath` — pinned constants.
 *
 * The emitted request is run through `evaluateWorkspaceHostReleaseGate` before it is written, so
 * a request this file emits is one the release will accept, or the refusal names the field.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  WORKSPACE_HOST_BOOTC_BASE_IMAGE,
  WORKSPACE_HOST_BOOTC_BUILDER_KIND,
  WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
  WORKSPACE_HOST_CONTAINERS_POLICY_PATH,
  WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
  buildWorkspaceHostBuildManifest,
  type WorkspaceHostBuildMaterial,
  type WorkspaceHostImageArtifact,
} from "@papercusp/deployment-driver";
import {
  evaluateArtifactTrust,
  type ArtifactTrustReport,
  type ArtifactTrustTool,
  type SecretFinding,
} from "@papercusp/operator-core/lib/workspace-host/artifact-trust";
import {
  AWS_AMI_REQUIRED_GUEST_TOOLS,
  type AwsAmiReleaseRequest,
} from "@papercusp/operator-core/lib/workspace-host/aws-ami-release";
import {
  parseWorkspaceHostBootcBakeManifest,
  workspaceHostBootcBakeReleaseMismatch,
  workspaceHostBootcCloudArtifact,
} from "@papercusp/operator-core/lib/workspace-host/bootc-bake-manifest";
import { GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS } from "@papercusp/operator-core/lib/workspace-host/gcp-image-family";
import { evaluateWorkspaceHostReleaseGate } from "@papercusp/operator-core/lib/workspace-host/workspace-host-release-gate";
import { isCliEntry } from "@papercusp/operator-core/lib/util/cli-entry";
import { activeWorkspaceId } from "@papercusp/operator-core/lib/workspace-registry";
import { governedExecutionLeaseTtlForTimeout, runGovernedOperation } from "@papercusp/operator-core/lib/resource-governor/execution";

import {
  WORKSPACE_HOST_PUBLICATION_TRUST_POLICY,
  parseVulnerabilityFacts,
} from "./workspace-host-publication-manifest-cli";

export const BOOTC_TEMPLATE_PATH = "infra/images/bootc/workspace-host.Containerfile";
export const BOOTC_SLSA_PREDICATE_TYPE = "https://slsa.dev/provenance/v1";
/** A secret scan that read fewer files than this measured an empty tree, not an OS image. */
export const BOOTC_SECRET_SCAN_MIN_COVERAGE = 5000;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export type BootcEmit = "trust-report" | "artifact" | "clean-room-input" | "request" | "guest-tool-versions";

/**
 * The guest tools each provider's release pins, keyed by `--provider`. The AWS request carries
 * its set itself (composeBootcAwsRequest); `--emit guest-tool-versions` derives either set from
 * the same SBOM for a release request composed elsewhere (WI-10006408: GCP).
 */
export const BOOTC_RELEASE_GUEST_TOOLS = {
  aws: AWS_AMI_REQUIRED_GUEST_TOOLS,
  gcp: GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS,
} as const;

export type BootcReleaseProvider = keyof typeof BOOTC_RELEASE_GUEST_TOOLS;

export interface BootcImageReleaseRequestCliArgs {
  inputFile: string;
  repoRoot: string;
  emit: BootcEmit;
  cleanRoomReportFile?: string;
  /** Required by, and only valid with, `--emit guest-tool-versions`. */
  provider?: BootcReleaseProvider;
}

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`);
  return (value as string).trim();
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be an object`);
  return value;
}

function requiredHex(value: unknown, label: string): string {
  const hex = requiredString(value, label).toLowerCase().replace(/^sha256:/, "");
  if (!SHA256_HEX.test(hex)) fail(`${label} must be a SHA-256 digest`);
  return hex;
}

function requiredTimestamp(value: unknown, label: string): string {
  const raw = requiredString(value, label);
  if (!Number.isFinite(Date.parse(raw))) fail(`${label} must be an ISO-8601 timestamp`);
  return raw;
}

const digestOf = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

async function readBytes(path: string, label: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch {
    fail(`${label} could not be read at ${path}`);
  }
}

async function readText(path: string, label: string): Promise<string> {
  return (await readBytes(path, label)).toString("utf8");
}

async function readJsonIfPresent(path: string, label: string): Promise<Record<string, unknown> | null> {
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return readJson(path, label);
}

async function readJson(path: string, label: string): Promise<Record<string, unknown>> {
  const text = await readText(path, label);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(`${label} is not valid JSON (${path})`);
  }
  return requiredRecord(parsed, label);
}

export function parseBootcImageReleaseRequestCliArgs(argv: readonly string[]): BootcImageReleaseRequestCliArgs {
  const allowed = new Set(["input-file", "repo-root", "emit", "clean-room-report", "provider"]);
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) fail(`unexpected argument ${token}`);
    const key = token.slice(2);
    if (!allowed.has(key)) fail(`unknown flag --${key}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) fail(`--${key} requires a value`);
    values[key] = next;
    index += 1;
  }
  const emit = (values.emit ?? "request") as BootcEmit;
  if (!["trust-report", "artifact", "clean-room-input", "request", "guest-tool-versions"].includes(emit)) {
    fail("--emit must be one of: trust-report, artifact, clean-room-input, request, guest-tool-versions");
  }
  if (!values["input-file"]) fail("--input-file is required");
  if (emit === "request" && !values["clean-room-report"]) {
    fail("--emit request requires --clean-room-report (the gate ratifies a report, never an assertion)");
  }
  const provider = values.provider;
  if (emit === "guest-tool-versions") {
    if (provider === undefined || !Object.hasOwn(BOOTC_RELEASE_GUEST_TOOLS, provider)) {
      fail(`--emit guest-tool-versions requires --provider ${Object.keys(BOOTC_RELEASE_GUEST_TOOLS).join("|")}`);
    }
  } else if (provider !== undefined) {
    fail("--provider is only valid with --emit guest-tool-versions");
  }
  return {
    inputFile: values["input-file"]!,
    repoRoot: values["repo-root"] ?? process.cwd(),
    emit,
    ...(values["clean-room-report"] ? { cleanRoomReportFile: values["clean-room-report"] } : {}),
    ...(provider !== undefined ? { provider: provider as BootcReleaseProvider } : {}),
  };
}

/* ------------------------------------------------------------------ evidence readers */

/**
 * The digests cosign reported VERIFYING, from `cosign verify` output (release-supply-chain.sh
 * step 6 writes stdout and stderr to one log). The JSON payload line is the only part that names
 * what was verified; the prose around it is ignored. No payload line -> no signature evidence.
 */
export function parseCosignVerifiedDigests(log: string): readonly string[] {
  const digests: string[] = [];
  for (const line of log.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("[")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const entry of parsed) {
      const image = isRecord(entry) && isRecord(entry.critical) && isRecord(entry.critical.image)
        ? entry.critical.image
        : undefined;
      const value = image?.["docker-manifest-digest"];
      if (typeof value === "string") digests.push(value);
    }
  }
  return digests;
}

/** SBOM facts from a syft-json document, bound to the image digest syft actually read. */
export function parseSyftSbomFacts(document: unknown): {
  componentCount: number;
  tool: ArtifactTrustTool;
  manifestDigest: string;
  imageBytes: number;
} {
  const doc = requiredRecord(document, "syft SBOM");
  if (!Array.isArray(doc.artifacts)) fail("syft SBOM must record an artifacts array");
  const descriptor = requiredRecord(doc.descriptor, "syft SBOM descriptor");
  const source = requiredRecord(doc.source, "syft SBOM source");
  const metadata = requiredRecord(source.metadata, "syft SBOM source.metadata");
  const manifestDigest = requiredString(metadata.manifestDigest, "syft SBOM source.metadata.manifestDigest");
  if (!DIGEST.test(manifestDigest)) fail("syft SBOM source.metadata.manifestDigest must be a sha256 digest");
  const imageBytes = Number(metadata.imageSize);
  if (!Number.isSafeInteger(imageBytes) || imageBytes <= 0) fail("syft SBOM must record a positive source.metadata.imageSize");
  return {
    componentCount: doc.artifacts.length,
    tool: {
      name: requiredString(descriptor.name, "syft descriptor.name"),
      version: requiredString(descriptor.version, "syft descriptor.version"),
    },
    manifestDigest,
    imageBytes,
  };
}

/** buildah/podman build's base-image annotations on the built image's own manifest. */
export const OCI_BASE_NAME_ANNOTATION = "org.opencontainers.image.base.name";
export const OCI_BASE_DIGEST_ANNOTATION = "org.opencontainers.image.base.digest";

/**
 * WI-10005711. The base image the bake was built FROM, read from the built image's own manifest,
 * never from a hand-copied input. syft embeds that manifest (base64) in the SBOM; it counts only
 * when its bytes hash to the digest the release signs, so the annotation is bound to the signed
 * image. `sha256` is the per-platform manifest digest buildah resolved the FROM tag to.
 * Returns null when the SBOM carries no manifest or the manifest carries no base annotations.
 */
export function signedBaseImage(sbom: unknown, digest: string): { reference: string; sha256: string } | null {
  const source = isRecord(sbom) && isRecord(sbom.source) ? sbom.source : undefined;
  const metadata = source && isRecord(source.metadata) ? source.metadata : undefined;
  const encoded = metadata?.manifest;
  if (encoded === undefined || encoded === null) return null;
  if (typeof encoded !== "string" || !encoded) fail("syft SBOM source.metadata.manifest must be a base64 string");
  const bytes = Buffer.from(encoded, "base64");
  const manifestDigest = `sha256:${digestOf(bytes)}`;
  if (manifestDigest !== digest) {
    fail(`syft SBOM's embedded image manifest hashes to ${manifestDigest}, not the signed digest ${digest}`);
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("syft SBOM's embedded image manifest is not valid JSON");
  }
  const annotations = isRecord(manifest) && isRecord(manifest.annotations) ? manifest.annotations : {};
  const reference = annotations[OCI_BASE_NAME_ANNOTATION];
  const baseDigest = annotations[OCI_BASE_DIGEST_ANNOTATION];
  if (reference === undefined && baseDigest === undefined) return null;
  if (typeof reference !== "string" || !reference) fail(`image manifest ${OCI_BASE_NAME_ANNOTATION} must be a non-empty string`);
  if (typeof baseDigest !== "string" || !DIGEST.test(baseDigest)) {
    fail(`image manifest ${OCI_BASE_DIGEST_ANNOTATION} must be a sha256 digest`);
  }
  return { reference, sha256: baseDigest.slice("sha256:".length) };
}

/**
 * The two artifact types an EL vendor kernel reaches grype as. `rpm` is the packaged kernel
 * (kernel, kernel-core, ...). `linux-kernel` is syft's binary cataloger reading the kernel image
 * itself (usr/lib/modules/<release>/vmlinuz, purl pkg:generic/linux-kernel); on a bootc image it is
 * the SAME vendor kernel as the RPMs, carries the same `.elN` release, and grype can only match it
 * by upstream NVD CPE. Measured on the P-012 AWS bake (WI-10005674, EL9): 2,226 of 2,328
 * "actionable" findings were this artifact while the RPMs stayed matched in redhat:distro. The
 * release tag is matched as `el<major>` rather than `el9` because the base moved to EL10 (D-035,
 * WI-10005910) and will move again. Mirrored exactly by release-supply-chain.sh's
 * generic_kernel_cpe.
 */
const EL_KERNEL_ARTIFACT_TYPES: ReadonlySet<string> = new Set(["rpm", "linux-kernel"]);

function isGenericElKernelCpe(match: Record<string, unknown>): boolean {
  const artifact = isRecord(match.artifact) ? match.artifact : {};
  const vulnerability = isRecord(match.vulnerability) ? match.vulnerability : {};
  const lower = (value: unknown) => (typeof value === "string" ? value.toLowerCase() : "");
  return (
    /(^|-)kernel($|-)/.test(lower(artifact.name)) &&
    EL_KERNEL_ARTIFACT_TYPES.has(lower(artifact.type)) &&
    /(^|[.-])el\d+([._-]|$)/.test(lower(artifact.version)) &&
    lower(vulnerability.namespace) === "nvd:cpe"
  );
}

/**
 * D-027 (WI-10005719). syft locates an INSTALLED rpm at the rpm database; an `.rpm` archive lying
 * in the image is catalogued as type rpm too but located at its own file, and is not installed.
 * Mirrors release-supply-chain.sh's rpmdb_path / installed_rpm.
 */
const RPMDB_PATH = /\/rpm\/(rpmdb\.sqlite|Packages(\.db)?)$/;

function locationPaths(artifact: Record<string, unknown>): string[] {
  const locations = Array.isArray(artifact.locations) ? artifact.locations : [];
  return locations.map((location) => (isRecord(location) && typeof location.path === "string" ? location.path : ""));
}

function isInstalledRpm(artifact: Record<string, unknown>): boolean {
  const type = typeof artifact.type === "string" ? artifact.type.toLowerCase() : "";
  const paths = locationPaths(artifact);
  return type === "rpm" && paths.length > 0 && paths.every((path) => RPMDB_PATH.test(path));
}

/** Every path an INSTALLED rpm owns, read from the syft SBOM grype scanned (its metadata.files). */
export function rpmOwnedPaths(sbom: unknown): Set<string> {
  const owned = new Set<string>();
  const artifacts = isRecord(sbom) && Array.isArray(sbom.artifacts) ? sbom.artifacts : [];
  for (const artifact of artifacts) {
    if (!isRecord(artifact) || !isInstalledRpm(artifact)) continue;
    const metadata = isRecord(artifact.metadata) ? artifact.metadata : {};
    for (const file of Array.isArray(metadata.files) ? metadata.files : []) {
      if (isRecord(file) && typeof file.path === "string") owned.add(file.path);
    }
  }
  return owned;
}

/**
 * WI-10006386: name -> the distinct versions the image's rpm DATABASE records, read from the
 * syft SBOM. Only installed rpms count (isInstalledRpm): syft's elf-binary cataloger also emits
 * type-rpm rows, guessed from binaries in ostree objects and without the epoch (the P-012 bake
 * recorded nftables '1.1.5-6.el10' beside the database's '1:1.1.5-6.el10').
 */
export function installedRpmVersions(sbom: unknown): Map<string, string[]> {
  const versions = new Map<string, string[]>();
  const artifacts = isRecord(sbom) && Array.isArray(sbom.artifacts) ? sbom.artifacts : [];
  for (const artifact of artifacts) {
    if (!isRecord(artifact) || !isInstalledRpm(artifact)) continue;
    if (typeof artifact.name !== "string" || typeof artifact.version !== "string" || !artifact.version.trim()) continue;
    const known = versions.get(artifact.name) ?? [];
    if (!known.includes(artifact.version)) known.push(artifact.version);
    versions.set(artifact.name, known);
  }
  return versions;
}

/**
 * The one installed version of each required guest tool. Refuses a tool the rpm database does
 * not record (the image lacks it) and one it records at more than one version (which one the
 * image runs is not determinable), rather than tag the image with a guess.
 */
export function requiredGuestToolVersions(
  installed: ReadonlyMap<string, readonly string[]>,
  tools: readonly string[],
): Record<string, string> {
  const missing = tools.filter((tool) => !installed.get(tool)?.length);
  if (missing.length > 0) {
    fail(`the bake's syft SBOM records no installed rpm for guest tool(s): ${missing.join(", ")}`);
  }
  const ambiguous = tools.filter((tool) => installed.get(tool)!.length > 1);
  if (ambiguous.length > 0) {
    fail(
      `the bake's syft SBOM records more than one installed version for: ` +
        ambiguous.map((tool) => `${tool} (${installed.get(tool)!.join(", ")})`).join("; "),
    );
  }
  return Object.fromEntries(tools.map((tool) => [tool, installed.get(tool)![0]!]));
}

/**
 * D-029 (WI-10005719). syft locates a base-layer binary the build did not replace at its ostree
 * OBJECT (the base layer hardlinks the live path to it). release-supply-chain.sh probes each such
 * object inside the image and records the live path(s) with identical content, or proves it has
 * none: a stale base copy the deployed tree never references. Mirrors ostree_object.
 */
const OSTREE_OBJECT = /^\/sysroot\/ostree\/repo\/objects\/[0-9a-f]{2}\/[0-9a-f]{62}\.file$/;

/** The probe's verdict for one ostree object: where its content lives, or that it lives nowhere. */
export interface OstreeObjectVerdict {
  livePaths: string[];
  stale: boolean;
}

export type OstreeObjectIndex = ReadonlyMap<string, OstreeObjectVerdict>;

const NO_OSTREE_OBJECTS: OstreeObjectIndex = new Map();

/**
 * Read release-supply-chain.sh's ostree-objects.json (D-029). A record for a different image is
 * corrupt evidence and refuses outright. An INCOMPLETE probe (the container failed, never reached
 * its end marker, or left an object without a verdict) relocates nothing and proves nothing stale,
 * so it yields an empty index — exactly the shell's ostree-object-index.json.
 */
export function ostreeObjectIndex(record: unknown, digest: string): Map<string, OstreeObjectVerdict> {
  const doc = requiredRecord(record, "ostree-objects record");
  if (doc.digest !== digest) fail(`ostree-objects record is for ${String(doc.digest)}, not ${digest}`);
  const index = new Map<string, OstreeObjectVerdict>();
  if (doc.complete !== true) return index;
  if (!Array.isArray(doc.objects)) fail("ostree-objects record must record an objects array");
  for (const object of doc.objects) {
    if (!isRecord(object) || typeof object.path !== "string") fail("ostree-objects record has an object without a path");
    const livePaths = Array.isArray(object.livePaths)
      ? object.livePaths.filter((path): path is string => typeof path === "string" && path.length > 0)
      : [];
    index.set(object.path, { livePaths, stale: object.stale === true });
  }
  return index;
}

/** Each location, relocated to its live copies when the probe found any. Mirrors effective_paths. */
function effectivePaths(artifact: Record<string, unknown>, objects: OstreeObjectIndex): string[] {
  return locationPaths(artifact).flatMap((path) => {
    const live = objects.get(path)?.livePaths ?? [];
    return live.length > 0 ? live : [path];
  });
}

/** Every location is an ostree object the probe proved has no live copy. Mirrors stale_object. */
function isStaleObject(match: Record<string, unknown>, objects: OstreeObjectIndex): boolean {
  const paths = locationPaths(isRecord(match.artifact) ? match.artifact : {});
  return (
    paths.length > 0 &&
    paths.every((path) => {
      const verdict = objects.get(path);
      return OSTREE_OBJECT.test(path) && verdict?.stale === true && verdict.livePaths.length === 0;
    })
  );
}

/**
 * The finding IS an installed rpm, or every file it sits in — after D-029 relocation — is owned by
 * one. Mirrors vendor_owned.
 */
function isVendorOwned(match: Record<string, unknown>, owned: ReadonlySet<string>, objects: OstreeObjectIndex): boolean {
  const artifact = isRecord(match.artifact) ? match.artifact : {};
  if (isInstalledRpm(artifact)) return true;
  const paths = effectivePaths(artifact, objects);
  return paths.length > 0 && paths.every((path) => owned.has(path));
}

/**
 * The release gate's own floor for "dnf really read its metadata". Independent of the floor the
 * bake recorded, so lowering the bake's --min-available-packages can never widen what the release
 * accepts as vendor-pending.
 */
export const VENDOR_MIN_AVAILABLE_PACKAGES = 1000;

/**
 * Read release-supply-chain.sh's vendor-updates.json (D-027 (b)). Only a record bound to THIS
 * digest that saw `dnf --refresh check-update` exit 0 from a container that itself exited 0, with
 * at least one enabled repo and the metadata floor met, proves the vendor ships nothing newer.
 * Every other shape proves nothing, so nothing becomes vendor-pending. A record for a different
 * image is corrupt evidence and refuses outright.
 */
export function vendorShipsNothingNewer(record: unknown, digest: string): boolean {
  const doc = requiredRecord(record, "vendor-updates record");
  if (doc.digest !== digest) fail(`vendor-updates record is for ${String(doc.digest)}, not ${digest}`);
  const count = (value: unknown) => (typeof value === "number" && Number.isInteger(value) ? value : -1);
  return (
    doc.verdict === "no-updates" &&
    doc.containerExit === 0 &&
    doc.checkUpdateExit === 0 &&
    count(doc.enabledRepos) >= 1 &&
    count(doc.availablePackages) >= VENDOR_MIN_AVAILABLE_PACKAGES
  );
}

/**
 * What the vendor-pending rule needs: who owns which file, and whether the vendor ships newer.
 * `ostreeObjects` (D-029) is the probe's index: it relocates object-located findings to their live
 * paths before ownership is judged, and names the stale base objects. Absent ⇒ nothing relocates
 * and nothing is stale.
 */
export interface VendorPendingEvidence {
  ownedPaths: ReadonlySet<string>;
  vendorShipsNothingNewer: boolean;
  ostreeObjects?: OstreeObjectIndex;
}

/**
 * Narrow a grype report to the population a release can act on — D-289, applied exactly as
 * release-supply-chain.sh applies it: findings WITH A FIX, minus EL9 kernel RPMs matched only by
 * a generic upstream NVD CPE (a vendor kernel's fix may already be backported, so that match
 * cannot show the package is vulnerable). Unfixed findings are not a verdict a rebase can change.
 * D-029: first, a fixed Critical/High finding located ONLY at ostree objects the image's probe
 * proved stale (no live copy anywhere in the deployed tree) is a stale base object — content the
 * host never executes. D-027: then, with `vendor` evidence, a fixed Critical/High finding the vendor
 * owns (isVendorOwned, over the relocated paths) is vendor-pending when the image's own repos ship
 * nothing newer — a fix no rebuild here can reach. Without that proof nothing is pending. The
 * excluded counts, and the excluded findings' ids, are returned so the caller reports them; they
 * are never silently dropped.
 */
export function actionableGrypeReport(report: unknown, vendor?: VendorPendingEvidence): {
  report: Record<string, unknown>;
  excludedUnfixed: number;
  excludedGenericKernelCpe: number;
  excludedStaleBaseObject: number;
  staleBaseObjectIds: string[];
  excludedVendorPending: number;
  vendorPendingIds: string[];
} {
  const doc = requiredRecord(report, "grype report");
  if (!Array.isArray(doc.matches)) fail("grype report must record a matches array");
  let excludedUnfixed = 0;
  let excludedGenericKernelCpe = 0;
  const staleBaseObjectIds: string[] = [];
  const vendorPendingIds: string[] = [];
  const objects = vendor?.ostreeObjects ?? NO_OSTREE_OBJECTS;
  const matches = doc.matches.filter((match) => {
    if (!isRecord(match) || !isRecord(match.vulnerability)) return true; // parseVulnerabilityFacts refuses it
    const fix = isRecord(match.vulnerability.fix) ? match.vulnerability.fix : {};
    if (fix.state !== "fixed") {
      excludedUnfixed += 1;
      return false;
    }
    if (isGenericElKernelCpe(match)) {
      excludedGenericKernelCpe += 1;
      return false;
    }
    const severity = match.vulnerability.severity;
    const critHigh = severity === "Critical" || severity === "High";
    const id = typeof match.vulnerability.id === "string" ? match.vulnerability.id : "(no id)";
    if (critHigh && isStaleObject(match, objects)) {
      staleBaseObjectIds.push(id);
      return false;
    }
    if (vendor?.vendorShipsNothingNewer === true && critHigh && isVendorOwned(match, vendor.ownedPaths, objects)) {
      vendorPendingIds.push(id);
      return false;
    }
    return true;
  });
  return {
    report: { ...doc, matches },
    excludedUnfixed,
    excludedGenericKernelCpe,
    excludedStaleBaseObject: staleBaseObjectIds.length,
    staleBaseObjectIds,
    excludedVendorPending: vendorPendingIds.length,
    vendorPendingIds,
  };
}

/**
 * Secret-scan findings from image-secret-scan.sh. FAIL-CLOSED: the record and the auditor's own
 * log must agree, the record must be bound to the released digest, and the scan must have read an
 * OS-sized tree — an unreadable or empty scan never becomes an empty findings list.
 */
export function parseBootcSecretScan(
  record: Record<string, unknown>,
  log: string,
  digest: string,
): { findings: readonly SecretFinding[]; tool: ArtifactTrustTool } {
  if (record.digest !== digest) fail(`secret scan is for ${String(record.digest)}, not ${digest}`);
  const toolRecord = requiredRecord(record.tool, "secret scan tool");
  const tool = {
    name: requiredString(toolRecord.name, "secret scan tool.name"),
    version: requiredString(toolRecord.version, "secret scan tool.version"),
  };
  const coverageMatch = /^\s*coverage: ([\d,]+) file\(s\)/mu.exec(log);
  if (!coverageMatch) fail("secret-scan log reports no coverage line; refusing to read an unknown scan as clean");
  const coverage = Number.parseInt(coverageMatch[1]!.replace(/,/g, ""), 10);
  if (!(coverage >= BOOTC_SECRET_SCAN_MIN_COVERAGE)) {
    fail(`secret scan covered ${coverage} files (floor ${BOOTC_SECRET_SCAN_MIN_COVERAGE}); it measured almost nothing`);
  }
  const clean = /^\s*✓ CLEAN\b/mu.test(log);
  const findings: SecretFinding[] = log
    .split("\n")
    .filter((line) => /^\s*✗ /.test(line))
    .map((line, index) => ({ ruleId: "release-audit", location: `${index + 1}: ${line.trim().slice(2, 160)}` }));
  if (record.exitCode === 0 && clean && findings.length === 0) return { findings: [], tool };
  if (record.exitCode === 1 && !clean && findings.length > 0) return { findings, tool };
  fail(
    `secret scan is contradictory or unscannable (exitCode ${String(record.exitCode)}, CLEAN marker ${clean}, ` +
      `${findings.length} finding line(s)); refusing to publish on it`,
  );
}

/** The newest SLSA v1 provenance statement cosign VERIFIED for this digest. */
export function parseVerifiedProvenance(
  verifyOutput: string,
  digest: string,
): { issuedAt: string; attestationSha256: string; predicateType: string } {
  const want = digest.replace(/^sha256:/, "");
  const found: { issuedAt: string; attestationSha256: string; predicateType: string }[] = [];
  for (const line of verifyOutput.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let envelope: unknown;
    try {
      envelope = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(envelope) || typeof envelope.payload !== "string") continue;
    const statementBytes = Buffer.from(envelope.payload, "base64");
    let statement: unknown;
    try {
      statement = JSON.parse(statementBytes.toString("utf8"));
    } catch {
      continue;
    }
    if (!isRecord(statement) || statement.predicateType !== BOOTC_SLSA_PREDICATE_TYPE) continue;
    const subjects = Array.isArray(statement.subject) ? statement.subject : [];
    const bound = subjects.some((subject) => isRecord(subject) && isRecord(subject.digest) && subject.digest.sha256 === want);
    if (!bound) continue;
    const predicate = isRecord(statement.predicate) ? statement.predicate : {};
    const runDetails = isRecord(predicate.runDetails) ? predicate.runDetails : {};
    const metadata = isRecord(runDetails.metadata) ? runDetails.metadata : {};
    const issuedAt = requiredTimestamp(metadata.startedOn, "provenance runDetails.metadata.startedOn");
    found.push({ issuedAt, attestationSha256: digestOf(statementBytes), predicateType: BOOTC_SLSA_PREDICATE_TYPE });
  }
  if (found.length === 0) fail(`no verified SLSA v1 provenance statement is bound to ${digest}`);
  return found.sort((left, right) => Date.parse(right.issuedAt) - Date.parse(left.issuedAt))[0]!;
}

/* ------------------------------------------------------------------ assembly */

interface LoadedInput {
  input: Record<string, unknown>;
  path(field: string, fallback?: string): string;
}

async function loadInput(args: BootcImageReleaseRequestCliArgs): Promise<LoadedInput> {
  const inputPath = resolve(args.inputFile);
  const input = await readJson(inputPath, "input file");
  const inputDir = dirname(inputPath);
  return {
    input,
    path(field, fallback) {
      const value = requiredString(input[field] ?? fallback, field);
      return isAbsolute(value) ? value : resolve(inputDir, value);
    },
  };
}

export interface BootcTrustBuild {
  trustReport: ArtifactTrustReport;
  bake: ReturnType<typeof parseWorkspaceHostBootcBakeManifest>;
  sourceRevision: string;
  /** WI-10005711: the base the image was built FROM, read from its signed manifest (null if unrecorded). */
  baseImage: { reference: string; sha256: string } | null;
  excluded: { unfixed: number; genericKernelCpe: number; staleBaseObject: number; vendorPending: number };
  /** D-029: the stale base-object findings' ids, reported beside the verdict, never dropped. */
  staleBaseObjectIds: string[];
  /** D-027: the vendor-pending findings' ids, reported beside the verdict, never dropped. */
  vendorPendingIds: string[];
  /** WI-10006386: installed rpm name -> versions, from the same SBOM the trust report binds. */
  installedRpms: ReadonlyMap<string, readonly string[]>;
}

/**
 * The bake's shell copy of a classification recorded its own count; the two copies must agree, so
 * a drift between them refuses at release instead of silently widening one side.
 */
function requireSummaryCount(summary: Record<string, unknown>, field: string, derived: number, rule: string): void {
  const recorded = summary[field];
  if (recorded === undefined || recorded === "skipped") return;
  if (Number(recorded) !== derived) {
    fail(
      `supply-chain summary records ${String(recorded)} ${field} findings but the release gate derives ` +
        `${derived} (${rule} copies disagree)`,
    );
  }
}

/** Build the trust report for the bake's OCI digest from the evidence its tools left behind. */
export async function buildBootcTrustReport(
  args: BootcImageReleaseRequestCliArgs,
  now: () => number = Date.now,
): Promise<BootcTrustBuild> {
  const loaded = await loadInput(args);
  const bakeManifestPath = loaded.path("bakeManifest");
  const bake = parseWorkspaceHostBootcBakeManifest(await readJson(bakeManifestPath, "bake manifest"));
  const supplyChain = loaded.path("supplyChainDir", resolve(dirname(bakeManifestPath), "supply-chain"));
  const scanDir = loaded.path("secretScanDir", supplyChain);
  const digest = bake.digest;
  const hex = digest.slice("sha256:".length);

  const summary = await readJson(resolve(supplyChain, "supply-chain-summary.json"), "supply-chain summary");
  if (summary.digest !== digest || summary.verifiedFromRegistry !== true) {
    fail(`supply-chain summary is for ${String(summary.digest)} (verifiedFromRegistry ${String(summary.verifiedFromRegistry)}), not ${digest}`);
  }

  const verified = parseCosignVerifiedDigests(await readText(resolve(supplyChain, "verify-sig.log"), "cosign verify log"));
  const publicKey = await readBytes(loaded.path("cosignPublicKey"), "cosign public key");
  const cosignVersion = requiredString(loaded.input.cosignVersion ?? "v2.4.1", "cosignVersion");

  const sbomBytes = await readBytes(resolve(supplyChain, "sbom.syft.json"), "syft SBOM");
  let sbomDoc: unknown;
  try {
    sbomDoc = JSON.parse(sbomBytes.toString("utf8"));
  } catch {
    fail("syft SBOM is not valid JSON");
  }
  const sbom = parseSyftSbomFacts(sbomDoc);
  if (sbom.manifestDigest !== digest) fail(`syft SBOM describes ${sbom.manifestDigest}, not ${digest}`);
  const baseImage = signedBaseImage(sbomDoc, digest);
  const sbomSha256 = digestOf(sbomBytes);

  // D-027: vendor-updates.json exists only when the bake had RPM-owned findings to ask about; its
  // absence proves nothing, so nothing becomes vendor-pending.
  const vendorUpdates = await readJsonIfPresent(resolve(supplyChain, "vendor-updates.json"), "vendor-updates record");
  // D-029: ostree-objects.json exists only when the bake probed object-located findings; its
  // absence (or an incomplete probe) relocates nothing and proves nothing stale.
  const ostreeObjects = await readJsonIfPresent(resolve(supplyChain, "ostree-objects.json"), "ostree-objects record");
  const narrowed = actionableGrypeReport(await readJson(resolve(supplyChain, "vulns.json"), "grype report"), {
    ownedPaths: rpmOwnedPaths(sbomDoc),
    vendorShipsNothingNewer: vendorUpdates !== null && vendorShipsNothingNewer(vendorUpdates, digest),
    ostreeObjects: ostreeObjects === null ? NO_OSTREE_OBJECTS : ostreeObjectIndex(ostreeObjects, digest),
  });
  requireSummaryCount(summary, "vendorPending", narrowed.excludedVendorPending, "D-027");
  requireSummaryCount(summary, "staleBaseObjects", narrowed.excludedStaleBaseObject, "D-029");
  const vulnerabilities = parseVulnerabilityFacts(narrowed.report);

  const scanFacts = parseBootcSecretScan(
    await readJson(resolve(scanDir, "secret-scan.json"), "secret-scan record"),
    await readText(resolve(scanDir, "secret-scan.log"), "secret-scan log"),
    digest,
  );

  const provenance = parseVerifiedProvenance(await readText(resolve(supplyChain, "verify-prov.json"), "verified provenance"), digest);
  const recordedPredicate = await readJson(resolve(supplyChain, "provenance.json"), "provenance predicate");
  const definition = isRecord(recordedPredicate.buildDefinition) ? recordedPredicate.buildDefinition : {};
  const internal = isRecord(definition.internalParameters) ? definition.internalParameters : {};
  const sourceRevision = requiredString(internal.sourceCheckout, "provenance internalParameters.sourceCheckout");
  if (!/^[0-9a-f]{40}$/.test(sourceRevision)) fail(`provenance sourceCheckout '${sourceRevision}' is not a commit id`);

  const trustReport = await evaluateArtifactTrust(
    { path: bake.pinnedRef, name: "workspace-host", bytes: sbom.imageBytes, sha256: hex, signed: true },
    {
      verifySignature: async () => ({
        kind: "signature",
        subjectSha256: hex,
        tool: { name: "cosign", version: cosignVersion },
        // Valid only when cosign reported verifying THIS digest and nothing else.
        valid: verified.length > 0 && verified.every((value) => value === digest),
        signingKeySha256: digestOf(publicKey),
      }),
      generateSbom: async () => ({
        kind: "sbom",
        subjectSha256: hex,
        tool: sbom.tool,
        format: "syft-json",
        documentSha256: sbomSha256,
        componentCount: sbom.componentCount,
      }),
      scanVulnerabilities: async () => ({
        kind: "vulnerability-scan",
        subjectSha256: hex,
        tool: vulnerabilities.tool,
        // release-supply-chain.sh runs grype over exactly sbom.syft.json.
        sbomSha256,
        findings: vulnerabilities.findings,
      }),
      scanSecrets: async () => ({ kind: "secret-scan", subjectSha256: hex, tool: scanFacts.tool, findings: scanFacts.findings }),
      verifyProvenance: async () => ({
        kind: "provenance-attestation",
        subjectSha256: hex,
        tool: { name: "cosign", version: cosignVersion },
        valid: true,
        predicateType: provenance.predicateType,
        issuedAt: provenance.issuedAt,
        attestationSha256: provenance.attestationSha256,
      }),
    },
    WORKSPACE_HOST_PUBLICATION_TRUST_POLICY,
    { now },
  );
  return {
    trustReport,
    bake,
    sourceRevision,
    baseImage,
    excluded: {
      unfixed: narrowed.excludedUnfixed,
      genericKernelCpe: narrowed.excludedGenericKernelCpe,
      staleBaseObject: narrowed.excludedStaleBaseObject,
      vendorPending: narrowed.excludedVendorPending,
    },
    staleBaseObjectIds: narrowed.staleBaseObjectIds,
    vendorPendingIds: narrowed.vendorPendingIds,
    installedRpms: installedRpmVersions(sbomDoc),
  };
}

async function gitBlob(repoRoot: string, revision: string, path: string): Promise<Buffer> {
  const timeoutMs = 30000;
  return await runGovernedOperation({
    workspaceId: activeWorkspaceId(),
    namespace: "bootc-release-source-verification",
    owner: process.env.PAPERCUSP_SID || `bootc-release-source:${process.pid}`,
    admissionClass: "process",
    demand: { fileDescriptors: 3 },
    leaseTtlMs: governedExecutionLeaseTtlForTimeout(timeoutMs),
    dedicatedClient: true,
  }, async () => await new Promise<Buffer>((resolveBlob, rejectBlob) => {
    execFile("git", ["-C", repoRoot, "show", `${revision}:${path}`], {
      encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs,
    }, (error, stdout) => {
      if (error) rejectBlob(new Error(`${path} is not readable at the bake's recorded revision ${revision}`));
      else resolveBlob(stdout);
    });
  }));
}

export interface BootcArtifactBuild extends BootcTrustBuild {
  artifact: Extract<WorkspaceHostImageArtifact, { hostModel: "bootc-image" }>;
  publishedAt: string;
}

/** Build the ONE artifact every emitted document is bound to. */
export async function buildBootcImageArtifact(
  args: BootcImageReleaseRequestCliArgs,
  now: () => number = Date.now,
): Promise<BootcArtifactBuild> {
  const trust = await buildBootcTrustReport(args, now);
  const loaded = await loadInput(args);
  const publication = await readJson(loaded.path("publicationManifest"), "publication manifest");
  const published = requiredRecord(publication.artifact, "publication manifest artifact");
  const release = requiredRecord(published.release, "publication manifest artifact.release");
  const manifest = requiredRecord(published.buildManifest, "publication manifest artifact.buildManifest");
  const releaseArtifact = requiredRecord(manifest.releaseArtifact, "publication manifest releaseArtifact");
  const publishedTrust = requiredRecord(publication.trustReport, "publication manifest trustReport");
  if (publishedTrust.trusted !== true) fail("the paired server publication is not trusted; refusing to pair a release with it");
  const version = requiredString(release.version, "publication manifest release.version");
  // WI-10005761: refuse BEFORE any clean-room spend. On the bootc model the bootstrap never
  // installs a release, so a bake that does not carry this version boots and then dies at
  // install-runtime; that cost two billable clean rooms on P-012.
  const releaseMismatch = workspaceHostBootcBakeReleaseMismatch(trust.bake, version);
  if (releaseMismatch) fail(releaseMismatch);
  const bundleSha256 = requiredHex(release.bundleSha256, "publication manifest release.bundleSha256");
  if (requiredHex(releaseArtifact.sha256, "publication manifest releaseArtifact.sha256") !== bundleSha256) {
    fail("publication manifest is internally inconsistent: releaseArtifact.sha256 differs from release.bundleSha256");
  }
  const materials: WorkspaceHostBuildMaterial[] = (Array.isArray(manifest.materials) ? manifest.materials : []).map((entry, index) => {
    const record = requiredRecord(entry, `publication manifest materials[${index}]`);
    return {
      path: requiredString(record.path, `publication manifest materials[${index}].path`),
      sha256: requiredHex(record.sha256, `publication manifest materials[${index}].sha256`),
      sizeBytes: Number(record.sizeBytes),
      ...(record.executable === true ? { executable: true } : {}),
    };
  });
  if (materials.length === 0) fail("publication manifest records no materials");

  // The Containerfile the bake built FROM: refused if the working tree has moved since the
  // revision the supply chain recorded — then nobody can say which file the image came from.
  const containerfile = await readBytes(resolve(args.repoRoot, BOOTC_TEMPLATE_PATH), "bootc Containerfile");
  if (!(await gitBlob(args.repoRoot, trust.sourceRevision, BOOTC_TEMPLATE_PATH)).equals(containerfile)) {
    fail(`${BOOTC_TEMPLATE_PATH} differs from its blob at the bake's revision ${trust.sourceRevision}; re-bake or check out that revision`);
  }
  const baseArg = /^ARG PAPERCUSP_BASE_IMAGE=(\S+)$/m.exec(containerfile.toString("utf8"))?.[1];
  if (baseArg !== WORKSPACE_HOST_BOOTC_BASE_IMAGE) {
    fail(`Containerfile builds FROM '${String(baseArg)}', but the attested bootc base is '${WORKSPACE_HOST_BOOTC_BASE_IMAGE}'`);
  }

  const aws = requiredRecord(loaded.input.aws, "aws");
  const targets = Array.isArray(aws.targets) ? aws.targets : fail("aws.targets must be an array");
  const regions = targets.map((target, index) =>
    requiredString(requiredRecord(target, `aws.targets[${index}]`).region, `aws.targets[${index}].region`),
  );
  const baseImage = requiredRecord(loaded.input.baseImage, "baseImage");
  const architecture = requiredString(baseImage.architecture, "baseImage.architecture");
  // WI-10005711: the base digest is a fact of the signed image, never a hand-copied input.
  if (baseImage.sha256 !== undefined) {
    fail(
      `baseImage.sha256 must not be supplied: the release reads the base digest from the signed image manifest's ${OCI_BASE_DIGEST_ANNOTATION}`,
    );
  }
  const signedBase =
    trust.baseImage ??
    fail(
      `the signed image manifest records no ${OCI_BASE_NAME_ANNOTATION}/${OCI_BASE_DIGEST_ANNOTATION}, so the release cannot attest the base it was built from`,
    );
  if (signedBase.reference !== WORKSPACE_HOST_BOOTC_BASE_IMAGE) {
    fail(`the image was built FROM '${signedBase.reference}', but the attested bootc base is '${WORKSPACE_HOST_BOOTC_BASE_IMAGE}'`);
  }
  const source = requiredRecord(manifest.source, "publication manifest source");

  const buildManifest = buildWorkspaceHostBuildManifest({
    contractVersion: WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
    distributionProfile: "vm-release",
    source: { repository: requiredString(source.repository, "publication manifest source.repository"), revision: trust.sourceRevision },
    releaseArtifact: {
      name: requiredString(releaseArtifact.name, "publication manifest releaseArtifact.name"),
      version,
      sha256: bundleSha256,
      sizeBytes: Number(releaseArtifact.sizeBytes),
    },
    baseImage: {
      reference: WORKSPACE_HOST_BOOTC_BASE_IMAGE,
      architecture,
      // The per-platform manifest digest buildah resolved the FROM tag to, bound to the signed image.
      sha256: signedBase.sha256,
    },
    builder: {
      strategy: "shared",
      kind: WORKSPACE_HOST_BOOTC_BUILDER_KIND,
      version: requiredString(requiredRecord(loaded.input.builder, "builder").version, "builder.version"),
      templatePath: BOOTC_TEMPLATE_PATH,
      templateSha256: digestOf(containerfile),
    },
    materials,
    parameters: [
      { name: "distribution_profile", value: "vm-release" },
      { name: "bootc_image_digest", value: trust.bake.digest },
    ],
    targets: [{ provider: "aws", locations: regions }],
  });

  const publishedAt = requiredTimestamp(loaded.input.publishedAt, "publishedAt");
  const rules = Array.isArray(published.compatibility) ? published.compatibility : [];
  const { ubuntuVersion: _ubuntu, provider: _provider, ...ruleRest } = requiredRecord(rules[0], "publication manifest compatibility[0]");
  const artifact = {
    contractVersion: WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
    image: { id: "papercusp-workspace-host", version },
    hostModel: "bootc-image" as const,
    bootc: {
      image: `${trust.bake.image}:${trust.bake.tag}`,
      imageDigest: trust.bake.digest,
      baseImage: WORKSPACE_HOST_BOOTC_BASE_IMAGE,
      signaturePolicyPath: WORKSPACE_HOST_CONTAINERS_POLICY_PATH,
    },
    buildManifest,
    release: {
      version,
      bundleUrl: requiredString(release.bundleUrl, "publication manifest release.bundleUrl"),
      bundleSha256,
      signatureUrl: requiredString(release.signatureUrl, "publication manifest release.signatureUrl"),
      signingKeySha256: requiredHex(release.signingKeySha256, "publication manifest release.signingKeySha256"),
      // Verbatim: its digest is taken over the exact bytes, trailing newline included.
      signingPublicKey:
        typeof release.signingPublicKey === "string" && release.signingPublicKey.trim()
          ? release.signingPublicKey
          : fail("publication manifest release.signingPublicKey must be a non-empty string"),
    },
    lifecycle: { state: "active" as const, publishedAt },
    compatibility: [
      { ...ruleRest, provider: "aws", architecture, hostModel: "bootc-image", bootcBaseImage: WORKSPACE_HOST_BOOTC_BASE_IMAGE },
    ],
  } as unknown as Extract<WorkspaceHostImageArtifact, { hostModel: "bootc-image" }>;
  return { ...trust, artifact, publishedAt };
}

/** Compose the AWS request; run the release gate over it before anything is written. */
export async function composeBootcAwsRequest(
  args: BootcImageReleaseRequestCliArgs,
  now: () => number = Date.now,
): Promise<{ request: AwsAmiReleaseRequest; connection: Record<string, unknown> }> {
  const built = await buildBootcImageArtifact(args, now);
  if (!built.trustReport.trusted) {
    fail(`bootc image is not trusted: ${built.trustReport.failures.map((item) => item.message).join("; ")}`);
  }
  const loaded = await loadInput(args);
  const reportDocument = await readJson(resolve(args.cleanRoomReportFile!), "clean-room report");
  const cleanRoomReport = requiredRecord(reportDocument.cleanRoomReport ?? reportDocument, "clean-room report");
  const reportImage = requiredRecord(cleanRoomReport.image, "clean-room report image");
  if (reportImage.id !== built.artifact.image.id || reportImage.version !== built.artifact.image.version) {
    fail(
      `clean-room report is for ${String(reportImage.id)}@${String(reportImage.version)}, not ` +
        `${built.artifact.image.id}@${built.artifact.image.version}; re-run it against --emit clean-room-input`,
    );
  }
  const aws = requiredRecord(loaded.input.aws, "aws");
  const connection = requiredRecord(loaded.input.connection, "connection");
  if (connection.target !== "aws") fail(`connection.target must be 'aws', got '${String(connection.target)}'`);
  const releaseGate = {
    artifact: built.artifact,
    bootcBakeManifest: built.bake,
    trustReport: built.trustReport,
    compatibilityRequest: {
      action: "install" as const,
      provider: "aws" as const,
      architecture: built.artifact.buildManifest.baseImage.architecture,
      hostModel: "bootc-image" as const,
      bootcBaseImage: WORKSPACE_HOST_BOOTC_BASE_IMAGE,
      observedAt: built.publishedAt,
    },
    cleanRoomReport: cleanRoomReport as unknown as AwsAmiReleaseRequest["releaseGate"]["cleanRoomReport"],
  };
  const gate = evaluateWorkspaceHostReleaseGate(releaseGate);
  if (!gate.accepted) {
    fail(`the composed request would be refused by the release gate: ${gate.failures.map((item) => `${item.code}: ${item.message}`).join("; ")}`);
  }
  const request = {
    releaseGate,
    publisherAccountId: requiredString(aws.publisherAccountId, "aws.publisherAccountId"),
    sourceRegion: requiredString(aws.sourceRegion, "aws.sourceRegion"),
    targets: aws.targets,
    ...(aws.previousPins !== undefined ? { previousPins: aws.previousPins } : {}),
    cleanAccount: requiredRecord(aws.cleanAccount, "aws.cleanAccount"),
    publishedAt: built.publishedAt,
    deprecatePreviousAt: requiredTimestamp(aws.deprecatePreviousAt, "aws.deprecatePreviousAt"),
    // WI-10006386: derived from the bake's own SBOM; the AMI is tagged with exactly these.
    guestToolVersions: requiredGuestToolVersions(built.installedRpms, AWS_AMI_REQUIRED_GUEST_TOOLS),
  } as unknown as AwsAmiReleaseRequest;
  return { request, connection };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseBootcImageReleaseRequestCliArgs(argv);
  const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  if (args.emit === "request") {
    write(await composeBootcAwsRequest(args));
    return;
  }
  if (args.emit === "trust-report") {
    const trust = await buildBootcTrustReport(args);
    process.stderr.write(
      `trusted=${trust.trustReport.trusted} excluded unfixed=${trust.excluded.unfixed} genericEl9KernelCpe=${trust.excluded.genericKernelCpe} ` +
        `staleBaseObject=${trust.excluded.staleBaseObject} vendorPending=${trust.excluded.vendorPending}\n`,
    );
    write({
      trustReport: trust.trustReport,
      staleBaseObjects: trust.staleBaseObjectIds,
      vendorPending: trust.vendorPendingIds,
    });
    return;
  }
  const built = await buildBootcImageArtifact(args);
  if (args.emit === "guest-tool-versions") {
    // A flat name -> version object: usable as a request's guestToolVersions or as the
    // release CLI's --guest-tool-versions-file, and derived from the same SBOM either way.
    process.stderr.write(`guest-tool versions for ${args.provider} from the SBOM of ${built.bake.digest}\n`);
    write(requiredGuestToolVersions(built.installedRpms, BOOTC_RELEASE_GUEST_TOOLS[args.provider!]));
    return;
  }
  if (args.emit === "artifact") {
    write({ artifact: built.artifact, bootcBakeManifest: built.bake });
    return;
  }
  // clean-room-input: the SAME artifact the request will carry, so the identity check cannot fail
  // for an avoidable reason.
  const loaded = await loadInput(args);
  const cleanRoom = requiredRecord(loaded.input.cleanRoom, "cleanRoom");
  const placement = requiredRecord(cleanRoom.placement, "cleanRoom.placement");
  // An AWS clean room boots the bake's own AWS disk (WI-10005633): its bake-manifest row is
  // derived here from the same bake the artifact came from, never copied in by hand.
  const aws = placement.provider === "aws";
  write({
    artifact: built.artifact,
    placement: aws ? { ...placement, bootcArtifact: workspaceHostBootcCloudArtifact(built.bake, "aws") } : placement,
    spec: { ...requiredRecord(cleanRoom.spec, "cleanRoom.spec"), hostModel: "bootc-image", bootcBaseImage: WORKSPACE_HOST_BOOTC_BASE_IMAGE },
    ...(aws ? { connection: requiredRecord(cleanRoom.connection, "cleanRoom.connection") } : {}),
  });
}

if (isCliEntry(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
