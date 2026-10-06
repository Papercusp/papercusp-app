/**
 * Capability-exec OS sandbox (agent-capability-confinement-2026-06-13 P-022 / D-008).
 *
 * The `capability:bash` / `capability:git` defineTools spawn real subprocesses in
 * the OPERATOR (Hono host) process — OUTSIDE the per-spawn agent OS sandbox
 * (claude-code's bwrap + socat) that contains a fleet agent's NATIVE Bash. So
 * routing the fleet off native Bash onto `capability:bash` (the B-18 cutover) would
 * move execution from a sandboxed context to an unsandboxed one. This module
 * re-applies an OS sandbox to that operator-side exec path: bwrap filesystem +
 * credential containment, with an optional deny-all-egress network lock.
 *
 * GATED + FAIL-OPEN. The wrap engages only when (a) the `papercusp-capability-exec-sandbox`
 * flag is ON and (b) bwrap actually works on this host. Otherwise the command runs
 * RAW (today's behavior) — so this can never break a host whose unprivileged userns
 * is restricted. The bwrap argv is unit-tested via an injectable seam; the real
 * bwrap + srt exec paths are validated end-to-end by `exec-sandbox.integration.test.ts`
 * on a bwrap-capable host (it skips where bwrap can't sandbox, e.g. CI). On Ubuntu
 * 24.04 a host needs an AppArmor profile granting `/usr/bin/bwrap` the `userns`
 * permission (`apparmor_restrict_unprivileged_userns=1` otherwise shunts unconfined
 * bwrap into the restrictive `unprivileged_userns` profile → `setting up uid map:
 * Permission denied`); see `/etc/apparmor.d/bwrap` and the agent-insights doc.
 *
 * SCOPE (honest): this restores FILESYSTEM + CREDENTIAL containment (the larger
 * blast radius) plus a deny-all-egress lever. DOMAIN-ALLOWLIST egress parity with
 * claude's socat proxy (a sandboxed `npm install` reaches the registry but nothing
 * else) is NOT here — it needs a per-subprocess netns + proxy, the same v1 caveat
 * the daemon bwrap path carries. Tracked as a follow-up; until it lands, arming the
 * exec-sandbox trades claude's socat egress-allowlist for bwrap fs/credential
 * containment (+ the optional deny-all egress lock).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, platform as osPlatform, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { srtBinOnPath, buildFleetSrtSettings, wrapSpawnWithSrt } from '@papercusp/orchestrator';
import { authSandboxMaskAdditions, authSandboxDenyAllEgressOverride } from '../../auth-config-overrides';
import {
  resolveOperationBoundaryProfile,
  type BoundaryContext,
  type OperationBoundaryProfile,
} from './boundary-profile';

/**
 * Credential dirs masked (tmpfs mounted over them, so they read empty) inside the
 * sandbox. Mirrors the fleet sandbox's `FLEET_SANDBOX_DENY_READ` (orchestrator
 * `invoke.ts`) — kept in step by `exec-sandbox.test.ts`. Home-relative; resolved
 * against the operator process home. (claude's sandbox hides these via `denyRead`;
 * bwrap has no per-path read-deny, so a tmpfs overlay is the equivalent.)
 */
export const CAPABILITY_SANDBOX_MASK_DIRS: readonly string[] = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.config/gcloud',
  '.papercusp',
  '.npmrc',
];

/**
 * Absolute executables that capability children must not invoke. Unlike the
 * home-relative credential masks above, these are masked at their canonical
 * host path so both PATH lookup and an explicit absolute invocation are
 * blocked. This applies only to the wrapped paths; the flag-off and
 * bwrap-unavailable fail-open paths remain intentionally raw.
 */
export const CAPABILITY_SANDBOX_MASK_ABSOLUTE_FILES: readonly string[] = ['/usr/bin/systemd-run'];

