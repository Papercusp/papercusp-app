/**
 * terminal-spawn — shared OS-terminal spawn helper for the operator host.
 *
 * The operator opens OS-native terminals server-side on Linux (the operator
 * sidecar runs in the desktop's GUI session, so a detached spawn here opens a
 * window on the user's display). This module holds the terminal-emulator
 * discovery + spawn that was previously duplicated across `console-launch.ts`
 * and `launch-su.ts`. New launchers (e.g. `launch-pui.ts`) build a `bash -lc`
 * one-liner and hand it to {@link spawnInTerminal}.
 *
 * ⚠ It is NOT the only such spawner, despite what this comment used to claim.
 * `console-spawn.ts` keeps its own findTerminal (`findLinuxTerminal`) and its own
 * spawn (it carries extra session-bus / display-override / env-injection logic
 * this module still lacks), and it serves the busier callers —
 * `capability:terminal` and every VISIBLE `fleet:launch-on-plan` member. That
 * stale "single home" wording is exactly why the EI-19385011811175105 fix landed
 * here and missed there (EI-19407722209410974) — the terminal DATA is now
 * single-sourced (`linux-terminals.ts`) and the SELECTION POLICY (desktop-session
 * detection deciding client-server vs process-per-window order) now reuses
 * console-spawn's directly (EI-19408594551235977), but the two spawn functions
 * themselves are still separate. A fix to spawn BEHAVIOUR must still be applied
 * to both until they are actually merged; grep the SYMPTOM (`gnome-terminal`)
 * rather than this module's callers.
 *
 * Linux-only — callers gate on `process.platform === 'linux'` and return 501
 * before reaching here on other platforms (mirrors console-launch.ts).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { standardToolDirs } from './tool-path';
import { createTextCollector } from './child-output';
import { LINUX_TERMINALS_FLAT } from './linux-terminals';
// EI-19408594551235977: reuse console-spawn's desktop-session-aware ordering
// instead of walking the flat list unconditionally. This IS a circular import
// (console-spawn.ts imports scrubTerminalContextEnv from this module) but it is
// safe: every binding crossed in either direction is a hoisted `export function`
// consumed only inside another function body, never at module-init time, so the
// import cycle never observes a not-yet-initialized value.
import {
  pickLinuxTerminal,
  resolveLinuxDesktopEnv,
  resolveTerminalPreference,
  watchEarlyExit,
  classifyEarlyExit,
  EARLY_EXIT_PROBE_MS,
  type DesktopEnvProbes,
} from './console-spawn';

/**
 * Terminal emulators tried in order, each with the args that run a command in
 * a new window.
 *
 * Now DERIVED from the shared table rather than a second literal copy of it
 * (EI-19407722209410974): the duplicate is what let the GNOME_TERMINAL_SCREEN fix
 * land here and miss console-spawn.ts entirely. The concatenation is
 * byte-identical to the literal it replaced — client-server group first, then
 * process-per-window — so single-sourcing the data changed no selection.
 * `linux-terminals.test.ts` pins that.
 *
 * Historically this flat order was what {@link findTerminal} walked
 * unconditionally (always gnome-terminal FIRST) — fixed by EI-19408594551235977,
 * which made `findTerminal` desktop-session-aware like console-spawn's
 * `pickLinuxTerminal` (WI-4718/WI-4711). `LINUX_TERMINALS` itself is kept as the
 * flat data-parity constant (pinned by `linux-terminals.test.ts` against the
 * pre-dedupe literal) — it is no longer what `findTerminal` iterates.
 */
export const LINUX_TERMINALS: ReadonlyArray<readonly [string, readonly string[]]> =
  LINUX_TERMINALS_FLAT;

/**
 * Is `bin` an executable reachable on PATH (plus the usual install dirs)?
 * Probes PATH + the canonical {@link standardToolDirs} (incl. /opt/homebrew/bin
 * for Apple-Silicon Homebrew, /usr/local/bin, ~/.local/bin) — NOT ~/.cargo/bin.
 * Callers that resolve a cargo-installed binary (pui, zellij) must check
 * `~/.cargo/bin` explicitly (see launch-pui.ts).
 */
