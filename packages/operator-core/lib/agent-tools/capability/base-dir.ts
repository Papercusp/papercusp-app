/**
 * resolveCapabilityBaseDir — the base directory a capability tool (read / write /
 * edit / inspect / bash) operates in.
 *
 * EI-1754: every capability tool used `ctx.projectDir ?? process.cwd()`. For a
 * HARNESS-scoped agent that's correct — `ctx.projectDir` is its harness tree. But
 * the SUPERUSER / workspace-unscoped MCP context resolves `projectDir` to
 * UNDEFINED (_mcp-handler.ts: when `workspaceId === '*'` or `harnessSlug === '*'`,
 * `paths = { projectDir: undefined }`), so it fell through to `process.cwd()` — and
 * the :3070 operator runs FROM the release deploy tree (papercup-release, pinned to
 * green `main`). So a superuser's capability:inspect/bash/read/write/edit ran in the
 * STALE release checkout, not the canonical/integration tree where the agent's edits
 * land (and the resolved release sub-path often doesn't exist → `spawn ENOENT`).
 *
 * Fix: fall back to `PAPERCUSP_CANONICAL_TREE` when the serving unit declares a
 * separate edit tree (the :3170 staging mirror exports both), then to
 * `PAPERCUSP_INTEGRATION_ROOT` (the usual canonical tree — the same resolver
 * `db:next-migration`, `ship-link`, and `register-papercusp` use) BEFORE `process.cwd()`.
 *
 * Order is `projectDir → PAPERCUSP_CANONICAL_TREE → PAPERCUSP_INTEGRATION_ROOT → process.cwd()`: projectDir-FIRST
 * means a harness bee's correct tree always wins and is never overridden by the env
 * (so the env's presence in a bee's inherited environment is irrelevant); the env is
 * ONLY consulted when projectDir is absent (the superuser case this fixes). An empty /
 * whitespace env is treated as unset.
 *
 * SYMLINK RESOLUTION (EI-5912): the resolved base dir is often reached via a symlink
 * (the canonical tree `.../papercup` is a symlink to `.../papercusp`, and
 * `PAPERCUSP_INTEGRATION_ROOT` points at the symlink). The capability exec-sandbox
 * (`buildCapabilitySandboxCommand` / srt `buildFleetSrtSettings`) makes the cwd
 * WRITABLE at the exact path we hand it — but node resolves a write UNDER the cwd
 * through the symlink to the REAL path, which sits under the sandbox's read-only `/`
 * bind → `EROFS` (e.g. vitest writing its config bundle to
 * `<cwd>/node_modules/.vite-temp/*.mjs`, so `capability:inspect { check:'test' }`
 * could never bootstrap vitest under the sandbox). Resolving the base dir to its
 * REAL path makes the intended-writable cwd actually writable. `realpathSync`
 * is FAIL-SOFT here: a path that can't be resolved (missing dir) is returned as-is,
 * never throwing — the selection semantics above are unchanged, only the final path
 * is canonicalized.
 */
import { realpathSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function resolveCapabilityBaseDir(ctx: { projectDir?: string }): string {
  return realpathSoft(pickCapabilityBaseDir(ctx));
}

/**
 * The WORKSPACE ROOT of the tree the agent is editing — for tools that must run a
 * repo-root-relative script (`scripts/test-files.mjs`) or resolve a repo-root-relative
 * project path, rather than just read one file.
 *
 * Why not `inferWorkspaceRoot()` (@papercusp/testing-shell/glob): two independent
 * defects make it wrong HERE, and both are invisible under vitest (where cwd is
 * already the repo root), which is why they reached production.
 *   1. It walks up from `process.cwd()` — the :3070 operator's cwd is the RELEASE
 *      checkout, so it returned the release tree and tools silently judged code the
 *      agent never edited (EI-1754's symptom, re-observed 2026-07-27 on testing:run).
 *   2. It MEMOIZES its answer in a module-level `_cachedRoot` that ignores the `from`
 *      argument on every later call — so passing the right starting point does not
 *      reliably fix (1): whichever caller happens to run first pins the root process-wide.
 *
 * So: start from the capability base dir (the agent's tree) and walk up WITHOUT
 * caching. A git SUBMODULE carries a `.git` FILE, not a directory — requiring a
 * DIRECTORY is what stops the walk from halting inside a submodule and reporting a
 * submodule-relative root (the same trap already documented in
 * libs/test-config/src/admin-test-runs-reporter.ts).
 */
export function resolveAgentWorkspaceRoot(ctx: { projectDir?: string }): string {
  const baseDir = resolveCapabilityBaseDir(ctx);
  let dir = resolve(baseDir);
  while (true) {
    if (isWorkspaceRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fail-soft: no marker found (a bare/unusual tree) — the base dir is still the
  // agent's tree, which beats the operator's cwd in every case this exists to fix.
  return baseDir;
}

/** A superproject root: `.git` as a DIRECTORY (never a submodule's gitlink FILE),
 *  plus a `package.json` declaring npm workspaces. */
function isWorkspaceRoot(dir: string): boolean {
  try {
    if (!statSync(join(dir, '.git')).isDirectory()) return false;
  } catch {
    return false;
  }
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as { workspaces?: unknown };
    return pkg.workspaces !== undefined;
  } catch {
    return false;
  }
}

/** The raw base-dir selection (projectDir → PAPERCUSP_INTEGRATION_ROOT → cwd),
 *  before symlink resolution. Exported for unit tests of the selection order. */
export function pickCapabilityBaseDir(ctx: { projectDir?: string }): string {
  if (ctx.projectDir) return ctx.projectDir;
  const canonicalTree = configuredCanonicalTree();
  if (canonicalTree) return canonicalTree;
  const integrationRoot = configuredCapabilityIntegrationRoot();
  if (integrationRoot) return integrationRoot;
  return process.cwd();
}

function configuredCanonicalTree(
  env: { PAPERCUSP_CANONICAL_TREE?: string } = process.env,
): string | undefined {
  return env.PAPERCUSP_CANONICAL_TREE?.trim() || undefined;
}

/**
 * The canonical integration checkout when the operator explicitly publishes one.
 *
 * This is intentionally narrower than `resolveCapabilityBaseDir({})`: callers
 * recovering from a bad harness root must never substitute the operator's own cwd
 * when the integration-root contract is absent. Exporting the narrow rung also
 * keeps path-aware capability handlers from re-implementing the env parsing.
 */
export function resolveCapabilityIntegrationRoot(
  env: { PAPERCUSP_INTEGRATION_ROOT?: string } = process.env,
): string | undefined {
  const integrationRoot = configuredCapabilityIntegrationRoot(env);
  return integrationRoot ? realpathSoft(integrationRoot) : undefined;
}

function configuredCapabilityIntegrationRoot(
  env: { PAPERCUSP_INTEGRATION_ROOT?: string } = process.env,
): string | undefined {
  return env.PAPERCUSP_INTEGRATION_ROOT?.trim() || undefined;
}

/** `realpathSync` that never throws: an unresolvable path (missing dir) is returned
 *  unchanged. Canonicalizes a symlinked tree so the exec-sandbox's writable-cwd bind
 *  matches where node actually writes (EI-5912). Exported for unit testing. */
export function realpathSoft(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
