import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Sql } from 'postgres';
import type { SessionBackend } from './types';
import {
  decompressArchiveBlobBounded,
  sha256Hex,
  type SessionArchiveStore,
} from '../session-archive';

export const MAX_SESSION_PORT_SOURCE_BYTES = 64 * 1024 * 1024;

/** Carry-respawn rotates the tracked row's native id. The latest indexed
 * owner of the exact, backend-pinned evidence incarnation is the shared guard
 * used by both the dispatcher and the session-port inspection route. */
export async function evidenceIncarnationOwnedBy(
  sql: Sql,
  sourceRow: { coordOwnerId: string | null; agent?: string | null },
  sessionId: string,
): Promise<boolean> {
  if (!sourceRow.coordOwnerId) return false;
  const [latest] = await sql<Array<{ owner: string }>>`
    SELECT t.owner
      FROM harness_shared.session_turns t
     WHERE t.session_id = ${sessionId}
       AND t.source_kind = ${sourceRow.agent ?? 'claude'}
       AND t.owner IS NOT NULL
     ORDER BY t.ingested_at DESC
     LIMIT 1
  `;
  return latest?.owner === sourceRow.coordOwnerId;
}

export interface StableSource {
  bytes: Buffer;
  sha256: string;
  highWaterBytes: number;
  completeBytes: number;
  source: 'live-jsonl' | 'archive-manifest';
  relpath: string | null;
}

function nativeTranscriptName(backend: 'codex' | 'omp', name: string, sessionId: string): boolean {
  return backend === 'codex'
    ? name.startsWith('rollout-') && name.endsWith(`-${sessionId}.jsonl`)
    : name === `${sessionId}.jsonl` || name.endsWith(`_${sessionId}.jsonl`);
}

/** Exact native id, inside ONE tracked home. Display resolvers' newest-file
 * and cross-home fallback semantics are deliberately unsuitable for evidence. */
export async function findCanonicalNativeLiveJsonl(root: string, backend: 'codex' | 'omp', sessionId: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{6,}$/.test(sessionId)) throw new Error('invalid native session identity');
  const matches: string[] = [];
  const walk = async (directory: string, remaining: number): Promise<void> => {
    const stat = await lstat(directory).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory() && remaining > 0) await walk(path, remaining - 1);
      else if (entry.isFile() && nativeTranscriptName(backend, entry.name, sessionId)) matches.push(path);
    }
  };
  await walk(root, backend === 'codex' ? 3 : 1);
  if (matches.length !== 1) throw new Error(`canonical live ${backend} JSONL is ${matches.length ? 'ambiguous' : 'missing'}`);
  return matches[0]!;
}

export async function readCanonicalNativeArchive(
  key: { backend: Exclude<SessionBackend, 'claude'>; sessionId: string },
  store: SessionArchiveStore,
  maxBytes = MAX_SESSION_PORT_SOURCE_BYTES,
): Promise<StableSource> {
  const stamp = await store.readStamp(key.backend, key.sessionId);
  if (!stamp) throw new Error(`canonical ${key.backend} archive not found`);
  const primary = stamp.manifest.filter((entry) =>
    nativeTranscriptName(key.backend, basename(entry.relpath), key.sessionId) &&
    (key.backend !== 'codex' || entry.relpath.split(/[/\\]/)[0] === 'sessions'));
  if (primary.length !== 1) throw new Error(`canonical ${key.backend} archive is ${primary.length ? 'ambiguous' : 'missing'}`);
  const manifest = primary[0]!;
  if (manifest.bytes_raw > maxBytes) throw new Error(`archive source ${manifest.bytes_raw} exceeds ${maxBytes} byte cap`);
  const rows = await store.readFiles(key.backend, key.sessionId);
  const row = rows.find((candidate) => candidate.relpath === manifest.relpath);
  if (!row || row.bytes_raw !== manifest.bytes_raw || row.sha256 !== manifest.sha256) throw new Error('canonical native archive manifest/file metadata mismatch');
  const bytes = await decompressArchiveBlobBounded(row, maxBytes);
  if (sha256Hex(bytes) !== manifest.sha256) throw new Error('canonical native archive sha mismatch');
  return { bytes, sha256: manifest.sha256, highWaterBytes: bytes.length, completeBytes: bytes.length,
    source: 'archive-manifest', relpath: manifest.relpath };
}

/** Resolve exactly one `<config>/projects/<cwd-key>/<session>.jsonl` without
 * following symlinked project directories or files. Multiple matches are a
 * hard ambiguity; choosing the newest would silently select a branch/cwd. */
