#!/usr/bin/env node
/**
 * EI-18662389554660036 — a single agent's `npm install` on this shared tree
 * breaks EVERY other agent's test runs for minutes (node_modules/.bin/vitest
 * vanishes mid-rewrite), and two OVERLAPPING installs can corrupt a package
 * outright (half-written dist/ — not a version-resolution issue, does not
 * self-heal). There is no advisory lock on a shared-tree-wide mutation this
 * disruptive, even though the exact primitive (a named resource lock) already
 * guards `dev:restart` / `db:migrate` for the same reason.
 *
 * This wrapper serializes `npm install`/`npm ci`/etc invocations across
 * concurrent agent processes on the SAME host via `withFsMutex` (scripts/lib/
 * fs-mutex.mjs — the same mkdir-lock algorithm `withTestcontainerStartLock`
 * already uses for the analogous "many Vitest processes, one Docker handshake"
 * problem). The lock is keyed off the REPO ROOT's real (symlink-resolved) path,
 * so invoking it via the `papercup` symlink or the canonical `papercusp` path
 * both hit the SAME lock (they're one tree) — but a genuinely different
 * checkout (papercup-release, papercup-checkpoint, ...) gets its own lock and
 * is never blocked by this one.
 *
 * EI-18666853411437489 — the mutex stops CONCURRENT installs from corrupting npm's
 * reify bookkeeping, but it cannot detect corruption that ALREADY exists (from an
 * earlier bare `npm install`, or another checkout's run). That failure is silent:
 * npm prints "up to date", exits 0, and leaves a declared dependency un-extracted;
 * the first symptom is a confusing "cannot find module" / Rolldown "failed to
 * resolve" in some unrelated build or gate, often 10+ minutes later. So a successful
 * install is now VERIFIED before the lock is released — every directly-declared
 * dependency directory must resolve AND lockfile-selected critical runtime
 * entrypoints must really import (catching incomplete dist/native/transitive
 * contents) — with ONE bounded auto-repair before failing loudly. A nonzero repair
 * exit is itself fatal; a later spot probe may not erase an ENOTEMPTY failure.
 * Set PAPERCUSP_SKIP_DEP_VERIFY=1 to skip the verification.
 *
 * Managed hives reuse this same implementation with `--repo-root`; the lock
 * and npm cwd both follow that explicit target instead of this script's repo.
 * A `--prefix` install remains outside this wrapper because npm owns the target
 * selection in that shape and the global guard deliberately leaves it alone.
 *
 * Usage: npm run install:safe [-- <npm args>]   (defaults to plain `npm install`)
 *        node scripts/npm-install-safe.mjs ci
 *        node scripts/npm-install-safe.mjs install --legacy-peer-deps
 *        node scripts/npm-install-safe.mjs --offline-safe ci
 *        node scripts/npm-install-safe.mjs --repo-root /path/to/hive -- install --no-save pkg
 *        node scripts/npm-install-safe.mjs --repo-root /path/to/hive --exec-under-lock -- command arg...
 *
 * `--offline-safe` is a wrapper-only mode for exact-candidate reconstruction. It
 * sets `ONNXRUNTIME_NODE_INSTALL=skip` in npm and bounded-repair children without
 * mutating the caller's environment or forwarding the wrapper flag to npm. An
 * explicit caller-provided `ONNXRUNTIME_NODE_INSTALL` value remains authoritative.
 *
 * `--exec-under-lock` is the reader-side half of the same contract. Long-lived
 * host services build an entrypoint from node_modules immediately before boot;
 * if systemd restarts one while an install is reifying the shared tree, the
 * build/runtime can observe a half-extracted native package and crash-loop.
 * Running that build command under the install mutex makes it wait for the
 * verified install boundary instead of repeatedly reading the transition.
 */
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  PACKAGE_CACHE_MUTEX_NAME,
  withFsMutexRead,
  withFsMutex,
} from "./lib/fs-mutex.mjs";
import {
  findIncompleteWorkspacePackagesWithRetry,
  findInvalidWorkspacePackageVersionsWithRetry,
  findUnextractedDepsWithRetry,
  findUnsatisfiedDeclaredDepRangesWithRetry,
  findUnusableRuntimeDepsWithRetry,
  formatIncompleteWorkspacePackages,
  formatInvalidWorkspacePackageVersions,
  formatMissing,
  formatRuntimeFailures,
  formatUnsatisfiedDeclaredDepRanges,
  resolveWorkspaceDirs,
} from "./check-declared-deps-extracted.mjs";

