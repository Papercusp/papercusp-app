/**
 * Scoper-action routes:
 *
 *   POST /api/harness/:slug/product-review   — kicks scoper MODE=proposal
 *   POST /api/harness/:slug/replan           — kicks scoper MODE=replan (or destructive MODE=initial when body.overwrite)
 *   POST /api/harness/:slug/cleanup          — kicks scoper MODE=cleanup
 *
 * All three are user-triggered "do this once" actions; both replan and
 * cleanup wrap the kickoff in `recordUserAction` so the operator action
 * log shows them.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 30). Background-spawn helper `invokeScoperBackground` lives in
 * `lib/harness-scoper.ts` (carve-out from batch 29).
 */
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { harnessQuery } from '@papercusp/db-org';
import { resolveProject, harnessDir, parseFeatures } from '../../../harness-core';
import { harnessPackageDir, orchestratorRunBin, tsxBin } from '../../../harness-paths';
import { STATE_FILES_FOR_BACKUP } from '../../../harness-state-files';
import { invokeScoperBackground } from '../../../harness-scoper';
import { recordUserAction } from '../../../user-actions';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import { runGovernedOperation } from '../../../resource-governor/execution';

// ── POST /:slug/product-review ─────────────────────────────────────────

const productReview = defineTool({
  method: 'POST',
  path: '/harness/:slug/product-review',
  auth: 'loopback',
  async handler(_req, ctx) {
    const project = await resolveProject(ctx.params.slug as string);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const { invocationId } = await invokeScoperBackground(project, 'proposal');
    return Response.json({ ok: true, invocationId, mode: 'proposal' });
  },
});

// ── POST /:slug/replan — two modes (delta-merge default, destructive overwrite) ──

const replan = defineTool({
  method: 'POST',
  path: '/harness/:slug/replan',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const project = await resolveProject(slug);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as { overwrite?: boolean };
    if (!body.overwrite) {
      // Non-destructive: scoper MODE=replan as a background invocation;
      // delta-merges new plan items into the existing queue.
      const invocationId = await recordUserAction(slug, 'replan', async () => {
        const r = await invokeScoperBackground(project, 'replan');
        return {
          summary: `Replan kicked off (invocation ${r.invocationId})`,
          invocationId: r.invocationId,
          result: r.invocationId,
        };
      });
      return Response.json({ ok: true, invocationId, mode: 'replan' });
    }

    // Destructive: wipe features in PG (after snapshot), back up state files,
    // then invoke scoper MODE=initial inline (MAX_ITERATIONS=0 skips the loop).
    // Plan-based harnesses have no SPEC.md or validation-contract.md — that is fine.

    await mkdir(harnessDir(project), { recursive: true });
    const backupDir = join(harnessDir(project), `.replan-backup-${Date.now()}`);
    await mkdir(backupDir, { recursive: true });
    for (const f of STATE_FILES_FOR_BACKUP) {
      const p = join(harnessDir(project), f);
      if (existsSync(p)) {
        await rename(p, join(backupDir, f));
      }
    }
    try {
      const prior = await parseFeatures(project);
      if (prior.length > 0) {
        await writeFile(join(backupDir, 'features.pg.json'), JSON.stringify(prior, null, 2));
        await harnessQuery(project.slug, (sql) => sql`
          DELETE FROM harness_features WHERE harness_slug = ${project.slug}
        `);
      }
    } catch (e: any) {
      console.warn('[replan] PG feature clear failed:', e?.message ?? e);
    }

    const orchBin = orchestratorRunBin();
    const logPath = `/tmp/harness-replan-${project.slug}.log`;
    // Instance config via the env-transport — the orchestrator never reads
    // `.papercusp/config.json` (deprecate-harness-config-json-2026-06-06).
    const instEnv = await (async (): Promise<Record<string, string>> => {
      try {
        const { instanceConfigEnv } = await import('../../../deployment/instance-config');
        return await instanceConfigEnv(project.slug, activeWorkspaceId());
      } catch { return {}; }
    })();
    return runGovernedOperation(
      {
        workspaceId: activeWorkspaceId(),
        namespace: 'harness-scoper-replan',
        owner: `harness:${project.slug}:replan`,
        admissionClass: 'process',
        demand: { cpuWeight: 1, memoryBytes: 512 * 1024 * 1024, fileDescriptors: 3 },
        payloadRef: `harness:${project.slug}:replan`,
        metadata: { harness: project.slug, mode: 'initial' },
      },
      async () => new Promise<Response>((resolve) => {
        execFile('bash', ['-c', `MAX_ITERATIONS=0 node ${tsxBin()} ${orchBin} >> ${logPath} 2>&1; echo "DONE rc=$?"`], {
          cwd: project.path,
          env: {
            ...process.env,
            ...instEnv,
            AGENT_CMD: process.env.AGENT_CMD ?? process.env.CLAUDE ?? 'omp -p',
            CLAUDE: process.env.AGENT_CMD ?? process.env.CLAUDE ?? 'omp -p',
            HARNESS_DIR: harnessPackageDir(),
            PROJECT_DIR: project.path,
            HARNESS_SLUG: project.slug,
          },
          maxBuffer: 1024 * 1024,
          timeout: 5 * 60_000,
        }, async (err: any, stdout, stderr) => {
          const produced = (await parseFeatures(project)).length > 0;
          if (err && !produced) {
            resolve(Response.json({ ok: false, error: String(err.message || err).slice(0, 400), stderr, logPath }, { status: 500 }));
            return;
          }
          resolve(Response.json({
            ok: true,
            mode: 'initial',
            produced,
            logPath,
            stdout: stdout.toString().slice(-2048),
            stderr: stderr.toString().slice(-1024),
            backupDir,
          }));
        });
      }),
    );
  },
});

// ── POST /:slug/cleanup ────────────────────────────────────────────────

const cleanup = defineTool({
  method: 'POST',
  path: '/harness/:slug/cleanup',
  auth: 'loopback',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    const project = await resolveProject(slug);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const invocationId = await recordUserAction(slug, 'cleanup', async () => {
      const r = await invokeScoperBackground(project, 'cleanup');
      return {
        summary: `Cleanup kicked off (invocation ${r.invocationId})`,
        invocationId: r.invocationId,
        result: r.invocationId,
      };
    });
    return Response.json({ ok: true, invocationId, mode: 'cleanup' });
  },
});

export default [productReview, replan, cleanup];
