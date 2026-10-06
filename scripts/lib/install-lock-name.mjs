/**
 * The repo-keyed name of the install:safe mutex (scripts/npm-install-safe.mjs).
 *
 * Lives in its own side-effect-free module so RUNTIME code can derive the same
 * lock name without importing npm-install-safe.mjs: that script's CLI guard
 * (`import.meta.url === file://${process.argv[1]}`) is TRUE inside the esbuild
 * host bundle, where every module shares the bundle's import.meta.url, so
 * importing it from operator code would run an npm install on operator boot.
 * WI-10005137 (headless agent launches wait on this lock).
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * realpath so the `papercup` -> `papercusp` symlink and the canonical path
 * both resolve to the identical lock; a genuinely different checkout
 * (different real path) gets its own lock instead of blocking on this one.
 * Throws when `repoRoot` does not exist (realpath fails).
 *
 * @param {string} repoRoot
 * @returns {string}
 */
export function installLockNameForRoot(repoRoot) {
  const real = realpathSync(resolve(repoRoot));
  const digest = createHash("sha1").update(real).digest("hex").slice(0, 12);
  return `npm-install-${digest}`;
}

/** Scoped reader ancestry; the old boolean marker proves no repository identity. */
function heldInstallMutexNames(env) {
  return String(env.PAPERCUSP_INSTALL_MUTEX_HELD ?? "")
    .split(",")
    .filter((name) => /^npm-install-[a-f0-9]{12}$/.test(name));
}

/** @param {string} lockName @param {NodeJS.ProcessEnv} [env] */
export function installMutexIsHeld(lockName, env = process.env) {
  return heldInstallMutexNames(env).includes(lockName);
}

/** Preserve ancestor leases when a child acquires a different repository lock. */
export function envWithInstallMutex(lockName, env = process.env) {
  return {
    ...env,
    PAPERCUSP_INSTALL_MUTEX_HELD: [...new Set([...heldInstallMutexNames(env), lockName])].join(","),
  };
}
