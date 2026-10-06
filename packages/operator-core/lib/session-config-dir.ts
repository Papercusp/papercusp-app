/**
 * session-config-dir.ts — WI-38349.
 *
 * WHERE a psu Claude session's `CLAUDE_CONFIG_DIR` ACTUALLY IS — as opposed to
 * where the conventional formula says it should be.
 *
 * `sessionClaudeConfigDir(ownerId)` is the formula every LAUNCH path is supposed
 * to key by, and on the interactive console path it is exactly right. It is not
 * right everywhere: the orchestrator/hive path keys the dir by the minted SPAWN
 * id (`invoke.ts` → `sessionClaudeConfigDir(trackedSessionSpawnId)`), and a
 * carry-respawn keeps the ORIGINAL dir while the coord owner id stays its own
 * value. Measured live on su-e318aa48 (twice, two incarnations):
 *
 *   PAPERCUSP_SID=su-e318aa48-…      # == the coord owner id — correct
 *   CLAUDE_CONFIG_DIR=…/session-claude/su-4c40b9b3-…   # a DIFFERENT key
 *
 * `…/session-claude/su-e318aa48-…/` has never existed. 78 of 98 owner ids active
 * in a 6h window had no directory at that path, while 30 live claude processes
 * held a perfectly good `CLAUDE_CONFIG_DIR` under another key.
 *
 * WHY THIS MODULE RATHER THAN "FIX THE FORMULA": the formula is not fixable from
 * the outside — several launch paths legitimately key the dir by different ids,
 * and the conventional path is still correct for the console path. What a READER
 * needs is not a better guess but an OBSERVATION, plus an honest "I could not
 * tell" when no observation is available. A reader that assumes the formula and
 * finds nothing concludes the session is DE-ENROLLED — a confident false alarm on
 * the healthy majority (WI-38349). An alarm that fires on the healthy majority is
 * how a real de-enrollment stops being believed.
 *
 * So every strategy here either OBSERVES the dir or declines:
 *   1. `live-process`   — the `CLAUDE_CONFIG_DIR` of the session's own running
 *                         `claude` process. Ground truth: it is the value the
 *                         process is actually reading. ~0.3ms from a pid hint.
 *   2. `transcript-scan`— the one session-claude dir holding `<sessionId>.jsonl`.
 *                         Works for an ENDED session, where no process remains.
 *   3. `conventional`   — `sessionClaudeConfigDir(ownerId)`, and ONLY when it
 *                         exists on disk. Deliberately LAST: a phantom directory
 *                         materialized by an earlier repair-to-the-wrong-path
 *                         exists but is read by nothing, so an observation of a
 *                         live process must be allowed to win over it.
 *
 * When all three decline the answer is `dir: null` with a reason — never a path
 * the caller can go on to diagnose as broken.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sessionClaudeRoot } from '@papercusp/orchestrator/session-launch-dirs';

/** How a config dir was located. Every value denotes an OBSERVATION, not a guess. */
export type SessionConfigDirSource = 'live-process' | 'transcript-scan' | 'conventional';

export interface SessionConfigDirResolution {
  /** The resolved directory, or null when no strategy could observe one. */
  dir: string | null;
  /** Which strategy produced `dir`; null exactly when `dir` is null. */
  source: SessionConfigDirSource | null;
  /** Every strategy that ran, with its outcome — the audit trail behind the verdict. */
  tried: string[];
  /** Why resolution failed. Non-null exactly when `dir` is null. */
  unresolvedReason: string | null;
}

export interface ResolveSessionConfigDirOptions {
  /** The session's coord owner id (`PAPERCUSP_SID` / `adv_sessions.coord_owner_id`). */
  ownerId: string;
  /** Home dir override (tests). Omitted ⇒ the real root, honouring PAPERCUSP_SESSION_CLAUDE_DIR. */
  home?: string;
  /**
   * A pid that IS the session's `claude` process, or its PARENT — `coord_presence.pid`
   * records the psu-launcher, whose single child is the claude CLI. Cheapest and most
   * authoritative strategy; without it the live process is simply not consulted.
   */
  pidHint?: number | null;
  /** The claude native session id — the `transcript-scan` key. */
  sessionId?: string | null;
  /**
   * WI-38369: ADDITIONAL keys the `conventional` strategy may try, after `ownerId`.
   * `ownerId` is load-bearing for the live-process guard (it must equal the process's
   * `PAPERCUSP_SID`), but it is NOT always the key the dir is named by: the
   * orchestrator/hive path names it after the minted SPAWN id
   * (`invoke.ts` → `sessionClaudeConfigDir(trackedSessionSpawnId)`), so a spawned
   * agent's two identities differ and only one of them is a directory name.
   *
   * This stays an OBSERVATION, not a second formula: a key is accepted only when the
   * directory it names actually EXISTS, so adding keys can turn an unresolved answer
   * into a resolved one but can never invent a path that was never there.
   */
  altOwnerIds?: (string | null | undefined)[];
  /** Injectable `/proc` root (tests). */
  procRoot?: string;
}

