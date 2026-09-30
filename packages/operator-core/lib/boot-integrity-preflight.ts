/**
 * boot-integrity-preflight.ts — fail-fast guard against an INCONSISTENT release
 * checkout (git source files importing packages that are ABSENT from node_modules).
 *
 * Why this exists (the 2026-06-25 "connection refused on all pages" incident):
 * `papercup-release` was left inconsistent by a botched deploy/rollback — the host's
 * source imported `@modelcontextprotocol/sdk`, `@papercusp/plugin-loader` and
 * `@typespec/ts-http-runtime`, none of which were installed. Under
 * `PAPERCUSP_CLUSTER=32`, EVERY request worker crash-looped on `MODULE_NOT_FOUND`
 * until the respawn budget (workers×5 = 160) was exhausted, leaving `:3070` with
 * zero live workers across four restart cycles (~08:30–09:32 EDT) — i.e. the
 * operator refused all connections on every page for ~35 minutes. CLAUDE.md
 * documents this exact class: deploy-cli's auto-rollback can leave the checkout's
 * git files out of sync with node_modules → MODULE_NOT_FOUND crash-loop.
 *
 * This preflight resolves a small manifest of load-bearing boot modules BEFORE the
 * cluster forks its fleet. On a broken/partial install it emits ONE loud, named
 * diagnostic (which packages are missing) and exits with a DISTINCT code in <1s,
 * instead of a 160-respawn flap storm. (The generic net for boot failures this
 * manifest doesn't enumerate is the cluster-fork boot-failure backstop — see
 * `cluster-fork.ts` `onUnbootable`. This file is the early, actionable signal.)
 *
 * DEPENDENCY-FREE ON PURPOSE: it imports only Node built-ins (`node:module`,
 * `node:fs`, `node:path`, `node:url`), so it can never be a victim of the very
 * inconsistency it checks for. Keep it that way — do not add any `@papercusp/*` or
 * third-party import here.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load-bearing packages the operator host imports at boot whose absence has (or
 * would) crash-loop `:3070`. A partial/half-installed `node_modules` — the failure
 * class — drops at least one of these, so they double as SENTINELS spanning the
 * major install clusters (first-party workspace pkgs, the MCP SDK + its transitive
 * azure/typespec chain, mem0, the core HTTP/DB/fs runtime). Catch the partial
 * install even when the exact missing dep isn't listed.
 *
 * ⚠ Every specifier here is RESOLVE-VERIFIED against a healthy tree (a false
 * positive would refuse to start a GOOD build — worse than the disease). Some
 * packages only resolve via a specific form because of their `exports` map:
 *   - `@modelcontextprotocol/sdk` (bare) does NOT resolve even when installed — use
 *     `.../package.json`.
 *   - `mem0ai/package.json` is blocked by `exports` — use the bare `mem0ai`.
 * When you ADD an entry, resolve-check it both present AND (conceptually) absent.
 */
export const CRITICAL_BOOT_MODULES: readonly string[] = [
  // first-party workspace packages (statically imported by host-bootstrap)
  '@papercusp/plugin-loader',
  '@papercusp/operator-core',
  // the 2026-06-25 culprits: MCP SDK + mem0
  //
  // WI-5801: `@typespec/ts-http-runtime/package.json` and `@azure/core-util/package.json`
  // used to sit here as sentinels for "mem0's transitive azure/typespec chain". They were
  // REMOVED because at that moment neither was in node_modules, in package-lock.json, or
  // declared by anything — so any `npm install` pruned them as extraneous, after which this
  // preflight resolve-failed 2/9 and exited 78, refusing to boot a PERFECTLY HEALTHY tree.
  // It took papercup-bg-host (routines/git-sync/substrate) into a crash-loop fleet-wide.
  //
  // CORRECTION (EI-18661577149752049, hours later the same day): the original note here said
  // that chain was "gone from the tree entirely" because mem0ai@3.0.3 depends only on
  // axios/openai/uuid/zod. That reasoned about mem0ai's DEPENDENCIES and missed its PEERS —
  // the azure/typespec chain arrives via mem0ai's peerDependencies (@azure/identity,
  // @azure/search-documents), which `mem0ai/oss` imports EAGERLY at module eval. Both are
  // plain non-optional package-lock.json entries again. Keeping them OUT of this manifest
  // is still correct — they must never gate boot — but do not rely on "that chain is gone".
  // Why they were absent that day: an ABORTED `rm -rf node_modules && npm install` (it died
  // on ENOTEMPTY mid-run, racing a concurrent writer) left the tree missing packages the
  // LOCKFILE REQUIRES. Note that is the INVERSE of the prune above, and this manifest can
  // detect neither: see EI-18666996942859193 — a both-directions package-lock ⇄ node_modules
  // diff is the check that would have caught BOTH incidents, with no list to maintain.
  //
  // Do NOT "fix" a missing peer by adding it here (the dead release-fixer that night was
  // about to add `ollama`). That just mints another sentinel — the very anti-pattern that
  // caused this incident. Declare the peer in the package.json that owns it instead.
  //
  // That is precisely the false positive the manifest comment above warns about, and it is
  // the specific hazard of a SENTINEL: a sentinel's whole job is to be a package you do not
  // directly depend on, which means an upstream dependency bump can delete it without any
  // signal here. The failure is also LATENT — a running host survives on already-loaded
  // modules and only dies on its NEXT restart, so the blame lands on whatever change that
  // restart happened to carry. `boot-integrity-preflight.test.ts` now resolve-checks this
  // whole manifest against the real tree so a dropped entry fails a test instead of the fleet.
  '@modelcontextprotocol/sdk/package.json',
  'mem0ai',
  // core HTTP / DB / fs runtime
  'hono',
  'postgres',
  'chokidar',
];

