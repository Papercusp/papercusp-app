/**
 * A1 (infra-fail-fast-build-integrity-2026-06-19) — native-addon deploy-gate
 * preflight.
 *
 * The 2026-06-19 :3070 outage: papercup-release's `better-sqlite3` native addon
 * was built for Node 22 (ABI 127) while the service runs Node 25 (ABI 141). It
 * loaded fine at install but FAILED at load ("Module did not self-register"),
 * mem0 never came up, and every memory-touching handler hung behind a green
 * health check. Nothing rebuilt/verified the addon against the runtime Node, so
 * the broken binary shipped to green undetected.
 *
 * This module test-LOADS the critical native packages under the CURRENT Node so
 * a deploy gate can fail a promotion on any load failure.
 *
 * KEY DESIGN — load PACKAGES, not raw `.node` files. The first instinct (scan
 * every `*.node` under node_modules and try to load each) produces ~60 benign
 * FALSE alarms: packages ship prebuilt binaries for many platforms/ABIs
 * (musl/darwin/win/arm/…) and the loader only ever selects ONE. Loading the
 * package via its real entry runs that package's own platform/ABI selection
 * (prebuild-install / node-gyp-build), so a throw means the binary the loader
 * ACTUALLY picks is broken on this runtime — the real signal, no false alarms.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

/**
 * Native addons whose load failure must FAIL a promotion. `better-sqlite3` is
 * the 2026-06-19 outage cause (mem0's store) and is loaded on every full host.
 * Kept deliberately small — a deploy gate that false-blocks every promotion is
 * worse than none. Extend via PAPERCUSP_PREFLIGHT_ADDONS (comma-separated).
 */
export const DEFAULT_REQUIRED_ADDONS = ['better-sqlite3'] as const;
// NOTE (EI-1814): `sodium-native` was briefly added here on the hypothesis that
// its load-failure caused the re-key 0-keys — REVERTED: su-ee7e9's runtime test
// proved sodium() does NOT throw in the live sidecar, so it is not the root, and
// sodium-native is re-key-only (the base swarm uses sodium-universal's JS
// fallback) so gating it universally would false-block re-key-OFF hosts. The real
// 0-keys root is elsewhere in the admit-grant (328af's `rekey_grant_failed` boot
// event names it). If a re-key-conditional native check is ever wanted, gate it
// on the flag — do not add it to the unconditional required set.

/** Resolve the required-addon set: env override (comma list) or the default. */
export function requiredAddonsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.PAPERCUSP_PREFLIGHT_ADDONS;
  if (raw && raw.trim()) {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [...DEFAULT_REQUIRED_ADDONS];
}

/**
 * Packages that run under the Bare runtime (Pear/holepunch), NOT Node. They
 * throw "Bare is not defined" / "require.addon is not a function" under Node's
 * `require` by design, and the operator (a Node process) never require()s them
 * directly — so a require-load test reports a spurious failure. Skipped from the
 * advisory scan so the report stays trustworthy (A1's no-false-alarms goal).
 */
export const DEFAULT_SKIP_PREFIXES = ['bare-'] as const;

/** True if `name` matches a skip prefix (scope-aware: `@scope/bare-x` → `bare-x`). */
export function shouldSkipAddon(
  name: string,
  prefixes: readonly string[] = DEFAULT_SKIP_PREFIXES,
): boolean {
  const bare = name.startsWith('@') ? name.split('/')[1] ?? name : name;
  return prefixes.some((p) => bare.startsWith(p));
}

export interface AddonLoadResult {
  name: string;
  /** true = loaded; false = threw; null = indeterminate (e.g. ESM-only, can't
   *  be require()-tested) — never counted as a gate failure. */
  ok: boolean | null;
  required: boolean;
  error?: string;
}

export interface PreflightReport {
  node: string;
  /** N-API/V8 module ABI (process.versions.modules) — the dimension that drifted. */
  abi: string;
  results: AddonLoadResult[];
  /** true iff every REQUIRED addon loaded (indeterminate required → fail-closed). */
  ok: boolean;
}

/** A package ships a native addon if it carries a `prebuilds/` dir or a built
 *  `build/Release` output. */
export function packageShipsAddon(pkgDir: string): boolean {
  return existsSync(join(pkgDir, 'prebuilds')) || existsSync(join(pkgDir, 'build', 'Release'));
}

/**
 * Discover packages under `nodeModulesDir` that ship a native addon, returning
 * their require specifiers (handles `@scope/name`). Used to populate the
 * ADVISORY set — addons we report on but don't gate on.
 */
export function discoverAddonPackages(nodeModulesDir: string): string[] {
  if (!existsSync(nodeModulesDir)) return [];
  const out: string[] = [];
  for (const entry of safeReaddir(nodeModulesDir)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      const scopeDir = join(nodeModulesDir, entry);
      for (const sub of safeReaddir(scopeDir)) {
        if (packageShipsAddon(join(scopeDir, sub))) out.push(`${entry}/${sub}`);
      }
      continue;
    }
    if (packageShipsAddon(join(nodeModulesDir, entry))) out.push(entry);
  }
  return out.sort();
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Node's code for "this is an ESM package, require() can't load it" — an
 *  indeterminate result for a require-based load test, NOT a broken addon. */
