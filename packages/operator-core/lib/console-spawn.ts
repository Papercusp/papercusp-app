/**
 * console-spawn.ts — the shared, server-side "open a native terminal window and
 * run a one-liner in it" primitive.
 *
 * This was extracted out of the `/api/agent-mcp/console/launch` route so it can
 * be reused without duplication by:
 *   - the superuser-console launcher route (the global "+" button)  → writeMcpJson:true
 *   - the `capability:terminal` agent tool (run an arbitrary command) → writeMcpJson:false
 *
 * One spawner, two callers. The OS-native new-window logic (Linux terminal
 * cascade, the OSC recolor/retitle prelude, the sentinel-file lifecycle) lives
 * here; each caller supplies a {@link ConsoleEnvelope} (built by
 * `buildConsoleEnvelope`) and decides whether the superuser `.mcp.json` should
 * be displaced into the cwd.
 *
 * Linux + macOS spawn server-side here; Windows does not. On macOS the operator
 * (a child of the desktop .app, in the user's GUI session) opens Terminal/iTerm
 * itself via `open -na` — mirroring the Linux child_process path, so fleet color
 * schemes + the sentinel lifecycle work identically. On Windows the operator runs
 * inside WSL and cannot spawn a Windows GUI terminal itself; the spawn must
 * happen in the Session-1 desktop shell via the Tauri `console_launch` command
 * (papercusp-desktop/src-tauri/src/native_console.rs). Two ways there:
 *   - user path ("+" button): {@link spawnConsole} returns `code:501` and
 *     native-console.ts's renderer fallback invokes `console_launch` directly;
 *   - agent path (WI-3289, `allowDesktopBridge`): {@link spawnConsole} relays
 *     the envelope to the desktop webview over the sync-bus bridge
 *     (lib/console-launch-bridge.ts) and awaits the Tauri result, so
 *     capability:terminal / fleet:launch-on-plan open REAL Windows terminals.
 *
 * Server-only.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConsoleEnvelope } from './console-launcher';
import type { ColorScheme } from './console-color-schemes';
// WI-37920 / P-001: plain-ESM shared module — psu-launcher.mjs (bare `node`,
// cannot import TypeScript) imports the SAME definitions, so detection and
// injection can never drift apart. See backend-bin-resolve.mjs's header.
import { SPAWN_PATH_DIRS_ENV, decodeSpawnPathDirs } from './backend-bin-resolve.mjs';
import { isWindowsDesktopHost } from './windows-desktop-windows';
import { requestDesktopConsoleLaunch } from './console-launch-bridge';
// task-manager P-009 follow-up: the HEADLESS path enrols (see
// buildHeadlessSpawnCommand's doc for why this file's windowed path does not).
import { scrubTerminalContextEnv } from './terminal-spawn';
import { CLIENT_SERVER_TERMINALS, PROCESS_PER_WINDOW_TERMINALS } from './linux-terminals';
import { beginSyncEnrolment, completeSyncEnrolment } from './task-manager/enroll-sync';
import { killTask } from './task-manager/control';
import { scopeUnitForTask, sliceForClass } from './task-manager/types';
import { warmScopeProbe } from './task-manager/managed-spawn';
import {
  agentSpawnScopeMemoryMaxG,
  SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS,
  userManagerBusReachable,
} from './systemd-scope';

/** Shared with psu-pty-host.mjs; kept as a literal here because this TypeScript
 * module is also imported by the launcher-side plain-ESM boundary. */
export const HEADLESS_NORMALIZED_LOG_ENV = 'PAPERCUSP_PSU_HEADLESS_NORMALIZED_LOG';
export const HEADLESS_AGENT_TERM = 'xterm-256color';

/**
 * Headless agents still run an interactive CLI inside the managed pty. A service
 * environment commonly supplies TERM=dumb (or no TERM at all), which Codex
 * refuses before it can register its session. Preserve a caller's supported
 * terminal type, but give headless launches a real terminal capability when the
 * inherited value cannot drive an interactive CLI.
 */
export function normalizeHeadlessAgentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = scrubTerminalContextEnv(env);
  return normalizeHeadlessAgentTerm(out);
}

/** Apply only the interactive-terminal correction to an already-scrubbed env. */
export function normalizeHeadlessAgentTerm(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  if (!out.TERM || out.TERM.toLowerCase() === 'dumb') out.TERM = HEADLESS_AGENT_TERM;
  return out;
}

warmScopeProbe();

// ─── Linux terminal selection ────────────────────────────────────────
//
// The two GROUPS (and why the split is load-bearing) now live in
// ./linux-terminals, shared with terminal-spawn.ts — there used to be two copies
// of this table and a fix to one silently missed the other
// (EI-19385011811175105 → EI-19407722209410974). The SELECTION POLICY below is
// still this file's own: it is conditional on whether a desktop session was
// actually resolved (WI-4718), which terminal-spawn's flat walk is not.

function isOnPath(bin: string): boolean {
  const paths = (process.env.PATH ?? '').split(':');
  paths.push('/usr/bin', '/usr/local/bin');
  return paths.some((p) => existsSync(join(p, bin)));
}

/**
 * Pure terminal selection given a PATH-membership probe. Normally, preference is
 * an explicit `$TERMINAL` (the user's own choice, honored as-is); then, driven by
 * `preferClientServer`, either the standard desktop terminals first
 * (gnome-terminal/konsole/xfce4 — chosen when a real desktop session was detected
 * and its D-Bus bus resolved, so they reliably open the owner's standard window)
 * or the process-per-window emulators first (chosen when NO desktop session is
 * reachable — a bare Xvfb/sandbox — where a client-server terminal would ghost).
 * The other group is appended as a fallback. `requireProcessPerWindow` is a hard
 * constraint for agent launches that must not share a client-server terminal:
 * it limits both `$TERMINAL` and fallback selection to that group. Exported (with
 * an injectable `onPath`) so the ordering is unit-testable without depending on
 * whatever the host happens to have installed. (WI-4718, EI-24381225643823469)
 */
export function pickLinuxTerminal(
  onPath: (bin: string) => boolean,
  preferClientServer = false,
  requireProcessPerWindow = false,
): { bin: string; args: string[] } | null {
  const fromEnv = process.env.TERMINAL;
  const processPerWindowEnv = PROCESS_PER_WINDOW_TERMINALS.find(([bin]) => bin === fromEnv);
  if (fromEnv && onPath(fromEnv) && (!requireProcessPerWindow || processPerWindowEnv)) {
    if (requireProcessPerWindow && processPerWindowEnv) {
      return { bin: fromEnv, args: [...processPerWindowEnv[1]] };
    }
    return fromEnv === 'gnome-terminal'
      ? { bin: fromEnv, args: ['--wait', '--'] }
      : { bin: fromEnv, args: ['-e'] };
  }
  const order = requireProcessPerWindow
    ? [...PROCESS_PER_WINDOW_TERMINALS]
    : preferClientServer
      ? [...CLIENT_SERVER_TERMINALS, ...PROCESS_PER_WINDOW_TERMINALS]
      : [...PROCESS_PER_WINDOW_TERMINALS, ...CLIENT_SERVER_TERMINALS];
  for (const [bin, args] of order) {
    if (onPath(bin)) return { bin, args: [...args] };
  }
  return null;
}

// Cache the terminal selection — the underlying set doesn't change at runtime
// (terminal binaries don't appear/disappear), and the existsSync sweep was adding
// noticeable latency to every console launch. Keyed by both selection flags
// because a strict process-per-window request must never reuse an ordinary
// launch's cached client-server result.
const cachedTerminal: Map<string, { bin: string; args: string[] } | null> = new Map();
export function findLinuxTerminal(
  preferClientServer = false,
  requireProcessPerWindow = false,
): { bin: string; args: string[] } | null {
  const cacheKey = `${preferClientServer}:${requireProcessPerWindow}`;
  const cached = cachedTerminal.get(cacheKey);
  if (cached !== undefined) return cached;
  const picked = pickLinuxTerminal(isOnPath, preferClientServer, requireProcessPerWindow);
  cachedTerminal.set(cacheKey, picked);
  return picked;
}

/** Test-only: clear the memoized terminal so a test can re-resolve after stubbing
 *  $TERMINAL. Without this, findLinuxTerminal() caches whatever the host had at
 *  first call — so the early-exit-probe tests (which mock `spawn` but need the
 *  resolver to return non-null) passed on a box with a terminal emulator installed
 *  and failed on a headless one (packaged install / CI runner) with "no terminal
 *  emulator found". */
export function _resetTerminalCacheForTests(): void {
  cachedTerminal.clear();
}

/**
 * EI-11578: resolve the `preferClientServer` value {@link findLinuxTerminal}
 * receives, folding in whether the caller wants a PROCESS-PER-WINDOW emulator
 * forced.
 *
 * The base preference is `desktopSessionDetected` (WI-4718: a reachable desktop
 * session ⇒ prefer the owner's standard gnome-terminal/konsole). But a RESUME (or
 * fork) of a dormant session is the one launch type that DROPS under a
 * client-server terminal's VTE pty: `capability:launch-agent { resume }` opened a
 * gnome-terminal window whose resumed claude died within seconds (the reattached
 * psu managed-pty host does not survive gnome-terminal-server's pty/env handoff),
 * while the IDENTICAL psu command under xterm — a process-per-window emulator that
 * binds the pty directly — held the session for >72s through
 * resume+compaction+turn-end. So when `preferProcessPerWindow` is set (the
 * resume/fork launches), force the process-per-window ordering EVEN on a detected
 * desktop session: the owner gets a LIVE resumed session in an xterm/alacritty
 * window instead of a dead one in their standard terminal (the window itself
 * always stays open — buildConsoleOneliner execs a login shell after the greeting
 * — so the visible-drop is specifically the resumed agent process, not the
 * window). Pure; exported for unit tests.
 */
export function resolveTerminalPreference(
  desktopSessionDetected: boolean,
  preferProcessPerWindow: boolean,
): boolean {
  return desktopSessionDetected && !preferProcessPerWindow;
}

// WI-4272: emulators that honor the DISPLAY env var for window placement. The
// client-server emulators (gnome-terminal, konsole, xfce4-terminal) are
// deliberately EXCLUDED — their client process just asks the per-session
// server for a window, so the window opens on the SERVER's display no matter
// what DISPLAY the client was spawned with. Only these process-per-window
// emulators can be pointed at a specific (sandbox/demo-stage) X display.
const DISPLAY_HONORING_TERMINALS: Array<[string, string[]]> = [
  ['xterm', ['-e']],
  ['alacritty', ['-e']],
  ['kitty', ['--']],
  ['wezterm', ['start', '--always-new-process', '--']],
];

let cachedDisplayHonoringTerminal: { bin: string; args: string[] } | null | undefined;
/**
 * WI-4272: like {@link findLinuxTerminal}, but restricted to DISPLAY-honoring
 * emulators — used by spawnConsole's `displayOverride` (demo-stage) path.
 * $TERMINAL is honored ONLY when it names one of the DISPLAY-honoring
 * candidates (a $TERMINAL=gnome-terminal must NOT hijack an override spawn —
 * its window would land on the seat, silently defeating the override).
 */
export function findDisplayHonoringTerminal(): { bin: string; args: string[] } | null {
  if (cachedDisplayHonoringTerminal !== undefined) return cachedDisplayHonoringTerminal;
  const fromEnv = process.env.TERMINAL;
  if (fromEnv) {
    const candidate = DISPLAY_HONORING_TERMINALS.find(([bin]) => bin === fromEnv);
    if (candidate && isOnPath(fromEnv)) {
      cachedDisplayHonoringTerminal = { bin: candidate[0], args: [...candidate[1]] };
      return cachedDisplayHonoringTerminal;
    }
  }
  for (const [bin, args] of DISPLAY_HONORING_TERMINALS) {
    if (isOnPath(bin)) {
      cachedDisplayHonoringTerminal = { bin, args: [...args] };
      return cachedDisplayHonoringTerminal;
    }
  }
  cachedDisplayHonoringTerminal = null;
  return cachedDisplayHonoringTerminal;
}

/** Test-only: reset (no arg) or SEED (explicit value) the display-honoring
 *  terminal memo. Seeding exists because {@link isOnPath} unconditionally
 *  checks /usr/bin — a "no emulator installed" case cannot be simulated by
 *  stubbing $PATH on a box that has xterm, so tests seed `null` instead. */
