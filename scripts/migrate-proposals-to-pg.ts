/**
 * One-shot: scan each project's `.papercusp/proposals/` directory and load
 * the metadata (id, status, ts, review verdict, summary) into
 * `harness_<slug>.harness_proposals`.
 *
 * Body content stays on disk. PG holds queryable metadata for Zero subs.
 * Idempotent — `ON CONFLICT (harness_slug, proposal_id) DO UPDATE`.
 *
 * Run with:
 *   tsx scripts/migrate-proposals-to-pg.ts                        # all
 *   tsx scripts/migrate-proposals-to-pg.ts <slug> [<slug>...]     # specific
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import postgres from 'postgres';
import { resolveScriptPgUrl } from './lib/pg-url.mjs';

interface ProjectEntry {
  slug: string;
  path: string;
}

const PG_URL = resolveScriptPgUrl().url;

function slugToSchema(slug: string): string {
  return 'harness_' + slug.toLowerCase().replace(/-/g, '_');
}

function safeRead(p: string): string | null {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

interface ProposalEntry {
  id: string;
  sizeBytes: number;
  ts: number;
  status: 'pending' | 'applied' | 'rejected';
  reviewVerdict: 'accept' | 'reject' | 'defer' | null;
  reviewedAt: number | null;
  reviewSummary: string | null;
}

function scanProposalsDir(projectPath: string): ProposalEntry[] {
  const dir = join(projectPath, '.papercusp', 'proposals');
  if (!existsSync(dir)) return [];
  const allFiles = readdirSync(dir);
  const reviewSet = new Set(allFiles.filter((f) => f.endsWith('.review.md')));
  return allFiles
    .filter((f) => f.endsWith('.md') && !f.endsWith('.review.md'))
    .map((f): ProposalEntry => {
      const full = join(dir, f);
      let size = 0, ts = 0;
      try { const s = statSync(full); size = s.size; ts = Math.floor(s.mtimeMs); } catch {}
      const body = safeRead(full) ?? '';
      const applied = /^applied:\s*true/m.test(body);
      const rejected = /^rejected:\s*true/m.test(body);
      const status: ProposalEntry['status'] = applied ? 'applied' : rejected ? 'rejected' : 'pending';
      const reviewName = `${f.replace(/\.md$/, '')}.review.md`;
      let reviewVerdict: ProposalEntry['reviewVerdict'] = null;
      let reviewedAt: number | null = null;
      let reviewSummary: string | null = null;
      if (reviewSet.has(reviewName)) {
        const reviewPath = join(dir, reviewName);
        const reviewBody = safeRead(reviewPath) ?? '';
        const m = reviewBody.match(/^VERDICT:\s*(accept|reject|defer)\b/im);
        if (m) {
          const v = m[1].toLowerCase();
          if (v === 'accept' || v === 'reject' || v === 'defer') reviewVerdict = v;
        }
        try { reviewedAt = Math.floor(statSync(reviewPath).mtimeMs); } catch {}
        const summaryLine = reviewBody
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l.length > 0 && !/^VERDICT:/i.test(l) && !/^#/.test(l));
        reviewSummary = summaryLine ? summaryLine.slice(0, 240) : null;
      }
      return { id: f, sizeBytes: size, ts, status, reviewVerdict, reviewedAt, reviewSummary };
    });
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
  const items = scanProposalsDir(project.path);
  if (items.length === 0) {
    return { slug: project.slug, loaded: 0, skipped: 'no proposals dir or empty' };
  }
  const schema = slugToSchema(project.slug);
  const exists = await sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = ${schema} AND table_name = 'harness_proposals'
  `;
  if (exists.length === 0) {
    return { slug: project.slug, loaded: 0, skipped: `schema ${schema} has no harness_proposals` };
  }
  const now = Date.now();
  const rows = items.map((p) => ({
    harness_slug: project.slug,
    proposal_id: p.id,
    size_bytes: p.sizeBytes,
    status: p.status,
    review_verdict: p.reviewVerdict,
    review_summary: p.reviewSummary,
    reviewed_at: p.reviewedAt,
    ts: p.ts,
    created_ts: now,
    updated_ts: now,
  }));
  await sql.unsafe(
    `INSERT INTO ${schema}.harness_proposals
       (harness_slug, proposal_id, size_bytes, status, review_verdict,
        review_summary, reviewed_at, ts, created_ts, updated_ts)
     VALUES ${rows
       .map((_, i) =>
         `($${i * 10 + 1},$${i * 10 + 2},$${i * 10 + 3},$${i * 10 + 4},$${i * 10 + 5},$${i * 10 + 6},$${i * 10 + 7},$${i * 10 + 8},$${i * 10 + 9},$${i * 10 + 10})`,
       )
       .join(',')}
     ON CONFLICT (harness_slug, proposal_id) DO UPDATE SET
       size_bytes      = EXCLUDED.size_bytes,
       status          = EXCLUDED.status,
       review_verdict  = EXCLUDED.review_verdict,
       review_summary  = EXCLUDED.review_summary,
       reviewed_at     = EXCLUDED.reviewed_at,
       ts              = EXCLUDED.ts,
       updated_ts      = EXCLUDED.updated_ts`,
    rows.flatMap((r) => [
      r.harness_slug, r.proposal_id, r.size_bytes, r.status, r.review_verdict,
      r.review_summary, r.reviewed_at, r.ts, r.created_ts, r.updated_ts,
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
        console.log(`OK   ${result.slug.padEnd(20)}  loaded ${result.loaded} proposals`);
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