function isEsmRequireError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ERR_REQUIRE_ESM';
}

/** Load the package and exercise a lazy native binding when its API requires it. */
export function loadAddon(
  spec: string,
  requireFn: (s: string) => unknown,
): { ok: boolean | null; error?: string } {
  try {
    const loaded = requireFn(spec);
    if (spec === 'better-sqlite3') {
      // Its JavaScript wrapper imports successfully even when the .node addon
      // targets a different ABI. Opening and querying an in-memory database
      // follows the binding-load path used by mem0 without touching user data.
      const Database = loaded as new (filename: string) => {
        prepare(sql: string): { get(): unknown };
        close(): void;
      };
      const db = new Database(':memory:');
      try { db.prepare('SELECT 1').get(); }
      finally { db.close(); }
    }
    return { ok: true };
  } catch (err) {
    if (isEsmRequireError(err)) {
      return { ok: null, error: 'ERR_REQUIRE_ESM (not require-loadable; skipped)' };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Test-load the required + advisory addon sets. `requireFn` is injected so the
 * deploy CLI can root it at the target install (createRequire) and tests can
 * stub it. The gate result (`ok`) is fail-CLOSED: a required addon that loads
 * is the only pass; a throw OR an indeterminate (ESM) required addon fails.
 */
export function checkNativeAddons(opts: {
  requireFn: (s: string) => unknown;
  required: string[];
  advisory?: string[];
  /** Advisory-only skip predicate (e.g. Bare-runtime packages). Required addons
   *  are NEVER skipped — if you mark it required, it is always tested. */
  skipAdvisory?: (name: string) => boolean;
}): PreflightReport {
  const required = new Set(opts.required);
  // Advisory minus anything already required (required wins).
  const advisory = (opts.advisory ?? []).filter((s) => !required.has(s));

  const results: AddonLoadResult[] = [];
  for (const name of opts.required) {
    const { ok, error } = loadAddon(name, opts.requireFn);
    results.push({ name, ok, required: true, error });
  }
  for (const name of advisory) {
    if (opts.skipAdvisory?.(name)) {
      results.push({ name, ok: null, required: false, error: 'skipped (not Node-loadable)' });
      continue;
    }
    const { ok, error } = loadAddon(name, opts.requireFn);
    results.push({ name, ok, required: false, error });
  }

  const ok = results.filter((r) => r.required).every((r) => r.ok === true);
  return { node: process.versions.node, abi: process.versions.modules, results, ok };
}

/**
 * A2 (infra-fail-fast-build-integrity-2026-06-19) — BOOT self-check.
 *
 * Runs IN the live process at boot (vs A1's deploy gate). Test-loads the
 * required native addons under the runtime Node and, on failure, LOGS LOUDLY so
 * a broken addon (the 2026-06-19 outage: better-sqlite3 ABI mismatch → mem0 load
 * fail → silent hang) becomes a visible boot error instead of an invisible hang.
 *
 * SAFE BY DEFAULT: it does NOT exit. The brief's fail-fast (`Restart=always`
 * surfacing a crashloop) is opt-in via PAPERCUSP_ADDON_PREFLIGHT_FATAL=1 —
 * flag-gated off until validated so it can never crashloop a healthy host (e.g.
 * one that deliberately runs without a memory backend). Always returns the
 * report; never throws.
 */
export function runBootAddonPreflight(opts?: {
  requireFn?: (s: string) => unknown;
  log?: (msg: string) => void;
  exit?: (code: number) => void;
  env?: NodeJS.ProcessEnv;
}): PreflightReport {
  const env = opts?.env ?? process.env;
  const log = opts?.log ?? ((m) => console.warn(m));
  const requireFn = opts?.requireFn ?? createRequire(import.meta.url);
  const report = checkNativeAddons({ requireFn, required: requiredAddonsFromEnv(env), advisory: [] });
  if (!report.ok) {
    log(`[addon-preflight] BOOT self-check FAILED — a required native addon will not load under this Node (the 2026-06-19 outage class):\n${formatReport(report)}`);
    if (env.PAPERCUSP_ADDON_PREFLIGHT_FATAL === '1') {
      log('[addon-preflight] PAPERCUSP_ADDON_PREFLIGHT_FATAL=1 — exiting non-zero so Restart=always surfaces a visible crashloop instead of a silent hang.');
      (opts?.exit ?? ((c) => process.exit(c)))(1);
    }
  }
  return report;
}

/** Human-readable report for the deploy log. */
export function formatReport(r: PreflightReport): string {
  const lines: string[] = [
    `native-addon preflight — node=${r.node} abi(modules)=${r.abi}`,
  ];
  for (const res of r.results) {
    const mark = res.ok === true ? 'OK  ' : res.ok === null ? 'SKIP' : 'FAIL';
    const tag = res.required ? 'required' : 'advisory';
    lines.push(`  [${mark}] ${res.name} (${tag})${res.error ? ` — ${res.error}` : ''}`);
  }
  const failed = r.results.filter((x) => x.required && x.ok !== true).map((x) => x.name);
  lines.push(r.ok ? 'PASS — all required addons load under the runtime Node.' : `FAIL — required addon(s) did not load: ${failed.join(', ')}`);
  return lines.join('\n');
}