export function _resetDisplayHonoringTerminalCacheForTests(
  ...seed: [] | [{ bin: string; args: string[] } | null]
): void {
  cachedDisplayHonoringTerminal = seed.length === 0 ? undefined : seed[0];
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Optionally displace the caller's `.mcp.json` and atomically install the
 * launch envelope's MCP configuration in the session cwd.
 *
 * The visible and headless agent launch paths share this writer so a
 * no-window agent gets the same MCP auto-discovery contract as a terminal
 * agent. Callers that run arbitrary commands keep the default opt-out.
 */
/**
 * Does this `.mcp.json` body carry a SIGNED, single-agent spawn capability?
 *
 * `role-launch-spec.ts` signs a role's MCP URL with `signSpawnParams`, which
 * stamps `sig=` (alongside `run=` / `spawn=` / `client=role-…`) into the query.
 * That URL authenticates as exactly ONE agent and is non-repudiable, so it must
 * never be materialized where another session can discover it.
 *
 * `sig=` is the exact discriminator, and it cannot fire on the legitimate cwd
 * writers: the superuser console door (`buildSuperuserMcpUrl`) is unsigned and
 * carries its bearer in `headers`, and the user-level door templates its client
 * as `${PAPERCUSP_SID}`, resolved per session.
 */
function isSignedSingleAgentMcpConfig(contents: string): boolean {
  return /[?&]sig=[^&"'\s]+/.test(contents);
}

function writeMcpJsonFile(envelope: ConsoleEnvelope, enabled: boolean): string | null {
  if (!enabled || !envelope.mcpJsonContents) return null;

  // EI-23765667869335651: a signed single-agent door must NOT be written into a
  // shared checkout. `bootstrap-role.ts` already enforces this for its own write
  // ("a role launch must never materialize a signed, single-agent config in
  // spec.cwd"); this is that same invariant at the SHARED writer, so no current
  // or future caller can reintroduce the leak by passing writeMcpJson:true.
  //
  // WHY IT MATTERS: a superuser session supplies NO `--mcp-config`
  // (desktop-install/claude-integration.ts), so claude AUTO-DISCOVERS
  // `<cwd>/.mcp.json`. A signed role door left at the repo root therefore becomes
  // a second `papercusp` door on every su session in that tree, and calls through
  // it answer as the ROLE — a post-compaction coord:orient returns that role's
  // control state (modes:[], loop inactive), which reads as "your autonomy was
  // revoked" and invites a silent halt.
  //
  // Skipping is safe: a role session is pointed at its own copy via an explicit
  // `--mcp-config <sessionMcpDir>/.mcp.json`, so the cwd copy is redundant for
  // the role it belongs to and harmful to every other session in the checkout.
  if (isSignedSingleAgentMcpConfig(envelope.mcpJsonContents)) {
    console.warn(
      `[console-spawn] refusing to write a signed single-agent .mcp.json into ${envelope.cwd} — ` +
        `it would be auto-discovered by every session in that checkout. A signed door belongs in a ` +
        `per-session dir passed via --mcp-config (see bootstrap-role.ts).`,
    );
    return null;
  }

  try {
    const mcpPath = join(envelope.cwd, '.mcp.json');
    if (existsSync(mcpPath)) {
      const bak = join(envelope.cwd, '.mcp.json.papercusp.bak');
      if (!existsSync(bak)) renameSync(mcpPath, bak);
    }
    // Atomic write via temp-file + rename instead of a direct writeFileSync.
    // WHY (owner-hit 2026-07-11: resume/fork consoles failed with HTTP 500
    // "write .mcp.json: EACCES"): the one-shot backup above is guarded by
    // `!existsSync(bak)`, so once a `.mcp.json.papercusp.bak` exists the stale
    // `.mcp.json` is NOT moved aside — and if that stale file is read-only
    // (a 0444 .mcp.json had been sitting at the repo root), the in-place
    // `writeFileSync(mcpPath, …)` opens it O_WRONLY and throws EACCES, so
    // EVERY console launch (resume, fork, and the "+" button) 500'd. A rename
    // only needs write permission on the DIRECTORY (which we have) — it
    // replaces the directory entry regardless of the target file's mode — so
    // this succeeds over a read-only .mcp.json, is atomic against concurrent
    // launches, and lands the fresh file at the default 0644 (self-healing the
    // read-only state). tmp lives in the same dir so the rename stays on one fs.
    const tmp = join(
      envelope.cwd,
      `.mcp.json.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`,
    );
    writeFileSync(tmp, envelope.mcpJsonContents);
    try {
      renameSync(tmp, mcpPath);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        /* best-effort temp cleanup */
      }
      throw e;
    }
  } catch (e: any) {
    return `write .mcp.json: ${e?.message}`;
  }

  return null;
}

// ─── Terminal appearance (OSC color/title) ───────────────────────────

export interface AppearanceOpts {
  mode: 'omp' | 'console';
  planSlug: string | null;
  label: string | null;
  advSessionId?: number | null;
  /** A bound fleet color scheme — when set it overrides the per-plan hashed
   *  background and also drives the foreground + cursor colors. */
  scheme?: ColorScheme | null;
}

/**
 * Emit the OSC escape sequences that recolor + retitle the terminal window:
 * foreground (OSC 10), background (OSC 11), window title (OSC 0). Per-plan
 * background is hashed from the plan slug for visual identity; foreground is a
 * fixed light tone for contrast.
 *
 * Why dark backgrounds + light foreground: agent CLIs (omp / claude / codex)
 * emit ANSI bright colors designed for dark terminals — illegible on a light
 * background. Dark saturated backgrounds keep those readable while still
 * letting each plan's terminal be visually distinct at a glance.
 */
function buildAppearancePrelude(opts: AppearanceOpts): string {
  // A bound fleet scheme wins: it sets bg + fg + cursor. Otherwise fall back to
  // the per-plan hashed background + default light foreground (no cursor OSC).
  const bg = opts.scheme?.bg ?? hashSlugToColor(opts.planSlug, opts.mode);
  const fg = opts.scheme?.fg ?? '#f4f4f5'; // zinc-100 — bright but not pure white (avoids halation on dark bg)
  const title = formatWindowTitle(opts);
  const titleEsc = title.replace(/'/g, "'\\''");
  const lines = [`printf '\\033]10;${fg}\\007'`, `printf '\\033]11;${bg}\\007'`];
  if (opts.scheme?.cursor) lines.push(`printf '\\033]12;${opts.scheme.cursor}\\007'`); // OSC 12 = cursor color
  lines.push(`printf '\\033]0;${titleEsc}\\007'`);
  return lines.join(' && ');
}

/**
 * Deterministic slug → background color from a curated palette of dark,
 * saturated hues. Every color is dark enough that ANSI bright colors remain
 * readable on top. Fixed neutral fallback when planSlug is null.
 */
function hashSlugToColor(planSlug: string | null, mode: 'omp' | 'console'): string {
  if (!planSlug) return mode === 'omp' ? '#0f3a36' : '#1e1b4b';
  const palette = [
    '#1e293b', '#0f172a', '#1e1b4b', '#312e81', '#3b0764',
    '#581c87', '#831843', '#7f1d1d', '#7c2d12', '#78350f',
    '#365314', '#14532d', '#134e4a', '#164e63', '#0c4a6e',
  ];
  let h = 0;
  for (let i = 0; i < planSlug.length; i++) {
    h = ((h << 5) - h + planSlug.charCodeAt(i)) | 0;
  }
  return palette[Math.abs(h) % palette.length]!;
}

export function advSessionTitleTag(id: number | null | undefined): string {
  return id != null ? `[adv:${id}]` : '';
}

function formatWindowTitle(opts: AppearanceOpts): string {
  const tag = opts.mode === 'omp' ? 'OMP' : 'SH';
  const advTag = advSessionTitleTag(opts.advSessionId);
  const name = opts.label?.trim() || opts.planSlug;
  return name ? `${tag}${advTag}: ${name}` : `${tag}${advTag}`;
}

// ─── The launcher one-liner ──────────────────────────────────────────

/**
 * Build the bash one-liner the terminal runs as its first command:
 *   appearance → cd → env exports → sentinel + EXIT-trap → (greeting) → exec shell
 *
 * The `greeting` (for capability:terminal, the user's arbitrary command) is
 * carried as a shell-escaped literal that a subshell `eval`s, then control
 * hands to an interactive login shell — so the command runs (quotes and all)
 * and the window STAYS OPEN.
 * The sentinel file lets the Rust/Tauri side detect when the user's shell exits
 * (the terminal launcher's own pid exits in ~1s, so we fingerprint via the fs).
 */
/**
 * The `export PATH=…` line of the launcher prelude — the whole reason a spawned
 * window can run `psu`, and (WI-37920 / P-001) the backend CLI psu then has to
 * exec. Returns null when there is nothing to add.
 *
 * TWO HALVES, ordered DIFFERENTLY on purpose:
 *
 *  • PREPENDED — `PAPERCUSP_BIN_DIR` (the writable psu/ptool shims) then
 *    `PAPERCUSP_SCRIPTS_DIR` (bundled scripts). These are papercusp's OWN
 *    commands; a user shim must win over a same-named bundled script, and both
 *    must win over anything else called `papercup` on the box.
 *  • APPENDED — the backend-CLI dirs the OPERATOR resolved
 *    ({@link SPAWN_PATH_DIRS_ENV}, filled by `buildConsoleEnvelope` because only
 *    the operator process has the full environment; this window does not — see
 *    backend-bin-resolve.mjs for why a desktop-spawned terminal loses
 *    ~/.bun/bin, nvm, brew and friends).
 *
 * The append is deliberate and is the load-bearing distinction. Injecting these
 * is a SAFETY NET for an env that cannot see them — not a claim that the
 * operator's copy of a tool should beat the one the user put on their own PATH.
 * Prepending would silently re-point a user's `claude`/`node`/`bun` at whatever
 * the operator happened to resolve: a worse bug than the one being fixed, and an
 * invisible one.
 *
 * Exported + pure (env in, string out) so the produced line can be EXECUTED in a
 * test under a stripped environment. That matters more than it looks: the
 * original defect had a green detection test and a dead terminal, because
 * `omp` is `#!/usr/bin/env bun` and nothing tested that the emitted PATH made
 * `bun` reachable too.
 */
export function buildPathExport(env: Record<string, string>): string | null {
  const pathPrepend = [env.PAPERCUSP_BIN_DIR, env.PAPERCUSP_SCRIPTS_DIR].filter(Boolean) as string[];
  const pathAppend = decodeSpawnPathDirs(env[SPAWN_PATH_DIRS_ENV]);
  if (!pathPrepend.length && !pathAppend.length) return null;
  const segments = [
    ...pathPrepend.map((d) => shellEscape(d)),
    '${PATH}',
    ...pathAppend.map((d) => shellEscape(d)),
  ];
  return `export PATH=${segments.join(':')}`;
}

/**
 * Stamp the birth identity of the shell that owns the visible console.
 *
 * The orphan-window closer validates both the Papercusp harness marker and this
 * kernel-backed identity before it sends a signal. Keep this in lockstep with
 * native_console.rs: Linux uses boot-id + /proc start time, while macOS uses
 * the normalized `ps lstart` value consumed by readProcessIdentity().
 */
function buildConsoleIdentityExport(): string {
  const identity = [
    'PAPERCUSP_CONSOLE_IDENTITY="$(',
    'if [ -r /proc/sys/kernel/random/boot_id ] && [ -r /proc/$$/stat ]; then',
    `printf 'linux:%s:%s' "$(cat /proc/sys/kernel/random/boot_id)" "$(awk '{print $22}' /proc/$$/stat)";`,
    'else',
    `papercusp_started="$(ps -o lstart= -p $$ 2>/dev/null | awk '{$1=$1; print}')";`,
    `[ -n "$papercusp_started" ] && printf 'darwin:%s' "$papercusp_started";`,
    'fi; true',
    ')"',
  ].join(' ');
  return `${identity} && export PAPERCUSP_CONSOLE_IDENTITY`;
}

export function buildConsoleOneliner(
  cwd: string,
  env: Record<string, string>,
  greeting: string,
  appearance: AppearanceOpts,
  /**
   * EI-19330040718883562: when set, also `tee -a` the greeting-failure banner
   * into this path. The visible path has no artifact to poll for the sentinel
   * (it writes to a terminal, not a log file) — this gives it one, on request,
   * so `pollConsoleBootReceipt` can catch the same phantom-ok class
   * spawnHeadless's boot receipt already catches (the greeting dies, but the
   * one-liner unconditionally `exec`s a login shell afterward, so the process
   * itself never exits and the early-exit probe is structurally blind to it).
   * `undefined`/`null` (the default) is byte-identical to the pre-fix banner.
   */
  bootReceiptPath?: string | null,
  /**
   * No-window managed launches do not need a desktop liveness marker. Keeping
   * this enabled for visible consoles lets the Tauri watcher restore
   * `.mcp.json`; disabling it for headless sessions avoids writing per-process
   * runtime files into the launch cwd (which is often the shared repository).
   */
  includeLivenessSentinel = true,
  /**
   * Keep a visible terminal open after the greeting. Headless launches pass
   * false: there is no window to inspect, and retaining the login shell after
   * `psu` exits would leave a detached process consuming host resources.
   */
  keepOpen = true,
  /** Optional receipt path for the interactive tab shell's `$$` PID. */
  terminalPidReceiptPath: string | null = null,
): string {
  const envExports: string[] = [];
  const pathExport = buildPathExport(env);
  if (pathExport) envExports.push(pathExport);
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    envExports.push(`export ${k}=${shellEscape(v)}`);
  }
  const escapedCwd = shellEscape(cwd);
  const prelude = [
    buildAppearancePrelude(appearance),
    `cd ${escapedCwd}`,
    ...envExports,
    ...(includeLivenessSentinel ? [buildConsoleIdentityExport()] : []),
  ].join(' && ');
  // Visible launches run the greeting in a subshell, then ALWAYS exec an
  // interactive login shell — `;` (not `&&`) on BOTH sides of the greeting, so
  // a command that exits non-zero still leaves the window open. Headless
  // launches use the same escaped eval but exit with the greeting's status
  // instead of retaining a detached login shell.
  //
  // The greeting travels as a shellEscape'd LITERAL that a subshell `eval`s at
  // runtime — it is never spliced into the one-liner as bare syntax. The old
  // form did `(${greeting.replace(/'/g, "'\\''")})`: an escape for a
  // single-quoted context the greeting was never actually inside, so ANY
  // greeting containing a quote (e.g. fleet:launch-on-plan's shq()-quoted
  // launch-context) produced an unparseable one-liner — macOS Terminal died
  // with `bash: -c: line 0: unexpected EOF while looking for matching "'"`,
  // gnome-terminal with exit 2 (the docs-agent-ask kickoff-env workaround
  // dodged this same bug). eval-in-a-subshell also means a MALFORMED greeting
  // (unbalanced quote, trailing `#`) errors visibly inside the open window
  // instead of aborting the whole one-liner at parse time.
  // EI-19330040718883562: pipe the same printf through `tee -a` into the
  // receipt path when one was supplied, so a poller outside the terminal can
  // observe the failure — the printf itself is unchanged (the window still
  // shows it), this just ALSO persists it to disk.
  const greetingScript = keepOpen
    ? keepWindowOpenOnFailure(greeting, {
        receiptPath: bootReceiptPath,
        terminalPidReceiptPath,
        interactivePrelude: includeLivenessSentinel
          ? `touch .papercup-console-active.$$; ` +
            `trap 'rm -f .papercup-console-active.$$' EXIT`
          : null,
      })
    : runCommandAndExit(greeting, { receiptPath: bootReceiptPath });
  return `${prelude} ; ${greetingScript}`;
}

/**
 * Run a headless greeting and terminate with its status. A detached headless
 * member has no window that needs to remain open; if the greeting's agent
 * process exits, retaining a shell here would create a live-but-useless task
 * that consumes host resources and hides the real failure from the process
 * liveness probe.
 */
function runCommandAndExit(command: string, opts?: { receiptPath?: string | null }): string {
  const receiptTee = opts?.receiptPath ? ` | tee -a ${shellEscape(opts.receiptPath)}` : '';
  return [
    `(eval ${shellEscape(command)})`,
    `__papercusp_greeting_rc=$?`,
    `if [ "$__papercusp_greeting_rc" -ne 0 ]; then ` +
      `printf '\\n[papercusp] initial terminal command exited with status %s; headless launch exiting.\\n' ` +
      `"$__papercusp_greeting_rc"${receiptTee}; ` +
      `fi`,
    `exit "$__papercusp_greeting_rc"`,
  ].join('; ');
}

/**
 * Wrap a command so that when it FAILS the window stays open showing why,
 * instead of closing the instant the command dies.
 *
 * The shape — `(eval '<cmd>'); <banner> ; exec "$SHELL" -l` — is load-bearing
 * in three separate ways, which is exactly why this is a shared helper and not
 * a string every caller retypes:
 *
 *  - `;` (never `&&`) on BOTH sides of the command, so a non-zero exit still
 *    reaches the banner and the trailing `exec`. An `&& exec` closes the window
 *    on precisely the failure the user needed to read.
 *  - the command travels as a shellEscape'd LITERAL that a subshell `eval`s at
 *    runtime, never spliced in as bare syntax — so a command containing quotes
 *    cannot produce an unparseable one-liner, and a MALFORMED one errors
 *    visibly inside the open window instead of aborting at parse time.
 *  - the final `exec "$SHELL" -l` is what actually holds the window open.
 *
 * WI-37743: `/adv/sessions/launch-su` (the HUD "+ New session" button) did NOT
 * use this — it emitted a bare `exec <psu …>`, so psu replaced the shell and
 * ANY boot refusal (a 409 from the freshness guard, a bad operator URL, a
 * missing token) closed the window in under a second with the message still on
 * screen for ~0 frames. The owner saw a terminal flash and a session stuck on
 * "Starting up", and the actual cause was unrecoverable from outside. Matches
 * the Rust/Tauri spawner too (native_console.rs build_launcher_oneliner).
 */
export function keepWindowOpenOnFailure(
  command: string,
  opts?: {
    receiptPath?: string | null;
    terminalPidReceiptPath?: string | null;
    interactivePrelude?: string | null;
  },
): string {
  // EI-19330040718883562: also persist the failure line to a receipt file when
  // one was supplied, so a poller OUTSIDE the terminal can observe it. The
  // printf itself is unchanged — the window still shows it.
  const receiptTee = opts?.receiptPath ? ` | tee -a ${shellEscape(opts.receiptPath)}` : '';
  const banner =
    `__papercusp_greeting_rc=$?; ` +
    `if [ "$__papercusp_greeting_rc" -ne 0 ]; then ` +
    `printf '\\n[papercusp] initial terminal command exited with status %s; terminal left open for inspection.\\n' "$__papercusp_greeting_rc"${receiptTee}; ` +
    `fi`;
  // The PID returned by child_process.spawn is the terminal emulator (or its
  // systemd-run launcher), not the interactive shell that owns the tab. Write
  // the latter from inside the interactive bash itself so fleet:kill can use
  // the same marker + birth identity it authenticates for terminal_pids.
  const terminalPidReceipt = opts?.terminalPidReceiptPath
    ? `printf '%s\\n' "$$" > ${shellEscape(opts.terminalPidReceiptPath)}; export PAPERCUSP_TERMINAL_PID="$$"`
    : null;
  const interactiveScript = [
    terminalPidReceipt,
    opts?.interactivePrelude,
    `(eval ${shellEscape(command)})`,
    banner,
    `exec "\${SHELL:-/bin/bash}" -l`,
  ]
    .filter(Boolean)
    .join('; ');

  // WI-40182: the terminal emulator starts this whole string beneath a
  // non-interactive `bash -lc`. Running the command directly in that shell
  // leaves the wrapper and its child in the SAME foreground process group, so
  // a terminal-generated Ctrl+C can SIGINT both of them. The wrapper then dies
  // before it can reach the trailing login shell and the desktop window closes.
  //
  // Make a genuinely interactive bash the terminal-holding supervisor BEFORE
  // the command starts. Interactive bash enables job control, gives the command
  // its own foreground process group, and survives Ctrl+C itself. `--rcfile`
  // lets the command run on that shell's first turn without stealing stdin from
  // the terminal. On an ordinary command exit the script still prints the
  // failure banner when needed and hands off to the user's login shell. If
  // Ctrl+C aborts rcfile execution, bash simply presents its prompt — which is
  // precisely the terminal-survival behavior the owner expects.
  return `exec bash --noprofile --rcfile <(printf '%s\\n' ${shellEscape(interactiveScript)}) -i`;
}

// ─── Desktop-env resolution + spawn verification (WI-1886) ───────────
//
// The operator commonly runs HEADLESS (a systemd user service with no DISPLAY /
// DBUS_SESSION_BUS_ADDRESS in its environment). `spawn('gnome-terminal', …)`
// then SUCCEEDS at the fork/exec layer (the binary exists → a pid is assigned),
// the client immediately dies off-screen with "Cannot open display", and the
// tool reported `ok + pid` with ZERO windows — the 2026-07-03 backlog-clearance
// launch lost all 10 member windows exactly this way. Durable fix, now three parts:
//   (a) resolveLinuxDesktopEnv(): when the operator itself has no DISPLAY,
//       resolve the interactive graphical session's env (X socket → DISPLAY,
//       /run/user/<uid>/bus → DBUS, gdm/~ Xauthority) and INJECT it; when no
//       display exists at all, FAIL LOUD before spawning anything.
//   (b) an early-exit probe: after spawning, watch the child briefly — a
//       desktop-terminal client that dies within the probe window (nonzero, or
//       zero under gnome-terminal --wait, whose client lives as long as the
//   (c) EI-8289: prefer the OWNER's REAL logged-in seat (resolved via `who`,
//       socket-file-independent) over a raw `/tmp/.X11-unix` socket scan. A
//       GNOME/XWayland real seat frequently has NO `/tmp/.X11-unix/X<N>` file
//       for its DISPLAY (`-nolisten local`-style setups only expose an abstract
//       socket), while a sandbox/frame Xvfb (leased per-hive/bee, or the
//       hive-frame-desktops pool) ALWAYS creates one. Blind socket-scanning
//       therefore (i) wrongly treats the real seat's already-correct DISPLAY as
//       "stale" (WI-2840's own liveness check) and (ii) then picks a virtual
//       Xvfb display instead — the launch reports "terminals opened" while the
//       owner's real desktop never sees them (EI-8289: 2026-07-06 fleet
//       behavior-probe, `fleet:launch-on-plan` windows landed on Xvfb `:93`
//       instead of the owner's real `:1`). `who`'s TTY column reports the
//       DISPLAY value directly for an X session and needs no socket file, so it
//       is checked FIRST — both before discarding an already-set DISPLAY as
//       stale, and before falling back to the socket scan. The socket scan is
//       now a last resort (no real seat found at all — a genuinely headless
//       box), and a virtual fallback is disclosed via `warnings` /
//       `resolvedVia`, never silent.
//       window) never opened a window → FAIL LOUD with its captured stderr.

/** How long to watch a just-spawned terminal for an early death. A real
 *  interactive window outlives this comfortably; a display-less client dies
 *  well inside it. */
export const EARLY_EXIT_PROBE_MS = 1200;

export interface DesktopEnvResolution {
  /** Extra env to inject into the terminal spawn ({} when the operator's own
   *  env is already desktop-complete). */
  env: Record<string, string>;
  /** False ⇒ no display could be resolved — spawning would ghost. */
  resolved: boolean;
  error: string | null;
  /**
   * WI-2840: non-fatal healing notes — set when an already-present DISPLAY /
   * XAUTHORITY value was found to be STALE (its socket/file no longer exists)
   * and was overridden by a freshly re-resolved one instead of being trusted
   * blindly. Empty when nothing needed healing. Callers should log these
   * loudly: a long-lived process silently carrying a poisoned value is
   * exactly what wedged desktop-terminal spawns until an operator restart
   * (the staging-operator incident this ticket was filed from). Also carries
   * an EI-8289 disclosure note when DISPLAY was resolved via the last-resort
   * socket scan (no real logged-in seat was found) — that display MAY be a
   * virtual/sandbox one rather than the owner's real desktop.
   */
  warnings: string[];
  /**
   * EI-8289: how the resolved DISPLAY was determined — `'operator-env'` (the
   * caller's own env was already correct, whether or not its socket file
   * exists), `'active-seat'` (no usable env DISPLAY; resolved from a REAL
   * logged-in seat via `who`), or `'socket-scan'` (last resort: no real seat
   * detected at all, so a virtual/sandbox display's socket file won by
   * default). `'active-seat'` is preferred over `'socket-scan'` precisely
   * because a sandbox/frame Xvfb always creates a socket file while a real
   * XWayland seat often does not — blind socket-scanning silently favors the
   * wrong one otherwise. `null` when `resolved` is false.
   */
  resolvedVia: 'operator-env' | 'active-seat' | 'socket-scan' | null;
  /**
   * WI-4718: true when a real interactive desktop session was detected (the
   * operator's own env already carried a DBUS_SESSION_BUS_ADDRESS, or a live
   * gnome-terminal-server/gnome-shell was found and its bus resolved). Drives
   * terminal preference: true ⇒ prefer the owner's STANDARD client-server
   * terminal (gnome-terminal/konsole, which will reach its server on the
   * injected bus); false ⇒ no reachable session (bare Xvfb/sandbox), so prefer a
   * reliable process-per-window emulator that binds DISPLAY directly.
   */
  desktopSessionDetected: boolean;
  /**
   * WI-4718: how DBUS_SESSION_BUS_ADDRESS was determined — 'operator-env' (the
   * caller already had one), 'session-scan' (resolved from a live desktop-session
   * process), 'user-bus' (fell back to /run/user/<uid>/bus), or null (none
   * injected / not applicable). Disclosure only; callers key behavior off
   * `desktopSessionDetected`.
   */
  dbusVia: 'operator-env' | 'session-scan' | 'user-bus' | null;
}

/** Extract the `/tmp/.X11-unix/X<N>` socket path a DISPLAY value points at.
 *  Handles `:N`, `:N.M`, and `host:N.M` forms; null when unparseable. */
function socketPathForDisplay(display: string): string | null {
  const m = /:(\d+)(?:\.\d+)?$/.exec(display);
  return m ? `/tmp/.X11-unix/X${m[1]}` : null;
}

/** Injectable fs probes so the resolver is unit-testable without a desktop. */
export interface DesktopEnvProbes {
  existsSync: (p: string) => boolean;
  readdirSync: (p: string) => string[];
  uid: number;
  home: string;
  /**
   * EI-8289: the OWNER's currently logged-in X seat display(s), socket-file
   * INDEPENDENT (resolved via `who`, not `/tmp/.X11-unix`). Optional + defaults
   * to `[]` when omitted (existing callers/tests that predate this probe fall
   * through to the socket scan exactly as before — fully backward compatible).
   * Ascending-sorted; production implementation is best-effort (never throws).
   */
  activeSeatDisplays?: () => string[];
  /**
   * WI-4718: the D-Bus session bus address of the owner's live desktop session
   * (read from a running gnome-terminal-server / gnome-shell for `display`), or
   * null when no desktop session is detected. Optional + defaults to a no-op
   * (`() => null`) when omitted, so existing callers/tests fall through to the
   * systemd-user-bus behavior exactly as before. Best-effort; never throws.
   */
  sessionBus?: (display: string | null) => string | null;
}

/**
 * EI-8289: parse `who`'s TTY column for real X-session displays. An X login
 * reports its DISPLAY value directly there (e.g. `dev :1  2026-07-04
 * … (:1)`), independent of whether `/tmp/.X11-unix/X<N>` exists for it — which
 * it frequently does NOT for a GNOME/XWayland real seat. Plain `who` (not
 * `who -a`) already excludes exited/dead sessions. Best-effort: any failure
 * (no `who` binary, non-Linux, timeout) returns `[]` so callers degrade to the
 * pre-existing socket-scan behavior, never throwing.
 */
function realActiveSeatDisplays(): string[] {
  try {
    const out = execFileSync('who', [], { encoding: 'utf8', timeout: 2000 });
    const displays: string[] = [];
    for (const line of out.split('\n')) {
      const tty = line.trim().split(/\s+/)[1];
      if (tty && /^:\d+$/.test(tty) && !displays.includes(tty)) displays.push(tty);
    }
    return displays.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  } catch {
    return [];
  }
}

// WI-4718: the desktop-session processes whose D-Bus session bus is the one a
// standard client-server terminal (gnome-terminal/konsole) must connect to. Ranked
// most-authoritative first: gnome-terminal-server IS the process that renders the
// gnome-terminal window, so its bus is definitively the right one whenever it's
// running; gnome-shell / gnome-session-binary / plasmashell are the always-present
// session leaders used when no terminal server is up yet (fresh session).
const DESKTOP_SESSION_PROCS = [
  'gnome-terminal-server',
  'gnome-shell',
  'gnome-session-binary',
  'plasmashell',
];

/** Read a process's environ as a map (empty on any error — e.g. EACCES for a
 *  different-uid process, or the pid exiting mid-read). */
function readProcEnviron(pid: string): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const raw = readFileSync(`/proc/${pid}/environ`, 'utf8');
    for (const kv of raw.split('\0')) {
      const eq = kv.indexOf('=');
      if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
  } catch {
    /* environ unreadable — skip this pid */
  }
  return env;
}

