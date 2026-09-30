/**
 * ensure-omp-su.ts — operator-startup helper that drops the engineer
 * bootstrap files (playbook + papercusp-coord extension + token) into the
 * user's home and registers the papercusp-su MCP in OMP, so the /adv
 * "Launch agent" / "Resume" buttons work without the user having to run
 * apps/operator/scripts/install-standalone-mcp.sh by hand.
 *
 * Scope:
 *   - ensure ~/.papercusp/engineer-collaborator.md exists and is fresh
 *   - ensure ~/.papercusp/papercusp-coord.ts exists and is fresh
 *   - ensure ~/.papercusp/superuser-token + su-agent-id exist
 *   - ensure ~/.omp/agent/mcp.json contains `papercusp-su`
 *   - ensure OMP-native Hindsight config is enabled
 *
 * The omp-su WRAPPER is no longer installed here (psu-only-launch P-050) —
 * psu launches raw omp per-launch (playbook + `-e` coord). This helper still
 * ensures the bootstrap files + MCP registration that psu's raw omp depends
 * on. (The name is kept to avoid churning the boot callers.)
 *
 * Idempotent. Safe to re-run. Logs to stderr; never throws.
 */

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename, delimiter } from 'node:path';
import { execFile } from 'node:child_process';

function dlog(msg: string): void {
  process.stderr.write(`[ensure-omp-su] ${msg}\n`);
}

/** Pure-Node PATH resolution (audit P-080): no shell, so a hostile/odd
 *  `bin` value can never be interpreted as shell syntax. */
function resolveOnPath(bin: string): string | null {
  const dirs = (process.env.PATH ?? '').split(delimiter);
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
      : [''];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* keep scanning */
      }
    }
  }
  return null;
}

function isOnPath(bin: string): boolean {
  return resolveOnPath(bin) !== null;
}