export interface PreflightResult {
  ok: boolean;
  checked: string[];
  missing: { id: string; error: string }[];
}

/** A module resolver (throws if the id cannot be resolved). `require.resolve`-shaped. */
export type ModuleResolver = (id: string) => string;

/** The default resolver resolves against THIS file's node_modules (the live release
 *  tree) — the same resolution the crashing imports used, so it sees what the host
 *  sees. `require.resolve` only RESOLVES (no module execution), so it's safe + fast
 *  and catches exactly the MODULE_NOT_FOUND class. */
const defaultResolver: ModuleResolver = createRequire(import.meta.url).resolve;

/**
 * Resolve-check the critical-module manifest. Pure + fully injectable (pass
 * `resolve` / `modules` in tests so nothing touches real `node_modules`).
 */
export function preflightCriticalModules(opts?: {
  modules?: readonly string[];
  resolve?: ModuleResolver;
}): PreflightResult {
  const modules = opts?.modules ?? CRITICAL_BOOT_MODULES;
  const resolve = opts?.resolve ?? defaultResolver;
  const missing: { id: string; error: string }[] = [];
  for (const id of modules) {
    try {
      resolve(id);
    } catch (e) {
      missing.push({ id, error: e instanceof Error ? e.message.split('\n')[0] : String(e) });
    }
  }
  return { ok: missing.length === 0, checked: [...modules], missing };
}

// ---------------------------------------------------------------------------
// Lock ⇄ tree drift (EI-18666996942859193) — the primary, list-free signal.
//
// CRITICAL_BOOT_MODULES above is a hand-maintained SENTINEL: it can only ever catch
// drift in packages someone thought to list, and on 2026-07-25 it missed an 8-package
// incomplete install for hours because none of the 8 happened to be on the list. It
// stays (kept as a cheap, resolve-verified smoke check — see the module doc), but it is
// no longer the primary signal: `package-lock.json` already enumerates the FULL intended
// tree, so diffing it against node_modules needs no list at all and catches every
// package, not just the ones we remembered to name.
//
// BOTH DIRECTIONS, ALWAYS TOGETHER — this is the specific trap a partial check falls
// into (EI-18666996942859193's own postmortem): checking only "on-disk-but-not-in-lock"
// (extraneous / WI-5801's class) can report a confident "0 extraneous ⇒ tree is safe"
// while missing packages the lock requires (the 2026-07-25 class) entirely, because that
// direction cannot see them. A caller that wants "is this tree healthy" must look at
// BOTH `missing` and `extraneous`, never one alone.
// ---------------------------------------------------------------------------

/** A lock-entry key's shape as it appears under package-lock.json's `packages` map. */
interface LockPackageEntry {
  dev?: boolean;
  optional?: boolean;
  link?: boolean;
}

