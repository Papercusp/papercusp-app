/**
 * Pure logic for `papercusp-aws-ami-scan` (WI-10005587): input validation, AMI provenance
 * binding, candidate-root selection, and turning syft / grype / gitleaks reports into the
 * `AwsAmiScanEvidence` measurement (packages/operator-core/lib/workspace-host/aws-ami-release.ts).
 *
 * Kept separate from the executable so every rule here is unit-tested without AWS, sudo or
 * a multi-GiB disk. The executable owns only I/O: describe the AMI, download its root
 * snapshot with coldsnap, mount it read-only, run the three scanners, tear down.
 *
 * TRUST RULE (same as the GCP scanner): a measurement is emitted only when every stage
 * produced a parsed result. A missing or unparseable report THROWS; it never becomes a
 * zero, because a zero is exactly what the release policy accepts.
 */
import { createHash } from 'node:crypto';

import { fail, requireText } from './gcp-ephemeral.mjs';

export const AWS_AMI_SCAN_TOOL = 'papercusp-aws-ami-scan';

/** Same shapes the release contract enforces (aws-ami-release.ts / aws-ami-production.ts). */
const AMI_ID = /^ami-[a-f0-9]+$/;
const SNAPSHOT_ID = /^snap-[a-f0-9]+$/;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/;
const MANIFEST_IDENTITY = /^sha256:[a-f0-9]{64}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
/** Mirror of AWS_AMI_DESCRIPTION_PATTERN in aws-ami-release.ts; drift is caught by the test. */
export const AWS_AMI_DESCRIPTION_PATTERN = /^papercusp-workspace-host (\S+) release-sha256:([a-f0-9]{64})$/;

/** The release bundle's install root: the subject boundary for scope attribution (D-201). */
export const PAPERCUSP_BUNDLE_PATH = '/opt/papercusp';

/**
 * Safety rail on `secretBundledSample`, NOT a sampling rate — the same cap and the same reason
 * as the GCP guest scanner (papercusp-image-scan.mjs). The bundled population must reach zero
 * unjustified findings to ship, so it is small by construction; the cap only stops a mis-built
 * image from returning a multi-megabyte array, and whether it bound is reported alongside.
 */
export const SECRET_BUNDLED_SAMPLE_CAP = 500;

/** Bounding slash so a sibling such as /opt/papercusp-old is never attributed to the bundle. */
function inBundlePath(path) {
  return String(path ?? '').includes(`${PAPERCUSP_BUNDLE_PATH}/`);
}

function scopeLabel(bundled) {
  return bundled ? 'papercusp-bundled' : 'inherited-base-image';
}

/**
 * Packages whose installed versions are reported as evidence: the RPM names in
 * AWS_AMI_REQUIRED_GUEST_TOOLS (aws-ami-release.ts), which is what the CentOS Stream 9
 * bootc image installs (WI-10005605). Mirrored rather than imported because this bin
 * runs without the TypeScript toolchain; the scan test pins the two lists together.
 */
export const GUEST_PACKAGE_PROBES = Object.freeze([
  'acl',
  'amazon-ssm-agent',
  'ca-certificates',
  'curl',
  'dnf-automatic',
  'jq',
  'minisign',
  'nftables',
  'openssh-server',
]);

/** Validate the adapter's stdin payload; returns the exact identity fields to echo back. */
export function parseAwsAmiScanInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('scan input must be a JSON object');
  const region = requireText(input.region, 'region');
  if (!REGION.test(region)) fail(`region '${region}' is not an AWS region name`);
  const imageId = requireText(input.imageId, 'imageId');
  if (!AMI_ID.test(imageId)) fail(`imageId '${imageId}' is not an AMI id`);
  const buildManifestIdentity = requireText(input.buildManifestIdentity, 'buildManifestIdentity');
  if (!MANIFEST_IDENTITY.test(buildManifestIdentity)) fail('buildManifestIdentity must be sha256:<64 hex>');
  const releaseSha256 = requireText(input.releaseSha256, 'releaseSha256');
  if (!SHA256_HEX.test(releaseSha256)) fail('releaseSha256 must be 64 lowercase hex characters');
  return { region, imageId, buildManifestIdentity, releaseSha256 };
}