/**
 * WI-4718: resolve the D-Bus session bus address of the owner's LIVE desktop
 * session by scanning /proc for a known desktop-session process (see
 * DESKTOP_SESSION_PROCS) and reading its DBUS_SESSION_BUS_ADDRESS. This is what a
 * client-server terminal (gnome-terminal/konsole) needs to reach its window
 * server — and it is NOT always the systemd user bus: on the dev box GNOME
 * started its own dbus-daemon at /tmp/dbus-*, so a hardcoded /run/user/<uid>/bus
 * pointed the terminal client at an empty bus and it ghosted (the invisible
 * window). Best-effort + pure-ish (reads /proc): returns the bus string, or null
 * when no desktop session is detected (a bare Xvfb / genuinely headless box) — in
 * which case the caller falls back to the systemd user bus AND prefers a
 * process-per-window terminal.
 *
 * When `display` is given, a process whose DISPLAY matches the resolved active
 * seat wins over one that doesn't (disambiguates a box with more than one
 * session). Among equal candidates, the earliest DESKTOP_SESSION_PROCS entry
 * (gnome-terminal-server → gnome-shell → …) wins.
 */
function realSessionBus(display: string | null): string | null {
  try {
    let pids: string[];
    try {
      pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n));
    } catch {
      return null;
    }
    let best: { rank: number; matchesDisplay: boolean; bus: string } | null = null;
    for (const pid of pids) {
      let comm: string;
      try {
        comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
      } catch {
        continue;
      }
      const rank = DESKTOP_SESSION_PROCS.indexOf(comm);
      if (rank < 0) continue;
      const env = readProcEnviron(pid);
      const bus = env.DBUS_SESSION_BUS_ADDRESS;
      if (!bus) continue;
      const matchesDisplay = display != null && env.DISPLAY === display;
      // Prefer a display match, then the most-authoritative process rank.
      const better =
        best === null ||
        (matchesDisplay && !best.matchesDisplay) ||
        (matchesDisplay === best.matchesDisplay && rank < best.rank);
      if (better) best = { rank, matchesDisplay, bus };
      // gnome-terminal-server on the matching display is as good as it gets.
      if (rank === 0 && matchesDisplay) break;
    }
    return best?.bus ?? null;
  } catch {
    return null;
  }
}

const realProbes = (): DesktopEnvProbes => ({
  existsSync,
  readdirSync: (p: string) => readdirSync(p),
  uid: process.getuid?.() ?? 1000,
  home: process.env.HOME ?? '/root',
  activeSeatDisplays: realActiveSeatDisplays,
  sessionBus: realSessionBus,
});

/**
 * Resolve the desktop-session env a GUI terminal needs, for an operator that
 * may be running headless. Pure given its probes; exported for unit tests.
 */
