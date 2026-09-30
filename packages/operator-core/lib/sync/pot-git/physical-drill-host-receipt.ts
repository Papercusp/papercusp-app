/**
 * Read-only host receipts for the canonical two-machine hive-git drill.
 *
 * A receipt is deliberately rooted in the device identity the substrate has
 * already announced.  The production path loads the persisted announce cache,
 * re-verifies its public key against the existing keychain entry (never minting
 * a replacement), derives a stable fingerprint from the host OS, and signs both
 * the exact evidence bytes and the receipt that binds those bytes to the host.
 */
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { promisify } from 'node:util';
import { verifyEd25519 } from '../../identity/ed25519';
import { signWithDeviceKey } from '../../identity/sign-with-device-key';
import {
  loadCachedLocalAnnounceIdentity,
  type LocalAnnounceIdentity,
} from '../hyperbee/local-announce-identity';

export const PHYSICAL_DRILL_EVIDENCE_SCHEMA = 'hive-git-physical-evidence/v3';
export const PHYSICAL_DRILL_HOST_IDENTITY_SCHEMA = 'hive-git-physical-host-identity/v1';
export const PHYSICAL_DRILL_HOST_RECEIPT_SCHEMA = 'hive-git-physical-host-receipt/v1';
const MACHINE_FINGERPRINT_DOMAIN = 'papercusp-physical-machine/v1';
const RECEIPT_SIGNING_DOMAIN = 'papercusp-physical-host-receipt/v1';
const RECEIPT_GRACE_MS = 10 * 60_000;
const DEVICE_KEY = /^[A-Za-z0-9+/]{43}=$/;
const SHA256 = /^[0-9a-f]{64}$/;
const HOST_ID = /^[A-Za-z0-9._:-]{1,80}$/;
const GITHUB_LOGIN = /^[A-Za-z0-9-]{1,39}$/;

type JsonRecord = Record<string, unknown>;

export interface PhysicalDrillHostIdentity {
  schemaVersion: typeof PHYSICAL_DRILL_HOST_IDENTITY_SCHEMA;
  hostId: string;
  deviceKey: string;
  keychainId: string;
  githubUserId: number;
  githubLogin: string;
  machineFingerprint: string;
}

export interface PhysicalDrillHostReceipt {
  schemaVersion: typeof PHYSICAL_DRILL_HOST_RECEIPT_SCHEMA;
  runId: string;
  hostId: string;
  deviceKey: string;
  keychainId: string;
  githubUserId: number;
  githubLogin: string;
  machineFingerprint: string;
  evidenceSigningSha256: string;
  signedAt: string;
  evidenceAttestation: string;
  signature: string;
}

export interface PhysicalDrillHostReceiptVerdict {
  ok: boolean;
  errors: string[];
  receipt: PhysicalDrillHostReceipt | null;
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function canonical(value: unknown, omittedKey?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => canonical(item, omittedKey));
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.keys(object)
      .filter((key) => key !== omittedKey)
      .sort()
      .map((key) => [key, canonical(object[key], omittedKey)]),
  );
}

/** The exact domain-separated bytes both physical device identities attest. */
export function physicalDrillSigningBytes(raw: unknown): Buffer {
  return Buffer.from(
    `${PHYSICAL_DRILL_EVIDENCE_SCHEMA}\n${JSON.stringify(canonical(raw, 'attestations'))}`,
    'utf8',
  );
}

/** Domain-separated bytes that bind a host/device/machine receipt. */
export function physicalDrillHostReceiptSigningBytes(raw: unknown): Buffer {
  return Buffer.from(
    `${RECEIPT_SIGNING_DOMAIN}\n${JSON.stringify(canonical(raw, 'signature'))}`,
    'utf8',
  );
}

function validDeviceKey(value: string | null): value is string {
  if (!value || !DEVICE_KEY.test(value)) return false;
  return Buffer.from(value, 'base64').length === 32;
}

function signature(value: string | null): Buffer {
  if (!value) return Buffer.alloc(0);
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 64 ? decoded : Buffer.alloc(0);
}

async function machineIdentityMaterial(): Promise<{ source: string; value: string }> {
  if (platform() === 'linux') {
    for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try {
        const value = (await readFile(path, 'utf8')).trim();
        if (value.length >= 16) return { source: path, value };
      } catch {
        // Try the next canonical OS identity source.
      }
    }
    throw new Error('physical-drill-host-receipt: no Linux machine-id is readable');
  }

  if (platform() === 'darwin') {
    const execFile = promisify(execFileCallback);
    const { stdout } = await execFile('/usr/sbin/ioreg', [
      '-rd1',
      '-c',
      'IOPlatformExpertDevice',
    ], { timeout: 5_000 });
    const match = stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    if (match?.[1]) return { source: 'IOPlatformUUID', value: match[1] };
    throw new Error('physical-drill-host-receipt: IOPlatformUUID is unavailable');
  }

  throw new Error(`physical-drill-host-receipt: unsupported host platform ${platform()}`);
}

