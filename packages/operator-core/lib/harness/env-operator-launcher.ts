/**
 * env-operator-launcher — install-time provisioning of the local env operators
 * (dogfood-silent-canonical-hive-join P-017, owner directives D-006/D-007/D-009).
 *
 * The cross-platform env switcher (EnvSwitcherBar) self-hides on a packaged,
 * single-operator install: only ONE env (the running sidecar) is reachable, and the
 * bar needs ≥2. This module brings the OTHER *enabled* env operators up — spawning
 * each from the already-cloned `papercup` source (bootstrap-papercusp-hive clones it)
 * on its fixed dev-box port (dev :3270 / prod :3070 / staging :3170), all sharing the
 * ONE embedded Postgres via RLS — so the switcher lights up. It is the missing
 * "install brings up the chosen local operators" half of D-006; the data/control
 * contract (dev-operators.ts, env-switcher-prefs.ts, the route + bar) already shipped
 * (D-009). This module does NOT change that contract — it just starts the operators
 * the reachability probe already reports.
 *
 * ── SAFETY: the EI-126 single-writer invariant is load-bearing ──────────────────────
 * Only the PRIMARY operator may run the shared-DB background machinery (the hyperbee
 * substrate, git-export drains, DBOS scheduled workflows). TWO writers against one
 * papercusp DB caused the DBOS appVersion war, doubled drain loops, and the
 * plan-content federation echo that rewrote single plans ~100k times (a 102 GB
 * substrate_outbox — host-bootstrap.ts EI-126). So every operator THIS launcher spawns
 * is strictly REQUEST-ONLY: `PAPERCUSP_BACKGROUND_WORKERS=0` (which short-circuits the
 * substrate / git-export / DBOS / periodic-sweep boot blocks, all gated on
 * backgroundWorkersEnabled()). The existing primary keeps the single-writer machinery;
 * the extra envs are read/serve-only siblings, exactly as the dev box runs :3170
 * request-only alongside the :3070 primary today.
 *
 * ── DEFAULT-ON under the desktop (WI-3285) ──────────────────────────────────────────
 * The boot integration (host-bootstrap.ts) runs this on every `PAPERCUSP_DESKTOP=1` boot
 * unless explicitly opted out (`PAPERCUSP_PROVISION_ENV_OPERATORS=0`). It originally
 * shipped dark behind an opt-IN env, which meant every packaged install rendered the env
 * switcher with all-dead buttons (owner-reported on the Windows build, WI-3285:
 * "The buttons should all be operational"). Never on a non-desktop host — the dev box's
 * dev/prod/staging operators are managed by their own launchers and must not be hijacked.
 * The PLANNER below (planEnvOperatorLaunch) is a PURE function and is fully unit-tested;
 * the effectful spawn/probe/tree/toolchain seams are injected.
 *
 * ── PROCESS LIFECYCLE / REAPING (handle at the live-verify, P-008/P-010) ────────────
 * Spawned operators are detached + unref'd so they outlive this boot turn. They are
 * request-only siblings of the primary, sharing its embedded Postgres — so when the
 * desktop (and its embedded PG) exits they lose their DB and idle/error rather than serve
 * stale state. But nothing here REAPS them on desktop shutdown (the dev box delegates that
 * to Tauri's beforeDevCommand watchdog in bin/dev-operator-ifneeded.sh). The packaged
 * build's live verify must own env-operator reaping — most cleanly the Tauri host tracking
 * the returned pids and TERM/KILL-ing them on exit, mirroring the dev watchdog. This is
 * deferred WITH the live spawn verify (not before it) because process-lifecycle behaviour
 * is platform-specific and only observable on a real build.
 *
 * ── BUNDLED-FIRST on a packaged install (owner directive 2026-07-06, WI-3285) ────────
 * "All installs are dogfood installs" and env provisioning on user builds means
 * PER-BRANCH BUNDLED SIDECARS — never npm-install-from-source on a user machine.
 * Verified on the real packaged Linux deb (WI-3287): the bundle ships a BARE node (no
 * npm/npx/tsx) and the clone dir is an empty stub, so any from-source path ENOENTs.
 * So the launcher spawns each env from a bundled per-branch `serve.mjs` when the package
 * ships one (see resolveBundledSidecar for the discovery contract:
 * `<env-sidecars-dir>/<branch>/serve.mjs`, dir from PAPERCUSP_ENV_SIDECARS_DIR or
 * `env-sidecars/` next to the running serve.mjs), running it with the SAME node binary
 * that runs this primary (process.execPath — always present, PATH-independent).
 * From-source (node + the tree's own tsx CLI against bin/hono-host.ts, mirroring
 * bin/dev-operator-ifneeded.sh) remains for machines where the cloned source + installed
 * deps actually exist (the dev box). When neither a bundle nor a runnable tree exists,
 * the env is reported unavailable (skipReason 'no-source-tree' / 'no-toolchain') and not
 * spawned — the switcher keeps self-hiding for it. The bundled `release` env always works
 * with no toolchain and is never spawned here (it IS the running package).
 */

import { spawn, type StdioOptions } from 'node:child_process';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { detectPapercupRoot, hasPapercupMarkers } from './register-papercusp';
import { readEnvSwitcherPrefs } from './env-switcher-prefs';

/** One provisionable env operator: which fixed local port it serves and which git
 *  tree/branch it represents (D-006). */
export interface EnvOperatorSpec {
  /** Stable env id — must match a `kind:'env'` DEV_OPERATORS id (dev-operators.ts). */
  id: string;
  /** Fixed local port (mirrors dev_wrapper.rs TARGETS + DEV_OPERATORS). */
  port: number;
  /** The git branch/tree this env serves (D-006). Used by the (release-build)
   *  worktree-preparation seam; the conservative default runs the detected checkout. */
  branch: string;
  /** How the env is served: a source operator host (node+tsx bin/hono-host.ts — the
   *  default) or the Vite SPA dev server (`local` :3055, whose /api proxies to the
   *  primary operator via PAPERCUSP_API_TARGET). */
  run?: 'operator' | 'vite';
}

/**
 * The env operators install-time provisioning brings up (D-006's port/multi-operator
 * model). Includes `local` (:3055) — the Vite SPA dev server run from the working tree,
 * its /api proxied to THIS primary operator (WI-3285: the owner mandated every switcher
 * button be operational on a packaged install; D-006's original "maps to prod or is
 * omitted" left it permanently dead). Deliberately EXCLUDES one DEV_OPERATORS entry:
 *  - `release` — the immutable bundled sidecar (already running as the primary, or at
 *    PAPERCUSP_RELEASE_ORIGIN); it is never spawned from source (it IS the package).
 * Overlaps with whatever the primary/release already serves are handled by the
 * idempotent `already-reachable` / `is-self` skips in the planner — not by omission.
 */