/**
 * Home-relative entries in {@link CAPABILITY_SANDBOX_MASK_DIRS} that are FILES, not
 * directories. `--tmpfs DEST` needs DEST to be a directory mount point, so a file
 * credential (`~/.npmrc` holds npm auth tokens) is masked with `--ro-bind /dev/null`
 * instead — otherwise the tmpfs mount no-ops and the secret stays readable.
 */
const CAPABILITY_SANDBOX_MASK_FILES: ReadonlySet<string> = new Set(['.npmrc']);

export interface CapabilitySandboxDecision {
  /** Binary to spawn (srt / bwrap, the raw command, or empty when refused). */
  binary: string;
  /** argv for the binary (the wrapper's args + the command, or `cmd.slice(1)`). */
  argv: string[];
  /** true ⇒ wrapped (srt or bwrap). */
  sandboxed: boolean;
  /** Which wrapper ran, or whether the operation was refused before spawn. */
  mode: 'srt' | 'bwrap' | 'raw' | 'unavailable';
  /** Why no wrapper ran (for telemetry / refusal), or null when sandboxed. */
  reason: 'flag-off' | 'bwrap-unavailable' | null;
}

let _bwrapWorksCache: boolean | null = null;

/**
 * True when bwrap is present AND can actually sandbox on this host (cached, like
 * the plugin-loader supervisor's probe). Returns false where the unprivileged
 * userns is restricted (Ubuntu 24.04 without an AppArmor profile granting bwrap
 * the `userns` permission → `setting up uid map: Permission denied`), keeping the
 * exec path fail-open. Tests inject availability via the `bwrapWorks` opt rather
 * than touching this.
 */
export function capabilityBwrapWorks(): boolean {
  if (_bwrapWorksCache !== null) return _bwrapWorksCache;
  if (osPlatform() !== 'linux' || !existsSync('/usr/bin/bwrap')) {
    _bwrapWorksCache = false;
    return false;
  }
  try {
    const r = spawnSync(
      '/usr/bin/bwrap',
      ['--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--die-with-parent', '/bin/true'],
      { stdio: 'ignore', timeout: 5_000 },
    );
    _bwrapWorksCache = r.status === 0;
  } catch {
    _bwrapWorksCache = false;
  }
  return _bwrapWorksCache;
}

/** Test-only: reset the cached bwrap-availability probe. */
export function __resetCapabilityBwrapCache(): void {
  _bwrapWorksCache = null;
}

export interface BuildSandboxInput {
  /** binary + argv, e.g. `['bash','-c',command]` or `['git','status','--porcelain']`. */
  cmd: string[];
  /** Writable working dir — bound rw at its real path, and the sandbox `--chdir`. */
  cwd: string;
}

export interface BuildSandboxOpts {
  /** The resolved `papercusp-capability-exec-sandbox` flag. */
  enabled: boolean;
  /** A confined operation may never downgrade to raw execution. */
  required?: boolean;
  /** EI-16635: true when this spawn is a `run_in_background:true` job — one that
   *  is CONTRACTUALLY meant to outlive the launching `capability:bash` call (the
   *  caller returns immediately and polls `capability:bash_output` later). The
   *  bwrap-fallback's `--die-with-parent` (below) is fundamentally incompatible
   *  with that contract, so it is omitted when `background` is true. Defaults to
   *  false (foreground: keep `--die-with-parent` as a safety net against leaking
   *  a sandboxed tree if the operator itself is killed mid-command). */
  background?: boolean;
  /** Whether bwrap works (defaults to `capabilityBwrapWorks()`); injected by tests. */
  bwrapWorks?: boolean;
  /** srt binary path or null. `undefined` ⇒ resolve via `srtBinOnPath()`; tests inject. */
  srtBin?: string | null;
  /** srt settings file path or null. `undefined` ⇒ resolve via the per-cwd memo; tests inject. */
  srtSettingsPath?: string | null;
  /** Add `--unshare-net` (deny ALL egress) on the BWRAP fallback. Defaults from the env knob. */
  denyAllEgress?: boolean;
  /** Operator home dir (defaults to `homedir()`); injected by tests. */
  homeDir?: string;
  /** bwrap binary (default `'bwrap'`); injected by tests. */
  bwrapBinary?: string;
  /** Predicate: does a credential-mask target exist on the host? Defaults to
   *  `existsSync`; injected by tests. A target that does not exist is SKIPPED —
   *  bwrap cannot create a mount point under the read-only `/` bind (EROFS), so
   *  binding a nonexistent path is fail-CLOSED, and a path with no file has no
   *  secret to mask anyway. */
  maskExists?: (abs: string) => boolean;
}

