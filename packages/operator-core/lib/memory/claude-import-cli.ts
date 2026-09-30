/**
 * claude-import-cli.ts — run the P-004 topic-file → canonical-store import
 * (memory-pg-lexical-own-injection-2026-07-13; decision table in
 * ./claude-import.ts).
 *
 *   npx tsx packages/operator-core/lib/memory/claude-import-cli.ts --dry-run
 *   npx tsx packages/operator-core/lib/memory/claude-import-cli.ts --limit 5
 *   npx tsx packages/operator-core/lib/memory/claude-import-cli.ts
 *
 * Writes go to the LIVE canonical store (harness_shared) through the
 * neutral seam (Mem0Backend.remember verbatim/infer:false — the D-008 bulk
 * path: no LLM extraction; embeds under the active embedder; entity-linking
 * best-effort). TAKE A BACKUP FIRST (pg_dump of harness_shared.memory_* +
 * a tar of the topic dir) — kopia is down per EI-10733.
 *
 * Idempotent + resumable by construction: every row carries
 * payload.imported_from = 'claude-file:<basename>'; re-runs skip them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Client } from 'pg';

import { Mem0Backend, claudeProjectMemoryDir, pgClientFields } from '@papercusp/memory';
// Side-effect import: wires the LIVE operator memory host (harness_shared
// schema, admin URL, embedder cascade) — the import targets the real store.
import './configure';
import { getSessionUserOrDefault } from '../auth';
import { bodyKey, planImport, readTopicFiles, type ImportPlan, type PlannedImport } from './claude-import';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = argValue('--limit') ? Number(argValue('--limit')) : undefined;
const CONCURRENCY = argValue('--concurrency') ? Number(argValue('--concurrency')) : 3;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function log(msg: string): void {
  console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);
}

async function main(): Promise<void> {
  const memoryDir =
    process.env.PAPERCUSP_CLAUDE_MEMORY_DIR ||
    claudeProjectMemoryDir(
      process.env.PAPERCUSP_CLAUDE_PROJECT_DIR || os.homedir(),
      path.join(os.homedir(), '.claude'),
    );
  if (!fs.existsSync(memoryDir)) throw new Error(`memory dir missing: ${memoryDir}`);
  log(`reading topic files from ${memoryDir}`);
  const candidates = readTopicFiles(memoryDir);
  log(`${candidates.length} topic files parsed`);

  const owner = await getSessionUserOrDefault();
  log(`default (unscoped-file) scope = owner pool ${owner.id}`);

  // --- store state for the planner (one client, three reads) ---------------
  const pg = new Client(await pgClientFields());
  await pg.connect();
  try {
    const linkIds = [
      ...new Set(
        candidates
          .map((c) => c.tf.extra?.link_id)
          .filter((v): v is string => typeof v === 'string' && UUID_RE.test(v)),
      ),
    ];
    const existingCanonicalIds = new Set<string>();
    // Chunked ANY() lookups — bounded statements, no 1,655-value single param.
    for (let i = 0; i < linkIds.length; i += 500) {
      const chunk = linkIds.slice(i, i + 500);
      const r = await pg.query(
        `SELECT id FROM harness_shared.memory_canonical WHERE id = ANY($1::uuid[])`,
        [chunk],
      );
      for (const row of r.rows) existingCanonicalIds.add(String(row.id));
    }
    log(`${linkIds.length} distinct link_ids, ${existingCanonicalIds.size} resolve to live canonical rows`);

    const importedRes = await pg.query(
      `SELECT payload->>'imported_from' AS k FROM harness_shared.memory_canonical WHERE payload ? 'imported_from'`,
    );
    const alreadyImported = new Set<string>(importedRes.rows.map((r: { k: string }) => r.k));
    log(`${alreadyImported.size} rows already imported (prior runs)`);

    // Exact-dup guard, restricted to the scopes this run could write into.
    const scopes = [...new Set(candidates.map((c) => c.tf.scope?.trim() || owner.id))];
    const bodiesRes = await pg.query(
      `SELECT payload->>'user_id' AS scope, payload->>'data' AS data
       FROM harness_shared.memory_canonical
       WHERE NOT (payload ? 'entityType') AND payload->>'user_id' = ANY($1)`,
      [scopes],
    );
    const existingBodies = new Set<string>(
      bodiesRes.rows.map((r: { scope: string; data: string }) => bodyKey(r.scope, r.data ?? '')),
    );

    const plan = planImport({ candidates, existingCanonicalIds, alreadyImported, existingBodies, defaultScope: owner.id });
    report(plan, candidates.length);

    let toRun: PlannedImport[] = plan.imports;
    if (LIMIT !== undefined) {
      toRun = toRun.slice(0, LIMIT);
      log(`--limit ${LIMIT}: importing first ${toRun.length} only`);
    }
    if (DRY_RUN) {
      log('--dry-run: no writes. First 10 planned imports:');
      for (const i of toRun.slice(0, 10)) console.log(`  ${i.file} → scope=${i.scope} kind=${i.kind ?? '-'} (${i.text.length} chars)`);
      return;
    }

    // --- the writes, through the neutral seam --------------------------------
    const backend = new Mem0Backend();
    const results: Array<{ file: string; ids: string[]; error?: string }> = [];
    let done = 0;
    const queue = [...toRun];
    const workers = Array.from({ length: Math.max(1, CONCURRENCY) }, async () => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        try {
          const r = await backend.remember(item.text, {
            scope: item.scope,
            verbatim: true,
            ...(item.kind ? { kind: item.kind } : {}),
            metadata: item.metadata,
          });
          results.push({ file: item.file, ids: r.ids });
        } catch (e) {
          results.push({ file: item.file, ids: [], error: (e as Error).message.slice(0, 200) });
        }
        done += 1;
        if (done % 25 === 0 || done === toRun.length) log(`imported ${done}/${toRun.length}`);
      }
    });
    await Promise.all(workers);

    const failed = results.filter((r) => r.error);
    const stored = results.filter((r) => !r.error && r.ids.length > 0);
    log(`DONE: ${stored.length} stored, ${failed.length} failed, of ${toRun.length} attempted`);
    for (const f of failed.slice(0, 10)) console.error(`  FAILED ${f.file}: ${f.error}`);

    const reportPath = path.resolve(
      process.cwd(),
      '.papercusp/bench-reports',
      `claude-import-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    );
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(
      reportPath,
      JSON.stringify({ memoryDir, defaultScope: owner.id, planSummary: summarize(plan, candidates.length), results }, null, 2),
    );
    log(`report → ${reportPath}`);
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    await pg.end().catch(() => {});
  }
}

function summarize(plan: ImportPlan, totalFiles: number) {
  return {
    totalFiles,
    toImport: plan.imports.length,
    skippedLinked: plan.skippedLinked,
    ghosts: plan.ghosts.length,
    skippedImported: plan.skippedImported,
    skippedExactDup: plan.skippedExactDup,
    skippedEmpty: plan.skippedEmpty,
  };
}

function report(plan: ImportPlan, totalFiles: number): void {
  const s = summarize(plan, totalFiles);
  log(
    `plan: ${s.toImport} to import | ${s.skippedLinked} linked-live (already stored) | ` +
      `${s.ghosts} ghosts (canonical row forgotten — NOT resurrected) | ` +
      `${s.skippedImported} previously imported | ${s.skippedExactDup} exact dups | ${s.skippedEmpty} empty`,
  );
  if (plan.ghosts.length > 0) {
    log(`ghost files (first 10): ${plan.ghosts.slice(0, 10).join(', ')}`);
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
