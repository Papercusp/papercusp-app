/**
 * The ONE definition of "where an agent-backend CLI can live, and how to reach it
 * from an env that is NOT the operator's" — WI-37920 / plan
 * agent-launch-verification-and-spawn-env-2026-08-11 (P-001, P-005).
 *
 * WHY THIS FILE EXISTS
 *
 * A desktop-spawned terminal does NOT inherit the operator's environment. Two
 * independent mechanisms strip it, and BOTH were measured on 2026-08-11:
 *
 *   1. A CLIENT-SERVER emulator (gnome-terminal, konsole) hands the command to a
 *      long-lived server process over D-Bus, which runs it under the DESKTOP
 *      session's env. Measured: that server's PATH carried ZERO `.bun` entries
 *      while the operator's carried `~/.bun/bin`.
 *   2. Every spawn runs the command under `bash -lc` — a LOGIN but NON-INTERACTIVE
 *      shell. The near-universal `~/.bashrc` preamble ("If not running
 *      interactively, don't do anything" → `return`) sits ABOVE the lines that add
 *      `~/.bun/bin` (and nvm, and pyenv, and cargo) to PATH, so none of them run.
 *
 * The consequence is per-BACKEND, not per-door: `claude`/`codex` happen to resolve
 * on a desktop PATH, `omp` (bun-installed) does not — so fleets looked immune while
 * `psu --agent=omp` aborted with "the omp backend (`omp`) is not installed" inside a
 * window where `omp` demonstrably works for the human.
 *
 * TWO LAYERS, both required — this is the part that is easy to half-fix:
 *   • DETECTION — psu must FIND the bin without PATH ({@link wellKnownBackendBin}).
 *   • EXECUTION — the bin must RUN. `omp` is `#!/usr/bin/env bun`, so resolving
 *     `omp` is worthless unless `bun` also resolves in the same env. Detection
 *     tests pass while execution fails; only {@link resolveSpawnPathDirs}'s
 *     shebang leg closes it.
 *
 * WHY PLAIN .mjs (same reasoning as `su-tier-roles.mjs`)
 * Both sides of the launch path need this list:
 *   • `apps/operator/scripts/psu-launcher.mjs` — bare `node`, unbundled, cannot
 *     import TypeScript. It decides whether a backend is installed.
 *   • `packages/operator-core/lib/console-launcher.ts` — resolves the dirs to
 *     inject into the spawned terminal's PATH prelude, in the operator process
 *     (which HAS the full env).
 * A copy on each side would be two lists that drift silently, in the worst
 * direction: detection succeeds, execution still fails, and the failure only
 * reproduces inside a desktop terminal.
 *
 * CROSS-PLATFORM CONTRACT (owner, 2026-08-11: "make sure this will also work cross
 * platform including linux machines with different terminals"). Every function
 * here is node-only and takes `platform` / `env` / `home` as parameters:
 *   • no shelling out (`which`, `command -v`, `env -i`) — those assume a POSIX
 *     shell and a POSIX PATH syntax;
 *   • `path.delimiter`, never a hardcoded `:`;
 *   • Windows executable extensions come from PATHEXT;
 *   • shebang resolution is skipped on win32 (the kernel there does not honor one).
 * So the SAME code path holds on Linux (any emulator), macOS (incl. Apple-Silicon
 * /opt/homebrew) and Windows.
 */
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, delimiter, isAbsolute } from 'node:path';

/** The agent CLIs psu can launch. Adding one means adding it here, once. */
export const BACKEND_AGENTS = /** @type {const} */ (['claude', 'codex', 'omp']);

/** Cap on enumerated version dirs (nvm/fnm) so a pathological ~/.nvm can't stall a spawn. */
const MAX_VERSION_DIRS = 8;

/** Cap on injected PATH entries — a bounded, readable prelude line. */
const MAX_SPAWN_PATH_DIRS = 16;

