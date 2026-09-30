/**
 * One-shot: scan each project's `.papercusp/logs/*.jsonl` and load metadata
 * into `harness_<slug>.agent_runs`.
 *
 * Body (.out + .jsonl) stays on disk; PG holds the queryable metadata
 * (role, feature_id, ts, cost/tokens, running, last_event_ts) so both
 * RecentAgentsTable and UsagePanel can subscribe via Zero.
 *
 * Idempotent — `ON CONFLICT (harness_slug, run_id) DO UPDATE`.
 *
 * Run with:
 *   tsx scripts/migrate-agent-runs-to-pg.ts                       # all
 *   tsx scripts/migrate-agent-runs-to-pg.ts <slug> [<slug>...]    # specific
 */
import {
  closeSync, existsSync, openSync, readdirSync, readSync, statSync,
} from 'node:fs';
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

const LIVE_MTIME_GRACE_MS = 5 * 60_000;

function slugToSchema(slug: string): string {
  return 'harness_' + slug.toLowerCase().replace(/-/g, '_');
}

interface AgentRun {
  run_id: string;
  role: string;
  feature_id: string | null;
  ts: number;
  size_bytes: number;
  duration_ms: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  running: boolean;
  last_event_ts: number;
}

function probeRunLiveness(jsonlPath: string, now: number): { running: boolean; lastEventTs: number } {
  if (!existsSync(jsonlPath)) return { running: false, lastEventTs: 0 };
  const stat = statSync(jsonlPath);
  const lastEventTs = stat.mtimeMs;
  const size = stat.size;
  if (size === 0) return { running: now - lastEventTs < LIVE_MTIME_GRACE_MS, lastEventTs };
  const tailSize = Math.min(size, 4096);
  const fd = openSync(jsonlPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(tailSize);
    readSync(fd, buf, 0, tailSize, size - tailSize);
    const tail = buf.toString('utf8');
    const lines = tail.split('\n').map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes('"type":"result"')) return { running: false, lastEventTs };
    }
    return { running: now - lastEventTs < LIVE_MTIME_GRACE_MS, lastEventTs };
  } finally { closeSync(fd); }
}

function scanRuns(projectPath: string): AgentRun[] {
  const logDir = join(projectPath, '.papercusp', 'logs');
  if (!existsSync(logDir)) return [];
  const now = Date.now();
  const out: AgentRun[] = [];
  for (const f of readdirSync(logDir)) {
    if (!f.endsWith('.jsonl')) continue;
    const base = f.replace(/\.jsonl$/, '');
    const match = base.match(/^(\d+)-([a-z]+)(?:-(F-[A-Z0-9-]+))?$/);
    const jsonlPath = join(logDir, f);
    let jsonlMtime = 0;
    try { jsonlMtime = Math.floor(statSync(jsonlPath).mtimeMs); } catch {}
    const outPath = join(logDir, `${base}.out`);
    let outSize = 0;
    try { if (existsSync(outPath)) outSize = statSync(outPath).size; } catch {}
    const { running, lastEventTs } = probeRunLiveness(jsonlPath, now);
    let costUsd = 0, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0, durationMs = 0;
    try {
      const stat = statSync(jsonlPath);
      const tailSize = Math.min(stat.size, 16384);
      if (tailSize > 0) {
        const fd = openSync(jsonlPath, 'r');
        try {
          const buf = Buffer.allocUnsafe(tailSize);
          readSync(fd, buf, 0, tailSize, stat.size - tailSize);
          const lines = buf.toString('utf8').split('\n').filter(Boolean);
          for (let i = lines.length - 1; i >= 0; i--) {
            if (!lines[i].includes('"type":"result"')) continue;
            try {
              const obj = JSON.parse(lines[i]);
              if (obj.type === 'result') {
                costUsd = obj.total_cost_usd ?? 0;
                inputTokens = obj.usage?.input_tokens ?? 0;
                outputTokens = obj.usage?.output_tokens ?? 0;
                cacheReadTokens = obj.usage?.cache_read_input_tokens ?? 0;
                cacheCreationTokens = obj.usage?.cache_creation_input_tokens ?? 0;
                durationMs = obj.duration_ms ?? 0;
                break;
              }
            } catch {}
          }
        } finally { closeSync(fd); }
      }
    } catch {}
    out.push({
      run_id: base,
      role: match ? match[2] : 'unknown',
      feature_id: (match && match[3]) || null,
      ts: match ? Number(match[1]) * 1000 : jsonlMtime,
      size_bytes: outSize,
      duration_ms: durationMs,
      cost_usd: costUsd,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheReadTokens,
      cache_creation_tokens: cacheCreationTokens,
      running,
      last_event_ts: Math.floor(lastEventTs || jsonlMtime),
    });
  }
  return out;
}

