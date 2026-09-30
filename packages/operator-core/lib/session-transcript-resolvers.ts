/**
 * session-transcript-resolvers — locate the on-disk transcript file for a
 * CODEX or OMP session, the non-claude legs of the agents-roster thinking pane
 * (claude resolution lives in claude-sessions.ts `findSessionTranscript`).
 *
 * Both resolvers are cheap bounded walks (a handful of readdirs, never an
 * all-owners sweep) and cache POSITIVE resolutions. Misses are NOT cached: the
 * thinking endpoint polls for a not-yet-written transcript (a live session
 * pre-first-turn) and must see it the moment it appears.
 *
 * ⚠ The cache's validity rule DIFFERS BY WHAT THE KEY NAMES, and conflating the two
 * is what caused EI-20219088862022620 (see CODEX_KEY_CACHE_TTL_MS below):
 *   - a key naming ONE FILE (a rollout uuid, an omp thread id) — "stable once
 *     written" holds, so an existence re-stat is a sufficient guard;
 *   - a key naming a DIRECTORY TO SEARCH (`findCodexRolloutPath`'s adv-session id →
 *     "the newest rollout in this CODEX_HOME") — the right answer MOVES to a new
 *     file on every carry-respawn while the old one lives on, so existence proves
 *     nothing and the entry must also expire.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { codexHomeForSessionKey } from '@papercusp/orchestrator/session-launch-dirs';

/**
 * OMP transcript root. Tracked psu sessions isolate PI_CODING_AGENT_DIR under
 * `~/.papercusp/su-omp-homes/session-<adv id>/agent`; only untracked OMP
 * sessions use the shared `~/.omp/agent` home. Kept lazy because `homedir()` at
 * module scope breaks the vite renderer stub.
 */
export function ompSessionsRootForSessionKey(
  sessionKey?: string | number,
  home: string = homedir(),
): string {
  return join(ompAgentHomeForSessionKey(sessionKey, home), 'sessions');
}

/**
 * The OMP agent home that owns one session's transcript/config state.
 *
 * Keep this path paired with {@link ompSessionsRootForSessionKey}: native
 * session handles need the AGENT HOME while transcript readers need its
 * `sessions` child. Before this helper existed the handle reconstructed the
 * shared `~/.omp/agent` path while the resolver correctly searched the tracked
 * per-session home, so one runtime carried two contradictory roots.
 */
export function ompAgentHomeForSessionKey(
  sessionKey?: string | number,
  home: string = homedir(),
): string {
  return sessionKey == null
    ? join(home, '.omp', 'agent')
    : join(ompSessionHomesRoot(home), `session-${sessionKey}`, 'agent');
}

/**
 * The container of every PER-SESSION omp home — `<here>/session-<advId>/agent/sessions/…`
 * (WI-41496).
 *
 * Exported because two layers must agree on it and did not: the search corpus
 * already walks this root (session-ingest's omp adapter, added by
 * EI-20212281439039808 with the note "this pair must not drift again"), while
 * this module — the LIVE transcript resolver the HUD conversation popup streams
 * through — only ever looked in the shared `~/.omp` home. A psu-launched omp
 * agent never writes there, so its popup was permanently empty: measured live,
 * a 25 KB transcript on disk and `backfill: []` on the wire.
 */
export function ompSessionHomesRoot(home: string = homedir()): string {
  return process.env.PAPERCUSP_SU_OMP_HOMES_DIR || join(home, '.papercusp', 'su-omp-homes');
}

interface CachedPath {
  path: string;
  /** When this resolution was computed — checked against {@link CODEX_KEY_CACHE_TTL_MS}. */
  at: number;
}

const codexPathCache = new Map<string, CachedPath>();
const ompPathCache = new Map<string, CachedPath>();

/**
 * WI-41496 — how long a FAILED per-session-home sweep suppresses the next one
 * for the same thread id.
 *
 * Misses are deliberately never cached in this module (a live session's file
 * appears mid-poll and must be seen at once), and that rule is right for the
 * cheap single-root walks. The all-homes fallback is a different cost class —
 * one readdir per per-session home — and the thinking route re-resolves every
 * second while a pane is open on a session with no file yet. Short enough that
 * a transcript appearing is picked up within a couple of ticks, long enough
 * that N open panes cannot turn into a readdir storm.
 */