function safeExists(p) {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

function safeIsDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Version-manager bin dirs (nvm, fnm), newest-last-listed-first. `npm i -g` lands
 * here on a huge fraction of dev boxes, and the PATH entry that exposes them is
 * added by the SAME `~/.bashrc` block the non-interactive early-return skips —
 * so these are exactly the dirs a desktop-spawned shell cannot see.
 */
function versionManagerBinDirs(home) {
  const out = [];
  const roots = [
    { base: join(home, '.nvm', 'versions', 'node'), suffix: ['bin'] },
    { base: join(home, '.local', 'share', 'fnm', 'node-versions'), suffix: ['installation', 'bin'] },
  ];
  for (const { base, suffix } of roots) {
    let entries;
    try {
      entries = readdirSync(base);
    } catch {
      continue;
    }
    // Reverse-sorted so a newer node version is searched before an older one.
    for (const name of entries.sort().reverse().slice(0, MAX_VERSION_DIRS)) {
      out.push(join(base, name, ...suffix));
    }
  }
  return out;
}

/**
 * Ordered directories a backend CLI (or its shebang interpreter) can legitimately
 * be installed into, that a login-but-non-interactive desktop shell cannot be
 * relied on to have on PATH.
 *
 * ⚠ ORDER IS THE PRECEDENCE. Papercusp-owned dirs first (an installer this app ran
 * is the one it can vouch for), then per-user package managers, then system-wide
 * prefixes. `/usr/bin` and friends are deliberately ABSENT: every login shell on
 * every platform already has them, so listing them would only add noise.
 */
export function backendSearchDirs({ home = homedir(), env = process.env, platform = process.platform } = {}) {
  const winHome = env.USERPROFILE || home;
  const dirs = [];
  if (platform === 'win32') {
    dirs.push(
      join(winHome, '.papercusp', 'bin'),
      join(winHome, '.papercusp', 'runtime', 'node_modules', '.bin'),
      join(winHome, '.local', 'bin'),
      join(winHome, '.claude', 'bin'),
      join(winHome, '.bun', 'bin'),
      join(winHome, '.npm-global', 'bin'),
      join(winHome, '.volta', 'bin'),
      join(winHome, '.cargo', 'bin'),
      join(winHome, '.deno', 'bin'),
    );
    if (env.APPDATA) dirs.push(join(env.APPDATA, 'npm'));
    if (env.LOCALAPPDATA) dirs.push(join(env.LOCALAPPDATA, 'Programs', 'nodejs'));
    if (env.ProgramFiles) dirs.push(join(env.ProgramFiles, 'nodejs'));
    return dirs;
  }
  dirs.push(
    join(home, '.local', 'bin'),
    join(home, '.papercusp', 'bin'),
    join(home, '.papercusp', 'runtime', 'node_modules', '.bin'),
    join(home, '.claude', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.yarn', 'bin'),
    join(home, '.volta', 'bin'),
    ...versionManagerBinDirs(home),
    join(home, '.cargo', 'bin'),
    join(home, '.deno', 'bin'),
  );
  if (platform === 'darwin') {
    // Apple Silicon's Homebrew prefix. NOT on the default PATH of a login shell
    // that never sourced `brew shellenv` — the macOS twin of the ~/.bun/bin miss.
    dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  } else {
    dirs.push('/home/linuxbrew/.linuxbrew/bin', '/usr/local/bin', '/snap/bin');
  }
  return dirs;
}

/**
 * Candidate file names for an executable on this platform. On win32 a bare name is
 * not executable — PATHEXT decides, so honor it rather than assuming `.exe`.
 */
export function executableNames(bin, { env = process.env, platform = process.platform } = {}) {
  if (platform !== 'win32') return [bin];
  const exts = String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean);
  // The bare name first: a shim installed WITHOUT an extension still exists on
  // disk and is what a WSL/git-bash shell would execute. Both cases of each ext,
  // deduped — PATHEXT is conventionally upper-case but the files on disk are not.
  const names = [bin];
  for (const e of exts) {
    for (const cased of [e.toLowerCase(), e.toUpperCase()]) {
      const n = `${bin}${cased}`;
      if (!names.includes(n)) names.push(n);
    }
  }
  return names;
}

/**
 * Resolve `bin` against a PATH string — pure node, no `which`/`where` subprocess.
 * Returns the absolute path or null.
 *
 * This deliberately does NOT check the executable bit: a file present at
 * `<dir>/<bin>` with the mode wrong is a different (loud, diagnosable) failure
 * than "not installed", and `access(X_OK)` answers about the CURRENT process's
 * uid — which is not necessarily the uid the desktop terminal runs as.
 */
export function resolveOnPath(bin, { env = process.env, platform = process.platform } = {}) {
  if (!bin) return null;
  // An interpreter given as an absolute path is already resolved.
  if (isAbsolute(bin) || bin.includes('/') || (platform === 'win32' && bin.includes('\\'))) {
    return safeExists(bin) ? bin : null;
  }
  const parts = String(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const names = executableNames(bin, { env, platform });
  for (const dir of parts) {
    for (const name of names) {
      const p = join(dir, name);
      if (safeExists(p)) return p;
    }
  }
  return null;
}

/**
 * Search the well-known dirs (PATH-independent) for `bin`. Absolute path or null.
 */
export function resolveInWellKnownDirs(bin, opts = {}) {
  const { env = process.env, platform = process.platform } = opts;
  const names = executableNames(bin, { env, platform });
  for (const dir of backendSearchDirs(opts)) {
    for (const name of names) {
      const p = join(dir, name);
      if (safeExists(p)) return p;
    }
  }
  return null;
}

/**
 * Well-known install location for a BACKEND (the psu-launcher entry point).
 * Absolute path or null. Kept as its own named export because psu-launcher.mjs's
 * `wellKnownBackendBin` delegates to it — one list, two callers, no drift.
 */
export function wellKnownBackendBin(agent, opts = {}) {
  if (!agent) return null;
  return resolveInWellKnownDirs(agent, opts);
}

/**
 * Read a file's shebang interpreter, if it has one.
 *
 * WHY THIS LEG EXISTS AT ALL: `omp` ships as `#!/usr/bin/env bun`. Resolving `omp`
 * and stopping there produces a green detection test and a red terminal — the
 * kernel runs `/usr/bin/env bun`, `env` searches the SPAWNED PATH for `bun`, and
 * the spawned PATH is exactly the one missing `~/.bun/bin`. This was found only by
 * testing EXECUTION, never by testing detection.
 *
 * Returns the interpreter as written (`bun`, `node`, `/usr/local/bin/python3`) or
 * null. `null` on win32: shebangs are not honored by the Windows loader.
 */
export function readShebangInterpreter(binPath, { platform = process.platform, readHead } = {}) {
  if (platform === 'win32') return null;
  let head;
  if (readHead) {
    head = readHead(binPath);
  } else {
    let fd = null;
    try {
      fd = openSync(binPath, 'r');
      const buf = Buffer.alloc(256);
      const n = readSync(fd, buf, 0, 256, 0);
      head = buf.subarray(0, n).toString('utf8');
    } catch {
      return null;
    } finally {
      if (fd != null) {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  }
  if (!head || !head.startsWith('#!')) return null;
  const line = head.split(/\r?\n/, 1)[0].slice(2).trim();
  if (!line) return null;
  const tokens = line.split(/\s+/).filter(Boolean);
  const first = tokens[0];
  if (!first) return null;
  // `#!/usr/bin/env [-S] <prog> [args…]` — the interpreter is the first token that
  // is neither `env` itself nor one of env's own flags.
  if (/(^|\/)env$/.test(first)) {
    for (const t of tokens.slice(1)) {
      if (t.startsWith('-')) continue; // -S, -i, …
      if (t.includes('=')) continue; // NAME=value assignments env accepts
      return t;
    }
    return null;
  }
  return first;
}

/**
 * Resolve ONE backend the way a launch actually needs it: the bin AND, when the
 * bin is a shebang script, the interpreter that must also be reachable.
 *
 * `onPath` reports whether the OPERATOR's PATH found it — informational only. A
 * bin found on the operator's PATH still needs its dir injected, because the
 * spawned terminal's PATH is a different PATH. Conflating the two is the original
 * bug in miniature.
 */
export function resolveBackendLaunch(agent, opts = {}) {
  const { env = process.env, platform = process.platform } = opts;
  const onPathBin = resolveOnPath(agent, { env, platform });
  const bin = onPathBin ?? resolveInWellKnownDirs(agent, opts);
  if (!bin) return null;
  const interpreter = readShebangInterpreter(bin, { platform, readHead: opts.readHead });
  const interpreterBin = interpreter
    ? (resolveOnPath(interpreter, { env, platform }) ?? resolveInWellKnownDirs(interpreter, opts))
    : null;
  return {
    agent,
    bin,
    onPath: Boolean(onPathBin),
    interpreter: interpreter ?? null,
    interpreterBin,
    /** The shebang named an interpreter we could NOT resolve — the window will fail. */
    interpreterMissing: Boolean(interpreter && !interpreterBin),
  };
}

/**
 * THE P-001 ENTRY POINT — the directories to inject into a spawned terminal's PATH
 * so the command it runs is SELF-SUFFICIENT, whatever emulator or OS opens it.
 *
 * Called in the OPERATOR process, which has the full environment; the result
 * travels as a plain string in the console envelope's env, so it is correct for a
 * CLIENT-SERVER emulator (gnome-terminal/konsole, which run under the desktop
 * session's env) and a PROCESS-PER-WINDOW one (xterm/alacritty/kitty/wezterm,
 * which inherit the spawner's) alike — without modelling either.
 *
 * By default it resolves EVERY backend, not just one: `capability:terminal` runs an
 * arbitrary command (the door the owner's failing launch actually went through), so
 * the dirs cannot be selected from a known agent argument. The cost is a few dozen
 * `existsSync` calls.
 */
export function resolveSpawnPathDirs(opts = {}) {
  const agents = opts.agents ?? BACKEND_AGENTS;
  const resolved = [];
  const missing = [];
  const dirs = [];
  const seen = new Set();
  const push = (d) => {
    if (!d || seen.has(d)) return;
    if (!safeIsDir(d)) return;
    seen.add(d);
    if (dirs.length < MAX_SPAWN_PATH_DIRS) dirs.push(d);
  };
  for (const agent of agents) {
    const r = resolveBackendLaunch(agent, opts);
    if (!r) {
      missing.push(agent);
      continue;
    }
    resolved.push(r);
    push(dirname(r.bin));
    if (r.interpreterBin) push(dirname(r.interpreterBin));
  }
  return { dirs, resolved, missing };
}

/** Env key carrying the resolved dirs to every spawner (server-side and Tauri). */
export const SPAWN_PATH_DIRS_ENV = 'PAPERCUSP_BACKEND_PATH_DIRS';

/**
 * The two PATH layers a spawned window is GUARANTEED, split by precedence — the
 * one definition of "what we actually put on that window's PATH", read by both
 * the emitter (console-spawn's buildPathExport) and the checker
 * ({@link preflightBackendLaunch}). Two copies here would let the preflight bless
 * a PATH the emitter never produces, which is a worse failure than no preflight:
 * a confident green followed by a dead window.
 */
export function spawnPathLayers(env = {}) {
  return {
    prepend: [env.PAPERCUSP_BIN_DIR, env.PAPERCUSP_SCRIPTS_DIR].filter(Boolean),
    append: decodeSpawnPathDirs(env[SPAWN_PATH_DIRS_ENV]),
  };
}

/**
 * Will `agent` actually RUN in the window this envelope is about to open?
 *
 * ⚠ THE FALSE-NEGATIVE TRAP THIS EXISTS TO AVOID, stated plainly because it is
 * what made the original bug take two failed launches to diagnose: a probe run
 * from the OPERATOR (capability:bash, a `which` in the tool handler, this
 * process's own `process.env.PATH`) inherits the OPERATOR's environment — which
 * is precisely the environment that does NOT have the defect. Such a probe
 * reports green while the window dies. So this deliberately searches ONLY the
 * dirs we INJECT, and ignores `process.env.PATH` entirely.
 *
 * That makes the check stricter than reality (the window usually also inherits a
 * desktop PATH that may well contain the backend), and that is the point: a pass
 * means the window works NO MATTER what PATH it inherits — the self-sufficiency
 * contract. A fail is reported as a diagnosis, and the caller's job is to refuse
 * to open a doomed window rather than report a confident "Launched".
 *
 * Returns `{ ok, reason, diagnosis, searched, bin, interpreter, foundOffPath }`.
 */
export function preflightBackendLaunch(agent, env = {}, opts = {}) {
  const { platform = process.platform } = opts;
  const { prepend, append } = spawnPathLayers(env);
  const searched = [...prepend, ...append];
  const guaranteedEnv = { PATH: searched.join(delimiter), PATHEXT: env.PATHEXT };

  const bin = resolveOnPath(agent, { env: guaranteedEnv, platform });
  if (!bin) {
    // Did the OPERATOR see it somewhere we failed to inject? That distinction is
    // the difference between "not installed" (user action) and "our injection is
    // broken" (our bug) — and reporting the second as the first is how a defect
    // gets closed as user error.
    const offPath = resolveBackendLaunch(agent, opts);
    return {
      ok: false,
      reason: offPath ? 'resolved-but-not-injected' : 'not-installed',
      bin: null,
      interpreter: null,
      searched,
      foundOffPath: offPath?.bin ?? null,
      diagnosis: describePreflightFailure({ agent, searched, offPath, opts }),
    };
  }

  // The EXECUTION layer. `omp` is `#!/usr/bin/env bun`: a resolvable bin whose
  // interpreter is unreachable dies inside `env`, not at the command, and every
  // detection-shaped check calls that a pass.
  const interpreter = readShebangInterpreter(bin, { platform, readHead: opts.readHead });
  if (interpreter) {
    const interpreterBin = resolveOnPath(interpreter, { env: guaranteedEnv, platform });
    if (!interpreterBin) {
      const offPath = resolveOnPath(interpreter, { env: process.env, platform })
        ?? resolveInWellKnownDirs(interpreter, opts);
      return {
        ok: false,
        reason: 'interpreter-unreachable',
        bin,
        interpreter,
        searched,
        foundOffPath: offPath,
        diagnosis:
          `\`${agent}\` resolves at ${bin}, but its interpreter does NOT.\n\n` +
          `${bin} starts with \`#!… ${interpreter}\`, so the kernel runs ${interpreter} — ` +
          `and ${interpreter} is not on any directory this window is guaranteed. The window ` +
          `would fail inside \`env\`, not at the command, which is why a check that only ` +
          `looks for \`${agent}\` reports success here.\n\n` +
          describeSearched(searched) +
          (offPath
            ? `\n\n  ${interpreter} DOES exist at ${offPath} — the operator can see it but did not ` +
              `inject its directory. That is a bug in the injection (backend-bin-resolve's ` +
              `interpreter leg), not a missing install.`
            : `\n\n  ${interpreter} was not found anywhere. Install it, or reinstall \`${agent}\` ` +
              `with a runtime that is present.`),
      };
    }
    return { ok: true, bin, interpreter, interpreterBin, searched, foundOffPath: null };
  }
  return { ok: true, bin, interpreter: null, interpreterBin: null, searched, foundOffPath: null };
}

function describeSearched(searched) {
  return searched.length
    ? `  Directories this window is guaranteed on PATH:\n${searched.map((d) => `    ${d}`).join('\n')}`
    : '  This window is guaranteed NO directories on PATH — nothing was injected at all.';
}

function describePreflightFailure({ agent, searched, offPath, opts }) {
  const probed = backendSearchDirs(opts);
  const head =
    `Refusing to open a terminal that cannot run \`${agent}\`.\n\n` +
    `A desktop-spawned terminal does not inherit the operator's environment: a ` +
    `client-server emulator (gnome-terminal, konsole) hands the command to a long-lived ` +
    `server that runs it under the DESKTOP session's env, and every spawn runs ` +
    `\`bash -lc\` — login but NON-interactive, so ~/.bashrc's PATH additions are skipped ` +
    `by its "if not running interactively, return" early-exit. So this checks the env the ` +
    `window will ACTUALLY receive, not the operator's.\n\n`;
  if (offPath) {
    return (
      head +
      `\`${agent}\` IS installed — at ${offPath.bin} — but its directory was not injected ` +
      `into the window's PATH. This is OUR bug, not a missing install: report it against ` +
      `backend-bin-resolve's injection leg.\n\n` +
      describeSearched(searched)
    );
  }
  return (
    head +
    `\`${agent}\` was not found in any known install location.\n\n` +
    describeSearched(searched) +
    `\n\n  Well-known install locations probed (${probed.length}):\n` +
    probed.map((d) => `    ${d}`).join('\n') +
    `\n\n  Install it with \`papercusp setup\`, then re-run. If it IS installed somewhere ` +
    `else, that location is missing from backendSearchDirs() in ` +
    `packages/operator-core/lib/backend-bin-resolve.mjs — add it there (one list, three ` +
    `consumers) rather than working around it.`
  );
}

/** Encode dirs for {@link SPAWN_PATH_DIRS_ENV}. Empty list ⇒ '' (caller omits the key). */
export function encodeSpawnPathDirs(dirs) {
  return (dirs ?? []).filter(Boolean).join(delimiter);
}

/**
 * Decode {@link SPAWN_PATH_DIRS_ENV}.
 *
 * ⚠ Splits on `path.delimiter`, NOT on a `[:;]` character class. A Windows path
 * begins `C:\…`, so the permissive class shreds every absolute path on the one
 * platform it was meant to accommodate. Encode and decode always run in the SAME
 * process (the operator resolves the dirs and builds the one-liner), so the
 * platform's own delimiter is both correct and symmetric.
 */
export function decodeSpawnPathDirs(value, { pathDelimiter = delimiter } = {}) {
  return String(value ?? '')
    .split(pathDelimiter)
    .map((s) => s.trim())
    .filter(Boolean);
}
