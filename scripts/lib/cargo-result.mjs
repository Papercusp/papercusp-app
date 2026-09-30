// cargo-result.mjs — the pure classification behind the native cargo-test
// reporter and the affected-tests wrapper. Keep this dependency-free: both
// scripts are gate entry points, so a helper import must not pull in a service
// or database module and turn a diagnostic into a runner failure.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

const GIB = 1024 ** 3;
const AFFECTED_CARGO_WORKSPACE = '@papercusp/desktop';

/**
 * Decide whether an affected-test invocation owns the desktop Rust suite.
 *
 * Cargo used to run after every affected invocation, including a one-workspace JS change. That
 * coupled a scoped Vitest verdict to unrelated native capacity/disk admission and could turn a
 * clean JS run red before it emitted its terminal result. Keep the native suite fail-wide inside
 * its actual workspace radius, and preserve the explicit `--all` route. An explicit desktop
 * exclusion wins in both cases, matching the task collector's existing exclusion contract.
 */
export function shouldRunAffectedCargoSuite({
  runAll = false,
  affectedWorkspaceNames = [],
  excludedWorkspaceNames = [],
} = {}) {
  const excluded = new Set(excludedWorkspaceNames ?? []);
  if (excluded.has(AFFECTED_CARGO_WORKSPACE)) return false;
  return (
    runAll === true ||
    new Set(affectedWorkspaceNames ?? []).has(AFFECTED_CARGO_WORKSPACE)
  );
}

/**
 * Resolve an actual `cargo` binary rather than trusting a bare spawn to find it on inherited
 * PATH. Service-managed and Vitest-worker environments can omit rustup's `~/.cargo/bin`; the
 * well-known fallbacks keep every native-test caller on the same resolution contract.
 */