export const OMP_HOME_SWEEP_COOLDOWN_MS = 5_000;
const ompHomeSweepCooldown = new Map<string, number>();

/**
 * EI-20219088862022620 / WI-38090 — how long a PER-HOME ("newest rollout in this
 * CODEX_HOME") resolution may be reused before it is re-walked.
 *
 * The module header's premise — "a transcript path is stable once written" — is true
 * for a key that names a FILE (a claude session_id, a rollout uuid) and FALSE for a key
 * that names a DIRECTORY to search. `findCodexRolloutPath` is keyed by the adv-session
 * id, which is STABLE ACROSS CARRY-RESPAWNS (a respawn reuses the same adv row and the
 * same per-session CODEX_HOME) while the rollout FILE it must resolve to changes on
 * every respawn. The old guard re-stat'd only the cached path, and since rollouts are
 * never deleted that stat always succeeded — so the first resolution was pinned for the
 * life of the process and every later generation was invisible.
 *
 * The damage was not a stale display: the compaction watchdog estimates context from
 * this path, so after one carry-respawn it read a DEAD predecessor's frozen rollout as
 * the live successor's usage. `coord_presence.context_tokens` froze at the dead value
 * while `context_estimated_at` kept refreshing (a stale VALUE wearing a fresh
 * TIMESTAMP), the watchdog cut live successors sitting at ~66k real tokens, and because
 * the frozen number could never fall below the limit the WI-5075 respawn-streak guard
 * concluded "the estimate never drops" and permanently suppressed BOTH enforcement
 * rungs — leaving the real session to run unmonitored into "Prompt is too long".
 * 48 sessions were reported over their ceiling, one at 2.7× its true usage.
 *
 * A TTL rather than no cache at all: the resolvers are called several times for the
 * same owner within one watchdog sweep (estimate, window, carry-spec build) and by the
 * roster's thinking poll, which is what the cache exists to collapse. 10s is far below
 * the 2-minute sweep, so every sweep re-resolves, and it matches
 * `isCodexSessionThinking`'s own `activeMs` window.
 */
const CODEX_KEY_CACHE_TTL_MS = 10_000;

/**
 * WI-6794: the cache key MUST carry the ROOT that was searched, not just the
 * session id. Every resolver here takes a home/root override, so keying by id
 * alone serves one home's answer to a caller that asked about another — and
 * the staleness guard cannot catch it, because it only re-stats the cached
 * path, which still exists under the wrong root. Caught by WI-6581's live
 * probe, where a homeOverride hit made a later default lookup report a file
 * that is not in the default home at all.
 */
function pathCacheKey(kind: string, id: string | number, root: string): string {
  return `${kind}::${id}::${root}`;
}

/** Test seam. */
export function __resetTranscriptResolverCaches(): void {
  codexPathCache.clear();
  ompPathCache.clear();
  ompHomeSweepCooldown.clear();
}

