/**
 * dev-operators — the canonical multi-operator ENV targets for the cross-platform
 * env switcher (dogfood-silent-canonical-hive-join P-012..P-014 / P-017, D-006/D-008).
 *
 * The dev box runs several operator stacks on fixed local ports — prod :3070 (the
 * green/release tree), staging :3170 (the staging tree), dev :3270 (the working tree),
 * and local :3055 (the Vite HMR frontend, whose /api proxies to :3070). The native
 * Linux GTK dev-wrapper bar (papercusp-desktop/src-tauri/src/dev_wrapper.rs `TARGETS`)
 * switches the webview between them. This module is the DATA twin of that list so the
 * cross-platform in-webview switcher (EnvSwitcherBar) renders the same envs on
 * macOS/Windows/Linux. KEEP THE TWO LISTS IN SYNC.
 *
 * Plus a "release" env (D-008): the UNCHANGED code from the installed release PACKAGE —
 * the immutable bundled operator that ships in the installer and can't be broken by
 * local edits. It is the always-good escape hatch (it REPLACES the old remote-main
 * git-reset button). Its origin comes from PAPERCUSP_RELEASE_ORIGIN (set by the Tauri
 * host / provisioning for the bundled operator) and falls back to prod :3070 on the dev
 * box (where the green release IS :3070).
 *
 * WHY SERVER-SIDE reachability: a webview served from one origin (:3070) cannot
 * cross-origin `fetch` another operator's /api/desktop/version (CORS) — so the operator
 * itself probes the sibling ports (server→localhost, no CORS) and reports which envs are
 * live. NAVIGATION between operators is a top-level `window.location` change, which is
 * NOT CORS-bound, so the switch itself works purely client-side.
 *
 * On a packaged single-operator install only the running operator is reachable; the
 * switcher self-hides until install-time provisioning (P-017) brings the others up.
 */

import {
  defaultDetectSourceArchivePending,
  defaultDetectSourceRoot,
  type SkipReason,
} from './env-operator-launcher';
import { isVmReleaseDistribution } from '../vm-release-runtime-policy';

export interface DevOperatorDescriptor {
  /** Stable id (persisted/selected). */
  id: string;
  /** Short button label. */
  label: string;
  /** Fixed local port this env listens on. */
  port: number;
  /** Hover tooltip explaining what the env serves. */
  tooltip: string;
  /**
   * True for envs that can ONLY exist where a papercup source checkout is
   * present (`dev` = the working tree itself; `local` = the Vite HMR dev
   * frontend). On an install without a source tree these are OMITTED from the
   * resolved list entirely — a button for an env that cannot exist is not a
   * "disabled" state, it's noise (owner-reported greyed-button wall on the mac
   * build, WI-3284; plan env-switcher-packaged-all-platforms-2026-07-06).
   * `prod`/`staging` stay: packaged installs run them from the per-branch
   * BUNDLED sidecars (owner directive 2026-07-06), no source needed.
   */
  requiresSourceTree?: boolean;
}

/**
 * Canonical env targets. Mirrors dev_wrapper.rs `TARGETS` (order + ports + meaning).
 */
export const DEV_OPERATORS: readonly DevOperatorDescriptor[] = [
  {
    id: 'dev',
    label: 'dev',
    port: 3270,
    tooltip:
      'Dev operator (:3270) — this session’s own working-tree build. The default target.',
    requiresSourceTree: true,
  },
  {
    id: 'prod',
    label: 'prod',
    port: 3070,
    tooltip:
      'Production operator (:3070) — the deployed green-`main` release build.',
  },
  {
    id: 'staging',
    label: 'staging',
    port: 3170,
    tooltip:
      'Staging operator (:3170) — the shared integration-tree build (latest `staging`).',
  },
  {
    id: 'local',
    label: 'local',
    port: 3055,
    tooltip:
      'Local Vite SPA (:3055) — the hot-reloading dev frontend; its /api proxies to :3070.',
    requiresSourceTree: true,
  },
] as const;

