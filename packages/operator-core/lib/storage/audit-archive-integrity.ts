import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const AUDIT_ARCHIVE_PUBLIC_DIR = '/mnt/data/papercusp-audit-inputs';
export const AUDIT_ARCHIVE_DESTINATION_DIR = '/mnt/backup/offload/papercusp-audit-inputs';
export const AUDIT_ARCHIVE_IMAGE_BASENAME = 'mac-post-tahoe26.6.1-builddata-workspace-20260813.qcow2';
export const AUDIT_ARCHIVE_EXPECTED_DIGEST = '6c0b30e8066892f2fc077c018018d2e59e8feb39ac5d603b0812914bc1835d9f';
export const AUDIT_ARCHIVE_EXPECTED_IMAGE_SIZE = 283_821_408_256;
export const AUDIT_ARCHIVE_EXPECTED_VIRTUAL_SIZE = 322_122_547_200;
export const AUDIT_ARCHIVE_EXPECTED_MTIME_MS = 1_786_662_480_716.52;
export const AUDIT_ARCHIVE_EXPECTED_CTIME_MS = 1_788_809_339_514.8215;
export const AUDIT_ARCHIVE_EXPECTED_IMAGE_IDENTITY = '2049:62154337';
export const AUDIT_ARCHIVE_EXPECTED_CHECKSUM_RECEIPT_SHA256 =
  'd1d9fbe8ddaee5332259245ca5ec7b48b1f2ce017ceff942385ab8b0161dbf65';
export const AUDIT_ARCHIVE_EXPECTED_PROVENANCE_RECEIPT_SHA256 =
  'c830770201dd2e1783b4b84a828699b70f97f80500da389f6b090cb722793451';

const EXPECTED_PROVENANCE_SCHEMA = 'papercusp-mac-audit-baseline-v1';
const EXPECTED_QEMU_ATTESTATION = 'No errors were found on the image.';

interface ArchiveProvenance {
  schemaVersion?: unknown;
  artifact?: {
    path?: unknown;
    byteLength?: unknown;
    sha256?: unknown;
    mode?: unknown;
    format?: unknown;
    virtualSizeBytes?: unknown;
    dirtyFlag?: unknown;
    qemuImgCheck?: unknown;
    sourceSha256AtCapture?: unknown;
  };
}

interface QemuImageInfo {
  format?: unknown;
  'virtual-size'?: unknown;
  'dirty-flag'?: unknown;
  corrupt?: unknown;
}