function tagMap(tags) {
  const out = {};
  for (const tag of Array.isArray(tags) ? tags : []) {
    if (tag && typeof tag.Key === 'string') out[tag.Key] = typeof tag.Value === 'string' ? tag.Value : '';
  }
  return out;
}

/**
 * Bind a DescribeImages record to the requested release BEFORE any byte is downloaded.
 *
 * The AMI must be available and carry the release provenance in BOTH places the release
 * writes it: the cross-account Description and the exact papercusp tags. It must have
 * exactly one EBS snapshot, mapped at the root device. A second volume would be content
 * this scan never reads, so it is refused rather than silently under-scanned.
 */
export function assertAwsAmiProvenance(image, expected) {
  if (!image || typeof image !== 'object') fail(`AMI ${expected.imageId} was not returned by DescribeImages`);
  if (image.ImageId !== expected.imageId) fail(`DescribeImages returned ${String(image.ImageId)}, not ${expected.imageId}`);
  if (image.State !== 'available') fail(`AMI ${expected.imageId} is not available (state=${String(image.State)})`);
  const description = AWS_AMI_DESCRIPTION_PATTERN.exec(typeof image.Description === 'string' ? image.Description : '');
  if (!description) fail(`AMI ${expected.imageId} has no papercusp release Description`);
  const [, releaseVersion, describedSha] = description;
  if (describedSha !== expected.releaseSha256) {
    fail(`AMI ${expected.imageId} Description binds release-sha256 ${describedSha}, not ${expected.releaseSha256}`);
  }
  const tags = tagMap(image.Tags);
  const wanted = {
    'papercusp:build-manifest': expected.buildManifestIdentity,
    'papercusp:release-sha256': expected.releaseSha256,
    'papercusp:image-version': releaseVersion,
    'papercusp:managed': 'true',
  };
  for (const [key, value] of Object.entries(wanted)) {
    if (tags[key] !== value) fail(`AMI ${expected.imageId} tag ${key} is '${tags[key] ?? '<absent>'}', expected '${value}'`);
  }
  const ebs = (Array.isArray(image.BlockDeviceMappings) ? image.BlockDeviceMappings : []).filter(
    (mapping) => mapping && mapping.Ebs && typeof mapping.Ebs.SnapshotId === 'string',
  );
  if (ebs.length !== 1) fail(`AMI ${expected.imageId} must have exactly one EBS snapshot; found ${ebs.length}`);
  const [root] = ebs;
  if (root.DeviceName !== image.RootDeviceName) {
    fail(`AMI ${expected.imageId} snapshot is mapped at ${String(root.DeviceName)}, not the root device ${String(image.RootDeviceName)}`);
  }
  if (!SNAPSHOT_ID.test(root.Ebs.SnapshotId)) fail(`AMI ${expected.imageId} root snapshot id is malformed`);
  return { snapshotId: root.Ebs.SnapshotId, releaseVersion, encrypted: root.Ebs.Encrypted === true };
}

/**
 * Pick the operating-system root among the os-release files found under the mount root.
 *
 * A bootc (ostree) disk keeps the OS under ostree/deploy/<stateroot>/deploy/<checksum>.<n>/,
 * seven levels below the mount, so the GCP scanner's depth-3 probe would report
 * candidate-root-not-mounted for every bootc image. A deployment root wins over a plain
 * partition root; ties break lexically so the choice is deterministic. Only
 * `<root>/etc/os-release` and `<root>/usr/lib/os-release` count: an os-release that is
 * merely a file inside the ostree object store proves nothing about a mounted userland.
 *
 * @param {string[]} paths absolute paths of os-release files under mountRoot
 * @returns {{ proof: string, osRoot: string } | null}
 */
