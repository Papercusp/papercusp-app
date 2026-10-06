/**
 * session-archive.ts — PG as the canonical archive of ended CLI sessions
 * (plan session-db-archive-retire-dirs-2026-07-10 P-002/P-003; schema:
 * libs/db/sql/539-session-archives.sql).
 *
 * INVERTS the storage contract session-ingest.ts documents ("the JSONL is
 * the archive"): once a session ENDS, archiveSession() writes its
 * irreplaceable bytes — zstd-compressed, sha256-verified — into
 * harness_shared.session_archive_files (one row per file) plus ONE
 * session_archives STAMP row whose existence == "archive is complete".
 * After that, deleteArchivedSessionFiles() may remove the on-disk copies,
 * and a later resume rematerializes them byte-exactly from PG on disk-miss
 * (rematerializeSession → `claude --resume <uuid>` / `codex resume <uuid>`
 * replay normally; wake-executor wiring is P-008).
 *
 * session_turns is deliberately untouched: it remains the bounded, 45d-pruned
 * recall INDEX over this canonical store (plan D-001 — redaction-vs-fidelity,
 * bounded-vs-permanent, and binary sqlite files forbid a single physical
 * representation).
 *
 * Safety invariants:
 *  - NEVER follow symlinks. Per-session claude dirs are symlink farms into
 *    the shared ~/.claude — following one would archive (and later DELETE)
 *    SHARED state. All classification is lstat/Dirent-based.
 *  - Delete only after the stamp row is committed AND the on-disk sha still
 *    matches the manifest; a post-archive write REFUSES deletion (re-archive
 *    first).
 *  - The archive write is one PG transaction (file rows + stale-relpath prune
 *    + stamp): a crash mid-way leaves either no stamp (retry re-writes
 *    idempotently) or a complete archive — never a half-archive that passes
 *    for done.
 *  - Rematerialize never overwrites a DIFFERING existing file (disk wins —
 *    it may be newer than the archive); the conflict is reported instead.
 */

import { createHash } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import * as zlib from 'node:zlib';
import { getOrgPg } from '@papercusp/db-org';

// ── zstd (node:zlib ≥22.15/23.8; typed defensively — @types/node may lag) ──

interface ZstdZlib {
  zstdCompress?: (
    buf: Buffer,
    opts: unknown,
    cb: (err: Error | null, out: Buffer) => void,
  ) => void;
  zstdDecompress?: (buf: Buffer, cb: (err: Error | null, out: Buffer) => void) => void;
  constants: Record<string, number>;
}
const zl = zlib as unknown as ZstdZlib;
if (typeof zl.zstdCompress !== 'function' || typeof zl.zstdDecompress !== 'function') {
  // Fail loud at import time: silently archiving uncompressed (or not at all)
  // would violate the storage budget the plan is built on.
  throw new Error('session-archive: node:zlib zstd support missing (need node ≥22.15)');
}
const zstdCompressCb = zl.zstdCompress;
const zstdDecompressCb = zl.zstdDecompress;
const ZSTD_LEVEL = 9; // measured 2026-07-10: 4.7x on real transcripts at ~ms cost

