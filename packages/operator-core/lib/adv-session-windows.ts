/**
 * adv-session-windows — X11/win32 window-management helpers for tracked adv
 * sessions (resolve a pid/title → window id, focus it, close it).
 *
 * SPLIT OUT of adv-sessions.ts (WI-5476, precompute-derived-sync-reads-2026-07-19
 * follow-up). These are the ONLY part of the adv-session surface that shells out
 * (`wmctrl`), and adv-sessions.ts is imported by five sync resolvers whose read
 * functions are pure Postgres. Keeping the subprocess helpers in the same module
 * dragged `node:child_process` into the sync-resolver read graph and tripped the
 * no-heavy-io-on-read-path guard — even though no resolver ever calls them.
 *
 * Moving them here means the read module is subprocess-free and the guard walks
 * clean, with zero behavior change: every helper is best-effort and returns
 * null/false on any failure (no wmctrl, no DISPLAY, pid not yet windowed).
 */
import { focusWindowByTitle, isWindowsDesktopHost, listWindowsByTitle } from './windows-desktop-windows';

/** Keep a refused X11 focus request from blocking the operator request loop. */
const X11_FOCUS_TIMEOUT_MS = 2_000;
/**
 * Mutter updates _NET_ACTIVE_WINDOW asynchronously after accepting an
 * activation request. Give that observed state a short bounded settling
 * window before calling an otherwise successful activation a failure.
 */
const X11_FOCUS_SETTLE_ATTEMPTS = 10;
const X11_FOCUS_SETTLE_INTERVAL_MS = 50;

interface FocusCommandResult {
  status: number | null;
  stdout: string;
}

/** A sync result is accepted for injected test seams; the real runner is async. */
type X11CommandRunner = (command: string, args: string[]) => FocusCommandResult | Promise<FocusCommandResult>;

interface FocusWindowIdDeps {
  runCommand?: X11CommandRunner;
  settle?: (ms: number) => Promise<void>;
}

/**
 * WI-10005394: every X11 command here runs through async `execFile` with a bound. These used to
 * be `spawnSync` on the operator main thread, three of them with NO timeout: a wedged X server
 * then blocked the event loop until the sentinel wedge-killed the host and every MCP session on
 * it (#1155). Even against a healthy X server each synchronous fork of the ~1.7 GB operator costs
 * ~160 ms of main-thread time (EI-24852529885337741), and one focus click issues up to ~14.
 */
async function runX11Command(command: string, args: string[]): Promise<FocusCommandResult> {
  const { execFileResult } = await import('./sync-exec-replay');
  const r = await execFileResult(command, args, { timeout: X11_FOCUS_TIMEOUT_MS });
  return { status: r.status, stdout: r.stdout };
}

function parseX11WindowId(value: string): bigint | null {
  const normalized = value.trim().toLowerCase();
  if (!/^(?:0x[0-9a-f]+|[0-9]+)$/.test(normalized)) return null;
  try {
    return BigInt(normalized);
  } catch {
    return null;
  }
}

/** wmctrl prints hexadecimal ids while xdotool prints the active id in decimal. */
export function sameX11WindowId(left: string, right: string): boolean {
  const a = parseX11WindowId(left);
  const b = parseX11WindowId(right);
  return a !== null && b !== null && a === b;
}

async function activeX11WindowMatches(targetWindowId: string, runCommand: X11CommandRunner): Promise<boolean> {
  const active = await runCommand('xdotool', ['getactivewindow']);
  return active.status === 0 && sameX11WindowId(active.stdout, targetWindowId);
}

async function waitForActiveX11Window(
  targetWindowId: string,
  runCommand: X11CommandRunner,
  settle: (ms: number) => Promise<void>,
): Promise<boolean> {
  if (await activeX11WindowMatches(targetWindowId, runCommand)) return true;
  for (let attempt = 0; attempt < X11_FOCUS_SETTLE_ATTEMPTS; attempt += 1) {
    await settle(X11_FOCUS_SETTLE_INTERVAL_MS);
    if (await activeX11WindowMatches(targetWindowId, runCommand)) return true;
  }
  return false;
}

/**
 * Resolve a pid → X11 window id via `wmctrl -lp`. Best-effort: returns
 * null on any failure (no wmctrl, no DISPLAY, pid not yet windowed,
 * etc.). Callers should accept the null and surface a "couldn't focus"
 * message rather than crashing.
 */