/**
 * EI-12725: BUILD-CACHE dirs that live OUTSIDE the repo tree, resolved to their REAL
 * paths and made writable in BOTH backends.
 *
 * The sandbox's writable surface is the cwd + /tmp; everything else is under the
 * read-only `/` bind. On this box the heavy Rust/Tauri caches are symlinked OUT of the
 * repo onto the big disk (`~/.cargo-target` and `papercusp-desktop/src-tauri/target`
 * → `/mnt/data/relocated-builds/…`, ~89G). The symlink NODE sits in the writable cwd,
 * but a write follows it to `/mnt/data`, which is read-only in-sandbox — so
 * `npm run tauri -- build` fails for an agent while succeeding in an unsandboxed
 * shell. That divergence, not the box, is what made the AppImage "unbuildable by an
 * agent"; the disk itself is rw (measured 2026-07-18).
 *
 * We therefore bind the RESOLVED targets rw. Rules, each load-bearing:
 * - **realpath, not the symlink path** — binding the link node leaves the write going
 *   through to a read-only target.
 * - **skip what does not exist** — bwrap cannot create a mount point under the
 *   read-only `/` bind (EROFS), so binding a missing path is fail-CLOSED and would
 *   abort every command on a host without these caches (the WI-608 failure mode).
 * - **skip anything already inside the cwd** — a stock checkout keeps `target/` in
 *   the tree, where the cwd bind already covers it; re-binding it is a no-op at best.
 *
 * This widens WRITE only, and only to build caches — the credential masks, the
 * read-only view of the rest of the host, and srt's egress allowlist are untouched.
 */
export function capabilityBuildCacheWritePaths(cwd: string, homeDir?: string): string[] {
  const home = homeDir ?? homedir();
  const candidates = [
    process.env.CARGO_TARGET_DIR,
    join(home, '.cargo-target'),
    join(cwd, 'papercusp-desktop', 'src-tauri', 'target'),
  ];
  const out: string[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      continue; // missing/unreadable ⇒ skip (binding it would fail-CLOSED)
    }
    if (real === cwd || real.startsWith(cwd + sep)) continue; // already writable via the cwd bind
    if (!out.includes(real)) out.push(real);
  }
  return out;
}

/**
 * Per-cwd memo of the srt settings file (network egress allowlist + credential
 * denyRead, from `buildFleetSrtSettings`). Written once per cwd (the allowlist is
 * stable for the operator's lifetime), 0600, so capability:bash isn't writing a
 * temp file per call. Mirrors the fleet sandbox's cache-root convention.
 */
const _srtSettingsByCwd = new Map<string, string>();

