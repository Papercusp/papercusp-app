/**
 * Guard the deliberate `PENDING-CODE-DEPLOY` migration workflow.
 *
 * A parked migration is intentionally invisible to the runner until someone
 * arms it.  Before this guard, arming was only a filename rename: a migration
 * could reach the shared DB while the release checkout still served the old
 * writer it was meant to replace.  Keep the coupling in the migration body so
 * it survives the rename, then verify the required literal against the
 * deployed checkout's `HEAD` before the boot/manual appliers run it.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RequiredDeployedMarker {
  sourcePath: string;
  marker: string;
}

export interface MigrationDeployGuardResult {
  ok: boolean;
  filename: string;
  required?: RequiredDeployedMarker;
  releaseRoot?: string;
  deployedSha?: string;
  error?: string;
}

/** The body marker remains present after a parked file is renamed to `.sql`. */
const PENDING_CODE_DEPLOY_RE = /^[ \t]*--[ \t]*PENDING-CODE-DEPLOY\b/im;

/**
 * `path#literal` keeps the source path machine-readable while allowing the
 * marker itself to contain spaces and punctuation.
 */
const REQUIRED_DEPLOYED_RE = /^[ \t]*--[ \t]*REQUIRES-DEPLOYED:[ \t]*([^\s#]+)#(.+?)[ \t]*$/im;

export function isPendingCodeDeployMigration(sqlText: string): boolean {
  return PENDING_CODE_DEPLOY_RE.test(sqlText);
}

export function parseRequiredDeployedMarker(sqlText: string): RequiredDeployedMarker | null {
  const match = REQUIRED_DEPLOYED_RE.exec(sqlText);
  if (!match) return null;
  const sourcePath = match[1]?.trim() ?? '';
  const marker = match[2]?.trim() ?? '';
  // A marker must name a repository-relative source file.  Refuse traversal
  // rather than allowing a migration comment to make the guard read arbitrary
  // files from the release host.
  if (!sourcePath || !marker || sourcePath.startsWith('/') || sourcePath.split('/').includes('..')) return null;
  return { sourcePath, marker };
}

/**
 * Pure decision over migration text and the source text from the deployed
 * checkout.  Keeping this separate makes the fail-closed contract easy to
 * test without requiring a live PG or release tree.
 */
export function evaluatePendingCodeDeployMigration(args: {
  filename: string;
  sqlText: string;
  deployedSourceText?: string | null;
  releaseRoot?: string;
  deployedSha?: string | null;
}): MigrationDeployGuardResult {
  const { filename, sqlText } = args;
  if (!isPendingCodeDeployMigration(sqlText)) return { ok: true, filename };

  const required = parseRequiredDeployedMarker(sqlText);
  if (!required) {
    return {
      ok: false,
      filename,
      error:
        `${filename} is marked PENDING-CODE-DEPLOY but has no valid ` +
        '`REQUIRES-DEPLOYED: path#marker` line; refusing to apply it',
    };
  }
  if (!args.releaseRoot) {
    return {
      ok: false,
      filename,
      required,
      error:
        `${filename} requires deployed source ${required.sourcePath}#${required.marker}, ` +
        'but no release checkout is configured; refusing to apply it',
    };
  }
  if (args.deployedSourceText == null) {
    return {
      ok: false,
      filename,
      required,
      releaseRoot: args.releaseRoot,
      deployedSha: args.deployedSha ?? undefined,
      error:
        `${filename} requires deployed source ${required.sourcePath}#${required.marker}, ` +
        `but HEAD of ${args.releaseRoot} could not be read; refusing to apply it`,
    };
  }
  if (!args.deployedSourceText.includes(required.marker)) {
    return {
      ok: false,
      filename,
      required,
      releaseRoot: args.releaseRoot,
      deployedSha: args.deployedSha ?? undefined,
      error:
        `${filename} requires deployed source ${required.sourcePath}#${required.marker}, ` +
        `but deployed ${args.deployedSha ? `HEAD ${args.deployedSha.slice(0, 12)}` : 'HEAD'} ` +
        'does not contain that marker; deploy the companion code before applying it',
    };
  }
  return {
    ok: true,
    filename,
    required,
    releaseRoot: args.releaseRoot,
    deployedSha: args.deployedSha ?? undefined,
  };
}

type GitRead = (releaseRoot: string, sourcePath: string, deployedRef?: string) => string | null;
type GitHead = (releaseRoot: string, deployedRef?: string) => string | null;

const readAtHead: GitRead = (releaseRoot, sourcePath, deployedRef = 'HEAD') => {
  try {
    return execFileSync('git', ['-C', releaseRoot, 'show', `${deployedRef}:${sourcePath}`], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
};

const resolveHead: GitHead = (releaseRoot, deployedRef = 'HEAD') => {
  try {
    return execFileSync('git', ['-C', releaseRoot, 'rev-parse', deployedRef], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
};

/**
 * Verify one migration against the release checkout.  The injectable git
 * readers are for deterministic unit tests; production always reads `HEAD`
 * through git, never a potentially dirty working-tree file.
 */
export function verifyPendingCodeDeployMigration(args: {
  filename: string;
  sqlText: string;
  releaseRoot?: string | null;
  /**
   * Revision the live process is actually serving. Omit outside the deploy
   * transaction to inspect HEAD; pass null when serving identity is unknown so
   * the guard fails closed instead of mistaking a pre-cutover target checkout
   * for deployed code.
   */
  deployedRef?: string | null;
  readAtHead?: GitRead;
  resolveHead?: GitHead;
}): MigrationDeployGuardResult {
  const required = parseRequiredDeployedMarker(args.sqlText);
  if (!isPendingCodeDeployMigration(args.sqlText)) return { ok: true, filename: args.filename };
  if (!required) return evaluatePendingCodeDeployMigration({ filename: args.filename, sqlText: args.sqlText });
  const releaseRoot = args.releaseRoot?.trim() || undefined;
  const deployedRefWasProvided = Object.prototype.hasOwnProperty.call(args, 'deployedRef');
  const deployedRef = deployedRefWasProvided ? args.deployedRef?.trim() || null : 'HEAD';
  const deployedSha = releaseRoot && deployedRef ? (args.resolveHead ?? resolveHead)(releaseRoot, deployedRef) : null;
  const deployedSourceText =
    releaseRoot && deployedSha && deployedRef
      ? (args.readAtHead ?? readAtHead)(releaseRoot, required.sourcePath, deployedRef)
      : null;
  return evaluatePendingCodeDeployMigration({
    filename: args.filename,
    sqlText: args.sqlText,
    releaseRoot,
    deployedSha,
    deployedSourceText,
  });
}

const SQL_DIR_REL = ['libs', 'papercusp', 'libs', 'db', 'sql'];

function treeRootFromSqlDir(sqlDir: string): string {
  return path.resolve(sqlDir, ...SQL_DIR_REL.map(() => '..'));
}

/**
 * Resolve the actual release sibling even when this process is the isolated
 * staging host and its ambient `PAPERCUSP_RELEASE_ROOT` points at staging.
 */
export function resolveDeployedReleaseRoot(sqlDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const currentRoot = treeRootFromSqlDir(sqlDir);
  const integrationRoot = env.PAPERCUSP_INTEGRATION_ROOT?.trim();
  if (integrationRoot) {
    const canonicalRelease = path.join(
      path.dirname(path.resolve(integrationRoot)),
      `${path.basename(path.resolve(integrationRoot))}-release`,
    );
    if (path.resolve(canonicalRelease) !== currentRoot) return canonicalRelease;
  }
  const explicit = env.PAPERCUSP_RELEASE_ROOT?.trim();
  if (explicit) {
    const explicitRoot = path.resolve(explicit);
    const explicitBase = path.basename(explicitRoot);
    if (explicitBase.endsWith('-staging')) {
      return path.join(path.dirname(explicitRoot), `${explicitBase.replace(/-staging$/, '')}-release`);
    }
    return explicitRoot;
  }
  const currentBase = path.basename(currentRoot);
  // A release-host process may have no explicit env overlay. In that case its
  // own tree is already the deployed checkout; do not invent a
  // `*-release-release` sibling and block every guarded migration forever.
  if (currentBase.endsWith('-release')) return currentRoot;
  return path.join(path.dirname(currentRoot), `${currentBase.replace(/-staging$/, '')}-release`);
}

/** Read and verify all armed, marked pending-code-deploy migrations. */
export function pendingCodeDeployFailures(args: {
  sqlDir: string;
  releaseRoot?: string | null;
  readFile?: (file: string) => string;
  readdir?: (dir: string) => string[];
  verify?: typeof verifyPendingCodeDeployMigration;
}): Array<{ file: string; error: string }> {
  const readFile = args.readFile ?? ((file: string) => fs.readFileSync(file, 'utf8'));
  const readdir = args.readdir ?? ((dir: string) => fs.readdirSync(dir));
  const verify = args.verify ?? verifyPendingCodeDeployMigration;
  const failures: Array<{ file: string; error: string }> = [];
  for (const file of readdir(args.sqlDir).filter((f) => f.endsWith('.sql')).sort()) {
    const fullPath = path.join(args.sqlDir, file);
    let sqlText: string;
    try {
      sqlText = readFile(fullPath);
    } catch {
      continue;
    }
    if (!isPendingCodeDeployMigration(sqlText)) continue;
    const result = verify({ filename: file, sqlText, releaseRoot: args.releaseRoot });
    if (!result.ok) failures.push({ file, error: result.error ?? `${file} failed the deployed-code guard` });
  }
  return failures;
}