export interface LockTreeDriftResult {
  /** Direction A: a plain (non-dev, non-optional, non-link) top-level package the lock
   *  requires, absent from node_modules — an INCOMPLETE install. This is the class that
   *  cost the fleet hours on 2026-07-25; a sentinel list can never see it in general. */
  missing: string[];
  /** Direction B: a top-level node_modules directory with no corresponding lock entry —
   *  PRUNABLE; the next `npm install` will remove it. Checking only this direction is
   *  the WI-5801 false-all-clear trap — see the module doc above. */
  extraneous: string[];
  /** true iff `missing` is empty (drift-clean does NOT require `extraneous` to be empty —
   *  an extraneous package is a future prune, not a present breakage). */
  ok: boolean;
}

export interface LockTreeDriftDeps {
  /** Absolute path to the tree root containing `package-lock.json` + `node_modules`. */
  rootDir: string;
  /** Reads a file as utf8 text (fs.readFileSync-shaped). Injectable for tests. */
  readFile?: (path: string) => string;
  /** Lists a directory's entry names (fs.readdirSync-shaped). Injectable for tests. */
  readDir?: (path: string) => string[];
  /** True iff `path` exists and is a directory. Injectable for tests. */
  isDirectory?: (path: string) => boolean;
}

const defaultReadFile = (p: string) => readFileSync(p, 'utf8');
const defaultReadDir = (p: string) => readdirSync(p);
const defaultIsDirectory = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// Matches a TOP-LEVEL package-lock.json `packages` key only — `node_modules/<name>` or
// `node_modules/@scope/<name>`, with no further nested `node_modules` segment. Nested
// (per-dependency-private) copies are deliberately out of scope: every observed incident
// (this one + WI-5801) was a hoisted top-level package, and that is also where a boot-time
// `require.resolve` / `import` actually resolves from.
const TOP_LEVEL_LOCK_KEY_RE = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/;

/**
 * Both-directions diff between package-lock.json's required top-level packages and what
 * is actually on disk in node_modules. Pure + fully injectable (pass `readFile`/`readDir`/
 * `isDirectory` in tests so nothing touches a real tree) — mirrors `preflightCriticalModules`'s
 * injectability above.
 *
 * Throws if `package-lock.json` cannot be read/parsed at `deps.rootDir` — callers that want
 * a never-throws surface should go through `checkLockTreeDrift` instead.
 */
export function diffLockAndTree(deps: LockTreeDriftDeps): LockTreeDriftResult {
  const readFile = deps.readFile ?? defaultReadFile;
  const readDir = deps.readDir ?? defaultReadDir;
  const isDirectory = deps.isDirectory ?? defaultIsDirectory;

  const lockRaw = readFile(join(deps.rootDir, 'package-lock.json'));
  const lock = JSON.parse(lockRaw) as { packages?: Record<string, LockPackageEntry> };
  // A lockfile with no `packages` map (lockfileVersion 1, or a truncated write) is
  // UNMEASURABLE, not clean. Defaulting it to `{}` walked zero entries and returned
  // `{ ok: true, missing: [], extraneous: [] }` — a boot-integrity ALL-CLEAR sourced from a
  // check that never ran, which is the exact absent-read-as-measured shape (WI-5977) this
  // preflight exists to catch in the tree it inspects. Throwing is in-contract: the doc
  // above already promises to throw on an unreadable lock, and `checkLockTreeDrift` turns
  // that into `skipped: true` + the reason, so the caller sees "not measured", never "fine".
  if (!lock.packages || typeof lock.packages !== 'object') {
    throw new Error(
      'package-lock.json has no `packages` map (lockfileVersion 1 or a partial write) — ' +
        'lock/tree drift cannot be measured from it',
    );
  }
  const packages = lock.packages;
  const nmDir = join(deps.rootDir, 'node_modules');

  // Direction A: lock-required, disk-absent. Also builds the lock-name set Direction B
  // diffs against, so we walk `packages` exactly once.
  const missing: string[] = [];
  const lockTopLevelNames = new Set<string>();
  for (const [key, entry] of Object.entries(packages)) {
    const m = TOP_LEVEL_LOCK_KEY_RE.exec(key);
    if (!m) continue;
    const name = m[1];
    lockTopLevelNames.add(name);
    if (entry?.dev || entry?.optional || entry?.link) continue; // skip per the drift spec
    if (!isDirectory(join(nmDir, name))) missing.push(name);
  }

  // Direction B: on-disk, lock-absent.
  const extraneous: string[] = [];
  let topEntries: string[] = [];
  try {
    topEntries = readDir(nmDir);
  } catch {
    topEntries = []; // no node_modules at all ⇒ nothing to report as extraneous here
  }
  for (const entry of topEntries) {
    if (entry.startsWith('.')) continue; // .bin, .package-lock.json, .cache, ...
    if (entry.startsWith('@')) {
      let scoped: string[] = [];
      try {
        scoped = readDir(join(nmDir, entry));
      } catch {
        scoped = [];
      }
      for (const s of scoped) {
        if (s.startsWith('.')) continue;
        const name = `${entry}/${s}`;
        if (!lockTopLevelNames.has(name) && isDirectory(join(nmDir, entry, s))) extraneous.push(name);
      }
      continue;
    }
    if (!lockTopLevelNames.has(entry) && isDirectory(join(nmDir, entry))) extraneous.push(entry);
  }

  missing.sort();
  extraneous.sort();
  return { missing, extraneous, ok: missing.length === 0 };
}