export function capabilitySrtSettingsPathForCwd(cwd: string): string {
  const cached = _srtSettingsByCwd.get(cwd);
  if (cached && existsSync(cached)) return cached;
  const dir = join(tmpdir(), 'papercusp-capability-srt');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `srt-${createHash('sha256').update(cwd).digest('hex').slice(0, 16)}.json`);
  // backend:'omp' ⇒ no model-endpoint domains added (a shell command talks to no
  // model); egress = the package registries/CDNs + localhost (the operator + PG).
  const settings = buildFleetSrtSettings({ cwd, backend: 'omp' }) as {
    filesystem: { allowWrite: string[]; denyRead: string[] };
  };
  // EI-12389: srt's OWN default write paths only cover `TMPDIR` (defaults to
  // `/tmp/claude`, NOT the real `/tmp`) — unlike the bwrap-only fallback below,
  // which does `--tmpfs /tmp` (the whole of /tmp writable). That asymmetry broke
  // any tool that needs a well-known /tmp path ignoring TMPDIR (X11's
  // `/tmp/.X11-unix` sockets are hardcoded by the X11 protocol, so relocating
  // TMPDIR — the workaround the reporting cup already tried — can't help them).
  // Add the LITERAL '/tmp' (not `tmpdir()` — that resolves the `TMPDIR` env var,
  // which can point elsewhere, e.g. a test harness setting TMPDIR=/tmp/pcv; the
  // whole point is covering the real /tmp regardless of TMPDIR) to srt's
  // allowWrite so capability:bash's srt path is consistent with its own bwrap
  // fallback.
  // EI-12725: plus the out-of-tree build caches (see capabilityBuildCacheWritePaths),
  // keeping the srt path consistent with the bwrap fallback below — the SAME asymmetry
  // EI-12389 fixed for /tmp, now for the cargo/Tauri target dirs.
  settings.filesystem.allowWrite = [
    ...settings.filesystem.allowWrite,
    '/tmp',
    ...capabilityBuildCacheWritePaths(cwd),
  ];
  // WI-39391: keep the srt-preferred path in parity with the bwrap fallback.
  // Without this absolute denyRead entry, a child can bypass the literal
  // systemd-run command guard by spawning the binary directly.
  settings.filesystem.denyRead = [
    ...settings.filesystem.denyRead,
    ...CAPABILITY_SANDBOX_MASK_ABSOLUTE_FILES,
  ];
  writeFileSync(path, JSON.stringify(settings), { mode: 0o600 });
  _srtSettingsByCwd.set(cwd, path);
  return path;
}

/** Test-only: clear the srt-settings memo. */
export function __resetCapabilitySrtSettings(): void {
  _srtSettingsByCwd.clear();
}

/**
 * ENV ALLOWLIST for a capability-exec'd subprocess (EI-1617). `capability:bash` /
 * `capability:git` / `capability:computer` spawn real subprocesses IN THE OPERATOR
 * (Hono host) process, which previously forwarded its OWN FULL environment
 * (`process.env`, or `stripHostX(process.env)` — which only removes DISPLAY /
 * XAUTHORITY / WAYLAND_DISPLAY) to the child. The operator process env carries
 * operator secrets that have nothing to do with running a shell command or build
 * tool — DB creds, webhook/JWT secrets, session keys, … — so any bee's
 * `capability:bash` could simply `echo $DATABASE_URL` and read them.
 *
 * Fix: switch from a passthrough-minus-denylist to an ALLOWLIST — keep only vars a
 * shell / build / test tool plausibly needs (PATH, HOME, locale, terminal, the
 * common language/package-manager toolchains, and the handful of Papercusp
 * plumbing vars the exec path itself depends on — see
 * `normalizeInheritedOperatorUrl` in bash-jobs.ts), drop everything else. This is
 * the ENV-stripping leg exec-sandbox.ts's bwrap/srt containment deliberately
 * deferred ("Containment is filesystem-level, not env-stripping" above) — the two
 * are complementary, not alternatives.
 *
 * `extraAllow` lets an individual call site widen the set for a command that
 * legitimately needs one more var (e.g. a caller-scoped token) without loosening
 * the default for every capability-exec call.
 */
