/**
 * Phased worktree helpers.
 *
 * Each project has up to three worktrees: staging (the main path),
 * testing (`<path>--testing` or config override), and production
 * (`<path>--production` or config override).
 *
 * Used by:
 *   - apps/operator/app/api/_hono/harness.ts — every `?phase=` route uses
 *     phasePath() to resolve to the right worktree.
 *   - apps/operator/lib/harness-fs-watcher.ts — the FS watcher mirrors all
 *     three phased worktrees into harness_shared.* with a `phase` column.
 */
import { type Phase, ALL_PHASES } from './harness-phases-const';

// Phase + ALL_PHASES live in the client-safe const module so client
// components can import them without pulling node:fs into the browser
// bundle. Re-exported here for back-compat with server callers.
export { type Phase, ALL_PHASES };

interface ProjectLike {
  slug?: string;
  path: string;
  /** Per-phase instance config (port/dbPath/path/publicUrl) from the workspace-PG
   *  registry ProjectEntry. Carried on the resolved project; no config.json read. */
  phases?: Record<string, Record<string, unknown>>;
}

/**
 * Resolve a (project, phase) pair to a filesystem path.
 *   staging      → project.path
 *   testing/prod → sibling `<path>--<phase>` OR explicit per-phase `path` override
 *
 * The per-phase `path` override now lives in the workspace-PG registry ProjectEntry
 * (`deprecate-harness-config-json-2026-06-06`) — carried on the resolved project's
 * `phases` blob, NOT read from `.papercusp/config.json`. This keeps the module
 * pure (no `node:fs`), so it's also client-bundle safe by construction.
 */
export function phasePath(project: ProjectLike, phase: Phase): string {
  if (phase === 'staging') return project.path;
  const override = project.phases?.[phase]?.path;
  if (typeof override === 'string' && override.length > 0) return override;
  return `${project.path}--${phase}`;
}

/**
 * Map a raw query-string `?phase=` value to a Phase, defaulting to staging.
 */
export function phasePhaseLabel(rawPhase: string | undefined): Phase {
  if (rawPhase === 'testing' || rawPhase === 'production' || rawPhase === 'staging') {
    return rawPhase;
  }
  return 'staging';
}