export interface LockTreeDriftCheck extends LockTreeDriftResult {
  /** true iff the check could not run at all (no package-lock.json found, parse error,
   *  ...) — this is NOT a drift signal; `ok` stays `true` in this case purely so a caller
   *  that only checks `ok` fails safe (never refuses to boot because it couldn't compute
   *  drift), but callers that care must check `skipped` explicitly rather than reading
   *  `ok: true` as "verified clean". */
  skipped: boolean;
  error?: string;
}

/**
 * Walks up from `startDir` looking for a `package-lock.json` — the monorepo root.
 * Bounded so a misconfigured/rootless environment can't loop forever.
 */
export function findLockRootUpward(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'package-lock.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Never-throws wrapper around `diffLockAndTree`: resolves `rootDir` (default: walk up
 * from this file's own location) and swallows any read/parse failure into
 * `{ skipped: true, error }` rather than propagating — a broken/absent lockfile must
 * never itself become a new false-positive boot refusal (the exact hazard this whole
 * module's design already guards against for CRITICAL_BOOT_MODULES).
 */
export function checkLockTreeDrift(
  opts?: { rootDir?: string } & Partial<Pick<LockTreeDriftDeps, 'readFile' | 'readDir' | 'isDirectory'>>,
): LockTreeDriftCheck {
  try {
    const rootDir = opts?.rootDir ?? findLockRootUpward(dirname(fileURLToPath(import.meta.url)));
    if (!rootDir) {
      return { ok: true, missing: [], extraneous: [], skipped: true, error: 'package-lock.json not found in any ancestor directory' };
    }
    const result = diffLockAndTree({ rootDir, readFile: opts?.readFile, readDir: opts?.readDir, isDirectory: opts?.isDirectory });
    return { ...result, skipped: false };
  } catch (e) {
    return { ok: true, missing: [], extraneous: [], skipped: true, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Preflight ANOTHER tree, from OUTSIDE it (EI-18661647550414959).
//
// Everything above answers "may *I* boot?" — it runs inside the host being started,
// which is necessarily AFTER the running process was killed. The one moment we can
// still cheaply say "don't do this" is the moment nobody asks: BEFORE the restart,
// while the host is still up. `preflightTreeAt` is that same verdict computed about
// an arbitrary tree root, so `dev:restart` and deploy-cli can refuse instead of
// restarting a host straight into a crash-loop.
//
// TWO TRAPS, BOTH MEASURED (2026-08-10) — a naive wiring silently checks NOTHING:
//
//  1. WRONG DIRECTORY. `package-lock.json` lives at the TREE ROOT, but every caller's
//     natural handle on a host is its systemd `WorkingDirectory`, which for 4 of the 5
//     dev:restart targets is `<root>/apps/operator`. `checkLockTreeDrift` does NOT walk
//     up from an explicit `rootDir`, so passing that directly returns
//     `{ skipped: true, ok: true }` — a guard that inspects nothing and reports clean.
//     Hence the mandatory `findLockRootUpward` hop below.
//
//  2. WRONG TREE. `preflightCriticalModules`'s default resolver resolves against THIS
//     file's own node_modules. For a target running from a DIFFERENT checkout (the
//     `dev` target runs from `papercup-release`, not the staging tree this code is
//     usually loaded from) that silently audits the wrong tree — and that target is
//     precisely the one whose node_modules a deploy rewrites and whose interrupted
//     rollback leaves inconsistent. Hence the tree-anchored `createRequire` below.
//
// FAIL OPEN, BUT NEVER SILENTLY. A tree we could not inspect must be reported as NOT
// CHECKED, never as clean: `ok` stays true so an unreadable tree can never block a
// restart, but `checked:false` is what a caller must branch on. Reading `ok:true`
// without `checked` is the same false-green this module already warns about for
// `LockTreeDriftCheck.skipped`.
// ---------------------------------------------------------------------------

export interface TreeIntegrityResult {
  /** Did we actually inspect the tree? FALSE ⇒ NOT CHECKED. `ok:true` with
   *  `checked:false` is NOT a clean bill — it is "no verdict, failing open". */
  checked: boolean;
  /** true iff nothing blocking was found. Fails OPEN: an uninspectable tree is `ok`. */
  ok: boolean;
  /** The directory the caller asked about (typically a unit's WorkingDirectory). */
  requestedRoot: string;
  /** The ancestor actually carrying package-lock.json, or null if none was found. */
  lockRoot: string | null;
  /** Required packages absent from node_modules — the union of the list-free lock⇄tree
   *  diff and the sentinel manifest. Non-empty ⇒ this tree will not boot. */
  missing: string[];
  /** On-disk but unlisted; a future `npm install` prune, never a reason to refuse. */
  extraneous: string[];
  /** Why the check could not run / could only run partially. Set iff `checked` is false
   *  or a leg was skipped. */
  reason?: string;
  /** One actionable line, safe to hand straight to an agent or a human. */
  note: string;
}

/**
 * Resolve-check an arbitrary tree the way boot would, without starting anything.
 * Pure + fully injectable (`lockRootFor` / `driftCheck` / `resolve`) so tests never
 * touch a real tree, mirroring the rest of this module.
 *
 * The verdict is deliberately ASYMMETRIC, and that asymmetry is the whole point: a
 * POSITIVE detection is trustworthy even from a partial inspection (a package that is
 * genuinely absent is absent), while a CLEAN bill from a partial inspection is not
 * evidence of anything. So a skipped drift leg still reports whatever the sentinel
 * leg found, but never reports "clean".
 */
export function preflightTreeAt(opts: {
  rootDir: string;
  modules?: readonly string[];
  resolve?: ModuleResolver;
  driftCheck?: (rootDir: string) => LockTreeDriftCheck;
  lockRootFor?: (startDir: string) => string | null;
}): TreeIntegrityResult {
  const requestedRoot = opts.rootDir;
  const base: Pick<TreeIntegrityResult, 'requestedRoot' | 'missing' | 'extraneous'> = {
    requestedRoot,
    missing: [],
    extraneous: [],
  };

  const lockRoot = (opts.lockRootFor ?? findLockRootUpward)(requestedRoot);
  if (!lockRoot) {
    const reason = `no package-lock.json in ${requestedRoot} or any ancestor`;
    return {
      ...base,
      checked: false,
      ok: true,
      lockRoot: null,
      reason,
      note: `[boot-integrity] NOT CHECKED (${reason}) — proceeding without a verdict. This is not a clean bill of health.`,
    };
  }

  const drift = (opts.driftCheck ?? ((r: string) => checkLockTreeDrift({ rootDir: r })))(lockRoot);

  // Anchor resolution to the TREE UNDER TEST, not to whichever checkout loaded this code.
  let resolve = opts.resolve;
  if (!resolve) {
    try {
      resolve = createRequire(join(lockRoot, 'package.json')).resolve;
    } catch {
      resolve = undefined;
    }
  }
  const sentinel = resolve ? preflightCriticalModules({ modules: opts.modules, resolve }) : null;

  const missing = [...new Set([...(drift.skipped ? [] : drift.missing), ...(sentinel?.missing.map((m) => m.id) ?? [])])];
  const extraneous = drift.skipped ? [] : drift.extraneous;

  // `checked` tracks the PRIMARY, list-free signal. A sentinel-only pass is a partial
  // inspection and must not read as a full clean bill (see the asymmetry above).
  const checked = !drift.skipped && sentinel !== null;
  const skippedLegs: string[] = [];
  if (drift.skipped) skippedLegs.push(`lock⇄tree diff skipped (${drift.error ?? 'unknown'})`);
  if (!sentinel) skippedLegs.push('sentinel resolve skipped (could not anchor a resolver)');
  const reason = skippedLegs.length ? skippedLegs.join('; ') : undefined;

  if (missing.length > 0) {
    return {
      ...base,
      checked,
      ok: false,
      lockRoot,
      missing,
      extraneous,
      reason,
      note:
        `[boot-integrity] ${lockRoot} is INCONSISTENT — ${missing.length} required package(s) are absent from ` +
        `node_modules: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? `, +${missing.length - 8} more` : ''}. ` +
        `Starting a host from this tree would crash-loop it on MODULE_NOT_FOUND (the boot guard would exit ` +
        `${BOOT_INTEGRITY_EXIT_CODE}). Fix: \`npm run install:safe -- ci\` in ${lockRoot}, then retry.`,
    };
  }

  return {
    ...base,
    checked,
    ok: true,
    lockRoot,
    extraneous,
    reason,
    note: checked
      ? `[boot-integrity] ${lockRoot} resolves clean (${extraneous.length} extraneous, not fatal).`
      : `[boot-integrity] PARTIALLY CHECKED (${reason}) — nothing blocking found, but this is not a full verdict.`,
  };
}

/** Distinct exit code so systemd / deploy-cli auto-rollback / a human can tell a
 *  build-INTEGRITY failure (this) apart from a normal crash or the lag-self-restart's
 *  EX_TEMPFAIL (75). 78 is BSD `EX_CONFIG`. */
export const BOOT_INTEGRITY_EXIT_CODE = 78;

/**
 * Run the preflight and, if the build is broken, log ONE loud actionable line and
 * exit fast — call this as early as possible in boot (before the cluster forks and
 * before the heavy import graph evaluates). Injectable `log` / `exit` / `driftCheck`
 * for tests. Returns the sentinel-check result on success so callers may continue /
 * assert (unchanged shape — `checkLockTreeDrift`'s result is folded into the
 * refuse-boot decision and logging below, not into this return value).
 *
 * TWO SIGNALS, ONE VERDICT (EI-18666996942859193): the hand-maintained
 * `CRITICAL_BOOT_MODULES` sentinel check stays — it's cheap and already proven — but
 * the list-free lock⇄tree drift diff is now the PRIMARY signal, since it catches any
 * missing required package, not just the ones on the list. Either one failing refuses
 * boot. An extraneous (on-disk-but-unlisted) package never refuses boot — it's a future
 * `npm install` prune, not a present breakage — it's only logged as a warning.
 */
export function runBootIntegrityGuardOrExit(opts?: {
  modules?: readonly string[];
  resolve?: ModuleResolver;
  log?: (line: string) => void;
  exit?: (code: number) => never;
  driftCheck?: () => LockTreeDriftCheck;
}): PreflightResult {
  const log = opts?.log ?? ((l) => console.error(l));
  const exit = opts?.exit ?? ((c) => process.exit(c) as never);
  const result = preflightCriticalModules({ modules: opts?.modules, resolve: opts?.resolve });
  const drift = (opts?.driftCheck ?? checkLockTreeDrift)();

  if (!drift.skipped && drift.extraneous.length > 0) {
    log(
      `[boot-integrity] tree-drift: ${drift.extraneous.length} node_modules director${drift.extraneous.length === 1 ? 'y is' : 'ies are'} ` +
        `not in package-lock.json and will be pruned by the next \`npm install\` (not fatal): ${drift.extraneous.join(', ')}`,
    );
  }
  if (drift.skipped && drift.error) {
    log(`[boot-integrity] tree-drift check skipped (${drift.error}) — falling back to the sentinel check alone`);
  }

  const driftMissing = drift.skipped ? [] : drift.missing;
  if (!result.ok || driftMissing.length > 0) {
    const allMissing = [...new Set([...result.missing.map((m) => m.id), ...driftMissing])];
    log(
      `[boot-integrity] FATAL: this release checkout is INCONSISTENT — ` +
        `${allMissing.length} required package(s) cannot be resolved / are absent from node_modules: ` +
        `${allMissing.join(', ')}. node_modules does not match the source (a partial/half-installed deploy or an ` +
        `interrupted rollback). Refusing to start so the host fails fast (exit ${BOOT_INTEGRITY_EXIT_CODE}) ` +
        `instead of crash-looping every worker on MODULE_NOT_FOUND. Fix: \`npm ci\` in this checkout ` +
        `(or roll back to the last consistent release), then restart. First error: ` +
        `${result.missing[0]?.error ?? (driftMissing[0] ? `Cannot find module '${driftMissing[0]}'` : 'n/a')}`,
    );
    exit(BOOT_INTEGRITY_EXIT_CODE);
  }
  return result;
}