export const PROVISIONABLE_ENV_OPERATORS: readonly EnvOperatorSpec[] = [
  { id: 'dev', port: 3270, branch: 'staging' }, // the user's working-tree checkout (the cloned source as-is)
  { id: 'prod', port: 3070, branch: 'main' }, // the green/release tree
  { id: 'staging', port: 3170, branch: 'staging' }, // the shared integration tree
  { id: 'local', port: 3055, branch: 'staging', run: 'vite' }, // the Vite SPA over the working tree
] as const;

export type LaunchAction = 'spawn' | 'skip';
export type SkipReason =
  | 'disabled' // the user turned this env off (env-switcher-prefs)
  | 'is-self' // it's the port THIS operator already serves
  | 'already-reachable' // another operator already answers on this port (idempotent)
  | 'no-source-tree' // the cloned papercup source isn't present, and none is coming
  | 'source-tree-pending' // a shipped source archive hasn't finished extracting YET
  | 'no-toolchain'; // no Node/npx+tsx run path on this machine

/** Skip reasons that are TRANSIENT — this env is expected to spawn on a later pass once
 *  the pending work finishes. Everything else is terminal for this boot. A machine reader
 *  (gate, health probe, UI) must branch on THIS, not on prose (EI-19442842364710969):
 *  `no-source-tree` and `source-tree-pending` are otherwise indistinguishable, and reading
 *  the transient one as terminal produced a false FAIL in the WI-3307 acceptance gate. */
export const TRANSIENT_SKIP_REASONS: readonly SkipReason[] = ['source-tree-pending'] as const;

/** True when `reason` means "not yet", false when it means "not on this machine". */
export function isTransientSkip(reason: string | undefined): boolean {
  return !!reason && (TRANSIENT_SKIP_REASONS as readonly string[]).includes(reason);
}

export interface EnvOperatorPlanEntry extends EnvOperatorSpec {
  /** http origin the switcher would navigate to, e.g. http://127.0.0.1:3170. */
  origin: string;
  action: LaunchAction;
  /** Present iff action==='skip' — WHY it was skipped. */
  skipReason?: SkipReason;
  /** Present iff action==='spawn': 'bundled' runs the package's per-branch serve.mjs
   *  (no toolchain needed); 'source' runs the cloned tree (dev box). */
  spawnMode?: 'bundled' | 'source';
  /** For spawnMode==='bundled': absolute path to that branch's bundled serve.mjs
   *  (stamped by launchEnvOperators after planning; the planner stays pure). */
  bundlePath?: string;
}

export interface PlanEnvOperatorLaunchInput {
  /** Candidate specs (default PROVISIONABLE_ENV_OPERATORS). */
  specs?: readonly EnvOperatorSpec[];
  /** Env ids the user disabled (env-switcher-prefs `disabled`). */
  disabledIds?: readonly string[];
  /** Ports already served by a live operator (idempotent skip). */
  reachablePorts?: readonly number[];
  /** The port THIS operator listens on — never re-spawn self. */
  selfPort?: number | null;
  /** Whether the cloned `papercup` source tree exists (a launchable env runs from it). */
  hasSourceTree: boolean;
  /** A source archive SHIPPED with this build but has not been extracted into a tree yet
   *  (first boot: extraction starts milliseconds after this pass and runs for MINUTES —
   *  measured ~30min for a 5.3G tree at ~2.9MB/s). Splits the source-less skip into the
   *  TRANSIENT `source-tree-pending` and the TERMINAL `no-source-tree`. Default false ⇒
   *  callers that don't know keep the pre-existing terminal wording. */
  sourceArchivePending?: boolean;
  /** Whether a Node/npx+tsx run path is available on this machine. */
  hasToolchain: boolean;
  /** Env ids with a bundled sidecar in the package (owner directive 2026-07-06 /
   *  WI-3285; contract: <sidecarDir>/env-sidecars/<envId>/serve.mjs): a bundled env
   *  spawns with NO source tree and NO toolchain. `run:'vite'` envs are source-only. */
  bundledEnvIds?: readonly string[];
  /** Bind host for the rendered origin (default 127.0.0.1). */
  host?: string;
}

/**
 * PURE planner: decide, per env, spawn-or-skip and (when skipped) WHY. No side effects.
 *
 * Skip precedence (deterministic, most-specific first):
 *   disabled → is-self → already-reachable → [bundled? spawn] →
 *   (source-tree-pending | no-source-tree) → no-toolchain → spawn (source).
 * `disabled` wins over everything (an off env is never started regardless of state);
 * `is-self` / `already-reachable` win over the env gates so an already-up operator is
 * never reported as "no toolchain". A bundled per-branch sidecar (owner directive
 * 2026-07-06) spawns REGARDLESS of source/toolchain — that's the packaged-install path;
 * the source/toolchain gates apply only to an env we'd otherwise run from the tree.
 * `run:'vite'` envs are source-only (the SPA dev server transforms the tree).
 */
export function planEnvOperatorLaunch(
  input: PlanEnvOperatorLaunchInput,
): EnvOperatorPlanEntry[] {
  const specs = input.specs ?? PROVISIONABLE_ENV_OPERATORS;
  const host = input.host ?? '127.0.0.1';
  const disabled = new Set(input.disabledIds ?? []);
  const reachable = new Set(input.reachablePorts ?? []);
  const bundled = new Set(input.bundledEnvIds ?? []);
  const selfPort = input.selfPort ?? null;

  return specs.map((spec): EnvOperatorPlanEntry => {
    const origin = `http://${host}:${spec.port}`;
    const base = { ...spec, origin };
    const skip = (skipReason: SkipReason): EnvOperatorPlanEntry => ({
      ...base,
      action: 'skip',
      skipReason,
    });

    if (disabled.has(spec.id)) return skip('disabled');
    if (selfPort != null && selfPort === spec.port) return skip('is-self');
    if (reachable.has(spec.port)) return skip('already-reachable');
    if (spec.run !== 'vite' && bundled.has(spec.id)) {
      return { ...base, action: 'spawn', spawnMode: 'bundled' };
    }
    if (!input.hasSourceTree) {
      // "no tree YET" vs "no tree, ever" — structurally distinct, never prose-only.
      return skip(input.sourceArchivePending ? 'source-tree-pending' : 'no-source-tree');
    }
    if (!input.hasToolchain) return skip('no-toolchain');
    return { ...base, action: 'spawn', spawnMode: 'source' };
  });
}

/** A spawned operator handle (the bits the launcher reports + the boot path can reap). */
export interface SpawnedOperator {
  id: string;
  port: number;
  pid?: number;
}

export interface BundledSidecarIdentity {
  /** SHA-256 of the exact serve.mjs bytes, independent of metadata. */
  readonly bundleSha256: string | null;
  /** SHA of the bytes this sidecar was built from, when attested. */
  readonly buildSha: string | null;
  /** Version baked into the sidecar provenance, when available. */
  readonly version: string | null;
  /** Why the identity was (or was not) established. */
  readonly source: 'build-provenance' | 'build-stamp' | 'unknown';
  /** True only when the provenance also hashes this exact serve.mjs. */
  readonly bytesVerified: boolean;
  /** The bundle itself carries the load-only identity capability marker. */
  readonly requestOnlyIdentityGuard: boolean;
}

