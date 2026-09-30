#!/usr/bin/env node
/**
 * backfill-disk-files-into-text-artifacts.ts — Phase 0d migration.
 *
 * For each harness in the registry, copy these files into
 * harness_shared.harness_text_artifacts:
 *   - <harness_dir>/knowledge.md      → rel_path = 'knowledge.md'
 *   - <project.path>/.mcp.json        → rel_path = 'mcp.json'
 *   - <project.path>/.claude/settings.json → rel_path = 'claude-settings.json'
 *
 * Idempotence policy:
 *   - Skip when the PG row's updated_at >= the file's mtime
 *     (PG was written more recently — never clobber).
 *   - Skip when PG content is non-empty AND byte-equals the file content.
 *   - Otherwise upsert: PG.updated_at = file.mtime.
 *
 * Usage:
 *   tsx libs/db/scripts/backfill-disk-files-into-text-artifacts.ts --dry-run
 *   tsx libs/db/scripts/backfill-disk-files-into-text-artifacts.ts --apply
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

const DRY_RUN = process.argv.includes('--dry-run');
const APPLY = process.argv.includes('--apply');

if (!DRY_RUN && !APPLY) {
  console.error('Usage: backfill-disk-files-into-text-artifacts.ts --dry-run | --apply');
  process.exit(2);
}

interface FileSpec {
  relPath: string;                     // text-artifacts key
  diskPathFor: (project: ProjectEntry) => string;
}

interface ProjectEntry {
  slug: string;
  path: string;
  workspaceId: string;
}

const FILES: FileSpec[] = [
  {
    relPath: 'knowledge.md',
    diskPathFor: (p) => join(p.path, '.papercusp', 'knowledge.md'),
  },
  {
    relPath: 'mcp.json',
    diskPathFor: (p) => join(p.path, '.mcp.json'),
  },
  {
    relPath: 'claude-settings.json',
    diskPathFor: (p) => join(p.path, '.claude', 'settings.json'),
  },
];

async function loadHarnesses(sql: ReturnType<typeof postgres>): Promise<ProjectEntry[]> {
  // harness_shared.harness_registry holds one row per workspace; payload
  // contains a `projects` array. Walk every row to enumerate every (slug, path).
  const rows = await sql<{ workspace_id: string; payload: { projects?: { slug: string; path: string }[] } }[]>`
    SELECT workspace_id, payload FROM harness_shared.harness_registry
  `;
  const out: ProjectEntry[] = [];
  for (const r of rows) {
    for (const p of r.payload?.projects ?? []) {
      out.push({ slug: p.slug, path: p.path, workspaceId: r.workspace_id });
    }
  }
  return out;
}

interface PlanEntry {
  slug: string;
  workspaceId: string;
  relPath: string;
  diskPath: string;
  fileMtimeMs: number;
  fileSize: number;
  pgUpdatedAt: number | null;
  pgContentLen: number | null;
  decision: 'upsert' | 'skip-pg-newer' | 'skip-content-match' | 'skip-no-file';
}

async function main() {
  const url = process.env.HARNESS_ADMIN_DATABASE_URL ?? 'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';
  const sql = postgres(url, { onnotice: () => {} });

  try {
    const projects = await loadHarnesses(sql);
    console.log(`[backfill-disk-files] found ${projects.length} harness(es) across registries`);
    const plan: PlanEntry[] = [];

    for (const p of projects) {
      for (const spec of FILES) {
        const diskPath = spec.diskPathFor(p);
        if (!existsSync(diskPath)) {
          plan.push({
            slug: p.slug, workspaceId: p.workspaceId, relPath: spec.relPath,
            diskPath, fileMtimeMs: 0, fileSize: 0, pgUpdatedAt: null, pgContentLen: null,
            decision: 'skip-no-file',
          });
          continue;
        }
        const stat = statSync(diskPath);
        const fileContent = readFileSync(diskPath, 'utf8');
        const rows = await sql<{ content: string; updated_at: number }[]>`
          SELECT content, updated_at FROM harness_shared.harness_text_artifacts
           WHERE harness_slug = ${p.slug} AND rel_path = ${spec.relPath}
           LIMIT 1
        `;
        const existing = rows[0];
        let decision: PlanEntry['decision'] = 'upsert';
        if (existing) {
          if (existing.updated_at >= Math.floor(stat.mtimeMs)) {
            decision = 'skip-pg-newer';
          } else if (existing.content && existing.content === fileContent) {
            decision = 'skip-content-match';
          }
        }
        plan.push({
          slug: p.slug, workspaceId: p.workspaceId, relPath: spec.relPath,
          diskPath, fileMtimeMs: Math.floor(stat.mtimeMs), fileSize: stat.size,
          pgUpdatedAt: existing?.updated_at ?? null,
          pgContentLen: existing?.content?.length ?? null,
          decision,
        });
      }
    }

    // Print plan
    let upserts = 0, skips = 0;
    for (const e of plan) {
      const tag = e.decision === 'upsert' ? 'UPSERT' : `SKIP(${e.decision.replace('skip-', '')})`;
      console.log(`  ${tag}  ${e.slug}/${e.relPath}  size=${e.fileSize}  fileMtime=${e.fileMtimeMs}  pgTs=${e.pgUpdatedAt ?? 'none'}`);
      if (e.decision === 'upsert') upserts++; else skips++;
    }
    console.log(`\n[summary] ${upserts} upsert(s), ${skips} skip(s)`);

    if (DRY_RUN) {
      console.log('\n[dry-run] no writes performed.');
      return;
    }

    // Apply
    for (const e of plan) {
      if (e.decision !== 'upsert') continue;
      const content = readFileSync(e.diskPath, 'utf8');
      await sql`
        INSERT INTO harness_shared.harness_text_artifacts (harness_slug, rel_path, content, updated_at, workspace_id)
        VALUES (${e.slug}, ${e.relPath}, ${content}, ${e.fileMtimeMs}, ${e.workspaceId})
        ON CONFLICT (harness_slug, rel_path) DO UPDATE SET
          content    = EXCLUDED.content,
          updated_at = EXCLUDED.updated_at
      `;
    }
    console.log(`\n[apply] wrote ${upserts} row(s).`);
  } finally {
    await sql.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
