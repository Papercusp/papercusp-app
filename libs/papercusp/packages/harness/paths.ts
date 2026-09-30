/**
 * @papercusp/harness/paths — runtime resolver for the harness install root.
 *
 * Replaces the old `~/autonomous-harness` symlink convention with proper
 * package resolution. Consumers do:
 *
 *   import { harnessPath } from '@papercusp/harness/paths';
 *   const promptsDir = harnessPath('prompts');
 *   const runSh = harnessPath('run.sh');
 *
 * Works in Next.js (transpilePackages), Node ESM, and tsx without any
 * configuration beyond adding `@papercusp/harness` to the workspace.
 *
 * The `PAPERCUSP_HARNESS_DIR` env var still overrides this for cases where
 * a different install root is wanted (Tauri sidecar runtime, container
 * mounts, fixture-controlled tests).
 */
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * True when `dir` is other-writable (mode & 0o002) — the hallmark of a
 * shared, multi-user scratch area (`/tmp`, `/var/tmp`, …), not a directory
 * this process or its deploy owns exclusively.
 *
 * Why this matters here (EI-19481118729454265): `resolveHarnessPackageRoot`'s
 * upward walk probes EVERY ancestor of its start dirs, and by default (no
 * `stopAt`) that walk is unbounded — it runs all the way to the filesystem
 * root. A `blueprints/base/blueprint.yaml` dropped in ANY world-writable
 * ancestor along that walk (accidentally, by a stray `cp -r`, or by a
 * malicious actor with local access) makes that ancestor answer as "the
 * harness package root" for every harness process whose module path or cwd
 * sits beneath it — silently substituting an untrusted blueprint set for the
 * real one. Measured live 2026-08-03/04: a full byte-identical copy of the
 * 48 built-in blueprints sat at bare `/tmp/blueprints` for unknown reasons,
 * and `hasHarnessAssets('/tmp')` was `true`. It happened to be harmless only
 * because the copy was byte-identical to source that day.
 *
 * Bounding the walk with `stopAt` (see below) fixes hermetic TESTS, but every
 * production caller passes no `stopAt` by design (recovering the source
 * package from an arbitrarily-deep bundled `dist-host` path needs to walk up
 * to the real repo root, whose depth isn't known in advance). So production
 * needs its own floor, independent of `stopAt`: never trust harness assets
 * discovered in a directory anyone on the box could have written into.
 * `statSync` failures (permission denied, dir vanished mid-walk) are treated
 * as "not safe to trust" rather than thrown — the walk simply keeps going.
 */
function isWorldWritable(dir: string): boolean {
  try {
    return (statSync(dir).mode & 0o002) !== 0;
  } catch {
    return true;
  }
}

function hasHarnessAssets(dir: string): boolean {
  if (isWorldWritable(dir)) return false;
  return existsSync(join(dir, 'blueprints', 'base', 'blueprint.yaml'));
}

function derivedHarnessRoot(repoRoot: string): string {
  return join(repoRoot, 'libs', 'papercusp', 'packages', 'harness');
}

export interface ResolveHarnessPackageRootOptions {
  /**
   * Highest ancestor the upward walk may consider, inclusive. Once this
   * directory has been probed the walk stops instead of continuing to the
   * filesystem root.
   *
   * Default (omitted) = the filesystem root, i.e. the historical behavior —
   * every production caller is unchanged.
   *
   * Why it exists: the walk probes EVERY ancestor, so a `blueprints/base/
   * blueprint.yaml` dropped in a world-shared ancestor (`/tmp`) makes that
   * ancestor answer as "the harness package root" for anything started
   * beneath it. That is unobservable in normal dev and it red-pinned the
   * fleet gate on 2026-08-04 (WI-10675): the `paths.test.ts` case asserting
   * "null when no candidate has harness assets" builds its candidates under
   * `mkdtemp(tmpdir())`, so it was asserting about `/tmp` and `/` — machine
   * state no test can own. A test that must be decidable passes the root it
   * created here, and then measures only the candidates it constructed.
   */
  stopAt?: string;
}

export function resolveHarnessPackageRoot(
  startDirs: string[],
  { stopAt }: ResolveHarnessPackageRootOptions = {},
): string | null {
  const seen = new Set<string>();
  const ceiling = stopAt === undefined ? null : resolve(stopAt);
  const consider = (dir: string): string | null => {
    let cur = resolve(dir);
    const root = parse(cur).root;
    for (;;) {
      const direct = cur;
      if (!seen.has(direct)) {
        seen.add(direct);
        if (hasHarnessAssets(direct)) return direct;
      }

      const derived = derivedHarnessRoot(cur);
      if (!seen.has(derived)) {
        seen.add(derived);
        if (hasHarnessAssets(derived)) return derived;
      }

      if (cur === root || cur === ceiling) return null;
      cur = dirname(cur);
    }
  };

  // A bundled host ships its own blueprint assets beside the running entry.
  // Prefer that complete build over the integration checkout: staging rebuilds
  // the latter in place while the previous host is still serving requests.
  // The isolated verifier uses dist-verify with the same bundled assets; mixing
  // its frozen schema with newer integration YAML can reject valid modes.
  // An explicit PAPERCUSP_HARNESS_DIR remains the harnessRoot() override.
  for (const startDir of startDirs) {
    const bundled = resolve(startDir);
    if (['dist-host', 'dist-sidecar', 'dist-verify'].includes(basename(bundled)) &&
        hasHarnessAssets(bundled)) return bundled;
  }

  const integ = process.env.PAPERCUSP_INTEGRATION_ROOT?.trim();
  if (integ) {
    const derived = derivedHarnessRoot(integ);
    if (hasHarnessAssets(derived)) return derived;
  }

  for (const dir of startDirs) {
    const hit = consider(dir);
    if (hit) return hit;
  }
  return null;
}

function packageRoot(): string {
  // ESM source path: paths.ts → import.meta.url → .../libs/papercusp/packages/harness/.
  // Bundled host path: esbuild inlines this module into apps/operator/dist-host/*.mjs,
  // so import.meta.url points at dist-host. Walk upward to the repo root and recover
  // the real harness package; otherwise built-in blueprint loads look under dist-host.
  if (typeof import.meta !== 'undefined' && import.meta.url) {
    const hit = resolveHarnessPackageRoot([dirname(fileURLToPath(import.meta.url)), process.cwd()]);
    if (hit) return hit;
  }

  // CJS fallback (Next.js sometimes emits CommonJS for server bundles):
  // __dirname will already point at the transpiled location of this file.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cjsDirname = (globalThis as any).__dirname;
  if (typeof cjsDirname === 'string') {
    const hit = resolveHarnessPackageRoot([cjsDirname, process.cwd()]);
    if (hit) return hit;
    return cjsDirname;
  }

  // Last-ditch fallback: use process.cwd() relative search
  return derivedHarnessRoot(process.cwd());
}

export function harnessRoot(): string {
  return process.env.PAPERCUSP_HARNESS_DIR ?? packageRoot();
}

export function harnessPath(...parts: string[]): string {
  return join(harnessRoot(), ...parts);
}

/**
 * Every candidate harness package root, in resolution order, deduped:
 *   1. The primary `harnessRoot()` (honors `PAPERCUSP_HARNESS_DIR` / the bundled
 *      `dist-host` anchor) — tried FIRST, so common-case resolution is unchanged.
 *   2. Any DERIVED SOURCE package (`<ancestor>/libs/papercusp/packages/harness`)
 *      recovered by walking up from the primary root AND `process.cwd()`.
 *
 * Why (EI-8628): the bundled host (`apps/operator/bin/bundle-host.sh`) copies the
 * harness `blueprints/` into `apps/operator/dist-host/blueprints` — a POINT-IN-TIME
 * snapshot. `packageRoot()` then anchors `harnessRoot()` on `dist-host` (its
 * `hasHarnessAssets` check only verifies `base/blueprint.yaml`), so a blueprint that
 * exists in the fresh SOURCE tree but not yet in that STALE bundle makes a lookup
 * under the primary root alone throw `no built-in blueprint "<id>"` (the routine
 * `bp-singleton-scout-0` failure that filed EI-8628). Callers that resolve a specific
 * file (e.g. a built-in blueprint YAML) try these roots in order, so a source-present
 * blueprint still resolves. A packaged deploy (no `libs/` source on disk) yields just
 * the primary root — byte-identical to before.
 */
export function harnessRootCandidates(): string[] {
  const roots: string[] = [];
  const add = (d: string | null | undefined): void => {
    if (d && !roots.includes(d)) roots.push(d);
  };
  add(harnessRoot());
  for (const start of [harnessRoot(), process.cwd()]) {
    let cur = resolve(start);
    const fsRoot = parse(cur).root;
    for (;;) {
      const derived = derivedHarnessRoot(cur);
      if (hasHarnessAssets(derived)) add(derived);
      if (cur === fsRoot) break;
      cur = dirname(cur);
    }
  }
  return roots;
}

/**
 * The harness install root used SPECIFICALLY for AGENT PROMPT resolution.
 *
 * decouple-agent-prompts-from-release-gate-2026-06-20 (D-001 — prompts-only):
 * agent PROMPT files (`blueprints/<id>/prompts/<role>.md`, `agent-base-*.md`,
 * `<role>.base.md`) are resolved from the integration/staging tree so a prompt
 * edit goes live WITHOUT a code-release (green-gate) promotion — while CODE +
 * TEMPLATE resolution stays on the running (deployed) checkout via
 * `harnessRoot()`/`harnessPath()`. This is the ONLY place the two roots diverge.
 *
 * Precedence (first existing wins; a misconfigured override never strands
 * resolution — it degrades to the running tree):
 *   1. `PAPERCUSP_PROMPT_ROOT`      — explicit harness-prompt-root override.
 *   2. `PAPERCUSP_INTEGRATION_ROOT` — repo root; derive `<root>/libs/papercusp/packages/harness`.
 *   3. `fallback` (default `harnessRoot()`) — byte-identical to pre-decouple behavior.
 *
 * Zero filesystem cost when neither env var is set (the common case): both
 * lookups short-circuit on the absent env before any `existsSync`.
 */
export function promptHarnessRoot(fallback?: string): string {
  const direct = process.env.PAPERCUSP_PROMPT_ROOT?.trim();
  if (direct && existsSync(direct)) return direct;
  const integ = process.env.PAPERCUSP_INTEGRATION_ROOT?.trim();
  if (integ) {
    const derived = join(integ, 'libs', 'papercusp', 'packages', 'harness');
    if (existsSync(derived)) return derived;
  }
  return fallback ?? harnessRoot();
}