/**
 * Assemble the marker at runtime so this CHECKER does not put the complete
 * marker into every serve.mjs by itself. The complete literal lives only in
 * local-announce-identity's guarded branch; finding it in another bundle is
 * therefore evidence that the guarded implementation was actually bundled.
 */
export function requestOnlyIdentityGuardMarker(): string {
  return ['papercusp', 'request', 'only', 'identity', 'load', 'only', 'v1'].join('-');
}

function trimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sha256Matches(actual: string | null, expected: unknown): boolean {
  if (!actual || typeof expected !== 'string' || !/^[0-9a-f]{64}$/i.test(expected)) {
    return false;
  }
  return actual === expected.toLowerCase();
}

/**
 * Read a bundled env-sidecar's own provenance without borrowing the primary
 * process's `PAPERCUSP_BUILD_SHA`.  The launcher previously spread
 * `process.env` into every child, so an old serve.mjs reported the primary's
 * SHA and looked current.  A missing/partial provenance is deliberately
 * represented as unknown; it is never promoted to the parent's identity.
 */
export function readBundledSidecarIdentity(bundlePath: string): BundledSidecarIdentity {
  const dir = dirname(bundlePath);
  let bundleBytes: Buffer | null = null;
  try {
    bundleBytes = readFileSync(bundlePath);
  } catch {
    // The caller will refuse an unreadable bundle through the absent guard.
  }
  const requestOnlyIdentityGuard =
    bundleBytes?.includes(requestOnlyIdentityGuardMarker()) ?? false;
  const bundleSha256 = bundleBytes
    ? createHash('sha256').update(bundleBytes).digest('hex')
    : null;
  const provenance = join(dir, 'build-provenance.json');
  try {
    const parsed = JSON.parse(readFileSync(provenance, 'utf8')) as {
      buildSha?: unknown;
      gitHeadAtEmit?: unknown;
      gitHead?: unknown;
      version?: unknown;
      artifacts?: Array<{ name?: unknown; sha256?: unknown }>;
    };
    // Prefer the explicit baked identity. Older emitters did not populate
    // buildSha, so retain their own source provenance as a diagnostic fallback
    // in the same order used by the original reader.
    const buildSha =
      trimmedString(parsed.buildSha) ??
      trimmedString(parsed.gitHeadAtEmit) ??
      trimmedString(parsed.gitHead);
    const version = trimmedString(parsed.version);
    const artifact = parsed.artifacts?.find((a) => {
      const name = trimmedString(a?.name);
      return name === 'serve.mjs' || name?.endsWith('/serve.mjs');
    });
    return {
      buildSha,
      version,
      source: 'build-provenance',
      bundleSha256,
      bytesVerified: sha256Matches(bundleSha256, artifact?.sha256),
      requestOnlyIdentityGuard,
    };
  } catch {
    // Continue to the lightweight sidecar/composed-payload stamps below.
  }

  for (const stampName of ['.sidecar-build-stamp', 'BUILD-STAMP.txt']) {
    try {
      const stamp = readFileSync(join(dir, stampName), 'utf8');
      if (stampName === '.sidecar-build-stamp') {
        const parsed = JSON.parse(stamp) as {
          gitHead?: unknown;
          version?: unknown;
          serveSha256?: unknown;
        };
        return {
          buildSha:
            trimmedString((parsed as { buildSha?: unknown }).buildSha) ??
            trimmedString(parsed.gitHead),
          version: trimmedString(parsed.version),
          source: 'build-stamp',
          bundleSha256,
          bytesVerified: sha256Matches(bundleSha256, parsed.serveSha256),
          requestOnlyIdentityGuard,
        };
      }
      const buildSha = /^sha=([^\s]+)\s/m.exec(stamp)?.[1]?.trim() || null;
      const version = /^version=([^\s]+)\s/m.exec(stamp)?.[1]?.trim() || null;
      const serveSha256 = /^serveSha256=([0-9a-f]{64})\s*$/im.exec(stamp)?.[1] || null;
      return {
        buildSha,
        version,
        source: 'build-stamp',
        bundleSha256,
        bytesVerified: sha256Matches(bundleSha256, serveSha256),
        requestOnlyIdentityGuard,
      };
    } catch {
      // Try the next supported stamp shape.
    }
  }
  return {
    buildSha: null,
    version: null,
    source: 'unknown',
    bundleSha256,
    bytesVerified: false,
    requestOnlyIdentityGuard,
  };
}

export interface RequestOnlyBundleAdmission {
  readonly ok: boolean;
  readonly reason:
    | 'byte-identical-primary'
    | 'primary-bundle-unavailable'
    | 'bundle-unreadable'
    | 'identity-guard-absent'
    | 'bundle-differs-from-primary';
  readonly identity: BundledSidecarIdentity;
}

/**
 * Resolve the serve.mjs this process was launched from. `PAPERCUSP_SIDECAR_BIN`
 * names the sibling `bin/` directory on packaged launches; argv[1] is the
 * direct bundle path. A bundled request-only child is unsafe when neither can
 * establish the current primary bytes, so absence is a refusal rather than a
 * provenance guess.
 */
export function resolveRunningPrimaryBundlePath(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): string | null {
  const sidecarBin = env.PAPERCUSP_SIDECAR_BIN?.trim();
  const sidecarCandidate = sidecarBin
    ? basename(sidecarBin) === 'serve.mjs'
      ? sidecarBin
      : join(dirname(sidecarBin), 'serve.mjs')
    : undefined;
  const candidates = [
    // The explicit sidecar-bin contract wins over argv[1]. In a source/tsx
    // launch argv[1] is serve.ts, while PAPERCUSP_SIDECAR_BIN still points at
    // the packaged primary bundle that a bundled child must match.
    sidecarCandidate,
    argv[1],
  ];
  for (const candidate of candidates) {
    if (
      candidate &&
      basename(candidate) === 'serve.mjs' &&
      existsSync(candidate)
    ) {
      return candidate;
    }
  }
  return null;
}

/**
 * Fail-closed admission for a request-only bundled child. The marker proves
 * the child contains the load-only implementation; direct content hashes prove
 * it is the same serve.mjs as the running primary instead of a stale staged
 * copy carrying inherited parent provenance.
 */
export function inspectRequestOnlyBundleAdmission(
  bundlePath: string,
  primaryBundlePath: string | null,
): RequestOnlyBundleAdmission {
  const identity = readBundledSidecarIdentity(bundlePath);
  if (!primaryBundlePath) {
    return { ok: false, reason: 'primary-bundle-unavailable', identity };
  }
  if (!identity.bundleSha256) {
    return { ok: false, reason: 'bundle-unreadable', identity };
  }
  if (!identity.requestOnlyIdentityGuard) {
    return { ok: false, reason: 'identity-guard-absent', identity };
  }
  const primaryIdentity =
    resolve(bundlePath) === resolve(primaryBundlePath)
      ? identity
      : readBundledSidecarIdentity(primaryBundlePath);
  if (!primaryIdentity.requestOnlyIdentityGuard) {
    return { ok: false, reason: 'identity-guard-absent', identity };
  }
  if (
    !primaryIdentity.bundleSha256 ||
    primaryIdentity.bundleSha256 !== identity.bundleSha256
  ) {
    return { ok: false, reason: 'bundle-differs-from-primary', identity };
  }
  return { ok: true, reason: 'byte-identical-primary', identity };
}

