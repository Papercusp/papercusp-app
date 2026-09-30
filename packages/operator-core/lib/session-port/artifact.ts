import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SESSION_PORT_ARTIFACT_TTL_MS = 15 * 60_000;
export const MAX_SESSION_PORT_ARTIFACT_BYTES = 8 * 1024 * 1024;

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');

export function parsePortToken(token: string): { portId: string; secret: string } | null {
  const match = String(token ?? '').match(/^([0-9a-f-]{36})\.([0-9a-f]{64})$/i);
  return match ? { portId: match[1], secret: match[2] } : null;
}

export function verifyPortToken(token: string, expectedHash: string): boolean {
  const parsed = parsePortToken(token);
  if (!parsed || !/^[0-9a-f]{64}$/i.test(expectedHash)) return false;
  return timingSafeEqual(Buffer.from(sha(parsed.secret), 'hex'), Buffer.from(expectedHash, 'hex'));
}

export async function writeSessionPortArtifact(input: {
  seed: string;
  portId?: string;
  root?: string;
  now?: number;
  secret?: string;
}): Promise<{ portId: string; token: string; tokenHash: string; path: string; expiresAt: string }> {
  const portId = input.portId ?? randomUUID();
  const secret = input.secret ?? randomBytes(32).toString('hex');
  if (!/^[0-9a-f]{64}$/i.test(secret)) throw new Error('session-port artifact secret must be 32-byte hex');
  if (Buffer.byteLength(input.seed, 'utf8') > MAX_SESSION_PORT_ARTIFACT_BYTES) {
    throw new Error(`session-port artifact exceeds ${MAX_SESSION_PORT_ARTIFACT_BYTES} byte cap`);
  }
  const root = input.root ?? join(homedir(), '.papercusp', 'session-ports');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const path = join(root, `${portId}.seed.md`);
  const temp = join(root, `.${portId}.${randomBytes(6).toString('hex')}.tmp`);
  const fh = await open(temp, 'wx', 0o600);
  try {
    await fh.writeFile(input.seed, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(temp, path);
  await chmod(path, 0o600);
  return {
    portId,
    token: `${portId}.${secret}`,
    tokenHash: sha(secret),
    path,
    expiresAt: new Date((input.now ?? Date.now()) + SESSION_PORT_ARTIFACT_TTL_MS).toISOString(),
  };
}

export async function readSessionPortArtifact(input: {
  token: string;
  expectedTokenHash: string;
  expectedPath: string;
  expiresAt: string;
  now?: number;
}): Promise<string> {
  if (!verifyPortToken(input.token, input.expectedTokenHash)) throw new Error('invalid session-port token');
  if (new Date(input.expiresAt).getTime() <= (input.now ?? Date.now())) throw new Error('session-port token expired');
  const fh = await open(input.expectedPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await fh.stat();
    if (!stat.isFile() || stat.size > MAX_SESSION_PORT_ARTIFACT_BYTES) {
      throw new Error('invalid or oversized session-port artifact');
    }
    return await fh.readFile('utf8');
  } finally {
    await fh.close();
  }
}

/** Deletion happens only after native transcript persistence is proven (or a
 * terminal failure), never merely because bootstrap read the seed. */
export async function deleteSessionPortArtifact(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Crash backstop for artifacts orphaned before/after a durable row update.
 * Only our UUID seed/temp names are eligible; symlinks and unrelated files are
 * never followed or removed. Immediate delivery cleanup remains the fast path. */
export async function pruneStaleSessionPortArtifacts(input: {
  root?: string;
  now?: number;
  ttlMs?: number;
  maxEntries?: number;
} = {}): Promise<{ scanned: number; removed: number; errors: number }> {
  const root = input.root ?? join(homedir(), '.papercusp', 'session-ports');
  const cutoff = (input.now ?? Date.now()) - (input.ttlMs ?? SESSION_PORT_ARTIFACT_TTL_MS);
  const maxEntries = Math.max(1, Math.min(input.maxEntries ?? 10_000, 100_000));
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { scanned: 0, removed: 0, errors: 0 };
    throw error;
  }
  let scanned = 0;
  let removed = 0;
  let errors = 0;
  const eligible = /^(?:[0-9a-f-]{36}\.seed\.md|\.[0-9a-f-]{36}\.[0-9a-f]{12}\.tmp)$/i;
  for (const entry of entries.slice(0, maxEntries)) {
    if (!eligible.test(entry.name) || !entry.isFile()) continue;
    scanned += 1;
    const path = join(root, entry.name);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs > cutoff) continue;
      if (await deleteSessionPortArtifact(path)) removed += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors += 1;
    }
  }
  return { scanned, removed, errors };
}

/** Compatibility alias for callers/tests predating the two-phase lifecycle.
 * It now means verify+read, not delete-on-read. */
export const consumeSessionPortArtifact = readSessionPortArtifact;
