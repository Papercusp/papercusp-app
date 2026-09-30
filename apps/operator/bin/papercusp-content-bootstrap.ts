#!/usr/bin/env node
/**
 * Install the workspace-host's first-party content before the operator and its
 * embedded Postgres exist. Distribution still goes through the existing
 * Cupboard bundle installer; this executable merely pins the official bundle,
 * the persistent machine-local home, and the pre-PG rubric-seed policy.
 */
import { constants as fsConstants, promises as fs } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type {
  InstallBundleAppOutcome,
  InstallBundleAppOptions,
} from '@papercusp/operator-core/lib/cupboard/bundle-app-install-io';
import { installBundleAppFromCupboard as installOfflineContentBundleAppFromCupboard } from '@papercusp/operator-core/lib/cupboard/offline-content-bundle-install-io';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

export const WORKSPACE_HOST_CONTENT_BUNDLE = Object.freeze({
  githubUrl: 'https://github.com/Papercusp/templates',
  listingRef: 'bundles/workspace-host',
});

export interface ContentBootstrapDeps {
  installBundle?: (
    input: typeof WORKSPACE_HOST_CONTENT_BUNDLE,
    opts: InstallBundleAppOptions,
  ) => Promise<InstallBundleAppOutcome>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

const USAGE = 'Usage: papercusp-content-bootstrap --state-root <absolute-directory>';

function restoreEnv(prior: Map<string, string | undefined>): void {
  for (const [key, value] of prior) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** Run the CLI with injectable install/output seams; returns its process code. */
export async function runContentBootstrap(
  argv = process.argv.slice(2),
  deps: ContentBootstrapDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  if (argv.includes('--help') || argv.includes('-h')) {
    stdout(USAGE);
    return 0;
  }

  let stateRoot = '';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== '--state-root' || index + 1 >= argv.length || stateRoot) {
      stderr(`${USAGE}\npapercusp-content-bootstrap: invalid arguments`);
      return 2;
    }
    stateRoot = argv[index + 1] ?? '';
    index += 1;
  }
  if (!stateRoot || !isAbsolute(stateRoot)) {
    stderr(`${USAGE}\npapercusp-content-bootstrap: --state-root must be absolute`);
    return 2;
  }
  stateRoot = resolve(stateRoot);
  try {
    const stat = await fs.stat(stateRoot);
    if (!stat.isDirectory()) throw new Error('not a directory');
    await fs.access(stateRoot, fsConstants.W_OK);
  } catch (error) {
    stderr(
      `papercusp-content-bootstrap: state root is not an existing writable directory: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 2;
  }

  const contentHome = join(stateRoot, '.papercusp');
  await fs.mkdir(contentHome, { recursive: true, mode: 0o700 });
  const contentEnv = new Map<string, string>([
    ['PAPERCUSP_HOME', contentHome],
    ['PAPERCUSP_PROMPTS_DIR', join(contentHome, 'blueprints', 'base', 'prompts')],
    ['PAPERCUSP_TEMPLATES_DIR', join(contentHome, 'templates')],
    ['PAPERCUSP_RUBRICS_DIR', join(contentHome, 'rubrics')],
  ]);
  const prior = new Map([...contentEnv.keys()].map((key) => [key, process.env[key]]));
  for (const [key, value] of contentEnv) process.env[key] = value;

  let outcome: InstallBundleAppOutcome;
  try {
    const installBundle =
      deps.installBundle ??
      installOfflineContentBundleAppFromCupboard;
    outcome = await installBundle(
      WORKSPACE_HOST_CONTENT_BUNDLE,
      {
        workspaceId: process.env.PAPERCUSP_WORKSPACE?.trim() || 'workspace-host',
        offlineContentOnly: true,
        deferRubricSeed: true,
      },
    );
  } catch (error) {
    stderr(`papercusp-content-bootstrap: install threw: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    restoreEnv(prior);
  }

  if (!outcome.ok) {
    stderr(
      `papercusp-content-bootstrap: ${outcome.error}${outcome.detail ? `: ${outcome.detail}` : ''}`,
    );
    return 1;
  }
  if (!outcome.result.ok) {
    stderr(
      `papercusp-content-bootstrap: content bundle incomplete: ${JSON.stringify({
        conflicts: outcome.result.review.conflicts,
        blueprints: outcome.result.blueprints.filter((unit) => !unit.ok),
        templates: outcome.result.templates.filter((unit) => !unit.ok),
        rubrics: outcome.result.rubrics.filter((unit) => !unit.ok),
      })}`,
    );
    return 1;
  }

  stdout(
    JSON.stringify({
      ok: true,
      bundle: outcome.manifest.name,
      contentHome,
      installed: {
        blueprints: outcome.result.blueprints.length,
        templates: outcome.result.templates.length,
        rubrics: outcome.result.rubrics.length,
      },
      rubricSeed: 'deferred-to-operator-startup',
    }),
  );
  return 0;
}

if (isCliEntry(import.meta.url)) {
  runContentBootstrap()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(
        'papercusp-content-bootstrap: fatal:',
        error instanceof Error ? error.stack : error,
      );
      process.exit(1);
    });
}