export function selectCandidateRoot(paths, mountRoot) {
  const base = mountRoot.replace(/\/+$/, '');
  const candidates = [];
  for (const path of paths) {
    if (!path.startsWith(`${base}/`)) continue;
    const relativePath = path.slice(base.length + 1);
    const match = /^(.*?)\/(?:etc|usr\/lib)\/os-release$/.exec(relativePath);
    if (!match) continue;
    const osRelative = match[1];
    const segments = osRelative.split('/');
    const isDeployment = /^[^/]+\/ostree\/deploy\/[^/]+\/deploy\/[^/]+$/.test(osRelative);
    if (!isDeployment && segments.length !== 1) continue;
    candidates.push({ proof: `/candidate/${relativePath}`, osRoot: `${base}/${osRelative}`, rank: isDeployment ? 0 : 1 });
  }
  candidates.sort((left, right) => left.rank - right.rank || left.proof.localeCompare(right.proof));
  const chosen = candidates[0];
  return chosen ? { proof: chosen.proof, osRoot: chosen.osRoot } : null;
}

function parseReport(text, label) {
  if (typeof text !== 'string' || text.trim() === '') fail(`${label} report is missing or empty`);
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${label} report is not JSON: ${error.message}`);
  }
}

function countBy(values) {
  const out = {};
  for (const value of values) {
    const key = typeof value === 'string' && value ? value : 'Unknown';
    out[key] = (out[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([left], [right]) => left.localeCompare(right)));
}

/**
 * Turn the three scanner reports into the measurement half of AwsAmiScanEvidence.
 *
 * @param {{ sbomText: string, vulnText: string, secretsText: string, mountedFilesystems: number,
 *           candidateRootProof: string, npmManifestsPresent: boolean }} input
 */
export function measureAwsAmiScan(input) {
  const sbom = parseReport(input.sbomText, 'syft');
  if (!sbom || !Array.isArray(sbom.artifacts)) fail('syft report has no artifacts[] array');
  const vuln = parseReport(input.vulnText, 'grype');
  if (!vuln || !Array.isArray(vuln.matches)) fail('grype report has no matches[] array');
  const secrets = parseReport(input.secretsText, 'gitleaks');
  if (!Array.isArray(secrets)) fail('gitleaks report is not a JSON array');
  if (!Number.isSafeInteger(input.mountedFilesystems) || input.mountedFilesystems < 1) {
    fail('no candidate filesystem was mounted');
  }
  const candidateRootProof = requireText(input.candidateRootProof, 'candidateRootProof');

  // Ecosystem coverage: an image that ships node_modules must produce npm packages, or the
  // cataloger read nothing and the vulnerability count is a measurement of nothing (D-200).
  const npmCataloged = sbom.artifacts.filter((artifact) => artifact && artifact.type === 'npm').length;
  if (input.npmManifestsPresent && npmCataloged === 0) {
    fail('sbom-npm-coverage-zero: the image ships node_modules but syft cataloged no npm packages');
  }
  // OS coverage: zero distro packages means the package database was never read, so a low
  // vulnerability count would describe the scanner, not the image.
  const rpmCataloged = sbom.artifacts.filter((artifact) => artifact && artifact.type === 'rpm').length;
  const debCataloged = sbom.artifacts.filter((artifact) => artifact && artifact.type === 'deb').length;
  if (rpmCataloged + debCataloged === 0) {
    fail('sbom-os-coverage-zero: syft cataloged no rpm or deb packages, so the OS package database was not read');
  }

  const matches = vuln.matches;
  const inBundle = (match) =>
    Array.isArray(match?.artifact?.locations) && match.artifact.locations.some((location) => inBundlePath(location?.path));
  // The at/above-high band, matched case-insensitively exactly like the GCP guest jq. The
  // scoped release policy reads only this band's bundled bucket (SCOPE_ATTRIBUTED_THRESHOLD).
  const atOrAboveHigh = (match) => {
    const severity = String(match?.vulnerability?.severity ?? '').toLowerCase();
    return severity === 'critical' || severity === 'high';
  };
  // SBOM PACKAGES (not findings) under the bundle path: the one number that tells "we looked at
  // the bundle and it is clean" apart from "we never found the bundle". Zero is emitted as zero
  // and the release policy denies on it — never coerced into a pass here.
  const bundleCatalogedArtifacts = sbom.artifacts.filter(
    (artifact) => Array.isArray(artifact?.locations) && artifact.locations.some((location) => inBundlePath(location?.path)),
  ).length;
  // Location only, never the matched value — the same non-disclosure rule as secretSample.
  const bundledSecrets = secrets
    .filter((finding) => inBundlePath(finding?.File))
    .map((finding) => ({ rule: finding?.RuleID, file: finding?.File, line: finding?.StartLine }));
  const guestPackages = {};
  for (const name of GUEST_PACKAGE_PROBES) {
    const hit = sbom.artifacts.find((artifact) => artifact && artifact.type === 'rpm' && artifact.name === name);
    guestPackages[name] = hit && typeof hit.version === 'string' ? hit.version : null;
  }

  return {
    sbomSha256: createHash('sha256').update(input.sbomText, 'utf8').digest('hex'),
    vulnerabilityFindings: matches.length,
    vulnerabilityBySeverity: countBy(matches.map((match) => match?.vulnerability?.severity)),
    vulnerabilityFixableBySeverity: countBy(
      matches.filter((match) => match?.vulnerability?.fix?.state === 'fixed').map((match) => match?.vulnerability?.severity),
    ),
    vulnerabilityByEcosystem: countBy(matches.map((match) => match?.artifact?.type)),
    // D-204 attribution, the same four maps the GCP guest scanner emits, so the AWS release gate can
    // judge the content papercusp ships (WI-10006421). Each partitions its total exactly; the
    // policy re-checks that and denies on any mismatch.
    vulnerabilityByScope: countBy(matches.map((match) => scopeLabel(inBundle(match)))),
    vulnerabilityCriticalHighByScope: countBy(matches.filter(atOrAboveHigh).map((match) => scopeLabel(inBundle(match)))),
    bundleCatalogedArtifacts,
    secretFindings: secrets.length,
    secretsByScope: countBy(secrets.map((finding) => scopeLabel(inBundlePath(finding?.File)))),
    // Rule and file only — never the matched secret: echoing it would turn a detection into a disclosure.
    secretSample: secrets.slice(0, 50).map((finding) => ({ rule: finding?.RuleID, file: finding?.File, line: finding?.StartLine })),
    // EVERY bundled finding by file, so each one can be matched against the committed allowances.
    secretBundledSample: bundledSecrets.slice(0, SECRET_BUNDLED_SAMPLE_CAP),
    secretBundledSampleComplete: bundledSecrets.length <= SECRET_BUNDLED_SAMPLE_CAP,
    mountedFilesystems: input.mountedFilesystems,
    candidateRootProof,
    catalogedArtifacts: { total: sbom.artifacts.length, npm: npmCataloged, rpm: rpmCataloged },
    guestPackages,
  };
}

/** Assemble the final evidence; `trusted` is true only because every stage above succeeded. */
export function buildAwsAmiScanEvidence(request, provenance, measurement, toolVersions) {
  const evidenceDigest = createHash('sha256')
    .update(
      [request.region, request.imageId, provenance.snapshotId, request.buildManifestIdentity, request.releaseSha256, measurement.sbomSha256].join('|'),
      'utf8',
    )
    .digest('hex');
  return {
    imageId: request.imageId,
    region: request.region,
    buildManifestIdentity: request.buildManifestIdentity,
    releaseSha256: request.releaseSha256,
    trusted: true,
    ...measurement,
    evidenceRef: `aws-ami-scan:${request.region}/${request.imageId}/${provenance.snapshotId}:sha256:${evidenceDigest}`,
    snapshotId: provenance.snapshotId,
    releaseVersion: provenance.releaseVersion,
    scanner: { tool: AWS_AMI_SCAN_TOOL, method: 'offline-snapshot-download', ...toolVersions },
  };
}