async function statMtime(p: string): Promise<number | null> {
  try {
    return (await fs.stat(p)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The NEWEST codex rollout jsonl for a tracked codex session — codex keys its
 * per-session CODEX_HOME by the adv-session row id and writes rollouts at
 * `<home>/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<uuid>.jsonl`. Newest-by-mtime
 * because a resumed session may add a second rollout file. Null until codex
 * takes its first turn (no sessions dir yet).
 */
export async function findCodexRolloutPath(
  sessionKey: string | number,
  opts: { homeOverride?: string; nowMs?: number } = {},
): Promise<string | null> {
  const now = opts.nowMs ?? Date.now();
  const root = join(opts.homeOverride ?? codexHomeForSessionKey(sessionKey), 'sessions');
  const cacheKey = pathCacheKey('codex-key', sessionKey, root);
  const cached = codexPathCache.get(cacheKey);
  if (cached) {
    // The path must still EXIST *and* the resolution must still be FRESH: this key names
    // a home to search, not a file, so a carry-respawn silently changes the right answer
    // while the cached file lives on forever (CODEX_KEY_CACHE_TTL_MS).
    if (now - cached.at < CODEX_KEY_CACHE_TTL_MS && (await statMtime(cached.path)) !== null) {
      return cached.path;
    }
    codexPathCache.delete(cacheKey);
  }
  let best: { path: string; mtime: number } | null = null;
  // Bounded walk: sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl — one home, ≤4 levels.
  let years: string[];
  try {
    years = await fs.readdir(root);
  } catch {
    return null;
  }
  for (const y of years) {
    let months: string[];
    try {
      months = await fs.readdir(join(root, y));
    } catch {
      continue;
    }
    for (const m of months) {
      let days: string[];
      try {
        days = await fs.readdir(join(root, y, m));
      } catch {
        continue;
      }
      for (const d of days) {
        let files: string[];
        try {
          files = await fs.readdir(join(root, y, m, d));
        } catch {
          continue;
        }
        for (const f of files) {
          if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
          const p = join(root, y, m, d, f);
          const mtime = await statMtime(p);
          if (mtime !== null && (!best || mtime > best.mtime)) best = { path: p, mtime };
        }
      }
    }
  }
  if (best) codexPathCache.set(cacheKey, { path: best.path, at: now });
  return best?.path ?? null;
}

const CODEX_THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the native Codex thread id BEFORE its first rollout JSONL exists.
 *
 * Codex 0.151 creates `<CODEX_HOME>/thread-writer-locks/<thread-id>.lock`
 * during interactive startup, but does not create the rollout file until the
 * first owner turn is persisted. Requiring a rollout before PUI can attach
 * creates a deadlock: PUI needs an adapter to send that first turn, while the
 * adapter used to require the file that only that turn creates.
 *
 * This is deliberately a live-runtime bootstrap seam, not an exact-resume
 * claim. Callers still treat `rolloutPath === null` as "not durably
 * resumable yet"; the lock supplies only the stable native identity needed to
 * address the already-running process.
 */
export async function findCodexLiveThreadId(codexHome: string): Promise<string | null> {
  const root = join(codexHome, 'thread-writer-locks');
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }

  let newest: { id: string; mtime: number } | null = null;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.lock')) continue;
    const id = entry.name.slice(0, -'.lock'.length);
    if (!CODEX_THREAD_ID_RE.test(id)) continue;
    const mtime = await statMtime(join(root, entry.name));
    if (mtime !== null && (!newest || mtime > newest.mtime)) newest = { id, mtime };
  }
  return newest?.id ?? null;
}

/**
 * A codex rollout jsonl matched by its ROLLOUT UUID (the trailing uuid of
 * `rollout-<ts>-<uuid>.jsonl`) under the GLOBAL `~/.codex` home — the id the
 * session-turns transcript index keys codex turns by (session-ingest's codex
 * adapter), so a transcript-search hit can deep-link a codex session that has
 * no adv-session row key (agents-pill-inactive-search-2026-07-09 P-005).
 * Same bounded ≤4-level walk as findCodexRolloutPath; newest mtime wins when
 * the uuid somehow appears twice. Null when the rollout no longer exists.
 */
export async function findCodexRolloutPathByUuid(
  rolloutId: string,
  opts: { homeOverride?: string } = {},
): Promise<string | null> {
  if (!/^[0-9a-f][0-9a-f-]{7,}$/i.test(rolloutId)) return null;
  const root = join(opts.homeOverride ?? join(homedir(), '.codex'), 'sessions');
  const cacheKey = pathCacheKey('codex-uuid', rolloutId, root);
  const cached = codexPathCache.get(cacheKey);
  if (cached) {
    // No TTL here, deliberately: this key names ONE FILE by its uuid, so the correct
    // answer cannot change while that file exists — unlike the per-home key above,
    // whose answer moves to a new rollout on every carry-respawn (WI-38090).
    if ((await statMtime(cached.path)) !== null) return cached.path;
    codexPathCache.delete(cacheKey);
  }
  const wanted = `-${rolloutId.toLowerCase()}.jsonl`;
  let best: { path: string; mtime: number } | null = null;
  let years: string[];
  try {
    years = await fs.readdir(root);
  } catch {
    return null;
  }
  for (const y of years) {
    let months: string[];
    try { months = await fs.readdir(join(root, y)); } catch { continue; }
    for (const m of months) {
      let days: string[];
      try { days = await fs.readdir(join(root, y, m)); } catch { continue; }
      for (const d of days) {
        let files: string[];
        try { files = await fs.readdir(join(root, y, m, d)); } catch { continue; }
        for (const f of files) {
          if (!f.startsWith('rollout-') || !f.toLowerCase().endsWith(wanted)) continue;
          const p = join(root, y, m, d, f);
          const mtime = await statMtime(p);
          if (mtime !== null && (!best || mtime > best.mtime)) best = { path: p, mtime };
        }
      }
    }
  }
  if (best) codexPathCache.set(cacheKey, { path: best.path, at: Date.now() });
  return best?.path ?? null;
}

/**
 * "Actively thinking" proxies for the roster's pulsing indicator — the codex /
 * omp analogues of claude-sessions' isSessionThinking: the session's transcript
 * file was appended within `activeMs`. Best-effort; false when unresolvable.
 */
/**
 * BOTH signals the roster needs about a non-claude session, from ONE resolve
 * (WI-41497) — the codex/omp analogue of claude-sessions'
 * `resolveSessionThinkingState`:
 *
 *   - `resolvable` — a transcript EXISTS to stream. False is what routes the
 *     conversation popup to its "no live transcript … it has ended, or its
 *     transcript was rotated away" note, so it is a claim about the record, not
 *     a default to leave lying around: before this existed, adv-roster never
 *     assigned it on the codex/omp legs at all and every codex row inherited a
 *     verdict from the CLAUDE resolver, which of course could not find a codex
 *     rollout. 237 of 257 live codex agents were being told they had ended.
 *   - `thinking` — that transcript was appended within `activeMs`.
 *
 * Returned together because the callers want both and a second resolve would be
 * a second chance for the two to disagree about the same session.
 */
export interface TranscriptThinkingState {
  resolvable: boolean;
  thinking: boolean;
}

const UNRESOLVED: TranscriptThinkingState = { resolvable: false, thinking: false };

async function stateForPath(
  p: string | null,
  opts: { nowMs?: number; activeMs?: number },
): Promise<TranscriptThinkingState> {
  if (!p) return UNRESOLVED;
  const mtime = await statMtime(p);
  if (mtime === null) return UNRESOLVED;
  return {
    resolvable: true,
    thinking: (opts.nowMs ?? Date.now()) - mtime < (opts.activeMs ?? 10_000),
  };
}

export async function resolveCodexThinkingState(
  sessionKey: string | number,
  opts: { nowMs?: number; activeMs?: number; homeOverride?: string } = {},
): Promise<TranscriptThinkingState> {
  return stateForPath(
    await findCodexRolloutPath(sessionKey, { homeOverride: opts.homeOverride }),
    opts,
  );
}

export async function resolveOmpThinkingState(
  threadId: string,
  opts: { nowMs?: number; activeMs?: number; rootOverride?: string; sessionKey?: string | number } = {},
): Promise<TranscriptThinkingState> {
  return stateForPath(
    await findOmpSessionPath(threadId, {
      rootOverride: opts.rootOverride,
      sessionKey: opts.sessionKey,
    }),
    opts,
  );
}

/**
 * "Actively thinking" proxies for the roster's pulsing indicator — the codex /
 * omp analogues of claude-sessions' isSessionThinking: the session's transcript
 * file was appended within `activeMs`. Best-effort; false when unresolvable.
 *
 * Thin wrappers over the state resolvers above, so a caller that wants only the
 * freshness half reads the same probe rather than a parallel one.
 */
export async function isCodexSessionThinking(
  sessionKey: string | number,
  opts: { nowMs?: number; activeMs?: number; homeOverride?: string } = {},
): Promise<boolean> {
  return (await resolveCodexThinkingState(sessionKey, opts)).thinking;
}

export async function isOmpThreadThinking(
  threadId: string,
  opts: { nowMs?: number; activeMs?: number; rootOverride?: string; sessionKey?: string | number } = {},
): Promise<boolean> {
  return (await resolveOmpThinkingState(threadId, opts)).thinking;
}

/**
 * The omp session jsonl for a thread id — omp stores sessions as
 * `~/.omp/agent/sessions/<cwd-encoded>/<timestamp>_<session-id>.jsonl` and the
 * adv row's `omp_thread_id` IS that session id, so the file is found by suffix
 * across the (bounded, per-cwd) session dirs.
 */
export async function findOmpSessionPath(
  threadId: string,
  opts: { rootOverride?: string; sessionKey?: string | number; home?: string } = {},
): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{6,}$/.test(threadId)) return null;
  const home = opts.home ?? homedir();
  const root = opts.rootOverride ?? ompSessionsRootForSessionKey(opts.sessionKey, home);
  const cacheKey = pathCacheKey('omp', threadId, root);
  const cached = ompPathCache.get(cacheKey);
  if (cached) {
    // Existence-only, like the uuid leg: the key names ONE file (`_<threadId>.jsonl`).
    if ((await statMtime(cached.path)) !== null) return cached.path;
    ompPathCache.delete(cacheKey);
  }
  const hit = await searchOmpRoot(root, threadId);
  if (hit) {
    ompPathCache.set(cacheKey, { path: hit, at: Date.now() });
    return hit;
  }

  /* WI-41496 — the caller could not name the session's home, so search the
     per-session homes too.
     A caller that KNOWS the adv-session id (the roster's freshness probe, and
     now the stream route) passes `sessionKey` and lands in exactly one home
     above; this leg is for the callers that structurally cannot — an archive
     re-resolve, a transcript-search deep-link that carries only the thread id.
     Before it existed those callers searched the shared `~/.omp` home ONLY,
     where a psu-launched agent never writes, and reported the session as having
     no transcript at all.
     Bounded and cooled-down rather than free: the thinking route re-resolves on
     a 1 Hz tick while a session has no file yet, so an uncooled sweep of every
     home would be a readdir storm for each open pane. A hit is cached by the
     normal path cache above; a miss suppresses the sweep for
     OMP_HOME_SWEEP_COOLDOWN_MS. */
  if (opts.rootOverride || opts.sessionKey != null) return null;
  const homesRoot = ompSessionHomesRoot(home);
  const now = Date.now();
  const cooledAt = ompHomeSweepCooldown.get(threadId);
  if (cooledAt !== undefined && now - cooledAt < OMP_HOME_SWEEP_COOLDOWN_MS) return null;
  let homes: string[];
  try {
    homes = await fs.readdir(homesRoot);
  } catch {
    ompHomeSweepCooldown.set(threadId, now);
    return null;
  }
  for (const dir of homes) {
    const sessionsRoot = join(homesRoot, dir, 'agent', 'sessions');
    const p = await searchOmpRoot(sessionsRoot, threadId);
    if (p) {
      ompPathCache.set(cacheKey, { path: p, at: Date.now() });
      ompHomeSweepCooldown.delete(threadId);
      return p;
    }
  }
  ompHomeSweepCooldown.set(threadId, now);
  return null;
}

/** One omp sessions root: `<root>/<cwd-encoded>/<ts>_<threadId>.jsonl`. */
async function searchOmpRoot(root: string, threadId: string): Promise<string | null> {
  const suffix = `_${threadId}.jsonl`;
  let cwdDirs: string[];
  try {
    cwdDirs = await fs.readdir(root);
  } catch {
    return null;
  }
  for (const dir of cwdDirs) {
    let files: string[];
    try {
      files = await fs.readdir(join(root, dir));
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.endsWith(suffix)) return join(root, dir, f);
    }
  }
  return null;
}
