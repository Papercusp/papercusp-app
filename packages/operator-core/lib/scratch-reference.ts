/**
 * Self-describing scratch references (orchestration-runtime-unification P-007).
 *
 * The manifest and payload share ONE file: the payload is written once, while
 * readers can enforce expiry/audience and verify integrity before exposing it.
 * Legacy scratch files remain readable as ordinary files.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { OutputAudience, OutputEvidenceClass } from './output-envelope';
import { reserveScratchSpace, RETENTION_MS } from './scratch-gc';

export const SCRATCH_REFERENCE_SCHEMA_VERSION = 'papercusp.scratch-reference/v1' as const;
export const SCRATCH_REFERENCE_MAGIC = `${SCRATCH_REFERENCE_SCHEMA_VERSION}\n`;

export interface ScratchReferenceContentMetadata {
  index: number;
  type: string;
  mimeType?: string;
  byteCount: number;
}

export interface ScratchReferenceManifest {
  schemaVersion: typeof SCRATCH_REFERENCE_SCHEMA_VERSION;
  createdAt: string;
  expiresAt: string;
  workspaceId: string;
  ownerId?: string;
  audience: OutputAudience;
  mediaType: string;
  byteCount: number;
  sha256: string;
  content: readonly ScratchReferenceContentMetadata[];
  evidence?: readonly ScratchReferenceEvidenceSelector[];
  /**
   * EI-21949915395361184 (umbrella over ten reports): byte offset, WITHIN THE PAYLOAD
   * (i.e. after this header), at which the machine-readable body begins — everything
   * before it is human-facing preamble the writer prepended.
   *
   * The file is a self-describing CONTAINER, not a JSON document, and until now the
   * boundary existed only in the tool RESULT's cursor. A consumer holding just the path
   * had to guess, and every natural guess fails: `jq .` chokes on the magic line, and
   * "first `{` through EOF" lands on THIS MANIFEST — a well-formed but WRONG object,
   * which is the failure mode that got reported ten times because it looks like success.
   *
   * Measured against the PAYLOAD, never the file, and that is not a detail: a
   * file-relative offset would have to count the header that contains it, so writing it
   * down would change it. The file offset stays derivable — the header is exactly the
   * first two lines — via `scratchReferenceBodyByteOffset()`, or in a shell:
   *
   *   P=$(sed -n 2p FILE | jq -r '.bodyOffsetInPayload')
   *   H=$(head -2 FILE | wc -c)
   *   tail -c +$((H + P + 1)) FILE | jq .
   *
   * Omitted when the writer has no machine-readable body to point at (a payload that is
   * entirely prose). Absent MEANS "no declared body", never "offset 0".
   */
  bodyOffsetInPayload?: number;
}

export interface ScratchReferenceEvidenceSelector {
  evidenceClass: OutputEvidenceClass;
  contentIndex: number;
  jsonPointers: readonly string[];
}

export interface ParsedScratchReference {
  manifest: ScratchReferenceManifest;
  payload: Buffer;
  payloadByteOffset: number;
}

/** Build the on-disk manifest header once so writers and cursor metadata agree
 * on where the plaintext payload begins. */
export function scratchReferenceHeader(manifest: ScratchReferenceManifest): Buffer {
  return Buffer.from(`${SCRATCH_REFERENCE_MAGIC}${JSON.stringify(manifest)}\n`, 'utf8');
}

/** Byte offset of the payload in a self-describing scratch reference file. */
export function scratchReferencePayloadByteOffset(manifest: ScratchReferenceManifest): number {
  return scratchReferenceHeader(manifest).byteLength;
}

/**
 * Byte offset of the machine-readable BODY in the raw FILE — the one number a `jq` /
 * `tail -c` consumer actually needs. Null when the manifest declares no body, which is
 * a real answer ("this payload is prose") and must not be read as offset 0.
 *
 * Derived from the manifest rather than stored in it, because a file-relative offset
 * cannot be written into the header it would have to measure.
 */
