/**
 * desktop-window-liveness.ts — derive which agent sessions are CURRENTLY "on the
 * desktop" (a live OS window on the user's screen), so the idle-session reaper
 * never kills a session the user is looking at and coord:presence can surface
 * which agents are on the desktop ("assign these to the agent on the desktop").
 *
 * Decision (2026-06-29, owner): "on the desktop" == the session's OS window is
 * still present RIGHT NOW — a live `wmctrl` enumeration of the open windows,
 * matched against the session TWO ways (union — over-matching only ever
 * over-protects):
 *   1. LAUNCH-RECORDED handles: `adv_sessions.window_id` (with the unique
 *      `[adv:<id>]` window-title tag and the recorded pid as fallbacks). Only
 *      covers launches that captured a handle (the console-launch route).
 *   2. LIVE PROC ANCESTRY (WI-1586, 2026-07-02): each live interactive psu
 *      session's host pid (psu-pty discovery, `listLiveHosts`) whose /proc
 *      ancestor chain reaches a window-owning pid IS inside an open terminal
 *      window. This is the load-bearing signal: launch-handle capture ROTTED
 *      silently (window_id dead since 2026-05-31 — Claude Code's TUI rewrites
 *      the `[adv:N]` title tag; gnome-terminal windows all report the shared
 *      gnome-terminal-server pid, never the launch pid), which made the reaper's
 *      on-desktop exemption a no-op ("0 on-desktop/hard-exempt" every sweep) and
 *      let it SIGKILL a session the owner had open on screen. The ancestry
 *      signal cannot rot: closing the window SIGHUPs the shell, so the host dies
 *      or is reparented away from the terminal-server — it expires WITH the
 *      window. Purely DERIVED — no new column, no migration, recomputed each read.
 *
 * Box-local by design: `wmctrl` talks to the X server of THIS host, so on a
 * headless fleet box (no DISPLAY) it returns nothing → zero on-desktop sessions
 * → the reaper + presence behave exactly as before. The operator host that hosts
 * the desktop is where the console terminals (console-launch.ts) AND this sweep
 * both run, so the window list and the session rows line up.
 *
 * Best-effort throughout: any wmctrl/PG failure yields an EMPTY result, so a
 * desktop-liveness hiccup can only ever make the reaper MORE conservative
 * (over-protect a session) or make presence omit the flag — it can NEVER crash a
 * read/sweep or cause an extra kill. Two pure functions (`parseWmctrlList`,
 * `selectOnDesktopSessions`) carry the parsing + match logic so they unit-test
 * without an X server; the IO seams (`listOpenWindows`, `gatherOnDesktopSessions`)
 * wrap them with the wmctrl spawn + the adv_sessions read, both short-TTL-cached
 * so a burst of presence reads forks wmctrl at most once per window.
 *
 * WINDOWS (P-019, windows-desktop-feature-parity-2026-07-02): wmctrl/pid/proc-
 * ancestry are all Linux-only concepts — a Windows terminal (`wt.exe`) has no
 * pid a WSL-hosted agent can see (its own pid lives in the `papercup-runtime`
 * WSL2 distro; the window belongs to a Windows process). So on a Windows
 * desktop host (`isWindowsDesktopHost()` — NOT `process.platform === 'win32'`,
 * which is never true here: the operator's Node process always runs INSIDE
 * WSL2 as a genuine Linux process, even on a real Windows install — see
 * windows-desktop-windows.ts's module doc for the full explanation and why
 * this bit the whole plan once already), `listOpenWindows` enumerates via
 * `listWindowsByTitle()` (the Lane 1 shared helper) instead of shelling to
 * wmctrl, and `selectOnDesktopSessions` gains a THIRD match leg keyed by the
 * window title's `Papercup — <sessionId>` tag (parseSessionIdFromWindowTitle)
 * against the candidate's `sessionId` — the one launch-independent signal that
 * survives the WSL boundary. Fail-soft mirrors the Linux path exactly: any
 * Windows-side failure (no powershell.exe / WSL interop unavailable / parse
 * miss) yields `[]`, so this can only ever under-protect toward the
 * pre-Windows-support behavior, never over-kill.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { getOrgPg } from '@papercusp/db-org';
import { listLiveHosts } from './events/await/psu-pty-discovery';
import {
  listWindowsByTitle,
  parseSessionIdFromWindowTitle,
  isWindowsDesktopHost,
  getOnDesktopWindowsCache,
  type WindowsDesktopWindow,
} from './windows-desktop-windows';

const execFileAsync = promisify(execFile);

/** One currently-open window (only the fields we match sessions on). */
export interface OpenWindow {
  /** wmctrl window id, e.g. '0x04200007'. */
  wid: string;
  /** Owning pid (wmctrl -lp column 3), or null when unknown. */
  pid: number | null;
  /** Window title (last column) — carries the `[adv:<id>]` launch tag. */
  title: string;
}