const EXEC_ENV_ALLOW_EXACT: ReadonlySet<string> = new Set([
  // Core process/shell plumbing.
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'OLDPWD',
  'TERM', 'TERMINFO', 'COLORTERM', 'EDITOR', 'VISUAL', 'PAGER',
  'LANG', 'LC_ALL',
  'TMPDIR', 'TMP', 'TEMP',
  'CI',
  // Network proxy config — a proxy URL/host is operational, not a secret, and its
  // ABSENCE (on a host with none set, the common case here) is a no-op either way.
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR',
  // Native-build linkers (no secrets ride on a library search path).
  'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH',
  // Node/JS toolchain.
  'NODE_ENV', 'NODE_OPTIONS', 'NODE_NO_WARNINGS',
  // Python toolchain.
  'PYTHONPATH', 'PYTHONUNBUFFERED', 'PYTHONDONTWRITEBYTECODE', 'VIRTUAL_ENV',
  // Go toolchain.
  'GOPATH', 'GOROOT', 'GOCACHE', 'GOMODCACHE', 'GOPROXY', 'GOSUMDB', 'GOFLAGS', 'GO111MODULE',
  // Rust toolchain.
  'CARGO_HOME', 'RUSTUP_HOME', 'RUSTFLAGS',
  // JVM/Android toolchains.
  'JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT',
  // Papercusp exec-path plumbing (non-secret): the operator base URL a helper
  // script may need to reach the operator itself, the workspace-root markers
  // the hook/exec paths resolve worktree roots from, and the tracked session /
  // workspace identity that provenance-aware helper scripts (for example
  // scripts/verify-tauri-headless.sh) must carry into a confined child. These
  // are identifiers, not credentials; deliberately do not widen this to every
  // PAPERCUSP_* variable because that namespace also contains secrets.
  'PAPERCUSP_OPERATOR_URL', 'PAPERCUSP_WORKSPACE_ROOT', 'PAPERCUSP_CANONICAL_TREE',
  'PAPERCUSP_SID', 'PAPERCUSP_WORKSPACE',
]);

/** Whole-namespace prefixes: build-tool config vars, none of which carry app
 *  secrets by convention (verified against the 7 vars EI-1617's live repro
 *  actually found leaking — DATABASE_URL, DEFGUARD_API_TOKEN,
 *  ELEVENLABS_WEBHOOK_SECRET, MOBILE_JWT_SECRET,
 *  NEXT_PUBLIC_CHATWOOT_WEBSITE_TOKEN, STARSHIP_SESSION_KEY,
 *  STOREWOLFPASSWORD — none match any prefix below). */
const EXEC_ENV_ALLOW_PREFIXES: readonly string[] = [
  'LC_', 'XDG_',
  'NPM_CONFIG_', 'npm_config_', 'NPM_',
  'YARN_', 'PNPM_',
  'CARGO_', 'RUSTC_',
  'PYENV_',
];

/**
 * The bwrap args that mask credentials under `home`, plus the absolute-path executable
 * masks. ONE emitter, shared by every sandbox that wraps a papercusp subprocess — the
 * capability-exec path here and P-010's desktop tier — because three separate subtleties
 * live in these few lines and a second hand-rolled copy will drift on at least one:
 *
 *  1. FILE vs DIR. `--tmpfs` needs a directory mount point, so a tmpfs over `~/.npmrc`
 *     NO-OPS and leaves the token readable. Files are masked with `--ro-bind /dev/null`.
 *  2. SKIP ABSENT targets. bwrap cannot create a mount point under the read-only `/` bind
 *     (`Can't mkdir …: Read-only file system`) and aborts the WHOLE command — fail-CLOSED,
 *     not just a skipped mask. WI-608: a host merely lacking `~/.config/gcloud` broke every
 *     capability:bash on this path.
 *  3. RUNTIME ADDITIONS. P-019's `exec_sandbox:set_policy` masks are tighten-only and union
 *     over the baked set; a copy that forgets them silently ignores an operator lockdown.
 *
 * Applied AFTER the ro-bind of `/`, so the overlay wins.
 */