async function loadRegistry(): Promise<ProjectEntry[]> {
  const raw = await readFile(join(homedir(), '.restart-harness-projects.json'), 'utf8');
  const parsed = JSON.parse(raw) as { projects: ProjectEntry[] };
  return parsed.projects;
}

async function migrateOne(
  sql: postgres.Sql,
  project: ProjectEntry,
): Promise<{ slug: string; loaded: number; skipped: string | null }> {
  const runs = scanRuns(project.path);
  if (runs.length === 0) return { slug: project.slug, loaded: 0, skipped: 'no logs dir or empty' };
  const schema = slugToSchema(project.slug);
  const exists = await sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = ${schema} AND table_name = 'agent_runs'
  `;
  if (exists.length === 0) return { slug: project.slug, loaded: 0, skipped: `${schema} has no agent_runs` };
  const now = Date.now();

  // Insert in batches of 100 to keep parameter count manageable.
  const BATCH = 100;
  for (let off = 0; off < runs.length; off += BATCH) {
    const batch = runs.slice(off, off + BATCH);
    const rows = batch.map((r) => ({ harness_slug: project.slug, ...r, created_ts: now, updated_ts: now }));
    await sql.unsafe(
      `INSERT INTO ${schema}.agent_runs
         (harness_slug, run_id, role, feature_id, ts, size_bytes, duration_ms,
          cost_usd, input_tokens, output_tokens, cache_read_tokens,
          cache_creation_tokens, running, last_event_ts, created_ts, updated_ts)
       VALUES ${rows.map((_, i) =>
         `($${i*16+1},$${i*16+2},$${i*16+3},$${i*16+4},$${i*16+5},$${i*16+6},$${i*16+7},$${i*16+8},$${i*16+9},$${i*16+10},$${i*16+11},$${i*16+12},$${i*16+13},$${i*16+14},$${i*16+15},$${i*16+16})`,
       ).join(',')}
       ON CONFLICT (harness_slug, run_id) DO UPDATE SET
         role                  = EXCLUDED.role,
         feature_id            = EXCLUDED.feature_id,
         ts                    = EXCLUDED.ts,
         size_bytes            = EXCLUDED.size_bytes,
         duration_ms           = EXCLUDED.duration_ms,
         cost_usd              = EXCLUDED.cost_usd,
         input_tokens          = EXCLUDED.input_tokens,
         output_tokens         = EXCLUDED.output_tokens,
         cache_read_tokens     = EXCLUDED.cache_read_tokens,
         cache_creation_tokens = EXCLUDED.cache_creation_tokens,
         running               = EXCLUDED.running,
         last_event_ts         = EXCLUDED.last_event_ts,
         updated_ts            = EXCLUDED.updated_ts`,
      rows.flatMap((r) => [
        r.harness_slug, r.run_id, r.role, r.feature_id, r.ts, r.size_bytes,
        r.duration_ms, r.cost_usd, r.input_tokens, r.output_tokens,
        r.cache_read_tokens, r.cache_creation_tokens, r.running,
        r.last_event_ts, r.created_ts, r.updated_ts,
      ]),
    );
  }
  return { slug: project.slug, loaded: runs.length, skipped: null };
}

async function main() {
  const argv = process.argv.slice(2);
  const projects = await loadRegistry();
  const targets = argv.length > 0 ? projects.filter((p) => argv.includes(p.slug)) : projects;
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
        console.log(`OK   ${result.slug.padEnd(20)}  loaded ${result.loaded} agent_runs`);
      }
    }
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