function runOmpConfig(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // `execFile` captures output by default; the callback intentionally ignores it.
    // Its typed options do not support `stdio` (unlike `spawn`), so passing that
    // runtime-only option made the operator typecheck red without changing behavior.
    execFile('omp', args, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function setOmpConfig(key: string, value: string): Promise<void> {
  if (!isOnPath('omp')) return;
  try {
    // This helper runs during operator startup. `execFileSync` here used to
    // freeze the HTTP event loop once per key while OMP loaded its config; five
    // sequential writes were enough to leave accepted connections queued on
    // :3170 even though systemd still reported the process active. Keep the
    // writes ordered, but let libuv wait for each child off the main thread.
    await runOmpConfig(['config', 'set', key, value]);
    dlog(`OMP config ${key}=${value}`);
  } catch (e) {
    dlog(`OMP config ${key} failed: ${(e as Error).message}`);
  }
}

async function ensureOmpHindsightConfig(): Promise<void> {
  const hindsightUrl =
    process.env.PAPERCUSP_HINDSIGHT_API_URL ??
    process.env.HINDSIGHT_API_URL ??
    'http://localhost:8888';
  await setOmpConfig('memory.backend', 'hindsight');
  await setOmpConfig('hindsight.apiUrl', hindsightUrl);
  await setOmpConfig('hindsight.scoping', 'per-project-tagged');
  await setOmpConfig('hindsight.autoRecall', 'true');
  await setOmpConfig('hindsight.autoRetain', 'true');
}

// NOTE (eval-disable scoping, 2026-07-04 / WI-2382): the `eval` builtin doom-loop fix for weak
// local models (ornith IQ3_M reaches for `eval` to run MCP calls as code and loops 56–80× — fatal)
// used to live here as a GLOBAL `omp config set eval.*=false`. That leaked the disable into the
// user's OWN direct (non-psu) omp sessions. It now lives PER-SESSION in psu-launcher's
// `writeOmpSessionConfigDir` (string-surgery on the isolated PI_CONFIG_DIR copy), so eval is off
// only for psu-launched agent sessions and the user's global ~/.omp keeps eval enabled. The
// coord-hook `isEvalCall` execution-block (agent-session-gated) remains as defense-in-depth.

/** Resolve the directory `omp` lives in (so the wrapper lands on the
 *  same PATH); fallback to ~/.local/bin. */
function resolveWrapperDir(home = homedir()): string {
  const ompPath = resolveOnPath('omp');
  if (ompPath) return dirname(ompPath);
  return join(home, '.local', 'bin');
}

export interface EngineerOmpBootstrapState {
  playbookPath: string;
  coordPath: string;
  /** Path a STALE omp-su wrapper would sit at (the wrapper is retired —
   *  reported only so a leftover can be detected/cleaned). */
  wrapperPath: string;
  playbookPresent: boolean;
  coordPresent: boolean;
  /** True if a leftover omp-su wrapper from a pre-retirement install exists. */
  wrapperPresent: boolean;
}

export function readEngineerOmpBootstrapState(home = homedir()): EngineerOmpBootstrapState {
  const playbookPath = join(home, '.papercusp', 'engineer-collaborator.md');
  const coordPath = join(home, '.papercusp', 'papercusp-coord.ts');
  const wrapperPath = join(resolveWrapperDir(home), 'omp-su');
  return {
    playbookPath,
    coordPath,
    wrapperPath,
    playbookPresent: existsSync(playbookPath),
    coordPresent: existsSync(coordPath),
    wrapperPresent: existsSync(wrapperPath),
  };
}

/** Find the operator's source dir so we can copy the playbook + coord
 *  extension from the repo. In a bundled Tauri app these are shipped
 *  as resources; in dev they're at the repo path. Returns null if
 *  neither location resolves. */
export function resolveSourceDir(): string | null {
  const sentinelAt = (dir: string) => join(dir, 'scripts', 'install-standalone-mcp.sh');

  // WI-7344 / EI-19412167276099357: PREFER the canonical repo root when the
  // environment names one, BEFORE falling back to the cwd walk below.
  //
  // Why this order matters, measured on the dev box 2026-08-03: the operator
  // process's cwd is the RELEASE checkout (papercusp-release, green `main`), so
  // the cwd walk resolves the RELEASE copy of every agent-facing artifact this
  // helper and install-standalone-mcp.sh install — the CC hooks and the rendered
  // su persona. Result: an agent lands a hook fix in the staging tree, the fix is
  // committed and correct, and the hook that actually RUNS stays whatever release
  // shipped. Measured that day: ~/.papercusp/hooks/cc/ask-gate-mirror.sh was
  // byte-identical to the release copy dated 2026-07-26 — EIGHT DAYS stale — and
  // was re-installed from release at 03:14 that morning, AFTER the fix landed in
  // staging at 02:37. Two of the three fixes in EI-19412167276099357 were
  // therefore inert on arrival, and the guard they repaired kept misfiring on
  // every agent on the box.
  //
  // This is the same `process.cwd()`-resolves-to-release class that makes
  // testing:run verify main's copy of a file rather than the one you just edited.
  //
  // Deliberately env-gated rather than path-sniffing: these vars are set for
  // dev/psu sessions and the operator services, and are UNSET in a packaged
  // Tauri app (where cwd is the sidecar dir and there is no second checkout), so
  // packaged installs keep exactly today's behavior and only a box that HAS a
  // canonical tree prefers it. Still sentinel-checked, so a stale/incorrect env
  // var falls through instead of pointing the installer at a directory with no
  // scripts/ in it.
  //
  // EI-23749662191699491 (measured 2026-09-20): the guard above SHIPPED and was
  // still a no-op, because it read a variable nothing on this box sets. Read
  // from /proc/<pid>/environ across all 8 live hono-host processes (positive
  // control: PATH present on the same probe, so the UNSET readings are real):
  // PAPERCUSP_REPO_ROOT was UNSET on every one, while
  // PAPERCUSP_INTEGRATION_ROOT was SET on every one — and three of those
  // processes had cwd=papercup-release/apps/operator, i.e. precisely the cwd
  // walk this guard exists to pre-empt. The result was the IDENTICAL failure the
  // comment above describes, recurring 2026-09-20: ~/.papercusp/hooks/cc/
  // ask-gate-mirror.sh was byte-identical to the RELEASE copy (md5
  // 48c32a50b0adcdc68272e8438762e357, 0 lines matching tools_invoke) while the
  // staging fix (md5 43bc5aa1ce7e79123014e515aa49c049, 1 such line) sat
  // committed and inert.
  //
  // So accept EITHER seam. PAPERCUSP_INTEGRATION_ROOT is not a new name invented
  // here: it is the canonical-tree seam release-config.ts and
  // desktop-install/workspace-map.ts already treat as authoritative, which is
  // why the service units set it. PAPERCUSP_REPO_ROOT stays FIRST so an explicit
  // per-process override still wins over the box-wide default.
  for (const envVar of ['PAPERCUSP_REPO_ROOT', 'PAPERCUSP_INTEGRATION_ROOT'] as const) {
    const canonicalRoot = process.env[envVar]?.trim();
    if (!canonicalRoot) continue;
    const operatorAppDir = join(canonicalRoot, 'apps', 'operator');
    if (existsSync(sentinelAt(operatorAppDir))) return operatorAppDir;
  }

  // process.cwd() is the operator app dir when started via `npm run
  // dev` or via the sidecar. Walk up looking for scripts/install-
  // standalone-mcp.sh as a sentinel.
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(sentinelAt(dir))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// (ensureWrapperScript removed — omp-su wrapper retired, P-050.)

async function ensurePapercuspBootstrap(): Promise<void> {
  try {
    const { installPapercuspFiles } = await import('./desktop-install/papercusp-files');
    const files = await installPapercuspFiles();
    if (!files.playbookWritten) dlog('phase1 playbook copy skipped or missing source');
    if (!files.extensionWritten) dlog('phase1 coord extension copy skipped or missing source');
  } catch (e) {
    dlog(`phase1 bootstrap failed: ${(e as Error).message}`);
  }

  try {
    const { installOmpIntegration } = await import('./desktop-install/omp-integration');
    const result = await installOmpIntegration();
    if (result.reason === 'phase1_not_run') {
      dlog('OMP integration skipped: phase1 bootstrap artifacts still missing');
    } else if (result.changed) {
      dlog(`OMP integration updated: ${result.actions.join('; ')}`);
    }
  } catch (e) {
    dlog(`OMP integration failed: ${(e as Error).message}`);
  }

  // Register claude's user-level papercusp-su MCP too (the claude sibling of
  // the omp merge above) so a `psu → claude` session has its tools. No-ops
  // cleanly when ~/.claude.json is absent (claude never launched).
  try {
    const { installClaudeIntegration } = await import('./desktop-install/claude-integration');
    const c = await installClaudeIntegration();
    if (c.changed) dlog('claude MCP integration registered papercusp-su in ~/.claude.json');
    else if (c.reason && c.reason !== 'claude_not_initialized') dlog(`claude MCP integration: ${c.reason}`);
  } catch (e) {
    dlog(`claude MCP integration failed: ${(e as Error).message}`);
  }
}


// Cache the completion of the heavy bootstrap for the process
// lifetime. The original implementation reset `inFlight = null` in a
// `finally` block, defeating the single-flight pattern: every console
// launch re-ran ~5s of work (4× synchronous `omp config set` shellouts
// + file copies). Bootstrap is idempotent at server-startup scope, so
// caching the resolved promise is the right shape.
let completed: Promise<void> | null = null;

export async function ensureOmpSuInstalled(): Promise<void> {
  if (completed) return completed;
  completed = (async () => {
    // Only meaningful on Linux right now — omp-su wrapper is bash; the
    // server-side spawn path in console-launch.ts is Linux-only too.
    // NOTE (windows-desktop-feature-parity-2026-07-02 P-025 audit): on a
    // Windows desktop install the operator sidecar is ALWAYS launched via
    // `wsl.exe --exec node ...` (papercusp-desktop/src-tauri/src/main.rs
    // make_sidecar_command), so this process's `process.platform` reports
    // 'linux' there too — this guard does NOT skip Windows; the bootstrap
    // below already runs (and, per static analysis, is expected to work)
    // on Windows via WSL. It's macOS ('darwin') this guard actually skips.
    if (process.platform !== 'linux') return;

    await ensurePapercuspBootstrap();
    await ensureOmpHindsightConfig();

    // Skip if the bootstrap files are already in place — fast path on reboot.
    const { playbookPath: playbookDest, coordPath: coordDest } =
      readEngineerOmpBootstrapState();

    if (existsSync(playbookDest) && existsSync(coordDest)) {
      return;
    }

    const sourceDir = resolveSourceDir();
    if (!sourceDir) {
      dlog('source dir not found; skipping (cwd=' + process.cwd() + ')');
      return;
    }
    // The playbook is written (with the client-tooling overlay SPLICED in
    // at the marker) by installPapercuspFiles() above — the canonical
    // writer. Do NOT raw-copy it here: a raw copy would ship the base with
    // its literal CLIENT-TOOLING-OVERLAY marker and no task/workflow tooling
    // section. If installPapercuspFiles couldn't write it, a missing
    // playbook (logged above) is preferable to a marker-broken one.
    const coordSrc = join(sourceDir, 'scripts', 'hooks', 'omp', 'coord-hook.ts');

    if (existsSync(coordSrc)) {
      // coord-hook.ts is renamed at install time, so its relative OMP modules
      // must be copied beside the renamed destination too. Reuse the same
      // sibling-bundle installer as the desktop path; naming only today's
      // non-preempting-delivery.ts would regress on the next extraction.
      const { installOmpHookBundle } = await import('./desktop-install/papercusp-files');
      const bundle = await installOmpHookBundle({
        sourceDir: dirname(coordSrc),
        entryFile: 'coord-hook.ts',
        destinationDir: dirname(coordDest),
        destinationEntry: basename(coordDest),
      });
      if (bundle.installed.length > 0) {
        dlog(`installed coord extension bundle → ${coordDest} (${bundle.installed.join(', ')})`);
      }
    } else {
      dlog(`coord extension source missing at ${coordSrc}; skipping`);
    }
    // The omp-su wrapper is no longer written (P-050) — psu launches raw omp.
  })();
  // Don't release the cache on rejection either — a transient failure
  // shouldn't cause the next launch to re-spend 5s repeating the same
  // failing work; we'd rather fail-fast and let the operator
  // restart-fix it.
  return completed;
}
