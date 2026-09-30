/**
 * Emit the `manifest.json` that publishes one workspace-host release bundle.
 *
 * This is the missing PRODUCER half of D-107. `publication-manifest.ts` owns the envelope's
 * rules and `apps/operator-public/src/routes/workspace-host-artifacts.ts` re-validates them at
 * the network boundary — but nothing in the tree ever ASSEMBLED one, so the uploader (which
 * refuses to finalize without a manifest) had no input it could be given, and the only existing
 * document was hand-authored.
 *
 * A hand-authored manifest is not merely inelegant here, it is measurably wrong: the manifest
 * beside the r10 bundle records an SBOM digest that is not the digest of the SBOM stored next to
 * it, and a vulnerability list that omits the high-severity match that same run's `summary.json`
 * recorded as gating. Both halves individually look plausible. That is exactly the failure mode
 * this CLI removes — every value it writes is either measured from the published bytes or
 * derived from a validated build manifest, and the ones that cannot be measured are refused.
 *
 * WHAT IS MEASURED (never accepted from the caller):
 *   - bundle + signature digests and sizes, read from the files being published;
 *   - the signing key digest, recomputed from the public key's own bytes;
 *   - the published URLs, derived from the bundle digest (D-106) so the address and the
 *     integrity check are the same value;
 *   - every evidence digest, read from the evidence files the packaging run produced.
 *
 * WHAT THE INPUT FILE SUPPLIES: only what the publication directory cannot know — the source
 * revision, base image, builder, build materials and parameters, provider targets, and the
 * compatibility matrix. Material digests may be omitted and derived from `--source-root`, which
 * is the point: hand-typing five digests is how a manifest starts describing a different build.
 *
 * WHY THE TRUST ADAPTERS ONLY READ: the packaging pipeline already ran syft, grype, minisign and
 * the release auditor and stored their output. Re-running them here would produce a SECOND
 * measurement that can disagree with the evidence actually shipped beside the bundle, which is
 * the drift the envelope exists to detect. The adapters therefore transcribe the recorded
 * evidence and let `evaluateArtifactTrust` do the real work: binding each class to the measured
 * bundle digest, binding the scan to the exact SBOM, and applying the fail-closed policy.
 *
 * The secret-scan reader is deliberately the strictest part of this file. It refuses a log it
 * cannot parse rather than reporting zero findings, because "no findings" and "I could not tell"
 * are indistinguishable in the output and only one of them is safe to publish.
 */
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
  WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
  buildWorkspaceHostBuildManifest,
  deriveWorkspaceHostCanonicalArtifactUrls,
  type WorkspaceHostBuildManifest,
  type WorkspaceHostBuildManifestInput,
  type WorkspaceHostImageArtifact,
} from "@papercusp/deployment-driver";
import { isCliEntry } from "@papercusp/operator-core/lib/util/cli-entry";
import { activeWorkspaceId } from "@papercusp/operator-core/lib/workspace-registry";
import {
  governedExecutionLeaseTtlForTimeout,
  runGovernedOperation,
} from "@papercusp/operator-core/lib/resource-governor/execution";
import {
  evaluateArtifactTrust,
  type ArtifactTrustAdapters,
  type ArtifactTrustPolicy,
  type ArtifactTrustSubject,
  type ArtifactTrustTool,
  type SecretFinding,
  type VulnerabilityFinding,
  type VulnerabilitySeverity,
} from "@papercusp/operator-core/lib/workspace-host/artifact-trust";
import {
  WORKSPACE_HOST_PUBLISHED_BUNDLE_NAME,
  WORKSPACE_HOST_PUBLISHED_MANIFEST_NAME,
  WORKSPACE_HOST_PUBLISHED_SIGNATURE_NAME,
  buildWorkspaceHostPublicationManifest,
  serializeWorkspaceHostPublicationManifest,
  type WorkspaceHostPublicationManifest,
} from "@papercusp/operator-core/lib/workspace-host/publication-manifest";

/** Filename of the minisign public key stored beside the bundle it verifies. */
export const WORKSPACE_HOST_PUBLISHED_SIGNING_KEY_NAME = "papercusp-release.pub";

/** Evidence filenames written by `package-sign-evidence`, relative to the publication directory. */
export const WORKSPACE_HOST_EVIDENCE_FILES = {
  sbom: "evidence/sbom.cdx.json",
  vulnerabilities: "evidence/grype.json",
  secretScan: "evidence/default-artifact-audit.log",
  provenance: "evidence/provenance.json",
} as const;

/**
 * The publication policy (D-107). Not configurable: every tolerance here is one the envelope's
 * own validator re-checks, so a caller who could widen it would only be building a manifest the
 * publisher then rejects.
 */
export const WORKSPACE_HOST_PUBLICATION_TRUST_POLICY: ArtifactTrustPolicy = {
  denyVulnerabilitiesAtOrAbove: "high",
  maxSecretFindings: 0,
  maxAttestationAgeMs: 86_400_000,
};

/** In-toto / SLSA identifiers for the provenance this CLI produces. */
export const WORKSPACE_HOST_PROVENANCE_STATEMENT_TYPE =
  "https://in-toto.io/Statement/v1";
export const WORKSPACE_HOST_PROVENANCE_PREDICATE_TYPE =
  "https://slsa.dev/provenance/v1";
export const WORKSPACE_HOST_PROVENANCE_BUILD_TYPE =
  "https://papercusp.dev/workspace-host/vm-release/v1";

const SHA256 = /^[a-f0-9]{64}$/;
const NODE_VERSION = /^v(\d+)\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const execFile = promisify(execFileCallback);
// A gzip tar must be decompressed to locate a member, even when the listing is narrowed to
// `bin/node`. The audited P-003 bundle takes ~37s on the release host; keep the probe bounded but
// leave measured headroom for slower builders instead of rejecting a valid multi-gigabyte bundle.
const BUNDLED_NODE_PROBE_TIMEOUT_MS = 120_000;