const DEFAULT_REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

const REPAIR_ARGS = ["install", "--legacy-peer-deps"];
const EXEC_UNDER_LOCK_FLAG = "--exec-under-lock";
const OFFLINE_SAFE_FLAG = "--offline-safe";
const CACHE_VERIFY_ARGS = ["cache", "verify"];
const DEPENDENCY_GENERATION_SCRIPT = join(
  DEFAULT_REPO_ROOT,
  "apps/operator/bin/release/dependency-generation.sh",
);

/**
 * Keep an explicit --cache override attached to the cache repair. Without it,
 * `npm run install:safe -- --cache <dir> ...` would verify the user's default
 * cache and then reify from a different cache, leaving the corrupt one
 * untouched. Environment/config-file cache selection is inherited by npm.
 */
export function cacheVerifyArgs(npmArgs = []) {
  const cacheArgs = [];
  for (let index = 0; index < npmArgs.length; index += 1) {
    const arg = npmArgs[index];
    if (arg === "--cache" && typeof npmArgs[index + 1] === "string") {
      cacheArgs.push(arg, npmArgs[index + 1]);
      index += 1;
    } else if (typeof arg === "string" && arg.startsWith("--cache=")) {
      cacheArgs.push(arg);
    }
  }
  return [...CACHE_VERIFY_ARGS, ...cacheArgs];
}

/**
 * npm's repeatable workspace selectors (`--workspace X`, `--workspace=X`, `-w X`,
 * `-w=X`) in argv order. An empty list means an unscoped, whole-project command.
 */
export function workspaceSelectorsForNpmArgs(npmArgs = []) {
  const selectors = [];
  for (let index = 0; index < npmArgs.length; index += 1) {
    const arg = npmArgs[index];
    if (arg === "--workspace" || arg === "-w") {
      if (typeof npmArgs[index + 1] === "string")
        selectors.push(npmArgs[++index]);
    } else if (typeof arg === "string" && arg.startsWith("--workspace=")) {
      selectors.push(arg.slice("--workspace=".length));
    } else if (typeof arg === "string" && arg.startsWith("-w=")) {
      selectors.push(arg.slice("-w=".length));
    }
  }
  return selectors;
}

/**
 * Resolve npm's repeatable workspace selectors to the canonical repo-relative
 * directories consumed by the dependency-integrity scanners. npm accepts both
 * package names and paths, while those scanners intentionally accept paths only.
 * No selector means a full install and therefore a full-tree verification.
 */
export function verificationScopeForNpmArgs({
  repoRoot = DEFAULT_REPO_ROOT,
  npmArgs = [],
  deps = {},
} = {}) {
  const selectors = workspaceSelectorsForNpmArgs(npmArgs);
  if (selectors.length === 0)
    return { workspaceDirs: undefined, repairWorkspaceArgs: [] };

  const readJson =
    deps.readJson ?? ((path) => JSON.parse(readFileSync(path, "utf8")));
  const workspaceDirs = resolveWorkspaceDirs(repoRoot, deps);
  const bySelector = new Map();
  for (const dir of workspaceDirs) {
    bySelector.set(dir, dir);
    bySelector.set(`./${dir}`, dir);
    const manifest = readJson(join(repoRoot, dir, "package.json"));
    if (typeof manifest?.name === "string") bySelector.set(manifest.name, dir);
  }
  const selectedDirs = selectors.map((selector) => {
    const dir = bySelector.get(selector);
    if (!dir)
      throw new Error(
        `npm workspace selector did not resolve after install: ${selector}`,
      );
    return dir;
  });
  const uniqueDirs = [...new Set(selectedDirs)];
  return {
    workspaceDirs: uniqueDirs,
    repairWorkspaceArgs: selectors.map((selector) => `--workspace=${selector}`),
  };
}

/**
 * Verify and repair npm's content-addressed cache before reification. npm's
 * cache verifier removes index entries whose content blobs disappeared, so a
 * stale cacache reference cannot make the install fail with an opaque ENOENT.
 * The caller runs this while holding the same repo-keyed install mutex as the
 * subsequent npm command.
 */
