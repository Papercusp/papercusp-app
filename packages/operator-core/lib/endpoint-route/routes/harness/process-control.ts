/**
 * Process control for a running harness — signal its driver processes:
 *
 *   POST /api/harness/:slug/pause     — SIGSTOP the driver + descendants
 *   POST /api/harness/:slug/unpause   — SIGCONT them
 *   POST /api/harness/:slug/stop      — SIGTERM the driver processes
 *
 * `/:slug/resume` stays in `_hono/harness.ts` for now — it relaunches via
 * the shared `launchRun` helper (migrated with `/:slug/launch` later).
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 21).
 */
import { readdirSync, readlinkSync, readFileSync } from 'node:fs';
import { resolvePhasedProject, isHarnessDriverCmdline } from '../../../harness-core';
import { phasePhaseLabel } from '../../../harness-phases';
import { defineTool } from '@papercusp/agent-mcp';

function phaseFromReq(req: Request) {
  return phasePhaseLabel(new URL(req.url).searchParams.get('phase') ?? undefined);
}

/**
 * Find all PIDs of run.sh running for this project + their descendants.
 * Walks /proc matching cwd-under-projectPath; includes claude/python3
 * children (so pause/unpause reach the whole tree).
 */
function findHarnessPids(projectPath: string): number[] {
  const pids: number[] = [];
  try {
    for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
      try {
        const cwd = readlinkSync(`/proc/${pid}/cwd`);
        if (!cwd.startsWith(projectPath)) continue;
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (isHarnessDriverCmdline(cmdline) || cmdline.includes('claude') || cmdline.includes('python3')) {
          pids.push(Number(pid));
        }
      } catch {}
    }
  } catch {}
  return pids;
}

const pause = defineTool({
  method: 'POST',
  path: '/harness/:slug/pause',
  auth: 'loopback',
  async handler(req, ctx) {
    // Signals arbitrary PIDs under the project path — loopback-only (audit P-025).
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const pids = findHarnessPids(project.path);
    const paused: number[] = [];
    for (const pid of pids) {
      try { process.kill(pid, 'SIGSTOP'); paused.push(pid); } catch {}
    }
    return Response.json({ ok: true, paused });
  },
});

const unpause = defineTool({
  method: 'POST',
  path: '/harness/:slug/unpause',
  auth: 'loopback',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const pids = findHarnessPids(project.path);
    const resumed: number[] = [];
    for (const pid of pids) {
      try { process.kill(pid, 'SIGCONT'); resumed.push(pid); } catch {}
    }
    return Response.json({ ok: true, resumed });
  },
});

const stop = defineTool({
  method: 'POST',
  path: '/harness/:slug/stop',
  auth: 'loopback',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    try {
      const procs = readdirSync('/proc').filter((d) => /^\d+$/.test(d));
      const killed: number[] = [];
      for (const pid of procs) {
        try {
          const cwd = readlinkSync(`/proc/${pid}/cwd`);
          if (!cwd.startsWith(project.path)) continue;
          const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
          if (isHarnessDriverCmdline(cmdline)) {
            process.kill(Number(pid), 'SIGTERM');
            killed.push(Number(pid));
          }
        } catch {}
      }
      return Response.json({ ok: true, killed });
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 500 });
    }
  },
});

export default [pause, unpause, stop];