export async function resolveWindowIdForPid(pid: number): Promise<string | null> {
  try {
    const r = await runX11Command('wmctrl', ['-lp']);
    if (r.status !== 0) return null;
    // wmctrl -lp output: <wid> <desktop> <pid> <host> <title>
    for (const line of r.stdout.split('\n')) {
      const parts = line.trim().split(/\s+/, 5);
      if (parts.length < 4) continue;
      if (Number(parts[2]) === pid) return parts[0];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Pure matcher over `wmctrl -lp` stdout: return the FIRST window id whose TITLE
 * contains `fragment`, else null. Columns are `<win-id> <desktop> <pid> <host>
 * <title…>` and the title is free-form (contains spaces + unicode) — so we skip
 * exactly the four leading fields and test the WHOLE remaining title. Extracted
 * as a pure fn so the parse is unit-testable without shelling out to wmctrl.
 */
export function matchWindowIdInWmctrlOutput(stdout: string, fragment: string): string | null {
  const wanted = fragment.trim();
  if (!wanted) return null;
  for (const line of stdout.split('\n')) {
    const m = line.match(/^(\S+)\s+\S+\s+\S+\s+\S+\s+(.*)$/);
    if (!m) continue;
    const [, winId, title] = m;
    if (title.includes(wanted)) return winId;
  }
  return null;
}

export async function resolveWindowIdForTitleFragment(fragment: string): Promise<string | null> {
  const wanted = fragment.trim();
  if (!wanted) return null;
  if (isWindowsDesktopHost()) {
    // windows-desktop-feature-parity-2026-07-02 P-010: there is no
    // pid→window mapping across the WSL↔Windows boundary (see
    // windows-desktop-windows.ts header), so the "window id" we persist for
    // a Windows session IS its exact window TITLE — durable + effectively
    // unique because native_console.rs mints it as `Papercup — <uuid>`. A
    // Windows hwnd would be cheaper to compare but isn't safe to persist:
    // this helper's contract is "give me something focusWindowId can use
    // LATER", and re-resolving by title at focus time (rather than trusting
    // a cached hwnd) is the only approach that survives the window being
    // re-created (e.g. after a WSL restart).
    //
    // NOTE: guard is isWindowsDesktopHost(), NOT process.platform === 'win32'
    // — the operator always runs as a `wsl.exe --exec node` Linux process
    // (main.rs), so process.platform reports 'linux' even on a real Windows
    // box (P-025 audit finding, WI-1646's sibling — see
    // windows-desktop-windows.ts's module doc). Don't regress this.
    try {
      const windows = await listWindowsByTitle();
      const match = windows.find((w) => w.title.includes(wanted));
      return match ? match.title : null;
    } catch {
      return null;
    }
  }
  try {
    const r = await runX11Command('wmctrl', ['-lp']);
    if (r.status !== 0) return null;
    // A psu/fleet terminal titles itself "▶ · ☕2 · 3p · su-78d15 · 🔭 …" — the
    // matched fragment (e.g. a coord-owner short id) can sit DEEP in the title,
    // so match the whole title, not just its first token. (owner-hit 2026-07-11:
    // the old first-token-only parse silently missed psu-launched windows.)
    return matchWindowIdInWmctrlOutput(r.stdout, wanted);
  } catch {
    return null;
  }
}

/**
 * Bring a window to the foreground. Linux: `wmctrl -ia <wid>` (X11 window
 * id). Windows: `windowId` is actually a TITLE (per
 * `resolveWindowIdForTitleFragment`'s win32 branch above — hwnds aren't
 * stable enough to persist across the WSL boundary), so refocus BY TITLE via
 * windows-desktop-windows.ts. User-initiated only — see memory
 * feedback_e2e_no_focus_steal: this pattern is forbidden for automated
 * drivers but fine for an explicit focus-button click.
 */
export async function focusWindowId(
  windowId: string,
  deps: FocusWindowIdDeps = {},
): Promise<boolean> {
  if (isWindowsDesktopHost()) {
    try {
      return await focusWindowByTitle(windowId);
    } catch {
      return false;
    }
  }
  try {
    const runCommand: X11CommandRunner = deps.runCommand ?? runX11Command;
    const settle = deps.settle ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

    // GNOME can accept wmctrl's _NET_ACTIVE_WINDOW request (exit 0) while
    // refusing to activate the window. Observe the active window before
    // reporting success; an exit code alone is not evidence of activation.
    const wmctrl = await runCommand('wmctrl', ['-ia', windowId]);
    if (wmctrl.status === 0 && (await activeX11WindowMatches(windowId, runCommand))) {
      return true;
    }

    // xdotool's synchronous activation path succeeds on GNOME installations
    // where wmctrl is a false positive. It is bounded by the runner timeout,
    // and still must pass the same observed-active-window check.
    const xdotool = await runCommand('xdotool', ['windowactivate', '--sync', windowId]);
    if (xdotool.status === 0 && (await waitForActiveX11Window(windowId, runCommand, settle))) {
      return true;
    }

    // Mutter can also ignore BOTH EWMH activation requests while returning
    // success (observed with two live gnome-terminal windows on the current
    // desktop). This is an explicit, user-initiated focus action, so make one
    // final direct X input-focus attempt after raising the exact resolved
    // window. Never trust either exit status: require _NET_ACTIVE_WINDOW to
    // converge on the target before reporting success.
    const raised = await runCommand('xdotool', ['windowraise', windowId]);
    if (raised.status !== 0) return false;
    const directlyFocused = await runCommand('xdotool', ['windowfocus', '--sync', windowId]);
    if (directlyFocused.status !== 0) return false;
    return await waitForActiveX11Window(windowId, runCommand, settle);
  } catch {
    return false;
  }
}

/**
 * GRACEFULLY close a window by X11 window id — `wmctrl -ic <wid>` sends the
 * window-manager close request (WM_DELETE_WINDOW). For an agent's terminal
 * that tears the terminal down, which SIGHUPs the foreground CLI so it can
 * exit cleanly. This is the "Kill agent" mechanism for a windowed session
 * (the roster's bulk-kill, owner ask 2026-07-11): a graceful close, NOT a
 * SIGKILL, and NOT a pid kill (every gnome-terminal shares one server pid, so
 * a pid can't be matched back to one window — see resolveWindowIdForPid).
 * Best-effort: returns false on any failure (no wmctrl, no DISPLAY, window
 * already gone). Linux/X11 only for now — a headless agent has no window to
 * close (the route reports that as an un-killable case rather than guessing).
 * User-initiated only, like focusWindowId.
 */
export async function closeWindowId(windowId: string): Promise<boolean> {
  if (isWindowsDesktopHost()) {
    // No safe title-based close on the Windows desktop host yet — closing the
    // wrong window is worse than a no-op. Report un-actionable.
    return false;
  }
  try {
    const r = await runX11Command('wmctrl', ['-ic', windowId]);
    return r.status === 0;
  } catch {
    return false;
  }
}
