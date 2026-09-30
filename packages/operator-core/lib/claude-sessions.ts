/**
 * claude-sessions — find / search / read Claude Code chat transcripts
 * (~/.claude/projects/<encoded-cwd>/<session-id>.jsonl), the Claude-Code analogue
 * of omp-sessions.ts. Backs the dev:claude_session tool (EI-4911): there was no
 * first-class way to find a prior Claude session, so continuing one meant
 * hand-grepping hundreds of transcript JSONLs.
 *
 * Reliable core: LIST by cwd + recency (cheap — a bounded head-read for `cwd` +
 * the file mtime). Bonus: bounded content SEARCH (the transcript is a lossy,
 * non-canonical secondary — a final message is often not persisted verbatim, and
 * markers match incidentally; the code + work-item/plan ledger is the real source
 * of truth, so treat a search hit as a lead, not proof).
 *
 * Every fs entrypoint takes an optional `root` so tests point at a fixture dir
 * instead of the real $HOME.
 */

import { promises as fs, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

export function defaultClaudeProjectsRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

/**
 * Base dir holding per-session ISOLATED Claude configs:
 * ~/.papercusp/session-claude/<coord-owner-id>/ . psu/su CONSOLE sessions run
 * under a per-session CLAUDE_CONFIG_DIR keyed by the owner id, so their
 * transcripts live at <base>/<owner>/projects/<encoded-cwd>/<session-id>.jsonl —
 * NOT under ~/.claude/projects (EI-5790 / reference_session_launch_dirs_unified_keying).
 */
export function papercuspSessionClaudeBase(): string {
  return join(homedir(), '.papercusp', 'session-claude');
}

/**
 * Every Claude `projects/` root to scan: the global ~/.claude/projects PLUS each
 * per-session isolation root ~/.papercusp/session-claude/<owner>/projects. Without
 * the isolation roots, a psu/su console session is invisible to dev:claude_session
 * (the bug that made `su-…` console transcripts unfindable). Fail-soft: a missing
 * or unreadable isolation base yields the global root only. Params are injectable
 * for tests.
 */
export async function claudeProjectsRoots(
  globalRoot: string = defaultClaudeProjectsRoot(),
  isolationBase: string = papercuspSessionClaudeBase(),
): Promise<string[]> {
  const roots = [globalRoot];
  try {
    for (const owner of await fs.readdir(isolationBase)) {
      roots.push(join(isolationBase, owner, 'projects'));
    }
  } catch {
    // no isolation base (or unreadable) — global root only
  }
  return roots;
}

/** sessionId → resolved transcript path. A session's transcript path is STABLE
 *  once written (the file never moves), so a validated cached hit skips the walk
 *  entirely — repeat opens of the same agent cost one stat, not a full sweep.
 *  Only POSITIVE resolutions are cached (a not-yet-written transcript must be
 *  re-resolved once it appears). Module-scoped + unbounded is fine: the key space
 *  is the set of session ids the loopback inspector has opened this process. */
const transcriptPathCache = new Map<string, string>();

/**
 * NEGATIVE-resolution cache (sessionId → miss-expiry ms). A sessionId that does NOT
 * resolve — a dead/ephemeral id, or a transcript not yet written — must NOT re-run the
 * full `claudeProjectsRoots()` sweep (readdir of 12k+ isolation-owner dirs) on EVERY
 * call. The compaction-usage watchdog polls `estimateContextTokensForOwner` on a cadence
 * for MANY owners, and before this each miss re-swept every root — ~13 MB/s of `path.join`
 * churn that outpaced GC and bloated the background host to tens of GB (+ pinned the event
 * loop "CPU-bound on main thread"). SHORT TTL so a not-yet-written transcript is re-resolved
 * once it appears; lightly pruned so a stream of unique ids can't grow it unbounded.
 */
const transcriptMissCache = new Map<string, number>();
const TRANSCRIPT_MISS_TTL_MS = 30_000;
const TRANSCRIPT_MISS_MAX = 20_000;
function rememberTranscriptMiss(sessionId: string, now: number): void {
  if (transcriptMissCache.size >= TRANSCRIPT_MISS_MAX) {
    for (const [k, exp] of transcriptMissCache) if (exp <= now) transcriptMissCache.delete(k);
    if (transcriptMissCache.size >= TRANSCRIPT_MISS_MAX) transcriptMissCache.clear();
  }
  transcriptMissCache.set(sessionId, now + TRANSCRIPT_MISS_TTL_MS);
}

/**
 * TTL-cached default roots. `claudeProjectsRoots()` readdir's the isolation base (12k+
 * owner dirs on a long-lived box) — far too expensive to redo per lookup. The roots list
 * changes rarely (a new isolation-owner dir appears occasionally), so a short TTL turns a
 * per-call 12k-dir readdir into ~one readdir per window. ONLY the default-args hot path is
 * cached; callers that inject explicit roots/args (tests, targeted scans) bypass it.
 */
let defaultRootsCache: { at: number; roots: string[] } | null = null;
const DEFAULT_ROOTS_TTL_MS = 15_000;
async function defaultProjectsRootsCached(now: number): Promise<string[]> {
  if (defaultRootsCache && now - defaultRootsCache.at < DEFAULT_ROOTS_TTL_MS) {
    return defaultRootsCache.roots;
  }
  const roots = await claudeProjectsRoots();
  defaultRootsCache = { at: now, roots };
  return roots;
}

/** Test seam: clear the module-scoped resolution caches so a soak/unit test starts clean. */
export function __resetClaudeSessionCaches(): void {
  transcriptPathCache.clear();
  transcriptMissCache.clear();
  defaultRootsCache = null;
}

/**
 * Resolve the transcript jsonl for a Claude session by its id — the
 * `<session-id>.jsonl` handle. Returns the first match's absolute path, or null.
 *
 * FAST PATH (`owner` hint): interactive sessions live under a per-owner isolation
 * root `~/.papercusp/session-claude/<owner>/projects/…`, and the caller (the
 * agents-roster) already knows the agent's coord `owner`. Given it, we scan ONLY
 * that root plus the global `~/.claude/projects` — NEVER the FULL
 * `claudeProjectsRoots()` sweep, which readdir's EVERY isolation owner dir
 * (13k+ on a long-lived box). The hint is authoritative for isolation roots
 * (launch keys CLAUDE_CONFIG_DIR and coord_owner_id from the same sid), so an
 * owner-hinted miss is a REAL miss — typically a live session that hasn't taken
 * its first turn yet — and re-sweeping every owner dir for it per roster push
 * was the CPU storm that pegged the desktop operator. Hint-ABSENT callers keep
 * the full sweep; a path cache keeps repeat hits at one stat.
 *
 * A targeted stat-only walk (readdir the project dirs, stat the one target file).
 * Powers the agents-roster live-thinking view for INTERACTIVE (non-bee) sessions,
 * which — unlike a spawned bee's harness run-log — keep their timeline here.
 */
export async function findSessionTranscript(
  sessionId: string,
  opts: { owner?: string | null; roots?: string[]; isolationBase?: string; nowMs?: number } = {},
): Promise<string | null> {
  if (!/^[A-Za-z0-9_.-]{6,}$/.test(sessionId)) return null;
  const file = `${sessionId}.jsonl`;
  const now = opts.nowMs ?? Date.now();
  // Resolution caches apply only to the production default-roots path; explicit-roots
  // callers (tests / targeted scans) bypass them so their scan is always deterministic.
  const useResolutionCaches = !opts.roots;

  // NEGATIVE cache: an id known-missing within the TTL short-circuits the whole
  // (potentially 12k-dir) sweep — the fix for the compaction-watchdog fs-churn bloat.
  if (useResolutionCaches) {
    const missUntil = transcriptMissCache.get(sessionId);
    if (missUntil !== undefined) {
      if (now < missUntil) return null;
      transcriptMissCache.delete(sessionId);
    }
  }

  // Validated cache hit → skip the walk. Re-resolve if the cached file vanished
  // (rotated/deleted), so a stale entry never wedges the lookup.
  const cached = transcriptPathCache.get(sessionId);
  if (cached) {
    try {
      await fs.access(cached);
      return cached;
    } catch {
      transcriptPathCache.delete(sessionId);
    }
  }

  const scan = async (root: string): Promise<string | null> => {
    let projectDirs: string[];
    try {
      projectDirs = await fs.readdir(root);
    } catch {
      return null; // root unreadable
    }
    for (const projDir of projectDirs) {
      const p = join(root, projDir, file);
      try {
        await fs.access(p);
        return p;
      } catch {
        /* not in this project dir */
      }
    }
    return null;
  };

  // FAST PATH: the owner's single isolation root, when the caller supplied a hint.
  if (opts.owner && /^[A-Za-z0-9_.-]+$/.test(opts.owner)) {
    const ownerRoot = join(opts.isolationBase ?? papercuspSessionClaudeBase(), opts.owner, 'projects');
    const hit = await scan(ownerRoot);
    if (hit) {
      transcriptPathCache.set(sessionId, hit);
      return hit;
    }
    // An owner hint is AUTHORITATIVE for the isolation roots (unified keying:
    // the launch's CLAUDE_CONFIG_DIR and coord_owner_id derive from the SAME
    // sid), so this session's transcript cannot live under ANOTHER owner's
    // isolation root — on a miss, check only the GLOBAL root (one cheap
    // readdir) and stop. Falling into the every-owner sweep here is not just
    // wasted work, it's the CPU storm that pegged the desktop operator: the
    // roster fires this per agent per push, a just-launched session has no
    // transcript until its first turn, and each miss re-walked 13k+ owner
    // dirs. (Explicit `roots` callers below keep their deterministic scan.)
    if (!opts.roots) {
      const globalHit = await scan(defaultClaudeProjectsRoot());
      if (globalHit) {
        transcriptPathCache.set(sessionId, globalHit);
        return globalHit;
      }
      if (useResolutionCaches) rememberTranscriptMiss(sessionId, now);
      return null;
    }
  }

  // FALLBACK: the full sweep (global + every isolation root) — correct but O(roots).
  // The default path uses the TTL-cached roots so a hot miss can't re-readdir 12k+ dirs
  // every call (the compaction-watchdog churn fix).
  for (const root of opts.roots ?? (await defaultProjectsRootsCached(now))) {
    const hit = await scan(root);
    if (hit) {
      transcriptPathCache.set(sessionId, hit);
      return hit;
    }
  }
  // Genuine miss → remember it briefly so a hot caller polling for a dead/not-yet-written
  // session doesn't re-sweep every isolation root on every tick.
  if (useResolutionCaches) rememberTranscriptMiss(sessionId, now);
  return null;
}

/**
 * P-016 fallback resolver: the newest `*.jsonl` under this owner's isolation root
 * `<base>/<owner>/projects/<cwd>/` (excluding the `history.jsonl` shell log).
 *
 * Covers the gap `findSessionTranscript`'s exact-id lookup CANNOT: the `session_id`
 * recorded in adv_sessions goes STALE when a resume mints a fresh Claude UUID (so
 * `<sessionId>.jsonl` no longer exists though a live transcript does), and some launch
 * cohorts write a `<sessionId>/` directory rather than a flat file. When the exact-id
 * lookup misses, the newest jsonl under the owner root is the session's CURRENT
 * transcript regardless of its UUID. Best-effort single-owner-dir scan (cheap — one
 * readdir per project dir, never the 12k-owner sweep): null on any error.
 *
 * (Lives here, beside findSessionTranscript, as the transcript-resolution primitive;
 * compaction-usage.ts re-exports it for its context-estimate fallback. Originally
 * P-016 in compaction-usage — moved 2026-07-04 so the agents-roster live-thinking
 * pane + stream can share the SAME robustness, WI-2680.)
 */
export function newestTranscriptUnderOwner(
  ownerId: string,
  isolationBase: string = papercuspSessionClaudeBase(),
): string | null {
  // Guard the path join — owner ids are our own UUIDs, but never escape the root.
  if (!ownerId || ownerId.includes('/') || ownerId.includes('..')) return null;
  try {
    const projectsRoot = join(isolationBase, ownerId, 'projects');
    let best: { p: string; mtimeMs: number } | null = null;
    for (const projDir of readdirSync(projectsRoot)) {
      const dir = join(projectsRoot, projDir);
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue; // not a dir / unreadable
      }
      for (const name of entries) {
        if (!name.endsWith('.jsonl') || name === 'history.jsonl') continue;
        const p = join(dir, name);
        try {
          const st = statSync(p);
          if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { p, mtimeMs: st.mtimeMs };
        } catch {
          /* vanished mid-scan */
        }
      }
    }
    return best?.p ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve an INTERACTIVE claude session's transcript with the P-016 fallback:
 * the exact recorded `session_id` → `<sessionId>.jsonl` FIRST, and — only on a miss,
 * when the coord `owner` is known — the newest jsonl under that owner's isolation
 * root. This is what the live-thinking pane/stream + the roster's `thinking` flag
 * should use so a session that RESUMED (fresh uuid ⇒ stale recorded id) still shows
 * its current transcript instead of an empty pane (WI-2680). Callers WITHOUT an owner
 * hint (or non-claude backends) get the plain exact-id resolution.
 */
export async function resolveInteractiveTranscript(
  sessionId: string,
  opts: { owner?: string | null; roots?: string[]; isolationBase?: string; nowMs?: number } = {},
): Promise<string | null> {
  const exact = await findSessionTranscript(sessionId, {
    owner: opts.owner,
    roots: opts.roots,
    isolationBase: opts.isolationBase,
    nowMs: opts.nowMs,
  });
  if (exact) return exact;
  if (opts.owner) return newestTranscriptUnderOwner(opts.owner, opts.isolationBase);
  return null;
}

/** A session reads as "actively thinking" if its transcript was appended within
 *  this window. It's the best available proxy — the transcript writes COMPLETE
 *  records (no token-level signal), so a long model generation between writes can
 *  briefly read as idle. Shared by the roster indicator + the live thinking pane
 *  so both agree. */
export const SESSION_THINKING_ACTIVE_MS = 10_000;

/**
 * Whether an interactive session appears to be actively thinking right now — its
 * transcript jsonl was appended within {@link SESSION_THINKING_ACTIVE_MS}. Takes
 * the coord `owner` hint so the transcript resolves via the fast path. Fail-soft
 * false (no transcript / stat error ⇒ not thinking). `nowMs` is injectable for tests.
 */
export async function isSessionThinking(
  sessionId: string,
  opts: { owner?: string | null; nowMs?: number; roots?: string[]; isolationBase?: string } = {},
): Promise<boolean> {
  return (await resolveSessionThinkingState(sessionId, opts)).thinking;
}

/**
 * Resolve an interactive claude session's transcript ONCE and derive BOTH the roster
 * signals the agents-roster needs: `resolvable` (a transcript actually exists to
 * stream — the "Live thinking" affordance should be OFFERED only when true, else the
 * pane opens empty) and `thinking` (that transcript was appended within
 * {@link SESSION_THINKING_ACTIVE_MS}). Uses the P-016 fallback so a resumed session
 * (stale recorded id) still resolves its current transcript. Fail-soft
 * `{ resolvable:false, thinking:false }`. Single resolve so the roster's per-agent
 * cost stays one stat, not two. (WI-2680.)
 */
export async function resolveSessionThinkingState(
  sessionId: string,
  opts: { owner?: string | null; nowMs?: number; roots?: string[]; isolationBase?: string } = {},
): Promise<{ resolvable: boolean; thinking: boolean }> {
  const path = await resolveInteractiveTranscript(sessionId, {
    owner: opts.owner,
    roots: opts.roots,
    isolationBase: opts.isolationBase,
    nowMs: opts.nowMs,
  });
  if (!path) return { resolvable: false, thinking: false };
  try {
    const st = await fs.stat(path);
    return { resolvable: true, thinking: (opts.nowMs ?? Date.now()) - st.mtimeMs < SESSION_THINKING_ACTIVE_MS };
  } catch {
    return { resolvable: false, thinking: false };
  }
}

/**
 * Decode a Claude project dir name to a cwd hint. Claude encodes the cwd by
 * replacing '/' with '-', which is NOT invertible when a real path segment
 * contains a dash — so this is a FALLBACK hint only; prefer the `cwd` read from a
 * record (extractCwdFromHead).
 */
export function decodeProjectDir(name: string): string {
  return name.replace(/-/g, '/');
}

/** Pull the first `"cwd":"…"` out of a head chunk without a full JSON parse. */
export function extractCwdFromHead(head: string): string | null {
  const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1];
  }
}