export function isOnPath(bin: string): boolean {
  const paths = (process.env.PATH ?? '').split(':');
  paths.push(...standardToolDirs());
  return paths.some((p) => p && existsSync(join(p, bin)));
}

/** A resolved terminal emulator + the args to run a command in a new window. */
export interface ResolvedTerminal {
  bin: string;
  args: string[];
}

/**
 * Resolve the terminal emulator to use: honour `$TERMINAL` if it's on PATH,
 * else pick via the SAME desktop-session-aware ordering console-spawn uses
 * (WI-4718 / EI-19408594551235977) — the client-server group
 * (gnome-terminal/konsole/xfce4-terminal) is tried first ONLY when a live
 * desktop session's D-Bus bus was actually resolved; otherwise the
 * process-per-window group (alacritty/kitty/wezterm/xterm) is tried first,
 * since a client-server terminal with no reachable bus silently ghosts
 * (WI-4711) — the other group is always appended as a fallback either way, so
 * this only changes ORDER, never which terminals are considered.
 *
 * `env` / `desktopEnvProbes` are DI seams for tests; defaults are the real
 * process env and console-spawn's real (best-effort, never-throws) probes.
 */
export function findTerminal(
  env: NodeJS.ProcessEnv = process.env,
  desktopEnvProbes?: DesktopEnvProbes,
): ResolvedTerminal | null {
  const fromEnv = env.TERMINAL;
  if (fromEnv && isOnPath(fromEnv)) {
    return fromEnv === 'gnome-terminal'
      ? { bin: fromEnv, args: ['--wait', '--'] }
      : { bin: fromEnv, args: ['-e'] };
  }
  const desktop = resolveLinuxDesktopEnv(env, desktopEnvProbes);
  const preferClientServer = resolveTerminalPreference(
    desktop.resolved && desktop.desktopSessionDetected,
    false,
  );
  return pickLinuxTerminal(isOnPath, preferClientServer);
}

/** POSIX single-quote escape — wrap `s` so the shell sees it as one literal. */
export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Env vars that IDENTIFY the terminal (or multiplexer) the OPERATOR ITSELF was
 * started in. A launch's terminal identity is RE-DERIVED, NEVER INHERITED —
 * the same rule launch-su already applies to `PAPERCUSP_OPERATOR_URL`.
 *
 * The one that bites (EI-19385011811175105, owner-reported 2026-08-02): the
 * desktop's operator sidecar is started by `npm run dev` inside a gnome-terminal
 * tab, so its env carries that tab's own
 * `GNOME_TERMINAL_SCREEN=/org/gnome/Terminal/screen/<uuid>`. gnome-terminal reads
 * it as "open the new window RELATIVE TO THIS SCREEN" and asks the factory for it
 * over D-Bus; the originating tab is long gone, so the call fails with
 *
 *     # Error creating terminal: Failed to get screen from object path /org/gnome/Terminal/screen/<uuid>
 *
 * and the client EXITS 0 having opened nothing. Exit code 0 makes the failure
 * invisible to any status check — which is why the stderr capture below exists
 * too. Measured live against the running sidecar's real env: baseline → no
 * window; minus `GNOME_TERMINAL_SCREEN` (or minus `GNOME_TERMINAL_SERVICE`) →
 * window opens. Downstream this rendered as "This session's launch failed — its
 * terminal closed before the session came online. Try launching it again.", advice
 * that could not possibly work because every retry failed identically.
 *
 * The rest are the exact analogues on the other emulators, plus the multiplexer
 * vars — we are opening a BRAND-NEW WINDOW, so a psu that believes it is still
 * inside the operator's tmux/zellij pane is wrong in the same way.
 */