/** Stable, non-reversible fingerprint of the OS-provided physical machine id. */
export async function resolvePhysicalMachineFingerprint(): Promise<string> {
  const material = await machineIdentityMaterial();
  return createHash('sha256')
    .update(`${MACHINE_FINGERPRINT_DOMAIN}\n${platform()}\n${material.source}\n${material.value}`)
    .digest('hex');
}

export async function resolvePhysicalDrillHostIdentity(input: {
  hostId: string;
  cachePath: string;
  loadIdentity?: (cachePath: string) => Promise<LocalAnnounceIdentity | null>;
  resolveMachineFingerprint?: () => Promise<string>;
}): Promise<PhysicalDrillHostIdentity> {
  if (!HOST_ID.test(input.hostId)) {
    throw new Error('physical-drill-host-receipt: hostId is invalid');
  }
  const identity = await (input.loadIdentity ?? loadCachedLocalAnnounceIdentity)(input.cachePath);
  if (!identity) {
    throw new Error(
      `physical-drill-host-receipt: cached announce identity/keychain mismatch at ${input.cachePath}`,
    );
  }
  if (!validDeviceKey(identity.devicePubkeyBase64)) {
    throw new Error('physical-drill-host-receipt: cached device pubkey is invalid');
  }
  const machineFingerprint = await (
    input.resolveMachineFingerprint ?? resolvePhysicalMachineFingerprint
  )();
  if (!SHA256.test(machineFingerprint)) {
    throw new Error('physical-drill-host-receipt: machine fingerprint is invalid');
  }
  return {
    schemaVersion: PHYSICAL_DRILL_HOST_IDENTITY_SCHEMA,
    hostId: input.hostId,
    deviceKey: identity.devicePubkeyBase64,
    keychainId: identity.keychainId,
    githubUserId: identity.githubUserId,
    githubLogin: identity.githubLogin,
    machineFingerprint,
  };
}

function evidenceRun(raw: unknown): {
  evidence: JsonRecord;
  runId: string;
  startedAt: number;
  finishedAt: number;
} {
  const evidence = record(raw);
  if (!evidence || evidence.schemaVersion !== PHYSICAL_DRILL_EVIDENCE_SCHEMA) {
    throw new Error(`physical-drill-host-receipt: evidence must use ${PHYSICAL_DRILL_EVIDENCE_SCHEMA}`);
  }
  const runId = string(evidence.runId);
  const window = record(evidence.window);
  const startedAt = Date.parse(String(window?.startedAt ?? ''));
  const finishedAt = Date.parse(String(window?.finishedAt ?? ''));
  if (!runId || !Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt <= startedAt) {
    throw new Error('physical-drill-host-receipt: evidence run/window is invalid');
  }
  return { evidence, runId, startedAt, finishedAt };
}

function topologyDeviceKey(evidence: JsonRecord, hostId: string): string | null {
  const topology = record(evidence.topology);
  const hosts = Array.isArray(topology?.hosts) ? topology.hosts : [];
  const host = hosts.map(record).find((candidate) => candidate?.id === hostId);
  return string(host?.deviceKey);
}

export async function createPhysicalDrillHostReceipt(input: {
  evidence: unknown;
  identity: PhysicalDrillHostIdentity;
  signedAt?: Date;
  sign?: (keychainId: string, bytes: Buffer) => Promise<Buffer>;
}): Promise<PhysicalDrillHostReceipt> {
  const { evidence, runId, startedAt, finishedAt } = evidenceRun(input.evidence);
  const signedAt = input.signedAt ?? new Date();
  const signedAtMs = signedAt.getTime();
  if (
    !Number.isFinite(signedAtMs) ||
    signedAtMs < startedAt ||
    signedAtMs > finishedAt + RECEIPT_GRACE_MS
  ) {
    throw new Error(
      'physical-drill-host-receipt: receipt must be signed during the run or within 10 minutes of its finish',
    );
  }
  if (topologyDeviceKey(evidence, input.identity.hostId) !== input.identity.deviceKey) {
    throw new Error(
      'physical-drill-host-receipt: evidence topology does not match the cached device identity',
    );
  }

  const sign = input.sign ?? signWithDeviceKey;
  const evidenceBytes = physicalDrillSigningBytes(evidence);
  const evidenceAttestation = (
    await sign(input.identity.keychainId, evidenceBytes)
  ).toString('base64');
  const unsigned: Omit<PhysicalDrillHostReceipt, 'signature'> = {
    schemaVersion: PHYSICAL_DRILL_HOST_RECEIPT_SCHEMA,
    runId,
    hostId: input.identity.hostId,
    deviceKey: input.identity.deviceKey,
    keychainId: input.identity.keychainId,
    githubUserId: input.identity.githubUserId,
    githubLogin: input.identity.githubLogin,
    machineFingerprint: input.identity.machineFingerprint,
    evidenceSigningSha256: createHash('sha256').update(evidenceBytes).digest('hex'),
    signedAt: signedAt.toISOString(),
    evidenceAttestation,
  };
  const receipt: PhysicalDrillHostReceipt = {
    ...unsigned,
    signature: (
      await sign(input.identity.keychainId, physicalDrillHostReceiptSigningBytes(unsigned))
    ).toString('base64'),
  };
  const verdict = validatePhysicalDrillHostReceipt(receipt, evidence);
  if (!verdict.ok) {
    throw new Error(`physical-drill-host-receipt: self-validation failed: ${verdict.errors.join('; ')}`);
  }
  return receipt;
}

