/**
 * Startup validation for the operator-home harness (EI-2224 recurrence guard).
 *
 * Fail-loud assertion: the configured home harness slug MUST resolve to a
 * registered project. This catches slug mismatches early (e.g. fire-paths
 * targeting an unregistered harness after a slug migration) instead of
 * silently 404ing during dispatch and going dark.
 *
 * Called at operator boot by src/server.ts before any business logic.
 */

import { HOME_HARNESS_ENV, operatorHomeHarnessSlug } from '../harness/operator-home-harness';
import { resolveProject } from '../harness-core';
import { activeWorkspaceId } from '../workspace-registry';
import { loadHarnessRegistry } from '../harness-registry';

/**
 * Validate that the configured home harness slug resolves to a registered project.
 * Throws if:
 *  - The slug is unset/empty
 *  - The slug does not resolve in the active workspace (AND not cross-workspace)
 *  - resolveProject() returns null
 *
 * Call this ONCE at operator startup, before any fire-paths fire.
 */
export async function validateHomeHarnessResolution(): Promise<void> {
  // EI-18189651437540304: a hermetic/no-home-hive operator instance (the gym's
  // spawned gym-operator, boot-spec.ts) intentionally sets PAPERCUSP_POT_HOME_SLUG
  // to the EMPTY STRING to declare "this instance has no home hive at all" — the
  // same semantic `resolvePotHomeSlug()` (pot/wake.ts) already honors (blank ⇒
  // null, no fallback). But `operatorHomeHarnessSlug()` cannot express that: by
  // design (papercup→papercusp generalization) it treats "unset" and "explicitly
  // blanked" identically and falls back to LEGACY_DEFAULT_HOME_HARNESS
  // ('papercusp') either way — so a deliberately-blanked hermetic instance still
  // validates against 'papercusp', which of course isn't registered in its own
  // isolated workspace, and this fires every time. Distinguish the two cases HERE
  // (not in the shared resolver, which ~70 other call sites rely on always
  // returning a concrete slug): only a genuinely present-but-EMPTY env var means
  // "no home harness, skip validation" — an absent/unset env var still resolves
  // and validates via the legacy-default fallback exactly as before.
  if (process.env[HOME_HARNESS_ENV] === '') {
    return;
  }

  const slug = operatorHomeHarnessSlug();
  if (!slug || !slug.trim()) {
    throw new Error(
      'STARTUP VALIDATION FAILED: operatorHomeHarnessSlug() returned an empty slug. ' +
      'Check PAPERCUSP_POT_HOME_SLUG env or LEGACY_DEFAULT_HOME_HARNESS fallback.'
    );
  }

  const ws = activeWorkspaceId();
  const proj = await resolveProject(slug, ws);
  if (!proj) {
    throw new Error(
      `STARTUP VALIDATION FAILED: home harness slug '${slug}' does not resolve to a ` +
      `registered project in workspace '${ws}'. This will cause fire-paths (dispatcher, ` +
      `overwatch, routines) to 404 silently and go dark. Verify the harness is registered ` +
      `and PAPERCUSP_POT_HOME_SLUG is set correctly, then restart the operator.`
    );
  }
}

/**
 * Should a FAILED home-harness validation hard-fail boot? NON-FATAL by default (EI-2633): a fresh
 * PACKAGED install legitimately has no registered home-harness project yet (the baked default slug
 * doesn't resolve in the 'default' workspace until setup), and re-throwing in host-bootstrap's
 * fire-and-forget boot IIFE was an UNHANDLED promise rejection → Node process exit → embedded-PG
 * down → dead on first launch for EVERY new user. So the boot path logs loudly (preserving the
 * EI-2224 "don't go dark silently" intent) and hard-fails ONLY when explicitly opted in — the
 * dev/server operator + CI/green-gate set PAPERCUSP_HOME_HARNESS_VALIDATION_FATAL=1 to restore
 * fail-fast. Mirrors the sibling addon-preflight policy. This pure predicate centralizes the
 * decision so it can be unit-pinned (the boot IIFE itself is not unit-testable).
 */
export function homeHarnessValidationFatal(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAPERCUSP_HOME_HARNESS_VALIDATION_FATAL === '1';
}

/**
 * Best-effort signal (EI-9919) for whether a failed home-harness validation is the
 * well-known, harmless FRESH-INSTALL gap rather than a genuine slug-drift
 * misconfiguration — so the boot log can say so instead of alarming every new user.
 *
 * A packaged desktop install validates the home-harness slug BEFORE its first-boot
 * hive auto-provisioning (ship-papercusp-as-single-hive, host-bootstrap.ts BUG-1 —
 * an async git clone that can take real time) has necessarily completed, so a fresh
 * install's FIRST boot always fails this check even though nothing is actually
 * broken: it self-resolves once the hive is cloned + registered, on a later boot.
 *
 * True when the active workspace has ZERO registered projects at all (nothing has
 * ever been set up — the fresh-install state). False when at least one project IS
 * registered but it just isn't the configured home-harness slug — THAT is real
 * drift (e.g. a stale PAPERCUSP_POT_HOME_SLUG after a rename) and must stay loud.
 * Never throws: a registry read failure conservatively reports "not a fresh
 * install" so a genuine problem is never silently softened.
 */
export async function isLikelyFreshInstallGap(workspaceId?: string): Promise<boolean> {
  try {
    const ws = workspaceId ?? activeWorkspaceId();
    const reg = await loadHarnessRegistry(ws);
    return reg.projects.length === 0;
  } catch {
    return false;
  }
}