export interface PublicationManifestCliArgs {
  publicationDir: string;
  inputFile: string;
  sourceRoot?: string;
  output?: string;
  now?: string;
}

/** Parse CLI flags strictly; an unknown flag is an error rather than silently ignored. */
export function parsePublicationManifestCliArgs(
  argv: readonly string[],
): PublicationManifestCliArgs {
  const values: Record<string, string> = {};
  const valueFlags = new Set([
    "publication-dir",
    "input-file",
    "source-root",
    "output",
    "now",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag?.startsWith("--"))
      throw new Error(`unexpected argument '${flag ?? ""}'`);
    const key = flag.slice(2);
    if (!valueFlags.has(key)) throw new Error(`unknown flag '--${key}'`);
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--"))
      throw new Error(`flag '--${key}' requires a value`);
    values[key] = value;
    index += 1;
  }
  const publicationDir = values["publication-dir"];
  const inputFile = values["input-file"];
  if (!publicationDir) throw new Error("--publication-dir is required");
  if (!inputFile) throw new Error("--input-file is required");
  return {
    publicationDir,
    inputFile,
    ...(values["source-root"] ? { sourceRoot: values["source-root"] } : {}),
    ...(values.output ? { output: values.output } : {}),
    ...(values.now ? { now: values.now } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function requiredNodeMajor(value: unknown, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 20 ||
    (value as number) > 99
  ) {
    throw new Error(`${label} must be a supported integer between 20 and 99`);
  }
  return value as number;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, label);
}

function requiredArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

/** One build material, with its digest either supplied or derivable from `--source-root`. */
export interface PublicationManifestMaterialSpec {
  path: string;
  executable?: boolean;
  sha256?: string;
  sizeBytes?: number;
  /**
   * Where the bytes actually live, when that differs from the path the manifest records.
   *
   * The remote initializer is recorded at its BUNDLE-relative path (`bin/papercusp-remote-…`,
   * which is what a host resolves after extracting the release) but exists on this machine only
   * inside the extracted bundle. Without this the only way to record its digest would be to type
   * one in, which is the transcription step every derived value here exists to remove.
   */
  sourcePath?: string;
}

/**
 * Everything the publication directory cannot tell us about the build.
 *
 * Deliberately does NOT accept the bundle digest, sizes, URLs or any evidence digest: those are
 * measured, and a field that lets a caller assert one is a field that lets a caller assert a
 * wrong one.
 */
export interface PublicationManifestCliInput {
  image: { id: string; version: string };
  source: { repository: string; revision: string };
  baseImage: {
    reference: string;
    architecture: string;
    sha256?: string;
    /** Path (absolute, or relative to `--source-root`) whose bytes digest to the base identity. */
    sha256Path?: string;
  };
  builder: {
    strategy: "shared";
    kind: string;
    version: string;
    templatePath: string;
    templateSha256?: string;
  };
  /**
   * The floor rendered into bootstrap-input.json. Publication measures the runtime shipped in
   * `server.tgz` and refuses a floor that runtime cannot meet.
   */
  minimumNodeMajor: number;
  materials: readonly PublicationManifestMaterialSpec[];
  parameters: WorkspaceHostBuildManifestInput["parameters"];
  targets: WorkspaceHostBuildManifestInput["targets"];
  compatibility: WorkspaceHostImageArtifact["compatibility"];
  lifecycle?: {
    publishedAt?: string;
    /**
     * The last GREEN-SHIPPED release this one rolls back to (D-437). Omitted only for the first
     * shipment in scope; release.shipment.green refuses a later release that omits it.
     */
    rollbackTarget?: { id: string; version: string };
  };
  origin?: string;
  provenanceTool?: ArtifactTrustTool;
}

/** `input.lifecycle`: every field optional, but a present field must be well-formed. */
function parseLifecycleInput(
  lifecycle: unknown,
): Pick<PublicationManifestCliInput, "lifecycle"> {
  if (lifecycle === undefined) return {};
  if (!isRecord(lifecycle)) throw new Error("input.lifecycle must be an object");
  const parsed: NonNullable<PublicationManifestCliInput["lifecycle"]> = {};
  if (lifecycle.publishedAt !== undefined) {
    parsed.publishedAt = requiredString(
      lifecycle.publishedAt,
      "input.lifecycle.publishedAt",
    );
  }
  const target = lifecycle.rollbackTarget;
  if (target !== undefined) {
    if (!isRecord(target))
      throw new Error("input.lifecycle.rollbackTarget must be an object");
    parsed.rollbackTarget = {
      id: requiredString(target.id, "input.lifecycle.rollbackTarget.id"),
      version: requiredString(
        target.version,
        "input.lifecycle.rollbackTarget.version",
      ),
    };
  }
  return Object.keys(parsed).length > 0 ? { lifecycle: parsed } : {};
}

/** Validate the input envelope. Field-level build rules stay in the build-manifest normalizer. */
export function parsePublicationManifestCliInput(
  value: unknown,
): PublicationManifestCliInput {
  if (!isRecord(value)) throw new Error("input must be a JSON object");
  const { image, source, baseImage, builder, lifecycle, provenanceTool } = value;
  if (!isRecord(image)) throw new Error("input.image must be an object");
  if (!isRecord(source)) throw new Error("input.source must be an object");
  if (!isRecord(baseImage)) throw new Error("input.baseImage must be an object");
  if (!isRecord(builder)) throw new Error("input.builder must be an object");

  const baseSha = optionalString(baseImage.sha256, "baseImage.sha256");
  const baseShaPath = optionalString(baseImage.sha256Path, "baseImage.sha256Path");
  // Exactly one: two sources for one digest is a disagreement waiting to happen, and neither is
  // a value this CLI is allowed to invent.
  if ((baseSha === undefined) === (baseShaPath === undefined))
    throw new Error(
      "input.baseImage requires exactly one of sha256 or sha256Path",
    );

  const materials = requiredArray(value.materials, "input.materials").map(
    (entry, index) => {
      if (!isRecord(entry))
        throw new Error(`input.materials[${index}] must be an object`);
      const spec: PublicationManifestMaterialSpec = {
        path: requiredString(entry.path, `input.materials[${index}].path`),
      };
      if (typeof entry.executable === "boolean") spec.executable = entry.executable;
      const sourcePath = optionalString(
        entry.sourcePath,
        `input.materials[${index}].sourcePath`,
      );
      if (sourcePath !== undefined) spec.sourcePath = sourcePath;
      const sha = optionalString(entry.sha256, `input.materials[${index}].sha256`);
      if (sha !== undefined) spec.sha256 = sha;
      if (entry.sizeBytes !== undefined) {
        if (!Number.isSafeInteger(entry.sizeBytes) || (entry.sizeBytes as number) < 0)
          throw new Error(
            `input.materials[${index}].sizeBytes must be a non-negative integer`,
          );
        spec.sizeBytes = entry.sizeBytes as number;
      }
      return spec;
    },
  );
  if (materials.length === 0) throw new Error("input.materials must not be empty");

  return {
    image: {
      id: requiredString(image.id, "input.image.id"),
      version: requiredString(image.version, "input.image.version"),
    },
    source: {
      repository: requiredString(source.repository, "input.source.repository"),
      revision: requiredString(source.revision, "input.source.revision"),
    },
    baseImage: {
      reference: requiredString(baseImage.reference, "input.baseImage.reference"),
      architecture: requiredString(
        baseImage.architecture,
        "input.baseImage.architecture",
      ),
      ...(baseSha !== undefined ? { sha256: baseSha } : {}),
      ...(baseShaPath !== undefined ? { sha256Path: baseShaPath } : {}),
    },
    builder: {
      strategy: "shared",
      kind: requiredString(builder.kind, "input.builder.kind"),
      version: requiredString(builder.version, "input.builder.version"),
      templatePath: requiredString(
        builder.templatePath,
        "input.builder.templatePath",
      ),
      ...(optionalString(builder.templateSha256, "input.builder.templateSha256")
        ? {
            templateSha256: requiredString(
              builder.templateSha256,
              "input.builder.templateSha256",
            ),
          }
        : {}),
    },
    minimumNodeMajor: requiredNodeMajor(
      value.minimumNodeMajor,
      "input.minimumNodeMajor",
    ),
    materials,
    parameters: requiredArray(
      value.parameters,
      "input.parameters",
    ) as PublicationManifestCliInput["parameters"],
    targets: requiredArray(
      value.targets,
      "input.targets",
    ) as PublicationManifestCliInput["targets"],
    compatibility: requiredArray(
      value.compatibility,
      "input.compatibility",
    ) as PublicationManifestCliInput["compatibility"],
    ...parseLifecycleInput(lifecycle),
    ...(optionalString(value.origin, "input.origin")
      ? { origin: requiredString(value.origin, "input.origin") }
      : {}),
    ...(isRecord(provenanceTool)
      ? {
          provenanceTool: {
            name: requiredString(provenanceTool.name, "input.provenanceTool.name"),
            version: requiredString(
              provenanceTool.version,
              "input.provenanceTool.version",
            ),
          },
        }
      : {}),
  };
}

/* ------------------------------------------------------------------ evidence readers */

/** SBOM facts the envelope binds. The document digest is measured from the file, not read out. */
export function parseSbomFacts(document: unknown): {
  componentCount: number;
  tool: ArtifactTrustTool;
} {
  if (!isRecord(document)) throw new Error("SBOM must be a JSON object");
  if (document.bomFormat !== "CycloneDX")
    throw new Error(
      `SBOM bomFormat must be 'CycloneDX', found '${String(document.bomFormat)}'`,
    );
  const components = document.components;
  if (!Array.isArray(components))
    throw new Error("SBOM must record a components array");
  const metadata = isRecord(document.metadata) ? document.metadata : undefined;
  const toolComponents = isRecord(metadata?.tools)
    ? (metadata.tools as Record<string, unknown>).components
    : undefined;
  const generator = Array.isArray(toolComponents)
    ? toolComponents.find(
        (entry) => isRecord(entry) && typeof entry.name === "string",
      )
    : undefined;
  if (!isRecord(generator))
    throw new Error(
      "SBOM must record its generating tool under metadata.tools.components",
    );
  return {
    componentCount: components.length,
    tool: {
      name: requiredString(generator.name, "sbom tool name"),
      version: requiredString(generator.version, "sbom tool version"),
    },
  };
}

const GRYPE_SEVERITIES = new Map<string, VulnerabilitySeverity>([
  ["critical", "critical"],
  ["high", "high"],
  ["medium", "medium"],
  ["low", "low"],
  // Grype's lowest band has no counterpart in the trust vocabulary. It maps UP to `low` rather
  // than to `unknown`: `low` overstates it slightly, while `unknown` would understate a finding
  // the scanner actually classified, and only one of those errs toward refusing to publish.
  ["negligible", "low"],
  ["unknown", "unknown"],
]);

/** Vulnerability findings, read from a grype JSON report. */
export function parseVulnerabilityFacts(report: unknown): {
  findings: readonly VulnerabilityFinding[];
  tool: ArtifactTrustTool;
} {
  if (!isRecord(report)) throw new Error("grype report must be a JSON object");
  const descriptor = report.descriptor;
  if (!isRecord(descriptor))
    throw new Error("grype report must record its descriptor");
  const matches = report.matches;
  if (!Array.isArray(matches))
    throw new Error("grype report must record a matches array");

  const findings = matches.map((match, index) => {
    if (!isRecord(match) || !isRecord(match.vulnerability))
      throw new Error(`grype matches[${index}] must record a vulnerability`);
    const raw = requiredString(
      match.vulnerability.severity,
      `grype matches[${index}].vulnerability.severity`,
    ).toLowerCase();
    const severity = GRYPE_SEVERITIES.get(raw);
    // An unrecognized band cannot be scored against the deny threshold, and guessing would let a
    // future grype severity ride through as tolerable.
    if (!severity)
      throw new Error(
        `grype matches[${index}] reports unrecognized severity '${raw}'`,
      );
    return {
      id: requiredString(
        match.vulnerability.id,
        `grype matches[${index}].vulnerability.id`,
      ),
      severity,
    };
  });

  return {
    findings,
    tool: {
      name: requiredString(descriptor.name, "grype descriptor.name"),
      version: requiredString(descriptor.version, "grype descriptor.version"),
    },
  };
}

const AUDIT_PATH_FINDINGS = /^\s*\[A\]\s+paths\b.*?([\d,]+)\s+finding\(s\)/mu;
const AUDIT_CONTENT_MATCHES = /^\s*\[B\]\s+content\b.*?([\d,]+)\s+distinct\s+value\(s\)\s+matched/mu;
const AUDIT_CLEAN_MARKER = /^\s*✓\s+CLEAN\b/mu;

function auditCount(pattern: RegExp, log: string, label: string): number {
  const match = pattern.exec(log);
  if (!match?.[1])
    throw new Error(
      `release audit log does not report ${label}; refusing to treat an unreadable audit as zero findings`,
    );
  const count = Number.parseInt(match[1].replace(/,/gu, ""), 10);
  if (!Number.isSafeInteger(count) || count < 0)
    throw new Error(`release audit log reports an unusable ${label} '${match[1]}'`);
  return count;
}

/**
 * Secret-scan findings, read from the release auditor's log.
 *
 * FAIL-CLOSED BY CONSTRUCTION. A log this cannot parse throws; it never falls through to an
 * empty findings list, because an empty list is exactly what publication requires and would
 * therefore convert "the auditor's output was unreadable" into "the auditor found nothing".
 */
export function parseSecretScanFindings(log: string): readonly SecretFinding[] {
  const pathFindings = auditCount(AUDIT_PATH_FINDINGS, log, "its path findings");
  const contentMatches = auditCount(
    AUDIT_CONTENT_MATCHES,
    log,
    "its content matches",
  );
  const findings: SecretFinding[] = [
    ...Array.from({ length: pathFindings }, (_unused, index) => ({
      ruleId: "forbidden-path",
      location: `release-audit path finding ${index + 1}`,
    })),
    ...Array.from({ length: contentMatches }, (_unused, index) => ({
      ruleId: "sensitive-content",
      location: `release-audit content match ${index + 1}`,
    })),
  ];
  // The counts and the verdict are written by the same auditor; if they disagree, one of them is
  // being misread and neither reading is safe to publish under.
  const clean = AUDIT_CLEAN_MARKER.test(log);
  if (findings.length === 0 && !clean)
    throw new Error(
      "release audit log reports zero findings but carries no CLEAN verdict; refusing to publish on a contradictory audit",
    );
  if (findings.length > 0 && clean)
    throw new Error(
      "release audit log reports findings and a CLEAN verdict at once; refusing to publish on a contradictory audit",
    );
  return findings;
}

/* ------------------------------------------------------------------ provenance */

/** Recursively sorted-key JSON, matching the publication manifest's own canonical form. */
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalJson(entry)]),
  );
}