export async function issuePhysicalDrillHostReceipt(input: {
  evidencePath: string;
  hostId: string;
  cachePath: string;
}): Promise<PhysicalDrillHostReceipt> {
  const evidence = JSON.parse(await readFile(input.evidencePath, 'utf8')) as unknown;
  const identity = await resolvePhysicalDrillHostIdentity({
    hostId: input.hostId,
    cachePath: input.cachePath,
  });
  return createPhysicalDrillHostReceipt({ evidence, identity });
}

export function validatePhysicalDrillHostReceipt(
  raw: unknown,
  rawEvidence: unknown,
): PhysicalDrillHostReceiptVerdict {
  const errors: string[] = [];
  const receipt = record(raw);
  let run: ReturnType<typeof evidenceRun> | null = null;
  try {
    run = evidenceRun(rawEvidence);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (!receipt) {
    return { ok: false, errors: [...errors, 'host receipt must be an object'], receipt: null };
  }

  if (receipt.schemaVersion !== PHYSICAL_DRILL_HOST_RECEIPT_SCHEMA) {
    errors.push(`host receipt schemaVersion must be ${PHYSICAL_DRILL_HOST_RECEIPT_SCHEMA}`);
  }
  const runId = string(receipt.runId);
  const hostId = string(receipt.hostId);
  const deviceKey = string(receipt.deviceKey);
  const keychainId = string(receipt.keychainId);
  const githubUserId = receipt.githubUserId;
  const githubLogin = string(receipt.githubLogin);
  const machineFingerprint = string(receipt.machineFingerprint);
  const evidenceSigningSha256 = string(receipt.evidenceSigningSha256);
  const signedAt = string(receipt.signedAt);
  const evidenceAttestation = string(receipt.evidenceAttestation);
  const receiptSignature = string(receipt.signature);

  if (!runId || runId !== run?.runId) errors.push('host receipt runId must match evidence');
  if (!hostId || !HOST_ID.test(hostId)) errors.push('host receipt hostId is invalid');
  if (!validDeviceKey(deviceKey)) errors.push('host receipt deviceKey is invalid');
  if (!keychainId || keychainId.length > 512) errors.push('host receipt keychainId is invalid');
  if (typeof githubUserId !== 'number' || !Number.isSafeInteger(githubUserId) || githubUserId <= 0) {
    errors.push('host receipt githubUserId is invalid');
  }
  if (!githubLogin || !GITHUB_LOGIN.test(githubLogin)) errors.push('host receipt githubLogin is invalid');
  if (!machineFingerprint || !SHA256.test(machineFingerprint)) {
    errors.push('host receipt machineFingerprint must be 64 lowercase hex');
  }

  const evidenceBytes = physicalDrillSigningBytes(rawEvidence);
  const actualEvidenceHash = createHash('sha256').update(evidenceBytes).digest('hex');
  if (evidenceSigningSha256 !== actualEvidenceHash) {
    errors.push('host receipt evidenceSigningSha256 must match the canonical evidence bytes');
  }
  if (run && hostId && topologyDeviceKey(run.evidence, hostId) !== deviceKey) {
    errors.push('host receipt host/device must match evidence topology exactly');
  }

  const signedAtMs = Date.parse(String(signedAt ?? ''));
  if (
    !run ||
    !Number.isFinite(signedAtMs) ||
    signedAtMs < run.startedAt ||
    signedAtMs > run.finishedAt + RECEIPT_GRACE_MS
  ) {
    errors.push('host receipt signedAt must be during the run or within 10 minutes of finish');
  }

  if (
    !validDeviceKey(deviceKey) ||
    !verifyEd25519(evidenceBytes, deviceKey, signature(evidenceAttestation))
  ) {
    errors.push('host receipt evidenceAttestation is not a valid device signature');
  }
  if (
    !validDeviceKey(deviceKey) ||
    !verifyEd25519(
      physicalDrillHostReceiptSigningBytes(receipt),
      deviceKey,
      signature(receiptSignature),
    )
  ) {
    errors.push('host receipt signature is not valid for its device key');
  }

  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    receipt: errors.length === 0 ? (receipt as unknown as PhysicalDrillHostReceipt) : null,
  };
}
