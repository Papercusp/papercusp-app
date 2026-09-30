/**
 * Per-harness iteration snapshots (`.papercusp/snapshots/<ts>-iter-<n>/`):
 *
 *   GET    /api/harness/:slug/snapshots                      — list
 *   POST   /api/harness/:slug/snapshots/:id/record-pg-state  — capture work queue
 *   POST   /api/harness/:slug/snapshots/:id/restore          — roll back FS + queue
 *   DELETE /api/harness/:slug/snapshots/:id                  — drop FS dir + PG rows
 *
 * Snapshot dirs live on disk; metadata + the per-snapshot feature queue
 * mirror to `harness_shared.snapshot_features` / `harness_snapshots`.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 13).
 */
import { existsSync, readdirSync } from 'node:fs';
import { copyFile, rename, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getOrgPg, getHarnessPg } from '@papercusp/db-org';
import { resolvePhasedProject, harnessDir } from '../../../harness-core';
import { phasePhaseLabel } from '../../../harness-phases';
import { SNAPSHOT_FILES } from '../../../harness-state-files';
import type { ProjectEntry } from '../../../harness-registry';
import { defineTool } from '@papercusp/agent-mcp';

function phaseFromReq(req: Request) {
  return phasePhaseLabel(new URL(req.url).searchParams.get('phase') ?? undefined);
}

interface SnapshotMeta {
  id: string;
  ts: number;
  iterNum: number;
  files: string[];
  featureCounts: Record<string, number>;
}

async function scanSnapshots(project: ProjectEntry): Promise<SnapshotMeta[]> {
  const snapDir = join(harnessDir(project), 'snapshots');
  if (!existsSync(snapDir)) return [];
  // Aggregate featureCounts from harness_shared.snapshot_features in one
  // query. Snapshots without PG rows get an empty count map (legacy or
  // pre-mirror snapshots — listable from FS only).
  const countsBySnapshot: Map<string, Record<string, number>> = new Map();
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ snapshot_id: string; status: string; n: string }[]>`
      SELECT snapshot_id, status, COUNT(*)::text AS n
      FROM harness_shared.snapshot_features
      WHERE harness_slug = ${project.slug}
      GROUP BY snapshot_id, status
    `;
    for (const r of rows) {
      const m = countsBySnapshot.get(r.snapshot_id) ?? {};
      m[r.status] = Number(r.n);
      countsBySnapshot.set(r.snapshot_id, m);
    }
  } catch { /* PG unavailable — snapshots still listable from FS */ }
  return readdirSync(snapDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const id = d.name;
      const match = id.match(/^(\d+)-iter-(\d+)$/);
      const ts = match ? Number(match[1]) * 1000 : 0;
      const iterNum = match ? Number(match[2]) : 0;
      const dirPath = join(snapDir, id);
      const files: string[] = [];
      for (const f of SNAPSHOT_FILES) {
        if (existsSync(join(dirPath, f))) files.push(f);
      }
      const featureCounts: Record<string, number> = countsBySnapshot.get(id) ?? {};
      return { id, ts, iterNum, files, featureCounts };
    })
    .filter((s) => s.ts > 0)
    .sort((a, b) => b.ts - a.ts);
}

/**
 * Mirror snapshot metadata into harness_<slug>.harness_snapshots.
 * Bulk upsert + tombstone for missing rows.
 */
async function syncSnapshotsToPg(project: ProjectEntry, snaps: SnapshotMeta[]): Promise<void> {
  const { sql } = getHarnessPg(project.slug);
  const now = Date.now();
  if (snaps.length > 0) {
    const rows = snaps.map((s) => ({
      harness_slug: project.slug,
      snapshot_id: s.id,
      ts: s.ts,
      iter_num: s.iterNum,
      files: JSON.stringify(s.files),
      feature_counts: JSON.stringify(s.featureCounts),
      created_ts: now,
      updated_ts: now,
    }));
    await sql`
      INSERT INTO harness_snapshots ${sql(rows, 'harness_slug', 'snapshot_id', 'ts', 'iter_num', 'files', 'feature_counts', 'created_ts', 'updated_ts')}
      ON CONFLICT (harness_slug, snapshot_id) DO UPDATE SET
        ts = EXCLUDED.ts,
        iter_num = EXCLUDED.iter_num,
        files = EXCLUDED.files,
        feature_counts = EXCLUDED.feature_counts,
        updated_ts = EXCLUDED.updated_ts
    `;
    const ids = snaps.map((s) => s.id);
    await sql`
      DELETE FROM harness_snapshots
      WHERE harness_slug = ${project.slug}
        AND snapshot_id NOT IN ${sql(ids)}
    `;
  } else {
    await sql`DELETE FROM harness_snapshots WHERE harness_slug = ${project.slug}`;
  }
}

const getSnapshots = defineTool({
  method: 'GET',
  path: '/harness/:slug/snapshots',
  auth: 'public',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const snapshots = await scanSnapshots(project);
    syncSnapshotsToPg(project, snapshots).catch((err) => {
      console.error(`[snapshots] PG sync failed for ${project.slug}:`, err);
    });
    return Response.json({ snapshots });
  },
});