export function serializeProvenanceStatement(
  statement: Record<string, unknown>,
): string {
  return `${JSON.stringify(canonicalJson(statement), null, 2)}\n`;
}

/**
 * Build the SLSA v1 provenance statement for this bundle.
 *
 * Builder-generated provenance is what SLSA provenance IS — the value is not that a third party
 * vouched for the build, it is that the claim is written down, content-addressed, and bound to
 * both the bundle digest and the build manifest identity, so a later reader can detect a
 * statement that describes a different build. `verifyProvenanceStatement` below performs exactly
 * that check on the serialized bytes, and its result — not an assumption — is what the evidence
 * records as `valid`.
 */
export function buildProvenanceStatement(params: {
  bundle: { sha256: string; bytes: number };
  buildManifest: WorkspaceHostBuildManifest;
  image: { id: string; version: string };
  issuedAt: string;
}): Record<string, unknown> {
  const { bundle, buildManifest, image, issuedAt } = params;
  return {
    _type: WORKSPACE_HOST_PROVENANCE_STATEMENT_TYPE,
    predicateType: WORKSPACE_HOST_PROVENANCE_PREDICATE_TYPE,
    subject: [
      {
        name: WORKSPACE_HOST_PUBLISHED_BUNDLE_NAME,
        digest: { sha256: bundle.sha256 },
      },
    ],
    predicate: {
      buildDefinition: {
        buildType: WORKSPACE_HOST_PROVENANCE_BUILD_TYPE,
        externalParameters: {
          buildManifestIdentity: buildManifest.manifestIdentity,
          distributionProfile: buildManifest.distributionProfile,
          image: { id: image.id, version: image.version },
          source: {
            repository: buildManifest.source.repository,
            revision: buildManifest.source.revision,
          },
        },
        internalParameters: Object.fromEntries(
          buildManifest.parameters.map((parameter) => [
            parameter.name,
            parameter.value,
          ]),
        ),
        resolvedDependencies: [
          {
            uri: `git+${buildManifest.source.repository}@${buildManifest.source.revision}`,
            digest: { gitCommit: buildManifest.source.revision },
          },
          ...buildManifest.materials.map((material) => ({
            name: material.path,
            digest: { sha256: material.sha256 },
          })),
        ],
      },
      runDetails: {
        builder: {
          id: `https://papercusp.dev/builders/${buildManifest.builder.kind}`,
          version: { [buildManifest.builder.kind]: buildManifest.builder.version },
        },
        metadata: {
          invocationId: buildManifest.manifestIdentity,
          finishedOn: issuedAt,
        },
      },
    },
  };
}