export function scratchReferenceBodyByteOffset(manifest: ScratchReferenceManifest): number | null {
  return manifest.bodyOffsetInPayload == null
    ? null
    : scratchReferencePayloadByteOffset(manifest) + manifest.bodyOffsetInPayload;
}

export class ScratchReferenceError extends Error {
  constructor(
    readonly code:
      | 'invalid_reference'
      | 'expired_reference'
      | 'forbidden_reference'
      | 'workspace_mismatch'
      | 'integrity_mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'ScratchReferenceError';
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isAudience(value: unknown): value is OutputAudience {
  return value === 'owner' || value === 'workspace' || value === 'public';
}

function requireManifest(value: unknown): ScratchReferenceManifest {
  if (!value || typeof value !== 'object') {
    throw new ScratchReferenceError('invalid_reference', 'scratch reference manifest must be an object');
  }
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== SCRATCH_REFERENCE_SCHEMA_VERSION) {
    throw new ScratchReferenceError('invalid_reference', 'unsupported scratch reference schema');
  }
  if (
    typeof row.createdAt !== 'string' ||
    typeof row.expiresAt !== 'string' ||
    typeof row.workspaceId !== 'string' ||
    typeof row.mediaType !== 'string' ||
    typeof row.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(row.sha256) ||
    !Number.isSafeInteger(row.byteCount) ||
    Number(row.byteCount) < 0 ||
    !isAudience(row.audience) ||
    (row.ownerId !== undefined && typeof row.ownerId !== 'string') ||
    !Array.isArray(row.content)
  ) {
    throw new ScratchReferenceError('invalid_reference', 'scratch reference manifest has invalid fields');
  }
  return row as unknown as ScratchReferenceManifest;
}

export function contentMetadata(items: readonly unknown[]): ScratchReferenceContentMetadata[] {
  return items.map((item, index) => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const type = typeof row.type === 'string' ? row.type : 'unknown';
    const mimeType = typeof row.mimeType === 'string' ? row.mimeType : undefined;
    const body = type === 'text' && typeof row.text === 'string'
      ? row.text
      : typeof row.data === 'string'
        ? row.data
        : JSON.stringify(item) ?? '';
    return {
      index,
      type,
      ...(mimeType ? { mimeType } : {}),
      byteCount: Buffer.byteLength(body, 'utf8'),
    };
  });
}

