/**
 * /api/dev/drizzle-studio — manages a child `drizzle-kit studio` gateway.
 *
 *   POST   → start (idempotent — returns running PID if already up)
 *   GET    → status { running, pid, port, since }
 *   DELETE → stop
 *
 * UI is served by https://local.drizzle.studio and connects back to the
 * local gateway over CORS. Cross-request state survives on globalThis.
 *
 * Ported from app/api/dev/drizzle-studio/route.ts. `auth: 'public'` —
 * dev-only, faithful port at current posture (D3).
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { getHarnessAdminUrl } from '../../../embedded-pg-discovery';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import {
  beginGovernedExecution,
  governedExecutionRuntime,
  type GovernedExecution,
} from '../../../resource-governor/execution';

interface StudioProc {
  child: ChildProcessByStdio<null, Readable, Readable>;
  execution: GovernedExecution;
  port: number;
  since: number;
  lastStderr: string;
}

const STATE: { proc: StudioProc | null; lastExitStderr: string; lastExitCode: number | null } =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__drizzleStudioState ??= { proc: null, lastExitStderr: '', lastExitCode: null };

function configPath(): string | null {
  const candidates = [
    'libs/papercusp/libs/db/drizzle.config.ts',
    '../../libs/papercusp/libs/db/drizzle.config.ts',
    '../../../libs/papercusp/libs/db/drizzle.config.ts',
  ];
  for (const c of candidates) {
    const abs = resolve(process.cwd(), c);
    if (existsSync(abs)) return abs;
  }
  return null;
}

function drizzleKitBin(): string | null {
  try {
    // Indirect eval defeats Turbopack's static module-graph trace.
    const pkgPath = (0, eval)("require.resolve('drizzle-kit/package.json')") as string;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = JSON.parse(require('node:fs').readFileSync(pkgPath, 'utf8')) as { bin?: Record<string, string> | string };
    const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['drizzle-kit'];
    if (binRel) {
      const abs = resolve(pkgPath, '..', binRel);
      if (existsSync(abs)) return abs;
    }
  } catch {
    // fall through
  }
  const symlinks = [
    'node_modules/.bin/drizzle-kit',
    '../../node_modules/.bin/drizzle-kit',
    '../../../node_modules/.bin/drizzle-kit',
  ];
  for (const c of symlinks) {
    const abs = resolve(process.cwd(), c);
    if (existsSync(abs)) return abs;
  }
  const binCjs = [
    'node_modules/drizzle-kit/bin.cjs',
    '../../node_modules/drizzle-kit/bin.cjs',
    '../../../node_modules/drizzle-kit/bin.cjs',
  ];
  for (const c of binCjs) {
    const abs = resolve(process.cwd(), c);
    if (existsSync(abs)) return abs;
  }
  return null;
}

async function isPortFree(p: number): Promise<boolean> {
  return new Promise((done) => {
    const s = createServer();
    s.once('error', () => done(false));
    s.once('listening', () => s.close(() => done(true)));
    s.listen(p, '127.0.0.1');
  });
}

async function pickFreePort(start: number): Promise<number> {
  for (let p = start; p < start + 20; p++) {
    if (await isPortFree(p)) return p;
  }
  return start;
}

function status() {
  const p = STATE.proc;
  if (!p) return { running: false, lastStderr: STATE.lastExitStderr, lastExitCode: STATE.lastExitCode };
  if (p.child.killed || p.child.exitCode != null) {
    STATE.lastExitStderr = p.lastStderr;
    STATE.lastExitCode = p.child.exitCode;
    STATE.proc = null;
    return { running: false, lastStderr: STATE.lastExitStderr, lastExitCode: STATE.lastExitCode };
  }
  return { running: true, pid: p.child.pid, port: p.port, since: p.since };
}

const get = defineTool({
  method: 'GET',
  path: '/dev/drizzle-studio',
  auth: { trust: ['verified', 'trusted'] },
  async handler() {
    return Response.json(status());
  },
});

const post = defineTool({
  method: 'POST',
  path: '/dev/drizzle-studio',
  auth: { trust: ['verified', 'trusted'] },
  async handler() {
    const cur = status();
    if (cur.running) return Response.json({ ...cur, started: false });

    const cfg = configPath();
    if (!cfg) return Response.json({ error: 'drizzle.config.ts not found' }, { status: 500 });
    const bin = drizzleKitBin();
    if (!bin) return Response.json({ error: 'drizzle-kit binary not found' }, { status: 500 });

    const requested = Number(process.env.DRIZZLE_STUDIO_PORT ?? 4983);
    const port = await pickFreePort(requested);
    const workspaceId = activeWorkspaceId();
    const execution = await beginGovernedExecution(
      {
        idempotencyKey: `drizzle-studio:${process.pid}:${randomUUID()}`,
        admissionClass: 'process',
        demand: { cpuWeight: 0.5, memoryBytes: 256 * 1024 * 1024, fileDescriptors: 4 },
        payloadRef: `drizzle-studio:${port}`,
        metadata: { port },
      },
      { owner: `drizzle-studio:${process.pid}`, leaseTtlMs: 30 * 24 * 60 * 60_000 },
      governedExecutionRuntime(workspaceId, 'drizzle-studio'),
    );

    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(bin, ['studio', '--config', cfg, '--port', String(port), '--host', '127.0.0.1'], {
        cwd: resolve(cfg, '../..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          HARNESS_ADMIN_DATABASE_URL: getHarnessAdminUrl(),
        },
      });
    } catch (error) {
      await execution.cancel(`drizzle studio spawn failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }

    const proc: StudioProc = { child, execution, port, since: Date.now(), lastStderr: '' };
    STATE.proc = proc;
    child.stderr.on('data', (b) => {
      proc.lastStderr = (proc.lastStderr + b.toString()).slice(-4096);
    });
    child.once('error', (error) => {
      void execution.cancel(`drizzle studio child error: ${error.message}`);
    });
    child.on('exit', (code) => {
      void execution.finish();
      if (STATE.proc === proc) {
        STATE.lastExitStderr = proc.lastStderr;
        STATE.lastExitCode = code;
        STATE.proc = null;
      }
    });

    await new Promise<void>((done) => {
      const t = setTimeout(done, 800);
      child.stdout.once('data', () => { clearTimeout(t); done(); });
      child.once('exit', () => { clearTimeout(t); done(); });
    });

    return Response.json({ ...status(), started: true });
  },
});

const del = defineTool({
  method: 'DELETE',
  path: '/dev/drizzle-studio',
  auth: { trust: ['verified', 'trusted'] },
  async handler() {
    const p = STATE.proc;
    if (!p) return Response.json({ running: false, stopped: false });
    p.child.kill('SIGTERM');
    STATE.proc = null;
    return Response.json({ running: false, stopped: true });
  },
});

export default [get, post, del];