export interface LaunchEnvOperatorsDeps {
  /** Candidate specs (default PROVISIONABLE_ENV_OPERATORS). */
  specs?: readonly EnvOperatorSpec[];
  /** Read the per-machine enabled/disabled prefs (default readEnvSwitcherPrefs). */
  readPrefs?: () => { disabled: string[] };
  /** Probe one origin for a live operator (default: GET /api/desktop/version). Never throws. */
  probe?: (origin: string) => Promise<boolean>;
  /** Resolve the runnable source root (default defaultDetectSourceRoot:
   *  PAPERCUSP_DEV_SOURCE_ROOT exact-checked, else detectPapercupRoot). null ⇒ absent. */
  detectSourceRoot?: () => string | null;
  /** Whether a source archive shipped with this build but is not yet extracted (default
   *  defaultDetectSourceArchivePending: PAPERCUSP_SOURCE_ARCHIVE points at a real file).
   *  Only consulted when detectSourceRoot() found no tree. */
  detectSourceArchivePending?: () => boolean;
  /** Whether a Node/npx+tsx run path exists (default: a `which`-style check). */
  hasToolchain?: () => Promise<boolean>;
  /** Resolve the bundled per-branch sidecar for a branch (owner directive 2026-07-06 /
   *  WI-3285): absolute path to that branch's serve.mjs, or null when the package
   *  doesn't ship one. DEFAULT: resolveBundledSidecar — `<dir>/<branch>/serve.mjs`
   *  under PAPERCUSP_ENV_SIDECARS_DIR, else `env-sidecars/` next to the RUNNING
   *  serve.mjs (process.argv[1]). */
  detectBundledSidecar?: (branch: string) => string | null;
  /** This operator's listen port (default: PAPERCUSP_HONO_PORT / PORT). */
  selfPort?: number | null;
  /** Prepare the on-disk tree for an env (worktree/branch checkout) and return its path.
   *  DEFAULT: prepareEnvWorktree (env-tree-prepare.ts) — dev runs the working tree in
   *  place; prod/staging get their own git worktree on main/staging under
   *  ~/.papercusp/env-trees/ (D-006). It is idempotent + best-effort + returns null on any
   *  git failure (shallow/offline clone), so that env is simply skipped → the switcher
   *  self-hides it. Returning null ⇒ this env's tree couldn't be prepared → skipped. */
  prepareTree?: (entry: EnvOperatorPlanEntry, sourceRoot: string) => Promise<string | null>;
  /** Spawn one operator from `treePath` on its port (default: detached `npx tsx
   *  bin/hono-host.ts`, request-only). Returns the handle, or null on a spawn failure. */
  spawnOperator?: (
    entry: EnvOperatorPlanEntry,
    treePath: string,
  ) => SpawnedOperator | null;
  /** Delay between spawns (ms) to avoid embedded-PG migration contention on cold boot
   *  (staggered boot, D-006). Default 4000. */
  staggerMs?: number;
  /** Sleep seam (tests pass a no-op). Default a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Bind host (default 127.0.0.1). */
  host?: string;
  /** Log sink (default console.log). */
  log?: (message: string) => void;
}

export interface LaunchEnvOperatorsResult {
  /** The full plan (every candidate, spawn-or-skip + reason). */
  planned: EnvOperatorPlanEntry[];
  /** The operators actually spawned this run. */
  spawned: SpawnedOperator[];
  /** Skipped envs with their reason (mirrors planned skips + any prepare/spawn failure). */
  skipped: { id: string; reason: string }[];
}

/**
 * Machine-readable completion marker for the optional source-operator pass.
 *
 * The WI-3307 acceptance harness used to infer that pass 2 ran by searching for
 * human-readable prose (`[env-operators] source pass`). That made a wording edit
 * change the verdict, and a newly added line could make a failed extract look like
 * a successful pass. Keep the contract as fields with stable names; callers should
 * branch on `status`, not on the surrounding log text.
 */
export type EnvOperatorPass2Status = 'ran' | 'skipped' | 'failed';

export function formatEnvOperatorPass2Result(input: {
  status: EnvOperatorPass2Status;
  spawned?: number;
  skipped?: number;
  reason?: string;
}): string {
  const fields = [`[env-operators] PASS2_RESULT status=${input.status}`];
  if (input.spawned !== undefined) fields.push(`spawned=${input.spawned}`);
  if (input.skipped !== undefined) fields.push(`skipped=${input.skipped}`);
  if (input.reason !== undefined) fields.push(`reason=${input.reason}`);
  return fields.join(' ');
}