export function credentialMaskArgs(
  home: string,
  maskExists: (abs: string) => boolean = existsSync,
): string[] {
  const argv: string[] = [];
  for (const d of [...CAPABILITY_SANDBOX_MASK_DIRS, ...authSandboxMaskAdditions()]) {
    const abs = join(home, d);
    if (!maskExists(abs)) continue;
    if (CAPABILITY_SANDBOX_MASK_FILES.has(d)) argv.push('--ro-bind', '/dev/null', abs);
    else argv.push('--tmpfs', abs);
  }
  // WI-39391: mask the canonical systemd-run binary itself. Binding /dev/null at the real
  // path covers both PATH-resolved and absolute-path invocations.
  for (const abs of CAPABILITY_SANDBOX_MASK_ABSOLUTE_FILES) {
    if (maskExists(abs)) argv.push('--ro-bind', '/dev/null', abs);
  }
  return argv;
}

export function scrubExecEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  extraAllow: readonly string[] = [],
): Record<string, string> {
  const extra = extraAllow.length > 0 ? new Set(extraAllow) : null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v == null) continue;
    if (EXEC_ENV_ALLOW_EXACT.has(k) || extra?.has(k)) {
      out[k] = v;
      continue;
    }
    if (EXEC_ENV_ALLOW_PREFIXES.some((p) => k.startsWith(p))) {
      out[k] = v;
    }
  }
  return out;
}

/** `PAPERCUSP_CAPABILITY_SANDBOX_DENY_ALL_EGRESS=1` → `--unshare-net` (no network). */
export function capabilitySandboxDenyAllEgress(): boolean {
  const v = (process.env.PAPERCUSP_CAPABILITY_SANDBOX_DENY_ALL_EGRESS ?? '').trim().toLowerCase();
  const envDeny = v === '1' || v === 'true' || v === 'on';
  // P-019: the runtime exec_sandbox:set_policy override can only FORCE deny (tighten-only) — it can
  // never re-open egress the env locked down.
  return envDeny || authSandboxDenyAllEgressOverride() === true;
}

/**
 * Decide how to spawn a capability subprocess. PURE given its opts (bwrap
 * availability + flag + knobs are inputs), so the full argv is unit-testable
 * without a live bwrap. The optional trusted-owner rollout remains FAIL-OPEN
 * for compatibility; `required:true` is the confined path and returns an
 * unavailable decision that callers must refuse before spawn.
 */
