/**
 * Supervisor + escalation actions:
 *
 *   POST /api/harness/:slug/supervisor             — run the supervisor.sh script and parse SUPERVISOR: outcome
 *   POST /api/harness/:slug/escalation/resolve     — append human response to supervisor-notes.md; optionally clear escalation.md
 *
 * Both write back to PG text-artifacts AND the on-disk markdown copy so
 * the harness FS watcher sees the change.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 32).
 */
import { existsSync } from 'node:fs';
import { appendFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { resolvePhasedProject, harnessDir, safeRead } from '../../../harness-core';
import { phasePhaseLabel } from '../../../harness-phases';
import { harnessPath } from '../../../harness-paths';
import { activeWorkspaceId } from '../../../workspace-registry';
import { GREEN_CHECKPOINT_ESCALATION_PHASES } from '../../../harness/improvements/watchdog';
import { defineTool } from '@papercusp/agent-mcp';
import { runGovernedOperation } from '../../../resource-governor/execution';

const supervisor = defineTool({
  method: 'POST',
  path: '/harness/:slug/supervisor',
  auth: 'loopback',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const script = harnessPath('bin', 'supervisor.sh');
    if (!existsSync(script)) return Response.json({ error: 'supervisor.sh not found' }, { status: 500 });
    return runGovernedOperation(
      {
        workspaceId: activeWorkspaceId(),
        namespace: 'harness-supervisor',
        owner: `harness:${project.slug}:supervisor`,
        admissionClass: 'process',
        demand: { cpuWeight: 1, memoryBytes: 256 * 1024 * 1024, fileDescriptors: 3 },
        payloadRef: `harness:${project.slug}:supervisor`,
        metadata: { harness: project.slug },
      },
      async () => new Promise<Response>((resolve) => {
        execFile('bash', [script], {
          cwd: project.path,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, CLAUDE: process.env.AGENT_CMD ?? process.env.CLAUDE ?? 'omp -p' },
        }, (err, stdout, stderr) => {
          if (err) {
            resolve(Response.json({ ok: false, error: String(err.message || err), stderr: stderr?.toString() ?? '', stdout: stdout?.toString() ?? '' }, { status: 500 }));
            return;
          }
          const last = (stdout?.toString() ?? '').trim().split('\n').reverse().find((l) => l.startsWith('SUPERVISOR:')) ?? '';
          resolve(Response.json({ ok: true, outcome: last, stdout: stdout?.toString(), stderr: stderr?.toString() }));
        });
      }),
    );
  },
});

const resolveEscalation = defineTool({
  method: 'POST',
  path: '/harness/:slug/escalation/resolve',
  auth: 'loopback',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const slug = ctx.params.slug as string;
    const requestedPhase = url.searchParams.get('phase') ?? undefined;
    const project = await resolvePhasedProject(
      slug,
      phasePhaseLabel(requestedPhase),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as { response?: unknown; action?: unknown };
    const response = typeof body.response === 'string' ? body.response.trim() : '';
    const action = body.action === 'clear' ? 'clear' : 'keep';
    const rowPhase = requestedPhase ?? 'staging';

    const supervisorNotesPath = join(harnessDir(project), 'supervisor-notes.md');
    const { appendTextArtifact, loadTextArtifact, deleteTextArtifact } = await import('../../../text-artifacts');
    const block = response
      ? `\n## Human response ${new Date().toISOString()}\n\n${response}\n`
      : '';
    if (response) {
      await appendTextArtifact(slug, 'supervisor-notes.md', block);
      try { await appendFile(supervisorNotesPath, block, 'utf8'); } catch {}
    }

    if (action === 'clear') {
      await deleteTextArtifact(slug, 'escalation.md');
      try { await unlink(join(harnessDir(project), 'escalation.md')); } catch {}
    }

    if (block || action === 'clear') {
      const { sql } = getOrgPg();
      // EI-9205: green-checkpoint-stall + green-checkpoint-watchdog are TWO distinct
      // harness_escalations rows for the SAME conceptual condition (one in-routine,
      // one standalone-watchdog), collected independently by collectEscalationSignals.
      // Annotating only the requested phase left the sibling row's supervisor_notes
      // empty, so the collector re-fired a near-duplicate unresolved-escalation
      // work-item on the sibling phase minutes later (EI-9197 → EI-9203). When the
      // requested phase is one of this pair, fan the same note/clear out to BOTH so a
      // single triage call suppresses the collector on both rows.
      const targetPhases = GREEN_CHECKPOINT_ESCALATION_PHASES.includes(rowPhase)
        ? GREEN_CHECKPOINT_ESCALATION_PHASES
        : [rowPhase];
      await sql.unsafe(
        `UPDATE harness_shared.harness_escalations
            SET supervisor_notes = CASE
                  WHEN $4 <> '' THEN COALESCE(supervisor_notes, '') || $4
                  ELSE supervisor_notes
                END,
                escalation = CASE
                  WHEN $5 THEN NULL
                  ELSE escalation
                END,
                mtime_ms = $6
          WHERE workspace_id = $1
            AND harness_slug = $2
            AND phase = ANY($3)`,
        [activeWorkspaceId(), slug, targetPhases, block, action === 'clear', Date.now()],
      );
    }

    const pgNotes = await loadTextArtifact(slug, 'supervisor-notes.md');
    return Response.json({
      ok: true,
      supervisorNotes: pgNotes ?? safeRead(supervisorNotesPath),
      cleared: action === 'clear',
    });
  },
});

export default [supervisor, resolveEscalation];
