import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { open, stat, type FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { getDbEncryptionKey } from '../db-encryption';

const MAGIC = Buffer.from('PCPVIA01', 'ascii');
const AUTH_TAG_BYTES = 16;
const HEADER_PREFIX_BYTES = 64;
const HEADER_BYTES = HEADER_PREFIX_BYTES + AUTH_TAG_BYTES;
const NONCE_PREFIX_BYTES = 8;
const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
const MANIFEST_NONCE_INDEX = 0xffff_ffff;
const KDF_LABEL = 'personal-vault-import-archive-v1';

export interface EncryptedPersonalArchiveMetadata {
  plaintextBytes: number;
  chunkBytes: number;
  chunkCount: number;
  noncePrefix: Buffer;
  contentSha256: string;
}

export interface PersonalArchiveEncryptionOptions {
  /** Test seam for rotation/failure coverage. Production resolves getDbEncryptionKey(). */
  rootKey?: string;
  chunkBytes?: number;
}

function rootKeyBytes(value: string): Buffer {
  const trimmed = value.trim();
  if (/^[0-9a-f]{64,}$/i.test(trimmed)) return Buffer.from(trimmed, 'hex');
  if (/^[A-Za-z0-9+/_=-]{43,}$/.test(trimmed)) {
    const decoded = Buffer.from(trimmed.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (decoded.length >= 32) return decoded;
  }
  return Buffer.from(trimmed, 'utf8');
}

/** RFC 5869 HKDF-Expand over the existing high-entropy workspace/db root key. */
function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  const blocks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  for (let counter = 1; Buffer.concat(blocks).length < length; counter += 1) {
    previous = createHmac('sha256', prk)
      .update(previous)
      .update(info)
      .update(Buffer.from([counter]))
      .digest();
    blocks.push(previous);
  }
  return Buffer.concat(blocks).subarray(0, length);
}

export function derivePersonalArchiveEncryptionKey(
  workspaceId: string,
  rootKey = getDbEncryptionKey(),
): Buffer {
  return hkdfExpand(
    rootKeyBytes(rootKey),
    Buffer.from(`${KDF_LABEL}:${workspaceId}`, 'utf8'),
    32,
  );
}

function assertChunkBytes(value: number | undefined): number {
  const resolved = value ?? DEFAULT_CHUNK_BYTES;
  if (!Number.isInteger(resolved) || resolved < 1024 || resolved > MAX_CHUNK_BYTES) {
    throw new Error('personal_vault_import_encryption_chunk_size_invalid');
  }
  return resolved;
}

function headerPrefix(
  metadata: Pick<
    EncryptedPersonalArchiveMetadata,
    'plaintextBytes' | 'chunkBytes' | 'chunkCount' | 'noncePrefix' | 'contentSha256'
  >,
): Buffer {
  const out = Buffer.alloc(HEADER_PREFIX_BYTES);
  MAGIC.copy(out, 0);
  out.writeUInt32BE(metadata.chunkBytes, 8);
  out.writeBigUInt64BE(BigInt(metadata.plaintextBytes), 12);
  out.writeUInt32BE(metadata.chunkCount, 20);
  metadata.noncePrefix.copy(out, 24);
  Buffer.from(metadata.contentSha256, 'hex').copy(out, 32);
  return out;
}

function manifestAad(workspaceId: string, prefix: Buffer): Buffer {
  return Buffer.concat([prefix, Buffer.from([0]), Buffer.from(workspaceId, 'utf8')]);
}

function authenticatedHeader(
  workspaceId: string,
  key: Buffer,
  metadata: EncryptedPersonalArchiveMetadata,
): Buffer {
  const prefix = headerPrefix(metadata);
  const cipher = createCipheriv(
    'aes-256-gcm',
    key,
    manifestNonce(metadata.noncePrefix),
  );
  cipher.setAAD(manifestAad(workspaceId, prefix));
  cipher.final();
  return Buffer.concat([prefix, cipher.getAuthTag()]);
}

function nonceAt(prefix: Buffer, index: number): Buffer {
  const out = Buffer.alloc(12);
  prefix.copy(out, 0);
  out.writeUInt32BE(index, NONCE_PREFIX_BYTES);
  return out;
}

/** Reject the manifest's reserved nonce domain even if future size bounds grow. */
export function assertPersonalArchiveDataChunkIndex(chunkIndex: number): void {
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= MANIFEST_NONCE_INDEX) {
    throw new Error('personal_vault_import_chunk_index_overflow');
  }
}