export function buildCapabilitySandboxCommand(
  input: BuildSandboxInput,
  opts: BuildSandboxOpts,
): CapabilitySandboxDecision {
  const raw = (reason: CapabilitySandboxDecision['reason']): CapabilitySandboxDecision => ({
    binary: input.cmd[0]!,
    argv: input.cmd.slice(1),
    sandboxed: false,
    mode: 'raw',
    reason,
  });
  const unavailable = (reason: Exclude<CapabilitySandboxDecision['reason'], null>): CapabilitySandboxDecision => ({
    binary: '',
    argv: [],
    sandboxed: false,
    mode: 'unavailable',
    reason,
  });
  if (!opts.enabled) return opts.required ? unavailable('flag-off') : raw('flag-off');
  // srt and our bwrap both rest on bubblewrap; if bwrap can't sandbox here, srt
  // can't either. Optional trusted calls retain the legacy raw fallback;
  // required/confined calls return unavailable and are refused before spawn.
  const works = opts.bwrapWorks ?? capabilityBwrapWorks();
  if (!works) return opts.required ? unavailable('bwrap-unavailable') : raw('bwrap-unavailable');

  // PREFER srt (P-033): it adds DOMAIN-ALLOWLIST egress (its socat proxy) on top of
  // the fs + credential containment — full parity with native Bash's fleet sandbox,
  // reusing the validated buildFleetSrtSettings allowlist. Only when srt is absent
  // do we fall back to the bwrap-only path (fs + credential, no domain egress).
  const srtBin = opts.srtBin !== undefined ? opts.srtBin : srtBinOnPath();
  if (srtBin) {
    const settingsPath =
      opts.srtSettingsPath !== undefined ? opts.srtSettingsPath : capabilitySrtSettingsPathForCwd(input.cwd);
    if (settingsPath) {
      const w = wrapSpawnWithSrt(input.cmd[0]!, input.cmd.slice(1), {
        enabled: true,
        backend: 'omp', // a shell command talks to no model — backend only selects model-domains (none for omp)
        srtBin,
        settingsPath,
      });
      return { binary: w.command, argv: w.argv, sandboxed: true, mode: 'srt', reason: null };
    }
  }

  const home = opts.homeDir ?? homedir();
  // SRT is the allowlisted-network route.  When it is absent, a REQUIRED
  // sandbox may still run offline through bwrap, but it must not silently regain
  // the host network.  Trusted/flag-only calls retain the historic bwrap policy.
  const denyAllEgress = opts.denyAllEgress ?? (opts.required || capabilitySandboxDenyAllEgress());
  const bwrap = opts.bwrapBinary ?? 'bwrap';
  const maskExists = opts.maskExists ?? existsSync;
  const argv: string[] = [
    // Read-only view of the whole host fs (builds/tools must READ it)…
    '--ro-bind', '/', '/',
    // …then carve out the writable surfaces. ORDER MATTERS: `--tmpfs /tmp` (a fresh
    // writable /tmp) must come BEFORE the cwd bind. When the cwd is itself under /tmp
    // (e.g. TMPDIR=/tmp/pcv → a mkdtemp working dir), a `--tmpfs /tmp` applied AFTER
    // the cwd bind mounts an empty tmpfs OVER it, so the bind vanishes and `--chdir`
    // fails ("Can't chdir … No such file or directory"). Binding the cwd on TOP of
    // the tmpfs makes bwrap create the mount point inside the writable tmpfs, so the
    // real cwd survives at its path and `--chdir` succeeds.
    '--tmpfs', '/tmp',
    '--bind', input.cwd, input.cwd,
    '--proc', '/proc',
    '--dev', '/dev',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup-try',
    '--chdir', input.cwd,
  ];
  // EI-16635 (RECONCILED): `--die-with-parent` kills the sandboxed tree the moment
  // bwrap's OS parent goes away — fundamentally in tension with `capability:bash`'s
  // `run_in_background:true` contract, which promises the job outlives the
  // launching call. Live-reproduced: with CAPABILITY_EXEC_SANDBOX flag
  // accidentally live-ON (fixed separately — added to DARK_FLAGS, its own
  // documented default), a backgrounded job through this bwrap path died ~3-6s
  // after the launching call returned. Fix: omit the flag entirely for a
  // `background` spawn (opts.background) — this makes the sandboxed path match
  // TODAY'S raw/unsandboxed background-job behavior (the child outlives the
  // call; an operator restart still strands it, exactly like an unsandboxed job
  // does — see EI-8855 / capability:bash_output's stranded-job detection), not a
  // new leak class. Foreground spawns are unaffected (still die with the
  // operator, the existing safety net) — a foreground command is already bounded
  // by its own wall-clock timeout/abort (bash-jobs.ts killProcessTree), so
  // `--die-with-parent` there is pure defense-in-depth, never load-bearing.
  // Still gated: CAPABILITY_EXEC_SANDBOX stays default-OFF pending a live
  // bwrap-capable-host validation (this dev box's userns is restricted, so the
  // fix above is argv-level/unit-tested only here — see
  // exec-sandbox.integration.test.ts for the real-bwrap validation surface) —
  // owner/leader still flips it ON only after that.
  if (!opts.background) argv.push('--die-with-parent');
  // EI-12725: carve the out-of-tree build caches writable too (see
  // capabilityBuildCacheWritePaths). AFTER the cwd bind: these resolve outside the
  // cwd and outside /tmp, so they neither shadow nor are shadowed by those mounts.
  for (const cache of capabilityBuildCacheWritePaths(input.cwd, home)) {
    argv.push('--bind', cache, cache);
  }
  // Mask credential paths. Applied AFTER the ro-bind of `/`, so the overlay wins.
  // Dirs read empty via a tmpfs overlay; file credentials (e.g. ~/.npmrc) read
  // empty via `--ro-bind /dev/null` (a tmpfs needs a DIRECTORY mount point, so a
  // tmpfs over a file no-ops and would leave the secret readable).
  //
  // SKIP a target that does not exist on the host. bwrap cannot create a mount
  // point under the read-only `/` bind — `Can't mkdir …: Read-only file system`
  // for a missing `--tmpfs` dir, `Can't create file at …` for a missing
  // `--ro-bind /dev/null` file — which aborts the WHOLE command (fail-CLOSED),
  // not just the mask. A path that does not exist has no secret to hide anyway,
  // and the read-only home means the sandboxed command cannot create one mid-run,
  // so skipping is safe. (WI-608: without this, a host merely lacking
  // `~/.config/gcloud` broke every capability:bash on the bwrap-fallback path.)
  // P-019: union any runtime add-only mask dirs (exec_sandbox:set_policy) over the baked set —
  // tighten-only (extra masks; the baked set is never removable). Additions are dirs ⇒ tmpfs.
  argv.push(...credentialMaskArgs(home, maskExists));
  if (denyAllEgress) argv.push('--unshare-net');
  // No `--clearenv`: a capability:bash build/test needs the caller's env (PATH,
  // HOME, npm/cargo config); the caller passes the same env to the bwrap spawn and
  // bwrap forwards it. Containment is filesystem-level (above), not env-stripping.
  argv.push('--', ...input.cmd);
  return { binary: bwrap, argv, sandboxed: true, mode: 'bwrap', reason: null };
}