export function resolveCargoBin(env = process.env, home = homedir()) {
  const pathDirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const candidates = [
    ...pathDirs.map((d) => join(d, 'cargo')),
    env.CARGO_HOME ? join(env.CARGO_HOME, 'bin', 'cargo') : null,
    join(home, '.cargo', 'bin', 'cargo'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return 'cargo'; // last resort — let spawn's own ENOENT surface if Cargo is truly absent
}

/**
 * WI-212675: the mount disk admission must measure is the one Cargo WRITES to —
 * the resolved target directory — never the one the manifest happens to sit on.
 * On the dev box `~/.cargo/config.toml` points every checkout's `build.target-dir`
 * at one shared target, and the two can live on different filesystems: the
 * manifest's mount sat at 95% used (owner data, nothing Cargo could reclaim)
 * while the target's mount had hundreds of GiB free, so the native suite was
 * refused every hour over a disk it never writes to.
 *
 * Resolution mirrors Cargo's own precedence instead of re-implementing it:
 *   1. `CARGO_TARGET_DIR` — a relative value resolves from `cwd`, as Cargo does;
 *   2. `cargo metadata`'s `target_directory` — honours every config.toml layer;
 *   3. `<manifest dir>/target` — Cargo's default when nothing is configured.
 * `metadata` is an injectable seam so the precedence is unit-testable without
 * a Cargo binary; a metadata failure falls through to Cargo's default rather
 * than aborting admission.
 */
export function resolveCargoTargetDir(
  manifestAbs,
  { env = process.env, cwd = process.cwd(), metadata = readCargoMetadataTargetDir } = {},
) {
  const configured = typeof env.CARGO_TARGET_DIR === 'string' ? env.CARGO_TARGET_DIR.trim() : '';
  if (configured) return resolve(cwd, configured);
  try {
    const fromMetadata = metadata(manifestAbs, env);
    if (typeof fromMetadata === 'string' && fromMetadata.trim()) return resolve(fromMetadata.trim());
  } catch {
    // fall through to Cargo's default
  }
  return resolve(dirname(manifestAbs), 'target');
}

function readCargoMetadataTargetDir(manifestAbs, env = process.env) {
  const out = execFileSync(
    resolveCargoBin(env),
    ['metadata', '--format-version', '1', '--no-deps', '--manifest-path', manifestAbs],
    { encoding: 'utf8', env, timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 },
  );
  const parsed = JSON.parse(out);
  return typeof parsed?.target_directory === 'string' ? parsed.target_directory : null;
}

/**
 * statfs needs a path that exists, and a first build's target directory does
 * not yet. Walk up to the nearest existing ancestor: every ancestor below the
 * mount point shares the mount, so the measurement is unchanged.
 */
export function diskProbePathFor(dir, { exists = existsSync } = {}) {
  let current = resolve(dir);
  for (;;) {
    if (exists(current)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/**
 * Cargo's cache-directory marker. Cargo clean requires this exact tag before
 * it will remove an explicitly selected target directory; keeping the marker
 * on an isolated target makes disk-pressure reclamation safe after the test
 * producer or its cargo child exits.
 */
export const CARGO_CACHE_TAG = [
  'Signature: 8a477f597d28d172789f06886806bc55',
  '# This file is a cache directory tag created by cargo.',
  '# For information about cache directory tags see https://bford.info/cachedir/',
  '',
].join('\n');

/**
 * Initialize or repair Cargo's cache marker in a producer-selected target.
 * The target is a disposable Cargo cache, so an existing regular marker with
 * stale contents is repaired in place. Symlinks and other non-regular entries
 * are rejected rather than followed into an unrelated path.
 */
/**
 * Where a crate's `cargo llvm-cov --lcov` report must be written for the JS
 * coverage chain to see it (P-010, plan design-to-code-coverage-seam-2026-09-02).
 *
 * This is NOT a free choice, which is why it is a named function rather than a
 * string literal at the call site. `scripts/merge-coverage.ts` finds inputs by
 * walking for a directory literally named `coverage` containing `lcov.info`,
 * and derives the workspace those records are relative to as
 * `dirname(dirname(file))`. Two consequences fix this path:
 *
 *   1. The report must sit at `<crateDir>/coverage/lcov.info` — one level under
 *      the crate — or the records re-anchor against the wrong workspace root.
 *   2. It must NOT sit under `target/`. That walker prunes `target` (as does
 *      affected-tests.mjs), so cargo-llvm-cov's own default output location is
 *      structurally invisible to the merge: the Rust leg would contribute zero
 *      files while every command still exits 0. A coverage gate fed by an
 *      absent producer goes green having measured nothing — the exact failure
 *      plan decision D-028 exists to prevent.
 */
export function cargoCoverageOutputPath(manifestAbs) {
  return resolve(dirname(manifestAbs), 'coverage', 'lcov.info');
}

export function ensureCargoCacheTag(targetDir) {
  if (typeof targetDir !== 'string' || targetDir.length === 0) return null;

  mkdirSync(targetDir, { recursive: true });
  const tagPath = join(targetDir, 'CACHEDIR.TAG');
  if (existsSync(tagPath)) {
    const stat = lstatSync(tagPath);
    if (!stat.isFile()) {
      throw new Error(`CACHEDIR.TAG must be a regular file: ${tagPath}`);
    }
    if (readFileSync(tagPath, 'utf8') === CARGO_CACHE_TAG) return tagPath;
  }

  writeFileSync(tagPath, CARGO_CACHE_TAG, { encoding: 'utf8' });
  return tagPath;
}

/**
 * Keep native-suite admission anchored to the standing disk alarm without turning
 * its percentage warning into an absolute gate on very large filesystems. WI-5080
 * deliberately keeps Cargo targets warm during normal operation, so this is an
 * admission guard, not an unconditional cache cleaner.
 */
/**
 * EI-21149612505559395: a 7.3 TiB volume at 97% used still had 284 GiB free, yet
 * the percentage leg refused Cargo and red-pinned every release. 128 GiB is a
 * deliberately conservative absolute working-headroom escape hatch: it is far
 * above the hard 5 GiB safety floor and the observed native target footprint,
 * while preserving the percentage refusal for genuinely tight volumes (for
 * example the existing 2 TiB / 80 GiB regression case). Kept as a bare constant
 * (not env-driven) so existing direct imports/assertions of this exact value
 * are unaffected; `cargoDiskPolicyFromEnv` below is where a host can actually
 * retune it.
 */
export const CARGO_PERCENT_FLOOR_BYPASS_BYTES = 128 * GIB;

export const DEFAULT_CARGO_DISK_POLICY = Object.freeze({
  freePctMin: 0.1,
  freeBytesMin: 5 * GIB,
  percentFloorBypassBytes: CARGO_PERCENT_FLOOR_BYPASS_BYTES,
});

/** EX_TEMPFAIL: the suite did not run and becomes valid after space is reclaimed. */
export const CARGO_DISK_REFUSAL_EXIT_CODE = 75;

function positiveEnvNumber(env, name, fallback) {
  const value = Number(env?.[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Reuse the disk alarm's existing tuning keys rather than minting a second
 * configuration surface for the Cargo-test entry point.
 *
 * EI-21901389541963783: `percentFloorBypassBytes` defaults to the SAME 128 GiB
 * value as `CARGO_PERCENT_FLOOR_BYPASS_BYTES` — zero behavior change unless a
 * host explicitly sets the env var. This exists so a host with verified,
 * measured peak Cargo working-set data can retune the absolute-headroom escape
 * hatch without editing source; it does not itself change what the default
 * floor is, and does not by itself resolve a real disk-pressure incident. */
export function cargoDiskPolicyFromEnv(env = process.env) {
  return {
    freePctMin:
      positiveEnvNumber(env, 'PAPERCUSP_DISK_ALARM_FREE_PCT', DEFAULT_CARGO_DISK_POLICY.freePctMin * 100) / 100,
    freeBytesMin:
      positiveEnvNumber(env, 'PAPERCUSP_DISK_ALARM_FREE_GB', DEFAULT_CARGO_DISK_POLICY.freeBytesMin / GIB) * GIB,
    percentFloorBypassBytes:
      positiveEnvNumber(
        env,
        'PAPERCUSP_CARGO_DISK_ALARM_PERCENT_FLOOR_BYPASS_GB',
        DEFAULT_CARGO_DISK_POLICY.percentFloorBypassBytes / GIB,
      ) * GIB,
  };
}

/**
 * Host-local cleanup is deliberately conservative and bounded.  The Cargo
 * admission guard is one of the few places that still runs when the hourly
 * janitors have fallen behind, so it is the last safe opportunity to reclaim
 * artifacts which their producers explicitly describe as disposable.
 *
 * The limits are intentionally large enough to clear one genuinely bad build
 * backlog, but finite so a malformed path/glob can never turn admission into
 * an unbounded recursive delete.
 */
export const DEFAULT_CARGO_RECLAIM_POLICY = Object.freeze({
  ephemeralTtlMs: 6 * 3_600_000,
  cargoTtlMs: 24 * 3_600_000,
  /**
   * How recent a `.heartbeat` must be for a producer to count as still live.
   *
   * WI-954677: this used to be the SAME value as `cargoTtlMs`, which silently
   * coupled two unrelated questions — "is this artifact stale enough to be
   * worth reclaiming?" and "is someone still writing to it?". That coupling is
   * why the age gate could not be lowered: shortening `cargoTtlMs` to reach a
   * genuinely stale artifact also shortened the window in which a live build
   * was recognised, so the safe-looking one-line change quietly weakened the
   * liveness check. Keep them separate. Lowering the age gate is a policy
   * choice about cost; lowering this is a correctness regression.
   *
   * Liveness does not actually depend on this value: `activeRunMarker`
   * (pid + start_ticks, immune to PID reuse), `pathIsLive` (open descriptors)
   * and the cargo slot lock all gate reclamation independently. The heartbeat
   * is the weakest of the four, which is exactly why it should not be the one
   * carrying the age policy on its back.
   */
  heartbeatTtlMs: 24 * 3_600_000,
  maxEntries: 12,
  maxBytes: 128 * GIB,
  minCargoArtifactBytes: 512 * 1024 * 1024,
});

const EPHEMERAL_PREFIXES = Object.freeze(['verify-tauri-headless.', 'deb-hzfed.']);
const CARGO_TARGET_NAME_RE = /^\.cargo-target(?:-dev\d+|-pid\d+)?$/;

/**
 * Cargo's own profile output directories. These are the artifacts Cargo itself
 * declares disposable: it rebuilds either one from source on the next run.
 *
 * `debug` is load-bearing here. `cargo test` builds into it, so a host whose
 * free space was consumed *by the native test suite* keeps its single largest
 * reclaimable artifact there. While the candidate set offered only
 * `release/bundle`, admission was unrecoverable in exactly that case: the one
 * candidate on offer was routinely younger than the TTL, the reclaim returned
 * `reclaimed: 0`, and the suite refused to spawn while tens of GiB of its own
 * stale output sat unreachable one directory away.
 */
const CARGO_PROFILE_DIR_NAMES = Object.freeze(['debug', 'release']);

function safeStat(path) {
  try { return statSync(path); } catch { return null; }
}

function hasCanonicalCargoCacheTag(root) {
  const tagPath = join(root, 'CACHEDIR.TAG');
  try {
    const stat = lstatSync(tagPath);
    return stat.isFile() && readFileSync(tagPath, 'utf8') === CARGO_CACHE_TAG;
  } catch {
    return false;
  }
}

const FILESYSTEM_BLOCK_SIZE_BYTES = 512;

function allocatedBytes(stat) {
  const blocks = Number(stat?.blocks);
  return Number.isFinite(blocks) && blocks >= 0
    ? blocks * FILESYSTEM_BLOCK_SIZE_BYTES
    : 0;
}

function safeDirBytes(path) {
  // `stat.size` is the apparent/logical size. Cargo targets and candidate
  // worktrees can contain hardlinks into a peer tree, so summing it claims
  // reclaim that deleting this path cannot actually free. Count allocated
  // filesystem blocks instead, and only count a file when every hardlink is
  // inside the path being removed. This keeps the byte cap and the reported
  // `bytesReclaimed` aligned with the space the delete can really return.
  const files = new Map();
  const visit = (current) => {
    const stat = (() => {
      try { return lstatSync(current); } catch { return null; }
    })();
    if (!stat || stat.isSymbolicLink()) return 0;
    if (stat.isFile()) {
      const device = Number.isFinite(Number(stat.dev)) ? Number(stat.dev) : current;
      const inode = Number.isFinite(Number(stat.ino)) ? Number(stat.ino) : current;
      const key = `${device}:${inode}`;
      const record = files.get(key) ?? {
        allocated: allocatedBytes(stat),
        links: Number.isInteger(stat.nlink) && stat.nlink > 0 ? stat.nlink : 1,
        seen: 0,
      };
      record.seen += 1;
      files.set(key, record);
      return 0;
    }
    if (!stat.isDirectory()) return 0;

    let total = allocatedBytes(stat);
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return total; }
    for (const entry of entries) total += visit(join(current, entry.name));
    return total;
  };

  let total = visit(path);
  for (const file of files.values()) {
    if (file.seen >= file.links) total += file.allocated;
  }
  return total;
}

function pathIsInside(root, candidate) {
  const normalizedRoot = resolve(root);
  const normalized = resolve(candidate.replace(/ \(deleted\)$/, ''));
  return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`);
}

/**
 * Check the kernel's live descriptor/executable/cwd view instead of trusting a
 * pid file or a directory mtime.  This runs only on a low-disk admission path,
 * and returns on the first match; it never emits the raw /proc scan.
 */
function defaultPathIsLive(root, ignoredSubtrees = []) {
  const ignored = ignoredSubtrees.map((path) => resolve(path));
  const isBlockingUse = (path) =>
    pathIsInside(root, path) &&
    !ignored.some((ignoredRoot) => pathIsInside(ignoredRoot, path));
  let processes;
  try { processes = readdirSync('/proc'); } catch { return true; }
  for (const name of processes) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    const proc = `/proc/${name}`;
    for (const special of ['cwd', 'exe']) {
      try {
        if (isBlockingUse(readlinkSync(`${proc}/${special}`))) return true;
      } catch { /* process exited or access was denied */ }
    }
    let fds;
    try { fds = readdirSync(`${proc}/fd`); } catch { continue; }
    for (const fd of fds) {
      try {
        if (isBlockingUse(readlinkSync(`${proc}/fd/${fd}`))) return true;
      } catch { /* descriptor closed during the scan */ }
    }
  }
  return false;
}

function processStartTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return afterComm[19] ?? null; // field 22 (starttime), after field 3 (state)
  } catch { return null; }
}

function activeRunMarker(path) {
  const markerPath = join(path, '.papercusp-run');
  try {
    const values = Object.fromEntries(
      readFileSync(markerPath, 'utf8')
        .split('\n')
        .map((line) => line.split('='))
        .filter(([key, value]) => key && value)
        .map(([key, ...value]) => [key, value.join('=')]),
    );
    const pid = Number(values.pid);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    if (values.start_ticks && processStartTicks(pid) !== values.start_ticks) return false;
    return true;
  } catch { return false; }
}

function freshHeartbeat(path, now, ttlMs) {
  const heartbeat = safeStat(join(path, '.heartbeat'));
  return Boolean(heartbeat && now - heartbeat.mtimeMs < ttlMs);
}

function cargoSlotLockIsHeld(targetDir, homeDir) {
  const name = targetDir.split('/').pop() ?? '';
  const fallbackSlot =
    targetDir.split('/').at(-2) === '.papercusp-target-slots'
      ? /^dev(\d+)$/.exec(name)?.[1]
      : null;
  const slot = name === '.cargo-target'
    ? 0
    : /^\.cargo-target-dev(\d+)$/.exec(name)?.[1]
      ? Number(/^\.cargo-target-dev(\d+)$/.exec(name)[1]) - 1
      : fallbackSlot
        ? Number(fallbackSlot) - 1
        : null;
  if (slot === null) return false;
  const lock = join(homeDir, '.papercusp', 'desktop-dev-slots', `slot${slot}.lock`);
  if (!existsSync(lock)) return false;
  try {
    execFileSync('flock', ['-n', lock, '-c', 'true'], { stdio: 'ignore' });
    return false;
  } catch {
    // Missing flock or a held lock both fail closed.  A cleanup pass must never
    // trade a cold rebuild for corrupting a live desktop target.
    return true;
  }
}

function knownCargoRoots(homeDir, configuredTargetDir) {
  const roots = [];
  try {
    for (const entry of readdirSync(homeDir, { withFileTypes: true })) {
      if (entry.isDirectory() && CARGO_TARGET_NAME_RE.test(entry.name)) {
        roots.push(join(homeDir, entry.name));
      }
    }
  } catch { /* no home scan means no default roots */ }
  if (!configuredTargetDir) return [...new Set(roots)];
  // The target this run is about to build into is scanned LAST. Every guard
  // below still decides whether it may be touched at all; this only settles the
  // ORDER in which equally-eligible artifacts are offered up. A peer's stale
  // target costs nothing to rebuild later, while this run's warm cache is the
  // one WI-5080 deliberately keeps, so it is spent only after the alternatives
  // are exhausted -- and, with a `stopWhen` budget, usually not at all.
  const configured = resolve(process.cwd(), configuredTargetDir);
  return [...new Set([...roots.filter((root) => root !== configured), configured])];
}

function cargoArtifactCandidates(root) {
  if (/-pid\d+$/.test(root.split('/').pop() ?? '')) {
    // Private overflow targets have no stable slot and are safe to remove as a
    // whole once their owner has died. Removing the root in one operation also
    // avoids re-evaluating a parent whose mtime changed after a child removal.
    return [root];
  }
  // Broader candidates are listed before the narrower ones they contain. A
  // TTL-eligible parent is then reclaimed in a single operation and its nested
  // path is skipped as already-missing, while a parent held back by its own
  // freshness still leaves the nested candidate its independent decision --
  // which is how the pre-existing `release/bundle` behaviour is preserved
  // rather than replaced.
  const candidates = [];
  const pushProfileDirs = (base) => {
    for (const profile of CARGO_PROFILE_DIR_NAMES) {
      const dir = join(base, profile);
      const stat = (() => { try { return lstatSync(dir); } catch { return null; } })();
      if (stat?.isDirectory() && !stat.isSymbolicLink()) candidates.push(dir);
    }
  };
  pushProfileDirs(root);
  const releaseBundle = join(root, 'release', 'bundle');
  if (safeStat(releaseBundle)?.isDirectory()) candidates.push(releaseBundle);
  // A non-writable relocation parent places derived/overflow targets under
  // this exact allocator-owned subtree. They are independent Cargo caches,
  // not part of the configured root's profiles, so offer each one as a whole
  // candidate. The caller applies the same age, marker, descriptor and byte
  // guards as every other candidate, plus its mapped slot lock below.
  const fallbackSlotsRoot = join(root, '.papercusp-target-slots');
  let fallbackSlots;
  try {
    fallbackSlots = readdirSync(fallbackSlotsRoot, { withFileTypes: true });
  } catch {
    fallbackSlots = [];
  }
  for (const entry of fallbackSlots) {
    if (
      entry.isDirectory() &&
      !entry.isSymbolicLink() &&
      /^(?:dev\d+|pid\d+)$/.test(entry.name)
    ) {
      candidates.push(join(fallbackSlotsRoot, entry.name));
    }
  }
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return [...new Set(candidates)]; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[A-Za-z0-9_]+-[A-Za-z0-9_]+-/.test(entry.name)) continue;
    pushProfileDirs(join(root, entry.name));
  }
  return [...new Set(candidates)];
}

/**
 * A `/build/<crate>-<16-hex-hash>/` segment — the shape of a build-script dir
 * inside SOME cargo target directory. Used to tell "a path into a cargo target"
 * from any other absolute path a build script may mention.
 */
const CARGO_BUILD_DIR_SEGMENT = /\/build\/[A-Za-z0-9_.-]+-[0-9a-f]{16}(?:\/|$)/;

/**
 * Build-script outputs whose replayed metadata points into ANOTHER cargo target
 * dir that no longer exists — the residue of MOVING a target dir (2026-09-03,
 * WI-212675: ~/.cargo-target → /mnt/data/cargo-target). Cargo caches each build
 * script's `output` file and replays its `cargo:KEY=VALUE` lines to dependents
 * WITHOUT re-running the script while its fingerprint is fresh, and that
 * fingerprint does not cover the target dir's own location. So tauri's cached
 * `…PERMISSION_FILES_PATH=/home/…/.cargo-target/…/out/…` reached
 * papercusp-desktop's build.rs verbatim, which panicked on a file that exists
 * only at the old address (gate run 7f876d2d: `cargo test` exit 101 with ZERO
 * parsed results — indistinguishable from a compile error, red-pinning the gate).
 * Removing the stale build dirs is exactly what makes cargo re-run those
 * scripts; rlibs stay, dependents recompile once.
 *
 * Deliberately NARROW. A referenced path counts as stale only when it
 *   (a) carries a `/build/<crate>-<hash>/` segment (lives in SOME cargo target),
 *   (b) is outside `targetDir`, and
 *   (c) does not exist.
 * A deleted SOURCE path in `rerun-if-changed` is not our business (cargo re-runs
 * on it by itself), and a LIVE sibling target dir is left alone.
 *
 * @param {string} targetDir
 * @param {{ exists?: (path: string) => boolean }} [options]
 * @returns {Array<{ dir: string, profile: string, crate: string, staleRefs: string[] }>}
 */
export function findStaleBuildScriptOutputs(targetDir, { exists = existsSync } = {}) {
  const root = resolve(targetDir);
  const stale = [];
  for (const profile of CARGO_PROFILE_DIR_NAMES) {
    const buildDir = join(root, profile, 'build');
    let entries = [];
    try { entries = readdirSync(buildDir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const dir = join(buildDir, entry.name);
      let text;
      try { text = readFileSync(join(dir, 'output'), 'utf8'); } catch { continue; }
      const staleRefs = new Set();
      for (const line of text.split('\n')) {
        if (!line.startsWith('cargo:')) continue;
        for (const token of line.match(/\/[^\s]+/g) ?? []) {
          const path = token.replace(/[,;)]+$/, '');
          if (!CARGO_BUILD_DIR_SEGMENT.test(path)) continue;
          // A plain prefix test, deliberately NOT the fs-backed pathIsInside: a path into
          // THIS target dir is healthy whether or not it exists yet (an out/ file a later
          // step writes), and must never be read as stale.
          if (path === root || path.startsWith(`${root}/`)) continue;
          if (exists(path)) continue;
          staleRefs.add(path);
        }
      }
      if (staleRefs.size > 0) stale.push({ dir, profile, crate: entry.name, staleRefs: [...staleRefs] });
    }
  }
  return stale;
}

/**
 * Remove the build-script dirs {@link findStaleBuildScriptOutputs} names so cargo
 * re-runs exactly those scripts on the next build. Skips WHOLESALE when another
 * process holds the target dir (a cargo mid-build would be corrupted by a delete
 * underneath it) — the next run simply retries. Synchronous, like the reclaimer:
 * it runs immediately before the cargo child is spawned.
 *
 * @param {string} targetDir
 * @param {{ dryRun?: boolean, exists?: (path: string) => boolean,
 *   pathIsLive?: (path: string) => boolean }} [options]
 * @returns {{ targetDir: string, found: number, dryRun: boolean,
 *   pruned: Array<{ path: string, crate: string, staleRef: string }>,
 *   skipped: Array<{ path: string, reason: string }> }}
 */
export function pruneStaleBuildScriptOutputs(targetDir, options = {}) {
  const dryRun = options.dryRun === true;
  const pathIsLive = options.pathIsLive ?? defaultPathIsLive;
  const exists = options.exists ?? existsSync;
  const root = resolve(targetDir);
  const stale = findStaleBuildScriptOutputs(root, { exists });
  const result = { targetDir: root, found: stale.length, dryRun, pruned: [], skipped: [] };
  if (stale.length === 0) return result;
  if (pathIsLive(root)) {
    result.skipped = stale.map((s) => ({ path: s.dir, reason: 'target dir in use by another process' }));
    return result;
  }
  for (const s of stale) {
    if (!dryRun) {
      try {
        if (lstatSync(s.dir).isSymbolicLink()) throw new Error('symbolic link');
        rmSync(s.dir, { recursive: true, force: true });
      } catch (error) {
        result.skipped.push({ path: s.dir, reason: `remove failed: ${error.message}` });
        continue;
      }
    }
    result.pruned.push({ path: s.dir, crate: s.crate, staleRef: s.staleRefs[0] });
  }
  return result;
}

/**
 * Reclaim explicitly-owned, inactive build artifacts before Cargo admission.
 * This is intentionally synchronous: it runs immediately before a child would
 * otherwise be spawned and must finish before the refreshed statfs decision.
 *
 * @param {{ tmpDir?: string, cargoRoots?: string[], configuredTargetDir?: string,
 *   now?: number, policy?: object, dryRun?: boolean,
 *   pathIsLive?: (path: string, ignoredSubtrees?: string[]) => boolean,
 *   slotLockIsHeld?: (path: string, homeDir: string) => boolean }} options
 * @returns {{ scanned: number, reclaimed: number, bytesReclaimed: number,
 *   skipped: Array<{ path: string, reason: string }>, dryRun: boolean }}
 */
export function reclaimInactiveCargoArtifacts(options = {}) {
  const policy = { ...DEFAULT_CARGO_RECLAIM_POLICY, ...(options.policy ?? {}) };
  const now = options.now ?? Date.now();
  const dryRun = options.dryRun === true;
  const tmpRoot = options.tmpDir ?? tmpdir();
  const homeDir = homedir();
  const pathIsLive = options.pathIsLive ?? defaultPathIsLive;
  const slotLockIsHeld = options.slotLockIsHeld ?? cargoSlotLockIsHeld;
  const result = { scanned: 0, reclaimed: 0, bytesReclaimed: 0, skipped: [], dryRun, stoppedEarly: false };
  // An optional sufficiency budget. Admission passes a predicate that re-reads
  // the mount, so reclamation stops at the first artifact that makes the
  // filesystem admissible instead of spending every eligible candidate up to
  // the entry/byte caps. Deleting the minimum is what actually preserves peer
  // and warm artifacts; the caps alone only bound the damage, they do not
  // avoid it. A throwing or absent predicate degrades to the previous
  // exhaustive behaviour rather than stopping early on a bad read.
  const stopWhen = typeof options.stopWhen === 'function' ? options.stopWhen : null;
  const sufficient = () => {
    if (!stopWhen || result.reclaimed === 0) return false;
    let done = false;
    try { done = stopWhen(result) === true; } catch { return false; }
    if (done) result.stoppedEarly = true;
    return done;
  };
  const reclaimed = (path, bytes) => {
    if (!dryRun) {
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) throw new Error('symbolic link');
        rmSync(path, { recursive: true, force: true });
      } catch (error) {
        result.skipped.push({ path, reason: `remove failed: ${error.message}` });
        return;
      }
    }
    result.reclaimed += 1;
    result.bytesReclaimed += bytes;
  };
  // `heartbeatTtlMs` defaults to `ttlMs` so the ephemeral call site below is
  // byte-for-byte unchanged; only the cargo path passes them separately.
  const canReclaim = (path, ttlMs, heartbeatTtlMs = ttlMs) => {
    const stat = safeStat(path);
    if (!stat || !stat.isDirectory()) return { ok: false, reason: 'missing or not a directory' };
    result.scanned += 1;
    if (now - stat.mtimeMs < ttlMs) return { ok: false, reason: 'younger than ttl' };
    if (activeRunMarker(path)) return { ok: false, reason: 'active run marker' };
    if (freshHeartbeat(path, now, heartbeatTtlMs)) return { ok: false, reason: 'fresh heartbeat' };
    if (pathIsLive(path)) return { ok: false, reason: 'live descriptor or executable' };
    if (existsSync(join(path, '.papercusp-keep'))) return { ok: false, reason: 'explicit keep marker' };
    return { ok: true };
  };

  let tmpEntries = [];
  try { tmpEntries = readdirSync(tmpRoot, { withFileTypes: true }); } catch { tmpEntries = []; }
  for (const entry of tmpEntries) {
    if (result.reclaimed >= policy.maxEntries) break;
    if (!entry.isDirectory() || entry.isSymbolicLink() || !EPHEMERAL_PREFIXES.some((p) => entry.name.startsWith(p))) continue;
    const path = join(tmpRoot, entry.name);
    const decision = canReclaim(path, policy.ephemeralTtlMs);
    if (!decision.ok) {
      result.skipped.push({ path, reason: decision.reason });
      continue;
    }
    if (entry.name.startsWith('deb-hzfed.')) {
      let servers = '';
      try {
        servers = readFileSync(join(path, 'servers'), 'utf8');
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          result.skipped.push({ path, reason: 'server ledger unreadable' });
          continue;
        }
      }
      if (servers.trim()) {
        result.skipped.push({ path, reason: 'server ledger is non-empty' });
        continue;
      }
    }
    const bytes = safeDirBytes(path);
    if (result.bytesReclaimed + bytes > policy.maxBytes) {
      result.skipped.push({ path, reason: 'reclaim byte cap' });
      continue;
    }
    reclaimed(path, bytes);
    if (sufficient()) return result;
    if (result.reclaimed >= policy.maxEntries) break;
  }

  const configuredTargetDir = options.configuredTargetDir ?? process.env.CARGO_TARGET_DIR;
  const configuredRoot = configuredTargetDir
    ? resolve(process.cwd(), configuredTargetDir)
    : null;
  const roots = options.cargoRoots ?? knownCargoRoots(homeDir, configuredTargetDir);
  for (const candidateRoot of roots) {
    if (result.reclaimed >= policy.maxEntries) break;
    const root = resolve(candidateRoot);
    const name = root.split('/').pop() ?? '';
    const legacyNamedRoot = CARGO_TARGET_NAME_RE.test(name);
    const configuredTaggedRoot =
      configuredRoot === root && hasCanonicalCargoCacheTag(root);
    // A config-resolved target may have any basename (`/mnt/data/cargo-target`
    // on the production host), so name matching alone strands the exact cache
    // admission is meant to reclaim. Preserve the narrow deletion boundary:
    // a non-legacy name is eligible only when it is the exact configured path
    // AND carries Cargo's canonical cache-directory marker. An arbitrary path
    // supplied through `cargoRoots` never gains deletion authority by itself.
    if ((!legacyNamedRoot && !configuredTaggedRoot) || !safeStat(root)?.isDirectory()) {
      if (!legacyNamedRoot && configuredRoot === root && !configuredTaggedRoot) {
        result.skipped.push({ path: root, reason: 'configured target lacks canonical CACHEDIR.TAG' });
      }
      continue;
    }
    if (existsSync(join(root, '.papercusp-keep'))) {
      result.skipped.push({ path: root, reason: 'explicit keep marker' });
      continue;
    }
    const slotHeld = slotLockIsHeld(root, homeDir);
    // A configured shared target owns slot-isolated live desktops below this
    // subtree, but cargoArtifactCandidates never offers the subtree itself for
    // deletion. Treating one live slot as a live use of the WHOLE target made
    // every unrelated root-level profile unreachable during disk recovery.
    // Ignore only this non-candidate subtree for the root veto; each candidate
    // still gets its own unignored PID/heartbeat/fd/keep checks below.
    const ignoredRootLiveSubtrees = configuredTaggedRoot
      ? [join(root, '.papercusp-target-slots')]
      : [];
    const live = pathIsLive(root, ignoredRootLiveSubtrees);
    if (slotHeld || live) {
      result.skipped.push({ path: root, reason: slotHeld ? 'target slot is held' : 'live target descriptor' });
      continue;
    }
    for (const path of cargoArtifactCandidates(root)) {
      if (slotLockIsHeld(path, homeDir)) {
        result.skipped.push({ path, reason: 'target slot is held' });
        continue;
      }
      const decision = canReclaim(path, policy.cargoTtlMs, policy.heartbeatTtlMs);
      if (!decision.ok) {
        result.skipped.push({ path, reason: decision.reason });
        continue;
      }
      const bytes = safeDirBytes(path);
      if (bytes < policy.minCargoArtifactBytes) {
        result.skipped.push({ path, reason: 'below cargo artifact size floor' });
        continue;
      }
      if (result.bytesReclaimed + bytes > policy.maxBytes) {
        result.skipped.push({ path, reason: 'reclaim byte cap' });
        continue;
      }
      reclaimed(path, bytes);
      if (sufficient()) return result;
      if (result.reclaimed >= policy.maxEntries) return result;
    }
    if (result.reclaimed >= policy.maxEntries) break;
  }
  return result;
}

/**
 * Pure disk admission decision. `usedPct` and `freeGiB` intentionally use the
 * same scale and rounding as system-health's readDiskPressure writer.
 *
 * `reservedBytes` (EI-21951384112327922) is space OTHER live builds have already
 * declared they are about to consume, read from the shared ledger by
 * scripts/lib/disk-reservations.mjs. Admitting against raw free space is a TOCTOU
 * race that this box loses routinely — ~100 agents share one filesystem, so two
 * builds reading the same "20GB free" both pass and then collectively need more
 * than exists. The floors are therefore applied to free-MINUS-reserved.
 *
 * Deliberately kept PURE and additive: the caller reads the ledger and passes the
 * number in. `freeBytes`/`freeGiB` stay the RAW measurement (a caller reporting
 * disk pressure still wants the true figure), the decision uses the effective
 * one, and an omitted `reservedBytes` reproduces the previous behaviour exactly.
 */
export function assessCargoDiskAdmission(
  { totalBytes, freeBytes, reservedBytes = 0 },
  policy = DEFAULT_CARGO_DISK_POLICY,
) {
  if (
    !Number.isFinite(totalBytes) ||
    totalBytes <= 0 ||
    !Number.isFinite(freeBytes) ||
    freeBytes < 0
  ) {
    return {
      allowed: true,
      status: 'unknown',
      reasons: ['invalid-statfs'],
      totalBytes,
      freeBytes,
      freePct: null,
      usedPct: null,
      freeGiB: null,
      policy,
    };
  }

  // Defensive fallback: any caller passing a policy object that predates this
  // field (a stale cached policy, a hand-built test fixture) still gets the
  // original 128 GiB behavior rather than `undefined` reaching the comparison.
  const percentFloorBypassBytes = Number.isFinite(policy.percentFloorBypassBytes)
    ? policy.percentFloorBypassBytes
    : CARGO_PERCENT_FLOOR_BYPASS_BYTES;

  const reserved = Number.isFinite(reservedBytes) && reservedBytes > 0 ? reservedBytes : 0;
  const effectiveFreeBytes = Math.max(0, freeBytes - reserved);

  const freePct = Math.min(1, freeBytes / totalBytes);
  const effectiveFreePct = Math.min(1, effectiveFreeBytes / totalBytes);
  const reasons = [];
  if (effectiveFreePct < policy.freePctMin && effectiveFreeBytes < percentFloorBypassBytes) {
    reasons.push('free-percent');
  }
  if (effectiveFreeBytes < policy.freeBytesMin) reasons.push('free-bytes');
  if (reasons.length > 0 && reserved > 0) reasons.push('reserved-by-other-builds');
  return {
    allowed: reasons.length === 0,
    status: reasons.length === 0 ? 'ok' : 'blocked',
    reasons,
    totalBytes,
    freeBytes,
    freePct,
    usedPct: Math.round((1 - freePct) * 100),
    freeGiB: Math.floor(freeBytes / GIB),
    reservedBytes: reserved,
    reservedGiB: Math.floor(reserved / GIB),
    effectiveFreeBytes,
    effectiveFreeGiB: Math.floor(effectiveFreeBytes / GIB),
    percentFloorBypassGiB: Math.floor(percentFloorBypassBytes / GIB),
    policy,
  };
}

export function formatCargoDiskRefusal(admission) {
  const minFreePct = Math.round(admission.policy.freePctMin * 1000) / 10;
  const minFreeGiB = Math.round((admission.policy.freeBytesMin / GIB) * 10) / 10;
  // Name the reservations when they are what tipped it: otherwise the reader goes
  // hunting a full disk that is not full, and finds a filesystem with room on it.
  const reserved =
    admission.reservedGiB > 0
      ? `${admission.reservedGiB} GiB of that is already RESERVED by other in-flight builds on this ` +
        `filesystem, leaving ${admission.effectiveFreeGiB} GiB effectively free; `
      : '';
  // Name the mount that was measured: it is the TARGET directory's, which on a
  // multi-disk box is not the checkout's (WI-212675). Without it the reader runs
  // `df` on the source tree and disputes a number that came from elsewhere.
  const where = admission.probePath ? ` at ${admission.probePath}` : '';
  return (
    `[report-cargo-tests] REFUSED before spawning Cargo: filesystem${where} is ${admission.usedPct}% used ` +
    `with ${admission.freeGiB} GiB available; ${reserved}admission requires at least ${minFreePct}% free ` +
    `unless absolute working headroom is at least ${admission.percentFloorBypassGiB} GiB, ` +
    `and always requires at least ${minFreeGiB} GiB free. ` +
    `Reclaim inactive build caches, then retry. Warm targets are preserved by default (WI-5080).`
  );
}

// Cargo test output can inherit terminal title/color control sequences from a
// child test. Strip the complete sequence before parsing result lines so an
// OSC title (BEL or ST terminated) or CSI color/erase prefix cannot hide a
// `test ... ... ok` record from the anchored parser.
const OSC_SEQUENCE_RE = /\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g;
const CSI_SEQUENCE_RE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const ESC_SEQUENCE_RE = /\u001B[ -/]*[@-~]/g;

/**
 * @typedef {'ok' | 'FAILED' | 'ignored'} CargoTestOutcome
 * @typedef {{ name: string, outcome: CargoTestOutcome }} CargoTestResult
 */

/**
 * @param {string} output
 * @returns {string}
 */
export function stripCargoTerminalControlSequences(output) {
  return output
    .replace(OSC_SEQUENCE_RE, '')
    .replace(CSI_SEQUENCE_RE, '')
    .replace(ESC_SEQUENCE_RE, '');
}

/**
 * Parse Cargo's `test <name> ... ok|FAILED|ignored` result lines.
 *
 * @param {string} output
 * @returns {CargoTestResult[]}
 */
export function parseCargoTestResultLines(output) {
  /** @type {CargoTestResult[]} */
  const results = [];
  const re = /^test (\S+) \.\.\. (ok|FAILED|ignored)\s*$/gm;
  let match;
  const normalized = stripCargoTerminalControlSequences(output);
  while ((match = re.exec(normalized))) {
    results.push({ name: match[1], outcome: match[2] });
  }
  return results;
}

/**
 * @typedef {{ signal: number, signalName: string }} CargoTermination
 */

/**
 * Extract cargo's own process-signal discriminator from a failed rustc command.
 * Cargo prints this in the `Caused by:` block, for example:
 *   process didn't exit successfully: `...rustc ...` (signal: 15, SIGTERM: termination signal)
 *
 * @param {string} output combined cargo stdout/stderr
 * @returns {CargoTermination | null}
 */
export function detectCargoTermination(output) {
  const re = /\(signal:\s*(\d+),\s*(SIG[A-Z0-9]+)\b[^)]*\)/g;
  let match;
  while ((match = re.exec(output)) !== null) {
    const signal = Number(match[1]);
    const signalName = match[2];
    if (Number.isInteger(signal) && signal > 0) return { signal, signalName };
  }
  return null;
}

/**
 * Classify the cargo task independently of the recorder's database result.
 *
 * @param {{ code: number | null, output: string, resultCount: number }} input
 * @returns {{ status: 'passed' | 'failed' | 'killed' | 'error', termination: CargoTermination | null }}
 */
export function classifyCargoRun({ code, output, resultCount }) {
  const termination = code !== 0 ? detectCargoTermination(output) : null;
  if (termination) return { status: 'killed', termination };
  if (code === 0 && resultCount > 0) return { status: 'passed', termination: null };
  if (code === 0) return { status: 'error', termination: null };
  return { status: 'failed', termination: null };
}

/**
 * EI-21950408988436927 — why this is its own exported function rather than three
 * inline branches in `scripts/affected-tests.mjs`.
 *
 * The wrapper's cargo branch answers a question the reporter's `classifyCargoRun`
 * cannot: given a task that ALREADY failed, what does a triager get told about it?
 * Three causes arrive through one non-zero exit code and, until this existed, two of
 * them were rendered identically to the third:
 *
 *   - the run was KILLED by a signal (already distinguished),
 *   - the runner REFUSED TO SPAWN cargo at all (exit 75 EX_TEMPFAIL — today's cause
 *     is low-disk admission; see `assessCargoDiskAdmission` above), so zero Rust
 *     tests executed and there is nothing in papercusp-desktop to triage,
 *   - cargo ran and something genuinely failed.
 *
 * Reporting the middle case as `papercusp-desktop :: cargo test` failed is a
 * false-positive generator pointed at source that was never compiled — the
 * expensive direction, because the natural response is to go read Rust.
 *
 * Extracted for the same reason `task-exit-class.mjs` was: this branch runs ONLY
 * when a cargo task has already failed, which on a healthy tree is never, so
 * in-process it is reachable by no test and verifiable only by reading it.
 * Gate-PROTECTING logic must not be the code that never runs until the gate is
 * already broken.
 *
 * ⚠ `gating` is `true` in EVERY case ON PURPOSE, and is returned rather than
 * implied so a test can hold it. A suite that never ran must NOT let the gate go
 * green; only the LABELLING is corrected here. A future edit that "forgives" an
 * admission refusal to unstick a red gate would ship unverified Rust — strictly
 * worse than the misdirection this fixes.
 *
 * Termination is checked FIRST, matching `classifyCargoRun`: a signal kill is
 * observed in cargo's own output and is the more specific claim.
 *
 * @param {{ code: number | null, output?: string }} input
 * @returns {{ kind: 'killed-by-signal' | 'admission-refused' | 'failed', reason: string, termination: CargoTermination | null, gating: true, message: string }}
 */
export function classifyAffectedCargoFailure({ code, output = '' }) {
  const termination = detectCargoTermination(output);
  if (termination) {
    return {
      kind: 'killed-by-signal',
      reason: `killed-by-signal:${termination.signalName}`,
      termination,
      gating: true,
      message:
        `>>> cargo test suite was killed by ${termination.signalName} (signal ${termination.signal}); ` +
        'this is an external process termination, not a compiler diagnostic — re-run before source triage.',
    };
  }
  if (code === CARGO_DISK_REFUSAL_EXIT_CODE) {
    return {
      kind: 'admission-refused',
      reason: 'disk-admission-refused',
      termination: null,
      gating: true,
      message:
        '>>> cargo test suite DID NOT RUN: the runner refused to spawn cargo ' +
        `(exit ${CARGO_DISK_REFUSAL_EXIT_CODE} EX_TEMPFAIL — typically low-disk admission). This is an INFRASTRUCTURE ` +
        'REFUSAL, not a test failure and not a compiler diagnostic: no Rust test was ' +
        'executed, so there is nothing to triage in papercusp-desktop. Reclaim space and ' +
        're-run. Check admission with assessCargoDiskAdmission() in scripts/lib/cargo-result.mjs ' +
        '— it refuses only when freePct < freePctMin AND freeBytes < percentFloorBypassBytes, ' +
        'so a low percentage alone is not the cause.',
    };
  }
  return {
    kind: 'failed',
    reason: 'non-vitest',
    termination: null,
    gating: true,
    message: `>>> cargo test suite exited with code ${code}`,
  };
}

/**
 * Return the reporter's process exit code without allowing an unmeasured Cargo
 * run to pass. Cargo versions/configurations can report an invalid target (for
 * example `--lib` on a bin-only crate) with exit code 0, so a zero parsed-test
 * count must remain a failure even when Cargo itself says it succeeded.
 *
 * @param {{ code: number | null, resultCount: number }} input
 * @returns {number}
 */
export function cargoRunExitCode({ code, resultCount }) {
  if (code === 0 && resultCount === 0) return 1;
  return code ?? 1;
}

/**
 * A keyed, grep-safe line for the run log. The signal fields are deliberately
 * on the same line as the status so a fixed-size tail cannot leave a reader
 * with only "could not compile" and no cause.
 *
 * @param {{ status: 'passed' | 'failed' | 'killed' | 'error', termination?: CargoTermination | null, cause?: string | null, disk?: { usedPct: number, freeGiB: number } | null }} result
 * @returns {string}
 */
export function formatCargoResultLine({ status, termination = null, cause = null, disk = null }) {
  const fields = [`CARGO_RESULT status=${status}`];
  if (termination) {
    fields.push(
      `signal=${termination.signal}`,
      `signalName=${termination.signalName}`,
      'cause=killed-by-signal',
    );
  }
  if (cause) fields.push(`cause=${cause}`);
  if (disk) fields.push(`diskUsedPct=${disk.usedPct}`, `diskFreeGiB=${disk.freeGiB}`);
  return fields.join(' ');
}
