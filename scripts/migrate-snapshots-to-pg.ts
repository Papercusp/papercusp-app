/**
 * One-shot: scan each project's `.papercusp/snapshots/<id>/` directories and
 * load metadata into `harness_<slug>.harness_snapshots`.
 *
 * The directory contents (config.json, features.json, supervisor-notes.md,
 * validation-contract.md) stay on disk; PG holds the queryable metadata
 * (id, ts, iter_num, files present, feature counts) so SnapshotsPanel can
 * subscribe via Zero.
 *
 * Idempotent — `ON CONFLICT (harness_slug, snapshot_id) DO UPDATE`.
 *
 * Run with:
 *   tsx scripts/migrate-snapshots-to-pg.ts                       # all
 *   tsx scripts/migrate-snapshots-to-pg.ts <slug> [<slug>...]    # specific
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import postgres from 'postgres';
import { resolveScriptPgUrl } from './lib/pg-url.mjs';

interface ProjectEntry {
  slug: string;
  path: string;
}

const PG_URL = resolveScriptPgUrl().url;

const SNAPSHOT_FILES = [
  'features.json', 'validation-contract.md', 'supervisor-notes.md', 'config.json',
] as const;

function slugToSchema(slug: string): string {
  return 'harness_' + slug.toLowerCase().replace(/-/g, '_');
}

interface SnapMeta {
  snapshot_id: string;
  ts: number;
  iter_num: number;
  files: string[];
  feature_counts: Record<string, number>;
}

function scanSnapshots(projectPath: string): SnapMeta[] {
  const snapDir = join(projectPath, '.papercusp', 'snapshots');
  if (!existsSync(snapDir)) return [];
  const out: SnapMeta[] = [];
  for (const ent of readdirSync(snapDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const id = ent.name;
    const m = id.match(/^(\d+)-iter-(\d+)$/);
    if (!m) continue;
    const ts = Number(m[1]) * 1000;
    const iterNum = Number(m[2]);
    const dirPath = join(snapDir, id);
    const files: string[] = [];
    for (const f of SNAPSHOT_FILES) {
      if (existsSync(join(dirPath, f))) files.push(f);
    }
    const featureCounts: Record<string, number> = {};
    try {
      const raw = readFileSync(join(dirPath, 'features.json'), 'utf8');
      const parsed = JSON.parse(raw);
      for (const feat of parsed.features ?? []) {
        const s = feat.status ?? 'todo';
        featureCounts[s] = (featureCounts[s] ?? 0) + 1;
      }
    } catch {}
    out.push({ snapshot_id: id, ts, iter_num: iterNum, files, feature_counts: featureCounts });
  }
  return out;
}

async function loadProjects(): Promise<ProjectEntry[]> {
  const registry = join(homedir(), '.restart-harness-projects.json');
  if (!existsSync(registry)) return [];
  const raw = readFileSync(registry, 'utf8');
  const parsed = JSON.parse(raw) as { projects?: Array<{ slug: string; path: string }> };
  return parsed.projects ?? [];
}

async function main() {
  const argSlugs = process.argv.slice(2);
  const all = await loadProjects();
  const projects = argSlugs.length > 0
    ? all.filter((p) => argSlugs.includes(p.slug))
    : all;
  if (projects.length === 0) {
    console.error('no matching projects in registry');
    process.exit(1);
  }

  const sql = postgres(PG_URL, { onnotice: () => {} });
  const now = Date.now();
  let totalRows = 0;

  try {
    for (const project of projects) {
      const schema = slugToSchema(project.slug);
      const snaps = scanSnapshots(project.path);
      console.log(`[${project.slug}] scanned ${snaps.length} snapshots`);
      if (snaps.length === 0) continue;

      const rows = snaps.map((s) => ({
        harness_slug: project.slug,
        snapshot_id: s.snapshot_id,
        ts: s.ts,
        iter_num: s.iter_num,
        files: JSON.stringify(s.files),
        feature_counts: JSON.stringify(s.feature_counts),
        created_ts: now,
        updated_ts: now,
      }));

      await sql`SET search_path TO ${sql(schema)}`;
      await sql`
        INSERT INTO harness_snapshots ${sql(rows, 'harness_slug', 'snapshot_id', 'ts', 'iter_num', 'files', 'feature_counts', 'created_ts', 'updated_ts')}
        ON CONFLICT (harness_slug, snapshot_id) DO UPDATE SET
          ts = EXCLUDED.ts,
          iter_num = EXCLUDED.iter_num,
          files = EXCLUDED.files,
          feature_counts = EXCLUDED.feature_counts,
          updated_ts = EXCLUDED.updated_ts
      `;
      const result = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM harness_snapshots WHERE harness_slug = ${project.slug}
      `;
      const count = Number(result[0]?.count ?? 0);
      console.log(`[${project.slug}] ${schema}.harness_snapshots → ${count} rows`);
      totalRows += count;
    }
  } finally {
    await sql.end();
  }

  console.log(`✓ migrated ${totalRows} snapshot rows total`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