function dataChunkNonce(prefix: Buffer, chunkIndex: number): Buffer {
  assertPersonalArchiveDataChunkIndex(chunkIndex);
  return nonceAt(prefix, chunkIndex);
}

function manifestNonce(prefix: Buffer): Buffer {
  return nonceAt(prefix, MANIFEST_NONCE_INDEX);
}

function aad(workspaceId: string, chunkBytes: number, chunkIndex: number, plaintextBytes: number): Buffer {
  const workspace = Buffer.from(workspaceId, 'utf8');
  const fixed = Buffer.alloc(16);
  fixed.writeUInt32BE(chunkBytes, 0);
  fixed.writeUInt32BE(chunkIndex, 4);
  fixed.writeBigUInt64BE(BigInt(plaintextBytes), 8);
  return Buffer.concat([MAGIC, workspace, Buffer.from([0]), fixed]);
}

async function writeAll(
  handle: FileHandle,
  value: Buffer,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < value.length) {
    const result = await handle.write(value, offset, value.length - offset, position + offset);
    if (result.bytesWritten <= 0) throw new Error('personal_vault_import_write_incomplete');
    offset += result.bytesWritten;
  }
}

async function readExact(
  handle: FileHandle,
  length: number,
  position: number,
): Promise<Buffer> {
  const value = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(value, offset, length - offset, position + offset);
    if (result.bytesRead <= 0) throw new Error('personal_vault_import_ciphertext_truncated');
    offset += result.bytesRead;
  }
  return value;
}

export class PersonalArchiveEncryptedWriter {
  readonly chunkBytes: number;
  readonly noncePrefix = randomBytes(NONCE_PREFIX_BYTES);
  private readonly key: Buffer;
  private pending = Buffer.alloc(0);
  private chunkIndex = 0;
  private plaintextBytes = 0;
  private readonly plaintextHash = createHash('sha256');

  private constructor(
    private readonly workspaceId: string,
    private readonly handle: FileHandle,
    options: PersonalArchiveEncryptionOptions,
  ) {
    this.chunkBytes = assertChunkBytes(options.chunkBytes);
    this.key = derivePersonalArchiveEncryptionKey(workspaceId, options.rootKey);
  }

  static async create(
    workspaceId: string,
    storagePath: string,
    options: PersonalArchiveEncryptionOptions = {},
  ): Promise<PersonalArchiveEncryptedWriter> {
    const handle = await open(storagePath, 'wx', 0o600);
    const writer = new PersonalArchiveEncryptedWriter(workspaceId, handle, options);
    const emptyMetadata: EncryptedPersonalArchiveMetadata = {
      plaintextBytes: 0,
      chunkBytes: writer.chunkBytes,
      chunkCount: 0,
      noncePrefix: writer.noncePrefix,
      contentSha256: createHash('sha256').digest('hex'),
    };
    await writeAll(
      handle,
      authenticatedHeader(workspaceId, writer.key, emptyMetadata),
      0,
    );
    return writer;
  }

  private async writeChunk(plaintext: Buffer): Promise<void> {
    const cipher = createCipheriv('aes-256-gcm', this.key, dataChunkNonce(this.noncePrefix, this.chunkIndex));
    cipher.setAAD(aad(this.workspaceId, this.chunkBytes, this.chunkIndex, plaintext.length));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const position = HEADER_BYTES + this.chunkIndex * (this.chunkBytes + AUTH_TAG_BYTES);
    await writeAll(this.handle, Buffer.concat([ciphertext, tag]), position);
    this.chunkIndex += 1;
    this.plaintextBytes += plaintext.length;
  }

