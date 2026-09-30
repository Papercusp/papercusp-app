/**
 * Migration drift detection (plan fleet-coordination-painpoints, Phase 2).
 *
 * The operator auto-applies pending `libs/papercusp/libs/db/sql/*.sql` to its
 * DB on boot (`instrumentation-node.ts` → `applyPendingMigrations`, tracked in
 * `harness_shared.schema_migrations`). But the `:3070` host has NO hot-reload,
 * so a migration ADDED after the last boot isn't applied until the next
 * restart — a silent gap where agents hit "missing column" at runtime.
 *
 * This is DETECTION ONLY (D-008): it compares the SQL dir against the tracker
 * and reports what's awaiting an apply. It never applies anything (embedded-pg
 * boot stays the source of truth). The file-selection MIRRORS the runner's
 * skip rules so templates / manual-only backfills aren't false-flagged — keep
 * in sync with `migration-runner.js`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { normalizeMigrationSql } from './migration-sql-normalize';
import {
  recoverAppliedMigrationText,
  type AppliedMigrationTextResult,
} from './migration-applied-text';

/** Mirror of migration-runner.js's skip(): per-harness template + MANUAL_ONLY. */
function isRunnerMigration(f: string): boolean {
  if (!f.endsWith('.sql')) return false;
  if (f.includes('per-harness-template')) return false;
  if (f === '040-plugin-configs-backfill.sql') return false; // psql -v only
  return true;
}

/**
 * EI-18737837917400418: a packaged/headless deploy (no repo tree above cwd —
 * e.g. a Tauri sidecar or a standalone rig install) has NO path satisfying any
 * of the repo-relative candidates below, so it MUST be resolvable via the
 * documented `PAPERCUSP_PG_SQL_DIR` env var alone. `apps/operator/bin/serve.ts`
 * (`defaultSqlDir()` callers) already honour that env var; this resolver used
 * to silently ignore it and try only repo-relative candidates — the boot-apply
 * safety net (EI-13992) then skipped every boot on such a deploy, unnoticed,
 * because the miss only logs a `console.warn`. Check the env var FIRST (it is
 * the explicit, authoritative override set by every headless launcher and by
 * `papercusp-desktop/src-tauri/src/main.rs`), then fall back to the
 * repo-relative candidates for a normal in-tree dev/CI run.
 */