export interface ResolvedDevOperator extends DevOperatorDescriptor {
  /** http origin to navigate to, e.g. `http://127.0.0.1:3170`. */
  origin: string;
  /** Whether the operator answered a /version probe (self is always true). */
  reachable: boolean;
  /** That operator's sidecar sha (8 hex), when reachable. */
  sha: string | null;
  /** True for the operator serving THIS request (highlighted as active). */
  isSelf: boolean;
  /** 'env' = a switchable branch operator; 'release' = the immutable bundled package code (D-008). */
  kind: 'env' | 'release';
  /** Whether the user wants this env (D-007). Disabled envs are not provisioned/started; 'release' is always enabled. */
  enabled: boolean;
}

/**
 * WHY an env is missing from `operators`, in the LAUNCHER's own vocabulary
 * (EI-19421499550693822). Two of the three values are `Extract`ed from the launcher's
 * `SkipReason` union rather than re-spelled here, so if that union renames one the
 * `Extract` collapses to `never` and every construction site fails typecheck — the two
 * surfaces cannot drift into disagreeing about the same condition (derived-truth ladder,
 * rung 2). `isTransientSkip()` from the launcher tells "not yet" from "not on this
 * machine" for the two source-tree values; branch on THAT, never on the prose.
 */
export type DevOperatorOmissionReason =
  | Extract<SkipReason, 'no-source-tree' | 'source-tree-pending'>
  | 'vm-release-distribution';

/** One env deliberately absent from `operators`, with the reason a machine can branch on. */
export interface OmittedDevOperator {
  /** The `DevOperatorDescriptor.id` that was omitted (e.g. 'dev', 'local'). */
  id: string;
  /** WHY it was omitted. Never prose — see DevOperatorOmissionReason. */
  reason: DevOperatorOmissionReason;
}

/**
 * The source-tree axis as a READBACK, not an inference from an absent entry
 * (EI-19421499550693822).
 *
 * WHY THIS EXISTS. `resolveDevOperators` filters `requiresSourceTree` envs (dev/local)
 * out of `operators` entirely when no runnable tree is present — the deliberate fix for
 * the WI-3284 permanently-grey-button wall. But the response carried no record that
 * anything had been dropped, so an absent `dev` was indistinguishable between "no source
 * shipped (expected)", "a shipped archive failed to extract (a bug)", "half-extracted, so
 * the marker check rejected it", and "this endpoint is broken". Diagnosing that needed an
 * SSH + a log grep for `[dev-source]` on the target machine — unavailable to CI, to a
 * remote acceptance check, and to the UI itself.
 *
 * WHY `status` RATHER THAN A BARE `hasSourceTree: boolean`. The vm-release path returns
 * before any detection runs, so a boolean there would have to be `false` — a MEASUREMENT
 * this code never took, reported as one. Same corrective as `StagingBuildIdentity` below
 * (D-052: absence must never render as a clean identity).
 */
export type DevOperatorSourceTreeReadback =
  | { status: 'measured'; present: boolean }
  | { status: 'not_measured'; reason: 'vm-release-distribution' };

export interface ResolveDevOperatorsResult {
  operators: ResolvedDevOperator[];
  /** The port this operator listens on (null if undeterminable). */
  selfPort: number | null;
  /**
   * DIAGNOSTIC (the switcher bar does not render it): whether a runnable source tree was
   * detected on this machine. Pairs with `omitted` — see DevOperatorSourceTreeReadback.
   */
  sourceTree: DevOperatorSourceTreeReadback;
  /**
   * DIAGNOSTIC (not rendered): envs that exist in the canonical list but were left OUT of
   * `operators`, and why. Empty means nothing was dropped — an assertion, not a silence.
   */
  omitted: OmittedDevOperator[];
}

