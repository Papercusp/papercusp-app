/**
 * Shared plugin-tool runtime helpers used by both transports
 * (apps/operator/app/api/[transport]/route.ts for MCP and
 * apps/operator/app/api/plugins/[...path]/route.ts for HTTP).
 *
 * Lifted out of the MCP route so the HTTP catch-all can use the same
 * subprocess + secret resolution. Without this, plugin tools that shell
 * out (repomix, code2prompt) only worked over MCP and silently failed
 * over HTTP.
 */
import { spawn as childSpawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, delimiter, resolve } from 'node:path';
import type { PluginSpawn } from '@papercusp/plugin-sdk';

/**
 * The operator sidecar is launched by the Tauri shell / a systemd dev unit
 * with a minimal PATH that frequently omits the directory where `node`/`npx`
 * actually live (Homebrew, nvm). Plugin tools shell out by basename (e.g.
 * repomix → `npx`), so a bare spawn fails with `spawn npx ENOENT`. Augment
 * PATH with the running node's own bin dir + well-known locations, and
 * absolutize the basename so resolution never depends on the supervisor's
 * PATH. (Same absolute-path discipline as setup-pty-commands.ts.)
 *
 * EI-2114: in a PACKAGED Tauri desktop build, `process.execPath` is the
 * Tauri/sidecar binary itself (not node), so `dirname(process.execPath)`
 * resolves to the app-bundle dir — which has no node/npx — and
 * `/home/linuxbrew/.linuxbrew/bin` never exists on an end-user host. Both of
 * this function's dev-box contributors miss on that runtime, which would
 * otherwise leave every basename spawn (repomix, git, npx, …) ENOENT on a
 * packaged desktop. main.rs sets `PAPERCUSP_SIDECAR_BIN` to the bundled
 * runtime's own bin dir (vendored `node` + vendored CLIs — see
 * `packages/operator-core/lib/tool-path.ts`, the canonical tool-dir list) for
 * every packaged/dev-sidecar boot, so include it here FIRST — before the
 * dev-box contributors — as the packaged-runtime fix. It is unset (and this
 * is an inert no-op) outside the sidecar-launched runtime.
 */