export function writeScratchReference(input: {
  filePath: string;
  payload: Buffer | string;
  workspaceId: string;
  ownerId?: string | null;
  audience?: OutputAudience;
  mediaType: string;
  content?: readonly ScratchReferenceContentMetadata[];
  evidence?: readonly ScratchReferenceEvidenceSelector[];
  nowMs?: number;
  /** Payload-relative start of the machine-readable body; see the manifest field. */
  bodyOffsetInPayload?: number;
  /**
   * When given, the file is written with fs.promises and the write's promise is pushed
   * here instead of blocking: the caller MUST await it before handing the reference to
   * anyone (see applyResultDoorAsync). Omitted ⇒ the synchronous write below.
   *
   * WI-10004533: the synchronous mkdirSync + writeFileSync runs on the request worker's
   * main thread; under ext4/jbd2 contention it sat in D-state long enough for the
   * event-loop sentinel to SIGKILL the operator with every in-flight MCP call.
   */
  deferredWrites?: Promise<void>[];
}): ScratchReferenceManifest {
  const payload = Buffer.isBuffer(input.payload) ? input.payload : Buffer.from(input.payload, 'utf8');
  const nowMs = input.nowMs ?? Date.now();
  const audience = input.audience ?? (input.ownerId ? 'owner' : 'workspace');
  if (audience === 'owner' && !input.ownerId) {
    throw new ScratchReferenceError('invalid_reference', 'owner audience requires ownerId');
  }
  const manifest: ScratchReferenceManifest = {
    schemaVersion: SCRATCH_REFERENCE_SCHEMA_VERSION,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + RETENTION_MS).toISOString(),
    workspaceId: input.workspaceId,
    ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    audience,
    mediaType: input.mediaType,
    byteCount: payload.length,
    sha256: sha256(payload),
    content: [...(input.content ?? [])],
    ...(input.evidence?.length ? { evidence: input.evidence.map((entry) => ({ ...entry, jsonPointers: [...entry.jsonPointers] })) } : {}),
    // Declared only when it actually points INTO this payload. An offset past the end
    // would send a consumer to EOF and read as "empty body" rather than as a broken
    // manifest, so it is dropped rather than written down wrong.
    ...(input.bodyOffsetInPayload != null &&
    Number.isSafeInteger(input.bodyOffsetInPayload) &&
    input.bodyOffsetInPayload >= 0 &&
    input.bodyOffsetInPayload < payload.length
      ? { bodyOffsetInPayload: input.bodyOffsetInPayload }
      : {}),
  };
  const header = scratchReferenceHeader(manifest);
  reserveScratchSpace({ workspaceId: input.workspaceId, bytes: header.length + payload.length });
  const bytes = Buffer.concat([header, payload]);
  if (input.deferredWrites) {
    const filePath = input.filePath;
    const write = (async () => {
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
      await writeFile(filePath, bytes, { mode: 0o600 });
    })();
    // Mark handled now: the caller awaits it later, and a fast failure must not reach the
    // process-level unhandledRejection handler (which terminates the host) first.
    write.catch(() => {});
    input.deferredWrites.push(write);
    return manifest;
  }
  mkdirSync(dirname(input.filePath), { recursive: true, mode: 0o700 });
  writeFileSync(input.filePath, bytes, { mode: 0o600 });
  return manifest;
}

/** Null means a legacy/non-reference scratch file. A matching magic prefix is
 * always parsed fail-closed: a corrupt reference must never fall back to raw. */
export function parseScratchReference(bytes: Buffer): ParsedScratchReference | null {
  const magic = Buffer.from(SCRATCH_REFERENCE_MAGIC, 'utf8');
  if (!bytes.subarray(0, magic.length).equals(magic)) return null;
  const manifestEnd = bytes.indexOf(0x0a, magic.length);
  if (manifestEnd < 0) {
    throw new ScratchReferenceError('invalid_reference', 'scratch reference manifest is unterminated');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.subarray(magic.length, manifestEnd).toString('utf8'));
  } catch {
    throw new ScratchReferenceError('invalid_reference', 'scratch reference manifest is not valid JSON');
  }
  const manifest = requireManifest(parsed);
  const payloadByteOffset = manifestEnd + 1;
  const payload = bytes.subarray(payloadByteOffset);
  if (payload.length !== manifest.byteCount) {
    throw new ScratchReferenceError(
      'integrity_mismatch',
      `scratch reference byte count mismatch: manifest=${manifest.byteCount}, actual=${payload.length}`,
    );
  }
  if (sha256(payload) !== manifest.sha256) {
    throw new ScratchReferenceError('integrity_mismatch', 'scratch reference SHA-256 mismatch');
  }
  return { manifest, payload, payloadByteOffset };
}

export function authorizeScratchReference(
  manifest: ScratchReferenceManifest,
  caller: { workspaceId?: string | null; ownerId?: string | null; nowMs?: number },
): void {
  const nowMs = caller.nowMs ?? Date.now();
  const expiresAt = Date.parse(manifest.expiresAt);
  if (!Number.isFinite(expiresAt) || nowMs >= expiresAt) {
    throw new ScratchReferenceError('expired_reference', `scratch reference expired at ${manifest.expiresAt}`);
  }
  if (!caller.workspaceId || caller.workspaceId !== manifest.workspaceId) {
    throw new ScratchReferenceError('workspace_mismatch', 'scratch reference belongs to a different workspace');
  }
  if (manifest.audience === 'owner' && caller.ownerId !== manifest.ownerId) {
    throw new ScratchReferenceError('forbidden_reference', 'scratch reference is restricted to its creating owner');
  }
}
