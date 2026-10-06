/**
 * restart-preflight — "would this host actually BOOT?", asked BEFORE we kill it.
 *
 * EI-18661647550414959. `dev:restart` used to be a pure coordination primitive: it
 * drained, killed and restarted, and the first thing that ever asked whether the
 * target could boot was the target itself, from inside its own boot — i.e. after the
 * running process was already gone. On 2026-07-25 that turned a latent node_modules
 * divergence (pruned hours earlier by an unrelated `npm install`) into a fleet-wide
 * routines/git-sync outage: the restart returned `{ok:true, restarted:true}` and the
 * service then crash-looped 5x on `[boot-integrity] FATAL` (exit 78).
 *
 * The asymmetry that makes this worth a preflight: BEFORE the restart the check is
 * free and the host is still up; AFTER, the host is gone and recovery needs a
 * human-equivalent diagnosis. Worse, the failure is LATENT — it lands on whatever
 * unrelated change the next restart happened to be carrying, and gets misattributed
 * to it.
 *
 * WHY A SEPARATE MODULE (the same reasoning as `restart-target-units.ts`): the
 * obvious home is `systemd-service-probe.ts`, but `restart.test.ts` does a
 * NON-spreading `vi.mock('./systemd-service-probe', ...)`, which silently blanks
 * anything parked there. Living here keeps this injectable and mockable on its own
 * terms.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, resolve } from 'node:path';

import { preflightTreeAt, type TreeIntegrityResult } from '../../boot-integrity-preflight';
import { RESTART_TARGET_UNITS, type RestartTargetName } from './restart-target-units';

let run: ((...args: any[]) => Promise<any>) | undefined;
const execFileP = (...args: any[]) => (run ??= promisify(execFile) as any)(...args);

/** Reads one systemd unit property. Injectable so tests never shell out. */
export type UnitPropertyReader = (unit: string, property: string) => Promise<string>;

const defaultReadUnitProperty: UnitPropertyReader = async (unit, property) => {
  const { stdout } = await execFileP('systemctl', ['--user', 'show', unit, '-p', property, '--value'], { timeout: 3000 });
  return stdout.trim();
};

export interface RestartPreflightResult extends TreeIntegrityResult {
  target: RestartTargetName;
  unit: string;
}

const STAGING_MIGRATION_RESULT_PREFIX = '__PAPERCUSP_STAGING_MIGRATION_RESULT__';
const STAGING_MIGRATION_TIMEOUT_MS = 300_000;

export interface StagingSchemaPreparationResult {
  ok: boolean;
  integrationRoot: string | null;
  sqlDir: string | null;
  applied: number;
  failed: { file: string; error: string }[];
  reason?: string;
  note: string;
}

export interface StagingSchemaCommandOptions {
  cwd: string;
  timeout: number;
  maxBuffer: number;
  env: NodeJS.ProcessEnv;
}

export type StagingSchemaCommandRunner = (
  command: string,
  args: string[],
  options: StagingSchemaCommandOptions,
) => Promise<{ stdout: string; stderr?: string }>;

const defaultStagingSchemaCommandRunner: StagingSchemaCommandRunner = async (command, args, options) =>
  execFileP(command, args, options);