/**
 * The session-claude isolation root. With no `home` override this is the shared
 * helper (so a `PAPERCUSP_SESSION_CLAUDE_DIR` testbed root is honoured exactly as
 * the launch paths honour it); with one, the conventional layout under that home.
 */
export function sessionClaudeRootFor(home?: string): string {
  return home === undefined ? sessionClaudeRoot() : join(home, '.papercusp', 'session-claude');
}

/** The conventional per-owner path — a FORMULA, true only on some launch paths. */
export function conventionalSessionConfigDir(ownerId: string, home?: string): string {
  return join(sessionClaudeRootFor(home), ownerId);
}

function readProcFile(procRoot: string, ...parts: string[]): string | null {
  try {
    return readFileSync(join(procRoot, ...parts), 'utf8');
  } catch {
    return null; // a pid that exited between listing and reading is normal, not an error
  }
}

/** One `KEY=value` out of a NUL-delimited /proc environ blob. */
function envValue(environ: string, key: string): string | null {
  for (const entry of environ.split('\0')) {
    if (entry.startsWith(`${key}=`)) return entry.slice(key.length + 1);
  }
  return null;
}

function claudeConfigDirOfPid(procRoot: string, pid: number, ownerId: string): string | null {
  if (readProcFile(procRoot, String(pid), 'comm')?.trim() !== 'claude') return null;
  const environ = readProcFile(procRoot, String(pid), 'environ');
  if (environ === null) return null;
  // Guard against a pid that has been recycled onto some OTHER session's claude:
  // the dir is only usable when the process agrees about whose session it is.
  const sid = envValue(environ, 'PAPERCUSP_SID');
  if (sid !== null && sid !== ownerId) return null;
  return envValue(environ, 'CLAUDE_CONFIG_DIR');
}