/**
 * PURE: parse `wmctrl -lp` stdout → the open windows. No spawn, so the column
 * parsing is unit-tested without an X server. Each line is:
 *   <wid> <desktop> <pid> <host> <title…>
 * A line without a `0x…` window id (or with < 4 columns) is skipped; the title
 * is the 5th column onward rejoined (it may contain spaces — the `[adv:N]` tag
 * survives).
 */
export function parseWmctrlList(stdout: string): OpenWindow[] {
  const out: OpenWindow[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 4 || !parts[0].startsWith('0x')) continue;
    const pidNum = Number(parts[2]);
    out.push({
      wid: parts[0],
      pid: Number.isFinite(pidNum) && pidNum > 0 ? pidNum : null,
      title: parts.slice(4).join(' '),
    });
  }
  return out;
}

/** wmctrl spawn timeout — a hung X server must never wedge a presence read. */
const WMCTRL_TIMEOUT_MS = 1500;
/** Short cache so a burst of reads (presence + reaper) forks wmctrl at most once. */
const OPEN_WINDOWS_TTL_MS = 5000;

let openWindowsCache: { at: number; windows: OpenWindow[] } | null = null;

/** Injectable side-effects so `listOpenWindows` unit-tests without a real X server. */
export interface ListOpenWindowsDeps {
  /** Returns `wmctrl -lp` stdout, or null on any failure. May be sync (tests) or
   *  async (production uses a non-blocking spawn). */
  run?: () => string | null | Promise<string | null>;
  nowMs?: number;
  ttlMs?: number;
}

/** ASYNC + non-blocking by design: this runs on the single :3070 operator event
 *  loop (the D-007 chokepoint) via the presence read path, so it must NEVER use a
 *  blocking spawnSync — a hung X server would freeze the whole operator. execFile
 *  kills the child at WMCTRL_TIMEOUT_MS and rejects → caught → null. */
async function defaultRunWmctrl(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('wmctrl', ['-lp'], {
      timeout: WMCTRL_TIMEOUT_MS,
      encoding: 'utf8',
    });
    return typeof stdout === 'string' ? stdout : null;
  } catch {
    return null; // no wmctrl / no DISPLAY / spawn error / timeout → no windows
  }
}

/** Windows leg (P-019): enumerate via the Lane 1 shared helper instead of
 *  wmctrl. Best-effort → [] (mirrors defaultRunWmctrl's fail-soft contract) —
 *  listWindowsByTitle itself never throws, but this stays defensive in case a
 *  future implementation (e.g. the Tauri-IPC pivot noted in
 *  windows-desktop-windows.ts) does. */
async function defaultListWindowsWindows(): Promise<OpenWindow[]> {
  try {
    const windows = await listWindowsByTitle();
    return windows.map((w) => ({ wid: w.hwnd, pid: w.pid ?? null, title: w.title }));
  } catch {
    return [];
  }
}

/**
 * The currently-open windows on this box (short-TTL cached). Best-effort → []:
 * no wmctrl, no DISPLAY (headless), a spawn timeout, or a parse miss all yield an
 * empty list, which downstream reads as "nobody is on the desktop". On a
 * Windows desktop host (isWindowsDesktopHost(); and only when `deps.run`
 * isn't explicitly injected — the test seam always wins) this enumerates via
 * the Windows title-based helper instead of wmctrl.
 */