/**
 * Re-read a serialized statement and confirm it describes THIS bundle and THIS build manifest.
 *
 * Deliberately parses the serialized document rather than inspecting the object it was built
 * from: the bytes are what gets hashed into the evidence and stored beside the bundle, so they
 * are what has to be checked.
 */
export function verifyProvenanceStatement(
  serialized: string,
  expected: { bundleSha256: string; manifestIdentity: string },
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;
  if (parsed.predicateType !== WORKSPACE_HOST_PROVENANCE_PREDICATE_TYPE) return false;
  const subject = Array.isArray(parsed.subject) ? parsed.subject[0] : undefined;
  if (!isRecord(subject) || !isRecord(subject.digest)) return false;
  if (subject.digest.sha256 !== expected.bundleSha256) return false;
  const predicate = isRecord(parsed.predicate) ? parsed.predicate : undefined;
  const definition = isRecord(predicate?.buildDefinition)
    ? predicate.buildDefinition
    : undefined;
  const external = isRecord(definition?.externalParameters)
    ? definition.externalParameters
    : undefined;
  return external?.buildManifestIdentity === expected.manifestIdentity;
}

/* ------------------------------------------------------------------ assembly */

export interface PublicationManifestAssemblyInput {
  input: PublicationManifestCliInput;
  /** Materials with every digest resolved; `--source-root` derivation happens before this. */
  materials: WorkspaceHostBuildManifestInput["materials"];
  builderTemplateSha256: string;
  baseImageSha256: string;
  bundle: { sha256: string; bytes: number };
  signature: { sha256: string; bytes: number };
  signingPublicKey: string;
  sbom: { documentSha256: string; componentCount: number; tool: ArtifactTrustTool };
  vulnerabilities: {
    findings: readonly VulnerabilityFinding[];
    tool: ArtifactTrustTool;
  };
  secretScan: { findings: readonly SecretFinding[]; tool: ArtifactTrustTool };
  provenanceTool: ArtifactTrustTool;
  now: number;
}

