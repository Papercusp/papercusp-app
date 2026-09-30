/**
 * GET /api/admin/run?cmd=<id> — SSE stream of a registered admin
 * command's stdout/stderr + exit.
 *
 * Ported from app/api/admin/run/route.ts. `auth: 'public'`,
 * `sampleRate: 0` (SSE). The Next `import 'server-only'` is dropped —
 * a defineTool module is server-only by construction.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { sseResponse } from '@papercusp/sse';
import { getCommand } from '../../../admin-commands';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import { runGovernedOperation } from '../../../resource-governor/execution';

interface AdminRunVocab extends Record<string, unknown> {
  meta: { commandId: string; label: string; command: string; cwd?: string; pid: number; startedAt: number };
  log: { stream: 'stdout' | 'stderr'; line: string };
  exit: { code: number | null; signal: NodeJS.Signals | null };
  error: { message: string };
}

export default defineTool({
  method: 'GET',
  path: '/admin/run',
  auth: { trust: ['verified', 'trusted'] },
  sampleRate: 0,
  handler(req): Response {
    const url = new URL(req.url);
    const cmdId = url.searchParams.get('cmd');
    if (!cmdId) {
      return new Response('missing ?cmd', { status: 400 });
    }
    const entry = getCommand(cmdId);
    if (!entry) {
      return new Response(`unknown command id: ${cmdId}`, { status: 404 });
    }

    return sseResponse<AdminRunVocab>({
      signal: req.signal,
      heartbeatMs: 15_000,
      initialHeartbeat: true,
      setup: async (sink) => {
        if (sink.closed) return;
        await runGovernedOperation(
          {
            workspaceId: activeWorkspaceId(),
            namespace: 'admin-command',
            owner: `admin:run:${entry.id}`,
            admissionClass: 'process',
            demand: { cpuWeight: 1, memoryBytes: 512 * 1024 * 1024, fileDescriptors: 3 },
            payloadRef: `admin:run:${entry.id}`,
            metadata: { commandId: entry.id },
          },
          async () => new Promise<void>((resolve, reject) => {
            // -lic = login + interactive + command. The user's ~/.bashrc has
            // Ubuntu's non-interactive-return guard at the top; passing -i
            // flips $- to include `i` so the guard passes and the env exports
            // below it (NVM, BUN, ELEVENLABS_API_KEY, cargo env, …) run.
            const child = spawn('bash', ['-lic', entry.command], {
              cwd: entry.cwd,
              stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '0' },
              detached: true, // own process group so process.kill(-pid) reaches all children
            });

            sink.event('meta', {
              commandId: entry.id,
              label: entry.label,
              command: entry.command,
              cwd: entry.cwd,
              pid: child.pid ?? -1,
              startedAt: Date.now(),
            });

            const outRl = createInterface({ input: child.stdout, crlfDelay: Infinity });
            outRl.on('line', (line) => {
              if (!sink.closed) sink.event('log', { stream: 'stdout', line });
            });
            const errRl = createInterface({ input: child.stderr, crlfDelay: Infinity });
            errRl.on('line', (line) => {
              // Silence bash's two `-i without TTY` complaints — cosmetic.
              if (
                line === 'bash: cannot set terminal process group (-1): Inappropriate ioctl for device' ||
                line === 'bash: no job control in this shell'
              ) return;
              if (!sink.closed) sink.event('log', { stream: 'stderr', line });
            });

            child.once('error', (err) => {
              if (!sink.closed) sink.event('error', { message: String(err?.message ?? err) });
              reject(err);
            });

            child.once('exit', (code, signal) => {
              if (!sink.closed) {
                sink.event('exit', { code, signal });
                sink.done();
              }
              resolve();
            });

            sink.onClose(() => {
              if (!child.killed && child.exitCode == null) {
                try {
                  process.kill(-child.pid!, 'SIGTERM');
                } catch {
                  try { child.kill('SIGTERM'); } catch { /* nothing to do */ }
                }
                setTimeout(() => {
                  if (!child.killed && child.exitCode == null) {
                    try { process.kill(-child.pid!, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* nothing to do */ } }
                  }
                }, 3000);
              }
            });
          }),
        );
      },
    });
  },
});