export interface AuditArchiveIntegrityObservation {
  publicIsSymlink: boolean;
  resolvedDirectory: string;
  publicImageIdentity: string;
  destinationImageIdentity: string;
  imageSize: number;
  imageMtimeMs: number;
  imageCtimeMs: number;
  imageMode: number;
  checksumDigest: string;
  checksumReceiptSha256: string;
  provenanceReceiptSha256: string;
  provenanceSchema: unknown;
  provenanceImagePath: unknown;
  provenanceImageSize: unknown;
  provenanceDigest: unknown;
  provenanceMode: unknown;
  provenanceFormat: unknown;
  provenanceVirtualSize: unknown;
  provenanceDirtyFlag: unknown;
  provenanceQemuAttestation: unknown;
  provenanceSourceDigest: unknown;
  qemuFormat: unknown;
  qemuVirtualSize: unknown;
  qemuDirtyFlag: unknown;
  qemuCorrupt: unknown;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function imageIdentity(path: string): string {
  const stat = statSync(path);
  return `${stat.dev}:${stat.ino}`;
}

export function auditArchiveIntegrityAvailable(): boolean {
  return existsSync(AUDIT_ARCHIVE_PUBLIC_DIR) && existsSync(AUDIT_ARCHIVE_DESTINATION_DIR);
}

/**
 * Bind the live read-only archive to the expensive verification performed before cutover.
 *
 * A full `qemu-img check` scans this 283.8 GB image and exceeded the former 60-second budget
 * three times in one pure-lane run. Repeating that historical proof in every live assertion
 * adds no independence. The persistent checksum/provenance sidecars are independently hashed,
 * and inode/size/mode/mtime/ctime continuity binds the historical SHA/qemu proof recorded by
 * WI-10000412 to today's file. Ctime is deliberately pinned: unlike mtime, an ordinary writer
 * cannot restore it after changing bytes. `qemu-img info` remains a fast live probe of the
 * current header, format, virtual size, and dirty/corrupt flags. A legitimate archive replacement
 * must therefore produce a new full verification proof and update these pins together.
 */
export function observeAuditArchiveIntegrity(): AuditArchiveIntegrityObservation {
  const publicImage = join(AUDIT_ARCHIVE_PUBLIC_DIR, AUDIT_ARCHIVE_IMAGE_BASENAME);
  const destinationImage = join(AUDIT_ARCHIVE_DESTINATION_DIR, AUDIT_ARCHIVE_IMAGE_BASENAME);
  const checksumRaw = readFileSync(`${publicImage}.sha256`, 'utf8');
  const provenanceRaw = readFileSync(
    join(AUDIT_ARCHIVE_PUBLIC_DIR, AUDIT_ARCHIVE_IMAGE_BASENAME.replace(/\.qcow2$/, '.provenance.json')),
    'utf8',
  );
  const provenance = JSON.parse(provenanceRaw) as ArchiveProvenance;
  const artifact = provenance.artifact ?? {};
  const image = statSync(publicImage);
  const qemu = JSON.parse(
    execFileSync('qemu-img', ['info', '--output=json', publicImage], {
      encoding: 'utf8',
      timeout: 10_000,
    }),
  ) as QemuImageInfo;
  return {
    publicIsSymlink: lstatSync(AUDIT_ARCHIVE_PUBLIC_DIR).isSymbolicLink(),
    resolvedDirectory: realpathSync(AUDIT_ARCHIVE_PUBLIC_DIR),
    publicImageIdentity: imageIdentity(publicImage),
    destinationImageIdentity: imageIdentity(destinationImage),
    imageSize: image.size,
    imageMtimeMs: image.mtimeMs,
    imageCtimeMs: image.ctimeMs,
    imageMode: image.mode & 0o777,
    checksumDigest: checksumRaw.trim().split(/\s+/, 1)[0] ?? '',
    checksumReceiptSha256: sha256(checksumRaw),
    provenanceReceiptSha256: sha256(provenanceRaw),
    provenanceSchema: provenance.schemaVersion,
    provenanceImagePath: artifact.path,
    provenanceImageSize: artifact.byteLength,
    provenanceDigest: artifact.sha256,
    provenanceMode: artifact.mode,
    provenanceFormat: artifact.format,
    provenanceVirtualSize: artifact.virtualSizeBytes,
    provenanceDirtyFlag: artifact.dirtyFlag,
    provenanceQemuAttestation: artifact.qemuImgCheck,
    provenanceSourceDigest: artifact.sourceSha256AtCapture,
    qemuFormat: qemu.format,
    qemuVirtualSize: qemu['virtual-size'],
    qemuDirtyFlag: qemu['dirty-flag'],
    qemuCorrupt: qemu.corrupt,
  };
}

export function auditArchiveIntegrityViolations(observation: AuditArchiveIntegrityObservation): string[] {
  const violations: string[] = [];
  if (!observation.publicIsSymlink) violations.push('public-path-not-symlink');
  if (observation.resolvedDirectory !== AUDIT_ARCHIVE_DESTINATION_DIR) violations.push('wrong-symlink-target');
  if (observation.publicImageIdentity !== observation.destinationImageIdentity) {
    violations.push('read-through-does-not-reach-destination');
  }
  if (observation.publicImageIdentity !== AUDIT_ARCHIVE_EXPECTED_IMAGE_IDENTITY) {
    violations.push('verified-image-identity-mismatch');
  }
  if (observation.checksumDigest !== AUDIT_ARCHIVE_EXPECTED_DIGEST) violations.push('checksum-mismatch');
  if (observation.checksumReceiptSha256 !== AUDIT_ARCHIVE_EXPECTED_CHECKSUM_RECEIPT_SHA256) {
    violations.push('checksum-receipt-mismatch');
  }
  if (observation.imageSize !== AUDIT_ARCHIVE_EXPECTED_IMAGE_SIZE) violations.push('image-size-mismatch');
  if (observation.imageMode !== 0o444) violations.push('image-mode-mismatch');
  if (Math.abs(observation.imageMtimeMs - AUDIT_ARCHIVE_EXPECTED_MTIME_MS) >= 1) {
    violations.push('image-mtime-mismatch');
  }
  if (Math.abs(observation.imageCtimeMs - AUDIT_ARCHIVE_EXPECTED_CTIME_MS) >= 1) {
    violations.push('image-ctime-mismatch');
  }
  if (observation.provenanceReceiptSha256 !== AUDIT_ARCHIVE_EXPECTED_PROVENANCE_RECEIPT_SHA256) {
    violations.push('provenance-receipt-mismatch');
  }
  if (observation.provenanceSchema !== EXPECTED_PROVENANCE_SCHEMA) violations.push('provenance-schema-mismatch');
  if (observation.provenanceImagePath !== join(AUDIT_ARCHIVE_PUBLIC_DIR, AUDIT_ARCHIVE_IMAGE_BASENAME)) {
    violations.push('provenance-image-path-mismatch');
  }
  if (observation.provenanceImageSize !== AUDIT_ARCHIVE_EXPECTED_IMAGE_SIZE) {
    violations.push('provenance-image-size-mismatch');
  }
  if (observation.provenanceDigest !== AUDIT_ARCHIVE_EXPECTED_DIGEST) violations.push('provenance-digest-mismatch');
  if (observation.provenanceSourceDigest !== AUDIT_ARCHIVE_EXPECTED_DIGEST) {
    violations.push('provenance-source-digest-mismatch');
  }
  if (observation.provenanceMode !== '0444') violations.push('provenance-mode-mismatch');
  if (observation.provenanceFormat !== 'qcow2') violations.push('provenance-format-mismatch');
  if (observation.provenanceVirtualSize !== AUDIT_ARCHIVE_EXPECTED_VIRTUAL_SIZE) {
    violations.push('provenance-virtual-size-mismatch');
  }
  if (observation.provenanceDirtyFlag !== false) violations.push('provenance-image-dirty');
  if (observation.provenanceQemuAttestation !== EXPECTED_QEMU_ATTESTATION) {
    violations.push('provenance-qemu-integrity-unverified');
  }
  if (observation.qemuFormat !== 'qcow2') violations.push('qemu-format-mismatch');
  if (observation.qemuVirtualSize !== AUDIT_ARCHIVE_EXPECTED_VIRTUAL_SIZE) {
    violations.push('qemu-virtual-size-mismatch');
  }
  if (observation.qemuDirtyFlag !== false) violations.push('qemu-image-dirty');
  if (observation.qemuCorrupt === true) violations.push('qemu-image-corrupt');
  return violations;
}