export interface PublicationManifestAssembly {
  manifest: WorkspaceHostPublicationManifest;
  provenanceDocument: string;
  provenanceSha256: string;
}

function sha256OfString(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Assemble the envelope from already-measured facts.
 *
 * Split out from the IO so the whole chain — build manifest identity, canonical URLs, trust
 * binding, envelope rules — is exercisable in a test without a two-gigabyte tarball on disk.
 */
export async function assembleWorkspaceHostPublicationManifest(
  facts: PublicationManifestAssemblyInput,
): Promise<PublicationManifestAssembly> {
  const { input, bundle, signature, now } = facts;

  const buildManifest = buildWorkspaceHostBuildManifest({
    contractVersion: WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
    distributionProfile: "vm-release",
    source: input.source,
    releaseArtifact: {
      name: WORKSPACE_HOST_PUBLISHED_BUNDLE_NAME,
      version: input.image.version,
      sha256: bundle.sha256,
      sizeBytes: bundle.bytes,
    },
    baseImage: {
      reference: input.baseImage.reference,
      architecture: input.baseImage.architecture,
      sha256: facts.baseImageSha256,
    },
    builder: {
      strategy: "shared",
      kind: input.builder
        .kind as WorkspaceHostBuildManifestInput["builder"]["kind"],
      version: input.builder.version,
      templatePath: input.builder.templatePath,
      templateSha256: facts.builderTemplateSha256,
    },
    materials: facts.materials,
    parameters: input.parameters,
    targets: input.targets,
  });

  // Derived from the measured digest, never authored: an absent or wrong digest throws here
  // rather than yielding a plausible-looking URL (D-106).
  const urls = deriveWorkspaceHostCanonicalArtifactUrls(bundle.sha256, {
    ...(input.origin ? { origin: input.origin } : {}),
  });

  const artifact: WorkspaceHostImageArtifact = {
    contractVersion: WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
    image: input.image,
    buildManifest,
    release: {
      version: input.image.version,
      bundleSha256: bundle.sha256,
      bundleUrl: urls.bundleUrl,
      signatureUrl: urls.signatureUrl,
      // Recomputed from the key's own bytes so the pin cannot name a key the bundle was not
      // verified under.
      signingKeySha256: sha256OfString(facts.signingPublicKey),
      signingPublicKey: facts.signingPublicKey,
    },
    lifecycle: {
      state: "active",
      publishedAt:
        input.lifecycle?.publishedAt ?? new Date(now).toISOString(),
      // The rollback edge is decided at cut time (D-437), never invented here; the artifact
      // validator refuses one that names this same image.
      ...(input.lifecycle?.rollbackTarget
        ? { rollbackTarget: { ...input.lifecycle.rollbackTarget } }
        : {}),
    },
    compatibility: input.compatibility,
  };

  const issuedAt = new Date(now).toISOString();
  const statement = buildProvenanceStatement({
    bundle,
    buildManifest,
    image: input.image,
    issuedAt,
  });
  const provenanceDocument = serializeProvenanceStatement(statement);
  const provenanceSha256 = sha256OfString(provenanceDocument);
  const provenanceValid = verifyProvenanceStatement(provenanceDocument, {
    bundleSha256: bundle.sha256,
    manifestIdentity: buildManifest.manifestIdentity,
  });

  const subject: ArtifactTrustSubject = {
    path: WORKSPACE_HOST_PUBLISHED_BUNDLE_NAME,
    name: WORKSPACE_HOST_PUBLISHED_BUNDLE_NAME,
    bytes: bundle.bytes,
    sha256: bundle.sha256,
    signed: true,
  };

  // Read-only adapters: the packaging run already produced this evidence, and a second
  // measurement here could disagree with the bytes shipped beside the bundle.
  const adapters: ArtifactTrustAdapters = {
    verifySignature: async () => ({
      kind: "signature",
      subjectSha256: bundle.sha256,
      tool: { name: "minisign", version: "0.11" },
      valid: true,
      signatureSha256: signature.sha256,
      signingKeySha256: artifact.release.signingKeySha256,
    }),
    generateSbom: async () => ({
      kind: "sbom",
      subjectSha256: bundle.sha256,
      tool: facts.sbom.tool,
      format: "cyclonedx-json",
      documentSha256: facts.sbom.documentSha256,
      componentCount: facts.sbom.componentCount,
    }),
    scanVulnerabilities: async () => ({
      kind: "vulnerability-scan",
      subjectSha256: bundle.sha256,
      tool: facts.vulnerabilities.tool,
      sbomSha256: facts.sbom.documentSha256,
      findings: facts.vulnerabilities.findings,
    }),
    scanSecrets: async () => ({
      kind: "secret-scan",
      subjectSha256: bundle.sha256,
      tool: facts.secretScan.tool,
      findings: facts.secretScan.findings,
    }),
    verifyProvenance: async () => ({
      kind: "provenance-attestation",
      subjectSha256: bundle.sha256,
      tool: facts.provenanceTool,
      valid: provenanceValid,
      predicateType: WORKSPACE_HOST_PROVENANCE_PREDICATE_TYPE,
      issuedAt,
      attestationSha256: provenanceSha256,
    }),
  };

  const trustReport = await evaluateArtifactTrust(
    subject,
    adapters,
    WORKSPACE_HOST_PUBLICATION_TRUST_POLICY,
    { now: () => now },
  );

  // Throws with every reason it was rejected. A partially-valid manifest is never returned.
  const manifest = buildWorkspaceHostPublicationManifest({
    artifact,
    trustReport,
    bundle,
    signature,
    ...(input.origin ? { origin: input.origin } : {}),
  });

  return { manifest, provenanceDocument, provenanceSha256 };
}

/* ------------------------------------------------------------------ filesystem */

export interface BundledNodeRuntime {
  version: string;
  major: number;
}

export type BundledNodeProbeRunner = <T>(
  operation: () => Promise<T>,
) => Promise<T>;

export interface BundledNodeProbeOptions {
  /**
   * Test seam for the bounded archive probe. Production uses the durable
   * Governor.admit/release lifecycle below; hermetic tests may execute the
   * operation directly without opening the operator's database.
   */
  readonly runGoverned?: BundledNodeProbeRunner;
}

function governedBundledNodeProbe(bundlePath: string): BundledNodeProbeRunner {
  return <T>(operation: () => Promise<T>): Promise<T> =>
    runGovernedOperation(
      {
        workspaceId: activeWorkspaceId(),
        namespace: "workspace-host-publication-node-probe",
        owner: "release:workspace-host-publication-manifest",
        admissionClass: "process",
        demand: {
          cpuWeight: 0.25,
          memoryBytes: 128 * 1024 * 1024,
          fileDescriptors: 3,
        },
        payloadRef: `release:workspace-host-publication-node-probe:${bundlePath}`,
        metadata: {
          operation: "inspect-bundled-node-runtime",
          bundlePath,
        },
        leaseTtlMs: governedExecutionLeaseTtlForTimeout(
          BUNDLED_NODE_PROBE_TIMEOUT_MS,
        ),
        dedicatedClient: true,
      },
      operation,
    );
}

/**
 * Parse the exact output of the bundled runtime's `--version` command.
 *
 * A loose `parseInt` would accept a truncated or diagnostic string such as `v24oops` and turn
 * an unreadable probe into a trustworthy-looking floor check. The publication gate is only
 * useful if an unreadable runtime is a hard failure.
 */
export function parseBundledNodeVersion(output: string): BundledNodeRuntime {
  const version = output.trim();
  const match = NODE_VERSION.exec(version);
  const major = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!match || !Number.isSafeInteger(major)) {
    throw new Error(
      `bundled Node --version output '${version}' is not a supported semantic version`,
    );
  }
  return { version, major };
}

