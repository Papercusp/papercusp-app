/**
 * One-shot: load each project's `.papercusp/issues.json` into
 * `harness_<slug>.harness_issues` in the papercusp database.
 *
 * Idempotent — uses `ON CONFLICT (harness_slug, issue_id) DO UPDATE`.
 *
 * Run with:
 *   tsx scripts/migrate-issues-to-pg.ts                # all projects in registry
 *   tsx scripts/migrate-issues-to-pg.ts <slug> [<slug>...]  # specific slugs
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import postgres from 'postgres';
import { resolveScriptPgUrl } from './lib/pg-url.mjs';

interface ProjectEntry {
  slug: string;
  path: string;
}

interface Issue {
  id: string;
  title: string;
  severity: string;
  source: string;
  foundAt: string;
  foundDuring?: string;
  status: string;
  repro?: string;
  evidence?: string;
  suggestedFix?: string;
  codePointer?: string;
  linkedFeatureId?: string;
  attempts: number;
  notes: unknown[];
}

interface IssuesFile {
  issues: Issue[];
  nextId: number;
}

const PG_URL = resolveScriptPgUrl().url;

function slugToSchema(slug: string): string {
  return 'harness_' + slug.toLowerCase().replace(/-/g, '_');
}

async function loadRegistry(): Promise<ProjectEntry[]> {
  const raw = await readFile(
    join(homedir(), '.restart-harness-projects.json'),
    'utf8',
  );
  const parsed = JSON.parse(raw) as { projects: ProjectEntry[] };
  return parsed.projects;
}

async function migrateOne(
  sql: postgres.Sql,
  project: ProjectEntry,
): Promise<{ slug: string; loaded: number; skipped: string | null }> {
  const file = join(project.path, '.papercusp', 'issues.json');
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return { slug: project.slug, loaded: 0, skipped: 'no issues.json' };
  }
  let parsed: IssuesFile;
  try {
    parsed = JSON.parse(raw) as IssuesFile;
  } catch (e) {
    return { slug: project.slug, loaded: 0, skipped: `parse: ${String(e)}` };
  }
  const issues = parsed.issues ?? [];
  if (issues.length === 0) {
    return { slug: project.slug, loaded: 0, skipped: 'empty' };
  }
  const schema = slugToSchema(project.slug);
  const exists = await sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = ${schema} AND table_name = 'harness_issues'
  `;
  if (exists.length === 0) {
    return { slug: project.slug, loaded: 0, skipped: `schema ${schema} has no harness_issues` };
  }
  const now = Date.now();
  const rows = issues.map((i) => ({
    harness_slug: project.slug,
    issue_id: i.id,
    title: i.title,
    severity: i.severity,
    source: i.source,
    status: i.status,
    found_at: i.foundAt,
    found_during: i.foundDuring ?? null,
    repro: i.repro ?? null,
    evidence: i.evidence ?? null,
    suggested_fix: i.suggestedFix ?? null,
    code_pointer: i.codePointer ?? null,
    linked_feature_id: i.linkedFeatureId ?? null,
    attempts: i.attempts ?? 0,
    notes: JSON.stringify(i.notes ?? []),
    created_ts: now,
    updated_ts: now,
  }));
  await sql.unsafe(
    `INSERT INTO ${schema}.harness_issues
       (harness_slug, issue_id, title, severity, source, status, found_at,
        found_during, repro, evidence, suggested_fix, code_pointer,
        linked_feature_id, attempts, notes, created_ts, updated_ts)
     VALUES ${rows
       .map(
         (_, i) =>
           `($${i * 17 + 1},$${i * 17 + 2},$${i * 17 + 3},$${i * 17 + 4},$${i * 17 + 5},$${i * 17 + 6},$${i * 17 + 7},$${i * 17 + 8},$${i * 17 + 9},$${i * 17 + 10},$${i * 17 + 11},$${i * 17 + 12},$${i * 17 + 13},$${i * 17 + 14},$${i * 17 + 15}::jsonb,$${i * 17 + 16},$${i * 17 + 17})`,
       )
       .join(',')}
     ON CONFLICT (harness_slug, issue_id) DO UPDATE SET
       title = EXCLUDED.title,
       severity = EXCLUDED.severity,
       source = EXCLUDED.source,
       status = EXCLUDED.status,
       found_at = EXCLUDED.found_at,
       found_during = EXCLUDED.found_during,
       repro = EXCLUDED.repro,
       evidence = EXCLUDED.evidence,
       suggested_fix = EXCLUDED.suggested_fix,
       code_pointer = EXCLUDED.code_pointer,
       linked_feature_id = EXCLUDED.linked_feature_id,
       attempts = EXCLUDED.attempts,
       notes = EXCLUDED.notes,
       updated_ts = EXCLUDED.updated_ts`,
    rows.flatMap((r) => [
      r.harness_slug, r.issue_id, r.title, r.severity, r.source, r.status,
      r.found_at, r.found_during, r.repro, r.evidence, r.suggested_fix,
      r.code_pointer, r.linked_feature_id, r.attempts, r.notes,
      r.created_ts, r.updated_ts,
    ]),
  );
  return { slug: project.slug, loaded: rows.length, skipped: null };
}

async function main() {
  const argv = process.argv.slice(2);
  const projects = await loadRegistry();
  const targets = argv.length > 0
    ? projects.filter((p) => argv.includes(p.slug))
    : projects;
  if (targets.length === 0) {
    console.error('no matching projects');
    process.exit(1);
  }
  const sql = postgres(PG_URL, { onnotice: () => {} });
  try {
    for (const p of targets) {
      const result = await migrateOne(sql, p);
      if (result.skipped) {
        console.log(`SKIP ${result.slug.padEnd(20)}  ${result.skipped}`);
      } else {
        console.log(`OK   ${result.slug.padEnd(20)}  loaded ${result.loaded} issues`);
      }
    }
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