export const TERMINAL_CONTEXT_ENV_KEYS: readonly string[] = [
  // Operator-process-ONLY subsystem overrides (WI-7160 / EI-19484521469xxx class,
  // found WI-37487 2026-08-09). These are set via `[Service] Environment=` on
  // papercup-dev-api.service / papercup-staging-api.service SPECIFICALLY to
  // retune that unit's OWN internal git-spawn-offload call sites
  // (dev-deploy-state.ts's `git()`, system-health/compute.ts's `runGit`) — never
  // meant to affect anything else. Every spawn seam here (visible terminal AND
  // headless agent/console spawn) runs the new payload as a CHILD of the
  // operator process with "full env inheritance intact" (systemd-scope.ts) by
  // design, so without this scrub every spawned agent shell — and every Bash
  // tool child process inside it — silently inherits the operator's own
  // subsystem toggle and can trip an unrelated code path (measured: it forced
  // an agent-shell `npm run test:file` invocation through the degraded spawner
  // sidecar, producing a `console.warn` that failed `vitest-fail-on-console` in
  // a THIRD, unrelated test — the recurring cycle-deps.test.ts red-test-watchdog
  // flake).
  'PAPERCUSP_DEV_DEPLOY_SPAWN_SIDECAR',
  'PAPERCUSP_SYSTEM_HEALTH_SPAWN_SIDECAR',
  // GNOME / VTE
  'GNOME_TERMINAL_SCREEN',
  'GNOME_TERMINAL_SERVICE',
  'VTE_VERSION',
  // KDE
  'KONSOLE_DBUS_SERVICE',
  'KONSOLE_DBUS_SESSION',
  'KONSOLE_DBUS_WINDOW',
  'KONSOLE_PROFILE_NAME',
  // others
  'ALACRITTY_SOCKET',
  'ALACRITTY_WINDOW_ID',
  'WEZTERM_PANE',
  'WEZTERM_UNIX_SOCKET',
  'ITERM_SESSION_ID',
  'TERM_SESSION_ID',
  'TERMINATOR_UUID',
  'TILIX_ID',
  'WINDOWID',
  // multiplexers
  'TMUX',
  'TMUX_PANE',
  'ZELLIJ',
  'ZELLIJ_SESSION_NAME',
  'ZELLIJ_PANE_ID',
  'STY',
];

/** `env` minus {@link TERMINAL_CONTEXT_ENV_KEYS}. Pure — returns a copy. */
export function scrubTerminalContextEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of TERMINAL_CONTEXT_ENV_KEYS) delete out[k];
  return out;
}

export interface SpawnInTerminalOpts {
  /** Shell one-liner run inside `bash -lc` in the new terminal window. */
  oneliner: string;
  /** Env for the spawned terminal (defaults to the operator host's env). */
  env?: NodeJS.ProcessEnv;
  /** Working directory for the spawned terminal (defaults to the host's cwd). */
  cwd?: string;
  /**
   * Silent-launch-failure detector (EI-18696184925888288): after the OS spawn
   * call returns, WATCH the child for this many ms and classify an early
   * death. A terminal client can hand off to a long-lived singleton server and
   * exit almost immediately even when NO window ever actually opened (repro'd
   * live: `gnome-terminal --wait` against a headless/offscreen Xvfb display
   * exits right away instead of blocking on the command it was asked to run) —
   * before this check, that produced a confident-looking `{ok:true, terminal,
   * pid}` with no signal that nothing was actually launched.
   *
   * ⚠ WI-37743 — this used to be a FIXED 400ms sleep followed by a single
   * `kill(pid, 0)` poll, and that shape was both too early and actively
   * self-defeating. Measured client death on the HUD "+ New session" path is
   * ~870ms, so the poll fired ~470ms BEFORE the failure, saw a live client,
   * and took the `likelyOpened` branch — which DRAINS the stderr pipe. The one
   * piece of evidence a silent launch failure leaves behind was thrown away by
   * the very check that existed to detect it, and the owner got "the terminal
   * closed" with no cause. Watching for the exit resolves the moment it
   * happens (so only the SUCCESS path pays the full window) and keeps the
   * stderr.
   *
   * 0 disables the check. Defaults to console-spawn's {@link
   * EARLY_EXIT_PROBE_MS} so both spawn paths judge "died at boot" on the same
   * window with the same classifier.
   */
  earlyExitProbeMs?: number;
  /**
   * Test-only DI seam: injectable probes for the desktop-session detection
   * {@link findTerminal} now performs (EI-19408594551235977). Omit in
   * production — defaults to the real (best-effort, never-throws) probes.
   */
  desktopEnvProbes?: DesktopEnvProbes;
}