interface TranscriptRecord {
  type?: string;
  cwd?: string;
  sessionId?: string;
  timestamp?: string;
  gitBranch?: string;
  message?: { role?: string; content?: unknown };
}

/** Extract plain text from a parsed record's message content (string or block array). */
export function recordText(rec: TranscriptRecord | null | undefined): string {
  const c = rec?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => (b && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** A trimmed snippet around the first case-insensitive match of `query` in `text`. */
export function firstMatchSnippet(text: string, query: string, radius = 90): { index: number; snippet: string } | null {
  if (!query) return null;
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return null;
  const start = Math.max(0, i - radius);
  const end = Math.min(text.length, i + query.length + radius);
  const snippet =
    (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
  return { index: i, snippet };
}

export interface ClaudeSessionMeta {
  sessionId: string;
  filePath: string;
  cwd: string | null;
  lastActivityMs: number; // file mtime — the reliable recency signal
  sizeBytes: number;
}

const HEAD_BYTES = 32_768;

async function readHead(filePath: string, bytes = HEAD_BYTES): Promise<string> {
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

async function listJsonlFiles(root: string): Promise<{ dir: string; filePath: string }[]> {
  let dirs: string[];
  try {
    dirs = await fs.readdir(root);
  } catch {
    return [];
  }
  const out: { dir: string; filePath: string }[] = [];
  for (const d of dirs) {
    const full = join(root, d);
    try {
      const st = await fs.stat(full);
      if (!st.isDirectory()) continue;
      for (const f of await fs.readdir(full)) {
        if (f.endsWith('.jsonl')) out.push({ dir: d, filePath: join(full, f) });
      }
    } catch {
      // unreadable dir — skip, never fail the whole scan
    }
  }
  return out;
}

async function metaForFile(dir: string, filePath: string): Promise<ClaudeSessionMeta | null> {
  try {
    const st = await fs.stat(filePath);
    const head = await readHead(filePath).catch(() => '');
    const cwd = extractCwdFromHead(head) ?? (dir ? decodeProjectDir(dir) : null);
    return {
      sessionId: basename(filePath).replace(/\.jsonl$/, ''),
      filePath,
      cwd,
      lastActivityMs: st.mtimeMs,
      sizeBytes: st.size,
    };
  } catch {
    return null;
  }
}

/** All session metas under `root`, newest-first, optionally filtered by cwd substring. */
export async function allClaudeSessionMetas(opts: { root?: string; roots?: string[]; cwd?: string } = {}): Promise<ClaudeSessionMeta[]> {
  // Explicit roots/root win (tests); otherwise scan global + per-session isolation roots.
  const scanRoots = opts.roots ?? (opts.root ? [opts.root] : await claudeProjectsRoots());
  const fileLists = await Promise.all(scanRoots.map((r) => listJsonlFiles(r)));
  const files = fileLists.flat();
  const metas = (await Promise.all(files.map((f) => metaForFile(f.dir, f.filePath)))).filter(
    (m): m is ClaudeSessionMeta => m != null,
  );
  let rows = metas;
  if (opts.cwd) {
    const needle = opts.cwd.toLowerCase();
    rows = rows.filter((m) => (m.cwd ?? '').toLowerCase().includes(needle));
  }
  rows.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  return rows;
}

/** List sessions newest-first (bounded). The reliable "which session for project X around date Y" read. */
export async function listClaudeSessions(opts: { root?: string; roots?: string[]; cwd?: string; limit?: number } = {}): Promise<{
  sessions: ClaudeSessionMeta[];
  total: number;
  truncated: boolean;
}> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200);
  const all = await allClaudeSessionMetas(opts);
  return { sessions: all.slice(0, limit), total: all.length, truncated: all.length > limit };
}

export interface ClaudeSessionMatch extends ClaudeSessionMeta {
  matchCount: number;
  snippet: string;
  /** EI-12890: true when this file is LARGER than perFileMaxBytes, so the scan
   *  covered only part of it — a "no match" on a file NOT in this list is
   *  authoritative; on a file that IS, it is not (some bytes went unscanned). */
  byteCapped: boolean;
}

interface ReadUpToResult {
  text: string;
  /** file size in bytes exceeded maxBytes — some of the file was NOT scanned. */
  truncated: boolean;
  fileSizeBytes: number;
  bytesRead: number;
}

/**
 * Bounded read of a (possibly huge) JSONL transcript. Reads the TAIL, not the
 * head: transcripts are append logs, so the most recent turns — the ones a
 * caller chasing "the un-indexed pre-window tail" (per the tool's own
 * guidance) actually wants — sit at the END of the file. A head-read on a
 * file far larger than maxBytes silently scans only the oldest slice and
 * misses everything recent (EI-12890: a 187MB session capped at 5MB read only
 * its earliest 2.7%, right past the turn a provenance check needed).
 */
async function readUpTo(filePath: string, maxBytes: number): Promise<ReadUpToResult> {
  const stat = await fs.stat(filePath);
  const fileSizeBytes = stat.size;
  if (fileSizeBytes <= maxBytes) {
    const text = await fs.readFile(filePath, 'utf8');
    return { text, truncated: false, fileSizeBytes, bytesRead: fileSizeBytes };
  }
  const fh = await fs.open(filePath, 'r');
  try {
    const start = fileSizeBytes - maxBytes;
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, start);
    return { text: buf.subarray(0, bytesRead).toString('utf8'), truncated: true, fileSizeBytes, bytesRead };
  } finally {
    await fh.close();
  }
}

/** Bounded content search across transcripts. Lossy by nature — see the module note. */
export async function searchClaudeSessions(opts: {
  root?: string;
  roots?: string[];
  query: string;
  cwd?: string;
  limit?: number;
  maxFilesScanned?: number;
  perFileMaxBytes?: number;
}): Promise<{
  matches: ClaudeSessionMatch[];
  filesScanned: number;
  filesTotal: number;
  truncated: boolean;
  /** EI-12890: files that were byte-capped (only part scanned) — a "no match"
   *  verdict is NOT authoritative for any sessionId listed here. */
  filesByteCapped: string[];
}> {
  const query = opts.query.trim();
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const maxFiles = Math.min(Math.max(opts.maxFilesScanned ?? 400, 1), 2000);
  const perFileMaxBytes = Math.min(Math.max(opts.perFileMaxBytes ?? 1_000_000, 1024), 5_000_000);
  if (!query) return { matches: [], filesScanned: 0, filesTotal: 0, truncated: false, filesByteCapped: [] };

  const all = await allClaudeSessionMetas({ ...(opts.root ? { root: opts.root } : {}), ...(opts.roots ? { roots: opts.roots } : {}), ...(opts.cwd ? { cwd: opts.cwd } : {}) });
  const candidates = all.slice(0, maxFiles); // newest-first, so a scan cap keeps the most-relevant
  const q = query.toLowerCase();
  const matches: ClaudeSessionMatch[] = [];
  const filesByteCapped: string[] = [];

  for (const meta of candidates) {
    let read: ReadUpToResult;
    try {
      read = await readUpTo(meta.filePath, perFileMaxBytes);
    } catch {
      continue;
    }
    if (read.truncated) filesByteCapped.push(meta.sessionId);
    const content = read.text;
    const lc = content.toLowerCase();
    let count = 0;
    let idx = lc.indexOf(q);
    while (idx >= 0) {
      count++;
      idx = lc.indexOf(q, idx + q.length);
    }
    if (count === 0) continue;
    // A clean snippet from the first matching record's text, falling back to raw.
    let snippet = '';
    for (const line of content.split('\n')) {
      if (!line.toLowerCase().includes(q)) continue;
      try {
        const s = firstMatchSnippet(recordText(JSON.parse(line) as TranscriptRecord), query);
        if (s) {
          snippet = s.snippet;
          break;
        }
      } catch {
        // not JSON / no text — keep scanning lines
      }
    }
    if (!snippet) snippet = firstMatchSnippet(content, query)?.snippet ?? '';
    matches.push({ ...meta, matchCount: count, snippet, byteCapped: read.truncated });
  }

  matches.sort((a, b) => b.matchCount - a.matchCount || b.lastActivityMs - a.lastActivityMs);
  return {
    matches: matches.slice(0, limit),
    filesScanned: candidates.length,
    filesTotal: all.length,
    truncated: matches.length > limit || all.length > candidates.length || filesByteCapped.length > 0,
    filesByteCapped,
  };
}

export interface ClaudeTurn {
  i: number;
  type: string;
  role: string | null;
  ts: string | null;
  text: string;
}

/** Read one session into a compact, bounded turn list (the most-recent `limit` turns). */
export async function readClaudeSession(opts: { filePath: string; limit?: number }): Promise<{
  sessionId: string;
  cwd: string | null;
  gitBranch: string | null;
  firstTs: string | null;
  lastTs: string | null;
  totalRecords: number;
  turns: ClaudeTurn[];
  truncated: boolean;
} | null> {
  let raw: string;
  try {
    raw = await fs.readFile(opts.filePath, 'utf8');
  } catch {
    return null;
  }
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000);
  const lines = raw.split('\n').filter(Boolean);
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  const turns: ClaudeTurn[] = [];
  let i = 0;
  for (const ln of lines) {
    let rec: TranscriptRecord;
    try {
      rec = JSON.parse(ln) as TranscriptRecord;
    } catch {
      continue;
    }
    if (rec.cwd && !cwd) cwd = rec.cwd;
    if (rec.gitBranch && !gitBranch) gitBranch = rec.gitBranch;
    if (rec.timestamp) {
      if (!firstTs) firstTs = rec.timestamp;
      lastTs = rec.timestamp;
    }
    if (rec.type === 'user' || rec.type === 'assistant') {
      const text = recordText(rec);
      turns.push({
        i: i++,
        type: rec.type,
        role: rec.message?.role ?? null,
        ts: rec.timestamp ?? null,
        text: text.length > 2000 ? `${text.slice(0, 2000)}…` : text,
      });
    }
  }
  const truncated = turns.length > limit;
  return {
    sessionId: basename(opts.filePath).replace(/\.jsonl$/, ''),
    cwd,
    gitBranch,
    firstTs,
    lastTs,
    totalRecords: lines.length,
    turns: truncated ? turns.slice(-limit) : turns,
    truncated,
  };
}