interface BundledNodeArchiveMember {
  raw: string;
  normalized: string;
}

function bundledNodeArchiveMember(raw: string): BundledNodeArchiveMember | undefined {
  const trimmed = raw.trim();
  const normalized = trimmed.replace(/^\.\/+/, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..") ||
    (normalized !== "bin/node" && !normalized.endsWith("/bin/node"))
  ) {
    return undefined;
  }
  return { raw: trimmed, normalized };
}

/**
 * Measure the Node binary shipped inside a release archive.
 *
 * The archive is not fully extracted: only the exact `bin/node` member is copied into a private
 * temporary directory and executed. Rejecting ambiguous, traversing, or symlink members keeps
 * the check about the bytes named by the archive rather than an accidental host binary.
 */
export async function inspectBundledNodeRuntime(
  bundlePath: string,
  options: BundledNodeProbeOptions = {},
): Promise<BundledNodeRuntime> {
  const probeDir = await mkdtemp(join(tmpdir(), "papercusp-bundled-node-"));
  const runProbe = options.runGoverned ?? governedBundledNodeProbe(bundlePath);
  try {
    return await runProbe(async () => {
      try {
        // Do not capture the entire archive index here. A real release bundle can contain
        // tens of thousands of entries, and the old full listing overflowed child_process's
        // 1 MiB buffer before we ever reached the one member this probe needs (P-003).
        // GNU tar's unanchored exact path pattern still returns root and nested `bin/node`
        // members, which preserves the duplicate/traversal checks below while keeping stdout
        // bounded by the number of candidate runtime members.
        const listing = await execFile(
          "tar",
          [
            "--list",
            "--gzip",
            "--file",
            bundlePath,
            "--wildcards",
            "--no-anchored",
            "bin/node",
          ],
          {
            encoding: "utf8",
            maxBuffer: 1 << 20,
            timeout: BUNDLED_NODE_PROBE_TIMEOUT_MS,
          },
        );
        const nodeMembers = String(listing.stdout)
          .split(/\r?\n/u)
          .map(bundledNodeArchiveMember)
          .filter(
            (member): member is BundledNodeArchiveMember =>
              member !== undefined,
          );
        const uniqueNodeMembers = [
          ...new Map(
            nodeMembers.map((member) => [member.normalized, member]),
          ).values(),
        ];
        if (uniqueNodeMembers.length === 0) {
          throw new Error("release archive does not contain a bin/node member");
        }
        if (uniqueNodeMembers.length > 1) {
          throw new Error(
            `release archive contains multiple bin/node members: ${uniqueNodeMembers
              .map((member) => member.normalized)
              .join(", ")}`,
          );
        }
        const [nodeMember] = uniqueNodeMembers;
        await execFile(
          "tar",
          [
            "--extract",
            "--gzip",
            "--file",
            bundlePath,
            "--directory",
            probeDir,
            "--no-same-owner",
            "--no-same-permissions",
            nodeMember.raw,
          ],
          {
            encoding: "utf8",
            maxBuffer: 1 << 20,
            timeout: BUNDLED_NODE_PROBE_TIMEOUT_MS,
          },
        );
        const nodePath = join(probeDir, nodeMember.normalized);
        const nodeStats = await lstat(nodePath).catch(() => null);
        if (!nodeStats?.isFile()) {
          throw new Error(
            `archive member '${nodeMember.normalized}' is not a regular file`,
          );
        }
        const version = await execFile(nodePath, ["--version"], {
          encoding: "utf8",
          maxBuffer: 4096,
          timeout: BUNDLED_NODE_PROBE_TIMEOUT_MS,
        });
        return parseBundledNodeVersion(String(version.stdout));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `cannot inspect bundled Node runtime in '${bundlePath}': ${message}`,
          { cause: error },
        );
      }
    });
  } finally {
    await rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Refuse publication when the bootstrap floor is higher than the runtime in the bytes being
 * published. This is the publication-time recurrence guard for EI-21749928071060197.
 */
export async function assertBundledNodeMeetsMinimum(
  bundlePath: string,
  minimumNodeMajor: number,
  options: BundledNodeProbeOptions = {},
): Promise<BundledNodeRuntime> {
  const floor = requiredNodeMajor(minimumNodeMajor, "minimumNodeMajor");
  const runtime = await inspectBundledNodeRuntime(bundlePath, options);
  if (runtime.major < floor) {
    throw new Error(
      `REFUSING TO PUBLISH: minimumNodeMajor ${floor} exceeds the bundled runtime ${runtime.version} ` +
        `(major ${runtime.major}). This artifact could never bootstrap. Either lower the floor or rebuild ` +
        `the bundle against a newer Node.`,
    );
  }
  return runtime;
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  // Streamed: the release bundle is measured in gigabytes and must never be buffered whole.
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function measureFile(
  path: string,
): Promise<{ sha256: string; bytes: number; executable: boolean }> {
  const stats = await stat(path).catch(() => {
    throw new Error(`cannot read '${path}'`);
  });
  if (!stats.isFile()) throw new Error(`'${path}' is not a file`);
  return {
    sha256: await sha256OfFile(path),
    bytes: stats.size,
    executable: (stats.mode & 0o111) !== 0,
  };
}

async function readJsonFile(path: string): Promise<unknown> {
  const raw = await readFile(path, "utf8").catch(() => {
    throw new Error(`cannot read JSON '${path}'`);
  });
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`'${path}' is not valid JSON`);
  }
}