export function resolveLinuxDesktopEnv(
  baseEnv: Record<string, string | undefined> = process.env,
  probes: DesktopEnvProbes = realProbes(),
): DesktopEnvResolution {
  const env: Record<string, string> = {};
  const warnings: string[] = [];
  let resolvedVia: 'operator-env' | 'active-seat' | 'socket-scan' = 'operator-env';

  // DISPLAY: trust the operator's own value — but ONLY after checking its X
  // socket still exists (WI-2840). A long-lived process (e.g. a systemd-
  // managed staging operator up for days) can carry a DISPLAY set at process
  // start whose X session has since ended (server restart, logout, socket
  // renumbered) — the value being SET is not evidence it is still LIVE.
  // Trusting it blindly is exactly what silently poisoned spawns until the
  // operator was restarted. If the socket is gone, treat it as unset and
  // re-resolve — EI-8289: but a missing socket file is ALSO what a real
  // GNOME/XWayland seat looks like (it's socket-file-less, not dead), so
  // before discarding an already-set DISPLAY, check whether `who` still
  // reports it as a currently logged-in seat and trust it if so.
  let haveDisplay = Boolean(baseEnv.DISPLAY);
  if (haveDisplay) {
    const socketPath = socketPathForDisplay(baseEnv.DISPLAY!);
    if (socketPath && !probes.existsSync(socketPath)) {
      const activeSeats = probes.activeSeatDisplays?.() ?? [];
      if (activeSeats.includes(baseEnv.DISPLAY!)) {
        // Genuinely live real seat, just socket-file-less (EI-8289) — trust it.
      } else {
        warnings.push(
          `stale DISPLAY=${baseEnv.DISPLAY} — no X socket at ${socketPath} and it is not a ` +
            'currently logged-in seat (who); re-resolving instead of trusting the inherited ' +
            'value (WI-2840/EI-8289)',
        );
        haveDisplay = false;
      }
    }
  }
  if (!haveDisplay) {
    // EI-8289: prefer the OWNER's real active login seat (who) over a blind
    // /tmp/.X11-unix socket scan. A sandbox/frame Xvfb (leased per hive/bee, or
    // the hive-frame-desktops pool) ALWAYS creates a socket file; a real
    // XWayland seat frequently does NOT — so scanning sockets alone silently
    // prefers the virtual display over the owner's real one. Only fall back to
    // the socket scan when no real seat is detected at all.
    const activeSeats = probes.activeSeatDisplays?.() ?? [];
    if (activeSeats.length > 0) {
      env.DISPLAY = activeSeats[0]!;
      resolvedVia = 'active-seat';
    } else {
      let sockets: string[] = [];
      try {
        sockets = probes
          .readdirSync('/tmp/.X11-unix')
          .filter((n) => /^X\d+$/.test(n))
          .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
      } catch {
        sockets = [];
      }
      if (sockets.length === 0) {
        return {
          env: {},
          resolved: false,
          error:
            (warnings.length ? `${warnings.join('; ')}; and ` : '') +
            'no X display: the operator has no DISPLAY and no X socket exists under /tmp/.X11-unix — ' +
            'a desktop terminal cannot open on this host (headless?). Launch from a desktop session, ' +
            'or run the command yourself in a terminal on the machine with the display. (WI-1886)',
          warnings,
          resolvedVia: null,
          desktopSessionDetected: false,
          dbusVia: null,
        };
      }
      env.DISPLAY = `:${sockets[0]!.slice(1)}`;
      resolvedVia = 'socket-scan';
      warnings.push(
        `no active login seat detected (who) — falling back to a raw X11 socket scan, which ` +
          `found DISPLAY=${env.DISPLAY}; this MAY be a virtual/sandbox display rather than the ` +
          'owner\'s real desktop (EI-8289). Verify who is actually watching if terminals opened ' +
          'this way are reported invisible.',
      );
    }
  }

  // DBUS_SESSION_BUS_ADDRESS (WI-4718): a client-server terminal
  // (gnome-terminal/konsole) opens its window via a per-session D-Bus server,
  // so it must connect to the SESSION's bus — which is NOT always the systemd
  // user bus. On the dev box GNOME started its own dbus-daemon at /tmp/dbus-*,
  // and injecting a hardcoded /run/user/<uid>/bus pointed the terminal client at
  // an empty bus with no server → it ghosted (the invisible window). So:
  //   1. scan the live session (running gnome-terminal-server/gnome-shell) for
  //      its real bus. It is authoritative even when the long-lived operator
  //      already carries a DIFFERENT bus: a logout/login can leave the operator
  //      attached to a live-but-wrong user bus whose GNOME Terminal name points
  //      at a vanished unique owner (WI-4752);
  //   2. absent a discoverable session bus, trust the operator's inherited bus;
  //   3. else fall back to the systemd user bus, but WITHOUT marking a desktop
  //      session detected (no window server known) so the caller prefers a
  //      process-per-window terminal instead.
  const runtimeDir = `/run/user/${probes.uid}`;
  let desktopSessionDetected = false;
  let dbusVia: 'operator-env' | 'session-scan' | 'user-bus' | null = null;
  const resolvedDisplay = env.DISPLAY ?? baseEnv.DISPLAY ?? null;
  const sessionBus = probes.sessionBus?.(resolvedDisplay) ?? null;
  if (sessionBus) {
    desktopSessionDetected = true;
    if (sessionBus !== baseEnv.DBUS_SESSION_BUS_ADDRESS) {
      env.DBUS_SESSION_BUS_ADDRESS = sessionBus;
      dbusVia = 'session-scan';
      if (baseEnv.DBUS_SESSION_BUS_ADDRESS) {
        warnings.push(
          'inherited DBUS_SESSION_BUS_ADDRESS does not match the live desktop-session bus; ' +
            'using the bus owned by gnome-terminal-server/gnome-shell instead (WI-4752)',
        );
      }
    } else {
      dbusVia = 'operator-env';
    }
  } else if (baseEnv.DBUS_SESSION_BUS_ADDRESS) {
    desktopSessionDetected = true;
    dbusVia = 'operator-env';
  } else if (probes.existsSync(`${runtimeDir}/bus`)) {
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runtimeDir}/bus`;
    dbusVia = 'user-bus';
  }
  if (!baseEnv.XDG_RUNTIME_DIR && probes.existsSync(runtimeDir)) {
    env.XDG_RUNTIME_DIR = runtimeDir;
  }

  // XAUTHORITY: same validate-before-trust — a set-but-vanished cookie file
  // (WI-2840) is treated as unset and re-resolved from the usual candidates.
  let haveXauth = Boolean(baseEnv.XAUTHORITY);
  if (haveXauth && !probes.existsSync(baseEnv.XAUTHORITY!)) {
    warnings.push(
      `stale XAUTHORITY=${baseEnv.XAUTHORITY} — file no longer exists; ` +
        're-resolving instead of trusting the inherited value (WI-2840)',
    );
    haveXauth = false;
  }
  if (!haveXauth) {
    const candidates = [`${runtimeDir}/gdm/Xauthority`, `${probes.home}/.Xauthority`];
    const found = candidates.find((p) => probes.existsSync(p));
    if (found) env.XAUTHORITY = found;
  }
  return { env, resolved: true, error: null, warnings, resolvedVia, desktopSessionDetected, dbusVia };
}

/**
 * Classify a terminal child's early exit (within {@link EARLY_EXIT_PROBE_MS}).
 * Pure; exported for unit tests.
 *
 * - nonzero exit / signal death ⇒ ALWAYS a failure (the client refused to run —
 *   classically "Cannot open display" / a dbus connect failure).
 * - zero exit ⇒ a failure ONLY under `--wait` semantics (gnome-terminal --wait
 *   keeps the client alive for the WINDOW's lifetime, so an instant clean exit
 *   means no window survived). Other emulators' clients may legitimately exit 0
 *   fast (konsole reusing an existing app instance) — not a failure signal.
 */
export function classifyEarlyExit(
  termArgs: string[],
  code: number | null,
  signal: string | null,
): { failed: boolean; why: string | null } {
  if (signal) return { failed: true, why: `killed by ${signal}` };
  if (code !== null && code !== 0) return { failed: true, why: `exit code ${code}` };
  if (code === 0 && termArgs.includes('--wait')) {
    return { failed: true, why: 'exited 0 instantly under --wait (no window survived)' };
  }
  return { failed: false, why: null };
}

/**
 * Watch a spawned child for an early exit OR a spawn-level failure; resolves
 * null only when it genuinely outlives the probe.
 *
 * ⚠ EI-19311623077693508 (second half): this used to listen for `'exit'` ALONE,
 * which made every caller blind to the failure mode where the child never
 * started at all. Node reports THAT as an `'error'` event (ENOENT/EACCES/EPERM
 * from the exec itself) and — for ENOENT — emits NO `'exit'`, so the promise ran
 * out its full `probeMs` and resolved null. Both call sites read null as
 * "outlived the probe ⇒ healthy" and fail OPEN, so a launch that never happened
 * was reported as a live window: `honored (1 member(s) opened)`, zero processes,
 * no error anywhere. Measured on the headless rig mac 2026-08-02 — the honor
 * path's two log lines were 1.516s apart, i.e. the full 1200ms probe plus
 * overhead, and NOT one of `no window opened` / `-10810` / `headless-fallback`
 * appeared, proving the ok-branch was taken.
 *
 * A spawn `'error'` is the LEAST ambiguous failure there is — the process does
 * not exist — so it must never reach the fail-open branch. It is surfaced as a
 * distinct `error` field rather than a synthetic exit code so callers can say
 * what actually happened instead of inventing an exit status.
 *
 * EXPORTED for terminal-spawn (WI-37743), which used to hand-roll a weaker
 * version of this — a fixed sleep followed by one `kill(pid, 0)` poll. Two
 * spawn paths judging "died at boot" by two different rules is how the HUD
 * path ended up probing ~470ms before the death it existed to catch. One
 * watcher, one classifier, one probe window.
 */
export function watchEarlyExit(
  child: ChildProcess,
  probeMs: number,
): Promise<{ code: number | null; signal: string | null; error?: Error } | null> {
  return new Promise((resolvePromise) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise(null);
    }, probeMs);
    timer.unref?.();
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolvePromise({ code, signal });
    };
    const onError = (error: Error) => {
      cleanup();
      resolvePromise({ code: null, signal: null, error });
    };
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

// ─── The spawn primitive ─────────────────────────────────────────────

export interface SpawnConsoleOpts {
  /** Envelope from `buildConsoleEnvelope` (cwd, env, greetingCmd, mcpJson…). */
  envelope: ConsoleEnvelope;
  /** Plan slug used for the per-plan window color + adv-session grouping. */
  planSlug?: string | null;
  /** Display label for the window title / adv-sessions list. */
  label?: string | null;
  /** Window-color/title mode. Default 'console'. */
  appearanceMode?: 'omp' | 'console';
  /** A bound fleet color scheme — overrides the per-plan hash for this window. */
  scheme?: ColorScheme | null;
  /**
   * WI-4272 (demo-stage): open the window on THIS X display (e.g. ':110' — a
   * computer:provision_desktop sandbox Xvfb being recorded) instead of
   * resolving the owner's seat. The display's X socket must exist (loud 412
   * otherwise), seat resolution is skipped entirely, WAYLAND_DISPLAY is
   * stripped from the spawn env (so GTK/webkit children bind X11 on the
   * override), and a DISPLAY-honoring emulator (xterm/alacritty/kitty/wezterm)
   * is required — gnome-terminal/konsole would open on the seat's server
   * regardless. Result reports desktopEnvResolvedVia:'caller-override'.
   * Linux only (ignored by the macOS / Windows-bridge paths). Default (unset):
   * byte-identical legacy behavior.
   */
  displayOverride?: string;
  /**
   * WI-3114: injectable desktop-env probes for the Linux path, threaded to
   * resolveLinuxDesktopEnv. Tests MUST pass fakes — the default (real) probes
   * read the live /tmp/.X11-unix, so a test that stubs DISPLAY without
   * controlling the socket check flakes with the box's X state (the WI-2840
   * stale-DISPLAY warn tripped vitest-fail-on-console when the /tmp wipe
   * removed X99). Production callers omit it.
   */
  desktopEnvProbes?: DesktopEnvProbes;
  /**
   * EI-19311623077693508: injectable seams for the macOS path — the
   * `/dev/console` GUI-session check and the `.command` execution receipt.
   * Tests MUST pass fakes: the suite runs on Linux, where `/dev/console` is
   * owned by root, so the real probe would (correctly) report "no GUI session"
   * and short-circuit every macOS case. Production callers omit it.
   */
  macProbes?: MacConsoleProbes;
  /**
   * EI-11578: force a PROCESS-PER-WINDOW emulator (xterm/alacritty/kitty/wezterm)
   * even when a desktop session was detected — used by capability:launch-agent's
   * RESUME/FORK path. A resumed dormant session drops under gnome-terminal's VTE
   * pty (the reattached psu managed-pty host dies), but survives under a
   * process-per-window emulator that binds the pty directly. Default false: a
   * fresh launch keeps the WI-4718 behavior (prefer the owner's standard
   * gnome-terminal on a detected session). See {@link resolveTerminalPreference}.
   * No effect on the macOS / Windows-bridge / displayOverride paths.
   */
  preferProcessPerWindow?: boolean;
  /**
   * Displace (back up + write) the envelope's superuser `.mcp.json` into the
   * cwd before spawning. The superuser console wants this so the user's agent
   * auto-discovers the MCP door; capability:terminal (run-a-command) does NOT —
   * it should not surprise the user by rewriting their project's .mcp.json.
   * Default false. A no-op when `envelope.mcpJsonContents` is empty.
   */
  writeMcpJson?: boolean;
  /**
   * WI-3289: on a Windows desktop host (operator inside WSL2), relay the spawn
   * to the desktop shell's Tauri `console_launch` command over the sync-bus
   * bridge (lib/console-launch-bridge.ts) instead of returning 501. Opt-in for
   * the AGENT-invoked callers (capability:terminal, fleet:launch-on-plan); the
   * user-facing /console/launch route keeps its 501 so native-console.ts's
   * renderer-side Tauri fallback (one hop, already shipped) stays in charge of
   * the "+" button path. Default false.
   */
  allowDesktopBridge?: boolean;
  /**
   * EI-19330040718883562: verify a boot RECEIPT (not just that the terminal
   * process survived {@link EARLY_EXIT_PROBE_MS}) before reporting ok — closes
   * the phantom-ok hole EI-19311623077693508 fixed for spawnHeadless but never
   * applied to the visible path, which `defaultSpawnMembers` tries FIRST. Adds
   * up to {@link HEADLESS_BOOT_RECEIPT_MS} of latency to the call (paid once
   * per `Promise.all` batch, not per member — same tradeoff spawnHeadless
   * already accepts). Default false/omitted: BYTE-IDENTICAL to the pre-fix
   * behavior — a human-facing launch (the "+" button, resume/fork,
   * capability:terminal) reports ok the instant the window survives the
   * early-exit probe, same as before. Opt in only where the caller actually
   * CONSUMES the ok/error verdict to decide whether a member exists (a
   * delegated/fleet member spawn) — a UI window the user visually confirms
   * themselves does not need it and should not pay its latency.
   */
  verifyBootReceipt?: boolean;
  /**
   * EI-19330040718883562: injectable seams for the boot-receipt poll (only
   * consulted when `verifyBootReceipt` is set). Tests MUST pass fakes so a
   * case can emit the sentinel deterministically instead of sleeping out the
   * real window. Production callers omit it. Mirrors
   * {@link SpawnHeadlessOpts.bootProbes}.
   */
  bootProbes?: {
    readLog?: (path: string) => string;
    sleep?: (ms: number) => Promise<void>;
    windowMs?: number;
  };
  /**
   * Capture the PID of the interactive tab shell (not the terminal emulator
   * returned as {@link SpawnConsoleResult.pid}) in an ephemeral receipt. This
   * is opt-in because it adds a bounded wait and is only useful to callers
   * that may later close an orphaned visible window. Missing receipts return
   * `terminalPid:null`; callers must never use `pid` as a fallback.
   */
  captureTerminalPid?: boolean;
  /** Injectable seams for the opt-in terminal-PID receipt poll. */
  terminalPidProbes?: {
    readReceipt?: (path: string) => string;
    sleep?: (ms: number) => Promise<void>;
    windowMs?: number;
  };
  /**
   * WI-37476 (EI-9748 Route B): injectable platform/PATH probes for
   * {@link buildConsoleScopedSpawnCommand}, mirroring
   * {@link SpawnHeadlessOpts.spawnCommandProbes}. Tests pass fakes so the
   * cgroup-escape branch is exercised deterministically instead of depending
   * on whether the CI box happens to have `systemd-run` on PATH. Production
   * callers omit it.
   */
  spawnCommandProbes?: { platform?: NodeJS.Platform; hasSystemdRun?: () => boolean };
}

export type SpawnConsoleResult =
  | {
      status: 'ok';
      pid: number | null;
      /**
       * PID of the authenticated interactive tab shell. This is distinct from
       * `pid`, which remains the terminal emulator/systemd launcher PID used
       * for process liveness. Present only when captureTerminalPid was opted in.
       */
      terminalPid?: number | null;
      terminal: string;
      /** Task-manager identity for an enrolled headless launch. Visible desktop
       *  launches do not currently have a task row at this seam. */
      taskId?: string;
      /** Durable per-session output for a headless launch. */
      logPath?: string;
      /**
       * Durable normalized companion output for a headless launch. Unlike
       * {@link logPath}, this sidecar is ANSI-free, CR-split, and line/size
       * bounded so identity diagnostics can safely read it with grep.
       */
      normalizedLogPath?: string;
      /**
       * The spawned terminal's Node handle (Linux/macOS server-side spawns) so
       * callers can attach exit watchers / adv-session bookkeeping. `null` on
       * the WI-3289 Windows desktop-bridge path — the child lives in the Rust
       * desktop-shell process, there is no Node handle to watch.
       */
      child: ChildProcess | null;
      /**
       * EI-8289: the DISPLAY the window actually opened on (Linux only; null on
       * macOS, which has no X DISPLAY concept). Callers (capability:terminal,
       * fleet:launch-on-plan) MUST surface this — a window reported as "opened"
       * on a virtual/sandbox display the owner isn't watching is a silent
       * failure of the "visible desktop terminal" contract otherwise.
       */
      display: string | null;
      /**
       * EI-8289: how `display` was resolved — 'operator-env'/'active-seat' are
       * the owner's real desktop; 'socket-scan' means NO real logged-in seat
       * was found and a raw X11 socket won by default, which MAY be a
       * virtual/sandbox display (a leased Xvfb) rather than the owner's real
       * one. 'caller-override' (WI-4272) means the caller pinned the window to
       * an explicit display via opts.displayOverride (demo-stage) — sandbox
       * placement is INTENTIONAL there, so don't flag it. null on macOS.
       * Callers should flag 'socket-scan' loudly.
       */
      desktopEnvResolvedVia: 'operator-env' | 'active-seat' | 'socket-scan' | 'caller-override' | null;
      /**
       * A persistent observation of the detached child after the initial spawn
       * probe. Headless callers use this to catch a psu that exits shortly after
       * spawnHeadless returns (the initial probe/receipt window cannot cover an
       * arbitrarily slow bootstrap). It resolves on either `exit` or spawn-level
       * `error`; it never rejects.
       */
      childExit?: Promise<SpawnChildExit>;
      /**
       * Opt-in proof that a scripted headless kickoff entered the backend's
       * native transcript. Absent for ordinary launches; callers that opt in
       * must require `persisted === true` before claiming the kickoff ran.
       */
      kickoffProof?: KickoffProofResult;
    }
  | { status: 'error'; error: string; code: number };

/** Detached-child lifecycle evidence exposed after a spawn result is returned. */
export interface SpawnChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

/** Parent-visible result for the optional detached launch-kickoff receipt. */
export interface KickoffProofResult {
  persisted: boolean;
  nativeRef: string | null;
  reason: string | null;
}

/** Environment keys for the opt-in detached kickoff proof handshake.
 *
 * These intentionally use the existing PAPERCUSP_* propagation contract: the
 * parent creates the receipt path, buildConsoleOneliner exports both values,
 * and psu-launcher preserves them through its runWrapper env merge. Keeping
 * this handshake out of psu-launcher.mjs avoids another launcher-only env
 * allowlist that could silently drop the proof.
 */
export const KICKOFF_PROOF_PATH_ENV = 'PAPERCUSP_KICKOFF_PROOF_PATH';
export const KICKOFF_PROOF_TOKEN_ENV = 'PAPERCUSP_KICKOFF_PROOF_TOKEN';

/** How long an opted-in parent waits for the detached host's proof receipt. */
export const KICKOFF_PROOF_WINDOW_MS = 30_000;

/** Injectable seams for the detached kickoff-proof receipt poll. */
export interface KickoffProofProbes {
  readReceipt?: (path: string, token: string) => string;
  sleep?: (ms: number) => Promise<void>;
  windowMs?: number;
  pollMs?: number;
}

interface KickoffProofRequest {
  path: string;
  token: string;
}

/** Create a parent-owned, single-launch receipt rendezvous. */
function createKickoffProofRequest(): KickoffProofRequest {
  const token = randomBytes(24).toString('hex');
  const path = join(
    tmpdir(),
    `papercup-kickoff-proof-${process.pid}-${Date.now()}-${randomBytes(12).toString('hex')}.json`,
  );
  const fd = openSync(path, 'wx', 0o600);
  closeSync(fd);
  // `wx` applies the mode at creation; chmod makes the invariant explicit even
  // when a host has an unusual umask or an intercepted fs implementation.
  chmodSync(path, 0o600);
  return { path, token };
}

/** Remove a proof placeholder/receipt without turning cleanup into a launch
 * failure. The host checks the placeholder before replacing it, so a timed-out
 * parent cleanup also prevents a late host from creating a new file. */
function cleanupKickoffProofRequest(request: KickoffProofRequest | null): void {
  if (!request) return;
  try { unlinkSync(request.path); } catch { /* already consumed / never created */ }
}

function parseKickoffProofReceipt(raw: string, token: string): KickoffProofResult | null {
  try {
    const receipt = JSON.parse(String(raw));
    if (!receipt || receipt.token !== token || typeof receipt.persisted !== 'boolean') return null;
    if (receipt.nativeRef !== null && typeof receipt.nativeRef !== 'string') return null;
    if (receipt.reason !== null && typeof receipt.reason !== 'string') return null;
    return {
      persisted: receipt.persisted,
      nativeRef: receipt.nativeRef ?? null,
      reason: receipt.reason ?? null,
    };
  } catch {
    return null;
  }
}

/** Poll one parent-created receipt with a bounded attempt count. The attempt
 * cap keeps injected no-op sleeps bounded in tests as well as in production. */
async function waitForKickoffProof(
  request: KickoffProofRequest,
  probes?: KickoffProofProbes,
): Promise<KickoffProofResult> {
  const readReceipt = probes?.readReceipt ?? ((path: string) => {
    try { return readFileSync(path, 'utf8'); } catch { return ''; }
  });
  const sleep = probes?.sleep
    ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); }));
  const windowMs = Math.max(0, probes?.windowMs ?? KICKOFF_PROOF_WINDOW_MS);
  const pollMs = Math.max(1, probes?.pollMs ?? 250);
  const attempts = Math.max(1, Math.ceil(windowMs / pollMs) + 1);
  for (let attempt = 0; attempt < attempts; attempt++) {
    let proof: KickoffProofResult | null = null;
    try { proof = parseKickoffProofReceipt(readReceipt(request.path, request.token), request.token); }
    catch { proof = null; }
    if (proof) return proof;
    if (attempt + 1 < attempts) await sleep(pollMs);
  }
  return { persisted: false, nativeRef: null, reason: 'kickoff-proof-timeout' };
}

/** Keep observing a detached child after the bounded early-exit probe ends. */
function observeChildExit(child: ChildProcess): Promise<SpawnChildExit> {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', (error) => resolve({ code: null, signal: null, error }));
  });
}

/**
 * EI-19330040718883562: poll `receiptPath` for the greeting-failure sentinel —
 * the visible-path sibling of {@link spawnHeadless}'s boot receipt (see
 * {@link HEADLESS_GREETING_FAILURE_RE}'s doc for why a process-exit probe is
 * structurally blind to this failure class: `buildConsoleOneliner` `exec`s a
 * login shell after the greeting no matter what, so a dead agent command never
 * shows up as a process exit). `receiptPath` is null whenever the caller did
 * not opt into verification (`SpawnConsoleOpts.verifyBootReceipt`); in that
 * case this returns immediately with no delay, matching the pre-fix behavior
 * byte-for-byte. Shared by the Linux and macOS spawn paths so the receipt
 * format / window / cleanup can't drift between them.
 */
async function pollConsoleBootReceipt(
  receiptPath: string | null,
  bootProbes: SpawnConsoleOpts['bootProbes'],
): Promise<{ status: 'error'; error: string; code: number } | null> {
  if (!receiptPath) return null;
  const readLog = bootProbes?.readLog ?? ((p: string) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return '';
    }
  });
  const sleep = bootProbes?.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms).unref?.(); }));
  const windowMs = bootProbes?.windowMs ?? HEADLESS_BOOT_RECEIPT_MS;
  const deadline = Date.now() + windowMs;
  for (;;) {
    const failed = HEADLESS_GREETING_FAILURE_RE.exec(readLog(receiptPath));
    if (failed) {
      const tail = readLog(receiptPath).trim().slice(-800);
      try {
        unlinkSync(receiptPath);
      } catch {
        /* best-effort */
      }
      return {
        status: 'error',
        error:
          `terminal window opened but its agent command died at boot (exit ${failed[1]})` +
          ' — the one-liner `exec`s a login shell after the greeting regardless, so the window' +
          ' stays open holding a DEAD session and this never surfaced as a process exit' +
          ` (EI-19330040718883562, the visible-path sibling of spawnHeadless's` +
          ` EI-19311623077693508 boot receipt)${tail ? ` — receipt tail: ${tail}` : ''}`,
        code: 502,
      };
    }
    if (Date.now() >= deadline) break;
    await sleep(250);
  }
  try {
    unlinkSync(receiptPath); // healthy launch (or nothing was ever written) — nothing to keep
  } catch {
    /* best-effort */
  }
  return null;
}