async function zstdCompress(raw: Buffer): Promise<Buffer> {
  return promisify(zstdCompressCb)(raw, {
    params: { [zl.constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL },
  });
}
async function zstdDecompress(blob: Buffer): Promise<Buffer> {
  return promisify(zstdDecompressCb)(blob);
}

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** A manifest relpath is DATA from a PG row, not trusted code. Reject anything
 *  that could resolve OUTSIDE the session root (absolute, `..` segments, NUL):
 *  a poisoned/corrupt stamp row must never turn the delete leg into an
 *  arbitrary unlink or the rematerialize leg into an arbitrary write
 *  (WI-3859 adversarial pass). Collectors only ever produce rooted,
 *  dot-dot-free relpaths, so a hit here is corruption by definition. */
export function isUnsafeArchiveRelpath(rel: string): boolean {
  if (!rel || rel.includes('\0')) return true;
  if (isAbsolute(rel)) return true;
  return rel.split(/[/\\]/).some((seg) => seg === '..');
}

/**
 * Is this relpath keyed by the session it was archived under — i.e. is it THIS
 * session's own file, or state the session merely SHARED with its neighbours?
 *
 * WI-38706 (owner-hit 2026-08-14, "psu --resume ... Model provider
 * `papercusp-codex-gateway` not found"). The archive's delete leg may only
 * unlink files that BELONG to the archived session. Every collector names a
 * per-session file with the session id in its path — claude
 * `projects/<cwd>/<sid>.jsonl` + `todos/<sid>*`, omp `<cwd>/<ts>_<sid>.jsonl`,
 * codex `sessions/YYYY/MM/DD/rollout-<ts>-<sid>.jsonl` — so this predicate is
 * satisfied by construction for anything session-scoped, and fails exactly for
 * state that is scoped to the DIRECTORY instead.
 *
 * That distinction is not cosmetic: a per-session CODEX_HOME is shared by every
 * codex THREAD in it (psu reuses one home per adv session while codex mints a
 * new rollout uuid per resume — 7 rollouts in one home here, 217 in another), so
 * archiving one dead thread was unlinking the `config.toml` that every sibling
 * thread and every future resume needs. Losing it drops
 * `[model_providers.papercusp-codex-gateway]`, which codex records in each
 * rollout's `session_meta` and resolves against the CURRENT config at
 * `thread/resume` — hence the -32600 above, on 11 homes / 89 rollouts.
 *
 * Measured over the live archive when this landed: 16,014 claude rows and 672
 * omp rows are session-keyed (0 exceptions), against 2,764 codex rows that are
 * not — precisely the `config.toml` / `goals_*.sqlite` / `memories_*.sqlite`
 * population. So this is a no-op for claude and omp and a guard only where the
 * bug lives, INCLUDING for the manifests already written before the collector
 * stopped producing them.
 */
export function isSessionKeyedRelpath(sessionId: string, rel: string): boolean {
  return Boolean(sessionId) && rel.includes(sessionId);
}

/** Decompress one archived file row back to its raw bytes (codec-aware). */
export async function decompressArchiveBlob(row: Pick<ArchiveFileRow, 'codec' | 'blob'>): Promise<Buffer> {
  return row.codec === 'zstd' ? zstdDecompress(row.blob) : row.blob;
}

/** Port/read-path decompression with admission checks BEFORE expansion. The
 * manifest's raw length is authenticated later by sha, but it is the only
 * cheap pre-decompression bound; `maxOutputLength` also makes zlib abort if a
 * corrupt frame expands past the admitted size. */
export async function decompressArchiveBlobBounded(
  row: Pick<ArchiveFileRow, 'codec' | 'blob' | 'bytes_raw'>,
  maxRawBytes: number,
): Promise<Buffer> {
  if (row.bytes_raw < 0 || row.bytes_raw > maxRawBytes) {
    throw new Error(`archive raw payload ${row.bytes_raw} exceeds ${maxRawBytes} byte cap`);
  }
  if (row.blob.length > maxRawBytes) {
    throw new Error(`archive stored payload ${row.blob.length} exceeds ${maxRawBytes} byte cap`);
  }
  if (row.codec !== 'zstd') return row.blob;
  const fn = zl.zstdDecompress as unknown as (
    buf: Buffer,
    opts: { maxOutputLength: number },
    cb: (err: Error | null, out: Buffer) => void,
  ) => void;
  const raw = await promisify(fn)(row.blob, { maxOutputLength: maxRawBytes });
  if (raw.length !== row.bytes_raw || raw.length > maxRawBytes) {
    throw new Error(`archive raw length mismatch: manifest=${row.bytes_raw} actual=${raw.length}`);
  }
  return raw;
}

// ── types ────────────────────────────────────────────────────────────────────

export type ArchiveSourceKind = 'claude' | 'omp' | 'codex';

export interface SessionArchiveRef {
  sourceKind: ArchiveSourceKind;
  /** Native CLI session id (claude/omp jsonl uuid; codex rollout uuid). */
  sessionId: string;
  /** Abs root the collected relpaths resolve against: the CLAUDE_CONFIG_DIR,
   *  the CODEX_HOME, or the omp sessions root. */
  sessionRoot: string;
  owner?: string | null;
  harnessSlug?: string | null;
  cwd?: string | null;
  advSessionId?: number | null;
  /** Provenance: 'exit-hook' | 'reconciler' | 'backfill' | an ownerId. */
  archivedBy?: string | null;
}

export interface CollectedFile {
  rel: string;
  abs: string;
  bytes: number;
  mtimeMs: number;
}

export interface ArchiveFileRow {
  workspace_id: string;
  source_kind: string;
  session_id: string;
  relpath: string;
  codec: 'zstd';
  blob: Buffer;
  sha256: string;
  bytes_raw: number;
  bytes_stored: number;
  mtime: Date | null;
}

export interface ArchiveManifestEntry {
  relpath: string;
  sha256: string;
  bytes_raw: number;
}

export interface ArchiveStampRow {
  workspace_id: string;
  source_kind: string;
  session_id: string;
  owner: string | null;
  harness_slug: string | null;
  cwd: string | null;
  adv_session_id: number | null;
  session_root: string;
  file_count: number;
  bytes_raw: number;
  bytes_stored: number;
  manifest: ArchiveManifestEntry[];
  archived_by: string | null;
}

/** Thin PG boundary, injected in tests (pattern: session-dir-gc's pure core). */
export interface SessionArchiveStore {
  /** MUST be atomic: file rows + stale-relpath prune + stamp, one tx. */
  upsertArchive(files: ArchiveFileRow[], stamp: ArchiveStampRow): Promise<void>;
  /**
   * Reads are keyed by (source_kind, session_id) ALONE and always resolve under
   * WS_DEFAULT, because that is the only workspace a write can ever produce.
   *
   * There is deliberately NO workspace parameter (WI-38236 / EI-20271441524331244).
   * It used to be optional, which made passing a real slug — the natural move when
   * you are holding an adv row whose `workspaceId` is right there — return null
   * rather than raise: indistinguishable from "this session has no archive". That
   * silently produced the SAME bug at two independent call sites. Removing the
   * parameter makes the mistake a COMPILE error instead of a wrong answer.
   */
  readStamp(sourceKind: string, sessionId: string): Promise<ArchiveStampRow | null>;
  readFiles(sourceKind: string, sessionId: string): Promise<ArchiveFileRow[]>;
  stampAdvSessionArchived(advSessionId: number): Promise<void>;
}

const WS_DEFAULT = 'default';
/** Bounds: a "session" that trips these is malformed input, not an archive job. */
export const SESSION_ARCHIVE_MAX_FILES = 64;
export const SESSION_ARCHIVE_MAX_TOTAL_RAW_BYTES = 256 * 1024 * 1024;

// ── collectors (pure FS; exported for tests + the P-006 reconciler) ─────────

async function dirents(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function statFile(abs: string): Promise<{ bytes: number; mtimeMs: number } | null> {
  try {
    const st = await lstat(abs); // lstat: a symlinked file is NOT a file here
    return st.isFile() ? { bytes: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

async function isRealDir(abs: string): Promise<boolean> {
  try {
    return (await lstat(abs)).isDirectory();
  } catch {
    return false;
  }
}

async function collectClaude(ref: SessionArchiveRef): Promise<CollectedFile[]> {
  const out: CollectedFile[] = [];
  const projects = join(ref.sessionRoot, 'projects');
  if (await isRealDir(projects)) {
    for (const d of await dirents(projects)) {
      if (!d.isDirectory()) continue; // Dirent uses lstat semantics: symlinks excluded
      const rel = join('projects', d.name, `${ref.sessionId}.jsonl`);
      const st = await statFile(join(ref.sessionRoot, rel));
      if (st) out.push({ rel, abs: join(ref.sessionRoot, rel), ...st });
    }
  }
  // todos/ is usually a SYMLINK into shared ~/.claude (never archive through
  // it); only a real per-session todos dir contributes files.
  const todos = join(ref.sessionRoot, 'todos');
  if (await isRealDir(todos)) {
    for (const d of await dirents(todos)) {
      if (!d.isFile() || !d.name.startsWith(ref.sessionId)) continue;
      const rel = join('todos', d.name);
      const st = await statFile(join(ref.sessionRoot, rel));
      if (st) out.push({ rel, abs: join(ref.sessionRoot, rel), ...st });
    }
  }
  return out;
}

async function collectCodex(ref: SessionArchiveRef): Promise<CollectedFile[]> {
  const out: CollectedFile[] = [];
  // sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl — fixed 3-level walk.
  const sessions = join(ref.sessionRoot, 'sessions');
  if (await isRealDir(sessions)) {
    for (const y of await dirents(sessions)) {
      if (!y.isDirectory()) continue;
      for (const m of await dirents(join(sessions, y.name))) {
        if (!m.isDirectory()) continue;
        for (const d of await dirents(join(sessions, y.name, m.name))) {
          if (!d.isDirectory()) continue;
          for (const f of await dirents(join(sessions, y.name, m.name, d.name))) {
            if (!f.isFile()) continue;
            if (!f.name.startsWith('rollout-') || !f.name.endsWith(`${ref.sessionId}.jsonl`)) continue;
            const rel = join('sessions', y.name, m.name, d.name, f.name);
            const st = await statFile(join(ref.sessionRoot, rel));
            if (st) out.push({ rel, abs: join(ref.sessionRoot, rel), ...st });
          }
        }
      }
    }
  }
  // WI-38706 — HOME-LEVEL STATE IS DELIBERATELY NOT COLLECTED, matching
  // collectClaude/collectOmp, which take only files named for the session.
  //
  // This used to also take `config.toml` + `goals_*.sqlite` + `memories_*.sqlite`
  // whenever the root was a per-session CODEX_HOME (≠ shared ~/.codex), on the
  // premise (D-003) that "the home-level state is part of the session". That
  // premise is false: psu allocates one CODEX_HOME per ADV session, while codex
  // mints a new rollout uuid per thread/resume — so a home holds many sessions
  // (7 rollouts in one home when this was found, 217 in another). Collecting
  // shared files under whichever session ended first made the delete leg unlink
  // the `config.toml` its siblings were still using, and every subsequent
  // `codex resume` there died with "Model provider `papercusp-codex-gateway`
  // not found" (11 homes / 89 rollouts, owner-hit 2026-08-14).
  //
  // Nor is losing the archive copy a real cost. Claude proves it: its config
  // (settings.json / .claude.json / credentials) is likewise never archived, and
  // the resume leg REBUILDS it — `ensureInteractiveConfigViaOperator` →
  // POST /adv/sessions/ensure-claude-config → writeInteractiveClaudeConfig. Codex
  // now has the same contract (`ensure-codex-home` → writeSuCodexHome), so its
  // config.toml is regenerable from the SSOT rather than restorable from a copy —
  // and a regenerated one is strictly better, since a restored copy can carry a
  // stale MCP tool list. `memories_*` is inert in managed homes anyway (the
  // generated config sets `memories = false`).
  //
  // The archive copy was also never a trustworthy backup: keyed per session id,
  // a re-archive of the same session OVERWRITES it — which is how 5 of the 11
  // broken homes had their good 3,440-byte config replaced by the 87-byte
  // trust-only stub codex writes after the delete. A backup that the failure
  // mode corrupts is not a backup.
  //
  // Byte impact of dropping it, measured on the live archive: rollouts are
  // 8,593 MB raw of 8,641 MB total — home state was 0.5%. All of the FS→DB
  // reclaim this pipeline exists for is in the rollouts above.
  return out;
}

async function collectOmp(ref: SessionArchiveRef): Promise<CollectedFile[]> {
  const out: CollectedFile[] = [];
  // <sessions-root>/<munged-cwd>/<ts>_<uuid>.jsonl
  for (const d of await dirents(ref.sessionRoot)) {
    if (!d.isDirectory()) continue;
    for (const f of await dirents(join(ref.sessionRoot, d.name))) {
      if (!f.isFile()) continue;
      if (f.name !== `${ref.sessionId}.jsonl` && !f.name.endsWith(`_${ref.sessionId}.jsonl`)) continue;
      const rel = join(d.name, f.name);
      const st = await statFile(join(ref.sessionRoot, rel));
      if (st) out.push({ rel, abs: join(ref.sessionRoot, rel), ...st });
    }
  }
  return out;
}

export async function collectSessionFiles(ref: SessionArchiveRef): Promise<CollectedFile[]> {
  switch (ref.sourceKind) {
    case 'claude':
      return collectClaude(ref);
    case 'codex':
      return collectCodex(ref);
    case 'omp':
      return collectOmp(ref);
  }
}

/** Newest archived native session id for an adv session — wake-executor
 *  recovery (P-008) when the rollout was archived+deleted and the adv row
 *  carries no native id (codex rows often don't; the id normally lives in the
 *  on-disk rollout filename this lifecycle deletes). */
export async function findArchivedSessionIdForAdv(advSessionId: number): Promise<string | null> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<Array<{ session_id: string }>>`
      SELECT session_id FROM harness_shared.session_archives
       WHERE adv_session_id = ${advSessionId}
       ORDER BY archived_at DESC
       LIMIT 1`;
    return rows[0]?.session_id ?? null;
  } catch {
    return null;
  }
}

/** All rollout session ids present in a codex home (reconciler/backfill
 *  helper). Same uuid-tail rule as the ingest adapter's meta(). */
export async function listCodexRolloutSessionIds(sessionRoot: string): Promise<string[]> {
  const ids = new Set<string>();
  const sessions = join(sessionRoot, 'sessions');
  if (!(await isRealDir(sessions))) return [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const e of await dirents(dir)) {
      if (e.isDirectory() && depth < 3) await walk(join(dir, e.name), depth + 1);
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        const m = basename(e.name, '.jsonl').match(/([0-9a-f]{8}-[0-9a-f-]{27,})$/i);
        if (m) ids.add(m[1]);
      }
    }
  };
  await walk(sessions, 0);
  return [...ids];
}

/** All native session ids present in a claude config dir (reconciler/backfill
 *  helper: one owner dir can hold several uuids across resumes). */
export async function listClaudeSessionIds(sessionRoot: string): Promise<string[]> {
  const ids = new Set<string>();
  const projects = join(sessionRoot, 'projects');
  if (!(await isRealDir(projects))) return [];
  for (const d of await dirents(projects)) {
    if (!d.isDirectory()) continue;
    for (const f of await dirents(join(projects, d.name))) {
      if (f.isFile() && f.name.endsWith('.jsonl')) ids.add(basename(f.name, '.jsonl'));
    }
  }
  return [...ids];
}

// ── archive / delete / rematerialize ────────────────────────────────────────

export interface ArchiveSessionResult {
  ok: boolean;
  reason?: 'no_files' | 'too_many_files' | 'too_large' | 'changed_during_read';
  fileCount: number;
  bytesRaw: number;
  bytesStored: number;
}

/** Test seam for the source read in {@link archiveSession}. The production
 * reader is node:fs/promises.readFile; the seam lets the race guard be tested
 * deterministically without relying on a timing-sensitive live writer. */
export interface ArchiveSessionReadDeps {
  readFile?: (path: string) => Promise<Buffer>;
}

export async function archiveSession(
  ref: SessionArchiveRef,
  store: SessionArchiveStore = pgSessionArchiveStore(),
  deps: ArchiveSessionReadDeps = {},
): Promise<ArchiveSessionResult> {
  const none = { fileCount: 0, bytesRaw: 0, bytesStored: 0 };
  const collected = await collectSessionFiles(ref);
  if (!collected.length) return { ok: false, reason: 'no_files', ...none };
  if (collected.length > SESSION_ARCHIVE_MAX_FILES) return { ok: false, reason: 'too_many_files', ...none };
  const totalRaw = collected.reduce((s, f) => s + f.bytes, 0);
  if (totalRaw > SESSION_ARCHIVE_MAX_TOTAL_RAW_BYTES) return { ok: false, reason: 'too_large', ...none };

  // Writers key every row under WS_DEFAULT, unconditionally. The ref carries no
  // workspace: a ref-supplied one could mint a row no reader is able to address.
  const ws = WS_DEFAULT;
  const fileRows: ArchiveFileRow[] = [];
  const manifest: ArchiveManifestEntry[] = [];
  let bytesRaw = 0;
  let bytesStored = 0;
  const readSnapshot = deps.readFile ?? readFile;
  for (const f of collected) {
    const raw = await readSnapshot(f.abs);
    // The source is a live, append-only CLI file. A read can finish on a
    // partial tail while the native writer is still appending; committing that
    // byte slice would make the canonical archive temporarily incomplete even
    // though the later SHA-checked delete would refuse to remove the newer
    // source. Fail closed and let the end hook/reconciler retry from the now
    // stable file instead.
    const afterRead = await statFile(f.abs);
    if (!afterRead || afterRead.bytes !== f.bytes || afterRead.mtimeMs !== f.mtimeMs) {
      return { ok: false, reason: 'changed_during_read', ...none };
    }
    const sha = sha256Hex(raw);
    const blob = await zstdCompress(raw);
    bytesRaw += raw.length;
    bytesStored += blob.length;
    fileRows.push({
      workspace_id: ws,
      source_kind: ref.sourceKind,
      session_id: ref.sessionId,
      relpath: f.rel,
      codec: 'zstd',
      blob,
      sha256: sha,
      bytes_raw: raw.length,
      bytes_stored: blob.length,
      mtime: new Date(f.mtimeMs),
    });
    manifest.push({ relpath: f.rel, sha256: sha, bytes_raw: raw.length });
  }
  await store.upsertArchive(fileRows, {
    workspace_id: ws,
    source_kind: ref.sourceKind,
    session_id: ref.sessionId,
    owner: ref.owner ?? null,
    harness_slug: ref.harnessSlug ?? null,
    cwd: ref.cwd ?? null,
    adv_session_id: ref.advSessionId ?? null,
    session_root: ref.sessionRoot,
    file_count: fileRows.length,
    bytes_raw: bytesRaw,
    bytes_stored: bytesStored,
    manifest,
    archived_by: ref.archivedBy ?? null,
  });
  if (ref.advSessionId != null) {
    try {
      await store.stampAdvSessionArchived(ref.advSessionId);
    } catch (e) {
      console.warn(`[session-archive] adv stamp failed (archive itself committed): ${(e as Error)?.message}`);
    }
  }
  return { ok: true, fileCount: fileRows.length, bytesRaw, bytesStored };
}

export interface DeleteArchivedResult {
  ok: boolean;
  reason?: 'not_archived';
  deleted: number;
  missing: number;
  /** relpaths whose on-disk bytes no longer match the archived sha — NOT
   *  deleted; the caller must re-archive before retrying. */
  refused: string[];
  /** relpaths RETAINED on disk because they are not keyed by this session
   *  (`isSessionKeyedRelpath`) — directory-shared state a sibling session or a
   *  future resume still needs, archived under one session's id by an older
   *  collector. Deliberately NOT `refused`: refusal means "the bytes drifted,
   *  re-archive and retry", and the reconciler acts on it by re-archiving then
   *  deleting — which would delete exactly what this is protecting (WI-38706). */
  retained: string[];
}

export async function deleteArchivedSessionFiles(
  ref: Pick<SessionArchiveRef, 'sourceKind' | 'sessionId'> & { sessionRoot?: string },
  store: SessionArchiveStore = pgSessionArchiveStore(),
): Promise<DeleteArchivedResult> {
  const stamp = await store.readStamp(ref.sourceKind, ref.sessionId);
  if (!stamp) {
    return { ok: false, reason: 'not_archived', deleted: 0, missing: 0, refused: [], retained: [] };
  }
  const root = ref.sessionRoot ?? stamp.session_root;
  let deleted = 0;
  let missing = 0;
  const refused: string[] = [];
  const retained: string[] = [];
  for (const m of stamp.manifest) {
    if (isUnsafeArchiveRelpath(m.relpath)) {
      refused.push(m.relpath); // poisoned/corrupt manifest — never resolve it
      continue;
    }
    // WI-38706: the archive may only unlink files that BELONG to this session.
    // Anything else in the manifest is directory-shared state (an older
    // collector took the codex home's config.toml/goals/memories under whichever
    // session happened to end first) that a sibling thread or a future resume
    // still reads off disk. Keep the archived COPY, keep the file.
    if (!isSessionKeyedRelpath(ref.sessionId, m.relpath)) {
      retained.push(m.relpath);
      continue;
    }
    const abs = join(root, m.relpath);
    const st = await statFile(abs);
    if (!st) {
      missing++;
      continue;
    }
    // Resolve-and-verify: the path must resolve EXACTLY to <root>/<relpath>.
    // Collection was symlink-safe at ARCHIVE time, but the tree is re-resolved
    // at DELETE time — an intermediate dir since swapped for a symlink (the
    // per-session dirs are symlink farms into shared ~/.claude) would carry
    // the unlink into shared state.
    try {
      if ((await realpath(abs)) !== join(await realpath(root), m.relpath)) {
        refused.push(m.relpath);
        continue;
      }
    } catch {
      missing++;
      continue;
    }
    const raw = await readFile(abs);
    if (sha256Hex(raw) !== m.sha256) {
      refused.push(m.relpath);
      continue;
    }
    await unlink(abs);
    deleted++;
  }
  // `retained` deliberately does NOT clear `ok`: nothing went wrong and there is
  // nothing to retry — those files are simply not this session's to delete.
  return { ok: refused.length === 0, deleted, missing, refused, retained };
}

/** The end-of-session fast path atom: archive, then delete what was archived. */
export async function archiveAndDeleteSession(
  ref: SessionArchiveRef,
  store: SessionArchiveStore = pgSessionArchiveStore(),
): Promise<{ archive: ArchiveSessionResult; delete?: DeleteArchivedResult }> {
  const archive = await archiveSession(ref, store);
  if (!archive.ok) return { archive };
  const del = await deleteArchivedSessionFiles(ref, store);
  return { archive, delete: del };
}

export interface RematerializeResult {
  ok: boolean;
  reason?: 'not_archived' | 'incomplete_archive' | 'sha_mismatch' | 'bad_relpath';
  root?: string;
  written: number;
  skippedExisting: number;
  /** Existing on-disk entries that DIFFER from the archive (or are symlinks /
   *  resolve outside the root) — left untouched; disk shape wins. */
  conflicts: string[];
}

export interface ArchiveReadinessResult {
  /** A complete archive stamp exists in the canonical store. */
  archived: boolean;
  /** Every manifest entry has a corresponding, byte-exact on-disk file. */
  ready: boolean;
  reason?: 'not_archived' | 'incomplete_archive' | 'not_materialized' | 'sha_mismatch' | 'bad_relpath' | 'conflict';
  root?: string;
  /** Missing manifest rows or on-disk files, reported by relpath. */
  missing: string[];
  /** Existing entries that are not the archived file (including symlinks). */
  conflicts: string[];
}

/**
 * Read-only readiness check shared by the rematerialize status route and its
 * callers. A stamp proves that the archive is complete in PG; it does not
 * prove that a timed-out rematerialization has finished writing its files.
 * Keep this check separate from rematerializeSession so a GET never writes
 * or interprets an in-flight POST as `not_archived`.
 */
export async function inspectArchiveReadiness(
  key: { sourceKind: ArchiveSourceKind; sessionId: string },
  store: SessionArchiveStore = pgSessionArchiveStore(),
): Promise<ArchiveReadinessResult> {
  const missing = new Set<string>();
  const conflicts = new Set<string>();
  let shaMismatch = false;
  const stamp = await store.readStamp(key.sourceKind, key.sessionId);
  if (!stamp) return { archived: false, ready: false, reason: 'not_archived', missing: [], conflicts: [] };

  const rows = await store.readFiles(key.sourceKind, key.sessionId);
  const byRel = new Map(rows.map((row) => [row.relpath, row]));
  const root = stamp.session_root;
  let realRoot: string | null = null;
  try {
    realRoot = await realpath(root);
  } catch {
    // The root may not exist until the first rematerialize write. Every
    // manifest entry is consequently missing, but the archive is still real.
  }

  for (const manifest of stamp.manifest) {
    if (isUnsafeArchiveRelpath(manifest.relpath)) {
      return {
        archived: true,
        ready: false,
        reason: 'bad_relpath',
        root,
        missing: [...missing],
        conflicts: [...conflicts, manifest.relpath],
      };
    }
    if (!byRel.has(manifest.relpath)) missing.add(manifest.relpath);
    if (!realRoot) {
      continue;
    }

    const abs = join(root, manifest.relpath);
    let entry: Stats | null = null;
    try {
      entry = await lstat(abs);
    } catch {
      entry = null;
    }
    if (!entry) {
      missing.add(manifest.relpath);
      continue;
    }
    if (!entry.isFile()) {
      conflicts.add(manifest.relpath);
      continue;
    }
    try {
      if ((await realpath(abs)) !== join(realRoot, manifest.relpath)) {
        conflicts.add(manifest.relpath);
        continue;
      }
      const raw = await readFile(abs);
      if (sha256Hex(raw) !== manifest.sha256) {
        conflicts.add(manifest.relpath);
        shaMismatch = true;
      }
    } catch {
      conflicts.add(manifest.relpath);
    }
  }

  const missingList = [...missing];
  const conflictList = [...conflicts];
  const ready = missingList.length === 0 && conflictList.length === 0;
  return {
    archived: true,
    ready,
    reason: ready
      ? undefined
      : conflictList.length > 0
        ? shaMismatch ? 'sha_mismatch' : 'conflict'
        : missingList.some((rel) => byRel.has(rel)) ? 'not_materialized' : 'incomplete_archive',
    root,
    missing: missingList,
    conflicts: conflictList,
  };
}

export async function rematerializeSession(
  key: { sourceKind: ArchiveSourceKind; sessionId: string; targetRoot?: string },
  store: SessionArchiveStore = pgSessionArchiveStore(),
): Promise<RematerializeResult> {
  const none = { written: 0, skippedExisting: 0, conflicts: [] as string[] };
  const stamp = await store.readStamp(key.sourceKind, key.sessionId);
  if (!stamp) return { ok: false, reason: 'not_archived', ...none };
  const rows = await store.readFiles(key.sourceKind, key.sessionId);
  const byRel = new Map(rows.map((r) => [r.relpath, r]));
  const root = key.targetRoot ?? stamp.session_root;
  await mkdir(root, { recursive: true });
  const realRoot = await realpath(root);
  let written = 0;
  let skippedExisting = 0;
  const conflicts: string[] = [];
  for (const m of stamp.manifest) {
    if (isUnsafeArchiveRelpath(m.relpath)) {
      // Poisoned/corrupt manifest — never resolve it into a write.
      return { ok: false, reason: 'bad_relpath', root, written, skippedExisting, conflicts };
    }
    const row = byRel.get(m.relpath);
    if (!row) return { ok: false, reason: 'incomplete_archive', root, written, skippedExisting, conflicts };
    const raw = row.codec === 'zstd' ? await zstdDecompress(row.blob) : row.blob;
    if (sha256Hex(raw) !== m.sha256) {
      return { ok: false, reason: 'sha_mismatch', root, written, skippedExisting, conflicts };
    }
    const abs = join(root, m.relpath);
    // lstat DIRECTLY (not statFile's file-only view): a SYMLINK at the target
    // is an existing entry we must never write through — writeFile would
    // follow it into shared ~/.claude (the per-session dirs are symlink farms
    // the launcher re-creates). Any non-file entry ⇒ conflict, disk shape wins.
    let entry: Stats | null = null;
    try {
      entry = await lstat(abs);
    } catch {
      entry = null;
    }
    if (entry) {
      if (entry.isFile()) {
        const cur = await readFile(abs);
        if (sha256Hex(cur) === m.sha256) {
          skippedExisting++;
        } else {
          conflicts.push(m.relpath); // disk wins — it may be newer than the archive
        }
      } else {
        conflicts.push(m.relpath); // symlink / dir at the target — never write through
      }
      continue;
    }
    await mkdir(dirname(abs), { recursive: true });
    // Containment: a PRE-EXISTING parent may be (or contain) a symlink that
    // escapes the root — verify it still resolves inside before writing.
    const realDir = await realpath(dirname(abs));
    if (realDir !== join(realRoot, dirname(m.relpath))) {
      conflicts.push(m.relpath);
      continue;
    }
    await writeFile(abs, raw);
    if (row.mtime != null) {
      try {
        // WI-3859 F6 (caught by the live e2e): the PG client returns `mtime`
        // as a STRING, which utimes rejects — and the best-effort catch was
        // silently swallowing that on EVERY real rematerialize. Coerce first.
        const m = row.mtime instanceof Date ? row.mtime : new Date(row.mtime as unknown as string);
        if (!Number.isNaN(m.getTime())) await utimes(abs, m, m);
      } catch {
        /* mtime restore is best-effort */
      }
    }
    written++;
  }
  return { ok: true, root, written, skippedExisting, conflicts };
}

// ── PG store ─────────────────────────────────────────────────────────────────

export function pgSessionArchiveStore(): SessionArchiveStore {
  return {
    async upsertArchive(files, stamp) {
      const { sql } = getOrgPg();
      await sql.begin(async (tx) => {
        for (const f of files) {
          await tx`
            INSERT INTO harness_shared.session_archive_files
              (workspace_id, source_kind, session_id, relpath, codec, blob,
               sha256, bytes_raw, bytes_stored, mtime)
            VALUES (${f.workspace_id}, ${f.source_kind}, ${f.session_id}, ${f.relpath},
                    ${f.codec}, ${f.blob}, ${f.sha256}, ${f.bytes_raw}, ${f.bytes_stored},
                    ${f.mtime ? f.mtime.toISOString() : null})
            ON CONFLICT (workspace_id, source_kind, session_id, relpath) DO UPDATE SET
              codec = EXCLUDED.codec, blob = EXCLUDED.blob, sha256 = EXCLUDED.sha256,
              bytes_raw = EXCLUDED.bytes_raw, bytes_stored = EXCLUDED.bytes_stored,
              mtime = EXCLUDED.mtime, archived_at = now()`;
        }
        // Prune relpaths from a previous archive shape no longer in the manifest.
        const rels = stamp.manifest.map((m) => m.relpath);
        await tx`
          DELETE FROM harness_shared.session_archive_files
           WHERE workspace_id = ${stamp.workspace_id} AND source_kind = ${stamp.source_kind}
             AND session_id = ${stamp.session_id} AND relpath <> ALL(${rels})`;
        await tx`
          INSERT INTO harness_shared.session_archives
            (workspace_id, source_kind, session_id, owner, harness_slug, cwd,
             adv_session_id, session_root, file_count, bytes_raw, bytes_stored,
             manifest, archived_by)
          VALUES (${stamp.workspace_id}, ${stamp.source_kind}, ${stamp.session_id},
                  ${stamp.owner}, ${stamp.harness_slug}, ${stamp.cwd},
                  ${stamp.adv_session_id}, ${stamp.session_root}, ${stamp.file_count},
                  ${stamp.bytes_raw}, ${stamp.bytes_stored},
                  ${JSON.stringify(stamp.manifest)}::text::jsonb, ${stamp.archived_by})
          ON CONFLICT (workspace_id, source_kind, session_id) DO UPDATE SET
            owner = COALESCE(EXCLUDED.owner, harness_shared.session_archives.owner),
            harness_slug = COALESCE(EXCLUDED.harness_slug, harness_shared.session_archives.harness_slug),
            cwd = COALESCE(EXCLUDED.cwd, harness_shared.session_archives.cwd),
            adv_session_id = COALESCE(EXCLUDED.adv_session_id, harness_shared.session_archives.adv_session_id),
            session_root = EXCLUDED.session_root, file_count = EXCLUDED.file_count,
            bytes_raw = EXCLUDED.bytes_raw, bytes_stored = EXCLUDED.bytes_stored,
            manifest = EXCLUDED.manifest, archived_by = EXCLUDED.archived_by,
            archived_at = now()`;
      });
    },

    async readStamp(sourceKind, sessionId) {
      const workspaceId = WS_DEFAULT;
      const { sql } = getOrgPg();
      const rows = await sql<
        Array<Omit<ArchiveStampRow, 'file_count' | 'bytes_raw' | 'bytes_stored' | 'adv_session_id'> & {
          file_count: number | string;
          bytes_raw: number | string;
          bytes_stored: number | string;
          adv_session_id: number | string | null;
        }>
      >`
        SELECT workspace_id, source_kind, session_id, owner, harness_slug, cwd,
               adv_session_id, session_root, file_count, bytes_raw, bytes_stored,
               manifest, archived_by
          FROM harness_shared.session_archives
         WHERE workspace_id = ${workspaceId} AND source_kind = ${sourceKind}
           AND session_id = ${sessionId}`;
      if (!rows.length) return null;
      const r = rows[0];
      return {
        ...r,
        file_count: Number(r.file_count),
        bytes_raw: Number(r.bytes_raw),
        bytes_stored: Number(r.bytes_stored),
        adv_session_id: r.adv_session_id == null ? null : Number(r.adv_session_id),
      };
    },

    async readFiles(sourceKind, sessionId) {
      const workspaceId = WS_DEFAULT;
      const { sql } = getOrgPg();
      const rows = await sql<
        Array<Omit<ArchiveFileRow, 'bytes_raw' | 'bytes_stored'> & {
          bytes_raw: number | string;
          bytes_stored: number | string;
        }>
      >`
        SELECT workspace_id, source_kind, session_id, relpath, codec, blob,
               sha256, bytes_raw, bytes_stored, mtime
          FROM harness_shared.session_archive_files
         WHERE workspace_id = ${workspaceId} AND source_kind = ${sourceKind}
           AND session_id = ${sessionId}`;
      return rows.map((r) => ({
        ...r,
        bytes_raw: Number(r.bytes_raw),
        bytes_stored: Number(r.bytes_stored),
        // type honesty (WI-3859 F6): the client hands timestamptz back as a
        // string; the declared ArchiveFileRow contract is Date | null.
        mtime: r.mtime == null ? null : r.mtime instanceof Date ? r.mtime : new Date(r.mtime as unknown as string),
      }));
    },

    async stampAdvSessionArchived(advSessionId) {
      const { sql } = getOrgPg();
      await sql`
        UPDATE harness_shared.adv_sessions
           SET archived_at = now()
         WHERE id = ${advSessionId} AND archived_at IS NULL`;
    },
  };
}