export function augmentedSpawnPath(cwd?: string): string {
  // Prepended, not appended: the bundled runtime must win even when the ambient
  // PATH already carries a (wrong-version) node bin dir (EI-2114).
  // Package-manager shells also prepend `node_modules/.bin` for the working
  // package and each workspace ancestor.  Preserve that contract for commands
  // launched through the operator, where the supervisor's PATH has no reason to
  // contain a checkout-local bin directory (EI-21252259002992350).
  const localBinDirs: string[] = [];
  if (cwd) {
    let current = resolve(cwd);
    while (true) {
      const localBin = join(current, 'node_modules', '.bin');
      if (existsSync(localBin)) localBinDirs.push(localBin);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  const home = process.env.HOME ?? '';
  const userNodeBinDirs = home ? discoverUserNodeBinDirs(home) : [];
  const prepend = [
    process.env.PAPERCUSP_SIDECAR_BIN ?? '',
    ...localBinDirs,
    // systemd-launched operator services commonly omit the user's Rust and
    // versioned Node prefixes. Keep the same toolchain surface available to
    // capability:bash children as the interactive psu shell.
    ...(home ? [join(home, '.cargo', 'bin')] : []),
    ...userNodeBinDirs,
  ];
  const extra = [
    dirname(process.execPath), // the running node → its sibling npx/npm
    '/home/linuxbrew/.linuxbrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    process.env.HOME ? join(process.env.HOME, '.local/bin') : '',
    // `omp`'s bare basename (DEFAULT_BACKEND_CMDS.omp = 'omp -p') means the
    // default cup/pot agent spawn (harness-invoke-once.ts buildInvokeOnce,
    // which pins env.PATH to THIS function's return value on the invoke-once
    // child) relies entirely on this list to resolve it. A bun global install
    // lands bins at $BUN_INSTALL/bin, defaulting to ~/.bun/bin — the exact
    // candidate preflight-binaries.ts's `probeOmpBinary` already knows about
    // (it lists `${HOME}/.bun/bin/omp`), which this list had drifted out of
    // sync with. Confirmed missing 2026-08-03: every `cup:spawn` (default
    // role, no AGENT_ROLE_BACKENDS override) via papercup-dev-api failed
    // exit-127 "command not found" because `omp` lives ONLY at
    // ~/.bun/bin/omp and neither dev-api's own PATH nor this augmentation
    // included that directory (EI-19415174699106397-adjacent finding, WI-4944
    // investigation).
    process.env.BUN_INSTALL
      ? join(process.env.BUN_INSTALL, 'bin')
      : process.env.HOME
        ? join(process.env.HOME, '.bun/bin')
        : '',
    // ~/.papercusp/bin — the papercusp shim directory that `installPapercuspFiles`
    // writes (psu, ptool, papercusp, psu-sentinel, and the `rg` entry point) and
    // that `ensureBinOnPath` adds to the user's SHELL profile. A shell profile is
    // not read by a scrubbed `bash -c` child, so until now every operator-spawned
    // child — capability:bash, code:run, saved recipes, exec-sandbox — could not
    // see anything installed there, while a human typing the same command could.
    // That asymmetry is the whole shape of the four independent `rg: command not
    // found` filings (D-001 of orchestration-surface-residue-drain-2026-08-23).
    //
    // DELIBERATELY LAST, and deliberately in `extra` (appended) rather than
    // `prepend`: this directory also holds copies of binaries that resolve
    // elsewhere — notably `omp`, whose canonical location the comment above pins
    // to ~/.bun/bin. Appending it last means it can only ever SUPPLY a command
    // nothing else on PATH provides, never SHADOW one, so adding it cannot change
    // which `omp` (or node, or claude) a spawn already resolves.
    //
    // ⚠ That guarantee is about what THIS FUNCTION CONTRIBUTES — it is NOT a claim
    // that ~/.papercusp/bin is the last element of the returned PATH. The dedup
    // below is FIRST-WINS, so when the ambient PATH already exports this directory
    // (precisely what `ensureBinOnPath` writes into the user's shell profile) the
    // appended copy is dropped and the entry keeps its earlier ambient position,
    // leaving whatever followed it there last. That is the invariant HOLDING — the
    // function added nothing and changed no resolution — not breaking. Do not
    // "fix" it by moving the entry to the tail: that would reorder a PATH the user
    // configured and make operator children resolve differently from the
    // interactive shell they are supposed to mirror. A test that asserted
    // `dirs.at(-1)` against the unpinned host PATH read this backwards and
    // red-pinned the fleet gate with a same-sha verdict flip (EI-21284542595660609).
    process.env.HOME ? join(process.env.HOME, '.papercusp/bin') : '',
  ];
  const seen = new Set<string>();
  return [...prepend, ...(process.env.PATH ?? '').split(delimiter), ...extra]
    .filter((d) => d && !seen.has(d) && (seen.add(d), true))
    .join(delimiter);
}

/**
 * Discover versioned user Node prefixes without pinning today's major (node25
 * → node26). The running node's sibling bin is already included above; these
 * additional prefixes cover a systemd service launched with a different Node
 * binary while preserving the user's managed CLIs for child shell commands.
 */
function discoverUserNodeBinDirs(home: string): string[] {
  const localDir = join(home, '.local');
  try {
    return readdirSync(localDir, { withFileTypes: true })
      .filter((entry) => /^node[^/]*$/.test(entry.name) && entry.isDirectory())
      .map((entry) => join(localDir, entry.name, 'bin'))
      .filter((dir) => existsSync(dir));
  } catch {
    return [];
  }
}

/** Resolve a basename to an absolute path against `path`; returns the bare
 * name if not found so libuv still surfaces a clear ENOENT. */
export function resolveBin(bin: string, path: string): string {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const cand = join(dir, bin);
    if (existsSync(cand)) return cand;
  }
  return bin;
}

export const pluginSpawnImpl: PluginSpawn = (bin, args, opts) =>
  new Promise((resolve, reject) => {
    if (bin.startsWith('/') || bin.startsWith('.')) {
      reject(new Error(`spawn rejected absolute/relative path "${bin}"; use binary basename`));
      return;
    }
    const spawnPath = augmentedSpawnPath(opts?.cwd);
    const child = childSpawn(resolveBin(bin, spawnPath), [...args], {
      cwd: opts?.cwd,
      env: { ...process.env, ...(opts?.env ?? {}), PATH: spawnPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const limit = opts?.maxBufferBytes ?? 1024 * 1024;
    child.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf8'); if (stdout.length > limit) child.kill(); });
    child.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); if (stderr.length > limit) child.kill(); });
    if (opts?.stdin !== undefined) child.stdin?.end(opts.stdin as never);
    else child.stdin?.end();
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, killed }); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
  });

/**
 * Env-only secret resolver — the fallback used when there is no calling
 * plugin to scope the lookup to (first-party tools, in-process callers).
 */
export async function secretImpl(name: string): Promise<string | null> {
  return process.env[name] ?? null;
}

/**
 * Plugin-scoped secret resolver (revive-plugin-system-2026-06-04 D-004).
 *
 * `secretImpl` read ONLY `process.env`, so the encrypted per-(harness,plugin)
 * keys written via `PUT /api/plugins/config` (the "set it via settings" path
 * firecrawl's README promises) were invisible to `ctx.secret`. This resolver
 * reads the calling plugin's `plugin_configs` row FIRST (keyed by manifest
 * name = the projected tool's pluginName = the config-route's canonicalSlug —
 * the same convention the WASM secrets host already uses), then falls back to
 * `process.env`.
 *
 * Precedence: plugin_configs (encrypted, per-plugin, the UI path) > env
 * (process-global, the dev/CI path). The config is loaded at most once per
 * resolver (memoized) so a handler reading several secrets pays one decrypt.
 */
export function makeSecretResolver(scope: {
  harnessSlug: string;
  pluginName: string;
}): (name: string) => Promise<string | null> {
  let cfgPromise: Promise<Record<string, unknown> | null> | undefined;
  const loadCfg = (): Promise<Record<string, unknown> | null> => {
    if (!cfgPromise) {
      // Lazy import so test/CLI contexts without a PG layer don't pay for it
      // unless a secret is actually read. Any failure → null (→ env fallback).
      cfgPromise = (async () => {
        try {
          const { loadPluginConfig } = await import('./plugin-configs-pg');
          return await loadPluginConfig(scope.harnessSlug, scope.pluginName);
        } catch {
          return null;
        }
      })();
    }
    return cfgPromise;
  };
  return async (name: string): Promise<string | null> => {
    const cfg = await loadCfg();
    const v = cfg?.[name];
    if (typeof v === 'string' && v.length > 0) return v;
    return process.env[name] ?? null;
  };
}
