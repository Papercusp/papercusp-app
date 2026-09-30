/**
 * POST /api/agent-mcp/console/record — record an adv_sessions row for a
 * terminal the DESKTOP SHELL spawned Rust-side (Tauri `console_launch`,
 * papercusp-desktop/src-tauri/src/native_console.rs).
 *
 * windows-desktop-feature-parity-2026-07-02 P-014: `console-spawn.ts`'s
 * server-side spawner (Linux + macOS) calls `recordAdvSession` itself right
 * after it forks the terminal — see `console-launch.ts`'s POST handler. On
 * Windows (and any future non-Linux/non-macOS operator host) that spawn
 * happens OUTSIDE the operator, in Rust, via `console_launch` — and until
 * this route, `native-console.ts`'s Tauri fallback never told the operator a
 * new terminal had opened at all. A plain (non-psu) console spawned that way
 * had NO adv_sessions row: invisible to /adv, unparkable, unresumable, and —
 * for the on-desktop reaper exemption (P-019) — undetectable, because there
 * was nothing to detect.
 *
 * A psu (agent) session self-registers independently via bootstrap-su.ts the
 * moment `psu` boots — that call happens FROM INSIDE the WSL distro TO the
 * WSL-hosted operator (console-spawn.ts: "the operator runs inside WSL"), so
 * it already works cross-platform with no Windows-specific code. This route
 * only closes the gap for the OTHER case: a plain shell console with no
 * agent to self-register.
 *
 * Deliberately DOES NOT accept a caller-supplied `pid`. The Rust caller's
 * only candidate pid is the WINDOWS-side wt.exe/wsl.exe process id (Rust
 * `Command::spawn().id()`, native_console.rs) — a Windows PID lives in a
 * DIFFERENT pid namespace than the WSL-hosted operator that would later
 * `process.kill(pid, 0)` it (wake-executor.ts / wake-reachability.ts). Ever
 * accepting one from the client and forwarding it into `adv_sessions.pid`
 * would silently poison every liveness check with a foreign-namespace
 * number — the exact "breaks across the WSL boundary" trap the underlying
 * plan calls out. Leaving `pid` unset degrades to the SAME
 * presence-freshness liveness path bootstrap-su-launched (hook-bootstrapped,
 * no-pid) sessions already use — a known-correct, already-tested channel,
 * not a new one.
 *
 * No exit-watcher, and the caller (native-console.ts) knows it: `console-
 * launch.ts`'s Linux/macOS path can attach one because it holds the Node
 * `ChildProcess`; here the child lives in the Rust process and this route
 * only fires once, at spawn time. The row is NOT automatically closed —
 * idle-session-reaper.ts's documented rule is "no coord_owner_id → can't
 * liveness-check → never reap (kept)", and this route always records with
 * `coordOwnerId: null`. That is why the caller only invokes this route for a
 * PLAIN console (`!opts.runPsu`): a psu console gets its own, properly
 * liveness-tracked row from bootstrap-su instead, so calling this route for
 * it too would leave a second, permanently-orphaned row behind rather than
 * one. A permanently-open plain-console row is an accepted, visible gap
 * (visibility beats the prior total invisibility) pending a Rust-side
 * "console exited" callback — native_console.rs already tracks the spawned
 * shell's exit via its sentinel-file trap for other purposes (MCP json
 * restore); a future fix can reuse that signal to end this row too.
 */
import { activeWorkspaceId } from '../../../workspace-registry';
import { recordAdvSession, setAdvSessionWindowId } from '../../../adv-sessions';
import { isWindowsDesktopHost, WINDOW_TITLE_PREFIX } from '../../../windows-desktop-windows';
import { PrincipalCheckError, requirePrincipal } from '../../../auth/require-principal';
import { defineTool } from '@papercusp/agent-mcp';

interface RecordBody {
  cwd?: string | null;
  terminalBin?: string | null;
  label?: string | null;
  planSlug?: string | null;
  launchArgv?: string[] | null;
  /**
   * windows-desktop-feature-parity-2026-07-02 P-010: the window-identity UUID
   * native_console.rs minted + titled the OS window with (`Papercup —
   * <sessionId>`). Only meaningful on a Windows-desktop host — see
   * `maybeRecordWindowTitle` below. Distinct from `adv_sessions.session_id`
   * (the agent CLI's native session id, e.g. claude's --session-id) — never
   * conflate the two.
   */
  sessionId?: string | null;
}

/** Same allowlist `console-launcher.ts`'s `shellSafeId` enforces — sessionId
 *  is minted as `crypto.randomUUID()`, so anything outside `[0-9a-f-]` is a
 *  malformed/adversarial value we refuse to splice into a stored title. */
const SAFE_SESSION_ID_RE = /^[0-9a-f-]+$/i;

function normalizeLaunchArgv(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter((s): s is string => typeof s === 'string' && s.length > 0);
  return out.length > 0 ? out : null;
}

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/console/record',
  auth: 'loopback',
  async handler(req) {
    try {
      await requirePrincipal(req.headers);
    } catch (err) {
      if (err instanceof PrincipalCheckError) {
        return Response.json({ status: 'error', error: err.reason }, { status: err.status });
      }
      throw err;
    }
    const body = (await req.json().catch(() => ({}))) as RecordBody;
    if (!body.cwd || typeof body.cwd !== 'string') {
      return Response.json({ status: 'error', error: 'cwd is required' }, { status: 400 });
    }
    const id = await recordAdvSession({
      workspaceId: activeWorkspaceId(),
      planSlug: body.planSlug ?? null,
      mode: 'console',
      terminalBin: body.terminalBin ?? null,
      // Deliberately omitted: see module header. Never forward a caller pid.
      label: body.label ?? null,
      cwd: body.cwd,
      launchArgv: normalizeLaunchArgv(body.launchArgv),
    });
    // windows-desktop-feature-parity-2026-07-02 P-010: on a Windows-desktop
    // host there's no pid→window mapping to resolve LATER (see
    // windows-desktop-windows.ts) — but we already KNOW the window's exact
    // title, because the caller minted it before the terminal even opened
    // (native_console.rs titled it `Papercup — <sessionId>`). Store that
    // title AS the row's windowId directly, so /adv/sessions/focus's
    // `latestRow?.windowId` fast path (endpoint-route/routes/adv/sessions.ts)
    // works immediately, with no enumerate-and-search round trip needed.
    if (id != null && isWindowsDesktopHost() && body.sessionId && SAFE_SESSION_ID_RE.test(body.sessionId)) {
      await setAdvSessionWindowId(id, `${WINDOW_TITLE_PREFIX}${body.sessionId}`);
    }
    return Response.json({ status: 'ok', id });
  },
});