export type SpawnInTerminalResult =
  | {
      ok: true;
      terminal: string;
      pid: number | undefined;
      likelyOpened: boolean;
      /**
       * What the emulator printed to stderr before it died, when it died — the
       * ONLY evidence available for a silent failure, since gnome-terminal exits
       * 0 on one (see TERMINAL_CONTEXT_ENV_KEYS). Set only alongside
       * `likelyOpened:false`, so callers can name the cause instead of reporting
       * a bare "the terminal closed".
       */
      stderr?: string;
      /**
       * HOW we concluded the window never opened, in the classifier's own words
       * — `gnome-terminal died exit code 1 within 1200ms`, `… exited 0 instantly
       * under --wait (no window survived)`, or a spawn-level ENOENT.
       *
       * Deliberately distinct from `stderr` (WI-37743): stderr is what the
       * EMULATOR said, this is what WE observed — and a silent failure prints
       * nothing at all, which used to leave the caller holding a bare
       * `likelyOpened:false` with no way to tell "died instantly" from "exited
       * cleanly under --wait" from "the binary never ran". Set only alongside
       * `likelyOpened:false`.
       */
      failureReason?: string;
    }
  | { ok: false; code: 'no_terminal' | 'spawn_failed'; error: string };

/** Max chars of emulator stderr kept — enough for a startup complaint, not a log. */
export const STDERR_CAPTURE_LIMIT = 1000;

/**
 * Max ms a DEAD child's stderr pipe gets to hand over what it already holds.
 *
 * `'exit'` can fire before the last `'data'` events land, and on the failure
 * path that text is the only evidence of the cause — so give it a bounded
 * grace instead of racing it. Paid ONLY when the launch already failed, so it
 * adds nothing to a healthy launch.
 */
export const STDERR_FLUSH_GRACE_MS = 200;

/** Wait (bounded) for a dead child's stderr to end, so a late-flushed
 *  diagnostic line is not lost to the exit/data race described above. */
function flushStderr(child: ChildProcess, ms: number): Promise<void> {
  const stderr = child.stderr;
  if (!stderr || stderr.readableEnded) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      stderr.removeListener('end', done);
      stderr.removeListener('close', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    stderr.once('end', done);
    stderr.once('close', done);
  });
}

/**
 * Resolve a terminal and spawn it detached, running `bash -lc <oneliner>`.
 * A login shell (`-l`) is used so the user's profile (cargo PATH etc.) is in
 * scope for whatever the one-liner exec's. The child is `unref`'d so it
 * outlives the request.
 *
 * After a successful spawn, WATCHES the child for an early death (see
 * `earlyExitProbeMs` above) and reports the verdict as `likelyOpened`, with
 * `failureReason` + `stderr` naming the cause — callers should surface a
 * warning rather than a flat success when it comes back false, since the spawn
 * syscall not throwing is NOT proof a window opened.
 */