  async write(value: Uint8Array): Promise<void> {
    let chunk = Buffer.from(value);
    this.plaintextHash.update(chunk);
    while (chunk.length) {
      if (!this.pending.length && chunk.length >= this.chunkBytes) {
        await this.writeChunk(chunk.subarray(0, this.chunkBytes));
        chunk = chunk.subarray(this.chunkBytes);
        continue;
      }
      const needed = this.chunkBytes - this.pending.length;
      const taken = chunk.subarray(0, needed);
      this.pending = this.pending.length ? Buffer.concat([this.pending, taken]) : Buffer.from(taken);
      chunk = chunk.subarray(taken.length);
      if (this.pending.length === this.chunkBytes) {
        await this.writeChunk(this.pending);
        this.pending = Buffer.alloc(0);
      }
    }
  }

  async finish(): Promise<EncryptedPersonalArchiveMetadata> {
    if (this.pending.length) {
      await this.writeChunk(this.pending);
      this.pending = Buffer.alloc(0);
    }
    const metadata = {
      plaintextBytes: this.plaintextBytes,
      chunkBytes: this.chunkBytes,
      chunkCount: this.chunkIndex,
      noncePrefix: this.noncePrefix,
      contentSha256: this.plaintextHash.digest('hex'),
    };
    await writeAll(this.handle, authenticatedHeader(this.workspaceId, this.key, metadata), 0);
    await this.handle.sync();
    await this.handle.close();
    return metadata;
  }

  async abort(): Promise<void> {
    await this.handle.close().catch(() => undefined);
  }
}

export async function readEncryptedPersonalArchiveMetadata(
  workspaceId: string,
  storagePath: string,
  options: Pick<PersonalArchiveEncryptionOptions, 'rootKey'> = {},
): Promise<EncryptedPersonalArchiveMetadata> {
  const handle = await open(storagePath, 'r');
  try {
    const raw = await readExact(handle, HEADER_BYTES, 0);
    if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error('personal_vault_import_ciphertext_header_invalid');
    }
    const chunkBytes = assertChunkBytes(raw.readUInt32BE(8));
    const plaintextBig = raw.readBigUInt64BE(12);
    if (plaintextBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('personal_vault_import_plaintext_size_invalid');
    }
    const plaintextBytes = Number(plaintextBig);
    const chunkCount = raw.readUInt32BE(20);
    const expectedChunkCount = plaintextBytes === 0 ? 0 : Math.ceil(plaintextBytes / chunkBytes);
    if (chunkCount !== expectedChunkCount) {
      throw new Error('personal_vault_import_chunk_count_invalid');
    }
    const noncePrefix = Buffer.from(raw.subarray(24, 24 + NONCE_PREFIX_BYTES));
    const contentSha256 = raw.subarray(32, 64).toString('hex');
    const key = derivePersonalArchiveEncryptionKey(workspaceId, options.rootKey);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      manifestNonce(noncePrefix),
      { authTagLength: AUTH_TAG_BYTES },
    );
    decipher.setAAD(manifestAad(workspaceId, raw.subarray(0, HEADER_PREFIX_BYTES)));
    decipher.setAuthTag(raw.subarray(HEADER_PREFIX_BYTES, HEADER_BYTES));
    try {
      decipher.final();
    } catch {
      throw new Error('personal_vault_import_manifest_authentication_failed');
    }
    const expectedSize = HEADER_BYTES + plaintextBytes + chunkCount * AUTH_TAG_BYTES;
    const actual = await stat(storagePath);
    if (actual.size !== expectedSize) {
      throw new Error('personal_vault_import_ciphertext_size_invalid');
    }
    return {
      plaintextBytes,
      chunkBytes,
      chunkCount,
      noncePrefix,
      contentSha256,
    };
  } finally {
    await handle.close();
  }
}