/** Default reachability probe — GET /api/desktop/version, server-side (no CORS). Never throws. */
async function defaultProbe(origin: string, timeoutMs = 700): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await globalThis.fetch(`${origin}/api/desktop/version`, { signal: ctrl.signal });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/** This operator's listen port (same env the host + dev-operators.ts read). */
function defaultSelfPort(): number | null {
  const raw = process.env.PAPERCUSP_HONO_PORT ?? process.env.PORT;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Default source-root resolution (WI-3306/WI-3308 extraction↔launcher contract, msg
 * mrano4w7): prefer `PAPERCUSP_DEV_SOURCE_ROOT` — the tree the serve-side first-boot
 * extracted from the packaged `source.tar.zst` — then fall back to the dev-box walk
 * (detectPapercupRoot). The env var is EXACT-checked (marker files, no walk-up) so a
 * half-extracted / missing tree degrades to the fallback instead of matching a parent.
 * Deliberately NOT the primary's PAPERCUSP_INTEGRATION_ROOT: that var re-points
 * prompt-assembly / capability base-dirs / git-pipeline on the PRIMARY, and on a
 * packaged install the primary is the release — only the dev/local CHILDREN may see
 * the extracted tree.
 */
export function defaultDetectSourceRoot(): string | null {
  const extracted = process.env.PAPERCUSP_DEV_SOURCE_ROOT;
  if (extracted && extracted.trim() !== '') {
    const root = resolve(extracted);
    if (hasPapercupMarkers(root)) return root;
  }
  return detectPapercupRoot();
}

/**
 * Default "is a source tree still coming?" check: did this build SHIP a source archive
 * that hasn't been unpacked yet? host-bootstrap extracts PAPERCUSP_SOURCE_ARCHIVE into
 * PAPERCUSP_DEV_SOURCE_ROOT ~13ms after the first provisioning pass, so on a first boot
 * the archive exists while the tree does not — that is precisely the window in which the
 * skip is transient. A build that shipped no archive returns false and keeps the terminal
 * `no-source-tree`. Best-effort, never throws (EI-19442842364710969).
 */
export function defaultDetectSourceArchivePending(): boolean {
  const archive = process.env.PAPERCUSP_SOURCE_ARCHIVE;
  if (!archive || archive.trim() === '') return false;
  try {
    return existsSync(archive);
  } catch {
    return false;
  }
}

/** Default toolchain check: is the cloned source's apps/operator runnable? We need an
 *  `npx`/`node` on PATH AND the operator entrypoint present. Best-effort, never throws. */
async function defaultHasToolchain(sourceRoot: string | null): Promise<boolean> {
  if (!sourceRoot) return false;
  try {
    // The operator entrypoint the dev-operator script runs (`npx tsx bin/hono-host.ts`).
    const entry = join(sourceRoot, 'apps', 'operator', 'bin', 'hono-host.ts');
    if (!existsSync(entry)) return false;
    // node is the runtime; npx ships with it. process.execPath is always present here,
    // but the SPAWNED env uses `npx tsx` from PATH, so require node_modules/.bin too.
    return existsSync(join(sourceRoot, 'node_modules', '.bin'));
  } catch {
    return false;
  }
}

/**
 * Bundled env-sidecar discovery — THE PINNED PACKAGING CONTRACT (owner directive
 * 2026-07-06; contract pinned on plan env-switcher-packaged-all-platforms-2026-07-06,
 * msg mra0qw49):
 *
 *   <sidecarDir>/env-sidecars/<envId>/serve.mjs
 *
 * where <sidecarDir> = dirname(PAPERCUSP_SIDECAR_BIN) — main.rs already sets it on
 * every platform and WSLENV-forwards it, so discovery needs zero Rust changes.
 * PAPERCUSP_ENV_SIDECARS_DIR overrides explicitly (tests / future packaging); the
 * running serve.mjs's own dir (process.argv[1]) is the last-resort fallback. Each env
 * dir is a SIDECAR-SHAPED bundle (serve.mjs + spa/ + db-sql/ …) so the env operator
 * serves its own UI; there is NO per-env node — the launcher reuses the primary's
 * runtime (process.execPath; npm/npx/tsx are verifiably absent on real installs,
 * WI-3287). V1 packaging ships exactly one extra bundle: env-sidecars/staging/.
 *
 * PROD SPECIAL CASE: when env-sidecars/prod/ is absent (the V1 default), prod resolves
 * to the PRIMARY's own <sidecarDir>/serve.mjs — the installed release IS green `main`,
 * so the prod button serves the same code on its fixed :3070 port.
 */
export function resolveBundledSidecar(envId: string): string | null {
  try {
    const explicit = process.env.PAPERCUSP_ENV_SIDECARS_DIR;
    const sidecarBin = process.env.PAPERCUSP_SIDECAR_BIN;
    const sidecarDir = sidecarBin
      ? dirname(sidecarBin)
      : process.argv[1]
        ? dirname(process.argv[1])
        : null;
    const baseDir =
      explicit && explicit.trim() !== ''
        ? explicit
        : sidecarDir
          ? join(sidecarDir, 'env-sidecars')
          : null;
    if (!baseDir) return null;
    const bundle = join(baseDir, envId, 'serve.mjs');
    if (existsSync(bundle)) return bundle;
    if (envId === 'prod' && sidecarDir) {
      const primary = join(sidecarDir, 'serve.mjs');
      if (existsSync(primary)) return primary;
    }
    return null;
  } catch {
    return null;
  }
}

/** The tsx CLI installed by the tree's own npm install — spawning it via
 *  process.execPath works on a packaged install where `npx` is not on PATH. */
function resolveTsxCli(treePath: string): string | null {
  const cli = join(treePath, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  return existsSync(cli) ? cli : null;
}

/** The vite CLI for the `local` env — hoisting may place it under the app or the root. */
function resolveViteCli(treePath: string): string | null {
  for (const cli of [
    join(treePath, 'apps', 'operator-vite', 'node_modules', 'vite', 'bin', 'vite.js'),
    join(treePath, 'node_modules', 'vite', 'bin', 'vite.js'),
  ]) {
    if (existsSync(cli)) return cli;
  }
  return null;
}

/** Argv for the `local` (vite) child — EI-19424980348813193.
 *
 * The port MUST be passed explicitly and STRICTLY. Neither half is optional:
 *
 *  - `--port <p>`: without it vite falls back to `apps/operator-vite/vite.config.ts`'s
 *    `Number(OPERATOR_E2E_PORT ?? PORT) || 3055`, and `PORT` is AMBIENT in this process —
 *    the primary operator sets it to its OWN Hono port (`defaultSelfPort()` reads exactly
 *    that env). So an inherited `PORT` silently retargets the SPA at the operator's port.
 *  - `--strictPort`: without it a collision on that wrong port makes vite WALK to the next
 *    free one and serve happily there, so the failure is silent and invisible — the launcher
 *    polls `entry.port` forever while a perfectly healthy dev server answers somewhere else.
 *
 * Observed on the packaged mac install 2026-08-03 (bundle b5f11ff9): the `local` child was
 * spawned as a bare `vite.js`, inherited `PORT=3070` from the primary, found 3070 held by
 * that same primary, walked to 3071 (free on IPv4 — the sibling dev operator held it only as
 * IPv6 `*:3071`, and node's V6ONLY bind leaves the IPv4 half open) and served the real SPA
 * with HTTP 200 on `127.0.0.1:3071` for 26+ minutes. Every probe asked `:3055`, got nothing,
 * and the env was filed as a HANG — `0% CPU` + `STAT Ss` + flat RSS read as "wedged" when
 * they are exactly what a correct, idle, serving vite looks like. `--strictPort` converts
 * that silent mis-bind into a loud immediate failure. */
export function viteChildArgv(viteCli: string, port: number): string[] {
  return [viteCli, '--port', String(port), '--strictPort'];
}

/** Env for the `local` (vite) child — EI-19424980348813193.
 *
 * Identical to every other source child, MINUS the two variables
 * `apps/operator-vite/vite.config.ts` reads as "the port I should listen on"
 * (`OPERATOR_E2E_PORT ?? PORT`). Both are ambient in the primary operator and mean
 * something else entirely there, so they are DELETED rather than overridden: `viteChildArgv`'s
 * explicit `--port` is the single source of truth for where the SPA listens, and leaving a
 * stale `PORT` in the child's env would keep a second, contradictory answer alive for the
 * next reader to trip over. */
export function viteChildEnv(
  base: NodeJS.ProcessEnv,
  treePath: string,
  selfPort: number | null,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    ...sourceChildEnv(treePath),
    ...(selfPort != null ? { PAPERCUSP_API_TARGET: `http://127.0.0.1:${selfPort}` } : {}),
    // The provisioning launcher must not re-run for the children (no recursion).
    PAPERCUSP_PROVISION_ENV_OPERATORS: '0',
    // Vite is a request-only sibling too; keep any node-side route it imports
    // from generating/repairing the shared device identity.
    PAPERCUSP_IDENTITY_MODE: 'load-only',
  };
  delete env.PORT;
  delete env.OPERATOR_E2E_PORT;
  return env;
}

/** Env additions every SOURCE-spawned child gets (extraction↔launcher contract, msg
 *  mrano4w7 / WI-3306): the child's OWN tree as its PAPERCUSP_INTEGRATION_ROOT — its
 *  prompt/capability/git internals must resolve to the tree it serves, never inherit
 *  the primary's — and the bundled-sidecar dir(s) prepended to PATH so tree-spawned
 *  subprocesses find the packaged node on installs where nothing useful is on PATH
 *  (the runtime lives at <sidecarDir>/bin/node; both dirs are added, existence-gated). */
export function sourceChildEnv(treePath: string): Record<string, string> {
  const env: Record<string, string> = { PAPERCUSP_INTEGRATION_ROOT: treePath };
  const sidecarBin = process.env.PAPERCUSP_SIDECAR_BIN;
  if (sidecarBin) {
    const sidecarDir = dirname(sidecarBin);
    const dirs = [sidecarDir, join(sidecarDir, 'bin')].filter((d) => existsSync(d));
    if (dirs.length > 0) env.PATH = [...dirs, process.env.PATH ?? ''].join(delimiter);
  }
  return env;
}

/** Per-env spawn log — EI-19423766332560955.
 *
 * Every env operator used to be spawned with `stdio: 'ignore'`, which made a child that
 * DIED or HUNG unobservable BY CONSTRUCTION: the only recoverable facts were "the launcher
 * says it spawned it" and "it isn't there". Diagnosing WI-3307's dead `dev`/`local` buttons
 * meant hand-reconstructing the child's exact argv+env on the target machine purely to
 * recover its first line of output — slow, error-prone, and actively risky, because the
 * BUNDLED branch carries single-writer knobs (PAPERCUSP_ENV_OPERATOR_ID /
 * PAPERCUSP_USE_EMBEDDED_PG='0', WI-3287) that a hand-rolled repro can easily omit, at which
 * point sweepOrphanPostgres can kill the PRIMARY's postmaster on the shared dataDir.
 *
 * Routing stdout/stderr to an append-mode FILE keeps `detached` + `unref()` intact: a
 * regular-file fd has no pipe buffer, so — unlike `'pipe'` — the child can NEVER block on an
 * undrained parent. Cost is one fd per env.
 *
 * Fails OPEN. If the log cannot be created we fall back to 'ignore' and still spawn: losing
 * diagnosability is strictly better than losing the operator.
 */
export function openEnvOperatorLog(id: string): {
  stdio: StdioOptions;
  logPath: string | null;
  fd: number | null;
} {
  try {
    const dir = join(homedir(), '.papercusp', 'logs');
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, `env-operator-${id}.log`);
    const fd = openSync(logPath, 'a');
    return { stdio: ['ignore', fd, fd], logPath, fd };
  } catch {
    return { stdio: 'ignore', logPath: null, fd: null };
  }
}