/**
 * Resolve the optional trusted-owner `papercusp-capability-exec-sandbox` rollout
 * flag at spawn time. DEFAULT-OFF and FAIL-OPEN for that compatibility path: a
 * flag-IO error resolves to OFF. Confined callers do not use this result —
 * `capabilityExecSandboxPolicy` forces their wrapper on and requires it.
 */
export async function capabilityExecSandboxEnabled(): Promise<boolean> {
  try {
    return await getFlag(FLAGS.CAPABILITY_EXEC_SANDBOX, 'system');
  } catch {
    return false;
  }
}

export interface CapabilityExecSandboxPolicy {
  /** Whether the existing wrapper selection should engage. */
  enabled: boolean;
  /** Whether failure to obtain a real wrapper must refuse before spawn. */
  required: boolean;
  /** Server-resolved profile retained for result metadata and tests. */
  profile: OperationBoundaryProfile;
}

/**
 * Resolve the actual exec-boundary policy from server-owned caller context.
 * Confined callers force the wrapper on and fail closed independently of the
 * dark rollout flag; trusted owner/operator automation keeps the flag's
 * backwards-compatible raw fallback.
 */
export async function capabilityExecSandboxPolicy(
  ctx: BoundaryContext,
): Promise<CapabilityExecSandboxPolicy> {
  const profile = await resolveOperationBoundaryProfile(ctx);
  if (profile.kind === 'confined') {
    return { enabled: true, required: true, profile };
  }
  return {
    enabled: await capabilityExecSandboxEnabled(),
    required: false,
    profile,
  };
}

export class CapabilityExecConfinementUnavailableError extends Error {
  readonly code = 'capability_exec_confinement_unavailable';

  constructor(reason: Exclude<CapabilitySandboxDecision['reason'], null>, cwd: string) {
    super(
      `${reason}: this caller is confined, but no working capability execution sandbox is available ` +
        `for ${cwd}. Raw host execution was not attempted. Install/repair bwrap (and srt for ` +
        `allowlisted network access), or route the work to a configured container/VM host.`,
    );
    this.name = 'CapabilityExecConfinementUnavailableError';
  }
}

/** Refuse an unavailable confined decision before any child-process effect. */
export function assertCapabilitySandboxAvailable(
  decision: CapabilitySandboxDecision,
  cwd: string,
): void {
  if (decision.mode === 'unavailable') {
    throw new CapabilityExecConfinementUnavailableError(decision.reason!, cwd);
  }
}