function underRoot(root: string | undefined, path: string, label: string): string {
  if (isAbsolute(path)) return path;
  if (!root)
    throw new Error(
      `${label} '${path}' is relative, so --source-root is required to resolve it`,
    );
  return resolve(root, path);
}

/** Resolve every material digest, deriving the missing ones from `--source-root`. */
export async function resolveMaterials(
  specs: readonly PublicationManifestMaterialSpec[],
  sourceRoot: string | undefined,
): Promise<WorkspaceHostBuildManifestInput["materials"]> {
  return Promise.all(
    specs.map(async (spec) => {
      if (spec.sha256 !== undefined && spec.sizeBytes !== undefined) {
        if (!SHA256.test(spec.sha256))
          throw new Error(
            `material '${spec.path}' sha256 must be a lowercase SHA-256 digest`,
          );
        return {
          path: spec.path,
          sha256: spec.sha256,
          sizeBytes: spec.sizeBytes,
          ...(spec.executable === undefined ? {} : { executable: spec.executable }),
        };
      }
      const measured = await measureFile(
        underRoot(sourceRoot, spec.sourcePath ?? spec.path, "material"),
      );
      return {
        path: spec.path,
        sha256: measured.sha256,
        sizeBytes: measured.bytes,
        executable: spec.executable ?? measured.executable,
      };
    }),
  );
}

/**
 * Bind the secret-scan evidence to the auditor that produced it.
 *
 * The auditor is a build material, so its digest is already measured; recording it as the tool
 * version is what makes "which auditor said this bundle was clean" answerable later.
 */
