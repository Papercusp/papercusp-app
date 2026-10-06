/**
 * Install (or check) the pinned coldsnap the AWS AMI release path uses (WI-10005642).
 *
 *   npx tsx packages/operator-core/lib/workspace-host/install-coldsnap-cli.ts          # install if absent/stale
 *   npx tsx packages/operator-core/lib/workspace-host/install-coldsnap-cli.ts --check  # read-only; exit 1 if not installed
 *
 * Requires cargo (CARGO env, else ~/.cargo/bin/cargo, else `cargo` on PATH). The pin, checksum
 * verification and install layout live in coldsnap-pin.ts; this file only binds real I/O.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isCliEntry } from '../util/cli-entry';
import {
  COLDSNAP_PIN,
  inspectPinnedColdsnap,
  installPinnedColdsnap,
  type ColdsnapInstallDeps,
} from './coldsnap-pin';

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveCargo(env: NodeJS.ProcessEnv, home: string, exists: (path: string) => boolean = isExecutable): string {
  const explicit = env.CARGO?.trim();
  if (explicit) return explicit;
  const rustup = join(home, '.cargo', 'bin', 'cargo');
  return exists(rustup) ? rustup : 'cargo';
}

export const realColdsnapInstallDeps: ColdsnapInstallDeps = {
  async fetchBytes(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  },
  run(command, args, options) {
    const result = spawnSync(command, [...args], {
      cwd: options?.cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60 * 60 * 1000,
    });
    return {
      status: result.error ? null : result.status,
      stdout: result.stdout ?? '',
      stderr: result.error ? String(result.error) : (result.stderr ?? ''),
    };
  },
  makeTempDir: () => mkdtemp(join(tmpdir(), 'papercusp-coldsnap-')),
  removeDir: (path) => rm(path, { recursive: true, force: true }),
  async writeFile(path, data) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  },
  readFile: (path) => readFile(path, 'utf8').catch(() => undefined),
  isExecutable,
  now: () => new Date(),
};

export async function main(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const home = env.HOME?.trim() || homedir();
  if (argv.includes('--check')) {
    const state = await inspectPinnedColdsnap(home, realColdsnapInstallDeps);
    process.stdout.write(`${JSON.stringify({ pin: COLDSNAP_PIN, ...state })}\n`);
    return state.installed ? 0 : 1;
  }
  const result = await installPinnedColdsnap(home, realColdsnapInstallDeps, { cargo: resolveCargo(env, home) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

if (isCliEntry(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