export async function findCanonicalClaudeLiveJsonl(
  claudeConfigDir: string,
  sessionId: string,
): Promise<string> {
  const projects = join(claudeConfigDir, 'projects');
  const entries = await readdir(projects, { withFileTypes: true }).catch(() => []);
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = join(projects, entry.name, `${sessionId}.jsonl`);
    const stat = await lstat(candidate).catch(() => null);
    if (stat?.isFile() && !stat.isSymbolicLink()) matches.push(candidate);
  }
  if (matches.length !== 1) {
    throw new Error(`canonical live Claude JSONL is ${matches.length ? 'ambiguous' : 'missing'}`);
  }
  return matches[0];
}

/** Snapshot an append-only JSONL at one byte high-water. O_NOFOLLOW rejects a
 * swapped transcript symlink; the final partial line is excluded so concurrent
 * appends cannot produce a half-record parse. */
export async function readStableLiveJsonl(
  path: string,
  maxBytes = MAX_SESSION_PORT_SOURCE_BYTES,
): Promise<StableSource> {
  const fh = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await fh.stat();
    if (!stat.isFile()) throw new Error('session source is not a regular file');
    const highWaterBytes = stat.size;
    if (highWaterBytes > maxBytes) throw new Error(`session source ${highWaterBytes} exceeds ${maxBytes} byte cap`);
    const snapshot = Buffer.allocUnsafe(highWaterBytes);
    let offset = 0;
    while (offset < highWaterBytes) {
      const { bytesRead } = await fh.read(snapshot, offset, highWaterBytes - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const read = snapshot.subarray(0, offset);
    const finalNewline = read.lastIndexOf(0x0a);
    const complete = finalNewline < 0 ? Buffer.alloc(0) : read.subarray(0, finalNewline + 1);
    return {
      bytes: complete,
      sha256: sha256Hex(complete),
      highWaterBytes,
      completeBytes: complete.length,
      source: 'live-jsonl',
      relpath: null,
    };
  } finally {
    await fh.close();
  }
}

/** Read the ONE canonical Claude primary JSONL directly from the archive.
 * Ambiguity is a hard error: concatenating multiple cwd/project transcripts
 * silently changes branch semantics and is never an acceptable fallback. */
export async function readCanonicalClaudeArchive(
  key: { sessionId: string },
  store: SessionArchiveStore,
  maxBytes = MAX_SESSION_PORT_SOURCE_BYTES,
): Promise<StableSource> {
  // Key by (source_kind, session_id) ONLY — the same key archive-at-death WRITES.
  // This previously passed the adv row's `workspaceId` ('papercusp-workspace'),
  // which can never match: the archive ref carries no workspaceId, so every row
  // lands under WS_DEFAULT (measured 2026-08-12: 17,147 rows, 100% 'default').
  // This branch runs exactly when the source session has ENDED — i.e. precisely
  // the sessions that ARE archived — so a cross-backend port of an ended session
  // always threw 'canonical Claude archive not found'. Same defect as the
  // /adv/sessions/resumable `hasArchive` lookup (WI-38236); found by re-probing
  // every archive-store call site after fixing that one.
  const stamp = await store.readStamp('claude', key.sessionId);
  if (!stamp) throw new Error('canonical Claude archive not found');
  const primary = stamp.manifest.filter(
    (entry) =>
      basename(entry.relpath) === `${key.sessionId}.jsonl` &&
      entry.relpath.split(/[/\\]/)[0] === 'projects',
  );
  if (primary.length !== 1) throw new Error(`canonical Claude archive is ${primary.length ? 'ambiguous' : 'missing'}`);
  const manifest = primary[0];
  if (manifest.bytes_raw > maxBytes) throw new Error(`archive source ${manifest.bytes_raw} exceeds ${maxBytes} byte cap`);
  const rows = await store.readFiles('claude', key.sessionId);
  const row = rows.find((candidate) => candidate.relpath === manifest.relpath);
  if (!row) throw new Error('canonical Claude archive file row missing');
  if (row.bytes_raw !== manifest.bytes_raw || row.sha256 !== manifest.sha256) {
    throw new Error('canonical Claude archive manifest/file metadata mismatch');
  }
  const raw = await decompressArchiveBlobBounded(row, maxBytes);
  if (sha256Hex(raw) !== manifest.sha256) throw new Error('canonical Claude archive sha mismatch');
  return {
    bytes: raw,
    sha256: manifest.sha256,
    highWaterBytes: raw.length,
    completeBytes: raw.length,
    source: 'archive-manifest',
    relpath: manifest.relpath,
  };
}