/** Record the resolved argv + the launcher's OWN env delta at the top of the child's log.
 *  This is precisely what had to be reconstructed by hand to diagnose a silent child.
 *  Only launcher-set keys are recorded — never the inherited environment, which carries
 *  DB URLs and other secrets. Never throws: diagnostics must not break a spawn. */
function writeSpawnHeader(
  fd: number | null,
  id: string,
  port: number,
  argv: string[],
  envDelta: Record<string, string>,
): void {
  if (fd == null) return;
  try {
    writeSync(
      fd,
      `\n=== [env-operators] spawn ${id} :${port} ${new Date().toISOString()} ===\n` +
        `argv: ${argv.join(' ')}\n` +
        `env-delta: ${JSON.stringify(envDelta)}\n`,
    );
  } catch {
    /* diagnostics must never break the spawn */
  }
}

/** Default spawn — mirror bin/dev-operator-ifneeded.sh's invocation, REQUEST-ONLY.
 *  Detached + unref'd, with stdio routed to a per-env log file (openEnvOperatorLog —
 *  EI-19423766332560955) so the spawned operator outlives this boot turn
 *  and never blocks it. The EI-126 single-writer knobs are the load-bearing safety here.
 *  Prefers `process.execPath` + the tree's own tsx/vite CLI over `npx` from PATH — a
 *  GUI-launched packaged app has no shell PATH to speak of (WI-3285). */