function systemdEnvironmentValue(environment: string, name: string): string | null {
  const match = new RegExp('(?:^|\\s)' + name + '=(?:"([^"]*)"|\\x27([^\\x27]*)\\x27|([^\\s]+))').exec(
    environment,
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function integrationRootFromUnit(environment: string, workingDirectory: string): string | null {
  const configured = systemdEnvironmentValue(environment, 'PAPERCUSP_INTEGRATION_ROOT');
  const configuredRoot = configured && isAbsolute(configured) ? resolve(configured) : null;
  const normalizedWorkingDirectory = workingDirectory.trim().replace(/\/+$/, '');
  const workingRoot =
    isAbsolute(normalizedWorkingDirectory) && normalizedWorkingDirectory.endsWith('/apps/operator')
      ? resolve(normalizedWorkingDirectory, '..', '..')
      : null;
  if (configuredRoot && workingRoot && configuredRoot !== workingRoot) return null;
  return configuredRoot ?? workingRoot;
}

function migrationResultFromOutput(
  stdout: string,
): { applied: number; failed: { file: string; error: string }[] } | null {
  const line = stdout
    .split('\n')
    .reverse()
    .find((candidate) => candidate.startsWith(STAGING_MIGRATION_RESULT_PREFIX));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line.slice(STAGING_MIGRATION_RESULT_PREFIX.length)) as {
      applied?: unknown;
      failed?: unknown;
    };
    if (
      !Number.isSafeInteger(parsed.applied) ||
      !Array.isArray(parsed.failed) ||
      !parsed.failed.every(
        (row) =>
          typeof row === 'object' &&
          row !== null &&
          typeof (row as { file?: unknown }).file === 'string' &&
          typeof (row as { error?: unknown }).error === 'string',
      )
    ) {
      return null;
    }
    return { applied: parsed.applied as number, failed: parsed.failed as { file: string; error: string }[] };
  } catch {
    return null;
  }
}

/**
 * Apply the staging unit's pinned migration tree while its listener is still
 * serving. The same guarded runner used by staging-sync is loaded from that
 * exact target tree, and flock holds the shared checkout lease while it reads
 * SQL files. A missing/mismatched target root, lock conflict, or failed
 * migration is a refusal before dev:restart drains or stops the service.
 */
export async function prepareStagingSchemaForRestart(
  lockPath: string,
  opts?: {
    readUnitProperty?: UnitPropertyReader;
    runCommand?: StagingSchemaCommandRunner;
  },
): Promise<StagingSchemaPreparationResult> {
  const unit = RESTART_TARGET_UNITS.staging;
  const readUnitProperty = opts?.readUnitProperty ?? defaultReadUnitProperty;
  const runCommand = opts?.runCommand ?? defaultStagingSchemaCommandRunner;
  const fail = (
    reason: string,
    note: string,
    integrationRoot: string | null = null,
    sqlDir: string | null = null,
    applied = 0,
    failed: { file: string; error: string }[] = [],
  ): StagingSchemaPreparationResult => ({ ok: false, integrationRoot, sqlDir, applied, failed, reason, note });

  if (!lockPath.trim()) {
    return fail('staging_sync_lock_unknown', 'The staging-sync checkout lock path could not be resolved.');
  }

  let environment: string;
  let workingDirectory: string;
  try {
    [environment, workingDirectory] = await Promise.all([
      readUnitProperty(unit, 'Environment'),
      readUnitProperty(unit, 'WorkingDirectory'),
    ]);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    return fail('staging_target_root_unreadable', 'Could not read the staging unit migration settings: ' + detail);
  }

  const integrationRoot = integrationRootFromUnit(environment, workingDirectory);
  if (!integrationRoot) {
    return fail(
      'staging_target_root_unknown',
      'The staging unit Environment and WorkingDirectory do not identify one exact integration tree.',
    );
  }

  const configuredSqlDir = systemdEnvironmentValue(environment, 'PAPERCUSP_PG_SQL_DIR');
  const sqlDir = configuredSqlDir
    ? isAbsolute(configuredSqlDir)
      ? resolve(configuredSqlDir)
      : resolve(workingDirectory.trim(), configuredSqlDir)
    : resolve(integrationRoot, 'libs/papercusp/libs/db/sql');
  const script = [
    "import { applyPendingMigrationsNow } from './packages/operator-core/lib/db-boot-migrate.ts';",
    'const result = await applyPendingMigrationsNow({ sqlDir: ' + JSON.stringify(sqlDir) + ', broadcast: false });',
    "console.log('" + STAGING_MIGRATION_RESULT_PREFIX + "' + JSON.stringify(result));",
    'if (!result || result.failed.length > 0) process.exitCode = 1;',
  ].join('\n');
  const args = [
    '--shared',
    '--nonblock',
    '--conflict-exit-code',
    '75',
    lockPath,
    'node',
    '--import',
    'tsx',
    '--input-type=module',
    '--eval',
    script,
  ];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PAPERCUSP_INTEGRATION_ROOT: integrationRoot,
    PAPERCUSP_PG_SQL_DIR: sqlDir,
    TSX_TSCONFIG_PATH: resolve(integrationRoot, 'apps/operator/tsconfig.json'),
  };

  try {
    const { stdout } = await runCommand('/usr/bin/flock', args, {
      cwd: integrationRoot,
      timeout: STAGING_MIGRATION_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      env,
    });
    const result = migrationResultFromOutput(stdout);
    if (!result) {
      return fail(
        'staging_migration_result_missing',
        'The guarded staging migration runner returned no parseable result; the service was left running.',
        integrationRoot,
        sqlDir,
      );
    }
    if (result.failed.length > 0) {
      return fail(
        'staging_migration_failed',
        'The guarded staging migration runner left failed migrations pending; the service was left running.',
        integrationRoot,
        sqlDir,
        result.applied,
        result.failed,
      );
    }
    return {
      ok: true,
      integrationRoot,
      sqlDir,
      applied: result.applied,
      failed: [],
      note: 'The staging target schema is prepared while the current API remains serving.',
    };
  } catch (error) {
    const record = error as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown };
    const result = migrationResultFromOutput(typeof record.stdout === 'string' ? record.stdout : '');
    const detail =
      typeof record.stderr === 'string' && record.stderr.trim()
        ? record.stderr.trim().slice(-1200)
        : typeof record.message === 'string'
          ? record.message.split('\n')[0]
          : String(error);
    if (record.code === 75) {
      return fail(
        'staging_sync_collision',
        'Staging-sync holds its exclusive checkout lock; no migration or restart was attempted.',
        integrationRoot,
        sqlDir,
      );
    }
    return fail(
      'staging_migration_preparation_failed',
      'The guarded staging migration runner failed; the service was left running: ' + detail,
      integrationRoot,
      sqlDir,
      result?.applied ?? 0,
      result?.failed ?? [],
    );
  }
}