export function resolveSqlDir(baseDir: string = process.cwd()): string | null {
  const envDir = process.env.PAPERCUSP_PG_SQL_DIR;
  if (envDir && fs.existsSync(envDir)) return envDir;
  const candidates = [
    path.resolve(baseDir, 'libs/papercusp/libs/db/sql'),
    path.resolve(baseDir, '../../libs/papercusp/libs/db/sql'),
    path.resolve(baseDir, '../../../libs/papercusp/libs/db/sql'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** The seeded replay visits the migration corpus in two phases. Keep its aggregate
 * Vitest deadline proportional to that corpus while each phase-2 statement still
 * has its own 15-second failure guard. A fixed five-minute test limit timed out
 * mid-replay on the 0.0.22-alpha source without reporting a failed migration. */
export function migrationReplayTestTimeoutMs(migrationCount: number): number {
  if (!Number.isSafeInteger(migrationCount) || migrationCount < 0) {
    throw new Error('migrationCount must be a non-negative safe integer');
  }
  return Math.max(300_000, migrationCount * 1_500);
}

/** The exact candidates {@link resolveSqlDir} tries, IN ORDER, for diagnostics —
 *  e.g. logging what was tried when resolution fails (EI-18737837917400418). */
export function sqlDirCandidates(baseDir: string = process.cwd()): string[] {
  const envDir = process.env.PAPERCUSP_PG_SQL_DIR;
  return [
    ...(envDir ? [`PAPERCUSP_PG_SQL_DIR=${envDir}`] : ['PAPERCUSP_PG_SQL_DIR=<unset>']),
    path.resolve(baseDir, 'libs/papercusp/libs/db/sql'),
    path.resolve(baseDir, '../../libs/papercusp/libs/db/sql'),
    path.resolve(baseDir, '../../../libs/papercusp/libs/db/sql'),
  ];
}

/** Path segments from a tree's root down to its migration sql dir — used both
 *  to resolve a dir (resolveSqlDir's candidates) and, in reverse, to recover a
 *  tree's root FROM an already-resolved sql dir (treeRootFromSqlDir). Keep the
 *  two in sync. */
const SQL_DIR_REL_SEGMENTS = ['libs', 'papercusp', 'libs', 'db', 'sql'];

/** Recover the containing tree's root from an on-disk sql dir found via
 *  resolveSqlDir() — the inverse of `path.resolve(baseDir, 'libs/papercusp/libs/db/sql')`.
 *  No git/env lookup needed: we already know the exact relative offset. */
function treeRootFromSqlDir(sqlDir: string): string {
  return path.resolve(sqlDir, ...SQL_DIR_REL_SEGMENTS.map(() => '..'));
}

/**
 * WI-6037: resolve the DEPLOYED (release checkout) tree's sql dir, independent
 * of which tree THIS process happens to be running from. `:3070` (green) and
 * `:3170` (staging) are sibling git worktrees under the same parent workspace
 * dir — the staging tree is legitimately AHEAD (new migration files land there
 * first, before a deploy). Comparing missing-on-disk migrations against the
 * DEPLOYED tree (rather than whichever tree is asking) distinguishes "normal
 * staging-ahead-of-release noise" (self-healing on the next deploy) from a
 * genuine unapplied migration in the tree actually serving the shared DB.
 *
 * Returns null when the deployed tree can't be resolved (no sibling
 * `papercup-release` checkout, e.g. a packaged install, CI, or a dev box with
 * no release checkout at all) — callers must treat null as "can't classify",
 * not as "nothing missing".
 */
export function resolveDeployedSqlDir(currentSqlDir: string | null): string | null {
  if (!currentSqlDir) return null;
  const treeRoot = treeRootFromSqlDir(currentSqlDir);
  const parent = path.dirname(treeRoot);
  const releaseRoot = process.env.PAPERCUSP_RELEASE_ROOT ?? path.join(parent, 'papercup-release');
  const releaseSqlDir = path.join(releaseRoot, ...SQL_DIR_REL_SEGMENTS);
  return fs.existsSync(releaseSqlDir) ? releaseSqlDir : null;
}

/**
 * EI-18757486483124756: the CANONICAL tree agents actually author migrations
 * in, independent of whichever tree THIS process happens to be serving from.
 * `PAPERCUSP_CANONICAL_TREE` is the explicit edit-tree path and takes
 * precedence; `PAPERCUSP_INTEGRATION_ROOT` remains the legacy fallback. A
 * staging serving mirror can therefore no longer hide a migration in the
 * canonical checkout from `db:migrations`, `db:check_drift`, or `db:migrate`.
 *
 * Distinct from `resolveDeployedSqlDir`: that one recovers a SIBLING
 * (`papercup-release`) of whatever tree is current, so when the CURRENT
 * process already IS the release checkout (the common case — the papercusp-su
 * MCP endpoint serves from :3070) it resolves to itself, a no-op that cannot
 * see the canonical tree at all. This resolves the canonical tree directly,
 * regardless of what "current" happens to be.
 */
export function resolveCanonicalStagingSqlDir(): string | null {
  const root = resolveCanonicalStagingRoot();
  if (!root) return null;
  const dir = path.resolve(root, ...SQL_DIR_REL_SEGMENTS);
  return fs.existsSync(dir) ? dir : null;
}

/**
 * EI-21413636618986324: the canonical staging tree's ROOT (the sibling of
 * {@link resolveCanonicalStagingSqlDir}, which returns its sql dir). Callers
 * that accept repo-root-relative paths (db:migrate) resolve them against THIS
 * root — never against `process.cwd()`, which on a serving process is whichever
 * checkout that worker happens to run from (`:3070` release vs `:3170` staging,
 * and a reuseport cluster can even answer two consecutive calls from workers
 * with different cwds — measured as dry-run ok then confirm ENOENT for the
 * SAME relative path). Null when neither `PAPERCUSP_CANONICAL_TREE` nor
 * `PAPERCUSP_INTEGRATION_ROOT` resolves to an existing directory — callers
 * must fall back to their legacy behavior, not throw.
 */
export function resolveCanonicalStagingRoot(): string | null {
  const configuredRoot =
    process.env.PAPERCUSP_CANONICAL_TREE?.trim() ||
    process.env.PAPERCUSP_INTEGRATION_ROOT?.trim();
  if (!configuredRoot) return null;
  const root = path.resolve(configuredRoot);
  return fs.existsSync(root) ? root : null;
}

/**
 * Pure classifier: split `missing` (on-disk, unapplied) into what's genuinely
 * unapplied at the DEPLOYED tree (`missingDeployed` — the real hazard) versus
 * merely not-yet-deployed noise (`missingPendingDeploy` — present here, absent
 * from the deployed tree, self-healing on the next deploy). `deployedOnDisk`
 * null means the deployed tree couldn't be resolved: fail TOWARD reporting
 * (treat every missing file as deployed/critical) rather than silently
 * suppressing a hazard we simply couldn't classify.
 */
export function classifyMissingByDeployedTree(
  missing: string[],
  deployedOnDisk: string[] | null,
): { missingDeployed: string[]; missingPendingDeploy: string[] } {
  if (deployedOnDisk === null) {
    return { missingDeployed: missing, missingPendingDeploy: [] };
  }
  const deployedSet = new Set(deployedOnDisk);
  return {
    missingDeployed: missing.filter((f) => deployedSet.has(f)),
    missingPendingDeploy: missing.filter((f) => !deployedSet.has(f)),
  };
}

export interface MigrationDrift {
  sqlDir: string | null;
  onDisk: string[];
  applied: string[];
  /** On disk + runner-eligible but NOT yet applied — awaiting an operator restart.
   *  This is the ACTIONABLE drift and the sole driver of `inSync`. */
  missing: string[];
  /** Recorded applied but the file is gone from disk. Almost always benign
   *  squashed/renamed-migration history (and the operator commonly runs from a
   *  release checkout that lags the canonical tree). INFORMATIONAL only — it does
   *  NOT flip `inSync` (infra round-3 F14: it used to, so in_sync was permanently
   *  false and masked real `missing` drift). Surface it for awareness; investigate
   *  only if a file you expected on disk is gone. */
  extra: string[];
  /** True when the live DB has applied every on-disk migration — i.e. `missing`
   *  is empty. NOT affected by `extra` (see above). */
  inSync: boolean;
  /** WI-5050 (WI-4070 class): applied migrations whose NUMERIC prefix is HIGHER
   *  than the max numbered migration this code tree ships — i.e. the shared DB
   *  was migrated by a NEWER code tree than the one running. Unlike `extra`
   *  (squashed-history noise), this is NOT benign: renames/drops the newer tree
   *  performed have already executed, so THIS tree's queries can hit
   *  `relation does not exist` at runtime (the VM dev-source rot that silently
   *  killed federation: post-mig-557 hives→pots DB vs pre-557 code). Empty when
   *  the code tree can't be resolved (unknown ≠ ahead). */
  schemaAhead: string[];
  /** WI-6037: the DEPLOYED (release checkout) tree's sql dir, resolved
   *  independent of which tree THIS process is running from. Null when it
   *  can't be resolved (no sibling `papercup-release` checkout). */
  deployedSqlDir: string | null;
  /** `missing` restricted to files that ALSO exist on disk in `deployedSqlDir`
   *  — i.e. genuinely unapplied at the tree actually serving the shared DB.
   *  Equal to the full `missing` when `deployedSqlDir` is null (fail toward
   *  reporting, never silently suppress an unclassifiable hazard). This is
   *  the field a CRITICAL alert should key on, not the raw `missing`. */
  missingDeployed: string[];
  /** `missing` minus `missingDeployed` — present on disk here, absent from the
   *  deployed tree: the NORMAL staging-ahead-of-release window. Always
   *  self-healing on the next deploy; never a runtime hazard on its own. */
  missingPendingDeploy: string[];
  /** EI-18757486483124756: the CANONICAL tree every agent authors migrations
   *  in (`PAPERCUSP_CANONICAL_TREE`, with legacy
   *  `PAPERCUSP_INTEGRATION_ROOT` fallback), resolved independently of the
   *  serving tree. Null when neither configured root resolves on this host. */
  canonicalStagingSqlDir: string | null;
  /** Runner-eligible files on disk in the canonical tree but NOT YET applied
   *  to the live DB — THE field a "did my just-written migration land"
   *  question should key on, regardless of which tree served this check. Empty
   *  (not "unknown") when `canonicalStagingSqlDir` is null: there is nothing
   *  to report from an unresolvable tree, same convention as `missing` itself. */
  missingCanonical: string[];
  /** EI-19365742982915607: applied migrations whose on-disk bytes no longer
   *  match the sha256 recorded when they ran — i.e. the file was edited AFTER
   *  it was applied, so the edit never executed and never will. NOT benign,
   *  and not self-healing: no restart or deploy re-runs an already-recorded
   *  migration. The repair is a NEW migration re-applying the intended state.
   *
   *  Deliberately does NOT flip `inSync`. `extra` was once wired that way and
   *  made in_sync permanently false, masking real `missing` drift (infra
   *  round-3 F14, see `extra` above) — and content drift has the same
   *  always-non-empty risk from historical comment-only edits. Surfaced as its
   *  own loud field instead, so it can never suppress the actionable signal.
   *
   *  EI-19408574209859155: every entry now carries a `classification` splitting
   *  a real half-landed migration from a provably-benign comment-only edit.
   *  Alert on `contentDriftExecutable`, not on this raw list.
   *
   *  WI-10002541: `null` = NOT MEASURED (the caller passed neither
   *  `checkContent` nor `classifyContent`). Never read null as "no drift". */
  contentDrift: ClassifiedMigrationContentDrift[] | null;
  /** EI-19408574209859155: the subset of `contentDrift` that is NOT proven
   *  benign — `executable` (real half-landed DDL) plus `unclassified` (the
   *  applied bytes could not be recovered, or the SQL could not be lexed).
   *
   *  THIS is the field an alert should key on, the same way `missingDeployed`
   *  rather than the raw `missing` is what the watchdog fires on. Note the
   *  deliberate asymmetry: `unclassified` counts as hazardous, because failing
   *  toward reporting drift is the only safe direction — misclassifying a real
   *  half-landed migration as benign silences exactly the signal the detector
   *  exists to carry. `null` exactly when `contentDrift` is (not measured). */
  contentDriftExecutable: ClassifiedMigrationContentDrift[] | null;
  /** The tree whose bytes `contentDrift` compared against — the canonical
   *  staging tree when resolvable (agents edit THERE, so drift shows up there
   *  first), else whichever tree served this call. Null when neither resolves,
   *  in which case `contentDrift` is empty for lack of anything to compare. */
  contentDriftSqlDir: string | null;
}

/**
 * EI-19365742982915607: an APPLIED migration whose bytes on disk no longer
 * match the sha256 recorded when it actually ran.
 *
 * This is the "half-landed migration" hazard, and it is silent by construction:
 * the runner records `sha256` at INSERT and NOTHING ever read it back, so
 * editing an already-applied file was a permanent no-op that left the file on
 * disk describing a live schema it does not have. Proven case: mig 708 ran at
 * 2026-08-01T19:15:49Z against a blob with zero `closed_ts`; the file gained a
 * PART 2 hunk 9 minutes later. PART 1 was live, PART 2 never executed, and
 * every reader who grepped the .sql concluded closed_ts federation shipped.
 *
 * Note the guard that could NOT catch this: the federated-column-completeness
 * suite applies sql/ to a FRESH testcontainer, so it validates the FILES and
 * passes green no matter how far the live DB has diverged from them.
 */
export interface MigrationContentDrift {
  filename: string;
  /** sha256 recorded in schema_migrations when the migration actually ran. */
  recordedSha256: string;
  /** sha256 of the file as it exists on disk now. */
  diskSha256: string;
}

/**
 * EI-19408574209859155: what a byte-level content-drift entry actually MEANS.
 *
 *  - `executable`     the SQL that would run differs — a genuine half-landed
 *                     migration (the mig-708 hazard). The edit never executed
 *                     and never will; the repair is a NEW migration.
 *  - `comments-only`  the executable SQL is identical; only comments and
 *                     whitespace differ. Benign — DB and file still correspond.
 *  - `unclassified`   the question could not be answered: the applied bytes
 *                     were unrecoverable, or one side could not be lexed with
 *                     confidence. Treated as hazardous, never as benign.
 */
export type ContentDriftClassification = 'executable' | 'comments-only' | 'unclassified';

export interface ClassifiedMigrationContentDrift extends MigrationContentDrift {
  classification: ContentDriftClassification;
  /** Human-readable justification — the commit the applied text was recovered
   *  from, or precisely why the verdict could not be reached. Always populated,
   *  so a reader never has to re-derive the classification by hand. */
  classificationDetail: string;
}

/**
 * Wall-clock ceiling on a whole classification pass. Measured 2026-08-03: 68
 * drifted files take ~13s, so this leaves headroom for today's corpus while
 * capping the worst case as it grows. Files not reached are `unclassified`,
 * i.e. still counted as hazardous.
 */
export const DEFAULT_CLASSIFY_BUDGET_MS = 20_000;

export interface ClassifyContentDriftOptions {
  /** Wall-clock ceiling for the whole pass (default {@link DEFAULT_CLASSIFY_BUDGET_MS}). */
  budgetMs?: number;
  /** Injectable clock, for testing the budget without sleeping. */
  now?: () => number;
}

/**
 * Pure classifier for byte-level content drift — exported for tests, with both
 * IO seams injected so it can be exercised without git or a filesystem.
 *
 * `readAppliedText` recovers the exact bytes that ran (see
 * migration-applied-text.ts — it walks git history for the blob whose sha256
 * matches what the runner recorded, because the applied TEXT is not stored in
 * the database, only its hash). `readDiskText` reads the file as it is now.
 *
 * Every path that cannot reach a confident "benign" verdict returns
 * `unclassified`, which callers count as hazardous. That asymmetry is the
 * whole safety property: reporting a benign edit as drift costs a moment of
 * attention, while reporting a half-landed migration as benign silences the
 * signal the detector exists to carry.
 */
export function classifyContentDrift(
  raw: ReadonlyArray<MigrationContentDrift>,
  readAppliedText: (d: MigrationContentDrift) => AppliedMigrationTextResult,
  readDiskText: (filename: string) => string | null,
  opts: ClassifyContentDriftOptions = {},
): ClassifiedMigrationContentDrift[] {
  const budgetMs = opts.budgetMs ?? DEFAULT_CLASSIFY_BUDGET_MS;
  const startedAt = opts.now?.() ?? Date.now();
  const now = () => opts.now?.() ?? Date.now();

  return raw.map((d): ClassifiedMigrationContentDrift => {
    const unclassified = (why: string): ClassifiedMigrationContentDrift => ({
      ...d,
      classification: 'unclassified',
      classificationDetail: why,
    });

    // The corpus only grows: 68 drifted files cost ~13s today, so an unbounded
    // walk becomes a real stall at 200. Past the budget, stop spending and mark
    // the rest unclassified — which counts as HAZARDOUS, so running out of time
    // can never make drift look benign.
    if (now() - startedAt > budgetMs) {
      return unclassified(
        `not classified — the ${budgetMs}ms classification budget was exhausted before reaching ` +
          `this file (${raw.length} drifted files); re-run with a larger budgetMs to classify it`,
      );
    }

    let applied: AppliedMigrationTextResult;
    try {
      applied = readAppliedText(d);
    } catch (err) {
      return unclassified(
        `applied text unrecoverable: ${(err as Error)?.message ?? 'unknown error'}`,
      );
    }
    if (!applied.ok) return unclassified(`applied text unrecoverable: ${applied.reason}`);

    let disk: string | null;
    try {
      disk = readDiskText(d.filename);
    } catch (err) {
      return unclassified(`on-disk text unreadable: ${(err as Error)?.message ?? 'unknown error'}`);
    }
    if (disk === null) return unclassified('on-disk text unreadable');

    const appliedNorm = normalizeMigrationSql(applied.text);
    if (!appliedNorm.ok) return unclassified(`applied SQL unparseable: ${appliedNorm.reason}`);
    const diskNorm = normalizeMigrationSql(disk);
    if (!diskNorm.ok) return unclassified(`on-disk SQL unparseable: ${diskNorm.reason}`);

    const at = applied.commit.slice(0, 12);
    if (appliedNorm.normalized === diskNorm.normalized) {
      return {
        ...d,
        classification: 'comments-only',
        classificationDetail:
          `executable SQL is identical to the applied blob (${at}); only comments/whitespace ` +
          `differ, so the live schema still matches this file`,
      };
    }
    return {
      ...d,
      classification: 'executable',
      classificationDetail:
        `executable SQL DIFFERS from the applied blob (${at}) — the edit never ran and never ` +
        `will; repair with a NEW migration re-applying the intended state`,
    };
  });
}

/** EI-19415309774723126: `000-baseline.sql` is FROZEN/GENERATED — regenerated
 *  wholesale by `pull-schema.mjs` from the live schema, so its on-disk bytes
 *  routinely diverge from whatever was recorded at apply time BY DESIGN. It is
 *  a known false-positive class for content-drift specifically (still a
 *  perfectly normal runner migration for `missing`/`extra`/`schemaAhead`
 *  purposes — only excluded from the byte-level drift comparison). */
const CONTENT_DRIFT_EXCLUDED_FILES = new Set(['000-baseline.sql']);

/**
 * Pure core of the content-drift detection — exported for tests.
 *
 * Skips, deliberately and each for a different reason:
 *  - non-runner files (templates / manual-only) — never applied by the runner;
 *  - `000-baseline.sql` — frozen/generated, diverges by design (see
 *    {@link CONTENT_DRIFT_EXCLUDED_FILES});
 *  - rows with no recorded sha256 — legacy rows predating the column; absence
 *    of evidence is not drift, so they are unjudgeable, not clean;
 *  - files absent from disk — that is exactly what `extra` reports; double
 *    reporting it here would just make both fields noisier.
 */
export function computeContentDrift(
  appliedRows: ReadonlyArray<{ filename: string; sha256: string | null }>,
  diskSha: ReadonlyMap<string, string>,
): MigrationContentDrift[] {
  const drifted: MigrationContentDrift[] = [];
  for (const row of appliedRows) {
    if (!isRunnerMigration(row.filename)) continue;
    if (CONTENT_DRIFT_EXCLUDED_FILES.has(row.filename)) continue;
    const recorded = row.sha256?.trim();
    if (!recorded) continue;
    const disk = diskSha.get(row.filename);
    if (disk === undefined) continue;
    if (disk !== recorded) {
      drifted.push({ filename: row.filename, recordedSha256: recorded, diskSha256: disk });
    }
  }
  return drifted.sort((a, b) => a.filename.localeCompare(b.filename));
}

/**
 * Hash the on-disk copy of each named migration the SAME way the runner does —
 * `createHash('sha256').update(<raw utf8 file text>)`
 * (embedded-postgres-server/src/migration-runner.js: it hashes `ddlRaw`, the
 * raw text, deliberately BEFORE stripping psql metacommands, so that changing
 * the stripper never re-applies files). Any divergence here would make every
 * file look drifted, so keep these two in lockstep. Unreadable files are
 * skipped rather than reported — see computeContentDrift's third skip.
 */
function hashMigrationsOnDisk(sqlDir: string | null, filenames: Iterable<string>): Map<string, string> {
  const hashes = new Map<string, string>();
  if (!sqlDir) return hashes;
  for (const f of filenames) {
    try {
      const text = fs.readFileSync(path.join(sqlDir, f), 'utf8');
      hashes.set(f, createHash('sha256').update(text).digest('hex'));
    } catch {
      // absent/unreadable → leave unset; `extra` owns the file-gone case.
    }
  }
  return hashes;
}

/** Numeric NNN prefix of a migration filename, or null (template/manual files). */
function migrationNumber(f: string): number | null {
  const m = /^(\d+)-/.exec(f);
  return m ? Number(m[1]) : null;
}

/**
 * Pure core of the WI-5050 schema-ahead-of-code detection — exported for tests.
 * Returns applied, runner-eligible migrations numbered beyond the max numbered
 * migration present on disk. Empty when onDisk has no numbered migrations
 * (an unresolvable/foreign tree must not flag the whole DB as "ahead").
 */
export function computeSchemaAhead(onDisk: string[], applied: string[]): string[] {
  const codeCap = Math.max(
    ...onDisk.map(migrationNumber).filter((n): n is number => n !== null),
    -1,
  );
  if (codeCap < 0) return [];
  return applied.filter((f) => {
    if (!isRunnerMigration(f)) return false;
    const n = migrationNumber(f);
    return n !== null && n > codeCap;
  });
}

export interface CheckMigrationDriftOptions {
  /**
   * Classify each content-drift entry as `executable` / `comments-only`
   * (EI-19408574209859155). DEFAULT FALSE, and deliberately so: classification
   * recovers the applied bytes from git history, which costs one `git log` plus
   * up to N `git show` invocations PER drifted file.
   *
   * That is not a theoretical cost. Measured on this tree 2026-08-03: 68 files
   * carry byte-level drift (a long-lived dev DB accumulates them), and
   * classifying all of them takes **8.5–10s**. `checkMigrationDrift` is called
   * from boot, system-health and the watchdog — none of which read
   * `contentDrift` at all — so making them pay that would be a pure regression.
   *
   * When false, every entry is reported with `classification: 'unclassified'`
   * and a detail saying so. That is honest rather than optimistic: an
   * unclassified entry counts as hazardous in `contentDriftExecutable`, so
   * skipping the work can never make drift look benign.
   *
   * `db:check_drift` — the diagnostic surface where an agent is actually asking
   * the question — passes true. Implies {@link checkContent}.
   */
  classifyContent?: boolean;
  /**
   * Compute raw content drift at all: read and sha256 every APPLIED migration
   * on disk and compare against the hash recorded when it ran. DEFAULT FALSE
   * (WI-10002541), for the same reason as `classifyContent`, one level down:
   * the hashing itself is a synchronous read + sha256 of ~1,000 files (4.8MB)
   * on the calling thread, ~37ms per call on the tower and ~150ms in a rig-VM
   * CPU profile, paid on every boot/system-health tick by callers that never
   * read `contentDrift`. When false, `contentDrift` and
   * `contentDriftExecutable` are `null` (NOT MEASURED), never an empty list,
   * so an unmeasured result cannot read as "no drift".
   */
  checkContent?: boolean;
}

export async function checkMigrationDrift(
  opts: CheckMigrationDriftOptions = {},
): Promise<MigrationDrift> {
  const sqlDir = resolveSqlDir();
  const onDisk = sqlDir
    ? fs.readdirSync(sqlDir).filter(isRunnerMigration).sort()
    : [];

  let applied: string[] = [];
  let appliedRows: Array<{ filename: string; sha256: string | null }> = [];
  try {
    const { sql } = getOrgPg();
    // `sha256` rides along for the content-drift check — it is recorded on every
    // apply but was never read back until EI-19365742982915607.
    appliedRows = await sql<Array<{ filename: string; sha256: string | null }>>`
      SELECT filename, sha256 FROM harness_shared.schema_migrations ORDER BY filename
    `;
    applied = appliedRows.map((r) => r.filename);
  } catch {
    // tracker absent / unreachable → report all on-disk as missing (loud, not silent).
  }

  const appliedSet = new Set(applied);
  const onDiskSet = new Set(onDisk);
  const missing = onDisk.filter((f) => !appliedSet.has(f));
  // Only count runner-eligible files as "extra" — ignore applied rows for
  // templates/manual files that were never runner-eligible on disk.
  const extra = applied.filter((f) => !onDiskSet.has(f) && isRunnerMigration(f));

  const deployedSqlDir = resolveDeployedSqlDir(sqlDir);
  let deployedOnDisk: string[] | null = null;
  if (deployedSqlDir) {
    try {
      deployedOnDisk = fs.readdirSync(deployedSqlDir).filter(isRunnerMigration);
    } catch {
      deployedOnDisk = null; // unreadable → fail toward reporting, same as unresolved
    }
  }
  const { missingDeployed, missingPendingDeploy } = classifyMissingByDeployedTree(
    missing,
    deployedOnDisk,
  );

  // EI-18757486483124756: independent of everything above (which is all
  // relative to whichever tree THIS process happens to be running from), scan
  // the CANONICAL tree agents actually author migrations in. When the
  // canonical tree IS the current tree (a dev box running from staging) this
  // duplicates `missing` harmlessly; when current is the release checkout
  // (the papercusp-su MCP endpoint's normal case) this is the only leg that
  // can see a just-authored, not-yet-deployed migration at all.
  const canonicalStagingSqlDir = resolveCanonicalStagingSqlDir();
  const missingCanonical = canonicalStagingSqlDir
    ? fs
        .readdirSync(canonicalStagingSqlDir)
        .filter(isRunnerMigration)
        .filter((f) => !appliedSet.has(f))
        .sort()
    : [];

  // EI-19365742982915607: compare the bytes of every APPLIED migration against
  // the sha256 recorded when it ran. Prefer the canonical staging tree — that
  // is where agents edit, so an edit-after-apply is observable there first (and
  // often ONLY there, until the next deploy carries it into the release tree).
  const contentDriftSqlDir = canonicalStagingSqlDir ?? sqlDir;
  // WI-10002541: opt-in. Only `db:check_drift` reads content drift; boot reads
  // `schemaAhead` and system-health reads `missing`, and they were paying a
  // synchronous full re-hash of every applied migration on each call.
  const checkContent = opts.checkContent === true || opts.classifyContent === true;
  const rawContentDrift = checkContent
    ? computeContentDrift(
        appliedRows,
        hashMigrationsOnDisk(
          contentDriftSqlDir,
          appliedRows.map((r) => r.filename).filter(isRunnerMigration),
        ),
      )
    : null;

  // EI-19408574209859155: a byte difference is not yet a verdict. Recover the
  // bytes that ACTUALLY ran (from git — the DB stores only their hash) and
  // compare executable content, so a provably-benign comment-only edit stops
  // being indistinguishable from a real half-landed migration.
  //
  // Opt-in: see CheckMigrationDriftOptions.classifyContent for why the default
  // is off (measured 8.5–10s on this tree, in a function boot/system-health/the
  // watchdog all call without ever reading this field).
  const contentDrift = rawContentDrift === null
    ? null
    : opts.classifyContent
    ? classifyContentDrift(
        rawContentDrift,
        (d) =>
          contentDriftSqlDir
            ? recoverAppliedMigrationText(contentDriftSqlDir, d.filename, d.recordedSha256)
            : { ok: false, reason: 'no sql dir resolved to search history in' },
        (filename) => {
          if (!contentDriftSqlDir) return null;
          try {
            return fs.readFileSync(path.join(contentDriftSqlDir, filename), 'utf8');
          } catch {
            return null;
          }
        },
      )
    : rawContentDrift.map((d) => ({
        ...d,
        classification: 'unclassified' as const,
        classificationDetail:
          'not classified — this caller did not request classification (pass classifyContent:true, ' +
          'or use db:check_drift, to separate a half-landed migration from a comment-only edit)',
      }));
  const contentDriftExecutable =
    contentDrift === null ? null : contentDrift.filter((d) => d.classification !== 'comments-only');

  return {
    sqlDir,
    onDisk,
    applied,
    missing,
    extra,
    // ACTIONABLE drift: a non-empty `missing` means the live DB lags the
    // on-disk migrations of whichever tree served this check (restart /
    // db:migrate to apply). `extra` is benign squashed-history noise and must
    // NOT flip this false — doing so made in_sync permanently false on this
    // fleet, masking real `missing` drift (infra round-3 F14). ALSO gated on
    // `missingCanonical` (EI-18757486483124756): `in_sync: true` must not be
    // reachable while an unapplied migration sits in the tree every agent
    // edits, even when the tree that served THIS check (often the release
    // checkout) happens to already match its own on-disk set.
    inSync: missing.length === 0 && missingCanonical.length === 0,
    schemaAhead: computeSchemaAhead(onDisk, applied),
    deployedSqlDir,
    missingDeployed,
    missingPendingDeploy,
    canonicalStagingSqlDir,
    missingCanonical,
    contentDrift,
    contentDriftExecutable,
    contentDriftSqlDir,
  };
}