/**
 * Read the PID receipt written by the interactive tab shell. The terminal
 * emulator (and, on Linux, systemd-run) is the process returned by `spawn`,
 * but `fleet:kill` must authenticate the shell that owns the tab via its
 * marker and birth identity. Keep this poll separate from the boot-failure
 * receipt: a healthy launch has a PID line, while a failed greeting has a
 * banner, and callers need to distinguish those two contracts.
 */
async function pollTerminalPidReceipt(
  receiptPath: string | null,
  probes: SpawnConsoleOpts['terminalPidProbes'],
): Promise<number | null> {
  if (!receiptPath) return null;
  const readReceipt = probes?.readReceipt ?? ((p: string) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return '';
    }
  });
  const sleep = probes?.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms).unref?.(); }));
  const windowMs = probes?.windowMs ?? TERMINAL_PID_RECEIPT_MS;
  const deadline = Date.now() + windowMs;
  for (;;) {
    const raw = readReceipt(receiptPath).trim();
    if (/^\d+$/.test(raw)) {
      const pid = Number(raw);
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          unlinkSync(receiptPath);
        } catch {
          /* best-effort */
        }
        return pid;
      }
    }
    if (Date.now() >= deadline) break;
    await sleep(50);
  }
  try {
    unlinkSync(receiptPath);
  } catch {
    /* best-effort */
  }
  return null;
}

/**
 * Open a NEW native terminal window running the envelope's one-liner.
 *
 * Returns the spawned `child` so the caller can attach its own exit watcher /
 * adv-session bookkeeping. The child is already `unref()`'d (it outlives this
 * process). Linux-only — see the module header for the macOS/Windows boundary.
 *
 * ASYNC since WI-1886: the Linux path now resolves missing desktop env before
 * spawning and watches the child for {@link EARLY_EXIT_PROBE_MS} — an
 * `ok + pid` return now actually means a window survived the probe, never a
 * client that died off-screen.
 */
export async function spawnConsole(opts: SpawnConsoleOpts): Promise<SpawnConsoleResult> {
  const { envelope } = opts;

  // 1. Optional .mcp.json displacement (backup the user's, write ours).
  const mcpJsonError = writeMcpJsonFile(envelope, opts.writeMcpJson ?? false);
  if (mcpJsonError) {
    return { status: 'error', error: mcpJsonError, code: 500 };
  }

  // 1.5. EI-19330040718883562: mint a boot-receipt path when the caller opted
  //      in — a tee target for the SAME sentinel spawnHeadless polls a log for.
  //      null (the default) flows straight through buildConsoleOneliner to an
  //      unmodified banner, so an opted-out caller sees zero behavior change.
  const receiptPath = opts.verifyBootReceipt
    ? join(
        tmpdir(),
        `papercup-console-receipt-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.log`,
      )
    : null;
  const terminalPidReceiptPath = opts.captureTerminalPid
    ? join(
        tmpdir(),
        `papercup-console-terminal-pid-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.txt`,
      )
    : null;

  // 2. Build the one-liner once (appearance/OSC colors + cd + env + sentinel +
  //    greeting + exec login shell). Same shape on every OS.
  const oneliner = buildConsoleOneliner(
    envelope.cwd,
    envelope.env,
    envelope.greetingCmd,
    {
      mode: opts.appearanceMode ?? 'console',
      planSlug: opts.planSlug ?? null,
      label: opts.label ?? null,
      scheme: opts.scheme ?? null,
    },
    receiptPath,
    true,
    true,
    terminalPidReceiptPath,
  );

  // 3. macOS: the operator is USUALLY a child of the desktop .app in the user's
  //    GUI session, so it can open a Terminal window itself — mirroring the Linux
  //    child_process path (no webview/Tauri round-trip). Fleet color schemes
  //    work here for free because the OSC prelude is already in the one-liner.
  //    ⚠ "usually" is load-bearing (EI-19311623077693508): a headless rig mac
  //    (sidecar started over ssh, nobody logged into the GUI) has NO GUI session,
  //    so LaunchServices refuses and `open` exits non-zero. spawnMacConsole
  //    verifies that exit rather than assuming success — callers get a real
  //    error and can fall back to spawnHeadless.
  if (process.platform === 'darwin') {
    return spawnMacConsole(
      envelope,
      oneliner,
      opts.macProbes,
      receiptPath,
      opts.bootProbes,
      terminalPidReceiptPath,
      opts.terminalPidProbes,
    );
  }

  // 4. Windows has no server-side path: the operator runs inside the WSL2 distro,
  //    so `process.platform` is 'linux' (NOT 'win32') — the ONLY reliable Windows
  //    signal is isWindowsDesktopHost() (WSL2 /proc/version check). A window the
  //    WSL operator spawns lands in Session 0 (invisible to the interactive
  //    desktop, per D-002); so on Windows we MUST defer to the desktop shell's
  //    Tauri `console_launch` command (spawn_windows_wsl_new_window, which spawns
  //    the Session-1 wt.exe titled `Papercup — <id>`). Two ways to defer:
  //    - allowDesktopBridge (WI-3289, the agent-tool callers): relay the envelope
  //      to the desktop webview over the sync-bus bridge and await the Tauri
  //      result here, so the CALLER still gets a real ok/error verdict;
  //    - otherwise return 501 so the renderer falls through to its own Tauri
  //      fallback (native-console.ts — the user "+" path).
  //    WI-1882: without the isWindowsDesktopHost() clause this fell into the
  //    Linux cascade below and died with "no terminal emulator found" because
  //    process.platform==='linux' in WSL.
  if (process.platform !== 'linux' || isWindowsDesktopHost()) {
    if (opts.allowDesktopBridge && isWindowsDesktopHost()) {
      const bridged = await requestDesktopConsoleLaunch({
        envelope,
        label: opts.label ?? null,
        planSlug: opts.planSlug ?? null,
      });
      if (bridged.ok) {
        return {
          status: 'ok',
          // Windows-namespace pid — display-only (never liveness-checked from
          // WSL; see console-record.ts's no-pid rationale). May be null.
          pid: bridged.pid,
          terminal: 'wt.exe (desktop-bridge)',
          child: null,
          display: null,
          desktopEnvResolvedVia: null,
        };
      }
      return {
        status: 'error',
        error: `desktop-bridge launch failed: ${bridged.error}`,
        code: 502,
      };
    }
    return {
      status: 'error',
      error:
        'server-side spawn implemented for Linux + macOS; Windows (WSL2 operator) uses the Tauri console_launch path',
      code: 501,
    };
  }

  // 5/6. Linux: pick a terminal emulator + resolve the display to open on.
  let term: { bin: string; args: string[] } | null;
  let desktopEnv: Record<string, string>;
  let resolvedVia: 'operator-env' | 'active-seat' | 'socket-scan' | 'caller-override';
  if (opts.displayOverride) {
    // WI-4272 (demo-stage): the caller pinned an explicit X display — a
    // provisioned sandbox Xvfb being recorded — so seat resolution is
    // deliberately SKIPPED. Requires a DISPLAY-honoring emulator; verify the
    // override's socket actually exists before spawning (loud-fail beats a
    // client ghosting off-screen — same WI-1886 contract as the seat path).
    term = findDisplayHonoringTerminal();
    if (!term) {
      return {
        status: 'error',
        error:
          `displayOverride ${opts.displayOverride}: no DISPLAY-honoring terminal emulator found. ` +
          'Install xterm / alacritty / kitty / wezterm — gnome-terminal & konsole cannot target a ' +
          "specific display (their client-server model opens windows on the seat's server; WI-4272).",
        code: 500,
      };
    }
    const socketPath = socketPathForDisplay(opts.displayOverride);
    if (!socketPath) {
      return {
        status: 'error',
        error:
          `displayOverride ${JSON.stringify(opts.displayOverride)} is not a parseable X display ` +
          "(expected ':N' / ':N.M' / 'host:N')",
        code: 400,
      };
    }
    const probeExists = opts.desktopEnvProbes?.existsSync ?? existsSync;
    if (!probeExists(socketPath)) {
      return {
        status: 'error',
        error:
          `displayOverride ${opts.displayOverride}: no X socket at ${socketPath} — the display is not ` +
          'alive. Provision the sandbox stage first (computer:provision_desktop) or check the display ' +
          'number (WI-4272).',
        code: 412,
      };
    }
    desktopEnv = { DISPLAY: opts.displayOverride };
    resolvedVia = 'caller-override';
  } else {
    // WI-1886(a): the operator often runs headless (systemd user service) —
    // resolve the interactive session's desktop env and inject it; with no
    // display resolvable, fail LOUD before spawning a client that would ghost.
    // WI-4718: resolve FIRST, then pick the terminal — desktopSessionDetected
    // (was a live desktop session's D-Bus bus found?) decides whether to prefer
    // the owner's standard client-server terminal (gnome-terminal, which will
    // reach its server on the injected bus) or a reliable process-per-window
    // emulator (a bare Xvfb/sandbox with no reachable window server).
    const desktop = resolveLinuxDesktopEnv(process.env, opts.desktopEnvProbes);
    if (!desktop.resolved) {
      return { status: 'error', error: desktop.error ?? 'no X display (WI-1886)', code: 412 };
    }
    if (desktop.warnings.length > 0) {
      // WI-2840: healed a stale inherited DISPLAY/XAUTHORITY — this is exactly
      // the "long-lived process env poisoned" symptom the ticket was filed
      // from. Log loudly (visible in the systemd journal for a service-managed
      // operator) so a recurrence has a named cause instead of a silent wedge.
      console.warn(`[console-spawn] ${desktop.warnings.join('; ')}`);
    }
    // EI-11578: a RESUME/FORK launch forces the process-per-window ordering even
    // on a detected desktop session — gnome-terminal's VTE pty drops the resumed
    // session's reattached psu managed-pty host, while xterm/alacritty hold it.
    const requireProcessPerWindow = opts.preferProcessPerWindow ?? false;
    term = findLinuxTerminal(
      resolveTerminalPreference(desktop.desktopSessionDetected, requireProcessPerWindow),
      requireProcessPerWindow,
    );
    if (!term) {
      return {
        status: 'error',
        error: requireProcessPerWindow
          ? 'no process-per-window terminal emulator found. Install alacritty / kitty / wezterm / xterm; a client-server $TERMINAL cannot satisfy this launch requirement'
          : 'no terminal emulator found. Set $TERMINAL or install gnome-terminal / konsole / alacritty / kitty / wezterm / xterm',
        code: 500,
      };
    }
    desktopEnv = desktop.env;
    // resolvedVia is non-null whenever resolved === true (checked above).
    resolvedVia = desktop.resolvedVia ?? 'operator-env';
  }

  // 7. Spawn a new window running the one-liner; detach so closing the
  //    operator doesn't kill the user's terminal. Stderr goes to a temp FILE
  //    (not a pipe: no backpressure/EPIPE risk on a long-lived window) so the
  //    early-exit probe can surface the client's actual complaint.
  const childArgs = [...term.args, 'bash', '-lc', oneliner];
  const stderrPath = join(tmpdir(), `papercup-console-stderr-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.log`);
  let stderrFd: number | null = null;
  try {
    stderrFd = openSync(stderrPath, 'w');
  } catch {
    stderrFd = null;
  }
  // EI-19407722209410974: scrub the terminal identity of whatever tab THIS
  // process was started in before handing the env to a NEW emulator. This file
  // keeps its own LINUX_TERMINALS/findTerminal copy rather than going through
  // `spawnInTerminal`, so the EI-19385011811175105 fix there did not reach here
  // — and this is the busier path (capability:terminal, and every VISIBLE
  // fleet:launch-on-plan member).
  //
  // Concretely: an operator started by `npm run dev` from a gnome-terminal tab
  // carries that tab's GNOME_TERMINAL_SCREEN. Inherited, gnome-terminal asks the
  // D-Bus factory for a screen that is long gone, prints "Failed to get screen
  // from object path ...", and EXITS 0 having opened nothing — a silent
  // zero-window launch reported as success. The systemd :3070 operator has no
  // such var, which is why this only bites a desktop-served operator.
  //
  // Applied to the MERGED env on purpose: no caller legitimately sets a terminal
  // identity, so an explicit one is as wrong as an inherited one.
  //
  // The WAYLAND_DISPLAY line below is the same lesson learned once before
  // (WI-4272) and never generalised — this is that generalisation.
  const spawnEnv: NodeJS.ProcessEnv = scrubTerminalContextEnv({
    ...process.env,
    ...desktopEnv,
    ...envelope.env,
  });
  // WI-4272: with a caller display override, strip the inherited
  // WAYLAND_DISPLAY so GTK/webkit children in the spawned terminal bind the
  // X11 backend on the override display instead of the seat's Wayland socket.
  if (opts.displayOverride) delete spawnEnv.WAYLAND_DISPLAY;
  // WI-37476 (EI-9748 Route B): escape the operator service's own cgroup via
  // systemd-run --user --scope, exactly like buildHeadlessSpawnCommand does for
  // headless members — so a `systemctl --user restart` of
  // papercup-dev-api/papercup-staging-api (KillMode=control-group) cannot reap
  // this window and everything spawned inside it (the login shell, and whatever
  // build/dev-server tree the caller's one-liner starts). See
  // buildConsoleScopedSpawnCommand's doc comment for the full rationale. `bin`/
  // `args` below are what actually get spawned — on hosts without `systemd-run`
  // (or non-Linux) this is byte-identical to the pre-fix `term.bin`/`childArgs`.
  const { bin: spawnBin, args: spawnArgs } = buildConsoleScopedSpawnCommand(
    term.bin,
    childArgs,
    opts.label ?? term.bin,
    opts.spawnCommandProbes,
  );
  try {
    const child = spawn(spawnBin, spawnArgs, {
      detached: true,
      stdio: ['ignore', 'ignore', stderrFd ?? 'ignore'],
      cwd: envelope.cwd,
      env: spawnEnv,
    });
    child.unref();
    if (stderrFd != null) {
      closeSync(stderrFd); // the child holds its own dup
      stderrFd = null;
    }

    // WI-1886(b): a client that dies inside the probe window never opened a
    // window — report the failure (with its stderr) instead of ok+pid.
    const earlyExit = await watchEarlyExit(child, EARLY_EXIT_PROBE_MS);
    let stderrText = '';
    try {
      stderrText = readFileSync(stderrPath, 'utf8').trim().slice(0, 800);
    } catch {
      stderrText = '';
    }
    if (earlyExit?.error) {
      // The emulator binary never started (ENOENT/EACCES). classifyEarlyExit
      // cannot express this — it reasons about exit codes — so it is answered
      // here rather than smuggled in as a synthetic code.
      try {
        unlinkSync(stderrPath);
      } catch { /* best-effort */ }
      return {
        status: 'error',
        error:
          `spawn ${term.bin} failed: ${earlyExit.error.message} — no window opened` +
          `${stderrText ? `: ${stderrText}` : ''} (the emulator binary never ran)`,
        code: 502,
      };
    }
    if (earlyExit) {
      const verdict = classifyEarlyExit(term.args, earlyExit.code, earlyExit.signal);
      if (verdict.failed) {
        try {
          unlinkSync(stderrPath);
        } catch { /* best-effort */ }
        return {
          status: 'error',
          error:
            `${term.bin} died ${verdict.why} within ${EARLY_EXIT_PROBE_MS}ms — no window opened` +
            `${stderrText ? `: ${stderrText}` : ''} (WI-1886: was the operator headless / display unreachable?)`,
          code: 502,
        };
      }
    }
    try {
      unlinkSync(stderrPath); // window survived (fd stays valid for the child on Linux)
    } catch { /* best-effort */ }
    // EI-19330040718883562: the window surviving EARLY_EXIT_PROBE_MS only rules
    // out the emulator dying — it says nothing about the AGENT COMMAND inside,
    // which the one-liner keeps alive-looking forever (it `exec`s a login shell
    // no matter what). Opt-in only (see SpawnConsoleOpts.verifyBootReceipt) —
    // a null receiptPath returns immediately with zero added latency.
    const bootFailure = await pollConsoleBootReceipt(receiptPath, opts.bootProbes);
    if (bootFailure) return bootFailure;
    const terminalPid = await pollTerminalPidReceipt(terminalPidReceiptPath, opts.terminalPidProbes);
    // EI-8289: report the DISPLAY the window actually opened on (its own env
    // if it already had one, else whatever we resolved/injected) so a virtual-
    // placement window is disclosed to the caller, never silent.
    return {
      status: 'ok',
      pid: child.pid ?? null,
      ...(terminalPidReceiptPath ? { terminalPid } : {}),
      terminal: term.bin,
      child,
      display: desktopEnv.DISPLAY ?? process.env.DISPLAY ?? null,
      desktopEnvResolvedVia: resolvedVia,
    };
  } catch (e: any) {
    if (stderrFd != null) {
      try {
        closeSync(stderrFd);
      } catch { /* already closed */ }
    }
    try {
      unlinkSync(stderrPath);
    } catch { /* best-effort */ }
    return { status: 'error', error: `spawn ${term.bin} failed: ${e?.message}`, code: 500 };
  }
}

