/**
 * Archive routes — tar.gz the harness's `.papercusp/` directory and restore
 * from a prior snapshot:
 *
 *   POST /api/harness/:slug/archive                 — create new tar; optional reset
 *   POST /api/harness/:slug/archives/:id/restore    — extract archive over current state (requires confirm:true)
 *
 * Both routes snapshot to `<harnessDir>/archives/<ts>.tar.gz`. Restore
 * does a pre-restore snapshot first so the destructive overwrite is itself
 * reversible (`undoSnapshot` is returned).
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 31).
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdir, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { harnessQuery } from '@papercusp/db-org';
import { resolvePhasedProject, harnessDir } from '../../../harness-core';
import { phasePhaseLabel } from '../../../harness-phases';
import { STATE_FILES_FOR_RESET } from '../../../harness-state-files';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import { runGovernedOperation } from '../../../resource-governor/execution';

/** Extracted for direct testability (WI-5381 / WI-4995 part b) — was inline
 *  `getLegacyClient(slug).prepare(...).run(...)`, a direct connection outside
 *  PgBouncer pooling; now routed through harnessQuery's PgBouncer-safe
 *  per-transaction search_path in pooled mode / connect-time search_path in
 *  direct mode (byte-identical behavior either way). */
export async function clearHarnessFeaturesForReset(slug: string): Promise<void> {
  await harnessQuery(slug, (sql) => sql`DELETE FROM harness_features WHERE harness_slug = ${slug}`);
}

const archiveOnly = defineTool({
  method: 'POST',
  path: '/harness/:slug/archive',
  auth: 'loopback',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as { reset?: boolean };

    const dir = harnessDir(project);
    const archivesDir = join(dir, 'archives');
    await mkdir(archivesDir, { recursive: true });
    const ts = Date.now();
    const archiveName = `${ts}.tar.gz`;
    const archivePath = join(archivesDir, archiveName);

    return runGovernedOperation({
      workspaceId: activeWorkspaceId(),
      namespace: 'harness-archive',
      owner: `harness:${project.slug}:archive`,
      admissionClass: 'process',
      demand: { cpuWeight: 1, memoryBytes: 256 * 1024 * 1024, fileDescriptors: 3 },
      payloadRef: `harness:${project.slug}:archive:${archiveName}`,
      metadata: { harness: project.slug, operation: 'archive' },
    }, async () => new Promise<Response>((resolve) => {
      execFile('tar', ['czf', archivePath, '-C', dir, '--exclude=archives', '--exclude=./archives', '.'], {
        cwd: project.path,
        maxBuffer: 8 * 1024 * 1024,
      }, async (err, _stdout, stderr) => {
        if (err) {
          resolve(Response.json({ ok: false, error: `tar failed: ${String(err.message || err).slice(0, 300)}`, stderr: stderr?.toString().slice(0, 500) ?? '' }, { status: 500 }));
          return;
        }
        const resetRemoved: string[] = [];
        if (body.reset) {
          // Remove validation-contract.md, issues.md, worker-log.md,
          // escalation.md, supervisor-notes.md, lanes.json, prs.json,
          // logs/, snapshots/, screenshots/. Keep config.json, hooks/,
          // knowledge.md, archives/. Features moved to PG in 2026-04-26;
          // we also DELETE from harness_features below.
          for (const f of STATE_FILES_FOR_RESET) {
            try { await unlink(join(dir, f)); resetRemoved.push(f); } catch {}
          }
          for (const d of ['logs', 'snapshots', 'screenshots']) {
            try { await rm(join(dir, d), { recursive: true, force: true }); resetRemoved.push(`${d}/`); } catch {}
          }
          try {
            await clearHarnessFeaturesForReset(project.slug);
            resetRemoved.push('harness_features (PG)');
          } catch (e: any) {
            console.warn('[archive-reset] PG features clear failed:', e?.message ?? e);
          }
        }
        let sizeBytes = 0;
        try { sizeBytes = statSync(archivePath).size; } catch {}
        resolve(Response.json({ ok: true, id: archiveName, sizeBytes, reset: !!body.reset, resetRemoved }));
      });
    }));
  },
});

const restoreArchive = defineTool({
  method: 'POST',
  path: '/harness/:slug/archives/:id/restore',
  auth: 'loopback',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const id = (ctx.params.id as string).replace(/[^A-Za-z0-9_.\-]/g, '');
    if (!id || !id.endsWith('.tar.gz') || !/^\d+\.tar\.gz$/.test(id)) {
      return Response.json({ error: 'invalid archive id' }, { status: 400 });
    }
    const archivePath = join(harnessDir(project), 'archives', id);
    if (!existsSync(archivePath)) return Response.json({ error: 'archive not found' }, { status: 404 });

    const body = (await req.json().catch(() => ({}))) as { confirm?: boolean };
    if (!body.confirm) {
      return Response.json({ error: 'confirm: true required — this overwrites current .papercusp/ state' }, { status: 400 });
    }

    const dir = harnessDir(project);
    const preSnapName = `${Date.now()}-pre-restore.tar.gz`;
    return runGovernedOperation({
      workspaceId: activeWorkspaceId(),
      namespace: 'harness-archive-restore',
      owner: `harness:${project.slug}:archive-restore`,
      admissionClass: 'process',
      demand: { cpuWeight: 1, memoryBytes: 256 * 1024 * 1024, fileDescriptors: 3 },
      payloadRef: `harness:${project.slug}:archive-restore:${id}`,
      metadata: { harness: project.slug, operation: 'restore' },
    }, async () => new Promise<Response>((resolve) => {
      execFile('tar', ['czf', join(dir, 'archives', preSnapName), '-C', dir, '--exclude=archives', '--exclude=./archives', '.'], {
        cwd: project.path,
        maxBuffer: 8 * 1024 * 1024,
      }, (err1, _o, e1) => {
        if (err1) {
          resolve(Response.json({ ok: false, error: `pre-restore snapshot failed: ${String(err1.message || err1).slice(0, 300)}`, stderr: e1?.toString().slice(0, 500) ?? '' }, { status: 500 }));
          return;
        }
        (async () => {
          try {
            for (const entry of readdirSync(dir)) {
              if (entry === 'archives') continue;
              await rm(join(dir, entry), { recursive: true, force: true });
            }
          } catch (e) {
            resolve(Response.json({ ok: false, error: `pre-restore cleanup failed: ${String(e).slice(0, 300)}` }, { status: 500 }));
            return;
          }
          execFile('tar', ['xzf', archivePath, '-C', dir], {
            cwd: project.path,
            maxBuffer: 8 * 1024 * 1024,
          }, (err2, _o2, e2) => {
            if (err2) {
              resolve(Response.json({ ok: false, error: `restore failed: ${String(err2.message || err2).slice(0, 300)}`, stderr: e2?.toString().slice(0, 500) ?? '', undoSnapshot: preSnapName }, { status: 500 }));
              return;
            }
            resolve(Response.json({ ok: true, restored: id, undoSnapshot: preSnapName }));
          });
        })();
      });
    }));
  },
});

export default [archiveOnly, restoreArchive];