export interface ResolveDevOperatorsDeps {
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Override the detected self port (tests). `null` = none. */
  selfPort?: number | null;
  /** Bind host to probe/navigate (default 127.0.0.1). */
  bindHost?: string;
  /** Per-probe timeout in ms (default 700). */
  timeoutMs?: number;
  /** Candidate env operators (default DEV_OPERATORS). */
  candidates?: readonly DevOperatorDescriptor[];
  /** Env ids the user has disabled (D-007) — reflected as `enabled:false`. 'release' is never disabled. */
  disabledIds?: readonly string[];
  /**
   * Whether a papercup source checkout exists on this machine (tests). Default:
   * `defaultDetectSourceRoot() != null` — the SAME detection launchEnvOperators
   * uses, so it also counts a packaged install's first-boot extracted tree
   * (PAPERCUSP_DEV_SOURCE_ROOT). When false, `requiresSourceTree` envs
   * (dev/local) are omitted from the result entirely — see the descriptor doc.
   */
  hasSourceTree?: boolean;
  /**
   * Whether a source archive SHIPPED with this build but has not finished extracting yet
   * (tests). Default: `defaultDetectSourceArchivePending()` — the SAME check the launcher
   * uses. It splits the source-less omission into the TRANSIENT `source-tree-pending` and
   * the TERMINAL `no-source-tree`; reading the transient one as terminal already produced
   * a false FAIL in the WI-3307 acceptance gate (EI-19442842364710969).
   */
  sourceArchivePending?: boolean;
  /** Test seam; defaults to the live process environment. */
  env?: NodeJS.ProcessEnv;
}

/** This operator's listen port, from the same env the host reads (PAPERCUSP_HONO_PORT / PORT). */
function detectSelfPort(): number | null {
  const raw = process.env.PAPERCUSP_HONO_PORT ?? process.env.PORT;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The "release" env origin (D-008): the UNCHANGED code from the installed release
 * PACKAGE. The Tauri host / provisioning sets PAPERCUSP_RELEASE_ORIGIN to the bundled
 * operator's origin; on the dev box (no bundled binary) it falls back to prod :3070.
 */
export function resolveReleaseOrigin(deps: { host?: string } = {}): string {
  const host = deps.host ?? '127.0.0.1';
  const env = process.env.PAPERCUSP_RELEASE_ORIGIN;
  if (env && /^https?:\/\//.test(env)) return env.replace(/\/+$/, '');
  // Packaged desktop (PAPERCUSP_DESKTOP=1) with no explicit origin: the bundled
  // primary operator IS the release code, and its port is DYNAMIC — the old
  // unconditional `:3070` fallback pointed at a port that doesn't exist on a
  // user install, so the release escape-hatch button rendered permanently dead
  // (owner-reported on the mac build 2026-07-06, WI-3284). Resolve to SELF: the
  // bar then marks release as the active env (honest — you're ON the release
  // code) instead of an unreachable ghost. The dev box keeps the `:3070`
  // fallback (its operators run without PAPERCUSP_DESKTOP; the green release
  // really is :3070 there).
  if (process.env.PAPERCUSP_DESKTOP === '1') {
    const selfPort = detectSelfPort();
    if (selfPort != null) return `http://${host}:${selfPort}`;
  }
  return `http://${host}:3070`;
}

/**
 * The sentinel `/api/desktop/version` emits when the build info carries no sha
 * (`routes/desktop/version.ts`: `sidecarSha: buildInfo.sha ?? 'unknown'`). It is a
 * STRING, so a bare `typeof === 'string'` check accepts it as though it were an
 * identity. Anything deriving a BUILD IDENTITY must reject it (D-052).
 */
const SIDECAR_SHA_UNKNOWN_SENTINEL = 'unknown';

/** Probe one operator's /api/desktop/version (server-side; no CORS). Never throws. */
async function probeVersion(
  origin: string,
  doFetch: typeof fetch,
  timeoutMs: number,
): Promise<{ reachable: boolean; sha: string | null; startedAtMs: number | null }> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await doFetch(`${origin}/api/desktop/version`, { signal: ctrl.signal });
      if (!res.ok) return { reachable: false, sha: null, startedAtMs: null };
      let sha: string | null = null;
      let startedAtMs: number | null = null;
      try {
        const j = (await res.json()) as { sidecarSha?: unknown; sidecarStartedAtMs?: unknown };
        sha = typeof j?.sidecarSha === 'string' ? j.sidecarSha : null;
        startedAtMs = typeof j?.sidecarStartedAtMs === 'number' && Number.isFinite(j.sidecarStartedAtMs)
          ? j.sidecarStartedAtMs
          : null;
      } catch {
        /* non-JSON body — still reachable */
      }
      return { reachable: true, sha, startedAtMs };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { reachable: false, sha: null, startedAtMs: null };
  }
}