/**
 * Is a human logged into this mac's GUI (a window CAN be displayed)?
 *
 * `/dev/console` is owned by the console (GUI) user; on a machine parked at the
 * loginwindow with nobody logged in it is owned by **root** (uid 0). That is the
 * live state of the rig mac, and it is a DETERMINISTIC verdict — unlike sniffing
 * `open`'s exit code, which cannot distinguish "LaunchServices accepted" from
 * "a window actually appeared" (see spawnMacConsole's doc comment).
 *
 * Deliberately a `statSync` rather than shelling out to `stat -f %Su`: no
 * subprocess on the spawn hot path, and no PATH/quoting surface.
 */
export function macHasGuiSession(probe: () => number = () => statSync('/dev/console').uid): boolean {
  try {
    return probe() !== 0;
  } catch {
    // Unreadable /dev/console ⇒ we cannot prove a GUI session exists. Report
    // "no GUI" so the caller takes the headless path, which works everywhere —
    // failing toward the path that runs is strictly better than toward a phantom.
    return false;
  }
}

/** Injectable seams for spawnMacConsole (tests pass fakes; production omits). */
export interface MacConsoleProbes {
  /** uid of /dev/console — 0 (root) means nobody is logged into the GUI. */
  consoleUid?: () => number;
  /** Did the one-shot `.command` still exist at `path` when polled? */
  commandFileExists?: (path: string) => boolean;
  /** Sleep between receipt polls. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * How long after `open` returns we keep waiting for the `.command` to be
 * executed (it self-deletes on exec — see macConsoleInvocation). A cold
 * Terminal.app launch on a healthy GUI mac is well under this; the rig case
 * never reaches this code because the GUI pre-flight short-circuits it.
 */
export const MAC_COMMAND_RECEIPT_MS = 2500;

/**
 * How long spawnHeadless watches a freshly-launched member's log for the
 * greeting-failure sentinel before calling the launch good.
 *
 * Sized off the live failure it exists to catch: psu reaches an auth/entitlement
 * rejection ~2–4s in (measured on the rig mac 2026-08-02), well past the 1200ms
 * EARLY_EXIT_PROBE_MS. 6s leaves margin without stalling honor unduly — the
 * spawns run under Promise.all, so it costs once, not once per member.
 */
export const HEADLESS_BOOT_RECEIPT_MS = 6000;

/**
 * How long an opted-in visible launch waits for the interactive tab shell to
 * publish its PID receipt. The terminal emulator's child PID is not the shell
 * that owns the window, so callers that need authenticated window cleanup use
 * this separate identity. A missing receipt is reported as `terminalPid:null`
 * rather than falling back to the emulator PID.
 */
export const TERMINAL_PID_RECEIPT_MS = 6000;

/**
 * The sentinel `buildConsoleOneliner` prints when the agent command dies. This
 * is OUR OWN emitted contract (see the `__papercusp_greeting_rc` branch there),
 * not a third-party log string, which is what makes matching it sound.
 */
export const HEADLESS_GREETING_FAILURE_RE =
  /\[papercusp\] initial terminal command exited with status (\d+)/;

/**
 * macOS spawner — mirrors native_console.rs `spawn_macos_new_window`: write a
 * one-shot, self-deleting `.command` file (chmod 755) and `open -na <term>` it.
 * `open -na` forces a FRESH app instance ⇒ a new window every time (Terminal's
 * AppleScript do-script would reuse the frontmost window). iTerm wins when
 * installed, else Terminal.app. The `.command` execs the same login-shell
 * one-liner the Linux path runs, so colors/env/sentinel behave identically.
 */
async function spawnMacConsole(
  envelope: ConsoleEnvelope,
  oneliner: string,
  probes: MacConsoleProbes = {},
  /** EI-19330040718883562: null unless the caller opted into verifyBootReceipt. */
  receiptPath: string | null = null,
  bootProbes: SpawnConsoleOpts['bootProbes'] = undefined,
  terminalPidReceiptPath: string | null = null,
  terminalPidProbes: SpawnConsoleOpts['terminalPidProbes'] = undefined,
): Promise<SpawnConsoleResult> {
  // Pre-flight (EI-19311623077693508, third and final half): with nobody logged
  // into the GUI a window CANNOT be displayed, no matter what `open` reports. Say
  // so BEFORE writing a .command and forking, so delegated-spawn-honor's
  // `status !== 'ok'` headless fallback engages instead of counting a phantom.
  if (!macHasGuiSession(probes.consoleUid)) {
    return {
      status: 'error',
      error:
        'no GUI session on this mac — /dev/console is owned by root (nobody is logged in),' +
        ' so LaunchServices cannot display a terminal window and `open` would report success anyway' +
        ' (EI-19311623077693508). A headless spawn is the working path on this host.',
      code: 502,
    };
  }
  // EI-19311623077693508: this path used to return ok the instant Node forked
  // `open`, never observing its EXIT — making macOS the ONLY spawn backend with
  // no verification at all (Linux has the WI-1886(b) probe below; spawnHeadless
  // has its own). On a mac with no GUI session (a rig VM parked at the
  // loginwindow: `stat -f %Su /dev/console` ⇒ root, osascript ⇒ -10810)
  // LaunchServices CANNOT open a window, so `open` exits NON-ZERO — but
  // asynchronously, and with stdio ignored nobody ever saw it. The lie
  // propagated: delegated-spawn-honor counted a phantom member as `opened`,
  // which ALSO made its own headless fallback (`r.status !== 'ok'`) dead code on
  // macOS, so the requester waited out the full offer expiry for a member that
  // was never coming. Verify the launcher instead of assuming it.
  //
  // ⚠ The macOS verdict is NOT the Linux one. `open` is a LAUNCHER that hands
  // off to LaunchServices and exits 0 immediately on success — the terminal is
  // NOT its child. So an early exit is normal here, and only a NON-ZERO/signalled
  // exit proves failure (the same condition spawnHeadless uses). Copying the
  // Linux "died inside the probe ⇒ failed" rule would fail every healthy launch.
  let stderrPath: string | null = null;
  try {
    const inv = macConsoleInvocation(oneliner, {
      tmpDir: process.env.TMPDIR || '/tmp',
      nowMs: Date.now(),
      pid: process.pid,
      hasITerm: existsSync('/Applications/iTerm.app'),
    });
    writeFileSync(inv.file, inv.content, { mode: 0o755 });
    // Capture `open`'s stderr so the operator error carries LaunchServices' own
    // words (e.g. "-10810") rather than a bare exit code.
    stderrPath = join(tmpdir(), `papercup-console-stderr-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.log`);
    let stderrFd: number | null = null;
    try {
      stderrFd = openSync(stderrPath, 'w');
    } catch {
      stderrFd = null;
    }
    const child = spawn('open', inv.openArgs, {
      detached: true,
      stdio: ['ignore', 'ignore', stderrFd ?? 'ignore'],
      cwd: envelope.cwd,
      // EI-19407722209410974: same scrub as the Linux path. No D-Bus factory is
      // involved here, so the zero-window failure cannot occur — but
      // ITERM_SESSION_ID / TERM_SESSION_ID / the multiplexer vars are still this
      // process's terminal identity, and a new window is not in it.
      env: scrubTerminalContextEnv({ ...process.env, ...envelope.env }),
    });
    child.unref();
    if (stderrFd != null) {
      closeSync(stderrFd); // the child holds its own dup
      stderrFd = null;
    }

    const earlyExit = await watchEarlyExit(child, EARLY_EXIT_PROBE_MS);
    // `open` never STARTED (ENOENT/EACCES on the launcher itself). This must be
    // checked before the exit-code branch and must never fall through to the
    // fail-open path below: on macOS a normal exit is uninformative, so an
    // unstarted launcher would otherwise be counted as a live window.
    if (earlyExit?.error) {
      try { unlinkSync(stderrPath); } catch { /* best-effort */ }
      stderrPath = null;
      return {
        status: 'error',
        error:
          `spawn open failed: ${earlyExit.error.message} — no window opened` +
          ' (EI-19311623077693508: the launcher itself never ran, so nothing was opened;' +
          ' a headless spawn is the working path on a host with no GUI session)',
        code: 502,
      };
    }
    if (earlyExit && (earlyExit.signal != null || (earlyExit.code ?? 0) !== 0)) {
      let stderrText = '';
      try {
        stderrText = readFileSync(stderrPath, 'utf8').trim().slice(0, 800);
      } catch {
        stderrText = '';
      }
      try { unlinkSync(stderrPath); } catch { /* best-effort */ }
      stderrPath = null;
      const how = earlyExit.signal ? `signal ${earlyExit.signal}` : `exit ${earlyExit.code}`;
      return {
        status: 'error',
        error:
          `open ${inv.term} failed (${how}) — no window opened` +
          `${stderrText ? `: ${stderrText}` : ''}` +
          ' (EI-19311623077693508: is anyone logged into the GUI? `stat -f %Su /dev/console` ⇒ root and' +
          ' osascript ⇒ -10810 mean there is no GUI session; a headless spawn works there, a window cannot)',
        code: 502,
      };
    }
    // `open` exited 0 (or outlived the probe) ⇒ LaunchServices ACCEPTED the
    // request. That is NOT proof a window opened — and trusting it is what made
    // this bug survive two fixes. Verify the POST-CONDITION instead: the
    // `.command` self-deletes (`rm -f "$0"`) as its first act, so its
    // DISAPPEARANCE is an execution receipt that cannot be faked by a launcher
    // that merely accepted the job. Measured on the rig mac 2026-08-02: both
    // .command files from the two "honored (1 member(s) opened)" spawns were
    // still on disk afterwards — never executed, zero agent processes.
    const commandExists = probes.commandFileExists ?? ((p: string) => existsSync(p));
    const sleep = probes.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms).unref?.(); }));
    let ran = !commandExists(inv.file);
    const deadline = Date.now() + MAC_COMMAND_RECEIPT_MS;
    while (!ran && Date.now() < deadline) {
      await sleep(100);
      ran = !commandExists(inv.file);
    }
    if (!ran) {
      // Best-effort cleanup: nothing executed it, so it will never self-delete.
      try { unlinkSync(inv.file); } catch { /* best-effort */ }
      try { unlinkSync(stderrPath); } catch { /* best-effort */ }
      stderrPath = null;
      return {
        status: 'error',
        error:
          `open ${inv.term} reported success but the launcher script was never executed` +
          ` within ${MAC_COMMAND_RECEIPT_MS}ms — no window opened (EI-19311623077693508:` +
          ' LaunchServices accepted the request and exited 0 without displaying anything;' +
          ' a headless spawn is the working path on such a host).',
        code: 502,
      };
    }
    try { unlinkSync(stderrPath); } catch { /* best-effort */ }
    stderrPath = null;
    // EI-19330040718883562: the .command self-deleting only proves the login
    // shell STARTED — same gap as the Linux early-exit probe, see
    // pollConsoleBootReceipt's doc. Opt-in only; a null receiptPath (the
    // default) returns immediately with zero added latency.
    const bootFailure = await pollConsoleBootReceipt(receiptPath, bootProbes);
    if (bootFailure) return bootFailure;
    const terminalPid = await pollTerminalPidReceipt(terminalPidReceiptPath, terminalPidProbes);
    // macOS has no X DISPLAY concept — display/desktopEnvResolvedVia are always
    // null here (the EI-8289 disclosure only applies to the Linux X11 path).
    return {
      status: 'ok',
      pid: child.pid ?? null,
      ...(terminalPidReceiptPath ? { terminalPid } : {}),
      terminal: inv.term,
      child,
      display: null,
      desktopEnvResolvedVia: null,
    };
  } catch (e: any) {
    if (stderrPath != null) {
      try { unlinkSync(stderrPath); } catch { /* best-effort */ }
    }
    return { status: 'error', error: `open Terminal failed: ${e?.message}`, code: 500 };
  }
}