function defaultSpawnOperator(
  entry: EnvOperatorPlanEntry,
  treePath: string,
): SpawnedOperator | null {
  try {
    if (entry.spawnMode === 'bundled' && entry.bundlePath) {
      // Packaged install: run the bundled env sidecar with the same node that runs
      // this primary. Self-contained — no source tree, no toolchain. The env dir is
      // sidecar-shaped (serve.mjs + spa/ + db-sql/ …): point the asset roots INTO it
      // when present so the env operator serves ITS OWN UI/build, not the primary's
      // (a prod-fallback bundle IS the primary's dir, so these resolve to the same
      // paths there — harmless).
      const envDir = dirname(entry.bundlePath);
      const spaDir = join(envDir, 'spa');
      const docsDir = join(envDir, 'internal-docs');
      const admission = inspectRequestOnlyBundleAdmission(
        entry.bundlePath,
        resolveRunningPrimaryBundlePath(),
      );
      if (!admission.ok) {
        // launchEnvOperators records the resulting spawn-failed skip through
        // its injected log sink; do not emit a process-global warning here,
        // because this helper also runs in fail-on-console test harnesses.
        return null;
      }
      const bundleIdentity = admission.identity;
      const parentBuildSha = process.env.PAPERCUSP_BUILD_SHA?.trim() || '';
      const log = openEnvOperatorLog(entry.id);
      writeSpawnHeader(log.fd, entry.id, entry.port, [process.execPath, entry.bundlePath], {
        PAPERCUSP_HONO_PORT: String(entry.port),
        PAPERCUSP_ENV_OPERATOR_ID: entry.id,
        PAPERCUSP_BACKGROUND_WORKERS: '0',
        PAPERCUSP_USE_EMBEDDED_PG: '0',
        PAPERCUSP_IDENTITY_MODE: 'load-only',
        PAPERCUSP_ENV_OPERATOR_BUILD_SHA: bundleIdentity.buildSha ?? 'unknown',
        PAPERCUSP_ENV_OPERATOR_PARENT_SHA: parentBuildSha || 'unknown',
        PAPERCUSP_ENV_OPERATOR_PROVENANCE: bundleIdentity.source,
        PAPERCUSP_ENV_OPERATOR_BYTES_VERIFIED: String(bundleIdentity.bytesVerified),
      });
      const child = spawn(process.execPath, [entry.bundlePath], {
        cwd: envDir,
        detached: true,
        stdio: log.stdio,
        env: {
          ...process.env,
          PAPERCUSP_HONO_PORT: String(entry.port),
          ...(existsSync(spaDir) ? { PAPERCUSP_SPA_DIST: spaDir } : {}),
          ...(existsSync(docsDir) ? { PAPERCUSP_DOCS_ROOT: docsDir } : {}),
          // ── EI-126 single-writer safety — the extra envs are request-only siblings ──
          // (shared embedded PG; ONLY the primary runs the background machinery)
          PAPERCUSP_BACKGROUND_WORKERS: '0',
          PAPERCUSP_DBOS_ENABLE: '0',
          PAPERCUSP_DBOS_ROUTINES: '0',
          PAPERCUSP_DBOS_ORCHESTRATOR: '0',
          // The provisioning launcher must not re-run for the children (no recursion).
          PAPERCUSP_PROVISION_ENV_OPERATORS: '0',
          // Each child reached by top-level navigation, not the primary's IPC fast path.
          PAPERCUSP_IPC_ENABLE: '0',
          DBOS__VMID: `desktop-env-${entry.port}`,
          // WI-3287 (found live on the first real packaged-Linux verify,
          // 2026-07-07): this child re-execs the SAME serve.mjs as the primary
          // under the SAME $HOME. Two things in serve.ts are unconditional and
          // MUST be told this is a request-only sibling, not another primary:
          //  1. The cold-start singleton lock (`operator.lock`) is held by the
          //     primary for its ENTIRE lifetime (released only on shutdown) —
          //     without PAPERCUSP_ENV_OPERATOR_ID scoping its own lock file,
          //     this child's boot ALWAYS aborts with "another `serve` holds the
          //     cold-start lock" the moment the primary is up (which is always,
          //     by the time this launcher runs). It also keeps this child off
          //     the primary's operator.json / sticky-port-memory files (those
          //     must name the primary alone — a reconnecting client or the next
          //     restart must never be handed an env sidecar's port).
          //  2. PAPERCUSP_USE_EMBEDDED_PG='0' + the inherited
          //     HARNESS_ADMIN_DATABASE_URL/HARNESS_DATABASE_URL (already in
          //     process.env — the primary's own ensurePostgres() stamped them)
          //     route this child straight to serve.ts's "attach to external
          //     Postgres" branch, so it NEVER calls startEmbeddedPostgresServer
          //     (double-initdb against the SAME dataDir) or sweepOrphanPostgres
          //     — which, on the shared dataDir, would find the primary's own
          //     live postmaster and KILL it, mistaking it for an orphan. The
          //     "shared embedded PG, EI-126 request-only" contract only holds
          //     with this attach-not-manage path.
          PAPERCUSP_ENV_OPERATOR_ID: entry.id,
          PAPERCUSP_USE_EMBEDDED_PG: '0',
          // Never let a request-only child borrow the primary's build stamp.
          // Unknown provenance stays empty and lets build-info use a baked
          // bundle SHA (or null), rather than fabricating freshness.
          PAPERCUSP_BUILD_SHA: bundleIdentity.buildSha ?? '',
          PAPERCUSP_BUILD_VERSION: bundleIdentity.version ?? '',
          PAPERCUSP_IDENTITY_MODE: 'load-only',
          PAPERCUSP_ENV_OPERATOR_BUILD_SHA: bundleIdentity.buildSha ?? '',
          PAPERCUSP_ENV_OPERATOR_PARENT_SHA: parentBuildSha,
          PAPERCUSP_ENV_OPERATOR_PROVENANCE: bundleIdentity.source,
          PAPERCUSP_ENV_OPERATOR_BYTES_VERIFIED: String(bundleIdentity.bytesVerified),
        },
      });
      child.unref();
      return { id: entry.id, port: entry.port, pid: child.pid };
    }
    if (entry.run === 'vite') {
      // The `local` env: the Vite SPA dev server over the working tree, its /api
      // proxied to THIS primary operator (the packaged install has no :3070 prod).
      const viteCli = resolveViteCli(treePath);
      if (!viteCli) return null;
      const selfPort = defaultSelfPort();
      const log = openEnvOperatorLog(entry.id);
      const argv = viteChildArgv(viteCli, entry.port);
      writeSpawnHeader(log.fd, entry.id, entry.port, [process.execPath, ...argv], {
        PAPERCUSP_INTEGRATION_ROOT: treePath,
        ...(selfPort != null
          ? { PAPERCUSP_API_TARGET: `http://127.0.0.1:${selfPort}` }
          : {}),
        PAPERCUSP_PROVISION_ENV_OPERATORS: '0',
        // EI-19424980348813193: recorded so the log shows the scrub happened. An
        // inherited PORT is what silently retargeted this child at the wrong port.
        PORT: '(deleted — vite.config.ts reads it as its own listen port)',
      });
      const child = spawn(process.execPath, argv, {
        cwd: join(treePath, 'apps', 'operator-vite'),
        detached: true,
        stdio: log.stdio,
        env: viteChildEnv(process.env, treePath, selfPort),
      });
      child.unref();
      return { id: entry.id, port: entry.port, pid: child.pid };
    }
    const tsxCli = resolveTsxCli(treePath);
    const [cmd, args] = tsxCli
      ? [process.execPath, [tsxCli, 'bin/hono-host.ts']]
      : ['npx', ['tsx', 'bin/hono-host.ts']];
    const log = openEnvOperatorLog(entry.id);
    writeSpawnHeader(log.fd, entry.id, entry.port, [cmd as string, ...(args as string[])], {
      PAPERCUSP_INTEGRATION_ROOT: treePath,
      PAPERCUSP_HONO_PORT: String(entry.port),
      PAPERCUSP_BACKGROUND_WORKERS: '0',
      PAPERCUSP_DBOS_ENABLE: '0',
      PAPERCUSP_IDENTITY_MODE: 'load-only',
    });
    const child = spawn(cmd as string, args as string[], {
      cwd: join(treePath, 'apps', 'operator'),
      detached: true,
      stdio: log.stdio,
      env: {
        ...process.env,
        ...sourceChildEnv(treePath),
        PAPERCUSP_HONO_PORT: String(entry.port),
        // ── EI-126 single-writer safety — the extra envs are request-only siblings ──
        PAPERCUSP_BACKGROUND_WORKERS: '0',
        PAPERCUSP_DBOS_ENABLE: '0',
        PAPERCUSP_IDENTITY_MODE: 'load-only',
        PAPERCUSP_BUILD_SHA: '',
        PAPERCUSP_BUILD_VERSION: '',
        PAPERCUSP_ENV_OPERATOR_PARENT_SHA: process.env.PAPERCUSP_BUILD_SHA?.trim() ?? '',
        // The provisioning launcher must not re-run for the children (no recursion).
        PAPERCUSP_PROVISION_ENV_OPERATORS: '0',
        // Each child reached by top-level navigation, not the primary's IPC fast path;
        // disabling IPC avoids clobbering the last-writer-wins endpoint-ipc.json discovery.
        PAPERCUSP_IPC_ENABLE: '0',
        // A stable DBOS VMID per env (matches the dev script's desktop-dev-<port> convention).
        DBOS__VMID: `desktop-env-${entry.port}`,
      },
    });
    child.unref();
    return { id: entry.id, port: entry.port, pid: child.pid };
  } catch {
    return null;
  }
}