export async function listOpenWindows(deps: ListOpenWindowsDeps = {}): Promise<OpenWindow[]> {
  const ttl = deps.ttlMs ?? OPEN_WINDOWS_TTL_MS;
  const now = deps.nowMs ?? Date.now();
  if (openWindowsCache && now - openWindowsCache.at < ttl) return openWindowsCache.windows;
  let windows: OpenWindow[];
  if (deps.run) {
    const stdout = await deps.run();
    windows = stdout ? parseWmctrlList(stdout) : [];
  } else if (isWindowsDesktopHost()) {
    windows = await defaultListWindowsWindows();
  } else {
    const stdout = await defaultRunWmctrl();
    windows = stdout ? parseWmctrlList(stdout) : [];
  }
  openWindowsCache = { at: now, windows };
  return windows;
}

/** Test seam: drop the cached window list (and the on-desktop result cache). */
export function __resetDesktopLivenessCache(): void {
  openWindowsCache = null;
  onDesktopCache = null;
}

/** A candidate session for the on-desktop check — its launch-recorded handles. */
export interface DesktopCandidateSession {
  /** The adv_sessions row id — used to build the `[adv:<id>]` title-tag fallback. */
  advSessionId: number;
  /** coord owner id (PAPERCUSP_SID) — the reaper/presence join key. */
  coordOwnerId: string | null;
  /** Native session id (claude uuid) — the slice-3 zombie-reap key. */
  sessionId: string | null;
  /** Launch-resolved X11 window id (the primary match key). */
  windowId: string | null;
  /** Recorded launch pid (a fallback match key). */
  pid: number | null;
}

/** The three keyings of "currently on the desktop" the callers need. */
export interface OnDesktopSets {
  /** coord owner ids whose OS window is open — the reaper protect + presence key. */
  owners: Set<string>;
  /** native session ids whose OS window is open — the slice-3 zombie-reap key. */
  sessionIds: Set<string>;
  /** adv_session row ids on the desktop — the /adv/sessions surface key. */
  advSessionIds: Set<number>;
  /**
   * WINDOWS conservative-on-stale (WI-1967): TRUE when this is a Windows desktop
   * host AND the renderer-pushed window cache is unavailable (null — GUI
   * closed/backgrounded or the last push aged past its TTL), so we genuinely
   * CANNOT tell which `wt.exe` terminals are open. Unlike the Linux path — where
   * an empty window list is a DEFINITE "headless / nothing open" signal — a null
   * Windows cache is "unknown", not "empty". The reaper reads this to stay
   * conservative (protect every open session rather than reap on the absent
   * window signal); non-reaper consumers (presence, /adv/sessions) ignore it.
   * Always FALSE on Linux/macOS and whenever the cache is fresh (even if that
   * fresh push is an empty list — that IS a definite "no windows open").
   */
  windowSignalUnknown: boolean;
}

function emptyOnDesktopSets(): OnDesktopSets {
  return { owners: new Set(), sessionIds: new Set(), advSessionIds: new Set(), windowSignalUnknown: false };
}

/**
 * PURE: which candidate sessions currently have an open OS window. A session
 * matches when ANY of:
 *   - its recorded `windowId` is in the open-window set (primary, most reliable —
 *     console-launch retries for 5s to resolve + store it by the title tag), OR
 *   - an open window's title carries its `[adv:<id>]` launch tag (the same tag
 *     console-launch sets, so it survives even if window_id capture missed), OR
 *   - an open window's pid equals its recorded launch pid (fallback for
 *     emulators whose window pid == the spawned pid), OR
 *   - an open window's title carries the WINDOWS `Papercup — <sessionId>` tag
 *     matching its `sessionId` (P-019 — the pid/windowId legs above are both
 *     Linux-only concepts a WSL-hosted Windows session can never satisfy; the
 *     title is the only signal that survives the WSL boundary).
 * Injected open-window list so the match logic is unit-tested without wmctrl.
 * Over-matching is SAFE by design (it only over-protects a session from the
 * reaper / shows an extra desktop flag), so the union of cheap signals is
 * deliberate.
 */
