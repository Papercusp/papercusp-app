/**
 * GET/PUT /api/harness/:slug/spec — read/write the per-harness project
 * files. SPEC.md (D-004) and validation-contract.md (D-005) are deprecated —
 * no longer read from or written to disk here; only AGENTS.md + config.json
 * are mirrored. The spec/contract fields stay in the GET/PUT shape only to
 * surface whatever legacy data PG still holds.
 *
 * PG canonical (Migration 034), with disk mirrors for editor convenience.
 * Optimistic concurrency: PUT accepts `expected_version` and returns 409
 * with the current version on mismatch so the caller can rebase.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 2).
 */
import { writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePhasedProject, harnessDir, safeRead } from '../../../harness-core';
import { phasePhaseLabel } from '../../../harness-phases';
import {
  loadProjectFiles,
  saveProjectFiles,
  ProjectFilesVersionConflict,
} from '../../../harness-project-files';
import { defineTool } from '@papercusp/agent-mcp';

const getSpec = defineTool({
  method: 'GET',
  path: '/harness/:slug/spec',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const url = new URL(req.url);
    const project = await resolvePhasedProject(slug, phasePhaseLabel(url.searchParams.get('phase') ?? undefined));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const pg = await loadProjectFiles(slug);
    return Response.json({
      // spec/contract are deprecated — return only what PG still holds for
      // legacy harnesses; don't fall back to reading the tombstone disk files.
      spec: pg.spec ?? null,
      agents: pg.agents ?? safeRead(join(project.path, 'AGENTS.md')),
      contract: pg.contract ?? null,
      // config.json is deprecated (deprecate-harness-config-json-2026-06-06): serve
      // only the PG copy; no fall-back read of the on-disk tombstone file.
      config: pg.config ?? null,
      version: pg.version,
    });
  },
});

const putSpec = defineTool({
  method: 'PUT',
  path: '/harness/:slug/spec',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const url = new URL(req.url);
    const project = await resolvePhasedProject(slug, phasePhaseLabel(url.searchParams.get('phase') ?? undefined));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const body = (await req.json()) as {
      spec?: string; agents?: string; contract?: string; config?: string;
      expected_version?: number;
    };

    let saved: { version: number };
    try {
      saved = await saveProjectFiles(slug, body, { expectedVersion: body.expected_version });
    } catch (err) {
      if (err instanceof ProjectFilesVersionConflict) {
        return Response.json({
          ok: false,
          error: 'version_conflict',
          expected: body.expected_version,
          current: err.currentVersion,
          detail: err.message,
        }, { status: 409 });
      }
      throw err;
    }

    // SPEC.md + validation-contract.md disk mirrors dropped — both deprecated
    // (D-004/D-005); only AGENTS.md / config.json are mirrored to disk now.
    const targets: Array<{ path: string; content: string | undefined; label: string }> = [
      { path: join(project.path, 'AGENTS.md'), content: body.agents, label: 'agents' },
      { path: join(harnessDir(project), 'config.json'), content: body.config, label: 'config' },
    ];

    const written: string[] = [];
    for (const t of targets) {
      if (typeof t.content !== 'string') continue;
      const tmp = `${t.path}.tmp.${Date.now()}`;
      try {
        await writeFile(tmp, t.content, 'utf8');
        await rename(tmp, t.path);
        written.push(t.label);
      } catch { /* mirror is best-effort; PG already has it */ }
    }

    // Invalidate sync queries when config.json is saved (data-sync migration P-009)
    if (body.config !== undefined) {
      const { notifySyncInvalidate } = await import('../../../sync-sse');
      // Invalidate both harnessProjectFiles (config) and discordConfig (which extracts discord from config)
      await Promise.all([
        notifySyncInvalidate('harnessProjectFiles.byHarness', { harnessSlug: slug }),
        notifySyncInvalidate('discordConfig.byHarness', { harnessSlug: slug }),
      ]);
    }

    return Response.json({ ok: true, written, version: saved.version });
  },
});

export default [getSpec, putSpec];