/**
 * WI-40893 / D-052 — the live STAGING build identity, as a value that cannot be
 * mistaken for a measurement it is not.
 *
 * WHY THIS EXISTS. P-020 is a staged rollout judged by regression telemetry, and a
 * measurement you cannot attribute to a build cannot establish a regression. The
 * P-019 acceptance canary verified :3170 by content but never recorded WHICH staging
 * build it ran against, so its evidence was unattributable (P-019 clause A.1).
 *
 * WHY `status` RATHER THAN A BARE `sidecarSha: string | null`. Three DIFFERENT
 * failures render as "no usable sha" — unreachable, non-JSON, and the literal
 * `'unknown'` sentinel — and the third is the dangerous one, because it is a
 * well-formed string that reads exactly like an identity. D-052: "absence must never
 * render as a clean identity". So the boundedness is stated ON the value, the same
 * corrective P-019's other defect (WI-40896's `refsMeasured`) required.
 *
 * `sidecarStartedAtMs` travels WITH the sha deliberately: a sha alone cannot tell you
 * the process actually restarted INTO that code, which is the same distinction
 * `serving.startedSinceCodeChange` draws for :3070.
 */
export type StagingBuildIdentity =
  | { status: 'measured'; sidecarSha: string; sidecarStartedAtMs: number | null; origin: string }
  | {
      status: 'not_measured';
      /** WHY it could not be measured — branch on this, never on a null sha. */
      reason: 'unreachable' | 'no-sha-in-response' | 'unknown-sentinel';
      sidecarSha: null;
      sidecarStartedAtMs: null;
      origin: string;
    };

/**
 * Read the live staging operator's build identity. Never throws: every failure is a
 * typed `not_measured`, so a caller cannot accidentally record absence as a build.
 */
export async function readStagingBuildIdentity(
  deps: { doFetch?: typeof fetch; timeoutMs?: number; host?: string } = {},
): Promise<StagingBuildIdentity> {
  const doFetch = deps.doFetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 1500;
  const host = deps.host ?? '127.0.0.1';
  const staging = DEV_OPERATORS.find((d) => d.id === 'staging');
  // Derived from the canonical descriptor list rather than a hardcoded 3170, so the
  // port cannot drift away from dev_wrapper.rs TARGETS behind this reader's back.
  const origin = `http://${host}:${staging?.port ?? 3170}`;

  const { reachable, sha, startedAtMs } = await probeVersion(origin, doFetch, timeoutMs);
  if (!reachable) return { status: 'not_measured', reason: 'unreachable', sidecarSha: null, sidecarStartedAtMs: null, origin };
  if (sha == null) return { status: 'not_measured', reason: 'no-sha-in-response', sidecarSha: null, sidecarStartedAtMs: null, origin };
  if (sha === SIDECAR_SHA_UNKNOWN_SENTINEL) {
    return { status: 'not_measured', reason: 'unknown-sentinel', sidecarSha: null, sidecarStartedAtMs: null, origin };
  }
  return { status: 'measured', sidecarSha: sha, sidecarStartedAtMs: startedAtMs, origin };
}

function portOfOrigin(origin: string): number {
  try {
    const u = new URL(origin);
    return u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  } catch {
    return NaN;
  }
}

/**
 * Resolve the env targets with live reachability. Probes every non-self candidate's
 * /api/desktop/version in parallel (bounded by timeoutMs); failures are reported as
 * `reachable:false`, never thrown. Appends the "release" env (D-008) as the last entry.
 */