/**
 * Resolve a restart target's tree from systemd and preflight it.
 *
 * ⚠ `systemctl --user show <unknown-unit>` EXITS 0 and prints an EMPTY value rather
 * than failing (documented at release-checkpoint-launch.ts:257 and re-verified here).
 * So an empty/unreadable WorkingDirectory MUST read as NOT CHECKED, never as clean —
 * otherwise a typo'd or renamed unit would silently disable this guard while still
 * reporting `ok:true`.
 *
 * Fails OPEN throughout: any probe failure proceeds with `checked:false` and says so.
 * A guard that cannot run must never be the reason a wedged host stays wedged.
 */
export async function preflightRestartTarget(
  target: RestartTargetName,
  opts?: {
    readUnitProperty?: UnitPropertyReader;
    preflight?: typeof preflightTreeAt;
  },
): Promise<RestartPreflightResult> {
  const unit = RESTART_TARGET_UNITS[target];
  const readUnitProperty = opts?.readUnitProperty ?? defaultReadUnitProperty;
  const preflight = opts?.preflight ?? preflightTreeAt;

  let workingDir = '';
  let probeError: string | undefined;
  try {
    workingDir = await readUnitProperty(unit, 'WorkingDirectory');
  } catch (e) {
    probeError = e instanceof Error ? e.message.split('\n')[0] : String(e);
  }

  // systemd renders an unset WorkingDirectory as '' and, on some versions, as the
  // literal '[not set]'. Both mean "we do not know this unit's tree".
  if (!workingDir || workingDir === '[not set]') {
    const reason = probeError
      ? `could not read ${unit} WorkingDirectory (${probeError})`
      : `${unit} reports no WorkingDirectory (an unknown unit also exits 0 with an empty value)`;
    return {
      target,
      unit,
      checked: false,
      ok: true,
      requestedRoot: '',
      lockRoot: null,
      missing: [],
      extraneous: [],
      reason,
      note: `[boot-integrity] NOT CHECKED (${reason}) — proceeding without a verdict. This is not a clean bill of health.`,
    };
  }

  return { target, unit, ...preflight({ rootDir: workingDir }) };
}
