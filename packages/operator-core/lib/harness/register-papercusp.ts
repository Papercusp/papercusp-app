/**
 * Self-register the papercup repo as a harness in the papercusp-workspace
 * sentinel — papercusp-dogfood-v5 Phase 4 / P-024.
 *
 * This is the "flip-the-switch-on-dogfooding" function: once it has run,
 * papercup itself appears in the harness dropdown alongside sheets and
 * the rest. State stays `private` (per Phase 4 design) — no Hyperbee
 * sync, no peer-mirror, no GitHub OAuth required.
 *
 * Idempotent: safe to call on every boot. Detects an existing 'papercup'
 * entry in the sentinel workspace's registry and returns silently. Also
 * tolerant of the sentinel workspace not existing yet (caller usually
 * ensures it first via ensurePapercuspWorkspace, but if not, this
 * silently no-ops rather than throw).
 *
 * Auto-detection: walks UP from the operator's runtime cwd looking for
 * the apps/operator/ + libs/papercusp/ markers that identify the
 * papercup repo. Returns null when not found — typical for a packaged
 * desktop install where the operator runs from .app/Contents/ and
 * papercup the repo isn't on disk. The whole call is a no-op in that
 * case; dogfooding only fires in dev / from-source installs.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadHarnessRegistry, saveHarnessRegistry } from '../harness-registry';
import {
  PAPERCUSP_WORKSPACE_ID,
  ensurePapercuspWorkspace,
} from './papercusp-workspace';
import { readRegistry } from '../workspace-registry';

/**
 * Slug the repo's LEGACY standalone-flow coding harness is registered under.
 * Value stays `'papercup'` on purpose: this is the pre-merge standalone slug,
 * deliberately DISTINCT from the operator-home hive slug (now `'papercusp'`,
 * via operatorHomeHarnessSlug()). The merged-hive skip below relies on the two
 * being different (`slug !== LEGACY_STANDALONE_HARNESS_SLUG`). Stable; downstream
 * code may reference it.
 */
export const LEGACY_STANDALONE_HARNESS_SLUG = 'papercup' as const;

/** True iff `dir` carries both papercup repo markers. Exported for callers that must
 *  validate an EXACT directory (no walk-up) — e.g. the env-operator launcher checking a
 *  PAPERCUSP_DEV_SOURCE_ROOT extracted tree (WI-3306/WI-3308). */
export function hasPapercupMarkers(dir: string): boolean {
  return (
    existsSync(join(dir, 'apps', 'operator', 'package.json')) &&
    existsSync(join(dir, 'libs', 'papercusp', 'package.json'))
  );
}

/**
 * Auto-detect the papercup repo root. Walks up from `start` looking
 * for a directory that has both `apps/operator/package.json` AND
 * `libs/papercusp/package.json` (two markers we can't accidentally
 * collide with). Returns the absolute path or null.
 *
 * Bounded to 8 levels — avoids unbounded walk on weird filesystems.
 *
 * AMBIENT detection (no explicit `start`) prefers
 * `PAPERCUSP_INTEGRATION_ROOT` when it's set and carries the markers:
 * post the release-gate cutover (release-gate-ready-branch-2026-06-04,
 * cut over 2026-06-05) the operator's cwd is the RELEASE checkout
 * (`papercup-release`, a worktree with the same markers), but spawned
 * agents / plan launches / registration must target the INTEGRATION
 * tree — the churning `main` git-sync commits, where edits actually
 * land. An explicit `start` still wins (tests + callers that really
 * mean "walk from here").
 */
export function detectPapercupRoot(start?: string): string | null {
  if (start === undefined) {
    const envRoot = process.env.PAPERCUSP_INTEGRATION_ROOT;
    if (envRoot) {
      const resolved = resolve(envRoot);
      if (hasPapercupMarkers(resolved)) return resolved;
    }
    start = process.cwd();
  }
  let dir = resolve(start);
  for (let i = 0; i < 8; i++) {
    if (hasPapercupMarkers(dir)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null; // hit filesystem root
    dir = parent;
  }
  return null;
}

export interface RegisterResult {
  /** Final state: 'already-registered' | 'newly-registered' | 'skipped'. */
  state: 'already-registered' | 'newly-registered' | 'skipped';
  /** Absolute path papercup was registered at. Null when state='skipped'. */
  path: string | null;
  /** Human-readable reason — primarily for the 'skipped' case. */
  reason?: string;
}

/**
 * Register papercup as a harness in the papercusp-workspace sentinel.
 * Idempotent. Auto-detects the repo path; pass `pathOverride` to force
 * a specific location (tests use this).
 *
 * Does NOT call scaffoldHarnessSchema — that's a separate step that
 * needs to know the schema-scoped slug + may have already run from a
 * different code path. The split keeps registration vs provisioning
 * orthogonal.
 */
export async function registerPapercupHarness(opts: {
  pathOverride?: string;
} = {}): Promise<RegisterResult> {
  // Ambient detection (no explicit start) — honors PAPERCUSP_INTEGRATION_ROOT
  // so a release-checkout-hosted operator registers the integration tree.
  const path = opts.pathOverride ?? detectPapercupRoot();
  if (!path) {
    return {
      state: 'skipped',
      path: null,
      reason: 'papercup root not detected (packaged install, or operator running from a non-repo dir)',
    };
  }

  // Ensure sentinel exists first. If the registry write fails (no
  // home dir / unwritable / etc), bail without touching PG.
  try {
    ensurePapercuspWorkspace();
  } catch (e) {
    return {
      state: 'skipped',
      path: null,
      reason: `ensurePapercuspWorkspace failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Verify sentinel is actually in the workspace registry (defensive —
  // if ensurePapercuspWorkspace returns but the row isn't there,
  // something else is wrong).
  const wsReg = readRegistry();
  if (!wsReg.workspaces.find((w) => w.id === PAPERCUSP_WORKSPACE_ID)) {
    return {
      state: 'skipped',
      path: null,
      reason: 'sentinel workspace missing from registry after ensure',
    };
  }

  // Now check the harness registry SCOPED to the sentinel workspace —
  // not the active workspace. (The active workspace might still be
  // 'default'; we don't disturb it.)
  const hReg = await loadHarnessRegistry(PAPERCUSP_WORKSPACE_ID);
  const already = hReg.projects.find((p) => p.slug === LEGACY_STANDALONE_HARNESS_SLUG);
  if (already) {
    return {
      state: 'already-registered',
      path: already.path,
    };
  }

  // B-merge (owner-directed papercup→papercusp): once 'papercusp' is the MERGED hive that
  // IS this repo (harness_kind:'hive', path===the repo root), do NOT also register a
  // separate legacy 'papercup' harness — that duplicate is exactly what the merge removes.
  // Skip so a post-merge boot never re-creates 'papercup'. Pre-merge (papercusp is still a
  // repo-less hive at a state dir) path!==root, so the legacy registration still runs.
  const mergedHive = hReg.projects.find(
    (p) => p.harness_kind === 'hive' && p.path === path && p.slug !== LEGACY_STANDALONE_HARNESS_SLUG,
  );
  if (mergedHive) {
    return {
      state: 'skipped',
      path: null,
      reason: `repo owned by merged hive '${mergedHive.slug}' (papercup→papercusp merge)`,
    };
  }

  hReg.projects.push({ slug: LEGACY_STANDALONE_HARNESS_SLUG, path });
  await saveHarnessRegistry(hReg, PAPERCUSP_WORKSPACE_ID);

  return {
    state: 'newly-registered',
    path,
  };
}