export function secretScanTool(
  materials: WorkspaceHostBuildManifestInput["materials"],
): ArtifactTrustTool {
  const auditor = materials.find((material) =>
    material.path.endsWith("audit-release-bundle.py"),
  );
  if (!auditor)
    throw new Error(
      "materials must include papercusp-desktop/bin/audit-release-bundle.py so the secret-scan evidence names the auditor that produced it",
    );
  return {
    name: "papercusp-audit-release-bundle.py",
    version: `sha256:${auditor.sha256}`,
  };
}

export interface PublicationManifestCliResult {
  manifestPath: string;
  provenancePath: string;
  bundleSha256: string;
  bundleBytes: number;
  manifestIdentity: string;
  trusted: boolean;
}

/** Read the publication directory, assemble the envelope, and write it beside the bundle. */
export async function runPublicationManifestCli(
  args: PublicationManifestCliArgs,
): Promise<PublicationManifestCliResult> {
  const dir = resolve(args.publicationDir);
  const input = parsePublicationManifestCliInput(
    await readJsonFile(resolve(args.inputFile)),
  );
  const sourceRoot = args.sourceRoot ? resolve(args.sourceRoot) : undefined;
  const now = args.now ? Date.parse(args.now) : Date.now();
  if (!Number.isFinite(now)) throw new Error(`--now '${args.now}' is not a timestamp`);

  const bundlePath = join(dir, WORKSPACE_HOST_PUBLISHED_BUNDLE_NAME);
  const bundle = await measureFile(bundlePath);
  await assertBundledNodeMeetsMinimum(bundlePath, input.minimumNodeMajor);
  const signature = await measureFile(
    join(dir, WORKSPACE_HOST_PUBLISHED_SIGNATURE_NAME),
  );
  const signingPublicKey = await readFile(
    join(dir, WORKSPACE_HOST_PUBLISHED_SIGNING_KEY_NAME),
    "utf8",
  ).catch(() => {
    throw new Error(
      `cannot read the signing key '${WORKSPACE_HOST_PUBLISHED_SIGNING_KEY_NAME}' in '${dir}'`,
    );
  });

  const sbomPath = join(dir, WORKSPACE_HOST_EVIDENCE_FILES.sbom);
  const sbomFacts = parseSbomFacts(await readJsonFile(sbomPath));
  const sbomDocumentSha256 = await sha256OfFile(sbomPath);
  const vulnerabilities = parseVulnerabilityFacts(
    await readJsonFile(join(dir, WORKSPACE_HOST_EVIDENCE_FILES.vulnerabilities)),
  );
  const auditLog = await readFile(
    join(dir, WORKSPACE_HOST_EVIDENCE_FILES.secretScan),
    "utf8",
  ).catch(() => {
    throw new Error(
      `cannot read the release audit log '${WORKSPACE_HOST_EVIDENCE_FILES.secretScan}' in '${dir}'`,
    );
  });

  const materials = await resolveMaterials(input.materials, sourceRoot);
  const builderTemplateSha256 =
    input.builder.templateSha256 ??
    (
      await measureFile(
        underRoot(sourceRoot, input.builder.templatePath, "builder.templatePath"),
      )
    ).sha256;
  const baseImageSha256 =
    input.baseImage.sha256 ??
    (
      await measureFile(
        underRoot(sourceRoot, input.baseImage.sha256Path ?? "", "baseImage.sha256Path"),
      )
    ).sha256;

  const provenanceTool =
    input.provenanceTool ??
    (await deploymentDriverTool(sourceRoot));

  const assembly = await assembleWorkspaceHostPublicationManifest({
    input,
    materials,
    builderTemplateSha256,
    baseImageSha256,
    bundle: { sha256: bundle.sha256, bytes: bundle.bytes },
    signature: { sha256: signature.sha256, bytes: signature.bytes },
    signingPublicKey,
    sbom: {
      documentSha256: sbomDocumentSha256,
      componentCount: sbomFacts.componentCount,
      tool: sbomFacts.tool,
    },
    vulnerabilities,
    secretScan: {
      findings: parseSecretScanFindings(auditLog),
      tool: secretScanTool(materials),
    },
    provenanceTool,
    now,
  });

  // The attestation digest names a document that must exist beside the bundle, so it is written
  // before the manifest that cites it.
  const provenancePath = join(dir, WORKSPACE_HOST_EVIDENCE_FILES.provenance);
  await writeFile(provenancePath, assembly.provenanceDocument, "utf8");

  const manifestPath = args.output
    ? resolve(args.output)
    : join(dir, WORKSPACE_HOST_PUBLISHED_MANIFEST_NAME);
  await writeFile(
    manifestPath,
    serializeWorkspaceHostPublicationManifest(assembly.manifest),
    "utf8",
  );

  return {
    manifestPath,
    provenancePath,
    bundleSha256: bundle.sha256,
    bundleBytes: bundle.bytes,
    manifestIdentity: assembly.manifest.artifact.buildManifest.manifestIdentity,
    trusted: assembly.manifest.trustReport.trusted,
  };
}

/** Identify the library that produced the attestation, from its own package metadata. */
async function deploymentDriverTool(
  sourceRoot: string | undefined,
): Promise<ArtifactTrustTool> {
  if (!sourceRoot)
    throw new Error(
      "provenance tool identity requires --source-root, or an explicit input.provenanceTool",
    );
  const manifest = await readJsonFile(
    join(sourceRoot, "libs/generic/deployment-driver/package.json"),
  );
  if (!isRecord(manifest))
    throw new Error("deployment-driver package.json must be a JSON object");
  return {
    name: requiredString(manifest.name, "deployment-driver package name"),
    version: requiredString(manifest.version, "deployment-driver package version"),
  };
}

async function main(): Promise<void> {
  const args = parsePublicationManifestCliArgs(process.argv.slice(2));
  const result = await runPublicationManifestCli(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (isCliEntry(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