/**
 * Pure builder for the macOS `open` invocation — the one-shot `.command` path,
 * its contents (self-deleting; execs the login-shell one-liner), the chosen
 * terminal app, and the `open` argv. Side-effect-free so it can be unit-tested
 * without spawning. Exported for tests.
 */
export function macConsoleInvocation(
  oneliner: string,
  opts: { tmpDir: string; nowMs: number; pid: number; hasITerm: boolean },
): { file: string; content: string; term: string; openArgs: string[] } {
  const term = opts.hasITerm ? 'iTerm.app' : 'Terminal.app';
  const file = join(opts.tmpDir, `papercup-console-${opts.pid}-${opts.nowMs}.command`);
  // `rm -f "$0"` self-deletes the launcher before exec so /tmp doesn't accrete
  // one-shot files; exec replaces the process with our login-shell one-liner.
  const content = `#!/bin/bash\nrm -f "$0"\nexec bash -lc ${shellEscape(oneliner)}\n`;
  return { file, content, term, openArgs: ['-na', term, file] };
}

// ─── Headless spawn (no terminal emulator) ───────────────────────────
//
// headless-fleet-launch-and-carry-knob-2026-07-10 P-002 (D-004: "keep the pty,
// drop the terminal emulator"). {@link spawnHeadless} is the third spawn BACKEND
// alongside spawnConsole (Linux/macOS window) and the Windows desktop-bridge — NOT
// a parallel launch system. It runs the shared `buildConsoleOneliner` prelude and
// escaped greeting under a bare detached `bash -lc`, with stdio wired to a log
// FILE instead of a terminal window. Unlike visible launches, headless mode
// exits when the greeting exits; retaining a login shell would leave a detached
// dead-session process behind. The greeting is a `psu --headless …` command, so
// psu-launcher takes the managed-pty host despite the non-TTY stdio
// (usePtyHost + PAPERCUSP_PSU_HEADLESS=1) — the member stays injectable for warm
// `loop:arm` wakes exactly like a desktop member; it just has no window.
//
// Cross-platform for free: no DISPLAY, no terminal cascade, no desktop-env
// resolution — a headless member is just a background process. So this path works
// identically on Linux, macOS, AND the Windows WSL2 operator (no Session-0 window
// problem because there is no window). Returns the SAME SpawnConsoleResult shape as
// spawnConsole so the fleet launcher needs no result-shape branch.

/** Where a headless member's console log lands, given an explicit dir (the caller's
 *  per-workspace fleet-logs dir) or a tmp fallback. Pure + exported for tests. */
export function headlessLogPath(
  opts: { logDir?: string | null; label: string; nowMs?: number; pid?: number },
): string {
  const dir = opts.logDir?.trim() || tmpdir();
  const safe = opts.label.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'headless';
  const stamp = `${opts.pid ?? process.pid}-${opts.nowMs ?? Date.now()}`;
  return join(dir, `${safe}-${stamp}.log`);
}

/**
 * Derive the grep-safe companion path from a headless launch's raw log path.
 * Keeping the two paths as siblings makes the relationship obvious to callers
 * and avoids a second timestamp that could make the artifacts hard to pair.
 * Pure + exported for callers/tests that need to predict the sidecar path.
 */
export function headlessNormalizedLogPath(logPath: string): string {
  const path = String(logPath ?? '').trim();
  if (!path) return '';
  return path.endsWith('.log')
    ? `${path.slice(0, -'.log'.length)}.normalized.log`
    : `${path}.normalized.log`;
}

export interface SpawnHeadlessOpts {
  /** Envelope from `buildConsoleEnvelope` (cwd, env, greetingCmd) — greetingCmd MUST
   *  be a `psu --headless …` command for the session to stay injectable. */
  envelope: ConsoleEnvelope;
  /**
   * Displace (back up + write) the envelope's superuser `.mcp.json` into the
   * cwd before spawning. Agent launches opt in so headless sessions retain MCP
   * auto-discovery; arbitrary headless callers keep the default false.
   */
  writeMcpJson?: boolean;
  /** Display label for the log filename + the result's `terminal` field. */
  label?: string | null;
  /** Directory for the per-session log file (created if absent). Defaults to tmpdir. */
  logDir?: string | null;
  /** Optional explicit path for the ANSI-free, bounded companion log. Defaults
   * to {@link headlessNormalizedLogPath} beside the raw per-session log. */
  normalizedLogPath?: string | null;
  /**
   * EI-9748: injectable platform/PATH probes for {@link buildHeadlessSpawnCommand}.
   * Tests MUST pass fakes — the default (real) probes check the live PATH for
   * `systemd-run`, so a test that doesn't control this flakes with the host's
   * actual systemd availability (same class of bug findLinuxTerminal's cache-reset
   * exists for). Production callers omit it.
   */
  spawnCommandProbes?: { platform?: NodeJS.Platform; hasSystemdRun?: () => boolean };
  /** task-manager P-009 follow-up — provenance for the ledger row. Optional: a
   *  caller that does not know says so (the row records `console-spawn:headless`)
   *  rather than guessing, because a wrong attribution in a ledger built FOR
   *  attribution is worse than an honest gap. */
  launchedBy?: string;
  fleetSlug?: string | null;
  /** Stable coord identity already chosen for this agent session. When known,
   *  this is the hand-off key bootstrap uses to attach the pre-fork ledger row
   *  to the native session id. Omit rather than infer it from command text. */
  coordOwnerId?: string | null;
  /**
   * Structured, caller-owned facts merged into the ledger row's `detail` bag
   * (after the spawner's own keys, which it cannot override). This is how a
   * single-purpose launch tells the task reaper what it is FOR, so the reaper can
   * end it when that purpose is over instead of inferring it from label text —
   * e.g. a consult answering session records `consultAnswer`
   * (EI-24106882795589775).
   */
  ledgerDetail?: Record<string, unknown> | null;
  /**
   * EI-19311623077693508: injectable seams for the boot-receipt scan. Tests pass
   * fakes so a case can emit the greeting-failure sentinel deterministically
   * instead of sleeping out the real 6s window. Production callers omit it.
   */
  bootProbes?: {
    readLog?: (path: string) => string;
    sleep?: (ms: number) => Promise<void>;
    windowMs?: number;
  };
  /**
   * Opt into a parent-visible proof that the detached launch kickoff reached
   * the backend's native transcript. The receipt env is carried through the
   * shell/psu launcher boundary; ordinary headless launches do not create or
   * poll one.
   */
  kickoffProof?: boolean;
  /** Injectable seams for the opt-in detached kickoff-proof receipt poll. */
  kickoffProofProbes?: KickoffProofProbes;
}

// EI-9748: headless members are a DETACHED + unref'd child of whichever operator
// API process served the spawn call — `detached:true` gives it its own POSIX
// process GROUP/session (escapes signals sent to a foreground job / a closing
// terminal), but on a systemd-managed Linux host that is NOT the same thing as
// escaping the parent's cgroup: a plain fork() inherits the parent's cgroup, and
// both `papercup-dev-api.service` and `papercup-staging-api.service` run with
// systemd's default `KillMode=control-group` — so ANY restart of that operator
// unit (routine: agents restart papercup-staging-api.service constantly per this
// repo's own "test a server-side edit live" workflow, plus the auto-deploy
// pipeline restarting papercup-dev-api.service) sends SIGTERM to the WHOLE
// cgroup, silently killing the headless child too, with no error/OOM/crash signal
// of its own. This has repeatedly been misattributed to host load (it isn't —
// confirmed by direct evidence on EI-9748: staging-api restarted every ~5-6min
// for hours from a completely unrelated, sanctioned dev workflow).
//
// FIXED (EI-9748 Route A, landed 2026-07-11, see buildHeadlessSpawnCommand
// below): on a systemd-managed Linux host, headless children now escape the
// operator service's cgroup entirely via `systemd-run --user --scope`, so a
// `systemctl --user restart` of papercup-dev-api/papercup-staging-api no
// longer reaps them. The residual gap above (plain fork() sharing the parent
// cgroup) applies ONLY on the fallback path — a host with no `systemd-run` on
// PATH (macOS, a bare/non-systemd container). This still wraps the child's own
// SIGTERM handling so any cgroup-kill (the fallback path, or another cause
// entirely on the escaped path) logs a clear, self-diagnosing breadcrumb
// instead of a bare `Terminated`. Exported + pure (string in, string out) for
// testing.
export function wrapHeadlessSigtermDiagnostic(oneliner: string): string {
  const trap =
    `trap 'echo "[EI-9748] SIGTERM received at $(date -u +%FT%TZ) — on this host, if the ` +
    `systemd-run --user --scope cgroup escape (EI-9748 Route A, landed 2026-07-11) succeeded ` +
    `at spawn time, this is NOT an operator-service restart (that escape makes this scope a ` +
    `SIBLING of papercup-dev-api/papercup-staging-api, immune to their KillMode=control-group ` +
    `restarts) — look elsewhere: a manual kill, host reboot/shutdown, or OOM. Only on a host ` +
    `WITHOUT systemd-run on PATH (no escape available, plain detached child) does an ` +
    `operator-service restart remain a likely cause. See work-item EI-9748 for detail." >&2; ` +
    `exit 143' TERM`;
  return `${trap}; ${oneliner}`;
}

/**
 * EI-9748 DURABLE FIX — Route (A), leader-ruled (su-286379e2, 2026-07-11,
 * under the owner's delegation): a narrow, DOCUMENTED exemption for the
 * PRODUCT headless-spawn path (and ONLY this path — never agent-invoked Bash)
 * to escape the operator service's own cgroup via `systemd-run --user --scope`.
 *
 * This is NOT routing around the box's native-scheduler lockout guard (the
 * PreToolUse hook that blocks an agent session's own Bash tool from invoking
 * crontab/at/batch/systemd-run). That guard exists to stop AGENT SESSIONS
 * creating untracked background processes invisible to the hive's
 * pause/status/liveness machinery. A headless fleet member spawned here is
 * the opposite of that: it registers presence, an ownerId, fleet membership,
 * and stays reachable for `loop:arm` wakes — fully hive-supervised — so the
 * guard's rationale does not apply to it. The exemption is scoped to exactly
 * this function; nothing here grants an agent's own shell the ability to call
 * systemd-run (that PreToolUse hook is untouched and still fires on agent Bash
 * calls).
 *
 * MECHANISM: `--user --scope` creates a transient `<unit>.scope` as a SIBLING
 * of the operator's own `papercup-*-api.service` in the systemd --user cgroup
 * tree (both hang off e.g. `user@<uid>.service/app.slice/`), NOT a descendant
 * of the operator service's cgroup — `systemd-run` moves the newly-forked
 * process into the new scope's cgroup before exec, and the scope is created
 * via the user's systemd manager (D-Bus), independent of whichever process
 * asked for it. So `systemctl --user restart papercup-staging-api.service`
 * (KillMode=control-group) only reaps THAT service's own cgroup — the sibling
 * scope, and the psu session running inside it, are untouched. `--collect`
 * auto-removes the transient unit once the session exits so units don't
 * accrete; `--unit=<name>` gives it a stable, greppable name for `systemctl
 * --user status`/`journalctl --user -u` debugging.
 *
 * FALLBACK: when `systemd-run` isn't on PATH (macOS has no systemd at all; a
 * non-systemd Linux host — a bare container, etc. — has no user manager to
 * scope against), falls back to the pre-existing plain detached spawn — the
 * one still vulnerable to the cgroup-kill this function exists to fix, but a
 * headless member that MIGHT die on a service restart beats no headless
 * member at all on hosts where the durable escape isn't available.
 *
 * Pure (given the platform/PATH probes) + exported for unit tests.
 */
/**
 * Shared systemd-run --user --scope argv builder underlying BOTH
 * buildHeadlessSpawnCommand (headless su members, below) and
 * buildConsoleScopedSpawnCommand (visible terminal windows — WI-37476/EI-9748
 * Route B). One implementation of the escape so the two spawn shapes cannot
 * drift the way the two linux-terminal tables once did (EI-19385011811175105
 * / EI-19407722209410974).
 *
 * `bin`/`args` is the command to run INSIDE the scope (e.g. `bash -lc
 * <oneliner>` for a headless member, or `<terminal-emulator> <its-args>` for
 * a visible window) — the function wraps it, it does not interpret it.
 * `unitPrefix` keeps each caller's unit names greppable/attributable
 * (`papercup-headless-…` vs `papercup-console-…`) without hardcoding either
 * prefix twice.
 */
function buildScopedSpawnArgv(
  bin: string,
  args: string[],
  label: string,
  unitPrefix: string,
  probes: { platform?: NodeJS.Platform; hasSystemdRun?: () => boolean } = {},
  taskScope?: { unit: string; slice: string } | null,
  memoryMaxBytes?: number | null,
): { bin: string; args: string[]; scopeUnit: string | null } {
  const platform = probes.platform ?? process.platform;
  // WI-10003189: PATH presence is necessary but NOT sufficient. A hosted workspace
  // host runs the operator as a system service with no user manager, so
  // `systemd-run --user` is installed yet cannot work — it exits 1 with "Failed to
  // connect to bus: No medium found" and the wrapped member never starts. Require a
  // reachable user bus too; without one there is no scope to escape into, and the
  // plain detached child below is the correct (only) launch.
  const hasSystemdRun =
    probes.hasSystemdRun ?? (() => isOnPath('systemd-run') && userManagerBusReachable(process.env));
  if (platform === 'linux' && hasSystemdRun()) {
    const safeLabel =
      label.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'member';
    // Un-enrolled fallback keeps a stable, prefix-greppable name when the ledger
    // is unavailable (or, for the console caller, never used at all).
    const unitName = taskScope?.unit ?? `${unitPrefix}-${safeLabel}-${process.pid}-${Date.now()}`;
    // EI-19366263067183489: the slice is UNCONDITIONAL. It used to be emitted only when
    // `taskScope` was non-null, which meant the un-enrolled fallback created a REAL systemd
    // scope holding a real agent subtree in `app.slice` — outside `papercusp.slice`, with no
    // ledger row. That is the worst of both worlds: nothing knew it existed (no row to join
    // on) AND nothing could sweep it (outside our slice), so it was untracked and unreapable
    // at the same time. Measured 2026-08-02: 90 such scopes had accumulated over 16 days —
    // 422 processes, 20.9 GB RSS, ~29 cores burned continuously, and 0 of 88 orphaned agents
    // had written a transcript in the previous 2 hours. They were spinning, not working.
    //
    // Note this does NOT make the fallback fail closed, and deliberately so: `confined` is
    // false in three cases (enroll-sync.ts:67) and one of them — `taskManagerEnabledSync()`
    // returning false — is a DESIGNED path whose contract is explicitly "byte-identical to
    // pre-feature behaviour: an unconfined, unledgered spawn". Refusing to spawn there would
    // break the flag-off path outright. Being unledgered is intended when the flag is off;
    // being UNREAPABLE never was. So the fix targets reapability, which is safe in all three
    // cases: the scope lands inside `papercusp.slice`, where `isOwnedCgroupPath` recognizes
    // it and a slice-level sweep can stop it even with no ledger row to look it up by.
    const sliceName = taskScope?.slice ?? sliceForClass('agent-session');
    return {
      // EI-19366263067183489 (second half): RETURN the unit name, don't just bake it into
      // argv. The slice fix above made the fallback scope REAPABLE; this makes it FINDABLE.
      //
      // `spawnHeadless` already ledgers the unconfined path — `managed-spawn.ts` states the
      // intent as "run UNCONFINED but still ledgered" — but it recorded
      // `scopeUnit: taskScope?.unit ?? null`, i.e. NULL, while this function had just placed
      // the process in a real named scope. The ledger said "no scope"; the kernel said
      // "scope papercup-headless-X". Nothing could join the two, so the row could never be
      // matched to its process and the reconciler classified it `unaccounted` forever.
      //
      // The name was computed here and discarded here — the caller could not record what it
      // was never told. Returning it costs nothing and closes the join.
      scopeUnit: unitName,
      bin: 'systemd-run',
      args: [
        '--user',
        '--scope',
        ...SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS,
        '--quiet',
        `--unit=${unitName}`,
        `--slice=${sliceName}`,
        ...(memoryMaxBytes && memoryMaxBytes > 0
          ? [`--property=MemoryMax=${Math.floor(memoryMaxBytes)}`]
          : []),
        '--',
        bin,
        ...args,
      ],
    };
  }
  // No systemd-run: there is no scope at all, so there is genuinely no unit to record.
  // `null` here is the honest answer, not a fallback — distinct from the case above where a
  // scope exists and we simply used to forget its name.
  return { bin, args, scopeUnit: null };
}