export function verifyNpmCache({
  repoRoot = DEFAULT_REPO_ROOT,
  npmArgs = [],
  runNpm = spawnSync,
  env = process.env,
} = {}) {
  const result = runNpm("npm", cacheVerifyArgs(npmArgs), {
    cwd: repoRoot,
    stdio: "inherit",
    env,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function isStrictlyWithin(parent, candidate) {
  const rel = relative(parent, candidate);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

/**
 * Convert detector findings into the only paths install:safe may remove before
 * its bounded repair. Both the workspace and package segments are untrusted
 * manifest-derived strings, so validate the repo boundary and the narrower
 * <workspace>/node_modules boundary before returning a target.
 */
export function packageLocalRepairTargets({
  repoRoot = DEFAULT_REPO_ROOT,
  findings = [],
} = {}) {
  const root = resolve(repoRoot);
  const targets = findings.map((finding) => {
    if (
      typeof finding?.workspace !== "string" ||
      finding.workspace.length === 0 ||
      typeof finding?.package !== "string" ||
      finding.package.length === 0
    ) {
      throw new Error(
        "refusing package-local repair target without workspace and package names",
      );
    }
    const nodeModulesDir = resolve(root, finding.workspace, "node_modules");
    if (!isStrictlyWithin(root, nodeModulesDir)) {
      throw new Error(
        `refusing package-local repair outside repo root: ${finding.workspace}/node_modules`,
      );
    }
    const target = resolve(nodeModulesDir, finding.package);
    if (!isStrictlyWithin(nodeModulesDir, target)) {
      throw new Error(
        `refusing package-local repair outside workspace node_modules: ${finding.workspace}/node_modules/${finding.package}`,
      );
    }
    return target;
  });
  return [...new Set(targets)].sort();
}

function removePackageLocalRepairTargets({ repoRoot, findings, deps = {} }) {
  const removePath =
    deps.removePath ??
    ((target) => rmSync(target, { recursive: true, force: true }));
  const targets = packageLocalRepairTargets({ repoRoot, findings });
  for (const target of targets) removePath(target);
  return targets;
}

/**
 * Remove a detector-confirmed stale package-local entry from package-lock.json
 * before npm reifies it again. The on-disk target alone is insufficient: npm
 * treats an orphaned lock entry as install intent even when the workspace's
 * current declaration is satisfied by a hoisted package.
 *
 * Only delete an exact entry whose locked version still matches the invalid
 * installed version the detector observed. A newer/different lock entry may be
 * a concurrent repair and must not be removed. The write is atomic so an
 * interrupted repair cannot leave the shared lockfile half-written.
 */
export function removePackageLocalRepairLockEntries({
  repoRoot = DEFAULT_REPO_ROOT,
  findings = [],
  deps = {},
} = {}) {
  if (findings.length === 0) return [];

  const root = resolve(repoRoot);
  const lockPath = join(root, "package-lock.json");
  const readLock =
    deps.readLock ?? (() => JSON.parse(readFileSync(lockPath, "utf8")));
  const writeLock =
    deps.writeLock ??
    ((lock) => {
      const tempPath = join(
        root,
        `.package-lock.json.papercusp-repair-${process.pid}`,
      );
      try {
        writeFileSync(tempPath, `${JSON.stringify(lock, null, 2)}\n`);
        renameSync(tempPath, lockPath);
      } finally {
        rmSync(tempPath, { force: true });
      }
    });

  let lock;
  try {
    lock = readLock();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (
    !lock ||
    typeof lock !== "object" ||
    !lock.packages ||
    typeof lock.packages !== "object" ||
    Array.isArray(lock.packages)
  ) {
    throw new Error(
      "refusing package-local repair: package-lock.json has no packages object",
    );
  }

  const removed = [];
  for (const finding of findings) {
    const [target] = packageLocalRepairTargets({
      repoRoot: root,
      findings: [finding],
    });
    const key = relative(root, target).split(sep).join("/");
    const entry = lock.packages[key];
    if (
      typeof finding.installed !== "string" ||
      typeof entry?.version !== "string" ||
      entry.version !== finding.installed
    ) {
      continue;
    }
    delete lock.packages[key];
    removed.push(key);
  }

  if (removed.length > 0) writeLock(lock);
  return removed;
}

/**
 * npm's per-entry dependency-type flags in package-lock.json. They record HOW a
 * package is reachable (only through devDependencies, only through optional
 * edges, through either, as a peer) — never WHICH bytes are installed.
 */
const LOCKFILE_DEP_FLAG_KEYS = new Set(["dev", "optional", "devOptional", "peer"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function withoutLockfileDepFlags(entry) {
  if (!isPlainObject(entry)) return entry;
  const rest = {};
  for (const [key, value] of Object.entries(entry)) {
    if (!LOCKFILE_DEP_FLAG_KEYS.has(key)) rest[key] = value;
  }
  return rest;
}

/**
 * Compare two parsed lockfiles. Returns the `packages` keys whose ONLY
 * difference is npm's dependency-type flags (`[]` = semantically identical), or
 * `null` when ANYTHING else differs: a version, resolved URL or integrity, a
 * dependency edge, an added or removed package, or any top-level field.
 */
export function lockfileDepFlagOnlyChanges(before, after) {
  if (!isPlainObject(before) || !isPlainObject(after)) return null;
  const topKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of topKeys) {
    if (key !== "packages" && !isDeepStrictEqual(before[key], after[key]))
      return null;
  }
  const beforePackages = before.packages;
  const afterPackages = after.packages;
  if (!isPlainObject(beforePackages) || !isPlainObject(afterPackages))
    return null;
  const beforeKeys = Object.keys(beforePackages);
  if (beforeKeys.length !== Object.keys(afterPackages).length) return null;
  const changed = [];
  for (const key of beforeKeys) {
    if (!Object.hasOwn(afterPackages, key)) return null;
    const was = beforePackages[key];
    const now = afterPackages[key];
    if (isDeepStrictEqual(was, now)) continue;
    if (
      !isDeepStrictEqual(withoutLockfileDepFlags(was), withoutLockfileDepFlags(now))
    )
      return null;
    changed.push(key);
  }
  return changed;
}

/** The root package-lock.json text, or `undefined` when there is none. */
export function readLockfileText(repoRoot = DEFAULT_REPO_ROOT, deps = {}) {
  const lockPath = join(resolve(repoRoot), "package-lock.json");
  const readText = deps.readText ?? (() => readFileSync(lockPath, "utf8"));
  try {
    return readText();
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * WI-10003114: undo a workspace-scoped command's lockfile rewrite when it changed
 * nothing but npm's dependency-type flags.
 *
 * `npm install --workspace=A --workspace=B` recomputes dev/optional/devOptional
 * for the WHOLE lockfile, but it does so without seeing the whole workspace graph.
 * An unscoped install writes one set of flags and a scoped install writes another,
 * so the committed lockfile flips between them depending on which ran last.
 * Measured 2026-09-29: an unscoped shared-tree install flipped 196 entries
 * dev -> devOptional. The desktop sidecar build's scoped installs then flipped
 * them back inside the exact-SHA live-certification checkout. Every certification
 * of green main 93f1c720 went RED `certification-source-dirty-at-build-end`
 * (dirty file: package-lock.json only) even though every functional leg passed.
 *
 * Restoring those bytes cannot change what is installed: the rewrite touched no
 * version, URL, integrity or dependency edge (a formatting-only rewrite is
 * restored for the same reason). A substantive rewrite (a new dependency, a
 * version bump, a removed package) is left exactly as npm wrote it. Unscoped
 * installs are never touched: they are the writer that sees the whole graph.
 */
export function restoreScopedFlagOnlyLockfileRewrite({
  repoRoot = DEFAULT_REPO_ROOT,
  beforeText,
  deps = {},
} = {}) {
  if (typeof beforeText !== "string")
    return { restored: false, reason: "no-lockfile-before", entries: [] };
  const root = resolve(repoRoot);
  const lockPath = join(root, "package-lock.json");
  const afterText = readLockfileText(root, deps);
  if (afterText === undefined)
    return { restored: false, reason: "lockfile-removed", entries: [] };
  if (afterText === beforeText)
    return { restored: false, reason: "unchanged", entries: [] };
  let before;
  let after;
  try {
    before = JSON.parse(beforeText);
    after = JSON.parse(afterText);
  } catch {
    return { restored: false, reason: "unparseable", entries: [] };
  }
  const changed = lockfileDepFlagOnlyChanges(before, after);
  if (changed === null)
    return { restored: false, reason: "substantive-change", entries: [] };
  const writeText =
    deps.writeText ??
    ((text) => {
      const tempPath = join(
        root,
        `.package-lock.json.papercusp-flag-restore-${process.pid}`,
      );
      try {
        writeFileSync(tempPath, text);
        renameSync(tempPath, lockPath);
      } finally {
        rmSync(tempPath, { force: true });
      }
    });
  writeText(beforeText);
  return {
    restored: true,
    reason: changed.length === 0 ? "formatting-only" : "dep-flags-only",
    entries: changed,
  };
}

/**
 * Verify (post-install, still holding the lock) that dependency directories and
 * critical runtime contents actually landed on disk; repair once if not.
 *
 * @returns {Promise<0|1>} 0 = healthy (possibly after repair), 1 = still broken.
 */
export async function verifyDepsExtracted({
  repoRoot = DEFAULT_REPO_ROOT,
  npmArgs = [],
  runNpm,
  probeSpecifiers,
  env = process.env,
  deps = {},
} = {}) {
  const spawn =
    runNpm ??
    ((args) =>
      spawnSync("npm", args, {
        cwd: repoRoot,
        stdio: "inherit",
        env,
      }).status ?? 1);

  const { workspaceDirs, repairWorkspaceArgs } = verificationScopeForNpmArgs({
    repoRoot,
    npmArgs,
    deps,
  });
  const inspect = async () => {
    const declared = await findUnextractedDepsWithRetry({
      repoRoot,
      workspaceDirs,
      deps,
    });
    const packageLocal = await findIncompleteWorkspacePackagesWithRetry({
      repoRoot,
      workspaceDirs,
      deps,
    });
    const packageVersions = await findInvalidWorkspacePackageVersionsWithRetry({
      repoRoot,
      workspaceDirs,
      deps,
    });
    const unsatisfiedRanges = await findUnsatisfiedDeclaredDepRangesWithRetry({
      repoRoot,
      workspaceDirs,
      deps,
    });
    if (
      declared.missing.length > 0 ||
      packageLocal.incomplete.length > 0 ||
      packageVersions.invalid.length > 0 ||
      unsatisfiedRanges.invalid.length > 0
    )
      return {
        missing: declared.missing,
        incomplete: packageLocal.incomplete,
        invalidVersions: packageVersions.invalid,
        unsatisfiedRanges: unsatisfiedRanges.invalid,
        runtimeFailures: [],
      };
    const runtime = await findUnusableRuntimeDepsWithRetry({
      repoRoot,
      probeSpecifiers,
      deps,
    });
    return {
      missing: [],
      incomplete: [],
      invalidVersions: [],
      unsatisfiedRanges: [],
      runtimeFailures: runtime.failures,
    };
  };

  const report = ({
    missing,
    incomplete,
    invalidVersions,
    unsatisfiedRanges,
    runtimeFailures,
  }) => {
    if (missing.length > 0) console.error(formatMissing(missing));
    if (incomplete.length > 0)
      console.error(formatIncompleteWorkspacePackages(incomplete));
    if (invalidVersions.length > 0)
      console.error(formatInvalidWorkspacePackageVersions(invalidVersions));
    if (unsatisfiedRanges.length > 0)
      console.error(formatUnsatisfiedDeclaredDepRanges(unsatisfiedRanges));
    if (runtimeFailures.length > 0)
      console.error(formatRuntimeFailures(runtimeFailures));
  };

  const healthy = ({
    missing,
    incomplete,
    invalidVersions,
    unsatisfiedRanges,
    runtimeFailures,
  }) =>
    missing.length === 0 &&
    incomplete.length === 0 &&
    invalidVersions.length === 0 &&
    unsatisfiedRanges.length === 0 &&
    runtimeFailures.length === 0;

  const first = await inspect();
  if (healthy(first)) return 0;

  report(first);
  const removedTargets = removePackageLocalRepairTargets({
    repoRoot,
    findings: [...first.incomplete, ...first.invalidVersions],
    deps,
  });
  const removedLockEntries = removePackageLocalRepairLockEntries({
    repoRoot,
    findings: first.invalidVersions,
    deps,
  });
  if (removedTargets.length > 0) {
    console.error(
      `NPM_INSTALL_SAFE removed ${removedTargets.length} invalid package-local node${removedTargets.length === 1 ? "" : "s"} before repair:\n${removedTargets
        .map((target) => `  - ${relative(repoRoot, target)}`)
        .join("\n")}`,
    );
  }
  if (removedLockEntries.length > 0) {
    console.error(
      `NPM_INSTALL_SAFE removed ${removedLockEntries.length} stale package-lock entr${removedLockEntries.length === 1 ? "y" : "ies"} before repair:\n${removedLockEntries
        .map((entry) => `  - ${entry}`)
        .join("\n")}`,
    );
  }
  const repairArgs = [...REPAIR_ARGS, ...repairWorkspaceArgs];
  console.error(
    `NPM_INSTALL_SAFE repairing: npm ${repairArgs.join(" ")} (one bounded attempt, still holding the lock)`,
  );
  const repairStatus =
    spawn(repairArgs, {
      cwd: repoRoot,
      stdio: "inherit",
      env,
    }) ?? 1;
  if (repairStatus !== 0) {
    console.error(
      `NPM_INSTALL_SAFE_FATAL: repair npm exited ${repairStatus}; dependency integrity is unverified.`,
    );
    return 1;
  }

  const second = await inspect();
  if (healthy(second)) {
    console.log(
      "NPM_INSTALL_SAFE repaired: dependency directories, package-local manifests and versions, and critical runtime imports are healthy",
    );
    return 0;
  }
  report(second);
  console.error(
    'NPM_INSTALL_SAFE_FATAL: dependencies are STILL incomplete after a repair install — this is not a race. Do not treat a downstream "cannot find module" as a code bug until this is clear.',
  );
  return 1;
}

export function repoLockName(repoRoot = DEFAULT_REPO_ROOT) {
  // realpath so the `papercup` -> `papercusp` symlink and the canonical path
  // both resolve to the identical lock; a genuinely different checkout
  // (different real path) gets its own lock instead of blocking on this one.
  const real = realpathSync(resolve(repoRoot));
  const digest = createHash("sha1").update(real).digest("hex").slice(0, 12);
  return `npm-install-${digest}`;
}

/**
 * Hold a shared host-wide cache lease while a package manager may read/write
 * its global cache. Independent safe installs remain concurrent (reader +
 * reader); the scheduled package-cache janitor takes the matching writer lease
 * before native cleanup. This is deliberately separate from the repo-scoped
 * install writer, because staging/release/checkpoint have different realpaths
 * while sharing the same user-level caches.
 */
export function withPackageCacheReadLease(fn, opts = {}) {
  return withFsMutexRead(PACKAGE_CACHE_MUTEX_NAME, fn, opts);
}

/**
 * npm treats config flags before a command as global flags. Preserve the
 * long-documented `npm run install:safe -- --legacy-peer-deps` form by making
 * the implicit install explicit before spawning npm.
 */
export function normalizeNpmArgs(argv) {
  if (argv.length === 0) return ["install"];
  return argv[0].startsWith("-") ? ["install", ...argv] : argv;
}

/**
 * Build the environment for npm children without changing the parent process.
 * The offline override is deliberately opt-in: ordinary installs retain an
 * explicit caller setting (including `ONNXRUNTIME_NODE_INSTALL=skip`).
 */
export function npmChildEnv({
  env = process.env,
  offlineSafe = false,
} = {}) {
  const hasExplicitInstallSetting =
    Object.prototype.hasOwnProperty.call(env, "ONNXRUNTIME_NODE_INSTALL") &&
    env.ONNXRUNTIME_NODE_INSTALL !== undefined;
  return {
    ...env,
    ...(offlineSafe && !hasExplicitInstallSetting
      ? { ONNXRUNTIME_NODE_INSTALL: "skip" }
      : {}),
  };
}

/**
 * Publish the verified install as an immutable dependency generation under a
 * shared reader marker for the repo-keyed install mutex. The generation builder
 * carries its own before/after fingerprint guard and a short atomic-publish
 * lock; this reader boundary keeps a concurrent safe install from reifying
 * node_modules during the potentially long copy while still allowing other
 * dependency readers to proceed together.
 */
export async function publishDependencyGeneration({
  repoRoot = DEFAULT_REPO_ROOT,
  runPublisher = spawnSync,
  env = process.env,
} = {}) {
  if (env.PAPERCUSP_SKIP_DEP_GENERATION === "1") return 0;
  const lockName = repoLockName(repoRoot);
  const result = await withFsMutexRead(
    lockName,
    () =>
      runPublisher(
        "bash",
        [DEPENDENCY_GENERATION_SCRIPT, "--integration", repoRoot],
        { cwd: repoRoot, stdio: "inherit", env },
      ),
    {
      onWaiting: ({ owner, elapsedMs }) => {
        console.error(
          `NPM_INSTALL_SAFE dependency generation waiting on an install (${Math.round(elapsedMs / 1000)}s so far) — holder: ${owner.trim()}`,
        );
      },
    },
  );
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  if (status !== 0) {
    console.error(
      `NPM_INSTALL_SAFE_FATAL: immutable dependency generation publish exited ${status}; the install is healthy but no checkpoint-safe generation was published.`,
    );
  }
  return status;
}

/**
 * Parse the wrapper-only target selector without stealing npm's own flags.
 * `--repo-root` is recognized only as the first wrapper argument and an
 * optional `--` cleanly separates it from the npm argv.
 */
export function parseCliArgs(
  argv = process.argv.slice(2),
  { cwd = process.cwd() } = {},
) {
  let repoRoot = DEFAULT_REPO_ROOT;
  let npmArgv = [...argv];
  let offlineSafe = false;

  if (npmArgv[0] === "--repo-root" || npmArgv[0]?.startsWith("--repo-root=")) {
    const inline = npmArgv[0].startsWith("--repo-root=")
      ? npmArgv[0].slice("--repo-root=".length)
      : null;
    const rawRoot = inline ?? npmArgv[1];
    if (!rawRoot) throw new Error("--repo-root requires a path");
    repoRoot = resolve(cwd, rawRoot);
    npmArgv = npmArgv.slice(inline === null ? 2 : 1);
  }
  if (npmArgv[0] === OFFLINE_SAFE_FLAG) {
    offlineSafe = true;
    npmArgv = npmArgv.slice(1);
  }
  if (npmArgv[0] === EXEC_UNDER_LOCK_FLAG) {
    const commandArgs = npmArgv.slice(npmArgv[1] === "--" ? 2 : 1);
    if (commandArgs.length === 0)
      throw new Error(`${EXEC_UNDER_LOCK_FLAG} requires a command`);
    return {
      repoRoot,
      commandArgs,
      ...(offlineSafe ? { offlineSafe: true } : {}),
    };
  }

  if (npmArgv[0] === "--") npmArgv = npmArgv.slice(1);

  return {
    repoRoot,
    npmArgs: normalizeNpmArgs(npmArgv),
    ...(offlineSafe ? { offlineSafe: true } : {}),
  };
}

/**
 * Run a dependency reader under the SAME repo-keyed mutex as install:safe.
 * The marker environment prevents a wrapped script from recursively wrapping
 * itself while keeping the contract explicit and testable at the child seam.
 */
export function runCommandUnderInstallMutex({
  repoRoot = DEFAULT_REPO_ROOT,
  commandArgs,
  runCommand = spawnSync,
  env = process.env,
} = {}) {
  if (!Array.isArray(commandArgs) || commandArgs.length === 0) {
    throw new Error(`${EXEC_UNDER_LOCK_FLAG} requires a command`);
  }
  const [command, ...args] = commandArgs;
  const lockName = repoLockName(repoRoot);
  const mutexAlreadyHeld = env.PAPERCUSP_INSTALL_MUTEX_HELD === "1";
  const childEnv = {
    ...env,
    ...(mutexAlreadyHeld ? {} : { PAPERCUSP_INSTALL_MUTEX_HELD: "1" }),
  };

  const executeReader = async () => {
    // Reader diagnostics belong on stderr: callers such as ptool expose the
    // child command's stdout as a machine-readable JSON stream.
    console.error(
      `${mutexAlreadyHeld ? "NPM_INSTALL_SAFE mutex already held; running nested reader directly" : "NPM_INSTALL_SAFE guarding reader"}: ${commandArgs.join(" ")} (root=${repoRoot}, lock=${lockName})`,
    );
    const result = runCommand(command, args, {
      cwd: repoRoot,
      stdio: "inherit",
      env: childEnv,
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  };

  // A command launched by an install-safe reader inherits this marker. Its
  // nested reader is already inside the install boundary and must not install
  // another reader marker beneath the writer it is waiting on: that is a
  // self-deadlock when the outer command still owns the writer lock.
  if (mutexAlreadyHeld) return executeReader();

  return withFsMutexRead(lockName, executeReader, {
    onWaiting: ({ owner, elapsedMs }) => {
      console.error(
        `NPM_INSTALL_SAFE reader waiting on an install (${Math.round(elapsedMs / 1000)}s so far) — holder: ${owner.trim()}`,
      );
    },
  });
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);
  if ("commandArgs" in parsed) return runCommandUnderInstallMutex(parsed);

  const { repoRoot, npmArgs } = parsed;
  const npmEnv = {
    ...npmChildEnv({
      env: process.env,
      offlineSafe: parsed.offlineSafe === true,
    }),
    PAPERCUSP_INSTALL_SAFE_ACTIVE: "1",
  };
  const lockName = repoLockName(repoRoot);

  const installStatus = await withPackageCacheReadLease(
    () =>
      withFsMutex(
        lockName,
        async () => {
          const cacheStatus = verifyNpmCache({
            repoRoot,
            npmArgs,
            env: npmEnv,
          });
          if (cacheStatus !== 0) {
            console.error(
              `NPM_INSTALL_SAFE_FATAL: npm cache verify exited ${cacheStatus}; cache integrity is unverified.`,
            );
            return cacheStatus;
          }
          console.log(
            `NPM_INSTALL_SAFE running: npm ${npmArgs.join(" ")} (root=${repoRoot}, lock=${lockName})`,
          );
          // WI-10003114: a workspace-scoped command recomputes dependency-type flags from a
          // partial view of the graph; snapshot the lockfile so a flag-only rewrite can be undone.
          const lockfileBeforeScopedCommand =
            workspaceSelectorsForNpmArgs(npmArgs).length > 0
              ? readLockfileText(repoRoot)
              : undefined;
          // Tell the root `preinstall` guard that THIS install is the sanctioned one — it holds the
          // writer lock, so it cannot tear a green-checkpoint dependency copy. Without the marker the
          // guard cannot distinguish us from the bare `npm install` it exists to refuse.
          const result = spawnSync("npm", npmArgs, {
            cwd: repoRoot,
            stdio: "inherit",
            env: npmEnv,
          });
          if (result.error) throw result.error;
          const status = result.status ?? 1;
          // A FAILED npm run reports its own error — never mask it with a dep verdict.
          if (status !== 0) return status;
          const verdict =
            process.env.PAPERCUSP_SKIP_DEP_VERIFY === "1"
              ? 0
              : await verifyDepsExtracted({ repoRoot, npmArgs, env: npmEnv });
          // After verification, because its bounded repair re-runs a scoped install.
          if (lockfileBeforeScopedCommand !== undefined) {
            const restore = restoreScopedFlagOnlyLockfileRewrite({
              repoRoot,
              beforeText: lockfileBeforeScopedCommand,
            });
            if (restore.restored)
              console.log(
                `NPM_INSTALL_SAFE kept the pre-install package-lock.json: this workspace-scoped command rewrote only npm dependency-type flags (${restore.reason}, ${restore.entries.length} entr${restore.entries.length === 1 ? "y" : "ies"}); a scoped install is not authoritative for them (WI-10003114)`,
              );
          }
          return verdict;
        },
        {
          onWaiting: ({ owner, elapsedMs }) => {
            console.log(
              `NPM_INSTALL_SAFE waiting on another agent's install (${Math.round(elapsedMs / 1000)}s so far) — holder: ${owner.trim()}`,
            );
          },
        },
      ),
    {
      onWaiting: ({ owner, elapsedMs }) => {
        console.log(
          `NPM_INSTALL_SAFE waiting on package-cache maintenance (${Math.round(elapsedMs / 1000)}s so far) — holder: ${owner.trim()}`,
        );
      },
    },
  );
  if (installStatus !== 0) return installStatus;
  return publishDependencyGeneration({ repoRoot });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      console.error(
        `NPM_INSTALL_SAFE_ERROR ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    });
}
