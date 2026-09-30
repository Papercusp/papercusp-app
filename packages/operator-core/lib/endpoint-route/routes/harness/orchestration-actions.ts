/**
 * Independent orchestration actions:
 *
 *   POST /api/harness/:slug/smoke-test/run     — exec service-smoke-test.sh; capture combined stdout+stderr
 *   POST /api/harness/:slug/architect/apply    — append a body to supervisor-notes.md
 *
 * Note: the 'SPEC.md' (D-004) and 'contract' / validation-contract.md (D-005)
 * targets were removed — both are deprecated; intent lives in plans and
 * acceptance is inline VAL-* bullets in plan items
 * (plans-central-harness-ux-2026-05-26).
 *
 * Two unrelated POSTs with no shared helpers — bundled into one batch
 * to keep the file count manageable.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 33).
 */
import { existsSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { resolveProject, resolvePhasedProject, harnessDir } from '../../../harness-core';
import { phasePhaseLabel } from '../../../harness-phases';
import { harnessPath } from '../../../harness-paths';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import { runGovernedOperation } from '../../../resource-governor/execution';

const runSmokeTest = defineTool({
  method: 'POST',
  path: '/harness/:slug/smoke-test/run',
  auth: 'loopback',
  async handler(_req, ctx) {
    const project = await resolveProject(ctx.params.slug as string);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const scriptPath = harnessPath('bin', 'service-smoke-test.sh');
    if (!existsSync(scriptPath)) return Response.json({ error: 'smoke-test script not found' }, { status: 500 });
    return runGovernedOperation(
      {
        workspaceId: activeWorkspaceId(),
        namespace: 'harness-smoke-test',
        owner: `harness:${project.slug}:smoke-test`,
        admissionClass: 'process',
        demand: { cpuWeight: 0.5, memoryBytes: 128 * 1024 * 1024, fileDescriptors: 3 },
        payloadRef: `harness:${project.slug}:smoke-test`,
        metadata: { harness: project.slug },
      },
      async () => new Promise<Response>((resolve) => {
        let stdout = '';
        const p = spawn('bash', [scriptPath], {
          env: { ...process.env, PROJECT_DIR: project.path, STATE_DIR: join(project.path, '.papercusp') },
        });
        p.stdout.on('data', (d) => { stdout += d.toString(); });
        p.stderr.on('data', (d) => { stdout += d.toString(); });
        p.on('close', (code) => {
          resolve(Response.json({ ok: code === 0, rc: code, output: stdout }));
        });
      }),
    );
  },
});

const architectApply = defineTool({
  method: 'POST',
  path: '/harness/:slug/architect/apply',
  auth: 'loopback',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const slug = ctx.params.slug as string;
    const project = await resolvePhasedProject(
      slug,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const body = (await req.json()) as { target: string; content: string };
    if (!body.content) return Response.json({ error: 'content required' }, { status: 400 });

    // supervisor-notes.md is the only remaining target. The 'SPEC.md' target
    // was removed (D-004) — the architect shapes plans now, not SPEC.md.
    if (body.target === 'supervisor-notes') {
      const notesPath = join(harnessDir(project), 'supervisor-notes.md');
      const block = `\n## architect ${new Date().toISOString()}\n\n${body.content}\n`;
      const { appendTextArtifact } = await import('../../../text-artifacts');
      await appendTextArtifact(slug, 'supervisor-notes.md', block);
      try { await appendFile(notesPath, block, 'utf8'); } catch {}
      return Response.json({ ok: true, appended: 'supervisor-notes.md' });
    }
    return Response.json({ error: 'unknown target' }, { status: 400 });
  },
});

export default [runSmokeTest, architectApply];