export function selectOnDesktopSessions(
  sessions: readonly DesktopCandidateSession[],
  openWindows: readonly OpenWindow[],
): OnDesktopSets {
  const sets = emptyOnDesktopSets();
  if (openWindows.length === 0 || sessions.length === 0) return sets;
  const openWids = new Set(openWindows.map((w) => w.wid));
  const openPids = new Set(
    openWindows.map((w) => w.pid).filter((p): p is number => p != null),
  );
  const titles = openWindows.map((w) => w.title);
  const windowSessionIds = new Set(
    titles.map((t) => parseSessionIdFromWindowTitle(t)).filter((id): id is string => id != null),
  );
  for (const s of sessions) {
    const tag = `[adv:${s.advSessionId}]`;
    const onDesktop =
      (s.windowId != null && openWids.has(s.windowId)) ||
      (s.pid != null && openPids.has(s.pid)) ||
      titles.some((t) => t.includes(tag)) ||
      (s.sessionId != null && windowSessionIds.has(s.sessionId));
    if (!onDesktop) continue;
    if (s.coordOwnerId) sets.owners.add(s.coordOwnerId);
    if (s.sessionId) sets.sessionIds.add(s.sessionId);
    sets.advSessionIds.add(s.advSessionId);
  }
  return sets;
}

/* ── Live proc-ancestry detection (WI-1586) ──────────────────────────────────
 * The launch-handle-free half of "on the desktop": a session's LIVE host pid
 * whose /proc ancestor chain reaches a pid that owns an open window is inside
 * an open terminal window (gnome-terminal-server owns every terminal window AND
 * parents every shell it hosts; same shape for other emulators + Tauri-embedded
 * terminals). Works for every session with a live psu-pty host — no launch
 * capture, no title tag, no recorded pid needed. */

/** PURE: ppid from `/proc/<pid>/stat`. comm (field 2) is parenthesised and may
 *  contain spaces/parens, so slice after the LAST ')'; the remaining 0-indexed
 *  fields are 0=state 1=ppid … (same parse as idle-session-reaper's
 *  parseForegroundFromStat). Exported for unit coverage without /proc. */
export function parsePpidFromStat(stat: string): number | null {
  const after = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
  const ppid = Number(after[1]);
  return Number.isFinite(ppid) && ppid > 0 ? ppid : null;
}

/** Ancestry depth cap — a real desktop chain is ~3 (host ← shell ← emulator);
 *  32 is a loop/corruption guard, not a tuning knob. */
const ANCESTRY_MAX_DEPTH = 32;

