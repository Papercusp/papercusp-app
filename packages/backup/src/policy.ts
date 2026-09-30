/**
 * Pure, dependency-free backup-policy helpers — the kopia ignore-rule
 * set and the add/remove diff. Kept in its own module (no PG, no kopia,
 * no fs) so workspace-backup.ts and the tests import one source of
 * truth. self-exclusion.test.ts used to hand-copy IGNORE_PATTERNS with
 * a "keep in sync" comment — exactly the drift this module avoids.
 */

/**
 * Directories/globs excluded from every workspace snapshot.
 *
 * The tail group is load-bearing: `backups/` (the kopia repo itself),
 * `.restored/`, `.broken-*`, `.rolled-back-*` all live inside the
 * workspace root we snapshot. Without these the repo recursively
 * snapshots its own pack files and balloons toward 1TB. Don't remove.
 *
 * `db-dumps/` is deliberately NOT excluded: the pre-snapshot hook
 * writes `pg-embedded.sql.gz` into it precisely so kopia versions the
 * DB dump into every snapshot — point-in-time DB restore depends on it.
 * The `db-dumps/hook.log` file still stays out via the `*.log` rule.
 */
/**
 * The load-bearing self-exclusion rules: directories that live INSIDE the
 * workspace root and must never enter a snapshot — `backups/` (the kopia repo
 * itself, the 1TB-runaway case) plus the restore/rollback scratch dirs. Every
 * one of these is asserted against the live kopia global policy before each
 * snapshot (assertSelfExclusionPolicy). Don't remove.
 *
 * EI-1032: PG/kopia recovery events rename the OLD copy aside with a
 * `<name>.<tag>-<timestamp>` suffix, e.g. `embedded-pg-data.broken-2026-05-01`
 * or `kopia-repo.broken-2026-05-01` — a COMPOUND name, not a bare
 * `.broken-*` (which only matches a name that itself STARTS with
 * `.broken-`, e.g. a literal `.broken-2026-05-01` dir). `*.broken-*` is the
 * superset glob that also catches the compound form; kept alongside the
 * original `.broken-*` for back-compat. `.zz-recover-*`, `.half-restored-*`,
 * and `.audit-wipe-*` are the other recovery-debris tags observed causing
 * unbounded disk growth (91% full on the `default` workspace, ~66G of dead
 * debris since early May) because nothing excluded OR reaped them.
 */
export const SELF_EXCLUSION_RULES = [
  'backups', '.restored', '.broken-*', '*.broken-*', '.rolled-back-*',
  '.zz-recover-*', '.half-restored-*', '.audit-wipe-*',
];

export const IGNORE_PATTERNS = [
  'node_modules', '.next', 'out', 'target', 'dist', 'build', '.turbo', '.cache',
  '.svelte-kit', '.nuxt', '.angular', '.vite', '.parcel-cache',
  '.yarn/cache', '.pnpm-store', '.bun',
  'coverage', '.nyc_output',
  '__pycache__', '*.pyc', '.venv', 'venv', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  '.gradle', '.terraform',
  // Transactional writers use a `.tmp` suffix until an artifact is complete.
  // Never snapshot one: a failed PG dump used to leave a ~1GB
  // `pg-embedded.sql.gz.tmp` behind on every cadence tick, and Kopia dutifully
  // versioned each incomplete file because only directories named `tmp` were
  // ignored.
  'tmp', '.tmp', '*.tmp', '*.swp', '*.swo', '.DS_Store', 'Thumbs.db',
  'proc-macro-srv*', '*.log',
  // Self-exclude — see the module comment above. Don't remove.
  ...SELF_EXCLUSION_RULES,
];

/**
 * Diff a kopia global-policy ignore list against the desired set.
 *
 * `kopia policy set --add-ignore` only ever appends — it never drops a
 * rule. To actually remove a rule (e.g. an excludedPath the user
 * deleted in the UI) the caller must pass `--remove-ignore`. This
 * returns both lists so applyGlobalPolicy can issue a single
 * `policy set` that converges the policy to exactly `desired`.
 *
 * `toAdd` is the full desired set: re-adding an existing rule is a
 * kopia no-op, so this keeps the apply idempotent and correct even
 * when the current policy couldn't be read.
 */
export function diffPolicyIgnores(
  current: string[],
  desired: string[],
): { toAdd: string[]; toRemove: string[] } {
  const desiredSet = new Set(desired);
  return {
    toAdd: desired,
    toRemove: current.filter((p) => !desiredSet.has(p)),
  };
}