async function decryptChunk(
  handle: FileHandle,
  workspaceId: string,
  metadata: EncryptedPersonalArchiveMetadata,
  key: Buffer,
  chunkIndex: number,
): Promise<Buffer> {
  const start = chunkIndex * metadata.chunkBytes;
  const plaintextBytes = Math.min(metadata.chunkBytes, metadata.plaintextBytes - start);
  if (plaintextBytes <= 0) throw new Error('personal_vault_import_chunk_range_invalid');
  const position = HEADER_BYTES + chunkIndex * (metadata.chunkBytes + AUTH_TAG_BYTES);
  const encrypted = await readExact(handle, plaintextBytes + AUTH_TAG_BYTES, position);
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    dataChunkNonce(metadata.noncePrefix, chunkIndex),
    { authTagLength: AUTH_TAG_BYTES },
  );
  decipher.setAAD(aad(workspaceId, metadata.chunkBytes, chunkIndex, plaintextBytes));
  decipher.setAuthTag(encrypted.subarray(plaintextBytes));
  try {
    return Buffer.concat([
      decipher.update(encrypted.subarray(0, plaintextBytes)),
      decipher.final(),
    ]);
  } catch {
    throw new Error('personal_vault_import_decryption_failed');
  }
}

export async function openEncryptedPersonalArchive(
  workspaceId: string,
  storagePath: string,
  options: Pick<PersonalArchiveEncryptionOptions, 'rootKey'> = {},
): Promise<{
  metadata: EncryptedPersonalArchiveMetadata;
  createReadStream(start?: number, end?: number): Readable;
}> {
  const metadata = await readEncryptedPersonalArchiveMetadata(workspaceId, storagePath, options);
  const key = derivePersonalArchiveEncryptionKey(workspaceId, options.rootKey);
  return {
    metadata,
    createReadStream(start = 0, end = metadata.plaintextBytes): Readable {
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > metadata.plaintextBytes) {
        return Readable.from((async function* invalidRange() {
          throw new Error('personal_vault_import_plaintext_range_invalid');
        })());
      }
      return Readable.from((async function* decryptRange() {
        const handle = await open(storagePath, 'r');
        try {
          const firstChunk = Math.floor(start / metadata.chunkBytes);
          const lastChunk = end === start ? firstChunk - 1 : Math.floor((end - 1) / metadata.chunkBytes);
          for (let chunkIndex = firstChunk; chunkIndex <= lastChunk; chunkIndex += 1) {
            const plaintext = await decryptChunk(handle, workspaceId, metadata, key, chunkIndex);
            const chunkStart = chunkIndex * metadata.chunkBytes;
            const from = Math.max(0, start - chunkStart);
            const to = Math.min(plaintext.length, end - chunkStart);
            if (to > from) yield plaintext.subarray(from, to);
          }
        } finally {
          await handle.close();
        }
      })());
    },
  };
}

export async function verifyEncryptedPersonalArchiveDigest(
  workspaceId: string,
  storagePath: string,
  expectedContentSha256?: string,
  options: Pick<PersonalArchiveEncryptionOptions, 'rootKey'> = {},
): Promise<string> {
  const archive = await openEncryptedPersonalArchive(workspaceId, storagePath, options);
  const hash = createHash('sha256');
  for await (const value of archive.createReadStream()) hash.update(value as Buffer);
  const digest = hash.digest('hex');
  if (digest !== archive.metadata.contentSha256 || (expectedContentSha256 && digest !== expectedContentSha256)) {
    throw new Error('personal_vault_import_content_digest_mismatch');
  }
  return digest;
}

export const PERSONAL_ARCHIVE_ENCRYPTION_HEADER_BYTES = HEADER_BYTES;