async function defaultReadStat(pid: number): Promise<string | null> {
  try {
    return await readFile(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null; // proc gone / not Linux → chain ends, no match
  }
}

/**
 * Does `pid`'s ancestor chain (inclusive) reach a window-owning pid? Injected
 * stat reader so the walk unit-tests without /proc. Best-effort → false: a
 * vanished proc or unreadable stat just ends the walk (never over-protects on
 * garbage, never throws).
 */
export async function pidHasWindowAncestor(
  pid: number,
  windowPids: ReadonlySet<number>,
  readStat: (pid: number) => Promise<string | null> = defaultReadStat,
): Promise<boolean> {
  if (windowPids.size === 0) return false;
  let p = pid;
  for (let depth = 0; depth < ANCESTRY_MAX_DEPTH && Number.isFinite(p) && p > 1; depth += 1) {
    if (windowPids.has(p)) return true;
    const stat = await readStat(p);
    if (stat == null) return false;
    const ppid = parsePpidFromStat(stat);
    if (ppid == null) return false;
    p = ppid;
  }
  return false;
}

/** The pids that own at least one open window (null/0 pids dropped). */
export function windowOwningPids(windows: readonly OpenWindow[]): Set<number> {
  return new Set(windows.map((w) => w.pid).filter((p): p is number => p != null && p > 0));
}

/**
 * Is this LIVE pid sitting under an open desktop window (proc ancestry)?
 * The slice-3 zombie-reap spare: a leaked `claude --resume` proc still inside
 * an open terminal window must never be killed, whatever its adv rows say.
 * Best-effort → false (headless / no wmctrl / proc gone).
 */
export async function isPidUnderOpenWindow(pid: number): Promise<boolean> {
  try {
    const windows = await listOpenWindows();
    return await pidHasWindowAncestor(pid, windowOwningPids(windows));
  } catch {
    return false;
  }
}

/** Candidate recency bound — a session whose window could still be open. Includes
 *  ended-but-recent rows on purpose: a still-open window on an ended adv row is
 *  exactly the "marked dead but still on screen" case we must spare. Mirrors
 *  adv-sessions RECORDED_LIVE_MAX_AGE_MS (12h). */
export const DESKTOP_CANDIDATE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** Short cache on the joined result — presence may read it per call; the reaper
 *  per sweep. The window list has its own TTL; this also caches the PG join. */
const ON_DESKTOP_TTL_MS = 5000;
let onDesktopCache: { at: number; sets: OnDesktopSets } | null = null;

/** Injectable seams for gatherOnDesktopSessions so the ancestry pass unit-tests
 *  without a live psu-pty dir or /proc. Production defaults wire the real ones. */
export interface GatherOnDesktopDeps {
  /** Open-window enumerator. Default: listOpenWindows() (wmctrl). */
  listWindows?: () => Promise<OpenWindow[]>;
  /** Live interactive psu hosts (ownerId + host pid). Default: listLiveHosts(). */
  listHosts?: () => Array<{ ownerId: string; pid: number }>;
  /** /proc stat reader for the ancestry walk. Default: real /proc. */
  readStat?: (pid: number) => Promise<string | null>;
  /** Is this the Windows desktop host? Default: isWindowsDesktopHost(). Injected
   *  so the WI-1967 windowSignalUnknown branch unit-tests off the Linux dev box. */
  isWindowsHost?: () => boolean;
  /** The renderer-pushed Windows window cache (null ⇒ unknown). Default:
   *  getOnDesktopWindowsCache(). Injected alongside isWindowsHost for tests. */
  readWindowsCache?: () => WindowsDesktopWindow[] | null;
}

/**
 * The sessions currently on the desktop, keyed three ways (owners / sessionIds /
 * advSessionIds). Enumerates the open windows, then matches sessions two ways:
 *   1. launch-recorded handles (window_id / pid / `[adv:N]` title tag) against
 *      the recently-launched adv_sessions rows, and
 *   2. LIVE PROC ANCESTRY (WI-1586): every live psu-pty host whose pid sits
 *      under a window-owning pid — the signal that works when handle capture
 *      rotted (it did: window_id dead since 2026-05-31, pid since 2026-06-23,
 *      which made the reaper's hard-exemption a silent no-op and killed an
 *      on-screen session).
 * Short-TTL cached. Best-effort → empty sets on ANY failure (the reaper/presence
 * then behave as if nothing is on the desktop, never crashing and never
 * over-killing).
 */
export async function gatherOnDesktopSessions(
  opts: { maxAgeMs?: number; nowMs?: number; ttlMs?: number; deps?: GatherOnDesktopDeps } = {},
): Promise<OnDesktopSets> {
  const ttl = opts.ttlMs ?? ON_DESKTOP_TTL_MS;
  const now = opts.nowMs ?? Date.now();
  if (onDesktopCache && now - onDesktopCache.at < ttl) return onDesktopCache.sets;

  let sets = emptyOnDesktopSets();
  // WI-1967 — Windows "unknown window signal" detection, computed up front (a pure
  // in-memory read that never throws, and independent of the window/PG reads
  // below). On a Windows desktop host the ONLY on-desktop signal is the
  // renderer-pushed cache; when it's null (GUI closed/backgrounded, or the last
  // push aged out) listWindowsByTitle collapses it to [], which is
  // indistinguishable from a genuine "no windows" — so we surface the ambiguity
  // explicitly for the reaper. On Linux/macOS this is always false (an empty
  // wmctrl list there is a definite headless signal, never "unknown").
  const windowSignalUnknown =
    (opts.deps?.isWindowsHost ?? isWindowsDesktopHost)() &&
    (opts.deps?.readWindowsCache ?? getOnDesktopWindowsCache)() === null;
  try {
    const windows = await (opts.deps?.listWindows ?? listOpenWindows)();
    // No open windows (headless box / no DISPLAY) → nobody is on the desktop.
    if (windows.length > 0) {
      const maxAgeSec = Math.max(1, Math.round((opts.maxAgeMs ?? DESKTOP_CANDIDATE_MAX_AGE_MS) / 1000));
      const { sql } = getOrgPg();
      // Recent rows with ANY join key — a launch handle (leg 1) OR a coord owner
      // (leg 2's join back from the live-host ownerId to sessionIds/advIds).
      const rows = await sql<
        Array<{ id: number; coord_owner_id: string | null; session_id: string | null; window_id: string | null; pid: number | null }>
      >`
        SELECT id, coord_owner_id, session_id, window_id, pid
          FROM harness_shared.adv_sessions
         WHERE started_at > now() - make_interval(secs => ${maxAgeSec})
           AND (window_id IS NOT NULL OR pid IS NOT NULL OR coord_owner_id IS NOT NULL)`;
      sets = selectOnDesktopSessions(
        rows.map((r) => ({
          advSessionId: r.id,
          coordOwnerId: r.coord_owner_id,
          sessionId: r.session_id,
          windowId: r.window_id,
          pid: r.pid,
        })),
        windows,
      );

      // Leg 2 — live-host proc ancestry. Each live interactive session's host
      // pid whose ancestor chain reaches a window-owning pid is inside an open
      // terminal window; fold its owner in and join its adv rows for the
      // sessionId/advSessionId keyings. Per-host best-effort: a failed walk
      // skips one protect, never the sweep.
      const winPids = windowOwningPids(windows);
      if (winPids.size > 0) {
        let hosts: Array<{ ownerId: string; pid: number }> = [];
        try {
          hosts = (opts.deps?.listHosts ?? listLiveHosts)();
        } catch {
          hosts = [];
        }
        for (const h of hosts) {
          if (!h.ownerId || !h.pid) continue;
          if (sets.owners.has(h.ownerId)) continue; // already matched by handle
          if (await pidHasWindowAncestor(h.pid, winPids, opts.deps?.readStat ?? defaultReadStat)) {
            sets.owners.add(h.ownerId);
            for (const r of rows) {
              if (r.coord_owner_id !== h.ownerId) continue;
              if (r.session_id) sets.sessionIds.add(r.session_id);
              sets.advSessionIds.add(r.id);
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn('[desktop-window-liveness] gather failed (non-fatal):', (e as Error)?.message ?? e);
    sets = emptyOnDesktopSets();
  }
  // Stamp the unknown-signal flag last, so it survives the `sets =
  // selectOnDesktopSessions(...)` reassignment in the success path AND rides the
  // catch-reset empty sets (a Windows host with a null cache should read
  // "unknown" even if the PG join threw).
  sets.windowSignalUnknown = windowSignalUnknown;
  onDesktopCache = { at: now, sets };
  return sets;
}

/* ── FOCUSED-window attendance (gateway-rayobyte-hardening P-006) ────────────────
 * The auto-ESC un-wedge (stall-waker) injects keystrokes into a session's pty. That
 * is safe for a background/fleet window, but NEVER for the window the human is
 * focused on RIGHT NOW: in the Claude Code TUI a stray Esc at the prompt (twice)
 * opens the rewind/restore picker — the 2026-07-01 accidental-conversation-restore.
 * Focus, not mere visibility, is the harm signal: fleet members in visible-but-
 * unfocused terminals stay eligible for auto-recovery. Best-effort: no X / no
 * xprop / no match ⇒ null/false ⇒ the caller behaves as before. */

/** PURE: parse `xprop -root _NET_ACTIVE_WINDOW` stdout → the active window id as a
 *  NUMBER (wmctrl prints `0x04200007`, xprop `0x4200007` — compare numerically),
 *  or null when unparseable / no active window (0x0). */
export function parseActiveWindowId(stdout: string): number | null {
  const m = stdout.match(/window id #\s*(0x[0-9a-fA-F]+)/);
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const XPROP_TIMEOUT_MS = 1500;
const ACTIVE_WINDOW_TTL_MS = 2000; // focus moves fast — cache only briefly
let activeWindowCache: { at: number; wid: number | null } | null = null;

/** Injectable seam for tests. */
export interface ActiveWindowDeps {
  run?: () => string | null | Promise<string | null>;
  nowMs?: number;
  ttlMs?: number;
}

async function defaultRunXprop(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('xprop', ['-root', '_NET_ACTIVE_WINDOW'], {
      timeout: XPROP_TIMEOUT_MS,
      encoding: 'utf8',
    });
    return typeof stdout === 'string' ? stdout : null;
  } catch {
    return null; // no xprop / no DISPLAY / timeout → focus unknown
  }
}

/** The currently-FOCUSED window id (numeric), or null when unknown. Short-TTL cached. */
export async function getActiveWindowId(deps: ActiveWindowDeps = {}): Promise<number | null> {
  const ttl = deps.ttlMs ?? ACTIVE_WINDOW_TTL_MS;
  const now = deps.nowMs ?? Date.now();
  if (activeWindowCache && now - activeWindowCache.at < ttl) return activeWindowCache.wid;
  const stdout = await (deps.run ?? defaultRunXprop)();
  const wid = stdout ? parseActiveWindowId(stdout) : null;
  activeWindowCache = { at: now, wid };
  return wid;
}

/** Test seam: drop the active-window cache. */
export function __resetActiveWindowCache(): void {
  activeWindowCache = null;
}

/** PURE: does the ACTIVE window belong to `ownerId`? Matches the same three ways as
 *  selectOnDesktopSessions (window id, owning pid, `[adv:<id>]` title tag), but for
 *  the single focused window. */
export function ownerOwnsWindow(
  sessions: readonly DesktopCandidateSession[],
  windows: readonly OpenWindow[],
  activeWid: number,
  ownerId: string,
): boolean {
  const win = windows.find((w) => Number.parseInt(w.wid, 16) === activeWid);
  if (!win) return false;
  return sessions.some(
    (s) =>
      s.coordOwnerId === ownerId &&
      ((s.windowId != null && Number.parseInt(s.windowId, 16) === activeWid) ||
        (s.pid != null && s.pid === win.pid) ||
        win.title.includes(`[adv:${s.advSessionId}]`)),
  );
}

/** Is `ownerId`'s session the one the human is FOCUSED on right now? Best-effort →
 *  false (headless / no xprop / no match), so a guard built on this can only ever
 *  SKIP keystroke injection for the focused session, never block recovery elsewhere. */
export async function isOwnerFocusedOnDesktop(ownerId: string): Promise<boolean> {
  try {
    const activeWid = await getActiveWindowId();
    if (activeWid == null) return false;
    const windows = await listOpenWindows();
    if (windows.length === 0) return false;
    const maxAgeSec = Math.max(1, Math.round(DESKTOP_CANDIDATE_MAX_AGE_MS / 1000));
    const { sql } = getOrgPg();
    const rows = await sql<
      Array<{ id: number; coord_owner_id: string | null; session_id: string | null; window_id: string | null; pid: number | null }>
    >`
      SELECT id, coord_owner_id, session_id, window_id, pid
        FROM harness_shared.adv_sessions
       WHERE coord_owner_id = ${ownerId}
         AND started_at > now() - make_interval(secs => ${maxAgeSec})
         AND (window_id IS NOT NULL OR pid IS NOT NULL)`;
    return ownerOwnsWindow(
      rows.map((r) => ({
        advSessionId: r.id,
        coordOwnerId: r.coord_owner_id,
        sessionId: r.session_id,
        windowId: r.window_id,
        pid: r.pid,
      })),
      windows,
      activeWid,
      ownerId,
    );
  } catch {
    return false;
  }
}