function childPids(procRoot: string, pid: number): number[] {
  const raw = readProcFile(procRoot, String(pid), 'task', String(pid), 'children');
  if (!raw) return [];
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * Strategy 1 — read `CLAUDE_CONFIG_DIR` off the live process. The hint may be the
 * claude process itself or its parent (coord_presence records the psu-launcher),
 * so we check the pid and then its direct children. One level is enough: the
 * launcher spawns claude directly, and a deeper walk would start reaching
 * unrelated descendants (a claude session's own tool subprocesses).
 */
function fromLiveProcess(procRoot: string, pid: number, ownerId: string): string | null {
  const own = claudeConfigDirOfPid(procRoot, pid, ownerId);
  if (own) return own;
  for (const child of childPids(procRoot, pid)) {
    const dir = claudeConfigDirOfPid(procRoot, child, ownerId);
    if (dir) return dir;
  }
  return null;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

interface TranscriptScanCacheEntry {
  dir: string;
  transcript: string;
}

/**
 * Transcript discovery is synchronous and runs once per active spawned row on
 * every roster read. The transcript path is stable after it is written, so a
 * validated positive hit can skip the recursive owner/project walk entirely.
 * The key includes the root because tests and multi-home callers can resolve
 * the same native session id against different trees.
 */
const transcriptScanCache = new Map<string, TranscriptScanCacheEntry>();

/**
 * A live session may not have written its first transcript yet. Keep that miss
 * short-lived so the normal roster cadence does not re-scan every owner on each
 * read, while a newly-created transcript becomes observable promptly.
 */
const transcriptScanMissCache = new Map<string, number>();
const TRANSCRIPT_SCAN_MISS_TTL_MS = 30_000;
const TRANSCRIPT_SCAN_CACHE_MAX = 20_000;

function transcriptScanCacheKey(root: string, sessionId: string): string {
  return `${root}\0${sessionId}`;
}

function rememberTranscriptScanHit(key: string, entry: TranscriptScanCacheEntry): void {
  if (!transcriptScanCache.has(key) && transcriptScanCache.size >= TRANSCRIPT_SCAN_CACHE_MAX) {
    const oldest = transcriptScanCache.keys().next().value;
    if (oldest !== undefined) transcriptScanCache.delete(oldest);
  }
  transcriptScanCache.set(key, entry);
}

function rememberTranscriptScanMiss(key: string, now: number): void {
  if (!transcriptScanMissCache.has(key) && transcriptScanMissCache.size >= TRANSCRIPT_SCAN_CACHE_MAX) {
    for (const [cachedKey, expiresAt] of transcriptScanMissCache) {
      if (expiresAt <= now) transcriptScanMissCache.delete(cachedKey);
    }
    if (transcriptScanMissCache.size >= TRANSCRIPT_SCAN_CACHE_MAX) {
      const oldest = transcriptScanMissCache.keys().next().value;
      if (oldest !== undefined) transcriptScanMissCache.delete(oldest);
    }
  }
  transcriptScanMissCache.set(key, now + TRANSCRIPT_SCAN_MISS_TTL_MS);
}

/** Test seam: clear the module-scoped transcript discovery caches. */
export function __resetSessionConfigDirCaches(): void {
  transcriptScanCache.clear();
  transcriptScanMissCache.clear();
}

/**
 * Strategy 2 — the session-claude dir whose `projects/**` holds this session's
 * transcript. The same discovery psu-launcher's `findUntrackedSession` already
 * does for a resume, and the only strategy that still works once the process is
 * gone. Measured at ~1ms across the live root.
 */
function fromTranscriptScan(root: string, sessionId: string, preferOwners: readonly string[] = []): string | null {
  const now = Date.now();
  // The preferred owners are part of the key: the answer depends on them.
  const cacheKey = transcriptScanCacheKey(root, `${sessionId}\0${preferOwners.join(',')}`);
  const cached = transcriptScanCache.get(cacheKey);
  if (cached) {
    // A cleanup/rotation may remove the file after a positive lookup. Re-scan
    // in that case so the cache can never pin a dead config directory.
    if (existsSync(cached.transcript)) return cached.dir;
    transcriptScanCache.delete(cacheKey);
  }

  const missUntil = transcriptScanMissCache.get(cacheKey);
  if (missUntil !== undefined) {
    if (now < missUntil) return null;
    transcriptScanMissCache.delete(cacheKey);
  }

  const file = `${sessionId}.jsonl`;
  // WI-10004654: the same `<id>.jsonl` can sit under several owner dirs — a
  // managed fork seeds its own config dir with a copy of its source's
  // transcript. A first-hit scan in readdir order can then name the FORK's dir
  // as this session's config dir. Check the owners the caller expects first;
  // the full scan stays the fallback for a session whose dir is keyed elsewhere.
  for (const owner of [...preferOwners, ...safeReaddir(root)]) {
    const projects = join(root, owner, 'projects');
    for (const project of safeReaddir(projects)) {
      const transcript = join(projects, project, file);
      if (existsSync(transcript)) {
        const dir = join(root, owner);
        transcriptScanMissCache.delete(cacheKey);
        rememberTranscriptScanHit(cacheKey, { dir, transcript });
        return dir;
      }
    }
  }
  rememberTranscriptScanMiss(cacheKey, now);
  return null;
}

/**
 * Locate the directory a session's Claude config documents ACTUALLY live in.
 *
 * Strategies run cheapest-and-most-authoritative first and each records its
 * outcome in `tried`. A null `dir` is a first-class answer meaning "not
 * determinable" — callers must render it as UNKNOWN and must never fall back to
 * the conventional path, which is the assumption that produced WI-38349.
 */
export function resolveSessionConfigDir(opts: ResolveSessionConfigDirOptions): SessionConfigDirResolution {
  const { ownerId, home, pidHint, sessionId, procRoot = '/proc' } = opts;
  const root = sessionClaudeRootFor(home);
  const tried: string[] = [];

  if (pidHint != null && Number.isInteger(pidHint) && pidHint > 0) {
    const dir = fromLiveProcess(procRoot, pidHint, ownerId);
    tried.push(dir ? `live-process(pid ${pidHint}): ${dir}` : `live-process(pid ${pidHint}): no claude process`);
    if (dir) return { dir, source: 'live-process', tried, unresolvedReason: null };
  } else {
    tried.push('live-process: skipped (no pid hint)');
  }

  if (sessionId) {
    const preferOwners = [ownerId, ...(opts.altOwnerIds ?? [])].filter(
      (k): k is string => typeof k === 'string' && k.length > 0 && !k.includes('/') && k !== '.' && k !== '..',
    );
    const dir = fromTranscriptScan(root, sessionId, preferOwners);
    tried.push(dir ? `transcript-scan(${sessionId}): ${dir}` : `transcript-scan(${sessionId}): no transcript found`);
    if (dir) return { dir, source: 'transcript-scan', tried, unresolvedReason: null };
  } else {
    tried.push('transcript-scan: skipped (no session id)');
  }

  // WI-38369: `ownerId` first (the common case), then any alternate key the caller
  // knows the dir may be named by — e.g. a spawned agent's spawn id. Each is accepted
  // only if it EXISTS, so this widens what can be OBSERVED without widening what can
  // be ASSUMED.
  const conventionalKeys = [ownerId, ...(opts.altOwnerIds ?? [])].filter(
    (k): k is string => typeof k === 'string' && k.length > 0,
  );
  for (const key of new Set(conventionalKeys)) {
    const conventional = join(root, key);
    if (existsSync(conventional)) {
      tried.push(`conventional(${key}): ${conventional}`);
      return { dir: conventional, source: 'conventional', tried, unresolvedReason: null };
    }
    tried.push(`conventional(${key}): ${conventional} does not exist`);
  }

  return {
    dir: null,
    source: null,
    tried,
    unresolvedReason:
      `no observable config dir for ${ownerId} — the live process was not found, no transcript names it, ` +
      `and no conventional path exists for ${conventionalKeys.map((k) => `'${k}'`).join(' / ')}. This is NOT ` +
      `evidence of de-enrollment: on several launch paths the dir is keyed by the spawn id rather than the ` +
      `coord owner id (WI-38349).`,
  };
}