const recordPgState = defineTool({
  method: 'POST',
  path: '/harness/:slug/snapshots/:id/record-pg-state',
  auth: 'loopback',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const id = String(ctx.params.id).replace(/[^A-Za-z0-9_-]/g, '');
    if (!id || !/^\d+-iter-\d+$/.test(id)) {
      return Response.json({ error: 'invalid snapshot id' }, { status: 400 });
    }
    try {
      const { sql } = getHarnessPg(project.slug);
      const now = Date.now();
      await sql.begin(async (tx) => {
        await tx`DELETE FROM harness_shared.snapshot_features WHERE harness_slug = ${project.slug} AND snapshot_id = ${id}`;
        await tx`
          INSERT INTO harness_shared.snapshot_features (
            harness_slug, snapshot_id, feature_id,
            title, summary, status, attempts, claims, notes, metadata, kind,
            project_id, expected_cost_cents, tags, needs_human_review,
            deprecation_reason, parent_id, goal_id, ts, created_ts
          )
          SELECT
            harness_slug, ${id}::TEXT, feature_id,
            title, summary, status, attempts, claims, notes, metadata, kind,
            project_id, expected_cost_cents, tags, needs_human_review,
            deprecation_reason, parent_id, goal_id, ts, ${now}::BIGINT
          FROM harness_features
        `;
      });
      return Response.json({ ok: true });
    } catch (e: any) {
      return Response.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
    }
  },
});

const restoreSnapshot = defineTool({
  method: 'POST',
  path: '/harness/:slug/snapshots/:id/restore',
  auth: 'loopback',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const id = String(ctx.params.id).replace(/[^A-Za-z0-9_-]/g, '');
    if (!id || !/^\d+-iter-\d+$/.test(id)) {
      return Response.json({ error: 'invalid snapshot id' }, { status: 400 });
    }
    const snapDir = join(harnessDir(project), 'snapshots', id);
    if (!existsSync(snapDir)) return Response.json({ error: 'snapshot not found' }, { status: 404 });

    const body = (await req.json().catch(() => ({}))) as {
      includeSupervisorNotes?: boolean; includeConfig?: boolean; includeFeatures?: boolean;
    };
    const includeSupervisorNotes = body.includeSupervisorNotes !== false;
    const includeConfig = body.includeConfig !== false;
    const includeFeatures = body.includeFeatures !== false;

    const restored: string[] = [];
    for (const f of SNAPSHOT_FILES) {
      if (f === 'supervisor-notes.md' && !includeSupervisorNotes) continue;
      if (f === 'config.json' && !includeConfig) continue;
      if (f === 'features.json') continue; // legacy — superseded by PG restore below
      const src = join(snapDir, f);
      if (!existsSync(src)) continue;
      const dest = join(harnessDir(project), f);
      const tmp = `${dest}.tmp.${Date.now()}`;
      await copyFile(src, tmp);
      await rename(tmp, dest);
      restored.push(f);
    }

    // PG round-trip for the work queue, transactional.
    let featuresRestored = 0;
    if (includeFeatures) {
      try {
        const { sql } = getHarnessPg(project.slug);
        await sql.begin(async (tx) => {
          const exists = await tx<{ n: number }[]>`
            SELECT COUNT(*)::int AS n
            FROM harness_shared.snapshot_features
            WHERE harness_slug = ${project.slug} AND snapshot_id = ${id}
          `;
          if (exists[0].n === 0) {
            // Legacy snapshot (pre-PG-mirror). Leave the queue alone.
            return;
          }
          await tx`DELETE FROM harness_features WHERE harness_slug = ${project.slug}`;
          await tx`
            INSERT INTO harness_features (
              harness_slug, feature_id,
              title, summary, status, attempts, claims, notes, metadata, kind,
              project_id, expected_cost_cents, tags, needs_human_review,
              deprecation_reason, parent_id, goal_id, ts, created_ts, updated_ts
            )
            SELECT
              harness_slug, feature_id,
              title, summary, status, attempts, claims, notes, metadata, kind,
              project_id, expected_cost_cents, tags, needs_human_review,
              deprecation_reason, parent_id, goal_id, ts, created_ts, ${Date.now()}::BIGINT
            FROM harness_shared.snapshot_features
            WHERE harness_slug = ${project.slug} AND snapshot_id = ${id}
          `;
          featuresRestored = exists[0].n;
        });
        if (featuresRestored > 0) restored.push(`harness_features (${featuresRestored} rows)`);
      } catch (e) {
        console.error(`[snapshots] PG restore failed for ${project.slug}:${id}:`, e);
        return Response.json({ ok: false, error: 'work queue restore failed; FS files restored', restored }, { status: 500 });
      }
    }

    return Response.json({ ok: true, restored, featuresRestored });
  },
});

const deleteSnapshot = defineTool({
  method: 'DELETE',
  path: '/harness/:slug/snapshots/:id',
  auth: 'loopback',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const id = String(ctx.params.id).replace(/[^A-Za-z0-9_-]/g, '');
    if (!id || !/^\d+-iter-\d+$/.test(id)) {
      return Response.json({ error: 'invalid snapshot id' }, { status: 400 });
    }
    const snapDir = join(harnessDir(project), 'snapshots', id);
    if (!existsSync(snapDir)) return Response.json({ ok: true, deleted: false });
    for (const f of SNAPSHOT_FILES) {
      try { await unlink(join(snapDir, f)); } catch {}
    }
    try { await rmdir(snapDir); } catch {}
    // Also drop any PG rows for this snapshot (no-op for legacy ones).
    try {
      const { sql } = getHarnessPg(project.slug);
      await sql`DELETE FROM harness_shared.snapshot_features WHERE harness_slug = ${project.slug} AND snapshot_id = ${id}`;
    } catch (e) {
      console.warn(`[snapshots] PG cleanup failed for ${project.slug}:${id}:`, (e as Error)?.message);
    }
    return Response.json({ ok: true, deleted: true });
  },
});

export default [getSnapshots, recordPgState, restoreSnapshot, deleteSnapshot];