export async function spawnInTerminal(opts: SpawnInTerminalOpts): Promise<SpawnInTerminalResult> {
  const term = findTerminal(opts.env ?? process.env, opts.desktopEnvProbes);
  if (!term) {
    return {
      ok: false,
      code: 'no_terminal',
      error:
        'no terminal emulator found. Set $TERMINAL or install gnome-terminal / konsole / alacritty / kitty / wezterm / xterm',
    };
  }
  try {
    const child = spawn(term.bin, [...term.args, 'bash', '-lc', opts.oneliner], {
      detached: true,
      // stderr is PIPED, not ignored: a silent launch failure exits 0 (see
      // TERMINAL_CONTEXT_ENV_KEYS), so the diagnostic line is the only evidence
      // there is, and `stdio:'ignore'` threw it away. stdin/stdout stay ignored —
      // the window owns those.
      stdio: ['ignore', 'ignore', 'pipe'],
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      env: scrubTerminalContextEnv(opts.env ?? process.env),
    });
    child.unref();
    const pid = child.pid;
    // Bounded: we only ever want the first line or two of a startup complaint,
    // and this buffer must not grow with a window that stays open for hours.
    //
    // Decoded through the shared StringDecoder-backed collector, NOT
    // `String(chunk)` (WI-6728): a multi-byte UTF-8 character split across two
    // 'data' events decodes to replacement characters under String(), silently
    // corrupting the text. That matters more here than almost anywhere else —
    // this capture exists precisely because a silent launch failure exits 0, so
    // the diagnostic line it holds is the ONLY evidence there is, and a
    // corrupted one is indistinguishable from a genuinely odd error message.
    //
    // The cap is enforced by DETACHING once saturated rather than by an `if`
    // guard inside the handler: the collector owns its own accumulation, and
    // detaching is also what stops it growing for a window that then stays open
    // for hours (the same thing the liveness branch below does on success).
    child.stderr?.on('error', () => {});
    const stderrOut = createTextCollector(child.stderr);
    child.stderr?.on('data', () => {
      if (stderrOut.bytes >= STDERR_CAPTURE_LIMIT) {
        child.stderr?.removeAllListeners('data');
        child.stderr?.resume();
      }
    });
    let likelyOpened = true;
    let failureReason: string | null = null;
    const probeMs = opts.earlyExitProbeMs ?? EARLY_EXIT_PROBE_MS;
    if (probeMs > 0) {
      // NOTE the missing `pid != null` guard, which the old sleep-then-poll
      // shape needed and this one must NOT have: when the emulator binary does
      // not exist, Node reports it via an async `'error'` event and `child.pid`
      // is undefined, so the old guard SKIPPED the check entirely and reported
      // `likelyOpened:true` for a process that never started. watchEarlyExit
      // listens for that event, so the least ambiguous failure there is now
      // reaches the caller instead of being the one case that fails open.
      const early = await watchEarlyExit(child, probeMs);
      if (early?.error) {
        // classifyEarlyExit reasons about exit codes and cannot express "the
        // binary never ran" — answer it here rather than smuggling it in as a
        // synthetic exit code (same split console-spawn makes).
        likelyOpened = false;
        failureReason = `spawn ${term.bin} failed: ${early.error.message} (the emulator binary never ran)`;
      } else if (early) {
        const verdict = classifyEarlyExit(term.args, early.code, early.signal);
        likelyOpened = !verdict.failed;
        if (verdict.failed) failureReason = `${term.bin} died ${verdict.why} within ${probeMs}ms`;
      }
      // Only on the failure path, and only for as long as it takes the pipe to
      // deliver what it already has — see STDERR_FLUSH_GRACE_MS.
      if (!likelyOpened) await flushStderr(child, STDERR_FLUSH_GRACE_MS);
    }
    if (likelyOpened) {
      // The window is up and may live for hours. Stop accumulating, but do NOT
      // destroy the pipe — closing the read end of a LIVE child's stderr risks
      // EPIPE/SIGPIPE in the emulator, which would kill the very window we just
      // opened. Drain it instead and unref so it cannot hold the event loop.
      child.stderr?.removeAllListeners('data');
      child.stderr?.resume();
      (child.stderr as unknown as { unref?: () => void })?.unref?.();
    } else {
      // Dead child ⇒ nothing left to receive a broken pipe, so this is safe.
      child.stderr?.destroy();
    }
    const tail = stderrOut.text().trim().slice(0, STDERR_CAPTURE_LIMIT);
    return {
      ok: true,
      terminal: term.bin,
      pid,
      likelyOpened,
      ...(!likelyOpened && tail ? { stderr: tail } : {}),
      ...(!likelyOpened && failureReason ? { failureReason } : {}),
    };
  } catch (e: any) {
    return { ok: false, code: 'spawn_failed', error: `spawn ${term.bin} failed: ${e?.message}` };
  }
}