export function buildHeadlessSpawnCommand(
  oneliner: string,
  label: string,
  probes: { platform?: NodeJS.Platform; hasSystemdRun?: () => boolean } = {},
  /**
   * task-manager-no-escape-2026-07-27 P-009 (follow-up): when the caller has
   * enrolled this member in the task ledger, it passes the scope unit + slice here
   * so the member lands inside `papercusp.slice` with a name the reconciler can
   * join on.
   *
   * This path was originally ALLOWLISTED out of the task manager on the reasoning
   * that console-spawn "opens a desktop TERMINAL for a human; the window is the
   * unit of control". That is true for spawnConsole and FLATLY WRONG here: a
   * headless member has no window at all, it is the largest agent subtree on the
   * box, and it is the exact population EI-9748 is about. One file served two
   * shapes and the allowlist treated it as one.
   *
   * Note the scope was ALREADY being created (EI-9748 Route A) — what was missing
   * was only the slice and the name. So this is not new confinement machinery on
   * a critical path; it is the same `systemd-run` call, addressed.
   */
  taskScope?: { unit: string; slice: string } | null,
): { bin: string; args: string[]; scopeUnit: string | null } {
  return buildScopedSpawnArgv(
    'bash',
    ['-lc', oneliner],
    label,
    'papercup-headless',
    probes,
    taskScope,
    agentSpawnScopeMemoryMaxG() * 1024 ** 3,
  );
}

/**
 * EI-9748 Route B (WI-37476, 2026-08-09): the SAME cgroup escape as
 * buildHeadlessSpawnCommand, applied to the VISIBLE-terminal spawn path
 * (spawnConsole below — capability:terminal, every visible
 * fleet:launch-on-plan member, and the operator "+" console button).
 *
 * Route A (2026-07-11) fixed exactly one of the two shapes console-spawn.ts
 * produces: a plain `detached:true` child inherits its PARENT's cgroup (the
 * operator process that served the spawn call — papercup-dev-api or
 * papercup-staging-api), and both run with systemd's default
 * `KillMode=control-group`, so ANY restart of that operator unit
 * (papercup-staging-api is restarted routinely by this repo's own "test a
 * server-side edit live" workflow, and papercup-dev-api by the auto-deploy
 * pipeline) SIGTERMs the WHOLE cgroup — silently killing every process the
 * spawn call started, with no error/OOM/crash signal of its own. This was
 * fixed for headless members; the windowed path was left on the vulnerable
 * plain-detached-child shape, on the (correct, but incomplete) reasoning
 * that "the window is the unit of control" for a human-opened terminal —
 * that reasoning says nothing about whether the WINDOW ITSELF, and every
 * process inside it, can be reaped out from under the human by an unrelated
 * operator restart.
 *
 * Filed from WI-37476: three desktop app processes died together in one
 * launch, two of them on ISOLATED cargo target-dir slots the triggering
 * build never touched — ruling out shared-target-dir corruption (WI-7101)
 * as the cause of at least those two. A cgroup reap of the spawning
 * console's whole process tree (bash → npm → cargo → the app binary) is the
 * one mechanism that explains dissimilar, unrelated processes dying
 * TOGETHER regardless of what each was individually doing. Unconfirmed for
 * that specific incident (the processes were already gone by the time it
 * was investigated, and papercup-dev-api/papercup-staging-api show no
 * restart in the incident's own window per `journalctl`) — but the
 * vulnerability itself is real and independent of that one incident, is the
 * exact class EI-9748 already fixed once, and is worth closing regardless
 * of whether it explains WI-37476's specific occurrence.
 *
 * Deliberately NOT task-manager-enrolled (unlike the headless path) — a
 * human-opened terminal window IS the unit of control (the comment on
 * buildHeadlessSpawnCommand's taskScope param is still correct for THIS
 * caller), so `taskScope` is always null here: the un-enrolled fallback
 * naming/slicing is the only shape this caller needs.
 */
export function buildConsoleScopedSpawnCommand(
  bin: string,
  args: string[],
  label: string,
  probes: { platform?: NodeJS.Platform; hasSystemdRun?: () => boolean } = {},
): { bin: string; args: string[]; scopeUnit: string | null } {
  return buildScopedSpawnArgv(bin, args, label, 'papercup-console', probes, null);
}

/**
 * Launch a headless (no-window) managed-pty session. Detached + unref'd so it
 * outlives the operator, with stdout+stderr → a per-session log file so a leader
 * can tail a member. Async like spawnConsole: it watches the child briefly and
 * reports a boot-time death (the psu command dying inside the probe window) as an
 * error-with-log-tail instead of a false ok+pid.
 */
export async function spawnHeadless(opts: SpawnHeadlessOpts): Promise<SpawnConsoleResult> {
  const { envelope } = opts;
  const mcpJsonError = writeMcpJsonFile(envelope, opts.writeMcpJson ?? false);
  if (mcpJsonError) {
    return { status: 'error', error: mcpJsonError, code: 500 };
  }
  const label = opts.label ?? 'headless-member';
  const coordOwnerId = opts.coordOwnerId?.trim() || null;
  let kickoffProofRequest: KickoffProofRequest | null = null;
  try {
    if (opts.kickoffProof) kickoffProofRequest = createKickoffProofRequest();
  } catch (e: any) {
    return {
      status: 'error',
      error: `headless kickoff-proof setup failed: ${e?.message ?? e}`,
      code: 500,
    };
  }
  let logDir = opts.logDir?.trim() || null;
  if (logDir) {
    try {
      mkdirSync(logDir, { recursive: true });
    } catch {
      logDir = null; // fall back to tmp if the dir can't be made
    }
  }
  const logPath = headlessLogPath({ logDir, label });
  const normalizedLogPath = opts.normalizedLogPath?.trim() || headlessNormalizedLogPath(logPath);
  const launchEnv = {
    ...envelope.env,
    // Keep the raw stdout log byte-oriented for existing lifecycle/activity
    // consumers. The managed pty host reads this separate path and writes its
    // bounded ANSI-free companion without changing that contract.
    [HEADLESS_NORMALIZED_LOG_ENV]: normalizedLogPath,
    ...(kickoffProofRequest
      ? {
          [KICKOFF_PROOF_PATH_ENV]: kickoffProofRequest.path,
          [KICKOFF_PROOF_TOKEN_ENV]: kickoffProofRequest.token,
        }
      : {}),
  };
  // Same one-liner shape spawnConsole builds — appearance prelude is harmless
  // with no TTY (the OSC escapes just land in the log). Headless sessions have
  // no desktop window or native .mcp.json watcher, so omit the visible-console
  // liveness marker and keep runtime state out of the launch cwd.
  const oneliner = wrapHeadlessSigtermDiagnostic(
    buildConsoleOneliner(envelope.cwd, launchEnv, envelope.greetingCmd, {
      mode: 'console',
      planSlug: null,
      label,
      scheme: null,
    }, null, false, false),
  );
  let logFd: number | null = null;
  try {
    logFd = openSync(logPath, 'a');
  } catch {
    logFd = null; // last resort: inherit-nothing (stdio ignore) below
  }

  try {
    // EI-9748 Route (A): escape the operator service's own cgroup via
    // systemd-run --user --scope when available, so a headless member
    // survives a `systemctl --user restart papercup-{dev,staging}-api.service`
    // instead of being reaped by KillMode=control-group. See
    // buildHeadlessSpawnCommand's doc comment for the full rationale.
    // task-manager P-009 follow-up: enrol BEFORE the fork. The scope was already
    // being created for EI-9748; this only gives it our slice + a joinable name,
    // and mints the ledger row that makes the member visible in /admin/tasks with
    // its fleet, its log, and its live cost.
    const memoryMaxBytes = agentSpawnScopeMemoryMaxG() * 1024 ** 3;
    const enrolment = beginSyncEnrolment({ class: 'agent-session', memoryMaxBytes });
    const taskScope = enrolment.confined
      ? { unit: scopeUnitForTask(enrolment.taskId, label), slice: sliceForClass('agent-session') }
      : null;
    // WI-10003189: `no-scope-support` means the task manager's live probe already
    // RAN `systemd-run --user --scope -- true` on this host and it failed. Wrapping
    // the member in that same command fails the same way (on a hosted host: "Failed
    // to connect to bus: No medium found", exit 1, New Session dead at boot), so the
    // probe's verdict outranks PATH presence. The other unconfined reasons say
    // nothing about systemd itself (flag-off, a caller veto, a probe still pending),
    // so they keep the EI-9748 cgroup escape.
    const spawnCommandProbes =
      enrolment.unconfinedReason === 'no-scope-support'
        ? { ...opts.spawnCommandProbes, hasSystemdRun: () => false }
        : opts.spawnCommandProbes;
    const { bin, args, scopeUnit } = buildHeadlessSpawnCommand(
      oneliner,
      label,
      spawnCommandProbes,
      taskScope,
    );
    const child = spawn(bin, args, {
      detached: true,
      stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
      cwd: envelope.cwd,
      // EI-19407722209410974: a headless member has no window, so the
      // GNOME_TERMINAL_SCREEN failure cannot reach it — but TMUX / ZELLIJ* / STY
      // would tell the psu it is running inside the OPERATOR's multiplexer pane,
      // which it is not. pui and `psu --brain` both drive zellij, so that is a
      // live wrong-answer, not a hypothetical one.
      env: normalizeHeadlessAgentTerm(scrubTerminalContextEnv({ ...process.env, ...launchEnv })),
    });
    // Keep a second, persistent observer before the bounded boot probes remove
    // their own listeners. The consult reviver consumes this promise to turn a
    // post-return status-2 exit into a truthful failed revival.
    const childExit = observeChildExit(child);
    child.unref();
    completeSyncEnrolment(
      // EI-19366263067183489: record the unit the spawn ACTUALLY used, not just the enrolled
      // one. This was `taskScope?.unit ?? null`, so every unconfined-but-ledgered spawn wrote
      // a row with no scope to join on even though its process was sitting in a named scope.
      // `scopeUnit` is null only when there is genuinely no scope (no systemd-run).
      { ...enrolment, scopeUnit },
      {
        class: 'agent-session',
        title: `headless member: ${label}`,
        argv: [bin, ...args.slice(0, 6)],
        cwd: envelope.cwd,
        launchedBy: opts.launchedBy ?? 'console-spawn:headless',
        fleetSlug: opts.fleetSlug ?? null,
        logPath,
        memoryMaxBytes,
        detail: {
          ...(opts.ledgerDetail ?? {}),
          headless: true,
          label,
          ...(coordOwnerId ? { coordOwnerId } : {}),
        },
      },
      child.pid ?? null,
    );
    if (logFd != null) {
      closeSync(logFd); // the child holds its own dup of the fd
      logFd = null;
    }

    // Boot-death probe: psu that dies at launch (bad model spec, missing backend,
    // config-dir fault) exits within the window — surface it + the log tail, not
    // a false ok. A healthy session BLOCKS here (the agent runs), so the probe
    // times out and we report ok.
    const earlyExit = await watchEarlyExit(child, EARLY_EXIT_PROBE_MS);
    // The headless binary never started at all (missing psu/agent CLI on PATH is
    // the live case on the rig mac, where `claude` sits in ~/.local/bin outside
    // the sidecar's ssh-launched PATH). Without this, the fail-open branch below
    // reports a member that does not exist — the same phantom the visible path had.
    if (earlyExit?.error) {
      cleanupKickoffProofRequest(kickoffProofRequest);
      return {
        status: 'error',
        error:
          `headless spawn failed to start: ${earlyExit.error.message}` +
          ` — the binary never ran (is the agent CLI on the operator's PATH?); see ${logPath}`,
        code: 502,
      };
    }
    if (earlyExit) {
      let logTail = '';
      try {
        logTail = readFileSync(logPath, 'utf8').trim().slice(-800);
      } catch {
        logTail = '';
      }
      cleanupKickoffProofRequest(kickoffProofRequest);
      return {
        status: 'error',
        error:
          `headless psu died at boot (${earlyExit.signal ? `signal ${earlyExit.signal}` : `exit ${earlyExit.code ?? 0}`}) within ${EARLY_EXIT_PROBE_MS}ms` +
          `${logTail ? ` — log tail: ${logTail}` : ` — see ${logPath}`}`,
        code: 502,
      };
    }

    // Boot RECEIPT (EI-19311623077693508, the earlier defensive fix). Before the
    // headless-only exit path above, buildConsoleOneliner printed its sentinel
    // and then exec'd a login shell, so a dead agent command stayed alive and
    // watchEarlyExit was structurally blind to it. Keep this receipt scan as a
    // second defense for delayed/alternate launch behavior; the normal headless
    // path now surfaces a command exit directly through watchEarlyExit.
    //
    // Measured on the rig mac 2026-08-02: psu launched, joined the fleet, then
    // died on "Your organization has disabled Claude subscription access for
    // Claude Code" ~2-4s in — comfortably past the 1200ms probe. All three
    // delegated spawns were logged as `honored (1 member(s) opened)` with zero
    // agent processes alive.
    //
    // Scope note: this bounds DETECTION, it does not make it total — a member
    // that dies after the window still returns ok here. The complete answer is
    // the asynchronous liveness plane (presence/sessionState), which reaps a
    // member that stops taking turns. This closes the boot-time case, which is
    // the one that silently consumed a delegated seat.
    const readLog = opts.bootProbes?.readLog ?? ((p: string) => {
      try { return readFileSync(p, 'utf8'); } catch { return ''; }
    });
    const bootSleep = opts.bootProbes?.sleep
      ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms).unref?.(); }));
    const windowMs = opts.bootProbes?.windowMs ?? HEADLESS_BOOT_RECEIPT_MS;
    const bootDeadline = Date.now() + windowMs;
    for (;;) {
      const failed = HEADLESS_GREETING_FAILURE_RE.exec(readLog(logPath));
      if (failed) {
        const tail = readLog(logPath).trim().slice(-800);
        cleanupKickoffProofRequest(kickoffProofRequest);
        return {
          status: 'error',
          error:
            `headless member launched but its agent command died at boot (exit ${failed[1]})` +
            ` — the shell stays open holding a DEAD session, so this never surfaced as a` +
            ` process exit (EI-19311623077693508)${tail ? ` — log tail: ${tail}` : ` — see ${logPath}`}`,
          code: 502,
        };
      }
      if (Date.now() >= bootDeadline) break;
      await bootSleep(250);
    }

    const kickoffProof = kickoffProofRequest
      ? await waitForKickoffProof(kickoffProofRequest, opts.kickoffProofProbes)
      : undefined;
    cleanupKickoffProofRequest(kickoffProofRequest);

    // A host receipt saying the kickoff was never submitted is conclusive: this
    // child cannot become the requested agent. Reap the enrolled task now so a
    // partial launch does not strand an idle headless process and its scope.
    // An absent/timed-out proof is only uncertainty; preserve that process and
    // its identity for the caller to inspect rather than killing a live turn.
    if (kickoffProof?.reason?.startsWith('kickoff-not-submitted:')) {
      let cleaned = false;
      try {
        const cleanup = await killTask(enrolment.taskId);
        cleaned = cleanup.ok || cleanup.error === 'already_gone';
      } catch {
        // Preserve the task identity in the partial-launch result below so
        // the caller can inspect and recover it when cleanup itself fails.
      }
      if (cleaned) {
        return {
          status: 'error',
          error: `headless kickoff was not submitted (${kickoffProof.reason}); task ${enrolment.taskId} was stopped or already gone`,
          code: 502,
        };
      }
    }

    return {
      status: 'ok',
      pid: child.pid ?? null,
      terminal: `headless (log: ${logPath})`,
      taskId: enrolment.taskId,
      logPath,
      normalizedLogPath,
      child,
      childExit,
      display: null,
      desktopEnvResolvedVia: null,
      ...(kickoffProof ? { kickoffProof } : {}),
    };
  } catch (e: any) {
    cleanupKickoffProofRequest(kickoffProofRequest);
    if (logFd != null) {
      try {
        closeSync(logFd);
      } catch { /* already closed */ }
    }
    return { status: 'error', error: `headless spawn failed: ${e?.message}`, code: 500 };
  }
}