const sleepReal = (ms: number): Promise<void> =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    // Don't let a pending stagger timer hold the boot turn / process open.
    (t as { unref?: () => void }).unref?.();
  });

/**
 * Bring up the enabled, not-yet-running env operators from the cloned source.
 * Idempotent (skips ports already served + this operator's own port), graceful
 * (missing tree/toolchain ⇒ that env is skipped, never an error), staggered (avoids
 * cold-boot migration contention), and fully defensive (a per-env prepare/spawn failure
 * is recorded as a skip and never aborts the rest). The caller (host-bootstrap.ts) runs
 * this fire-and-forget + non-fatal behind the default-off env gate.
 */
export async function launchEnvOperators(
  deps: LaunchEnvOperatorsDeps = {},
): Promise<LaunchEnvOperatorsResult> {
  const specs = deps.specs ?? PROVISIONABLE_ENV_OPERATORS;
  const host = deps.host ?? '127.0.0.1';
  const readPrefs = deps.readPrefs ?? (() => readEnvSwitcherPrefs());
  const probe = deps.probe ?? ((origin: string) => defaultProbe(origin));
  const detectSourceRoot = deps.detectSourceRoot ?? defaultDetectSourceRoot;
  const selfPort = deps.selfPort !== undefined ? deps.selfPort : defaultSelfPort();
  const spawnOperator = deps.spawnOperator ?? defaultSpawnOperator;
  const staggerMs = deps.staggerMs ?? 4000;
  const sleep = deps.sleep ?? sleepReal;
  const log = deps.log ?? ((m: string) => console.log(m));

  const sourceRoot = detectSourceRoot();
  const hasSourceTree = !!sourceRoot;
  // Only meaningful when there is no tree: is one still being unpacked? Splits the
  // transient first-boot skip from the terminal one (EI-19442842364710969).
  const detectSourceArchivePending =
    deps.detectSourceArchivePending ?? defaultDetectSourceArchivePending;
  const sourceArchivePending = hasSourceTree ? false : detectSourceArchivePending();
  const hasToolchain = deps.hasToolchain
    ? await deps.hasToolchain()
    : await defaultHasToolchain(sourceRoot);

  // Which envs ship a bundled sidecar in this package (owner directive 2026-07-06;
  // <sidecarDir>/env-sidecars/<envId>/serve.mjs, prod falling back to the primary's
  // own bundle) — the packaged-install spawn path that needs no source or toolchain.
  const detectBundledSidecar = deps.detectBundledSidecar ?? resolveBundledSidecar;
  const bundleByEnvId = new Map<string, string>();
  for (const s of specs) {
    if (s.run === 'vite') continue;
    const bundle = detectBundledSidecar(s.id);
    if (bundle) bundleByEnvId.set(s.id, bundle);
  }

  // Probe every candidate port in parallel for an already-live operator (idempotent skip).
  const reachableEntries = await Promise.all(
    specs.map(async (s) => ({ port: s.port, up: await probe(`http://${host}:${s.port}`) })),
  );
  const reachablePorts = reachableEntries.filter((e) => e.up).map((e) => e.port);

  const disabledIds = readPrefs().disabled;
  const planned = planEnvOperatorLaunch({
    specs,
    disabledIds,
    reachablePorts,
    selfPort,
    hasSourceTree,
    sourceArchivePending,
    hasToolchain,
    bundledEnvIds: [...bundleByEnvId.keys()],
    host,
  });
  // Stamp each bundled entry with its bundle path (the planner is pure and path-free).
  for (const entry of planned) {
    if (entry.action === 'spawn' && entry.spawnMode === 'bundled') {
      entry.bundlePath = bundleByEnvId.get(entry.id);
    }
  }

  const spawned: SpawnedOperator[] = [];
  const skipped: { id: string; reason: string }[] = [];

  // Default: the real branch-differentiating worktree prepare (D-006) — dev runs the
  // working tree in place; prod/staging get their own git worktree on main/staging under
  // ~/.papercusp/env-trees/. It degrades to null→skip on any git failure, so a shallow/
  // offline clone simply doesn't get that env (the switcher self-hides it). Lazy-imported
  // so the type-only back-reference in env-tree-prepare stays a pure type edge.
  const prepareTree =
    deps.prepareTree ??
    (async (entry: EnvOperatorPlanEntry, root: string) => {
      const { prepareEnvWorktree } = await import('./env-tree-prepare');
      return prepareEnvWorktree(entry, root);
    });

  for (const entry of planned) {
    if (entry.action === 'skip') {
      skipped.push({ id: entry.id, reason: entry.skipReason ?? 'skip' });
      continue;
    }
    // Stagger between *actual operator boots* only: no wait before the first real spawn,
    // and a skip / prepare-fail / spawn-fail never consumes a stagger slot (it boots
    // nothing, so there's no migration contention to space out). Keyed on spawned.length
    // rather than loop position so the gap always sits between two live boots.
    if (spawned.length > 0 && staggerMs > 0) await sleep(staggerMs);

    // A bundled sidecar is self-contained — no source tree to prepare; it runs from
    // its own bundle dir. Only source spawns need the worktree/branch checkout.
    let treePath: string | null = null;
    if (entry.spawnMode === 'bundled' && entry.bundlePath) {
      treePath = dirname(entry.bundlePath);
    } else {
      try {
        treePath = await prepareTree(entry, sourceRoot as string);
      } catch {
        treePath = null;
      }
    }
    if (!treePath) {
      skipped.push({ id: entry.id, reason: 'tree-prepare-failed' });
      continue;
    }
    const handle = spawnOperator(entry, treePath);
    if (handle) {
      spawned.push(handle);
      log(
        `[env-operators] spawned ${entry.id} on :${entry.port} (${entry.spawnMode ?? 'source'}, request-only, pid=${handle.pid ?? '?'})`,
      );
    } else {
      skipped.push({ id: entry.id, reason: 'spawn-failed' });
      log(`[env-operators] spawn FAILED for ${entry.id} on :${entry.port} (non-fatal)`);
    }
  }

  // "done" is true of THIS CALL and false of the operation whenever a skip is transient —
  // host-bootstrap runs a second pass after the source extract. Say so in the line itself,
  // so it can never be read as a terminal verdict (EI-19442842364710969).
  const deferred = skipped.filter((s) => isTransientSkip(s.reason));
  log(
    `[env-operators] pass complete — spawned=${spawned.length} skipped=${skipped.length}` +
      (skipped.length ? ` (${skipped.map((s) => `${s.id}:${s.reason}`).join(', ')})` : '') +
      (deferred.length
        ? ` — NOT the final verdict: ${deferred
            .map((s) => s.id)
            .join('+')} deferred until the source extract finishes, then spawn on a later pass`
        : ''),
  );
  return { planned, spawned, skipped };
}
