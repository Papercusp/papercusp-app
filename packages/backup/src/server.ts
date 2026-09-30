/**
 * Per-workspace kopia server lifecycle (the kopia web UI we iframe into
 * the /dev Backups tab).
 *
 * `kopia server start` runs a long-lived HTTP server with a web UI on a
 * loopback port. One server per workspace; we cache the spawned child
 * keyed by workspaceId and reuse across requests.
 *
 * Auth is disabled (`--insecure --without-password`) because the server
 * is loopback-only and the operator process already gates access. If we
 * ever expose this off-host, add `--server-username/--server-password`
 * driven by the spawn-signing key.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { backupHost } from './config';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { deriveRepoPassword } from './password';

const KOPIA_BIN = process.env.KOPIA_BIN ?? 'kopia';

export interface KopiaServerInfo {
  workspaceId: string;
  port: number;
  url: string;
  startedAt: string;
}

interface ServerHandle {
  info: KopiaServerInfo;
  child: ChildProcess;
}

const RUNNING = new Map<string, ServerHandle>();

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (addr && typeof addr === 'object') {
        const p = addr.port;
        s.close(() => resolve(p));
      } else {
        s.close(() => reject(new Error('failed to allocate port')));
      }
    });
  });
}

export async function startKopiaServer(workspaceId: string): Promise<KopiaServerInfo> {
  const existing = RUNNING.get(workspaceId);
  if (existing && !existing.child.killed) return existing.info;

  const workspaceRoot = join(backupHost().workspacesRoot(), workspaceId);
  const backupsDir = join(workspaceRoot, 'backups');
  await mkdir(backupsDir, { recursive: true });

  const password = await deriveRepoPassword(workspaceId);
  const port = await freePort();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KOPIA_PASSWORD: password,
    KOPIA_CONFIG_PATH: join(backupsDir, 'repository.config'),
    KOPIA_LOG_DIR: join(backupsDir, 'logs'),
    KOPIA_CACHE_DIRECTORY: join(backupsDir, 'cache'),
  };

  const child = spawn(KOPIA_BIN, [
    'server', 'start',
    '--insecure',
    '--without-password',
    `--address=127.0.0.1:${port}`,
    '--disable-csrf-token-checks',
  ], { env, stdio: ['ignore', 'pipe', 'pipe'] });

  // An unhandled ChildProcess 'error' (spawn ENOENT when the kopia binary
  // is absent from the runtime) is an UNCAUGHT EXCEPTION that kills the
  // whole operator — took serve down live on Windows 2026-06-11 when the
  // Setup Wizard reached the Backups step. Capture and surface as a
  // normal rejection instead.
  let spawnError: NodeJS.ErrnoException | null = null;
  child.on('error', (e) => {
    spawnError = e;
    RUNNING.delete(workspaceId);
  });
  child.stdout.on('data', () => { /* drain */ });
  child.stderr.on('data', () => { /* drain */ });
  child.on('exit', () => RUNNING.delete(workspaceId));

  const info: KopiaServerInfo = {
    workspaceId,
    port,
    url: `http://127.0.0.1:${port}/`,
    startedAt: new Date().toISOString(),
  };
  RUNNING.set(workspaceId, { info, child });

  // Give kopia a beat to bind. If it dies immediately, surface that.
  await new Promise((r) => setTimeout(r, 250));
  if (spawnError) {
    RUNNING.delete(workspaceId);
    const failed: NodeJS.ErrnoException = spawnError;
    throw new Error(
      failed.code === 'ENOENT'
        ? `kopia binary not found (${KOPIA_BIN}) — backups are unavailable in this runtime`
        : `kopia server failed to spawn: ${failed.message}`,
    );
  }
  if (child.exitCode !== null) {
    RUNNING.delete(workspaceId);
    throw new Error(`kopia server failed to start (exit ${child.exitCode})`);
  }
  return info;
}

export function stopKopiaServer(workspaceId: string): boolean {
  const h = RUNNING.get(workspaceId);
  if (!h) return false;
  h.child.kill('SIGTERM');
  RUNNING.delete(workspaceId);
  return true;
}

export function kopiaServerStatus(workspaceId: string): KopiaServerInfo | null {
  const h = RUNNING.get(workspaceId);
  return h && !h.child.killed ? h.info : null;
}