export async function resolveDevOperators(
  deps: ResolveDevOperatorsDeps = {},
): Promise<ResolveDevOperatorsResult> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const host = deps.bindHost ?? '127.0.0.1';
  const timeoutMs = deps.timeoutMs ?? 700;
  const selfPort = deps.selfPort !== undefined ? deps.selfPort : detectSelfPort();
  const disabled = new Set(deps.disabledIds ?? []);
  if (isVmReleaseDistribution(deps.env ?? process.env)) {
    const origin = selfPort == null ? `http://${host}:3070` : `http://${host}:${selfPort}`;
    return {
      selfPort,
      // Nothing probed the filesystem on this path, so the source-tree axis is
      // NOT_MEASURED rather than false — and the envs this distribution drops are
      // still named, so an empty `omitted` never has to stand for "and also these".
      sourceTree: { status: 'not_measured', reason: 'vm-release-distribution' },
      omitted: (deps.candidates ?? DEV_OPERATORS).map((d) => ({
        id: d.id,
        reason: 'vm-release-distribution' as const,
      })),
      operators: [{
        id: 'release',
        label: 'release',
        port: selfPort ?? 3070,
        origin,
        tooltip: 'Immutable Papercusp VM runtime (single operator).',
        reachable: true,
        sha: null,
        isSelf: true,
        kind: 'release',
        enabled: true,
      }],
    };
  }
  // Omit source-tree-only envs (dev/local) where no runnable source tree exists —
  // without one they CANNOT run, and rendering them as permanently grey buttons
  // is the WI-3284 owner-reported wall. prod/staging remain (the per-branch
  // bundled sidecars serve them; owner directive 2026-07-06). Uses the launcher's
  // own detection so a packaged install's first-boot extracted tree
  // (PAPERCUSP_DEV_SOURCE_ROOT, WI-3308) counts — a raw detectPapercupRoot()
  // here omitted dev/local from the list while local was literally running
  // (WI-3307 mac verify, 2026-07-07).
  const hasSourceTree = deps.hasSourceTree ?? defaultDetectSourceRoot() != null;
  const allCandidates = deps.candidates ?? DEV_OPERATORS;
  const candidates = allCandidates.filter((d) => hasSourceTree || !d.requiresSourceTree);
  // The omission above is deliberate and stays; what was missing is the READBACK for it
  // (EI-19421499550693822). Report WHAT was dropped and WHY, in the launcher's own
  // vocabulary, so a packaged-build acceptance check is one curl rather than an SSH plus
  // a `[dev-source]` log grep on the target machine. The pending/terminal split is the
  // launcher's own (defaultDetectSourceArchivePending), so the two surfaces cannot
  // disagree about whether a tree is still coming.
  const omitted: OmittedDevOperator[] = hasSourceTree
    ? []
    : (() => {
        const dropped = allCandidates.filter((d) => d.requiresSourceTree);
        if (dropped.length === 0) return [];
        const pending = deps.sourceArchivePending ?? defaultDetectSourceArchivePending();
        const reason: DevOperatorOmissionReason = pending ? 'source-tree-pending' : 'no-source-tree';
        return dropped.map((d) => ({ id: d.id, reason }));
      })();

  const envOps = await Promise.all(
    candidates.map(async (d): Promise<ResolvedDevOperator> => {
      const origin = `http://${host}:${d.port}`;
      const isSelf = selfPort != null && selfPort === d.port;
      // self is reachable by definition — skip its probe.
      const { reachable, sha } = isSelf
        ? { reachable: true, sha: null }
        : await probeVersion(origin, doFetch, timeoutMs);
      return { ...d, origin, reachable, sha, isSelf, kind: 'env', enabled: !disabled.has(d.id) };
    }),
  );

  // The "release" escape env (D-008) — the immutable bundled package code.
  const releaseOrigin = resolveReleaseOrigin({ host });
  const releasePort = portOfOrigin(releaseOrigin);
  const releaseIsSelf = selfPort != null && releasePort === selfPort;
  const releaseProbe = releaseIsSelf
    ? { reachable: true, sha: null }
    : await probeVersion(releaseOrigin, doFetch, timeoutMs);
  const releaseOp: ResolvedDevOperator = {
    id: 'release',
    label: 'release',
    port: releasePort,
    tooltip:
      'Release — the unchanged code from the installed release package (immutable; the safe, always-good env).',
    origin: releaseOrigin,
    kind: 'release',
    isSelf: releaseIsSelf,
    enabled: true,
    ...releaseProbe,
  };

  return {
    operators: [...envOps, releaseOp],
    selfPort,
    sourceTree: { status: 'measured', present: hasSourceTree },
    omitted,
  };
}
